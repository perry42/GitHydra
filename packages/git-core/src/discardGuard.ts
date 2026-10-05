// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runGit, runGitAllowingExitCodes, runGitWithInput, withReadOnlyIndex, withFsmonitorNeutralized } from "./gitProcess";
import { DiscardBackupError, DiscardFingerprintError, GitCommandError, InvalidArgumentError, StaleDiffError } from "./errors";
import { assertPathWithinWorkdir, isErrnoException } from "./pathSafety";
import { batchArgs } from "./argvBatch";

/**
 * Whole-file discard guard (security review H1): one opaque fingerprint of everything a discard would
 * destroy or reset, re-verified inside the same mutation-queue slot as the destructive git command, plus a
 * dangling-blob safety copy of the worktree content. Reads only; nothing here mutates the index or worktree.
 */

export type DiscardKind = "tracked" | "untracked";

/** Streaming-hash ceiling. Above it the fingerprint falls back to size+mtimeMs+ino (weaker: an in-place same-size edit that preserves mtime is missed). */
export const DISCARD_HASH_CAP_BYTES = 256 * 1024 * 1024;
/** Safety-copy ceiling: the bytes are buffered whole for `hash-object --stdin`, so larger files are discarded without a copy. */
export const DISCARD_BACKUP_CAP_BYTES = 64 * 1024 * 1024;

const CHUNK = 1024 * 1024;

export type DiscardBackupSkipReason = "too-large" | "not-a-regular-file" | "absent";

export interface DiscardBackupInfo {
  /** Loose blob holding the pre-discard worktree bytes (`git cat-file -p <oid>`; `git fsck --lost-found` finds it once unreferenced), or null when none was written. */
  oid: string | null;
  skipped?: DiscardBackupSkipReason;
}

export interface DiscardOptions {
  /** From `getDiscardFingerprint`; a mismatch inside the queue slot throws `StaleDiffError` and changes nothing. Required: an unguarded whole-file discard is not offered (security review INFO 3). */
  expectedFingerprint: string;
  /** Called after the safety copy is written (or deliberately skipped), before the destructive command runs. */
  onBackup?: (info: DiscardBackupInfo) => void;
}

interface Observed {
  fingerprint: string;
  /** Worktree part only (no git side), for the bulk path's cheap re-checks. */
  worktreeFingerprint: string;
  /** Present only for a regular file small enough to back up. */
  bytes: Buffer | null;
  state: "regular" | "absent" | "other" | "directory";
  tooLarge: boolean;
  /** Bytes hashed (or stat size above the hash cap); 0 for non-regular entries. Sizes the bulk sub-batches. */
  size: number;
}

function sha256(...parts: string[]): string {
  const h = createHash("sha256");
  for (const p of parts) h.update(p).update("\0");
  return h.digest("hex");
}

async function assertNoSymlinkedComponent(workdir: string, abs: string, filePath: string): Promise<"ok" | "absent"> {
  const root = path.resolve(workdir);
  const rel = path.relative(root, path.dirname(abs));
  if (rel === "") return "ok";
  let cur = root;
  for (const seg of rel.split(path.sep)) {
    cur = path.join(cur, seg);
    let st;
    try {
      st = await fs.lstat(cur);
    } catch (err) {
      if (isErrnoException(err) && (err.code === "ENOENT" || err.code === "ENOTDIR")) return "absent";
      throw new DiscardFingerprintError(filePath, isErrnoException(err) ? String(err.code) : "unreadable");
    }
    if (st.isSymbolicLink()) throw new DiscardFingerprintError(filePath, "a parent folder is a symbolic link");
  }
  return "ok";
}

