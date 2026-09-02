import * as path from "node:path";
import * as fs from "node:fs/promises";
import { runGit, checkGitVersion, optionEquals, pathExists, type RunOptions } from "./gitProcess";
import { NotAGitRepositoryError } from "./errors";
import { getWorkingDirectoryChanges } from "./workingDirStatus";
import type {
  AmOperationDetail,
  InProgressOperation,
  InProgressOperationDetail,
  MergeOperationDetail,
  RebaseOperationDetail,
  RepositoryState,
} from "./types";

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

/**
 * Detect an in-progress operation (FR-5) by inspecting per-worktree state files under gitDir.
 * Exported (beyond this module's own `getRepositoryState()` use) so `stash.ts` can run this same
 * cheap, fresh-from-disk check as a pre-flight guard before `applyStash`/`popStash` — see
 * `PreExistingConflictError` (`errors.ts`) for why that guard exists.
 */
export async function detectInProgressOperation(gitDir: string): Promise<InProgressOperation> {
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

const FULL_SHA_RE = /^[0-9a-fA-F]{40}$/;

async function readTextFile(filePath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw.trim();
  } catch {
    return null;
  }
}

async function readIntFile(filePath: string): Promise<number | null> {
  const raw = await readTextFile(filePath);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && Number.isInteger(n) ? n : null;
}

/** Read a file expected to contain a single full 40-hex commit SHA (MERGE_HEAD, onto, stopped-sha, ...).
 * Returns null (never throws) when the file is missing OR its content doesn't parse as a clean
 * SHA — a defensively-corrupt `.git` state degrades to "no detail" rather than crashing FR-58's
 * read-only detection, and a non-hex value is never allowed to reach a later git argument. */
async function readShaFileAt(filePath: string): Promise<string | null> {
  const raw = await readTextFile(filePath);
  if (raw === null) return null;
  const first = (raw.split("\n")[0] ?? "").trim();
  return FULL_SHA_RE.test(first) ? first.toLowerCase() : null;
}

function readShaFile(gitDir: string, name: string): Promise<string | null> {
  return readShaFileAt(path.join(gitDir, name));
}

