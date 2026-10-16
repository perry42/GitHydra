// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getEmptyHooksDir } from "./emptyHooksDir";
import { isErrnoException } from "./pathSafety";
import { listWorktrees } from "./worktreeList";
import { realpathBestEffort, verifyRegisteredWorktree } from "./worktreePaths";
import { relatePaths } from "./worktreeParse";
import { wrapGit, wtSpawn } from "./worktreeRunner";
import { isLargeRow, isSecretLooking, runsCodeWhenOpened, validateCopyPath, type CopyCandidateRow } from "./worktreeCopyPure";

/**
 * Listing of ignored files in the SOURCE worktree (specs/worktree-copy-ignored.md FR-626). git does the enumeration; this
 * module only bounds it (timeout kill, stdout and row caps) and describes each row. Nothing here writes anywhere.
 */

export const LIST_TIMEOUT_MS = 5000;
export const LIST_MAX_STDOUT_BYTES = 4 * 1024 * 1024;
export const LIST_MAX_ROWS = 20_000;
const WALK_MAX_ENTRIES = 100_000;
const WALK_MAX_MS = 3000;

export interface IgnoredCandidate extends CopyCandidateRow {
  /** False: counts/size were capped ("size not computed"). */
  sizeComputed: boolean;
  secret: boolean;
  runsCode: boolean;
  large: boolean;
}

export interface ListIgnoredOptions {
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxRows?: number;
  walkMaxEntries?: number;
  walkMaxMs?: number;
  signal?: AbortSignal;
}

export type ListFailureReason = "timeout" | "too-many-files" | "git-failed" | "cancelled" | "not-a-worktree" | "untrusted-list";

export type IgnoredListing =
  | { status: "ok"; candidates: IgnoredCandidate[]; /** A bare repository has no working tree: render nothing. */ bare: boolean }
  | { status: "failed"; reason: ListFailureReason };

export interface ResolvedSource {
  /** Admin-dir name; null for the main worktree. */
  id: string | null;
  /** Real path of the source worktree. */
  root: string;
  bare: boolean;
}

/** The source must be a worktree git itself lists for this repository (a stray directory is never enumerated). */
export async function resolveSourceWorktree(repoPath: string, sourcePath: string): Promise<ResolvedSource | { failed: ListFailureReason }> {
  const list = await listWorktrees(repoPath);
  const want = await realpathBestEffort(sourcePath);
  for (const entry of list.entries) {
    if (!entry.supported) continue;
    const real = await realpathBestEffort(entry.path);
    if (relatePaths(real, want) !== "same") continue;
    if (entry.isBare) return { id: null, root: real, bare: true };
    if (entry.isMain) return { id: null, root: real, bare: false };
    if (list.untrusted) return { failed: "untrusted-list" };
    const v = await verifyRegisteredWorktree(repoPath, entry.id!, { list });
    return v.trusted ? { id: entry.id, root: v.realPath, bare: false } : { failed: "not-a-worktree" };
  }
  return { failed: "not-a-worktree" };
}

/** Kills the whole tree on Windows (`taskkill /T`), SIGKILL elsewhere. */
export function killProcessTree(child: { pid?: number; kill(signal?: NodeJS.Signals): boolean }): void {
  try {
    if (process.platform === "win32" && child.pid !== undefined) {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => undefined);
    }
    child.kill("SIGKILL");
  } catch {
    // already gone
  }
}

export type Enumeration = { status: "ok"; paths: string[] } | { status: "failed"; reason: ListFailureReason };

/** One bounded `git ls-files -o -i ... -z` run. `extra` carries the flavour (`--exclude-standard`, `-X <file>`, `--directory`) and a pathspec. */
export async function enumerateIgnored(cwd: string, extra: readonly string[], opts: ListIgnoredOptions = {}): Promise<Enumeration> {
  const timeoutMs = opts.timeoutMs ?? LIST_TIMEOUT_MS;
  const maxBytes = opts.maxStdoutBytes ?? LIST_MAX_STDOUT_BYTES;
  const maxRows = opts.maxRows ?? LIST_MAX_ROWS;
  const hooks = await getEmptyHooksDir();
  const child = wtSpawn(["-c", `core.hooksPath=${hooks}`, "ls-files", "-o", "-i", ...extra], cwd);
  return new Promise<Enumeration>((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let verdict: ListFailureReason | null = null;
    let settled = false;
    const finish = (r: Enumeration): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };
    const stop = (reason: ListFailureReason): void => {
      verdict ??= reason;
      killProcessTree(child);
      // A killed child may never emit close (grandchildren hold the pipes): do not wait for it.
      setTimeout(() => finish({ status: "failed", reason }), 250).unref?.();
    };
    const onAbort = (): void => stop("cancelled");
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (c: Buffer) => {
      if (verdict) return;
      bytes += c.length;
      if (bytes > maxBytes) return stop("too-many-files");
      chunks.push(c);
    });
    child.stderr.on("data", () => undefined);
    child.on("error", () => finish({ status: "failed", reason: verdict ?? "git-failed" }));
    child.on("close", (code) => {
      if (verdict) return finish({ status: "failed", reason: verdict });
      if (code !== 0) return finish({ status: "failed", reason: "git-failed" });
      const text = Buffer.concat(chunks).toString("utf8");
      const paths = text === "" ? [] : text.split("\0");
      if (paths[paths.length - 1] === "") paths.pop();
      if (paths.length > maxRows) return finish({ status: "failed", reason: "too-many-files" });
      finish({ status: "ok", paths });
    });
  });
}