/** Reads the worktree entry without following symlinks; hashes streaming so large and binary files never need to fit in memory. */
async function observeWorktree(workdir: string, filePath: string, keepBytes: boolean): Promise<Omit<Observed, "worktreeFingerprint">> {
  const abs = path.resolve(workdir, filePath);
  if ((await assertNoSymlinkedComponent(workdir, abs, filePath)) === "absent") {
    return { fingerprint: sha256("absent"), bytes: null, state: "absent", tooLarge: false, size: 0 };
  }
  let st;
  try {
    st = await fs.lstat(abs);
  } catch (err) {
    if (isErrnoException(err) && (err.code === "ENOENT" || err.code === "ENOTDIR")) {
      return { fingerprint: sha256("absent"), bytes: null, state: "absent", tooLarge: false, size: 0 };
    }
    throw new DiscardFingerprintError(filePath, isErrnoException(err) ? String(err.code) : "unreadable");
  }
  if (st.isSymbolicLink()) {
    let target: string;
    try {
      target = await fs.readlink(abs);
    } catch {
      throw new DiscardFingerprintError(filePath, "unreadable symbolic link");
    }
    return { fingerprint: sha256("symlink", target), bytes: null, state: "other", tooLarge: false, size: 0 };
  }
  if (!st.isFile()) {
    return { fingerprint: sha256(st.isDirectory() ? "dir" : "other"), bytes: null, state: st.isDirectory() ? "directory" : "other", tooLarge: false, size: 0 };
  }

  // Windows has no O_NOFOLLOW; there the lstat above plus the ino identity check below are the defence.
  let fh;
  try {
    fh = await fs.open(abs, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (err) {
    throw new DiscardFingerprintError(filePath, isErrnoException(err) ? String(err.code) : "unreadable");
  }
  try {
    const hst = await fh.stat();
    if (!hst.isFile() || (st.ino !== 0 && hst.ino !== 0 && st.ino !== hst.ino)) {
      throw new DiscardFingerprintError(filePath, "changed while being read");
    }
    const mode = process.platform === "win32" ? "-" : String(hst.mode & 0o111);
    if (hst.size > DISCARD_HASH_CAP_BYTES) {
      return {
        fingerprint: sha256("regular-stat", mode, String(hst.size), String(hst.mtimeMs), String(hst.ino)),
        bytes: null,
        state: "regular",
        tooLarge: true,
        size: hst.size,
      };
    }
    const hash = createHash("sha256");
    const chunks: Buffer[] = [];
    const keep = keepBytes && hst.size <= DISCARD_BACKUP_CAP_BYTES;
    let total = 0;
    // Fixed size, not sized from the stat: a file stat'd at 0 bytes that then grows would otherwise be read 1 byte per iteration.
    const buf = Buffer.allocUnsafe(CHUNK);
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      // A file growing past the cap while read cannot be fingerprinted faithfully; refuse rather than guess.
      if (total > DISCARD_HASH_CAP_BYTES) throw new DiscardFingerprintError(filePath, "grew while being read");
      hash.update(buf.subarray(0, bytesRead));
      if (keep) chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
    }
    const keptBytes = keep && total <= DISCARD_BACKUP_CAP_BYTES ? Buffer.concat(chunks) : null;
    return {
      fingerprint: sha256("regular", mode, String(total), hash.digest("hex")),
      bytes: keptBytes,
      state: "regular",
      tooLarge: total > DISCARD_BACKUP_CAP_BYTES,
      size: total,
    };
  } finally {
    await fh.close();
  }
}

function gitSideDigest(kind: DiscardKind, head: string, stage: string): string {
  if (kind === "untracked") return sha256("untracked", stage === "" ? "none" : stage);
  return sha256("tracked", head === "" ? "none" : head, stage === "" ? "none" : stage);
}

/** Splits `-z` records into `[path, record-with-its-NUL]`; `ls-files --stage` and `ls-tree` both put the path after the tab. */
function* zRecords(stdout: string): Generator<[string, string]> {
  let start = 0;
  while (start < stdout.length) {
    let end = stdout.indexOf("\0", start);
    if (end === -1) end = stdout.length;
    const tab = stdout.indexOf("\t", start);
    if (tab !== -1 && tab < end) yield [stdout.slice(tab + 1, end), stdout.slice(start, Math.min(end + 1, stdout.length))];
    start = end + 1;
  }
}

/**
 * Raw `ls-files --stage` (mode, oid, stage of every entry) and `ls-tree HEAD` for each path, digested per path.
 * One `ls-files` and one `ls-tree` per argv-sized batch instead of two per file; each path's slice of the output is the
 * exact text a single-path call would have printed, so digests equal the one-file form (unborn HEAD reads as no entry).
 */
async function readGitSides(workdir: string, items: readonly { path: string; kind: DiscardKind }[]): Promise<Map<string, string>> {
  const kindOf = new Map(items.map((i) => [i.path, i.kind] as const));
  const out = new Map<string, string>();
  for (const batch of batchArgs([...kindOf.keys()], 120)) {
    const wanted = new Set(batch);
    const stage = new Map<string, string>();
    const stageOut = (await runGit(withReadOnlyIndex(["--literal-pathspecs", "ls-files", "--stage", "-z", "--", ...batch]), { cwd: workdir })).stdout;
    for (const [p, rec] of zRecords(stageOut)) {
      // A pathspec naming a directory also matches everything under it, exactly like the single-path call.
      for (let cur = p; ; ) {
        if (wanted.has(cur)) stage.set(cur, (stage.get(cur) ?? "") + rec);
        const slash = cur.lastIndexOf("/");
        if (slash <= 0) break;
        cur = cur.slice(0, slash);
      }
    }
    const head = new Map<string, string>();
    const trackedBatch = batch.filter((p) => kindOf.get(p) === "tracked");
    if (trackedBatch.length > 0) {
      let headOut: string;
      try {
        headOut = (await runGit(withReadOnlyIndex(["--literal-pathspecs", "ls-tree", "-z", "HEAD", "--", ...trackedBatch]), { cwd: workdir })).stdout;
      } catch (err) {
        if (!(err instanceof GitCommandError)) throw err;
        const probe = await runGitAllowingExitCodes(["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: workdir }, [0, 1]);
        if (probe.exitCode === 0) throw err;
        headOut = ""; // unborn HEAD
      }
      for (const [p, rec] of zRecords(headOut)) if (wanted.has(p)) head.set(p, (head.get(p) ?? "") + rec);
    }
    for (const p of batch) out.set(p, gitSideDigest(kindOf.get(p)!, head.get(p) ?? "", stage.get(p) ?? ""));
  }
  return out;
}

/** Git-side digests for a chunk of rows about to be discarded, plus which untracked paths `git clean` would still treat as untracked. */
export async function readSharedGitSides(
  workdir: string,
  items: readonly { path: string; kind: DiscardKind }[],
): Promise<Map<string, { gitSide: string; untrackedListed?: boolean }>> {
  const digests = await readGitSides(workdir, items);
  const listed = new Set<string>();
  const untrackedPaths = items.filter((i) => i.kind === "untracked").map((i) => i.path);
  for (const batch of batchArgs(untrackedPaths, 120)) {
    const r = await runGit(withReadOnlyIndex(["--literal-pathspecs", "ls-files", "--others", "--exclude-standard", "-z", "--", ...batch]), { cwd: workdir });
    for (const rec of r.stdout.split("\0")) if (rec) listed.add(rec);
  }
  return new Map(items.map((i) => [i.path, { gitSide: digests.get(i.path)!, ...(i.kind === "untracked" ? { untrackedListed: listed.has(i.path) } : {}) }]));
}

function combineFingerprint(workdir: string, filePath: string, kind: DiscardKind, gitSide: string, worktreeFp: string): string {
  // Path + kind are hashed in so identical bytes at two paths never share a fingerprint (security review L-A).
  const rel = path.relative(path.resolve(workdir), path.resolve(workdir, filePath)).split(path.sep).join("/");
  return sha256("githydra-discard-v2", kind, rel, gitSide, worktreeFp);
}

async function observe(workdir: string, filePath: string, kind: DiscardKind, keepBytes: boolean, shared?: { gitSide: string }): Promise<Observed> {
  if (shared) {
    const wt = await observeWorktree(workdir, filePath, keepBytes);
    return { ...wt, worktreeFingerprint: wt.fingerprint, fingerprint: combineFingerprint(workdir, filePath, kind, shared.gitSide, wt.fingerprint) };
  }
  const gitSide = (await readGitSides(workdir, [{ path: filePath, kind }])).get(filePath)!;
  const wt = await observeWorktree(workdir, filePath, keepBytes);
  // Re-read the git side after the worktree read: if HEAD/index moved meanwhile the pair is inconsistent, so refuse.
  const gitSideAfter = (await readGitSides(workdir, [{ path: filePath, kind }])).get(filePath)!;
  if (gitSide !== gitSideAfter) throw new DiscardFingerprintError(filePath, "changed while being read");
  return { ...wt, worktreeFingerprint: wt.fingerprint, fingerprint: combineFingerprint(workdir, filePath, kind, gitSide, wt.fingerprint) };
}

export type DiscardFingerprintOutcome = { ok: true; fingerprint: string } | { ok: false; error: unknown };

/**
 * Same fingerprints as `getDiscardFingerprint`, for many files at once: git-side state is read per argv batch (before and
 * after the worktree reads, keeping the "changed while being read" check) instead of per file. Paths must be unique.
 */
export async function getDiscardFingerprints(
  workdir: string,
  items: readonly { path: string; kind: DiscardKind }[],
  concurrency = 8,
): Promise<Map<string, DiscardFingerprintOutcome>> {
  const out = new Map<string, DiscardFingerprintOutcome>();
  const valid: { path: string; kind: DiscardKind }[] = [];
  for (const it of items) {
    try {
      assertPathWithinWorkdir(workdir, it.path);
      if (it.kind !== "tracked" && it.kind !== "untracked") throw new DiscardFingerprintError(it.path, "unknown kind");
      valid.push(it);
    } catch (error) {
      out.set(it.path, { ok: false, error });
    }
  }
  const before = await readGitSides(workdir, valid);
  const wtFp = new Map<string, string>();
  const wtErr = new Map<string, unknown>();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, valid.length) }, async () => {
      while (next < valid.length) {
        const it = valid[next++]!;
        try {
          wtFp.set(it.path, (await observeWorktree(workdir, it.path, false)).fingerprint);
        } catch (error) {
          wtErr.set(it.path, error);
        }
      }
    }),
  );
  const after = await readGitSides(workdir, valid);
  for (const it of valid) {
    if (wtErr.has(it.path)) out.set(it.path, { ok: false, error: wtErr.get(it.path) });
    else if (before.get(it.path) !== after.get(it.path)) out.set(it.path, { ok: false, error: new DiscardFingerprintError(it.path, "changed while being read") });
    else out.set(it.path, { ok: true, fingerprint: combineFingerprint(workdir, it.path, it.kind, before.get(it.path)!, wtFp.get(it.path)!) });
  }
  return out;
}

