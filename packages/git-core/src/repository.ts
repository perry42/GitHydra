import * as path from "node:path";
import * as fs from "node:fs/promises";
import { runGit, checkGitVersion, optionEquals, pathExists, type RunOptions } from "./gitProcess";
import { NotAGitRepositoryError, OperationCancelledError } from "./errors";
import { fastCheckRepositoryDiscovery } from "./fsRepoDiscovery";
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
 *
 * specs/repo-open-feedback.md FR-163: accepts an optional `signal`, threaded into every git
 * invocation below — this function (called first, from `getRepositoryState()`) IS "the
 * repo-validity check" FR-163 names, and is very often the very first `git` process this session
 * ever spawns (see FR-162's investigation finding, `gitProcess.ts`'s `resolveGitExecutablePath()`
 * doc comment), i.e. the single likeliest-to-be-slow call a user would want to cancel.
 */
export async function resolveRepositoryPaths(
  repoPath: string,
  signal?: AbortSignal,
): Promise<{ gitDir: string; commonGitDir: string; workdir: string | null; isBare: boolean }> {
  if (!pathExists(repoPath)) {
    throw new NotAGitRepositoryError(repoPath);
  }

  // Fast path (spawns no `git` process at all — see fsRepoDiscovery.ts's doc comment for the full
  // rationale and correctness contract): the common case of opening a folder that isn't a git
  // repository, and none of whose parents are either, can be answered from plain fs reads alone,
  // skipping BOTH `checkGitVersion()`'s `git --version` spawn below AND the single combined
  // `rev-parse` spawn further down (4 queries, one process — see its own doc comment for why
  // these 4 are safe to combine). Any ambiguity at all (a `.git` found somewhere, a bare-repo-
  // looking directory, ceiling/GIT_DIR-style env overrides, or an unexpected fs error mid-walk)
  // instead defers to git, falling through to the exact same code path this function has always
  // run — this fast path can only ever short-circuit the negative ("not a repo") answer, never the
  // positive one.
  if ((await fastCheckRepositoryDiscovery(repoPath, signal)) === "definitely-not-a-repo") {
    throw new NotAGitRepositoryError(repoPath);
  }

  await checkGitVersion(repoPath, signal);

  const opts: RunOptions = { cwd: repoPath, signal };

  // These 4 queries used to be 4 separate `git rev-parse` spawns run in parallel via
  // `Promise.all`. Consolidated into a single invocation (git-core-engineer investigation,
  // 2026-09-05, prompted by a user question about why opening a repo needs so many process
  // spawns — each one is a real OS process launch, exactly what real-time AV/EDR hooks add
  // highly variable latency to, per `fsRepoDiscovery.ts`'s doc comment): `git rev-parse` genuinely
  // supports multiple query flags in one invocation, printing one line of output per recognized
  // query flag, in the exact order given — verified directly (not assumed) against a real normal
  // repo, a bare repo, a linked worktree, and a genuine non-repo directory.
  //
  // Verified consolidation is SAFE specifically for these 4 flags because none of them is ever
  // individually inapplicable while the others succeed: each one only requires "cwd is inside some
  // git repository" (bare or not) to succeed at all — confirmed `--is-inside-work-tree` still
  // prints a plain "false" (exit 0) rather than erroring when run inside a bare repository, so
  // there is no repository shape where a mix of these 4 succeeds/fails asymmetrically. All 4
  // succeed together (one process, one exit 0, exactly 4 stdout lines in this order) or all 4 fail
  // together (cwd isn't a repository at all — `git` errors out on the very first flag it can't
  // satisfy and stops, non-zero exit, no stdout at all) — matching, line for line, what running
  // them as 4 separate calls already produced. This is NOT generalized to `--show-toplevel` below:
  // that query genuinely IS asymmetric (it fails with "this operation must be run in a work tree"
  // in a bare repo, confirmed directly, while the 4 above still succeed there), and it's also only
  // ever needed conditionally (`!isBare && isInsideWorkTree`), so it must stay a separate,
  // conditionally-issued call — combining a flag with divergent applicability into the same
  // invocation as these 4 would risk exactly the "some queries silently missing from stdout"
  // regression this consolidation is designed to avoid.
  const REV_PARSE_PROBE_ARGS = [
    "rev-parse",
    "--absolute-git-dir",
    "--git-common-dir",
    "--is-bare-repository",
    "--is-inside-work-tree",
  ] as const;

  let gitDir: string;
  let commonGitDir: string;
  let isBareRaw: string;
  let isInsideWorkTreeRaw: string;
  try {
    const { stdout } = await runGit(REV_PARSE_PROBE_ARGS, opts);
    // One line per flag, in the order given above — see this block's doc comment. A trailing
    // newline after the last flag's output means `split("\n")` yields a trailing "" entry, which
    // is simply never read (only indices 0-3 are). If a future/unexpected git behaves differently
    // and produces fewer than 4 lines despite exiting 0, that's exactly as untrustworthy as any
    // other malformed rev-parse response — fail the same way an outright command failure does,
    // rather than silently proceeding with `undefined`-derived empty strings.
    const lines = stdout.split("\n");
    if (lines.length < 4) throw new NotAGitRepositoryError(repoPath);
    [gitDir, commonGitDir, isBareRaw, isInsideWorkTreeRaw] = [
      lines[0]!.trim(),
      lines[1]!.trim(),
      lines[2]!.trim(),
      lines[3]!.trim(),
    ];
  } catch (err) {
    // FR-165: a caller cancellation is a distinct outcome — never folded into "this path isn't a
    // git repository at all". Only a GENUINE rev-parse failure becomes NotAGitRepositoryError.
    if (err instanceof OperationCancelledError) throw err;
    if (err instanceof NotAGitRepositoryError) throw err;
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

/** FR-163/FR-165: `signal` is threaded through; a caller cancellation must still surface as
 * `OperationCancelledError`, never get silently absorbed into this function's own "degrade to a
 * safe default on any failure" contract (which exists for a genuinely corrupt/unreadable repo
 * state, not for a caller-requested cancellation). */
export async function isShallowRepository(cwd: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const { stdout } = await runGit(["rev-parse", "--is-shallow-repository"], { cwd, signal });
    return stdout.trim() === "true";
  } catch (err) {
    if (err instanceof OperationCancelledError) throw err;
    return false;
  }
}

/** Read HEAD state: attached/detached, born/unborn, and the resolved SHA if any. See
 * `isShallowRepository`'s doc comment for why a caller cancellation (`signal`) must never be
 * folded into either of this function's own "degrade to null" catches below. */
async function readHeadState(
  cwd: string,
  signal?: AbortSignal,
): Promise<{
  currentBranch: string | null;
  isDetachedHead: boolean;
  isUnbornHead: boolean;
  headSha: string | null;
}> {
  let attachedBranch: string | null = null;
  try {
    const { stdout } = await runGit(["symbolic-ref", "-q", "--short", "HEAD"], { cwd, signal });
    attachedBranch = stdout.trim() || null;
  } catch (err) {
    if (err instanceof OperationCancelledError) throw err;
    attachedBranch = null; // detached, or truly no HEAD at all (shouldn't happen post git-init)
  }

  let headSha: string | null = null;
  try {
    const { stdout } = await runGit(["rev-parse", "--verify", "-q", "HEAD"], { cwd, signal });
    headSha = stdout.trim() || null;
  } catch (err) {
    if (err instanceof OperationCancelledError) throw err;
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

/** True if there are zero commits reachable from any ref in the repo. See
 * `isShallowRepository`'s doc comment for why a caller cancellation (`signal`) must never be
 * folded into this function's own "degrade to true" catch. */
async function isRepositoryEmpty(cwd: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const { stdout } = await runGit(["rev-list", "--all", "--max-count=1"], { cwd, signal });
    return stdout.trim() === "";
  } catch (err) {
    if (err instanceof OperationCancelledError) throw err;
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
 *
 * specs/repo-open-feedback.md FR-163: `signal` — when supplied (from `Repository.open()`'s own
 * `options.signal`, e.g. `openRepo`'s Cancel button) — is threaded through `resolveRepositoryPaths`
 * and every read in the `Promise.all` below: together, this is exactly "the repo-validity check
 * plus initial reads" the PRD names, and the single most likely place for the first-spawn slowness
 * FR-162 investigated to actually be felt. Deliberately NOT threaded into
 * `computeInProgressOperationDetail` below — see its call site's own comment for why.
 */
export async function getRepositoryState(repoPath: string, signal?: AbortSignal): Promise<RepositoryState> {
  const { gitDir, commonGitDir, workdir, isBare } = await resolveRepositoryPaths(repoPath, signal);
  const cwd = repoPath;

  const [inProgressOperation, isShallow, headState, isEmpty] = await Promise.all([
    detectInProgressOperation(gitDir),
    isShallowRepository(cwd, signal),
    readHeadState(cwd, signal),
    isRepositoryEmpty(cwd, signal),
  ]);

  // Only pay for FR-58's richer detail when an operation is actually in progress — the common
  // case (no operation) stays exactly as cheap as before this spec. `signal` is deliberately NOT
  // passed down into this call: every helper it fans out to (`commitSubject`/
  // `resolveRefNameForSha`/`computeMergeDetail`/`computeRebaseDetail`, above) is, by design, a
  // best-effort read that degrades to a null field on ANY failure rather than throwing (see each
  // one's own doc comment) — silently absorbing a cancellation into "degraded but successful" data
  // would defeat FR-165's "cancellation is a distinct, never-silently-absorbed outcome" guarantee.
  // Reworking every one of those intentionally-forgiving helpers to distinguish "cancelled" from
  // "corrupt/unreadable state" is a materially larger, separately-riskier change for a condition
  // (the just-opened repo already has a merge/rebase/cherry-pick/revert/am in progress) that's rare
  // in general and doubly rare to coincide with a user cancelling a slow open. A cancel clicked
  // while THIS specific subtree is in flight isn't instant (it runs to its own natural completion
  // or internal `DEFAULT_GIT_TIMEOUT_MS`, exactly as it did before this feature) — but the far more
  // common case this PRD targets, a slow/hung FIRST git spawn, resolves above and is instant.
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
