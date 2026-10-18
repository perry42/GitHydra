// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { GitCommandError, NotAGitRepositoryError } from "./errors";
import { pathExists } from "./gitProcess";
import {
  WORKTREE_LIST_Z_MIN_VERSION,
  WORKTREE_PORCELAIN_PRUNABLE_MIN_VERSION,
  gitVersionAtLeast,
} from "./gitVersion";
import {
  analyzeGitdirFile,
  parseStrictPorcelainBlocks,
  parseWorktreeListPorcelain,
  shortSha,
  splitPorcelainNewline,
  splitPorcelainNul,
  visibleUntrustedText,
  type GitdirAnalysis,
  type PorcelainBlock,
} from "./worktreeParse";
import { classifyPathString, relatePaths } from "./worktreeParse";
import { getWorktreeGitVersion, toWorktreeError, wrapGit, wtRun, wtRunAllowing } from "./worktreeRunner";

/** specs/worktrees.md FR-601. */
export interface WorktreeEntry {
  /** The admin-dir name under `<common-dir>/worktrees`; null for the main worktree. */
  id: string | null;
  /** Native-separator path for supported entries; control characters replaced for unsupported ones. */
  path: string;
  /** Short branch name, or null when detached/bare. */
  branch: string | null;
  detached: boolean;
  /** Full HEAD id; null for a bare entry or an unborn branch. */
  head: string | null;
  shortHead: string | null;
  isMain: boolean;
  isBare: boolean;
  locked: boolean;
  lockReason: string | null;
  prunable: boolean;
  prunableReason: string | null;
  /** False: listed for transparency, never openable or removable (path cannot be represented or trusted). */
  supported: boolean;
}

export type WorktreeUntrustedReason = "malformed-output" | "count-mismatch" | "path-mismatch" | "ambiguous-duplicate-path" | "network-path" | "special-file";

export interface WorktreeList {
  entries: WorktreeEntry[];
  /** True when git's output and the admin directories disagree: Open and Remove must be disabled for every linked entry. */
  untrusted: boolean;
  untrustedReason: WorktreeUntrustedReason | null;
  /** Absolute path of the shared git dir. */
  commonDir: string;
  /** The main worktree (or the bare repo folder) as git prints it, native separators. */
  mainPath: string;
  /** Which `git worktree list` format was parsed. */
  format: "nul" | "newline";
  /**
   * True when git printed the git dir as the main worktree (`--separate-git-dir` repos) and the real working tree could
   * not be found; `mainPath` is then the git dir, which is still a valid cwd for git.
   */
  mainPathIsGitDir: boolean;
}

export interface AdminRecord {
  id: string;
  analysis: GitdirAnalysis;
  /** gitdir file longer than the read cap: treated as unsupported. */
  truncated: boolean;
}

const GITDIR_READ_CAP = 8192;
const LOCK_FILE_READ_CAP = 1024;

/**
 * Capped read of a repo-controlled admin file. `lstat` first and only a regular file is read (a symlink, FIFO or directory
 * planted as `gitdir`/`locked` is skipped); on POSIX the open also refuses a link swapped in after the check and never
 * blocks on a FIFO (O_NOFOLLOW | O_NONBLOCK).
 */