/**
 * Opaque fingerprint of everything a whole-file discard of `filePath` would destroy or reset: the HEAD entry,
 * every index entry (mode, blob, stage), and the worktree entry's type, executable bit and content (see
 * `DISCARD_HASH_CAP_BYTES` for the large-file fallback). Throws `DiscardFingerprintError` when it cannot be
 * computed faithfully (symlinked parent folder, unreadable, changing while read); callers must then refuse.
 */
export async function getDiscardFingerprint(workdir: string, filePath: string, kind: DiscardKind): Promise<string> {
  assertPathWithinWorkdir(workdir, filePath);
  if (kind !== "tracked" && kind !== "untracked") throw new DiscardFingerprintError(filePath, "unknown kind");
  return (await observe(workdir, filePath, kind, false)).fingerprint;
}

async function writeBackup(workdir: string, filePath: string, obs: Observed): Promise<DiscardBackupInfo> {
  if (obs.state === "absent") return { oid: null, skipped: "absent" };
  if (obs.state === "other") return { oid: null, skipped: "not-a-regular-file" };
  // Above the cap we proceed without a copy rather than make large-file discards impossible; reported via `skipped`.
  if (obs.tooLarge || obs.bytes === null) return { oid: null, skipped: "too-large" };
  try {
    // --stdin of the exact bytes that were fingerprinted: no re-read by git, no clean/autocrlf filters rewriting them.
    const r = await runGitWithInput(
      withFsmonitorNeutralized(["hash-object", "-w", "--stdin"]),
      { cwd: workdir },
      obs.bytes,
    );
    const oid = r.stdout.trim();
    if (!/^[0-9a-f]{40,64}$/.test(oid)) throw new Error("unexpected hash-object output");
    return { oid };
  } catch (err) {
    throw new DiscardBackupError(filePath, err instanceof Error ? err.message.split("\n")[0]! : "unknown error");
  }
}

