// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runGit, runGitAllowingExitCodes, runGitWithInput, withReadOnlyIndex, withFsmonitorNeutralized } from "./gitProcess";
import { DiscardBackupError, DiscardFingerprintError, GitCommandError, InvalidArgumentError, StaleDiffError } from "./errors";
import { assertPathWithinWorkdir, isErrnoException } from "./pathSafety";

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
  /** From `getDiscardFingerprint`; a mismatch inside the queue slot throws `StaleDiffError` and changes nothing. */
  expectedFingerprint?: string;
  /** Called after the safety copy is written (or deliberately skipped), before the destructive command runs. */
  onBackup?: (info: DiscardBackupInfo) => void;
}

interface Observed {
  fingerprint: string;
  /** Present only for a regular file small enough to back up. */
  bytes: Buffer | null;
  state: "regular" | "absent" | "other" | "directory";
  tooLarge: boolean;
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
async function observeWorktree(workdir: string, filePath: string, keepBytes: boolean): Promise<Observed> {
  const abs = path.resolve(workdir, filePath);
  if ((await assertNoSymlinkedComponent(workdir, abs, filePath)) === "absent") {
    return { fingerprint: sha256("absent"), bytes: null, state: "absent", tooLarge: false };
  }
  let st;
  try {
    st = await fs.lstat(abs);
  } catch (err) {
    if (isErrnoException(err) && (err.code === "ENOENT" || err.code === "ENOTDIR")) {
      return { fingerprint: sha256("absent"), bytes: null, state: "absent", tooLarge: false };
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
    return { fingerprint: sha256("symlink", target), bytes: null, state: "other", tooLarge: false };
  }
  if (!st.isFile()) {
    return { fingerprint: sha256(st.isDirectory() ? "dir" : "other"), bytes: null, state: st.isDirectory() ? "directory" : "other", tooLarge: false };
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
      };
    }
    const hash = createHash("sha256");
    const chunks: Buffer[] = [];
    const keep = keepBytes && hst.size <= DISCARD_BACKUP_CAP_BYTES;
    let total = 0;
    const buf = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(hst.size, 1)));
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
    };
  } finally {
    await fh.close();
  }
}

/** Raw `ls-files --stage` (mode, oid, stage of every entry) and `ls-tree HEAD` for the path; 'none' when absent / unborn HEAD. */
async function readGitSide(workdir: string, filePath: string, kind: DiscardKind): Promise<string> {
  const stage = await runGit(withReadOnlyIndex(["ls-files", "--stage", "-z", "--", filePath]), { cwd: workdir });
  if (kind === "untracked") return sha256("untracked", stage.stdout === "" ? "none" : stage.stdout);
  let head: string;
  try {
    head = (await runGit(withReadOnlyIndex(["ls-tree", "-z", "HEAD", "--", filePath]), { cwd: workdir })).stdout;
  } catch (err) {
    if (!(err instanceof GitCommandError)) throw err;
    const probe = await runGitAllowingExitCodes(["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: workdir }, [0, 1]);
    if (probe.exitCode === 0) throw err;
    head = ""; // unborn HEAD
  }
  return sha256("tracked", head === "" ? "none" : head, stage.stdout === "" ? "none" : stage.stdout);
}

async function observe(workdir: string, filePath: string, kind: DiscardKind, keepBytes: boolean): Promise<Observed> {
  const gitSide = await readGitSide(workdir, filePath, kind);
  const wt = await observeWorktree(workdir, filePath, keepBytes);
  // Re-read the git side after the worktree read: if HEAD/index moved meanwhile the pair is inconsistent, so refuse.
  const gitSideAfter = await readGitSide(workdir, filePath, kind);
  if (gitSide !== gitSideAfter) throw new DiscardFingerprintError(filePath, "changed while being read");
  return { ...wt, fingerprint: sha256("githydra-discard-v1", kind, gitSide, wt.fingerprint) };
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

/**
 * Verify, back up, then run `args` as ONE mutation-queue entry (caller supplies the queue wrapper), so no other
 * queued mutation can slip between the check and the destructive command. Residual (accepted): an external
 * process writing in the microseconds between our read and git's own unlink/rewrite is not covered by either
 * the check or the copy; the earlier IPC-hop-sized window is what this closes.
 */
export async function guardedDestructive(
  workdir: string,
  filePath: string,
  kind: DiscardKind,
  args: readonly string[],
  options: DiscardOptions,
): Promise<void> {
  const obs = await observe(workdir, filePath, kind, true);
  // `git clean -f -- <dir>` removes the whole untracked directory (verified), and a directory cannot be backed up as one blob.
  if (obs.state === "directory") throw new InvalidArgumentError(`"${filePath}" is a directory; only single files can be discarded.`);
  if (options.expectedFingerprint !== undefined && obs.fingerprint !== options.expectedFingerprint) {
    throw new StaleDiffError(filePath);
  }
  const backup = await writeBackup(workdir, filePath, obs);
  options.onBackup?.(backup);
  // No `mutatesRepository`: the caller already holds the queue (a nested queued call would deadlock).
  await runGit(withFsmonitorNeutralized([...args]), { cwd: workdir });
}
