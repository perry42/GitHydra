// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runGit, withReadOnlyIndex } from "./gitProcess";
import { EditFileAccessError, EditWriteError, GitCommandError, InvalidArgumentError, SymlinkEscapesWorkdirError } from "./errors";
import { isErrnoException, resolveRealPathWithinWorkdir, resolveWithinWorkdir } from "./pathSafety";
import { parsePorcelainV2Changes } from "./workingDirStatus";
import { readConflictSides } from "./conflicts";

/**
 * specs/edit-in-diff.md FR-468/FR-469/FR-471/FR-474/FR-528: read and save the WORKING copy of one text file.
 * Never touches the index, never runs a hook, never converts encoding/line endings/BOM. Main-process only.
 */

export const MAX_EDITABLE_FILE_BYTES = 1024 * 1024;

export type EditIneligibleReason =
  | "outside-repo"
  | "git-internal"
  | "symlink"
  | "submodule"
  | "conflicted"
  | "deleted"
  | "directory"
  | "special-file"
  | "too-large"
  | "binary"
  | "not-utf8";

const REASON_MESSAGES: Record<EditIneligibleReason, string> = {
  "outside-repo": "This path is not inside the repository",
  "git-internal": "Files inside .git cannot be edited here",
  symlink: "Symbolic links cannot be edited here",
  submodule: "Submodules cannot be edited here",
  conflicted: "Conflicted file: use the conflict resolution view",
  deleted: "The file does not exist in the working tree",
  directory: "This path is a directory",
  "special-file": "Not a regular file",
  "too-large": "File too large to edit here",
  binary: "Binary file",
  "not-utf8": "Not UTF-8, edit externally",
};

export interface EditIneligible {
  eligible: false;
  reason: EditIneligibleReason;
  message: string;
}
export interface EditProbeEligible {
  eligible: true;
  /** Index differs from HEAD for this path (FR-528 note). False for intent-to-add. */
  hasStagedContent: boolean;
  /** No HEAD entry for this path (untracked, staged-added or intent-to-add). */
  isNew: boolean;
  isUntracked: boolean;
  /** specs/edit-in-diff.md FR-556: an unmerged text conflict opened in the block editor; false for every ordinary file. */
  conflicted: boolean;
  size: number;
  mtimeMs: number;
  mode: number;
}
export type EditProbeResult = EditProbeEligible | EditIneligible;

export type LineEnding = "lf" | "crlf" | "mixed";
export interface EditableFileContent extends EditProbeEligible {
  /** Verbatim decoded text with the BOM removed; line endings untouched. */
  content: string;
  eol: LineEnding;
  hasBom: boolean;
  finalNewline: boolean;
  /** sha256 hex of the raw on-disk bytes (BOM included). */
  contentHash: string;
}
export type EditReadResult = EditableFileContent | EditIneligible;

export interface WriteEditedFileOptions {
  /** `contentHash` from the last read/write (FR-474). Required. */
  expectedHash: string;
  /** "lf"/"crlf": every line break in `content` is normalised to it; "mixed": `content` is written verbatim. */
  eol: LineEnding;
  hasBom: boolean;
  /** true: ensure a trailing line break; false: drop one trailing line break if present. */
  finalNewline: boolean;
  /** Caller already got `changed-on-disk` and the user confirmed the overwrite. */
  force?: boolean;
}
export type WriteEditedFileResult =
  | { status: "written"; contentHash: string; mtimeMs: number; size: number }
  | { status: "changed-on-disk"; currentHash: string }
  | { status: "ineligible"; reason: EditIneligibleReason; message: string };