let afterCheckHook: (() => Promise<void>) | null = null;

/** Test-only: runs after the fingerprint check and safety copy, before the destructive step (simulates a late race). */
export function _setDiscardAfterCheckHookForTests(hook: (() => Promise<void>) | null): void {
  afterCheckHook = hook;
}

async function verifyAndBackUp(workdir: string, filePath: string, kind: DiscardKind, options: DiscardOptions): Promise<Observed> {
  if (typeof options?.expectedFingerprint !== "string") throw new InvalidArgumentError("A discard needs the fingerprint read when the user confirmed.");
  const obs = await observe(workdir, filePath, kind, true);
  // A directory cannot be backed up as one blob, and `git clean -f -- <dir>` would delete it recursively.
  if (obs.state === "directory") throw new InvalidArgumentError(`"${filePath}" is a directory; only single files can be discarded.`);
  if (obs.fingerprint !== options.expectedFingerprint) throw new StaleDiffError(filePath);
  const backup = await writeBackup(workdir, filePath, obs);
  options.onBackup?.(backup);
  await afterCheckHook?.();
  return obs;
}

/**
 * Verify, back up, then run `args` as ONE mutation-queue entry (caller supplies the queue wrapper), so no other
 * queued mutation can slip between the check and the destructive command. Residual (accepted): an external
 * process writing in the microseconds between our read and git's own rewrite is not covered by either
 * the check or the copy. Only for `git restore`; a restore of a path that became a directory after the check would
 * replace it, a residual documented in the README (the bulk path re-reads right before each sub-batch to shrink it).
 */
