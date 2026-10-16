// SPDX-License-Identifier: GPL-3.0-or-later
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { getEmptyHooksDir } from "./emptyHooksDir";
import { enumerateIgnored, listIgnoredCandidates, resolveSourceWorktree, type ListFailureReason, type ListIgnoredOptions } from "./worktreeCopy";
import {
  createExclusiveFlags,
  errCode,
  readFlags,
  realCopyFs,
  sameFileIdentity,
  type CopyFs,
  type FsHandle,
  type FsStat,
} from "./worktreeCopyFs";
import { COPY_SKIP_MESSAGES, validateCopyPath, type CandidateDisabledReason, type CopySkipReason } from "./worktreeCopyPure";
import { wrapGit, wtRun } from "./worktreeRunner";

/**
 * Two-phase copy (specs/worktree-copy-ignored.md FR-643 + FR-630). `buildCopyManifest` freezes what the user reviewed;
 * `copyFromManifest` copies only files that are in it and unchanged, file by file, through handles. Never `fs.copyFile`/`cp`,
 * never a script, never a shell, never network, and no file content or raw OS error text in any result.
 */

export const COPY_MAX_FILES = 5000;
export const COPY_MAX_BYTES = 200 * 1024 * 1024;
export const COPY_MAX_MS = 60_000;
export const COPY_PROGRESS_AFTER_MS = 2000;
const MANIFEST_MAX_FILES = 20_000;
const ROW_MAX_FILES = COPY_MAX_FILES + 1;
const CHUNK = 64 * 1024;

export interface CopyManifestFile {
  /** As git reports it (`/` separators). */
  path: string;
  rowId: string;
  /** Decimal strings so the manifest stays JSON-serialisable. */
  size: string;
  mtimeNs: string;
  dev: string;
  ino: string;
}

export interface CopyManifestRow {
  /** The row's path; the renderer selects rows by this id and never sends raw paths. */
  id: string;
  path: string;
  isDirectory: boolean;
  /** Indexes into `files`. */
  fileIndexes: number[];
  fileCount: number;
  bytes: number;
  disabledReason: CandidateDisabledReason | null;
}

export interface CopyManifest {
  version: 1;
  createdAt: number;
  /** Admin-dir name of the source worktree; null for the main worktree. */
  sourceWorktreeId: string | null;
  /** Real path of the source worktree. */
  sourceRoot: string;
  /** Slot for the main process (sha256 repo key, FR-629/FR-643); git-core leaves it null. */
  repoKey: string | null;
  /** Random single-use token slot; the main process owns binding, expiry and single use. */
  token: string;
  rows: CopyManifestRow[];
  files: CopyManifestFile[];
}

export interface BuildManifestOptions extends ListIgnoredOptions {
  fs?: CopyFs;
  now?: () => number;
  repoKey?: string | null;
  token?: string;
  /** Per-row file cap (default: the copy limit + 1); a bigger row is disabled as "too-many-files". */
  rowMaxFiles?: number;
}

export type BuildManifestResult = { status: "ok"; manifest: CopyManifest } | { status: "failed"; reason: ListFailureReason };

const identityStrings = (st: FsStat): { size: string; mtimeNs: string; dev: string; ino: string } => ({
  size: String(st.size),
  mtimeNs: String(st.mtimeNs),
  dev: String(st.dev),
  ino: String(st.ino),
});

/** FR-643 phase 1: re-enumerate in the source worktree and record every file of every selectable row with its identity. */
export function buildCopyManifest(repoPath: string, sourceWorktreePath: string, opts: BuildManifestOptions = {}): Promise<BuildManifestResult> {
  return wrapGit("list-ignored", async () => {
    const cfs = opts.fs ?? realCopyFs;
    const src = await resolveSourceWorktree(repoPath, sourceWorktreePath);
    if ("failed" in src) return { status: "failed", reason: src.failed };
    const manifest: CopyManifest = {
      version: 1,
      createdAt: (opts.now ?? Date.now)(),
      sourceWorktreeId: src.id,
      sourceRoot: src.root,
      repoKey: opts.repoKey ?? null,
      token: opts.token ?? randomBytes(24).toString("base64url"),
      rows: [],
      files: [],
    };
    if (src.bare) return { status: "ok", manifest };
    const listing = await listIgnoredCandidates(repoPath, sourceWorktreePath, opts);
    if (listing.status === "failed") return listing;

    for (const c of listing.candidates) {
      const row: CopyManifestRow = { id: c.path, path: c.path, isDirectory: c.isDirectory, fileIndexes: [], fileCount: 0, bytes: 0, disabledReason: c.disabledReason ?? null };
      manifest.rows.push(row);
      if (row.disabledReason) continue;
      let paths: string[];
      if (c.isDirectory) {
        const e = await enumerateIgnored(src.root, ["--exclude-standard", "-z", "--", c.path], { ...opts, maxRows: opts.rowMaxFiles ?? ROW_MAX_FILES });
        if (e.status === "failed") {
          if (e.reason !== "too-many-files") return e;
          row.disabledReason = "too-many-files";
          continue;
        }
        paths = e.paths;
      } else {
        paths = [c.path];
      }
      if (manifest.files.length + paths.length > MANIFEST_MAX_FILES) {
        row.disabledReason = "too-many-files";
        continue;
      }
      for (const p of paths) {
        if (!validateCopyPath(p).ok) continue;
        let st: FsStat;
        try {
          st = await cfs.lstat(path.join(src.root, ...p.split("/")));
        } catch {
          continue;
        }
        if (!st.isFile()) continue;
        row.fileIndexes.push(manifest.files.length);
        manifest.files.push({ path: p, rowId: row.id, ...identityStrings(st) });
        row.fileCount++;
        row.bytes += Number(st.size);
      }
    }
    return { status: "ok", manifest };
  });
}

