import * as path from "node:path";
import * as fs from "node:fs/promises";
import { runGit, checkGitVersion, pathExists, type RunOptions } from "./gitProcess";
import { NotAGitRepositoryError } from "./errors";
import type { InProgressOperation, RepositoryState } from "./types";

/**
 * Resolve and validate that `repoPath` is (inside) a git repository, and locate its
 * git-dir / common-git-dir / worktree root. Uses git's own plumbing for all of this
 * rather than guessing paths ourselves, since the layout differs for bare repos,
 * linked worktrees, and submodules.
 */
export async function resolveRepositoryPaths(
  repoPath: string,
): Promise<{ gitDir: string; commonGitDir: string; workdir: string | null; isBare: boolean }> {
  if (!pathExists(repoPath)) {
    throw new NotAGitRepositoryError(repoPath);
  }

  await checkGitVersion(repoPath);

  const opts: RunOptions = { cwd: repoPath };

  let gitDir: string;
  let commonGitDir: string;
  let isBareRaw: string;
  let isInsideWorkTreeRaw: string;
  try {
    [gitDir, commonGitDir, isBareRaw, isInsideWorkTreeRaw] = await Promise.all([
      runGit(["rev-parse", "--absolute-git-dir"], opts).then((r) => r.stdout.trim()),
      runGit(["rev-parse", "--git-common-dir"], opts).then((r) => r.stdout.trim()),
      runGit(["rev-parse", "--is-bare-repository"], opts).then((r) => r.stdout.trim()),
      runGit(["rev-parse", "--is-inside-work-tree"], opts).then((r) => r.stdout.trim()),
    ]);
  } catch {
    throw new NotAGitRepositoryError(repoPath);
  }

  // --git-common-dir can be printed relative (e.g. plain ".git" for the main worktree) —
  // relative to the cwd git was invoked from, NOT relative to --absolute-git-dir. Resolving
  // it against gitDir instead is a real bug: for the main worktree it turns ".git" into
  // "<gitDir>/.git", which never matches gitDir and makes every ordinary repo look like a
  // linked worktree.
  const absoluteCommonGitDir = path.isAbsolute(commonGitDir)
    ? commonGitDir
    : path.resolve(repoPath, commonGitDir);

  const isBare = isBareRaw === "true";
  const isInsideWorkTree = isInsideWorkTreeRaw === "true";

  let workdir: string | null = null;
  if (!isBare && isInsideWorkTree) {
    const { stdout } = await runGit(["rev-parse", "--show-toplevel"], opts);
    workdir = stdout.trim();
  }

  return {
    gitDir: path.resolve(gitDir),
    commonGitDir: path.resolve(absoluteCommonGitDir),
    workdir,
    isBare,
  };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Detect an in-progress operation (FR-5) by inspecting per-worktree state files under gitDir. */
async function detectInProgressOperation(gitDir: string): Promise<InProgressOperation> {
  const [mergeHead, cherryPickHead, revertHead, bisectStart, rebaseMerge, rebaseApply] =
    await Promise.all([
      fileExists(path.join(gitDir, "MERGE_HEAD")),
      fileExists(path.join(gitDir, "CHERRY_PICK_HEAD")),
      fileExists(path.join(gitDir, "REVERT_HEAD")),
      fileExists(path.join(gitDir, "BISECT_START")),
      fileExists(path.join(gitDir, "rebase-merge")),
      fileExists(path.join(gitDir, "rebase-apply")),
    ]);

  // Order matters: a rebase can have a paused cherry-pick-like step, but MERGE_HEAD/
  // CHERRY_PICK_HEAD/REVERT_HEAD take precedence when present since they're the more
  // specific, directly-actionable state.
  if (mergeHead) return "merge";
  if (cherryPickHead) return "cherry-pick";
  if (revertHead) return "revert";
  if (rebaseMerge) return "rebase";
  if (rebaseApply) {
    const applying = await fileExists(path.join(gitDir, "rebase-apply", "applying"));
    return applying ? "am" : "rebase";
  }
  if (bisectStart) return "bisect";
  return null;
}

/**
 * Read `.git/shallow` (and legacy `.git/info/grafts`) to find history-boundary commit
 * SHAs: commits that have no parents in this repo's object database even though they
 * are not true root commits upstream. The UI must mark these, not render them as roots
 * (edge case: shallow clones / grafted history).
 */
export async function readHistoryBoundarySet(commonGitDir: string): Promise<Set<string>> {
  const boundary = new Set<string>();

  try {
    const shallowContents = await fs.readFile(path.join(commonGitDir, "shallow"), "utf8");
    for (const line of shallowContents.split("\n")) {
      const sha = line.trim();
      if (sha) boundary.add(sha);
    }
  } catch {
    // no shallow file — normal, non-shallow repo.
  }

  try {
    const grafts = await fs.readFile(path.join(commonGitDir, "info", "grafts"), "utf8");
    for (const line of grafts.split("\n")) {
      const sha = line.trim().split(/\s+/)[0];
      if (sha) boundary.add(sha);
    }
  } catch {
    // no grafts file — normal case.
  }

  return boundary;
}

export async function isShallowRepository(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await runGit(["rev-parse", "--is-shallow-repository"], { cwd });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

/** Read HEAD state: attached/detached, born/unborn, and the resolved SHA if any. */
async function readHeadState(
  cwd: string,
): Promise<{
  currentBranch: string | null;
  isDetachedHead: boolean;
  isUnbornHead: boolean;
  headSha: string | null;
}> {
  let attachedBranch: string | null = null;
  try {
    const { stdout } = await runGit(["symbolic-ref", "-q", "--short", "HEAD"], { cwd });
    attachedBranch = stdout.trim() || null;
  } catch {
    attachedBranch = null; // detached, or truly no HEAD at all (shouldn't happen post git-init)
  }

  let headSha: string | null = null;
  try {
    const { stdout } = await runGit(["rev-parse", "--verify", "-q", "HEAD"], { cwd });
    headSha = stdout.trim() || null;
  } catch {
    headSha = null;
  }

  const isDetachedHead = attachedBranch === null && headSha !== null;
  const isUnbornHead = attachedBranch !== null && headSha === null;

  return {
    currentBranch: attachedBranch,
    isDetachedHead,
    isUnbornHead,
    headSha,
  };
}

/** True if there are zero commits reachable from any ref in the repo. */
async function isRepositoryEmpty(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await runGit(["rev-list", "--all", "--max-count=1"], { cwd });
    return stdout.trim() === "";
  } catch {
    return true;
  }
}

/** True if `gitDir` belongs to a linked worktree rather than the main working tree/repo. */
function isLinkedWorktree(gitDir: string, commonGitDir: string): boolean {
  return path.resolve(gitDir) !== path.resolve(commonGitDir);
}

/**
 * Compute full repository state: paths, bare/shallow/empty/worktree flags, HEAD state,
 * and any in-progress operation (FR-4, FR-5). Never throws for a "weird but valid" repo
 * state — those are reported as flags, not errors. Only throws if `repoPath` isn't a
 * git repository at all, or git itself is missing/too old.
 */
export async function getRepositoryState(repoPath: string): Promise<RepositoryState> {
  const { gitDir, commonGitDir, workdir, isBare } = await resolveRepositoryPaths(repoPath);
  const cwd = repoPath;

  const [inProgressOperation, isShallow, headState, isEmpty] = await Promise.all([
    detectInProgressOperation(gitDir),
    isShallowRepository(cwd),
    readHeadState(cwd),
    isRepositoryEmpty(cwd),
  ]);

  return {
    gitDir,
    commonGitDir,
    workdir,
    isBare,
    isShallow,
    isWorktree: isLinkedWorktree(gitDir, commonGitDir),
    isEmpty,
    isUnbornHead: headState.isUnbornHead,
    isDetachedHead: headState.isDetachedHead,
    currentBranch: headState.currentBranch,
    headSha: headState.headSha,
    inProgressOperation,
  };
}