// Lazy: a top-level Buffer use would break the sandboxed renderer's module load (CLAUDE.md pitfall).
const bom = (): Buffer => Buffer.from([0xef, 0xbb, 0xbf]);
const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
// Lazy: Vite stubs node:fs in the sandboxed renderer and throws on property reads at module load (CLAUDE.md pitfall).
// O_NOFOLLOW is undefined on Windows; the lstat/realpath checks carry the symlink defence there.
const noFollow = (): number => (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const no = (reason: EditIneligibleReason): EditIneligible => ({ eligible: false, reason, message: REASON_MESSAGES[reason] });

interface IndexInfo {
  gitlink: boolean;
  conflicted: boolean;
  inIndex: boolean;
  /** Unmerged stages present, with their modes. */
  stages: Map<number, string>;
}

async function readIndexInfo(workdir: string, rel: string): Promise<IndexInfo> {
  const { stdout } = await runGit(withReadOnlyIndex(["ls-files", "-s", "-z", "--", rel]), { cwd: workdir });
  const want = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  const info: IndexInfo = { gitlink: false, conflicted: false, inIndex: false, stages: new Map() };
  for (const rec of stdout.split("\0")) {
    const tab = rec.indexOf("\t");
    if (tab < 0 || rec.slice(tab + 1) !== want) continue;
    const [mode, , stage] = rec.slice(0, tab).split(" ");
    info.inIndex = true;
    if (stage !== "0") info.stages.set(Number(stage), mode!);
    if (mode === "160000") info.gitlink = true;
    if (stage !== "0") info.conflicted = true;
  }
  return info;
}

/** FR-556: both-modified / both-added, regular files, stages 2 and 3 UTF-8 text under the cap. Everything else keeps the file-level flow. */
async function isEditableTextConflict(workdir: string, rel: string, idx: IndexInfo): Promise<boolean> {
  const regular = (m: string | undefined) => m === "100644" || m === "100755";
  if (!regular(idx.stages.get(2)) || !regular(idx.stages.get(3))) return false;
  const sides = await readConflictSides(workdir, rel);
  return sides !== null && sides.ours.status === "ok" && sides.theirs.status === "ok";
}

async function readGitState(workdir: string, rel: string) {
  let idx: IndexInfo;
  let status: { stdout: string };
  try {
    [idx, status] = await Promise.all([
      readIndexInfo(workdir, rel),
      runGit(withReadOnlyIndex(["status", "--porcelain=v2", "-z", "--untracked-files=all", "--", rel]), { cwd: workdir }),
    ]);
  } catch (err) {
    // git's stderr can hold absolute paths; never forward it.
    if (err instanceof GitCommandError) {
      if (/is in submodule/i.test(err.stderr)) return { submodule: true as const };
      throw new EditFileAccessError(rel, "GIT");
    }
    throw err;
  }
  const ch = parsePorcelainV2Changes(status.stdout);
  const staged = ch.staged.find((c) => c.path === rel.replace(/\\/g, "/"));
  const unstagedAdded = ch.unstaged.some((c) => c.status === "added");
  const untracked = ch.untracked.length > 0 || !idx.inIndex;
  const isNew = untracked || unstagedAdded || (staged !== undefined && (staged.status === "added" || staged.status === "renamed" || staged.status === "copied"));
  return { submodule: false as const, idx, hasStagedContent: staged !== undefined, isNew, isUntracked: untracked, conflicted: idx.conflicted || ch.conflicted.length > 0 };
}

function hasGitSegment(rel: string): boolean {
  return rel.split(/[\\/]+/).some((s) => {
    const l = s.split(":")[0]!.toLowerCase().replace(/[ .]+$/, "");
    return l === ".git" || l === "git~1";
  });
}

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Windows-only name tricks that bypass textual containment: alternate data streams (`x.txt:s`, `.git::$INDEX_ALLOCATION`)
 * and reserved device names (`NUL.txt`). String-level so tests can run it on any OS via `platform`.
 */
export function invalidPathReason(rel: string, platform: string = process.platform): EditIneligibleReason | null {
  if (hasGitSegment(rel)) return "git-internal";
  if (platform !== "win32") return null;
  for (const seg of rel.split(/[\\/]+/)) {
    if (seg.includes(":")) return "outside-repo";
    const trimmed = seg.replace(/[ .]+$/, "");
    if (WIN_RESERVED.test(trimmed.split(".")[0]!.trimEnd())) return "outside-repo";
  }
  return null;
}

/** Re-runnable parent-chain check (M2): no symlinked directory component, and the realpath stays inside the workdir. */
async function parentProblem(workdir: string, rel: string, abs: string): Promise<EditIneligibleReason | null> {
  const relParts = path.relative(path.resolve(workdir), abs).split(path.sep);
  let cur = path.resolve(workdir);
  for (const part of relParts.slice(0, -1)) {
    cur = path.join(cur, part);
    const l = await fs.lstat(cur).catch(() => null);
    if (l?.isSymbolicLink()) return "symlink";
  }
  try {
    await resolveRealPathWithinWorkdir(workdir, rel);
  } catch (err) {
    if (err instanceof SymlinkEscapesWorkdirError) return "symlink";
    throw err;
  }
  return null;
}

/** Identity of the exact file we hashed, taken from the open handle (bigint so Windows file ids do not lose precision). */
interface FileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  mode: number;
}
const identityOf = (st: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; mode: bigint }): FileIdentity => ({ dev: st.dev, ino: st.ino, size: st.size, mtimeNs: st.mtimeNs, mode: Number(st.mode) });
const sameIdentity = (a: FileIdentity, b: FileIdentity): boolean => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;
const msOf = (st: { mtimeNs: bigint }): number => Number(st.mtimeNs) / 1e6;