export async function guardedDestructive(
  workdir: string,
  filePath: string,
  kind: DiscardKind,
  args: readonly string[],
  options: DiscardOptions,
): Promise<void> {
  await verifyAndBackUp(workdir, filePath, kind, options);
  // No `mutatesRepository`: the caller already holds the queue (a nested queued call would deadlock).
  await runGit(withFsmonitorNeutralized([...args]), { cwd: workdir });
}

/**
 * Untracked-file discard without `git clean`: `git clean -f -- <path>` deletes a directory recursively when one
 * has replaced the file since the check (security review L-B). `unlink` cannot remove a directory, so a late
 * swap fails instead of recursing. Like `git clean` (no -x), a tracked or ignored path is a silent no-op.
 */
export async function guardedUnlinkUntracked(workdir: string, filePath: string, options: DiscardOptions): Promise<void> {
  const obs = await verifyAndBackUp(workdir, filePath, "untracked", options);
  if (obs.state === "absent") return;
  const listed = await runGit(withReadOnlyIndex(["--literal-pathspecs", "ls-files", "--others", "--exclude-standard", "-z", "--", filePath]), { cwd: workdir });
  if (listed.stdout === "") return;
  await unlinkFile(workdir, filePath);
}

/** Directory-safe delete of one file; shared by the single-file and bulk untracked paths. */
async function unlinkFile(workdir: string, filePath: string): Promise<void> {
  const abs = path.resolve(workdir, filePath);
  try {
    const st = await fs.lstat(abs);
    if (st.isDirectory()) throw new StaleDiffError(filePath);
    // A parent folder swapped for a symlink since the fingerprint would make unlink act outside the repo.
    if ((await assertNoSymlinkedComponent(workdir, abs, filePath)) === "absent") return;
    await fs.unlink(abs);
  } catch (err) {
    if (err instanceof StaleDiffError) throw err;
    if (!isErrnoException(err)) throw err;
    // Gone already: the end state the user asked for, and nothing is lost by treating it as done.
    if (err.code === "ENOENT") return;
    // EISDIR (Linux) / EPERM (Windows, macOS) on a directory swapped in after our lstat.
    try {
      if ((await fs.lstat(abs)).isDirectory()) throw new StaleDiffError(filePath);
    } catch (inner) {
      if (inner instanceof StaleDiffError) throw inner;
    }
    throw new DiscardFingerprintError(filePath, String(err.code));
  }
}