/** `git show -s --format=%s <sha>` — best-effort, null on any failure (unresolvable/corrupt SHA, detached object gone, etc), never throws. */
async function commitSubject(cwd: string, sha: string): Promise<string | null> {
  if (!FULL_SHA_RE.test(sha)) return null;
  try {
    const { stdout } = await runGit(["show", "-s", "--format=%s", sha], { cwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Best-effort: a short branch/tag/remote-branch name that currently points exactly at `sha`, or null if none does. */
async function resolveRefNameForSha(cwd: string, sha: string): Promise<string | null> {
  if (!FULL_SHA_RE.test(sha)) return null;
  try {
    const { stdout } = await runGit(
      [
        "for-each-ref",
        "--format=%(refname:short)",
        optionEquals("--points-at", sha),
        "refs/heads",
        "refs/remotes",
        "refs/tags",
      ],
      { cwd },
    );
    const first = stdout.split("\n").find((l) => l.trim());
    return first ? first.trim() : null;
  } catch {
    return null;
  }
}

const MERGE_MSG_REF_RE = /^Merge (?:branch|remote-tracking branch|tag|commit) '([^']+)'/;

/**
 * FR-58: parse the incoming ref name from `MERGE_MSG`'s first line, matching the handful of
 * forms git itself generates ("Merge branch 'x'", "Merge remote-tracking branch 'origin/x'",
 * "Merge tag 'v1'", "Merge commit 'abc123'"). Returns null for anything else — a custom message
 * (`git merge -m "..."`), a squash merge, or a missing MERGE_MSG — rather than guessing.
 */
async function parseIncomingRefFromMergeMsg(gitDir: string): Promise<string | null> {
  const raw = await readTextFile(path.join(gitDir, "MERGE_MSG"));
  if (!raw) return null;
  const firstLine = raw.split("\n")[0] ?? "";
  const m = MERGE_MSG_REF_RE.exec(firstLine);
  return m ? m[1]! : null;
}

async function computeMergeDetail(gitDir: string, cwd: string): Promise<MergeOperationDetail | null> {
  const mergeHeadSha = await readShaFile(gitDir, "MERGE_HEAD");
  if (!mergeHeadSha) return null; // MERGE_HEAD existed (that's how we got "merge") but wasn't a clean SHA — corrupt/mid-write state, degrade rather than throw.

  const [headSha, mergeHeadSubject, incomingRef] = await Promise.all([
    runGit(["rev-parse", "--verify", "-q", "HEAD"], { cwd })
      .then((r) => r.stdout.trim() || null)
      .catch(() => null),
    commitSubject(cwd, mergeHeadSha),
    parseIncomingRefFromMergeMsg(gitDir),
  ]);
  const headSubject = headSha ? await commitSubject(cwd, headSha) : null;

  return { kind: "merge", headSha, headSubject, mergeHeadSha, mergeHeadSubject, incomingRef };
}

/**
 * FR-58: rebase detail from whichever backend is active — `rebase-merge/` (git's default "merge"
 * backend, used unless `--apply`/`git am` applies) or `rebase-apply/` (the apply backend). Step
 * counts come from `msgnum`/`end` (merge backend) or `next`/`last` (apply backend). The commit
 * currently being replayed comes from `stopped-sha` (merge backend, written when a step pauses
 * on conflict/empty-commit) or `original-commit` (apply backend, not written by every git
 * version) — both best-effort, null when unavailable rather than a guess.
 */
async function computeRebaseDetail(gitDir: string, cwd: string): Promise<RebaseOperationDetail> {
  const mergeDir = path.join(gitDir, "rebase-merge");
  const usingMergeBackend = await fileExists(mergeDir);
  const baseDir = usingMergeBackend ? mergeDir : path.join(gitDir, "rebase-apply");

  const [headNameRaw, ontoSha, currentStep, totalSteps, currentCommitSha] = await Promise.all([
    readTextFile(path.join(baseDir, "head-name")),
    readShaFileAt(path.join(baseDir, "onto")),
    readIntFile(path.join(baseDir, usingMergeBackend ? "msgnum" : "next")),
    readIntFile(path.join(baseDir, usingMergeBackend ? "end" : "last")),
    readShaFileAt(path.join(baseDir, usingMergeBackend ? "stopped-sha" : "original-commit")),
  ]);

  const originalBranch =
    headNameRaw && headNameRaw !== "detached"
      ? headNameRaw.startsWith("refs/heads/")
        ? headNameRaw.slice("refs/heads/".length)
        : headNameRaw
      : null;

  const [ontoSubject, ontoRef, currentCommitSubject] = await Promise.all([
    ontoSha ? commitSubject(cwd, ontoSha) : Promise.resolve(null),
    ontoSha ? resolveRefNameForSha(cwd, ontoSha) : Promise.resolve(null),
    currentCommitSha ? commitSubject(cwd, currentCommitSha) : Promise.resolve(null),
  ]);

  return {
    kind: "rebase",
    originalBranch,
    ontoSha,
    ontoSubject,
    ontoRef,
    currentCommitSha,
    currentCommitSubject,
    currentStep,
    totalSteps,
  };
}

const PICK_LINE_RE = /^pick\s/;

/**
 * FR-105/FR-108 (specs/cherry-pick.md): count of still-queued `pick` lines in
 * `.git/sequencer/todo`, EXCLUDING the currently-paused step's own line (git leaves it as the
 * FIRST line of `todo` until it actually succeeds — confirmed directly against real git, not
 * assumed: a 3-commit pick that pauses on commit 1 still shows all 3 `pick` lines in `todo`, so
 * "remaining after current" is `pickLineCount - 1`, never the raw line count). `null` when no
 * `sequencer/` directory exists at all — a single-commit cherry-pick never creates one, and
 * neither does any other in-progress-operation kind. Exported so `cherryPick.ts` can reuse this
 * exact computation for its own reads, rather than duplicating the parse.
 */
export async function computeRemainingAfterCurrentPicks(gitDir: string): Promise<number | null> {
  const raw = await readTextFile(path.join(gitDir, "sequencer", "todo"));
  if (raw === null) return null;
  const pickLineCount = raw.split("\n").filter((line) => PICK_LINE_RE.test(line.trim())).length;
  return Math.max(0, pickLineCount - 1);
}

/**
 * FR-105 (specs/cherry-pick.md): true when a paused cherry-pick's current step is already fully
 * reflected in `HEAD` — nothing conflicted, and nothing staged that this step still needs
 * committed. Verified directly against real git (2026-09-01): after `git cherry-pick <sha>` where
 * `<sha>`'s change is already an ancestor of `HEAD`, `CHERRY_PICK_HEAD` is written (git treats
 * this as a pause, not a silent no-op) but `git status --porcelain` reports nothing at all —
 * `conflicted` and `staged` are BOTH empty — distinguishing this cleanly from an ordinary
 * already-resolved conflict mid-`--continue` (which always has staged content differing from
 * `HEAD`, since the resolution itself is a real change to commit). `false` (never a guess) when
 * there is no `CHERRY_PICK_HEAD` at all, or `workdir` is unavailable (bare repo — cherry-pick
 * cannot be in progress there in the first place, since it requires a working tree).
 */
export async function computeCherryPickIsEmptyResult(gitDir: string, workdir: string | null): Promise<boolean> {
  if (!workdir) return false;
  const hasCherryPickHead = await fileExists(path.join(gitDir, "CHERRY_PICK_HEAD"));
  if (!hasCherryPickHead) return false;
  try {
    const changes = await getWorkingDirectoryChanges(workdir);
    return changes.conflicted.length === 0 && changes.staged.length === 0;
  } catch {
    return false; // defensively-corrupt working-tree read — degrade rather than throw (FR-58's contract).
  }
}

async function computeAmDetail(gitDir: string): Promise<AmOperationDetail> {
  const dir = path.join(gitDir, "rebase-apply");
  const [currentStep, totalSteps] = await Promise.all([
    readIntFile(path.join(dir, "next")),
    readIntFile(path.join(dir, "last")),
  ]);
  return { kind: "am", currentStep, totalSteps };
}

/**
 * FR-58: extend the bare `InProgressOperation` tag into a richer, read-only detail object —
 * merge/rebase/cherry-pick/revert-specific fields the UI needs for FR-60's banner and FR-61's
 * per-operation-type ours/theirs labeling. Makes no mutating call. Never throws: any unreadable
 * or unexpectedly-shaped state file degrades to a null field (or, in the merge case, a null
 * detail entirely) rather than surfacing a crash for what is, by definition, an already-unusual
 * mid-operation `.git` state.
 */
async function computeInProgressOperationDetail(
  gitDir: string,
  cwd: string,
  workdir: string | null,
  operation: InProgressOperation,
): Promise<InProgressOperationDetail> {
  switch (operation) {
    case null:
      return null;
    case "bisect":
      return { kind: "bisect" };
    case "merge":
      return computeMergeDetail(gitDir, cwd);
    case "cherry-pick": {
      const targetSha = await readShaFile(gitDir, "CHERRY_PICK_HEAD");
      if (!targetSha) return null;
      const [targetSubject, isEmptyResult, remainingAfterCurrent] = await Promise.all([
        commitSubject(cwd, targetSha),
        computeCherryPickIsEmptyResult(gitDir, workdir),
        computeRemainingAfterCurrentPicks(gitDir),
      ]);
      return { kind: "cherry-pick", targetSha, targetSubject, isEmptyResult, remainingAfterCurrent };
    }
    case "revert": {
      const targetSha = await readShaFile(gitDir, "REVERT_HEAD");
      if (!targetSha) return null;
      return { kind: "revert", targetSha, targetSubject: await commitSubject(cwd, targetSha) };
    }
    case "am":
      return computeAmDetail(gitDir);
    case "rebase":
      return computeRebaseDetail(gitDir, cwd);
  }
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

  // Only pay for FR-58's richer detail when an operation is actually in progress — the common
  // case (no operation) stays exactly as cheap as before this spec.
  const inProgressOperationDetail = await computeInProgressOperationDetail(
    gitDir,
    cwd,
    workdir,
    inProgressOperation,
  );

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
    inProgressOperationDetail,
  };
}
