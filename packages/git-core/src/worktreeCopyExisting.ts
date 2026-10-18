// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { GitCommandError } from "./errors";
import { killProcessTree } from "./gitProcess";
import { getEmptyHooksDir } from "./emptyHooksDir";
import { isErrnoException } from "./pathSafety";
import { listWorktrees } from "./worktreeList";
import { realpathBestEffort, verifyRegisteredWorktree } from "./worktreePaths";
import { relatePaths } from "./worktreeParse";
import { wrapGit, wtRun, wtRunInput, wtSpawn } from "./worktreeRunner";
import { enumerateIgnored, LIST_MAX_STDOUT_BYTES, LIST_TIMEOUT_MS, resolveSourceWorktree, type ListFailureReason, type ListIgnoredOptions } from "./worktreeCopy";
import {
  buildCopyManifest,
  copyFromManifest,
  COPY_MAX_BYTES,
  COPY_MAX_FILES,
  type CopyFileResult,
  type CopyManifest,
  type CopyOptions,
  type CopyProgress,
  type CopyTotals,
} from "./worktreeCopyEngine";
import { realCopyFs, type CopyFs } from "./worktreeCopyFs";
import { changesGitBehaviour, isLargeRow, validateCopyPath, type CopySkipReason } from "./worktreeCopyPure";
import { copyCollisionKey, escapeDisplayName, strongestExistingReason, type ExistingDisabledReason } from "./worktreeCopyExistingPure";

/**
 * Copy ignored files into an EXISTING worktree (specs/worktree-copy-ignored.md section G, FR-649..657). Reuses the Create engine
 * (`copyFromManifest`: no-follow source, `wx` destination, one-level mkdir, streamed budgets) and adds the destination
 * classification of FR-652. Every git call goes through the worktree seam (env scrub, fsmonitor off); nothing here writes in
 * the SOURCE worktree, the common dir or `.git/worktrees`.
 */

export const TRACKED_BATCH_PATHS = 2000;
/** Windows caps a command line near 32k characters; the 2,000-path batch is also bounded by the characters it carries. */
const BATCH_CHAR_BUDGET = 24_000;
export const CLASSIFY_OVERALL_MS = 15_000;

export type ExistingDestinationRefusal = "source-is-destination" | "locked" | "missing" | "unsupported" | "untrusted-list" | "bare" | "not-a-worktree" | "git-failed";

export interface ResolvedDestination {
  /** Admin-dir name; null for the main worktree. */
  id: string | null;
  /** Realpath of the working tree. */
  root: string;
  adminDir: string;
  /** Folder name, escaped and truncated for display (FR-651, L1). */
  name: string;
  branch: string | null;
  detached: boolean;
  shortHead: string | null;
}

export type ResolvedDestinationResult = { ok: true; dest: ResolvedDestination } | { ok: false; reason: ExistingDestinationRefusal };

const isGitFailure = (err: unknown): boolean => err instanceof GitCommandError || isErrnoException(err);

/**
 * FR-650: the destination is a worktree id from git's own list. Linked: FR-640 (`verifyRegisteredWorktree`). Main: the first
 * list entry, confirmed by `rev-parse --git-common-dir` (never `commondir/..`, which is wrong for `--separate-git-dir`).
 * Then git in the folder must answer for THAT folder (FR-652 M6): toplevel and git dir equal the bound ones.
 */