// --- bulk discard (specs/ignore-and-multiselect.md FR-508) ---------------------------------------------------------

export interface BulkGuardRow {
  path: string;
  kind: DiscardKind;
  expectedFingerprint: string;
}

export interface BulkGuardResult {
  discarded: string[];
  /** Safety copies of the rows in `discarded` only. */
  backups: { path: string; backup: DiscardBackupInfo }[];
  /** Untracked rows left alone because git no longer lists them as untracked (became tracked or ignored). */
  skipped: string[];
  /** First row that was not discarded, with the reason. Rows after it that were not touched are in `notAttempted`. */
  failed: { path: string; error: unknown } | null;
  notAttempted: string[];
}

/** Rows that share one git-side read, one safety-copy spawn and one `git restore`; a spawn costs ~0.1-0.5 s on Windows, so per-file git calls do not scale. */
export const BULK_DISCARD_CHUNK = 25;

/** `hash-object --stdin-paths` is line based and unquotes a leading `"`; such names take the per-file `--stdin` route. */
const isPlainStdinPath = (p: string): boolean => !/[\r\n]/.test(p) && !p.startsWith('"');

/** Sub-batch limits for the re-read-then-act step: bytes hashed between the second read and the destructive call stay bounded. */
const SUB_BATCH_MAX_ROWS = 8;
const SUB_BATCH_MAX_BYTES = 32 * 1024 * 1024;

async function writeBackupsBatch(workdir: string, rows: readonly BulkGuardRow[], obs: readonly Observed[]): Promise<DiscardBackupInfo[]> {
  const infos: DiscardBackupInfo[] = obs.map((o): DiscardBackupInfo => {
    if (o.state === "absent") return { oid: null, skipped: "absent" };
    if (o.state === "other") return { oid: null, skipped: "not-a-regular-file" };
    if (o.tooLarge) return { oid: null, skipped: "too-large" };
    return { oid: null };
  });
  // `hash-object --stdin-paths` follows symlinks and would block on a FIFO swapped in since the read: lstat again and skip those rows.
  const regular: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (obs[i]!.state !== "regular" || obs[i]!.tooLarge) continue;
    const st = await fs.lstat(path.resolve(workdir, rows[i]!.path)).catch(() => null);
    if (st?.isFile()) regular.push(i);
    else infos[i] = { oid: null, skipped: st ? "not-a-regular-file" : "absent" };
  }
  const plain = regular.filter((i) => isPlainStdinPath(rows[i]!.path));
  const oidOk = (s: string): boolean => /^[0-9a-f]{40,64}$/.test(s);
  try {
    if (plain.length > 0) {
      // Raw bytes (`--no-filters`) so clean/autocrlf cannot rewrite the copy; git reads the files itself, which the later re-verify closes.
      const r = await runGitWithInput(withFsmonitorNeutralized(["hash-object", "-w", "--no-filters", "--stdin-paths"]), { cwd: workdir }, plain.map((i) => rows[i]!.path).join("\n") + "\n");
      const oids = r.stdout.split("\n").filter((l) => l !== "");
      if (oids.length !== plain.length || !oids.every(oidOk)) throw new Error("unexpected hash-object output");
      plain.forEach((i, k) => (infos[i] = { oid: oids[k]! }));
    }
    for (const i of regular.filter((i) => !plain.includes(i))) {
      let fh;
      try {
        fh = await fs.open(path.resolve(workdir, rows[i]!.path), fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      } catch {
        infos[i] = { oid: null, skipped: "not-a-regular-file" };
        continue;
      }
      let bytes: Buffer;
      try {
        if (!(await fh.stat()).isFile()) {
          infos[i] = { oid: null, skipped: "not-a-regular-file" };
          continue;
        }
        bytes = await fh.readFile();
      } finally {
        await fh.close();
      }
      const oid = (await runGitWithInput(withFsmonitorNeutralized(["hash-object", "-w", "--stdin"]), { cwd: workdir }, bytes)).stdout.trim();
      if (!oidOk(oid)) throw new Error("unexpected hash-object output");
      infos[i] = { oid };
    }
  } catch (err) {
    throw new DiscardBackupError(rows[regular[0] ?? 0]?.path ?? "", err instanceof Error ? err.message.split("\n")[0]! : "unknown error");
  }
  return infos;
}