export async function readCapped(file: string, cap: number): Promise<{ text: string; truncated: boolean } | null> {
  let handle: fs.FileHandle;
  try {
    const st = await fs.lstat(file);
    if (!st.isFile()) return null;
    const flags = process.platform === "win32" ? "r" : fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
    handle = await fs.open(file, flags);
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(cap + 1);
    const { bytesRead } = await handle.read(buf, 0, cap + 1, 0);
    return { text: new TextDecoder().decode(buf.subarray(0, Math.min(bytesRead, cap))), truncated: bytesRead > cap };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * `git worktree list` opens each admin file with a plain blocking read, so a FIFO (or device/socket, or a link to one)
 * planted as `gitdir`/`locked`/`HEAD`/`commondir` hangs it forever. Such a repo is listed from the admin dirs alone.
 */
async function hasBlockingAdminFile(commonDir: string): Promise<boolean> {
  // lstat, never stat: following a link planted at one of these names would contact its target (UNC share, FIFO) first.
  const root = path.join(commonDir, "worktrees");
  let ids: string[];
  try {
    ids = await fs.readdir(root);
  } catch {
    return false;
  }
  for (const id of ids) {
    for (const name of ["gitdir", "locked", "HEAD", "commondir"]) {
      try {
        const st = await fs.lstat(path.join(root, id, name));
        if (st.isSymbolicLink() || st.isFIFO() || st.isSocket() || st.isCharacterDevice() || st.isBlockDevice()) return true;
      } catch {
        // missing or dangling: git copes with those
      }
    }
  }
  return false;
}

/** Git skips an admin dir whose `gitdir` is missing, unreadable or empty, so do we (same set, same count). */
export async function readAdminRecords(commonDir: string): Promise<AdminRecord[]> {
  const root = path.join(commonDir, "worktrees");
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch {
    return [];
  }
  const records: AdminRecord[] = [];
  for (const id of names.sort()) {
    const file = await readCapped(path.join(root, id, "gitdir"), GITDIR_READ_CAP);
    if (!file || (file.text === "" && !file.truncated)) continue;
    const analysis = analyzeGitdirFile(file.text);
    // A lossy UTF-8 decode (U+FFFD) means the real bytes are not representable: listed, never openable.
    const lossy = file.text.includes("�") || id.includes("�");
    const badId = /[\u0000-\u001f\u007f]/.test(id); // eslint-disable-line no-control-regex
    records.push({
      id,
      truncated: file.truncated,
      analysis: file.truncated || badId || lossy ? { ...analysis, supported: false } : analysis,
    });
  }
  return records;
}

export async function resolveCommonDir(repoPath: string): Promise<string> {
  if (!pathExists(repoPath)) throw new NotAGitRepositoryError(repoPath);
  try {
    const { stdout } = await wtRun(["rev-parse", "--git-common-dir"], repoPath);
    return path.resolve(repoPath, stdout.trim());
  } catch (err) {
    if (err instanceof GitCommandError && !/dubious ownership|safe\.directory/i.test(err.stderr)) throw new NotAGitRepositoryError(repoPath);
    throw toWorktreeError("list", err);
  }
}

interface PorcelainRead {
  blocks: PorcelainBlock[] | null;
  format: "nul" | "newline";
  rawFirstLine: string;
}

async function readPorcelain(repoPath: string, useNul: boolean): Promise<PorcelainRead> {
  if (useNul) {
    try {
      const { stdout } = await wtRun(["worktree", "list", "--porcelain", "-z"], repoPath);
      const split = splitPorcelainNul(stdout);
      return { blocks: split ? parseStrictPorcelainBlocks(split) : null, format: "nul", rawFirstLine: stdout.split("\0")[0] ?? "" };
    } catch (err) {
      // A wrong version guess must not break listing: an unknown switch means the git is older than we thought.
      if (!(err instanceof GitCommandError && /unknown (switch|option)/i.test(err.stderr))) throw toWorktreeError("list", err);
    }
  }
  try {
    const { stdout } = await wtRun(["worktree", "list", "--porcelain"], repoPath);
    const split = splitPorcelainNewline(stdout);
    return { blocks: split ? parseStrictPorcelainBlocks(split) : null, format: "newline", rawFirstLine: stdout.split("\n")[0] ?? "" };
  } catch (err) {
    throw toWorktreeError("list", err);
  }
}

function branchShortName(full: string | null): string | null {
  if (full === null) return null;
  return full.startsWith("refs/heads/") ? full.slice("refs/heads/".length) : full;
}

const nativePath = (p: string): string => path.normalize(p);

function entryFromBlock(id: string | null, block: PorcelainBlock, pathText: string, supported: boolean): WorktreeEntry {
  return {
    id,
    path: pathText,
    branch: branchShortName(block.branchFullName),
    detached: block.detached,
    head: block.head,
    shortHead: shortSha(block.head),
    isMain: id === null,
    isBare: block.bare,
    locked: block.locked,
    lockReason: block.lockReason,
    prunable: block.prunable,
    prunableReason: block.prunableReason,
    supported,
  };
}

async function assemble(
  commonDir: string,
  admin: readonly AdminRecord[],
  read: PorcelainRead,
  oldGitPrunable: boolean,
): Promise<WorktreeList> {
  let untrustedReason: WorktreeUntrustedReason | null = null;
  let blocks = read.blocks;
  if (!blocks || blocks.length === 0) {
    untrustedReason = "malformed-output";
    // The first line is always the main worktree and is printed before any admin-controlled text.
    const first = parseWorktreeListPorcelain(read.rawFirstLine.startsWith("worktree ") ? `${read.rawFirstLine}\n` : "")[0];
    blocks = [
      {
        path: first?.path ?? path.dirname(commonDir),
        head: null,
        branchFullName: first?.branchFullName ?? null,
        detached: false,
        bare: first?.isBare ?? false,
        locked: false,
        lockReason: null,
        prunable: false,
        prunableReason: null,
      },
    ];
  }

  const main = blocks[0]!;
  const linked = blocks.slice(1);
  const used = new Set<number>();
  const expectedPaths = admin.map((a) => a.analysis.gitPrintsPath);
  if (untrustedReason === null && linked.length !== admin.length) untrustedReason = "count-mismatch";
  if (untrustedReason === null && new Set(expectedPaths).size !== expectedPaths.length) untrustedReason = "ambiguous-duplicate-path";

  const entries: WorktreeEntry[] = [entryFromBlock(null, main, nativePath(main.path), !main.path.includes("�"))];
  for (let i = 0; i < admin.length; i++) {
    const rec = admin[i]!;
    const idx = untrustedReason === "malformed-output" ? -1 : linked.findIndex((b, j) => !used.has(j) && (b.path === expectedPaths[i] || (rec.analysis.suffixMissing && b.path === main.path)));
    if (idx >= 0) used.add(idx);
    else if (untrustedReason === null) untrustedReason = "path-mismatch";
    const block: PorcelainBlock =
      idx >= 0
        ? linked[idx]!
        : { path: "", head: null, branchFullName: null, detached: false, bare: false, locked: false, lockReason: null, prunable: false, prunableReason: null };
    const adminDir = path.join(commonDir, "worktrees", rec.id);
    const display = rec.analysis.supported
      ? nativePath(rec.analysis.worktreePath)
      : visibleUntrustedText(rec.analysis.hasInteriorBreak || rec.truncated ? adminDir : rec.analysis.gitPrintsPath);
    const entry = entryFromBlock(rec.id, block, display, rec.analysis.supported);
    // The file is the faithful source: the newline porcelain C-quotes a reason with special characters.
    if (entry.locked) {
      const file = await readCapped(path.join(commonDir, "worktrees", rec.id, "locked"), LOCK_FILE_READ_CAP);
      const text = file?.text.replace(/\r?\n$/, "") ?? "";
      if (text !== "") entry.lockReason = visibleUntrustedText(text);
    }
    if (oldGitPrunable && entry.supported && !entry.locked && classifyPathString(entry.path) === null) {
      // Git before 2.31 prints no prunable line; the admin dir is the read-only source (specs/worktrees.md FR-601).
      const present = await fs.lstat(path.join(entry.path, ".git")).then(() => true, () => false);
      if (!present) {
        entry.prunable = true;
        entry.prunableReason = "gitdir file points to non-existent location";
      }
    }
    entries.push(entry);
  }
  if (untrustedReason === null && used.size !== linked.length) untrustedReason = "count-mismatch";

  return {
    entries,
    untrusted: untrustedReason !== null,
    untrustedReason,
    commonDir,
    mainPath: nativePath(main.path),
    format: read.format,
    mainPathIsGitDir: false,
  };
}

/**
 * Git (verified on 2.31) lists the git dir itself as the main worktree for a `--separate-git-dir` repo. The real working
 * tree is only discoverable when the opened path belongs to the main worktree (its git dir is the common dir).
 */
async function correctSeparateGitDirMain(repoPath: string, list: WorktreeList): Promise<void> {
  const main = list.entries[0]!;
  if (main.isBare || relatePaths(list.commonDir, main.path) !== "same") return;
  list.mainPathIsGitDir = true;
  try {
    const { stdout } = await wtRun(["rev-parse", "--git-dir", "--show-toplevel"], repoPath);
    const [gitDir, topLevel] = stdout.split(/\r?\n/);
    if (gitDir && topLevel && relatePaths(list.commonDir, path.resolve(repoPath, gitDir)) === "same") {
      main.path = nativePath(topLevel);
      list.mainPath = main.path;
      list.mainPathIsGitDir = false;
    }
  } catch {
    // Not inside a working tree (opened at the git dir): keep git's answer.
  }
}

/**
 * FR-601: typed worktree entries. Linked entries come from `<common-dir>/worktrees/*` + `gitdir`; git's own porcelain
 * is only the cross-check, because a crafted `gitdir` with an interior newline can forge `worktree`/`HEAD` lines in the
 * newline format. Any disagreement marks the whole list `untrusted` (retried once to absorb a concurrent add/remove).
 */
export function listWorktrees(repoPath: string): Promise<WorktreeList> {
  return wrapGit("list", () => listWorktreesCore(repoPath));
}

async function listWorktreesCore(repoPath: string): Promise<WorktreeList> {
  const commonDir = await resolveCommonDir(repoPath);
  // Git itself stats every gitdir target during `worktree list`, so a planted network path would be probed (SMB/NTLM
  // leak). With any such record we never run it and fail closed from the admin dirs alone.
  const firstAdmin = await readAdminRecords(commonDir);
  if (firstAdmin.some(isNetworkRecord)) return listFromAdminOnly(repoPath, commonDir, firstAdmin);
  if (await hasBlockingAdminFile(commonDir)) return listFromAdminOnly(repoPath, commonDir, firstAdmin, "special-file");
  const version = await getWorktreeGitVersion(repoPath);
  const useNul = gitVersionAtLeast(version, WORKTREE_LIST_Z_MIN_VERSION);
  const oldGitPrunable = !gitVersionAtLeast(version, WORKTREE_PORCELAIN_PRUNABLE_MIN_VERSION);
  let result: WorktreeList | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const admin = attempt === 0 ? firstAdmin : await readAdminRecords(commonDir);
    if (admin.some(isNetworkRecord)) return listFromAdminOnly(repoPath, commonDir, admin);
    const read = await readPorcelain(repoPath, useNul);
    result = await assemble(commonDir, admin, read, oldGitPrunable);
    if (!result.untrusted) break;
  }
  await correctSeparateGitDirMain(repoPath, result!);
  return result!;
}

/**
 * Fail-closed listing used when any admin record names a network (UNC/device) path: `git worktree list` is NOT run, so git
 * never stats it. Entries come from the admin dirs (gitdir, HEAD, locked); the list is `untrusted`, which disables Open
 * and Remove for every linked entry, and the network entries are `supported: false`. Prunable state is unknown here.
 */
/**
 * UNC/device strings, plus on Windows ANY path that is not `X:\` or `X:/` (covers `\??\UNC\...`, a single leading
 * backslash and other NT forms). A mapped drive letter that points at a share cannot be told apart from a local one.
 */
export const isNetworkRecord = (r: AdminRecord): boolean =>
  classifyPathString(r.analysis.gitPrintsPath) === "unc" || (process.platform === "win32" && !/^[A-Za-z]:[\\/]/.test(r.analysis.gitPrintsPath));

async function listFromAdminOnly(
  repoPath: string,
  commonDir: string,
  admin: readonly AdminRecord[],
  untrustedReason: WorktreeUntrustedReason = "network-path",
): Promise<WorktreeList> {
  const isBare = path.basename(commonDir).toLowerCase() !== ".git";
  const mainPath = nativePath(isBare ? commonDir : path.dirname(commonDir));
  const gitDirArg = `--git-dir=${commonDir}`;
  const sym = await wtRunAllowing([gitDirArg, "symbolic-ref", "-q", "HEAD"], repoPath, [0, 1, 128]).catch(() => null);
  const headRef = sym && sym.exitCode === 0 ? sym.stdout.trim() : "";
  const head = await wtRunAllowing([gitDirArg, "rev-parse", "-q", "--verify", "HEAD"], repoPath, [0, 1, 128]).catch(() => null);
  const mainSha = head && head.exitCode === 0 && /^[0-9a-f]{40,64}$/.test(head.stdout.trim()) ? head.stdout.trim() : null;
  const main: WorktreeEntry = {
    id: null,
    path: mainPath,
    branch: branchShortName(headRef || null),
    detached: !headRef && mainSha !== null,
    head: isBare ? null : mainSha,
    shortHead: isBare ? null : shortSha(mainSha),
    isMain: true,
    isBare,
    locked: false,
    lockReason: null,
    prunable: false,
    prunableReason: null,
    supported: true,
  };
  const entries: WorktreeEntry[] = [main];
  for (const rec of admin) {
    const dir = path.join(commonDir, "worktrees", rec.id);
    const network = classifyPathString(rec.analysis.gitPrintsPath) === "unc";
    const headFile = await readCapped(path.join(dir, "HEAD"), 512);
    const headText = headFile?.text.trim() ?? "";
    const ref = /^ref: (.+)$/.exec(headText)?.[1] ?? null;
    const sha = /^[0-9a-f]{40,64}$/.test(headText) ? headText : null;
    const lockFile = await readCapped(path.join(dir, "locked"), LOCK_FILE_READ_CAP);
    const supported = rec.analysis.supported && !network;
    entries.push({
      id: rec.id,
      path: supported ? nativePath(rec.analysis.worktreePath) : visibleUntrustedText(dir),
      branch: branchShortName(ref),
      detached: ref === null && sha !== null,
      head: sha,
      shortHead: shortSha(sha),
      isMain: false,
      isBare: false,
      locked: lockFile !== null,
      lockReason: lockFile && lockFile.text.trim() !== "" ? visibleUntrustedText(lockFile.text.replace(/\r?\n$/, "")) : null,
      prunable: false,
      prunableReason: null,
      supported,
    });
  }
  return { entries, untrusted: true, untrustedReason, commonDir, mainPath, format: "newline", mainPathIsGitDir: false };
}