export async function resolveDestinationWorktree(repoPath: string, destId: string | null, sourceRoot: string): Promise<ResolvedDestinationResult> {
  const fail = (reason: ExistingDestinationRefusal): ResolvedDestinationResult => ({ ok: false, reason });
  const list = await listWorktrees(repoPath);
  if (list.entries[0]?.isBare) return fail("bare");
  if (list.untrusted) return fail("untrusted-list");
  const entry = destId === null ? list.entries.find((e) => e.isMain) : list.entries.find((e) => e.id === destId);
  if (!entry) return fail("not-a-worktree");
  if (!entry.supported) return fail("unsupported");
  if (entry.locked) return fail("locked");
  if (entry.prunable) return fail("missing");
  const commonReal = await realpathBestEffort(list.commonDir);
  let root: string;
  let adminDir: string;
  if (entry.isMain) {
    if (list.mainPathIsGitDir) return fail("unsupported");
    try {
      root = await fs.realpath(entry.path);
      if (!(await fs.lstat(root)).isDirectory()) return fail("missing");
      await fs.lstat(path.join(root, ".git"));
    } catch {
      return fail("missing");
    }
    try {
      const { stdout } = await wtRun(["rev-parse", "--git-common-dir"], root);
      const reported = await fs.realpath(path.resolve(root, stdout.trim()));
      if (relatePaths(commonReal, reported) !== "same") return fail("not-a-worktree");
    } catch (err) {
      if (isGitFailure(err)) return fail("git-failed");
      throw err;
    }
    adminDir = commonReal;
  } else {
    const v = await verifyRegisteredWorktree(repoPath, destId!, { list });
    if (!v.trusted) return fail(v.reason === "missing" ? "missing" : "not-a-worktree");
    root = v.realPath;
    adminDir = await realpathBestEffort(path.join(commonReal, "worktrees", destId!));
  }
  if (relatePaths(await realpathBestEffort(sourceRoot), root) === "same") return fail("source-is-destination");
  try {
    const { stdout } = await wtRun(["rev-parse", "--show-toplevel", "--absolute-git-dir"], root);
    const lines = stdout.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l !== "");
    if (lines.length !== 2) return fail("not-a-worktree");
    const top = await fs.realpath(lines[0]!);
    const gitDir = await fs.realpath(lines[1]!);
    if (relatePaths(root, top) !== "same" || relatePaths(adminDir, gitDir) !== "same") return fail("not-a-worktree");
  } catch (err) {
    if (isGitFailure(err)) return fail("git-failed");
    throw err;
  }
  return {
    ok: true,
    dest: { id: destId, root, adminDir, name: escapeDisplayName(path.basename(root)), branch: entry.branch, detached: entry.detached, shortHead: entry.shortHead },
  };
}

// --- bounded git reads ---

type Bounded = { ok: true; stdout: Buffer } | { ok: false; reason: "timeout" | "too-large" | "failed" | "cancelled" };

/** One streaming git read with the FR-626 limits: 5 s timeout, 4 MB stdout cap, kill-tree; any failure is a closed `ok: false`. */
async function boundedGit(args: readonly string[], cwd: string, opts: { timeoutMs: number; maxBytes: number; signal?: AbortSignal }): Promise<Bounded> {
  const hooks = await getEmptyHooksDir();
  const child = wtSpawn(["-c", `core.hooksPath=${hooks}`, "--literal-pathspecs", ...args], cwd);
  return new Promise<Bounded>((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let verdict: "timeout" | "too-large" | "cancelled" | null = null;
    let settled = false;
    const finish = (r: Bounded): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };
    const stop = (reason: "timeout" | "too-large" | "cancelled"): void => {
      verdict ??= reason;
      killProcessTree(child);
      setTimeout(() => finish({ ok: false, reason }), 250).unref?.();
    };
    const onAbort = (): void => stop("cancelled");
    const timer = setTimeout(() => stop("timeout"), opts.timeoutMs);
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (c: Buffer) => {
      if (verdict) return;
      bytes += c.length;
      if (bytes > opts.maxBytes) return stop("too-large");
      chunks.push(c);
    });
    child.stderr.on("data", () => undefined);
    child.on("error", () => finish({ ok: false, reason: verdict ?? "failed" }));
    child.on("close", (code) => {
      if (verdict) return finish({ ok: false, reason: verdict });
      if (code !== 0) return finish({ ok: false, reason: "failed" });
      finish({ ok: true, stdout: Buffer.concat(chunks) });
    });
  });
}

export class TrackedCheckFailedError extends Error {
  constructor() {
    super("The tracked-file check failed.");
    this.name = "TrackedCheckFailedError";
  }
}

interface IndexEntry {
  mode: string;
  path: string;
}

/** `git ls-files -z --cached --stage` rows: `<mode> <sha> <stage>\t<path>`. Anything else is unparsable and fails the check closed. */
function parseStage(buf: Buffer): IndexEntry[] | null {
  const text = buf.toString("utf8");
  if (text === "") return [];
  const rows = text.split("\0");
  if (rows[rows.length - 1] === "") rows.pop();
  const out: IndexEntry[] = [];
  for (const row of rows) {
    const tab = row.indexOf("\t");
    if (tab < 0) return null;
    const head = row.slice(0, tab).split(" ");
    if (head.length !== 3 || !/^\d{6}$/.test(head[0]!) || !/^[0-9a-f]{40,64}$/.test(head[1]!) || !/^[0-3]$/.test(head[2]!)) return null;
    out.push({ mode: head[0]!, path: row.slice(tab + 1) });
  }
  return out;
}