interface ChunkState {
  backupOf: Map<string, DiscardBackupInfo>;
  done: Set<string>;
  /** Untracked rows left alone because they are no longer untracked-listed; never counted as discarded. */
  skipped: Set<string>;
}

/**
 * Guarded discard of up to `BULK_DISCARD_CHUNK` rows per round. Per chunk: one batched git-side read, pass 1 verifies every
 * row (mutating nothing), one safety-copy batch, then rows are acted on in small sub-batches, each preceded by its own
 * git-side re-read (must equal the first) and worktree re-read, so the window before the destructive call covers only a few
 * rows / `SUB_BATCH_MAX_BYTES`. Caller holds the mutation-queue slot. A failure stops the run; only discarded rows get a `backups` entry.
 */
export async function guardedBulkDiscard(workdir: string, rows: readonly BulkGuardRow[]): Promise<BulkGuardResult> {
  const res: BulkGuardResult = { discarded: [], backups: [], skipped: [], failed: null, notAttempted: [] };
  for (let at = 0; at < rows.length; at += BULK_DISCARD_CHUNK) {
    const chunk = rows.slice(at, at + BULK_DISCARD_CHUNK);
    const st: ChunkState = { backupOf: new Map(), done: new Set(), skipped: new Set() };
    const failure = await runBulkChunk(workdir, chunk, st);
    for (const r of chunk) {
      if (st.done.has(r.path)) {
        res.discarded.push(r.path);
        res.backups.push({ path: r.path, backup: st.backupOf.get(r.path)! });
      } else if (st.skipped.has(r.path)) res.skipped.push(r.path);
    }
    if (failure) {
      const bad = chunk[failure.index]!;
      res.failed = { path: bad.path, error: failure.error };
      const finished = new Set([...res.discarded, ...res.skipped]);
      res.notAttempted = rows.slice(at).filter((r) => r.path !== bad.path && !finished.has(r.path)).map((r) => r.path);
      break;
    }
  }
  return res;
}

type SharedSides = Awaited<ReturnType<typeof readSharedGitSides>>;
type VerifyFn = (row: BulkGuardRow, sides: SharedSides) => Promise<Observed>;