interface WalkBudget {
  entries: number;
  deadline: number;
}

async function walkDirectory(dir: string, budget: WalkBudget): Promise<{ fileCount: number; bytes: number; complete: boolean }> {
  let fileCount = 0;
  let bytes = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (--budget.entries < 0 || Date.now() > budget.deadline) return { fileCount, bytes, complete: false };
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) {
        try {
          bytes += (await fs.lstat(full)).size;
          fileCount++;
        } catch {
          // vanished
        }
      }
    }
  }
  return { fileCount, bytes, complete: true };
}

async function describeRow(root: string, rel: string, budget: WalkBudget): Promise<IgnoredCandidate | null> {
  const isDirectory = rel.endsWith("/");
  const base: CopyCandidateRow = { path: rel, isDirectory, fileCount: isDirectory ? null : 1, bytes: null };
  const finish = (row: CopyCandidateRow, sizeComputed: boolean): IgnoredCandidate => ({
    ...row,
    sizeComputed,
    secret: isSecretLooking(row.path),
    runsCode: runsCodeWhenOpened(row.path),
    large: isLargeRow(row),
  });
  if (!validateCopyPath(rel).ok || rel.includes("�")) return finish({ ...base, disabledReason: "name-not-allowed" }, false);
  const abs = path.join(root, ...(isDirectory ? rel.slice(0, -1) : rel).split("/"));
  let st: import("node:fs").Stats;
  try {
    st = await fs.lstat(abs);
  } catch (err) {
    if (isErrnoException(err) && (err.code === "ENOENT" || err.code === "ENOTDIR")) return null;
    return finish({ ...base, disabledReason: "not-a-regular-file" }, false);
  }
  if (st.isSymbolicLink()) return finish({ ...base, disabledReason: "symbolic-link" }, false);
  if (st.isDirectory()) {
    const nested = await fs.lstat(path.join(abs, ".git")).then(() => true, () => false);
    if (nested) return finish({ ...base, disabledReason: "nested-repository" }, false);
    const walked = await walkDirectory(abs, budget);
    return walked.complete ? finish({ ...base, fileCount: walked.fileCount, bytes: walked.bytes }, true) : finish({ ...base, fileCount: walked.fileCount }, false);
  }
  if (!st.isFile()) return finish({ ...base, disabledReason: "not-a-regular-file" }, false);
  return finish({ ...base, bytes: st.size }, true);
}

/** FR-626: candidate rows (directories collapsed, as `--directory` prints them) with async, capped counts and sizes. */
export function listIgnoredCandidates(repoPath: string, sourceWorktreePath: string, opts: ListIgnoredOptions = {}): Promise<IgnoredListing> {
  return wrapGit("list-ignored", async () => {
    const src = await resolveSourceWorktree(repoPath, sourceWorktreePath);
    if ("failed" in src) return { status: "failed", reason: src.failed };
    if (src.bare) return { status: "ok", candidates: [], bare: true };
    const listed = await enumerateIgnored(src.root, ["--exclude-standard", "-z", "--directory"], opts);
    if (listed.status === "failed") return listed;
    const budget: WalkBudget = { entries: opts.walkMaxEntries ?? WALK_MAX_ENTRIES, deadline: Date.now() + (opts.walkMaxMs ?? WALK_MAX_MS) };
    const candidates: IgnoredCandidate[] = [];
    for (const rel of listed.paths) {
      const row = await describeRow(src.root, rel, budget);
      if (row) candidates.push(row);
    }
    return { status: "ok", candidates, bare: false };
  });
}