function batches(paths: readonly string[]): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let chars = 0;
  for (const p of paths) {
    if (cur.length > 0 && (cur.length >= TRACKED_BATCH_PATHS || chars + p.length > BATCH_CHAR_BUDGET)) {
      out.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(p);
    chars += p.length + 1;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/**
 * FR-652(c)/M7: which index entries (HEAD is not consulted) lie at or under the probe paths. Per batch of at most 2,000 paths with the
 * 5 s timeout and 4 MB cap; ANY timeout, cap hit, non-zero exit or unparsable output throws {@link TrackedCheckFailedError}.
 */
async function queryIndex(destRoot: string, probes: readonly string[], opts: { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number; batchPaths?: number }): Promise<IndexEntry[]> {
  const entries: IndexEntry[] = [];
  for (const batch of batches(probes)) {
    const parts = opts.batchPaths ? splitEvery(batch, opts.batchPaths) : [batch];
    for (const part of parts) {
      const r = await boundedGit(["ls-files", "-z", "--cached", "--stage", "--", ...part], destRoot, {
        timeoutMs: opts.timeoutMs ?? LIST_TIMEOUT_MS,
        maxBytes: opts.maxBytes ?? LIST_MAX_STDOUT_BYTES,
        signal: opts.signal,
      });
      if (!r.ok) throw new TrackedCheckFailedError();
      const parsed = parseStage(r.stdout);
      if (!parsed) throw new TrackedCheckFailedError();
      entries.push(...parsed);
    }
  }
  return entries;
}

function splitEvery<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

// --- classification against the destination ---

export interface ClassifyOptions {
  fs?: CopyFs;
  platform?: string;
  now?: () => number;
  /** Overall deadline for classifying all rows (default 15 s); files not reached are `could-not-be-checked`, never enabled. */
  classifyMs?: number;
  signal?: AbortSignal;
  /** Test seams for the git read limits. */
  gitTimeoutMs?: number;
  gitMaxBytes?: number;
  gitBatchPaths?: number;
}

interface DirNames {
  exact: Set<string>;
  byKey: Map<string, string[]>;
}

const ancestorsOf = (rel: string): string[] => {
  const segs = rel.split("/");
  const out: string[] = [];
  for (let i = 1; i < segs.length; i++) out.push(segs.slice(0, i).join("/"));
  return out;
};

/**
 * FR-652 (a)(b) and the nested-repository rule (M3) for ONE file, without following anything. Returns the reason and the shallowest
 * probe path for the tracked check (a missing component, or an empty directory that could be an unpopulated submodule).
 */
async function inspectPath(
  destRoot: string,
  rel: string,
  ctx: { cfs: CopyFs; win: boolean; dirs: Map<string, Promise<DirNames | null>>; resolves: Map<string, boolean> },
): Promise<{ reason: ExistingDisabledReason | null; probes: string[] }> {
  const segs = rel.split("/");
  const probes: string[] = [];
  const readDir = (dir: string): Promise<DirNames | null> => {
    let p = ctx.dirs.get(dir);
    if (!p) {
      p = fs.readdir(dir).then(
        (names) => {
          const byKey = new Map<string, string[]>();
          for (const n of names) {
            const k = copyCollisionKey(n);
            const list = byKey.get(k);
            if (list) list.push(n);
            else byKey.set(k, [n]);
          }
          return { exact: new Set(names), byKey };
        },
        (err: unknown) => {
          if (isErrnoException(err) && (err.code === "ENOENT" || err.code === "ENOTDIR")) return null;
          throw err;
        },
      );
      ctx.dirs.set(dir, p);
    }
    return p;
  };
  const resolvesHere = async (dir: string): Promise<boolean> => {
    const hit = ctx.resolves.get(dir);
    if (hit !== undefined) return hit;
    const real = await ctx.cfs.realpath(dir).catch(() => null);
    const strip = (x: string): string => x.replace(/^\\\\\?\\/, "").replace(/[\\/]+$/, "").toLowerCase();
    const ok = real !== null && strip(real) === strip(dir);
    ctx.resolves.set(dir, ok);
    return ok;
  };
  let cur = destRoot;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    const rel0 = segs.slice(0, i + 1).join("/");
    const names = await readDir(cur);
    if (names === null) {
      probes.push(rel0);
      return { reason: null, probes };
    }
    if (i > 0 && names.exact.size === 0) probes.push(segs.slice(0, i).join("/"));
    const hits = names.byKey.get(copyCollisionKey(seg));
    if (!hits || hits.length === 0) {
      probes.push(rel0);
      return { reason: null, probes };
    }
    // Same name only under case or normalisation folding: the filesystem may treat it as the same file (FR-652 a).
    if (!hits.includes(seg)) return { reason: "already-exists", probes: [...probes, rel] };
    const next = path.join(cur, seg);
    if (i === segs.length - 1) return { reason: "already-exists", probes: [...probes, rel] };
    const st = await ctx.cfs.lstat(next);
    if (st.isSymbolicLink()) return { reason: "destination-link", probes };
    if (!st.isDirectory()) return { reason: "already-exists", probes: [...probes, rel] };
    if (ctx.win && !(await resolvesHere(next))) return { reason: "destination-link", probes };
    if (await ctx.cfs.lstat(path.join(next, ".git")).then(() => true, () => false)) return { reason: "inside-another-repository", probes };
    cur = next;
  }
  return { reason: null, probes };
}

export interface FileClassification {
  /** Per manifest file index; null = copyable. Indexes not asked for are absent. */
  states: Map<number, ExistingDisabledReason | null>;
}

/** FR-652 for the given manifest files. Throws {@link TrackedCheckFailedError} when git cannot answer. */
export async function classifyFilesAgainstDestination(
  manifest: CopyManifest,
  indexes: readonly number[],
  dest: ResolvedDestination,
  containsRowIds: ReadonlySet<string>,
  opts: ClassifyOptions = {},
): Promise<FileClassification> {
  const cfs = opts.fs ?? realCopyFs;
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.classifyMs ?? CLASSIFY_OVERALL_MS);
  const ctx = { cfs, win: (opts.platform ?? process.platform) === "win32", dirs: new Map<string, Promise<DirNames | null>>(), resolves: new Map<string, boolean>() };
  const states = new Map<number, ExistingDisabledReason | null>();
  const probesOf = new Map<number, string[]>();
  for (const i of indexes) {
    const file = manifest.files[i]!;
    if (containsRowIds.has(file.rowId)) {
      states.set(i, "contains-destination");
      continue;
    }
    if (now() > deadline || opts.signal?.aborted) {
      states.set(i, "could-not-be-checked");
      continue;
    }
    try {
      const r = await inspectPath(dest.root, file.path, ctx);
      states.set(i, r.reason);
      probesOf.set(i, r.probes);
    } catch {
      states.set(i, "could-not-be-checked");
    }
  }

  // Tracked check for everything not already settled by a stronger reason.
  const needs = [...states.entries()].filter(([, s]) => s === null || s === "already-exists").map(([i]) => i);
  if (needs.length > 0) {
    const probes = new Set<string>();
    for (const i of needs) {
      probes.add(manifest.files[i]!.path);
      for (const p of probesOf.get(i) ?? []) probes.add(p);
    }
    if (now() > deadline) {
      for (const i of needs) states.set(i, "could-not-be-checked");
    } else {
      const entries = await queryIndex(dest.root, [...probes], { signal: opts.signal, timeoutMs: opts.gitTimeoutMs, maxBytes: opts.gitMaxBytes, batchPaths: opts.gitBatchPaths });
      const byKey = new Map<string, string>();
      const dirKeys = new Set<string>();
      for (const e of entries) {
        const k = copyCollisionKey(e.path);
        byKey.set(k, e.mode);
        for (const a of ancestorsOf(k)) dirKeys.add(a);
      }
      for (const i of needs) {
        const k = copyCollisionKey(manifest.files[i]!.path);
        let verdict: ExistingDisabledReason | null = null;
        const own = byKey.get(k);
        if (own !== undefined) verdict = own === "160000" ? "inside-another-repository" : "tracked-in-destination";
        else if (dirKeys.has(k)) verdict = "tracked-in-destination";
        for (const a of ancestorsOf(k)) {
          const m = byKey.get(a);
          if (m === undefined) continue;
          verdict = strongestExistingReason([m === "160000" ? "inside-another-repository" : "tracked-in-destination", ...(verdict ? [verdict] : [])]);
        }
        if (verdict) states.set(i, strongestExistingReason([verdict, ...(states.get(i) ? [states.get(i)!] : [])]));
      }
    }
  }
  return { states };
}