// --- phase 2 ---

export type CopyFileResult =
  | { path: string; rowId: string; outcome: "copied"; bytes: number }
  | { path: string; rowId: string; outcome: "skipped"; reason: CopySkipReason; message: string };

export interface CopyTotals {
  copied: number;
  skipped: number;
  bytes: number;
}

export type CopyOutcome =
  | { status: "done" | "cancelled" | "limit"; results: CopyFileResult[]; totals: CopyTotals }
  | { status: "refused"; reason: "destination-invalid" | "source-changed"; results: []; totals: CopyTotals };

export interface CopyProgress {
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
}

export interface CopyOptions {
  limits?: Partial<{ maxFiles: number; maxBytes: number; maxMs: number; progressAfterMs: number }>;
  signal?: AbortSignal;
  /** Called once 2 s have passed, then at most once a second. */
  onProgress?: (p: CopyProgress) => void;
  fs?: CopyFs;
  now?: () => number;
  /** Test seam; the platform whose path-length rule applies. */
  platform?: string;
  /** Test seam replacing `git ls-files -z` in the destination. */
  listTracked?: (destination: string) => Promise<string[]>;
}

const collisionKey = (p: string): string => p.normalize("NFC").toLowerCase();

class Stop extends Error {
  constructor(readonly reason: CopySkipReason) {
    super(reason);
  }
}

const fold = (p: string, platform: string): string => (platform === "win32" ? p.toLowerCase() : p);

async function trackedPaths(destination: string): Promise<string[]> {
  const hooks = await getEmptyHooksDir();
  const { stdout } = await wtRun(["-c", `core.hooksPath=${hooks}`, "ls-files", "-z"], destination);
  const out = stdout.split("\0");
  if (out[out.length - 1] === "") out.pop();
  return out;
}

/** FR-630 + FR-643 phase 2. Only manifest files of the selected rows, only if unchanged; every other case is a typed skip. */
export function copyFromManifest(manifest: CopyManifest, selectedRowIds: readonly string[], destinationWorktreePath: string, opts: CopyOptions = {}): Promise<CopyOutcome> {
  return wrapGit("copy-ignored", () => copyCore(manifest, selectedRowIds, destinationWorktreePath, opts));
}