type Loaded = { ok: true; bytes: Buffer; probe: EditProbeEligible; identity: FileIdentity } | { ok: false; result: EditIneligible };

/** Shared by probe, read and the write-time re-check (FR-468 race: file may have changed type since open). */
async function load(workdir: string, rel: string): Promise<Loaded> {
  const fail = (r: EditIneligibleReason): Loaded => ({ ok: false, result: no(r) });
  let abs: string;
  try {
    abs = resolveWithinWorkdir(workdir, rel);
  } catch (err) {
    if (err instanceof InvalidArgumentError) return fail("outside-repo");
    throw err;
  }
  if (abs === path.resolve(workdir)) return fail("directory");
  const bad = invalidPathReason(rel);
  if (bad) return fail(bad);

  const pp = await parentProblem(workdir, rel, abs);
  if (pp) return fail(pp);

  // A directory holding its own `.git` is a submodule or nested repo: its files belong to another repository.
  let anc = path.resolve(workdir);
  for (const part of path.relative(anc, abs).split(path.sep).slice(0, -1)) {
    anc = path.join(anc, part);
    if (await fs.lstat(path.join(anc, ".git")).then(() => true, () => false)) return fail("submodule");
  }

  const git = await readGitState(workdir, rel);
  if (git.submodule || git.idx.gitlink) return fail("submodule");
  if (git.conflicted && !(await isEditableTextConflict(workdir, rel, git.idx))) return fail("conflicted");

  try {
    const lst = await fs.lstat(abs, { bigint: true }).catch((e: unknown) => {
      if (isErrnoException(e) && (e.code === "ENOENT" || e.code === "ENOTDIR")) return null;
      throw e;
    });
    if (!lst) return fail("deleted");
    if (lst.isSymbolicLink()) return fail("symlink");
    if (lst.isDirectory()) return fail("directory");
    if (!lst.isFile()) return fail("special-file");
    if (lst.size > BigInt(MAX_EDITABLE_FILE_BYTES)) return fail("too-large");

    // Open without following links, then verify the handle is a regular file (no FIFO hang, no swap).
    const fh = await fs.open(abs, fsConstants.O_RDONLY | noFollow() | (fsConstants.O_NONBLOCK ?? 0));
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const st = await fh.stat({ bigint: true });
        if (!st.isFile()) return fail("special-file");
        if (st.size > BigInt(MAX_EDITABLE_FILE_BYTES)) return fail("too-large");
        const bytes = Buffer.alloc(Number(st.size));
        let off = 0;
        while (off < bytes.length) {
          const { bytesRead } = await fh.read(bytes, off, bytes.length - off, off);
          if (bytesRead === 0) break;
          off += bytesRead;
        }
        const st2 = await fh.stat({ bigint: true });
        // Modified while we read it: the bytes and identity would not describe one version.
        if (off !== bytes.length || !sameIdentity(identityOf(st), identityOf(st2))) continue;
        if (bytes.includes(0)) return fail("binary");
        try {
          UTF8_STRICT.decode(bytes);
        } catch {
          return fail("not-utf8");
        }
        return {
          ok: true,
          bytes,
          identity: identityOf(st2),
          probe: { eligible: true, hasStagedContent: git.hasStagedContent, isNew: git.isNew, isUntracked: git.isUntracked, conflicted: git.conflicted, size: bytes.length, mtimeMs: msOf(st2), mode: Number(st2.mode) & 0o777 },
        };
      }
      throw new EditFileAccessError(rel, "EBUSY");
    } finally {
      await fh.close();
    }
  } catch (err) {
    if (err instanceof EditFileAccessError) throw err;
    if (isErrnoException(err)) {
      if (err.code === "ELOOP") return fail("symlink"); // O_NOFOLLOW hit a link swapped in after lstat
      if (err.code === "EISDIR") return fail("directory");
      if (err.code === "ENOENT") return fail("deleted");
      throw new EditFileAccessError(rel, err.code ?? "UNKNOWN");
    }
    throw err;
  }
}