/** Rows whose real path is the destination or contains it (FR-650, M4): `A/.worktrees/B` with `.worktrees/` ignored in A. */
async function rowsContainingDestination(manifest: CopyManifest, destRoot: string): Promise<Set<string>> {
  const out = new Set<string>();
  for (const row of manifest.rows) {
    if (!row.isDirectory) continue;
    const abs = path.join(manifest.sourceRoot, ...row.path.slice(0, -1).split("/"));
    const real = await realpathBestEffort(abs);
    if (relatePaths(real, destRoot) !== "outside") out.add(row.id);
  }
  return out;
}

/** FR-652: the informational `not ignored in <B>` set; a failing check returns null (tag absent, nothing else changes). */
async function notIgnoredPaths(dest: ResolvedDestination, paths: readonly string[], deadline: number, now: () => number): Promise<Set<string> | null> {
  const notIgnored = new Set<string>();
  try {
    for (const batch of splitEvery(paths, TRACKED_BATCH_PATHS)) {
      if (now() > deadline) return null;
      const input = Buffer.from(`${batch.join("\0")}\0`, "utf8");
      let ignored: string[] = [];
      try {
        const r = await wtRunInput(["check-ignore", "--no-index", "--stdin", "-z"], dest.root, input, {
          timeoutMs: LIST_TIMEOUT_MS,
          // check-ignore rejects literal-pathspec mode; it takes plain path strings and FR-630 hygiene already refused any colon.
          extraEnv: { GIT_LITERAL_PATHSPECS: "0" },
        });
        ignored = r.stdout.toString("utf8").split("\0").filter((x) => x !== "");
      } catch (err) {
        // Exit 1 means "none of these is ignored", a normal answer.
        if (!(err instanceof GitCommandError) || err.exitCode !== 1) return null;
      }
      const set = new Set(ignored);
      for (const p of batch) if (!set.has(p)) notIgnored.add(p);
    }
  } catch {
    return null;
  }
  return notIgnored;
}