async function copyCore(manifest: CopyManifest, selectedRowIds: readonly string[], destinationPath: string, opts: CopyOptions): Promise<CopyOutcome> {
  const cfs = opts.fs ?? realCopyFs;
  const now = opts.now ?? Date.now;
  const platform = opts.platform ?? process.platform;
  const limits = { maxFiles: COPY_MAX_FILES, maxBytes: COPY_MAX_BYTES, maxMs: COPY_MAX_MS, progressAfterMs: COPY_PROGRESS_AFTER_MS, ...opts.limits };
  const totals: CopyTotals = { copied: 0, skipped: 0, bytes: 0 };
  const refused = (reason: "destination-invalid" | "source-changed"): CopyOutcome => ({ status: "refused", reason, results: [], totals });

  let srcReal: string;
  let destReal: string;
  try {
    srcReal = await cfs.realpath(manifest.sourceRoot);
    destReal = await cfs.realpath(destinationPath);
    const dst = await cfs.lstat(destReal);
    if (!dst.isDirectory()) return refused("destination-invalid");
    await cfs.lstat(path.join(destReal, ".git"));
  } catch {
    return refused("destination-invalid");
  }
  if (fold(srcReal, platform) !== fold(manifest.sourceRoot, platform)) return refused("source-changed");
  if (fold(srcReal, platform) === fold(destReal, platform)) return refused("destination-invalid");

  const tracked = await (opts.listTracked ?? trackedPaths)(destReal);
  const trackedKeys = new Set<string>();
  for (const t of tracked) trackedKeys.add(collisionKey(t));
  const trackedDirKeys = new Set<string>();
  for (const t of tracked) {
    const parts = t.split("/");
    for (let i = 1; i < parts.length; i++) trackedDirKeys.add(collisionKey(parts.slice(0, i).join("/")));
  }
  const copiedFileKeys = new Set<string>();
  const copiedDirKeys = new Set<string>();

  // Selected rows to files, in row order, each file once.
  const rowsById = new Map(manifest.rows.map((r) => [r.id, r]));
  const results: CopyFileResult[] = [];
  const queue: { file: CopyManifestFile; rowId: string }[] = [];
  const seen = new Set<number>();
  const skip = (p: string, rowId: string, reason: CopySkipReason): void => {
    totals.skipped++;
    results.push({ path: p, rowId, outcome: "skipped", reason, message: COPY_SKIP_MESSAGES[reason] });
  };
  for (const id of selectedRowIds) {
    const row = rowsById.get(id);
    if (!row) {
      skip(id, id, "not-in-manifest");
      continue;
    }
    if (row.disabledReason) {
      skip(row.path, row.id, "row-disabled");
      continue;
    }
    for (const i of row.fileIndexes) {
      const file = manifest.files[i];
      if (file && !seen.has(i)) {
        seen.add(i);
        queue.push({ file, rowId: row.id });
      }
    }
  }

  const start = now();
  let lastProgress = -Infinity;
  let filesDone = 0;
  const tick = (): void => {
    if (!opts.onProgress) return;
    const t = now();
    if (t - start >= limits.progressAfterMs && t - lastProgress >= 1000) {
      lastProgress = t;
      opts.onProgress({ filesDone, filesTotal: queue.length, bytesDone: totals.bytes });
    }
  };
  const guard = (): void => {
    if (opts.signal?.aborted) throw new Stop("cancelled");
    if (now() - start > limits.maxMs) throw new Stop("time-limit");
  };

  let stopped: CopySkipReason | null = null;
  for (const { file, rowId } of queue) {
    if (stopped) {
      skip(file.path, rowId, stopped);
      continue;
    }
    try {
      guard();
      if (totals.copied >= limits.maxFiles) throw new Stop("file-limit");
      if (totals.bytes + Number(file.size) > limits.maxBytes) throw new Stop("size-limit");
      const bytes = await copyOne(file);
      totals.copied++;
      totals.bytes += bytes;
      results.push({ path: file.path, rowId, outcome: "copied", bytes });
    } catch (err) {
      const reason: CopySkipReason = err instanceof Stop ? err.reason : "write-failed";
      if (reason === "cancelled" || reason === "time-limit" || reason === "file-limit" || reason === "size-limit") stopped = reason;
      skip(file.path, rowId, reason);
    }
    filesDone++;
    tick();
  }
  const status = opts.signal?.aborted || stopped === "cancelled" ? "cancelled" : stopped ? "limit" : "done";
  return { status, results, totals };

  async function copyOne(file: CopyManifestFile): Promise<number> {
    const rel = file.path;
    if (!validateCopyPath(rel).ok) throw new Stop("unsafe-path");
    const segs = rel.split("/");
    const parents = segs.slice(0, -1);
    const srcAbs = path.join(srcReal, ...segs);
    const destAbs = path.join(destReal, ...segs);
    if (platform === "win32" && destAbs.length >= 260) throw new Stop("path-too-long");

    // Name collisions with tracked files (incl. case/Unicode folding and a tracked link used as a parent) and earlier copies.
    const key = collisionKey(rel);
    const prefixKeys = parents.map((_, i) => collisionKey(parents.slice(0, i + 1).join("/")));
    if (trackedKeys.has(key)) throw new Stop("tracked-in-destination");
    if (trackedDirKeys.has(key) || prefixKeys.some((k) => trackedKeys.has(k)) || copiedFileKeys.has(key) || prefixKeys.some((k) => copiedFileKeys.has(k)) || copiedDirKeys.has(key)) {
      throw new Stop("case-collision");
    }

    // Source: parents are plain directories, the file is regular and unchanged, opened without following links.
    let cur = srcReal;
    for (const p of parents) {
      cur = path.join(cur, p);
      let st: FsStat;
      try {
        st = await cfs.lstat(cur);
      } catch {
        throw new Stop("changed-since-review");
      }
      if (st.isSymbolicLink() || !st.isDirectory()) throw new Stop("source-parent-link");
    }
    let lst: FsStat;
    try {
      lst = await cfs.lstat(srcAbs);
    } catch {
      throw new Stop("changed-since-review");
    }
    if (lst.isSymbolicLink()) throw new Stop("source-symlink");
    if (!lst.isFile()) throw new Stop("not-regular-file");
    const expected = { dev: BigInt(file.dev), ino: BigInt(file.ino), size: BigInt(file.size), mtimeNs: BigInt(file.mtimeNs) };
    if (!sameFileIdentity(lst, expected)) throw new Stop("changed-since-review");

    let src: FsHandle;
    try {
      src = await cfs.open(srcAbs, readFlags());
    } catch (err) {
      const c = errCode(err);
      throw new Stop(c === "ELOOP" ? "source-symlink" : c === "ENOENT" ? "changed-since-review" : "source-unreadable");
    }
    let dst: FsHandle | null = null;
    let created = false;
    let destIdentity: FsStat | null = null;
    try {
      const st = await src.stat();
      if (!st.isFile()) throw new Stop("not-regular-file");
      if (!sameFileIdentity(st, expected) || !sameFileIdentity(st, lst)) throw new Stop("changed-since-review");
      // The open ran against the path: confirm the parent still resolves where the checks above looked (no-follow is a no-op on Windows).
      const srcParentReal = await cfs.realpath(path.dirname(srcAbs)).catch(() => null);
      if (srcParentReal === null || fold(srcParentReal, platform) !== fold(path.join(srcReal, ...parents), platform)) throw new Stop("source-parent-link");

      // Destination: one level at a time, never through a link.
      let dcur = destReal;
      for (const p of parents) {
        dcur = path.join(dcur, p);
        let dstat: FsStat | null = await cfs.lstat(dcur).catch(() => null);
        if (!dstat) {
          try {
            await cfs.mkdir(dcur);
          } catch (err) {
            if (errCode(err) !== "EEXIST") throw new Stop("write-failed");
          }
          dstat = await cfs.lstat(dcur).catch(() => null);
          if (!dstat) throw new Stop("write-failed");
        }
        if (dstat.isSymbolicLink()) throw new Stop("destination-parent-link");
        if (!dstat.isDirectory()) throw new Stop("destination-not-directory");
      }
      try {
        dst = await cfs.open(destAbs, createExclusiveFlags(), Number(st.mode & 0o777n));
        created = true;
      } catch (err) {
        const c = errCode(err);
        throw new Stop(c === "EEXIST" ? "already-exists" : c === "ELOOP" ? "destination-parent-link" : "write-failed");
      }
      destIdentity = await dst.stat();
      const dParentReal = await cfs.realpath(path.dirname(destAbs)).catch(() => null);
      if (dParentReal === null || fold(dParentReal, platform) !== fold(path.join(destReal, ...parents), platform)) throw new Stop("destination-parent-link");

      const buf = Buffer.allocUnsafe(CHUNK);
      let total = 0;
      for (;;) {
        guard();
        const { bytesRead } = await src.read(buf, 0, CHUNK, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        // The budget is enforced while streaming: a file that grew since review cannot slip past the manifest size.
        if (BigInt(total) > expected.size) throw new Stop("changed-since-review");
        if (totals.bytes + total > limits.maxBytes) throw new Stop("size-limit");
        let off = 0;
        while (off < bytesRead) off += (await dst.write(buf, off, bytesRead - off)).bytesWritten;
        tick();
      }
      if (BigInt(total) !== expected.size) throw new Stop("changed-since-review");
      const after = await src.stat();
      if (!sameFileIdentity(after, expected)) throw new Stop("changed-since-review");
      await dst.close();
      dst = null;
      copiedFileKeys.add(key);
      for (const k of prefixKeys) copiedDirKeys.add(k);
      return total;
    } catch (err) {
      if (dst) await dst.close().catch(() => undefined);
      dst = null;
      if (created) await removeOurs(destAbs, destIdentity);
      if (err instanceof Stop) throw err;
      throw new Stop("write-failed");
    } finally {
      await src.close().catch(() => undefined);
    }
  }

  /** Remove the file we just created (never one that appeared there since): checked by identity when the platform reports it. */
  async function removeOurs(p: string, ident: FsStat | null): Promise<void> {
    try {
      const st = await cfs.lstat(p);
      if (st.isSymbolicLink() || !st.isFile()) return;
      if (ident && ident.ino !== 0n && st.ino !== ident.ino) return;
      await cfs.unlink(p);
    } catch {
      // nothing more we can safely do
    }
  }
}