export async function probeEditableFile(workdir: string, rel: string): Promise<EditProbeResult> {
  const l = await load(workdir, rel);
  return l.ok ? l.probe : l.result;
}

function classifyEol(text: string): LineEnding {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) {
        crlf++;
        i++;
      } else cr++;
    } else if (c === 10) lf++;
  }
  if (cr > 0 || (crlf > 0 && lf > 0)) return "mixed";
  return crlf > 0 ? "crlf" : "lf";
}

export async function readEditableFile(workdir: string, rel: string): Promise<EditReadResult> {
  const l = await load(workdir, rel);
  if (!l.ok) return l.result;
  const hasBom = l.bytes.length >= 3 && l.bytes.subarray(0, 3).equals(bom());
  const content = UTF8_STRICT.decode(hasBom ? l.bytes.subarray(3) : l.bytes);
  return {
    ...l.probe,
    content,
    eol: classifyEol(content),
    hasBom,
    finalNewline: content.endsWith("\n") || content.endsWith("\r"),
    contentHash: sha256(l.bytes),
  };
}

function encode(content: string, o: WriteEditedFileOptions): Buffer {
  let text = content;
  const nl = o.eol === "crlf" ? "\r\n" : "\n";
  if (o.eol !== "mixed") text = text.replace(/\r\n|\r|\n/g, nl);
  if (o.finalNewline) {
    if (text !== "" && !/[\r\n]$/.test(text)) text += nl;
  } else {
    text = text.replace(/(\r\n|\r|\n)$/, "");
  }
  const body = Buffer.from(text, "utf8");
  return o.hasBom ? Buffer.concat([bom(), body]) : body;
}

// Serialises saves per file inside this process so the hash check and the rename cannot interleave.
const pathLocks = new Map<string, Promise<unknown>>();
function withPathLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = pathLocks.get(key) ?? Promise.resolve();
  const run = prev.then(task, task);
  const tail = run.catch(() => undefined);
  pathLocks.set(key, tail);
  void tail.then(() => {
    if (pathLocks.get(key) === tail) pathLocks.delete(key);
  });
  return run;
}

/** Windows maps the read-only attribute to the missing write bits, so one mode check covers both platforms. */
function isReadOnlyMode(mode: number): boolean {
  return (mode & 0o222) === 0;
}

function ioError(rel: string, err: unknown): EditWriteError {
  const code = isErrnoException(err) ? err.code : "unknown";
  return new EditWriteError(rel, "io", `the file system reported ${code}`);
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const transient = isErrnoException(err) && (err.code === "EPERM" || err.code === "EBUSY" || err.code === "EACCES");
      if (!transient || attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 40 * (attempt + 1)));
    }
  }
}

/**
 * FR-471/FR-474. `options.eol` MUST be `"mixed"` for a file that `readEditableFile` reported as `"mixed"`, or its
 * line endings get normalised. Throws `EditWriteError` (read-only, content rejected, I/O), `EditFileAccessError` (unreadable file) and `InvalidArgumentError` (bad options);
 * everything the caller should branch on is a typed result. Content containing NUL is refused: the file would become
 * binary and could no longer be reopened here.
 */