// --- listing ---

export interface ExistingRow {
  id: string;
  path: string;
  /** Escaped and middle-truncated for display (FR-651); `path` stays the exact id. */
  displayPath: string;
  isDirectory: boolean;
  /** Files git enumerated that the manifest holds (M of "N of M already exist"). */
  fileCount: number;
  /** Files that can be copied right now. */
  copyableCount: number;
  /** Files that already exist in the destination (N). */
  existingCount: number;
  /** Bytes of the copyable files. */
  bytes: number;
  disabledReason: ExistingDisabledReason | null;
  secret: boolean;
  runsCode: boolean;
  large: boolean;
  /** A copied `.gitignore` / `.gitattributes` changes how git behaves in the destination (L3). */
  changesGit: boolean;
  /** Informational: git would NOT ignore a copyable file of this row in the destination. Never blocks. */
  notIgnoredInDestination: boolean;
  droppedFiles: number;
  droppedReasons: Record<string, number>;
}

export type ExistingListFailure = ListFailureReason | ExistingDestinationRefusal | "tracked-check-failed";

export type ExistingListing =
  | {
      status: "ok";
      source: { id: string | null; root: string; name: string };
      destination: ResolvedDestination;
      manifest: CopyManifest;
      rows: ExistingRow[];
    }
  | { status: "failed"; reason: ExistingListFailure; /** Set once the destination resolved, for "Couldn't check which files <B> tracks.". */ destinationName?: string };

export interface ListForExistingOptions extends ListIgnoredOptions, ClassifyOptions {
  /** Passed to the manifest builder. */
  repoKey?: string | null;
  token?: string;
  rowMaxFiles?: number;
}