async function runBulkChunk(workdir: string, chunk: readonly BulkGuardRow[], st: ChunkState): Promise<{ index: number; error: unknown } | null> {
  let shared: SharedSides;
  try {
    shared = await readSharedGitSides(workdir, chunk.map((r) => ({ path: r.path, kind: r.kind })));
  } catch (error) {
    return { index: 0, error };
  }
  const verify: VerifyFn = async (row, sides) => {
    const o = await observe(workdir, row.path, row.kind, false, sides.get(row.path)!);
    if (o.state === "directory") throw new InvalidArgumentError(`"${row.path}" is a directory; only single files can be discarded.`);
    if (o.fingerprint !== row.expectedFingerprint) throw new StaleDiffError(row.path);
    return o;
  };

  let failure: { index: number; error: unknown } | null = null;
  const obs: Observed[] = [];
  for (let k = 0; k < chunk.length; k++) {
    try {
      obs.push(await verify(chunk[k]!, shared));
    } catch (error) {
      failure = { index: k, error };
      break;
    }
  }
  const live = chunk.slice(0, obs.length);
  if (live.length === 0) return failure;

  try {
    const infos = await writeBackupsBatch(workdir, live, obs);
    live.forEach((r, k) => st.backupOf.set(r.path, infos[k]!));
    for (let k = 0; k < live.length; k++) await afterCheckHook?.();
  } catch (error) {
    return { index: 0, error }; // nothing destructive ran yet
  }

  for (let from = 0; from < live.length; ) {
    let to = from;
    let bytes = 0;
    while (to < live.length && to - from < SUB_BATCH_MAX_ROWS && (to === from || bytes + obs[to]!.size <= SUB_BATCH_MAX_BYTES)) bytes += obs[to++]!.size;
    const stop = await actOnSubBatch(workdir, live.slice(from, to), shared, verify, st);
    if (stop) return { index: from + stop.index, error: stop.error };
    from = to;
  }
  return failure;
}

/** Re-reads git side and worktree for `sub`, then restores/unlinks it right away; returns the first row that failed. */
async function actOnSubBatch(
  workdir: string,
  sub: readonly BulkGuardRow[],
  firstShared: SharedSides,
  verify: VerifyFn,
  st: ChunkState,
): Promise<{ index: number; error: unknown } | null> {
  let sides: SharedSides;
  try {
    sides = await readSharedGitSides(workdir, sub.map((r) => ({ path: r.path, kind: r.kind })));
  } catch (error) {
    return { index: 0, error };
  }
  // HEAD/index moved since the first read: the verified fingerprints no longer describe what git would act on, so nothing in this sub-batch is touched.
  for (let k = 0; k < sub.length; k++) {
    const a = firstShared.get(sub[k]!.path)!;
    const b = sides.get(sub[k]!.path)!;
    if (a.gitSide !== b.gitSide || a.untrackedListed !== b.untrackedListed) return { index: k, error: new StaleDiffError(sub[k]!.path) };
  }
  let live = [...sub];
  let failure: { index: number; error: unknown } | null = null;
  const second: Observed[] = [];
  for (let k = 0; k < sub.length; k++) {
    const r = sub[k]!;
    try {
      second.push(await verify(r, sides));
    } catch (error) {
      failure = { index: k, error };
      live = live.slice(0, k);
      break;
    }
  }

  const tracked = live.filter((r) => r.kind === "tracked");
  if (tracked.length > 0) {
    try {
      for (const batch of batchArgs(tracked.map((r) => r.path), 60)) {
        await runGit(withFsmonitorNeutralized(["--literal-pathspecs", "restore", "--", ...batch]), { cwd: workdir });
      }
      for (const r of tracked) st.done.add(r.path);
    } catch (error) {
      // git restore may have finished some files before failing: report what really changed on disk.
      for (const r of tracked) {
        const before = second[live.indexOf(r)]!.worktreeFingerprint;
        const now = await observeWorktree(workdir, r.path, false).then((o) => o.fingerprint, () => before);
        if (now !== before) st.done.add(r.path);
      }
      const first = live.findIndex((r) => r.kind === "tracked" && !st.done.has(r.path));
      // first === -1: every tracked file really changed despite git's error, so the untracked rows below still proceed.
      if (first !== -1) return { index: first, error };
    }
  }
  for (let k = 0; k < live.length; k++) {
    const r = live[k]!;
    if (r.kind !== "untracked") continue;
    try {
      if (second[k]!.state === "absent") {
        st.done.add(r.path); // vanished already: the end state the user asked for
      } else if (!sides.get(r.path)!.untrackedListed) {
        st.skipped.add(r.path); // became tracked/ignored: left alone, not a discard
      } else {
        await unlinkFile(workdir, r.path);
        st.done.add(r.path);
      }
    } catch (error) {
      return { index: k, error };
    }
  }
  return failure;
}