export async function writeEditedFile(workdir: string, rel: string, content: string, options: WriteEditedFileOptions): Promise<WriteEditedFileResult> {
  if (typeof content !== "string") throw new InvalidArgumentError("Content must be a string.");
  if (typeof options?.expectedHash !== "string" || options.expectedHash === "") throw new InvalidArgumentError("A save needs the content hash read when the file was opened.");
  if (options.eol !== "lf" && options.eol !== "crlf" && options.eol !== "mixed") throw new InvalidArgumentError("Unknown line-ending mode.");
  const abs = resolveWithinWorkdir(workdir, rel);
  if (content.includes("\0")) throw new EditWriteError(rel, "contains-nul", "the text contains a NUL character, which would make the file binary");
  if (LONE_SURROGATE.test(content)) throw new EditWriteError(rel, "invalid-content", "the text is not valid Unicode");
  const out = encode(content, options);
  if (out.length > MAX_EDITABLE_FILE_BYTES) throw new EditWriteError(rel, "content-too-large", "the text is over the 1 MB editing limit");

  return withPathLock(abs, async (): Promise<WriteEditedFileResult> => {
    let tmp: string | null = null;
    try {
      const cur = await load(workdir, rel);
      if (!cur.ok) return { status: "ineligible", reason: cur.result.reason, message: cur.result.message };
      const curHash = sha256(cur.bytes);
      if (curHash !== options.expectedHash && !options.force) return { status: "changed-on-disk", currentHash: curHash };

      // Identity and mode come from the very handle that was hashed. Checked before any write: rename would
      // otherwise replace a read-only file without complaint on POSIX.
      const before = cur.identity;
      if (isReadOnlyMode(before.mode)) throw new EditWriteError(rel, "read-only", "the file is read-only");
      await fs.access(abs, fsConstants.W_OK).catch(() => {
        throw new EditWriteError(rel, "read-only", "you do not have write permission for this file");
      });

      // M2: a hostile concurrent local process swapping a parent directory is out of scope; these re-checks only
      // narrow the window for accidental races (a directory replaced by a link between validation and write).
      const parentReal = await fs.realpath(path.dirname(abs));
      const recheck = async (): Promise<WriteEditedFileResult | null> => {
        const pp = await parentProblem(workdir, rel, abs);
        if (pp) return { status: "ineligible", reason: pp, message: REASON_MESSAGES[pp] };
        if ((await fs.realpath(path.dirname(abs))) !== parentReal) return { status: "ineligible", reason: "symlink", message: REASON_MESSAGES.symlink };
        return null;
      };
      const pre = await recheck();
      if (pre) return pre;

      const mode = before.mode & 0o777; // never carry setuid/setgid/sticky onto the rewritten file
      const candidate = path.join(path.dirname(abs), `.githydra-edit-${randomBytes(8).toString("hex")}.tmp`);
      const fh = await fs.open(candidate, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, mode);
      tmp = candidate;
      try {
        await fh.writeFile(out);
        // chmod after create: the process umask would otherwise strip bits from the original mode.
        if (process.platform !== "win32") await fh.chmod(mode);
        await fh.sync().catch(() => undefined);
      } finally {
        await fh.close();
      }
      if ((await fs.realpath(path.dirname(candidate))) !== parentReal) return { status: "ineligible", reason: "symlink", message: REASON_MESSAGES.symlink };

      // Last guard before the swap: still the file we hashed (narrows the check-to-rename window).
      const post = await recheck();
      if (post) return post;
      const after = await fs.lstat(abs, { bigint: true }).catch(() => null);
      if (!after || !after.isFile() || !sameIdentity(before, identityOf(after))) {
        const again = await load(workdir, rel);
        if (!again.ok) return { status: "ineligible", reason: again.result.reason, message: again.result.message };
        return { status: "changed-on-disk", currentHash: sha256(again.bytes) };
      }
      await renameWithRetry(candidate, abs);
      tmp = null;
      const st = await fs.stat(abs, { bigint: true });
      return { status: "written", contentHash: sha256(out), mtimeMs: msOf(st), size: Number(st.size) };
    } catch (err) {
      if (err instanceof EditWriteError || err instanceof EditFileAccessError) throw err;
      throw ioError(rel, err);
    } finally {
      if (tmp) await fs.rm(tmp, { force: true }).catch(() => undefined);
    }
  });
}