/** FR-652: the Create listing of the SOURCE plus the classification of every enumerated file against the DESTINATION. */
export function listIgnoredForExisting(repoPath: string, sourceWorktreePath: string, destId: string | null, opts: ListForExistingOptions = {}): Promise<ExistingListing> {
  return wrapGit("list-ignored", async () => {
    const src = await resolveSourceWorktree(repoPath, sourceWorktreePath);
    if ("failed" in src) return { status: "failed", reason: src.failed };
    if (src.bare) return { status: "failed", reason: "bare" };
    const resolved = await resolveDestinationWorktree(repoPath, destId, src.root);
    if (!resolved.ok) return { status: "failed", reason: resolved.reason };
    const built = await buildCopyManifest(repoPath, sourceWorktreePath, opts);
    if (built.status === "failed") return built;
    const manifest = built.manifest;
    const now = opts.now ?? Date.now;
    const deadline = now() + (opts.classifyMs ?? CLASSIFY_OVERALL_MS);
    const contains = await rowsContainingDestination(manifest, resolved.dest.root);
    const live = manifest.rows.filter((r) => !r.disabledReason);
    const indexes = live.flatMap((r) => r.fileIndexes);
    let classification: FileClassification;
    try {
      classification = await classifyFilesAgainstDestination(manifest, indexes, resolved.dest, contains, opts);
    } catch (err) {
      if (err instanceof TrackedCheckFailedError) return { status: "failed", reason: "tracked-check-failed", destinationName: resolved.dest.name };
      throw err;
    }
    const copyablePaths = indexes.filter((i) => classification.states.get(i) === null).map((i) => manifest.files[i]!.path);
    const notIgnored = await notIgnoredPaths(resolved.dest, copyablePaths, deadline, now);
    const rows: ExistingRow[] = manifest.rows.map((row) => {
      const states = row.fileIndexes.map((i) => classification.states.get(i) ?? null);
      const copyable = row.fileIndexes.filter((i) => classification.states.get(i) === null);
      const existing = states.filter((s) => s === "already-exists").length;
      let disabledReason: ExistingDisabledReason | null = row.disabledReason;
      if (!disabledReason && contains.has(row.id)) disabledReason = "contains-destination";
      else if (!disabledReason && row.fileIndexes.length === 0) disabledReason = row.droppedFiles > 0 ? "name-not-allowed" : "not-a-regular-file";
      else if (!disabledReason && copyable.length === 0) disabledReason = strongestExistingReason(states.filter((s): s is ExistingDisabledReason => s !== null));
      return {
        id: row.id,
        path: row.path,
        displayPath: escapeDisplayName(row.path),
        isDirectory: row.isDirectory,
        fileCount: row.fileIndexes.length,
        copyableCount: copyable.length,
        existingCount: existing,
        bytes: copyable.reduce((n, i) => n + Number(manifest.files[i]!.size), 0),
        disabledReason,
        secret: row.secret,
        runsCode: row.runsCode,
        large: isLargeRow({ path: row.path, fileCount: row.fileIndexes.length, bytes: row.bytes }),
        changesGit: changesGitBehaviour(row.path) || row.fileIndexes.some((i) => changesGitBehaviour(manifest.files[i]!.path)),
        notIgnoredInDestination: notIgnored !== null && copyable.some((i) => notIgnored.has(manifest.files[i]!.path)),
        droppedFiles: row.droppedFiles,
        droppedReasons: row.droppedReasons,
      };
    });
    return { status: "ok", source: { id: src.id, root: src.root, name: escapeDisplayName(path.basename(src.root)) }, destination: resolved.dest, manifest, rows };
  });
}

// --- copy ---

export type ExistingCopyRefusal = "not-a-worktree" | "destination-changed" | "source-changed" | "over-limit" | "tracked-check-failed";

export type ExistingCopyOutcome =
  | { status: "done" | "cancelled" | "limit"; results: CopyFileResult[]; totals: CopyTotals; destination: ResolvedDestination }
  | { status: "refused"; reason: ExistingCopyRefusal; results: []; totals: CopyTotals };

export interface CopyIntoExistingOptions extends ClassifyOptions {
  limits?: CopyOptions["limits"];
  onProgress?: (p: CopyProgress) => void;
  /** Test seam: bounds the re-enumeration of directory rows. */
  enumerate?: ListIgnoredOptions;
}

const SKIP_FOR_STATE: Record<ExistingDisabledReason, CopySkipReason> = {
  "nested-repository": "row-disabled",
  "symbolic-link": "source-symlink",
  "not-a-regular-file": "not-regular-file",
  "name-not-allowed": "unsafe-path",
  "too-many-files": "row-disabled",
  "already-exists": "already-exists",
  "destination-link": "destination-parent-link",
  "tracked-in-destination": "tracked-in-destination",
  "inside-another-repository": "inside-another-repository",
  "contains-destination": "contains-destination",
  "could-not-be-checked": "could-not-be-checked",
};

