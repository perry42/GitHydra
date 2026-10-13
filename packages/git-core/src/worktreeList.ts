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
import { getWorktreeGitVersion, toWorktreeError, wtRun } from "./worktreeRunner";

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

export type WorktreeUntrustedReason = "malformed-output" | "count-mismatch" | "path-mismatch" | "ambiguous-duplicate-path";

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
}

interface AdminRecord {
  id: string;
  analysis: GitdirAnalysis;
  /** gitdir file longer than the read cap: treated as unsupported. */
  truncated: boolean;
}

const GITDIR_READ_CAP = 8192;
const LOCK_FILE_READ_CAP = 1024;

async function readCapped(file: string, cap: number): Promise<{ text: string; truncated: boolean } | null> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, "r");
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

/** Git skips an admin dir whose `gitdir` is missing, unreadable or empty, so do we (same set, same count). */
async function readAdminRecords(commonDir: string): Promise<AdminRecord[]> {
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
    const badId = /[\u0000-\u001f\u007f]/.test(id); // eslint-disable-line no-control-regex
    records.push({
      id,
      truncated: file.truncated,
      analysis: file.truncated || badId ? { ...analysis, supported: false } : analysis,
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

  const entries: WorktreeEntry[] = [entryFromBlock(null, main, nativePath(main.path), true)];
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
    if (entry.locked && entry.lockReason === null) {
      const file = await readCapped(path.join(commonDir, "worktrees", rec.id, "locked"), LOCK_FILE_READ_CAP);
      const text = file?.text.replace(/\r?\n$/, "") ?? "";
      if (text !== "") entry.lockReason = text;
    }
    if (oldGitPrunable && entry.supported && !entry.locked) {
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
  };
}

/**
 * FR-601: typed worktree entries. Linked entries come from `<common-dir>/worktrees/*` + `gitdir`; git's own porcelain
 * is only the cross-check, because a crafted `gitdir` with an interior newline can forge `worktree`/`HEAD` lines in the
 * newline format. Any disagreement marks the whole list `untrusted` (retried once to absorb a concurrent add/remove).
 */
export async function listWorktrees(repoPath: string): Promise<WorktreeList> {
  const commonDir = await resolveCommonDir(repoPath);
  const version = await getWorktreeGitVersion(repoPath);
  const useNul = gitVersionAtLeast(version, WORKTREE_LIST_Z_MIN_VERSION);
  const oldGitPrunable = !gitVersionAtLeast(version, WORKTREE_PORCELAIN_PRUNABLE_MIN_VERSION);
  let result: WorktreeList | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const admin = await readAdminRecords(commonDir);
    const read = await readPorcelain(repoPath, useNul);
    result = await assemble(commonDir, admin, read, oldGitPrunable);
    if (!result.untrusted) break;
  }
  return result!;
}