/**
 * FR-653 phase 2 for an existing destination. `destId` / `boundRoot` are what the listing bound; the destination is re-resolved
 * (FR-640 again), must still be the same realpath, every selected file is re-classified, and the selection must still fit the limits.
 */
export function copyIgnoredIntoExisting(
  repoPath: string,
  manifest: CopyManifest,
  selectedRowIds: readonly string[],
  binding: { destId: string | null; boundRoot: string },
  opts: CopyIntoExistingOptions & { signal?: AbortSignal } = {},
): Promise<ExistingCopyOutcome> {
  return wrapGit("copy-ignored", async () => {
    const totals: CopyTotals = { copied: 0, skipped: 0, bytes: 0 };
    const refused = (reason: ExistingCopyRefusal): ExistingCopyOutcome => ({ status: "refused", reason, results: [], totals });
    const resolved = await resolveDestinationWorktree(repoPath, binding.destId, manifest.sourceRoot);
    if (!resolved.ok) return refused("not-a-worktree");
    const dest = resolved.dest;
    if (relatePaths(await realpathBestEffort(binding.boundRoot), dest.root) !== "same") return refused("destination-changed");

    const rowsById = new Map(manifest.rows.map((r) => [r.id, r]));
    const wanted = [...new Set(selectedRowIds)];
    const selected = wanted.map((id) => rowsById.get(id)).filter((r): r is NonNullable<typeof r> => r !== undefined && !r.disabledReason);
    const contains = await rowsContainingDestination(manifest, dest.root);
    const indexes = [...new Set(selected.flatMap((r) => r.fileIndexes))];
    let classification: FileClassification;
    try {
      classification = await classifyFilesAgainstDestination(manifest, indexes, dest, contains, opts);
    } catch (err) {
      if (err instanceof TrackedCheckFailedError) return refused("tracked-check-failed");
      throw err;
    }
    // FR-651: the limit counts only the files that can actually be copied.
    const copyable = indexes.filter((i) => classification.states.get(i) === null);
    const limits = { maxFiles: COPY_MAX_FILES, maxBytes: COPY_MAX_BYTES, ...opts.limits };
    if (copyable.length > limits.maxFiles || copyable.reduce((n, i) => n + Number(manifest.files[i]!.size), 0) > limits.maxBytes) return refused("over-limit");

    // FR-653: re-enumerate the SOURCE; a file inside a ticked directory row that the user never saw listed is reported, never copied.
    const extras: CopyFileResult[] = [];
    let extraCount = 0;
    for (const row of selected) {
      if (!row.isDirectory) continue;
      const e = await enumerateIgnored(manifest.sourceRoot, ["--exclude-standard", "-z", "--", row.path], { ...opts.enumerate, signal: opts.signal ?? opts.enumerate?.signal });
      if (e.status === "failed") return refused("source-changed");
      const known = new Set<string>([...row.fileIndexes.map((i) => manifest.files[i]!.path), ...(row.droppedPaths ?? [])]);
      for (const p of e.paths) {
        if (known.has(p) || p.endsWith("/") || !validateCopyPath(p).ok) continue;
        if (extras.length < 200) extras.push({ path: p, rowId: row.id, outcome: "skipped", reason: "changed-since-review", message: "changed since you reviewed" });
        extraCount++;
      }
    }

    const stateByFile = new Map(indexes.map((i) => [manifest.files[i]!, classification.states.get(i) ?? null] as const));
    const outcome = await copyFromManifest(manifest, wanted, dest.root, {
      limits: opts.limits,
      signal: opts.signal,
      onProgress: opts.onProgress,
      fs: opts.fs,
      now: opts.now,
      platform: opts.platform,
      expectedDestReal: dest.root,
      // Tracked-ness was asked of git in bounded batches above (FR-652 M7); the Create engine's unbounded `ls-files` is not used here.
      listTracked: async () => [],
      preCheck: async (file) => {
        const state = stateByFile.get(file);
        return state ? SKIP_FOR_STATE[state] : null;
      },
    });
    if (outcome.status === "refused") return refused(outcome.reason === "source-changed" ? "source-changed" : "destination-changed");
    return {
      status: outcome.status,
      results: [...extras, ...outcome.results],
      totals: { copied: outcome.totals.copied, skipped: outcome.totals.skipped + extraCount, bytes: outcome.totals.bytes },
      destination: dest,
    };
  });
}
