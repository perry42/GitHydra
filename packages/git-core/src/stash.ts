import {
  runGit,
  optionEquals,
  withFsmonitorNeutralized,
} from "./gitProcess";
import {
  GitCommandError,
  InvalidArgumentError,
  NothingEligibleToStashError,
  PreExistingConflictError,
  StashOnUnbornHeadError,
} from "./errors";
import { assertPathWithinWorkdir } from "./pathSafety";
import { detectInProgressOperation, resolveRepositoryPaths } from "./repository";
import { getWorkingDirectoryChanges } from "./workingDirStatus";
import { getChangedFiles } from "./changedFiles";
import { getFileDiff } from "./diff";
import type {
  CreateStashOptions,
  CreateStashResult,
  DiffOptions,
  StashApplyOutcome,
  StashDiffFile,
  StashDiffResult,
  StashInfo,
  WorkingDirectoryChanges,
} from "./types";

/**
 * Implements specs/stash.md's git-core surface (FR-81 through FR-90): list/preview/create/
 * apply/pop/drop. See `Repository`'s own methods (index.ts) for the facade most callers should
 * use; the functions here are the lower-level implementation, matching every other module's split
 * in this package (branches.ts, conflicts.ts, staging.ts, ...).
 *
 * **A sharp edge worth restating here (see specs/stash.md's "A sharp edge worth stating
 * plainly")**: `git stash apply`/`git stash pop` resolve conflicts via an internal merge but
 * write no `MERGE_HEAD`-equivalent state anywhere — `detectInProgressOperation()`
 * (`repository.ts`) correctly returns `null` after a conflicting apply/pop, and nothing in this
 * module fabricates one. `applyStash()`/`popStash()` detect a conflict the exact same way every
 * other read in this package detects live state: by re-reading `getWorkingDirectoryChanges()`
 * afterward and checking its `conflicted` list — never by parsing stderr for a "CONFLICT" marker
 * (git's own textual conflict message for stash is not even guaranteed stable across versions)
 * and never by inventing a synthetic in-progress-operation record. Once a conflict is detected
 * this way, resolution reuses `conflicts.ts`'s existing per-file primitives
 * (`getWorkingDirectoryChanges().conflicted`, `classifyStageCombination`, `getConflictFileDiff`,
 * `scanConflictMarkers`, `acceptConflictSide`, `markConflictResolved`) completely unmodified —
 * those are already generic over live index-stage state, not over which operation produced it,
 * so a stash-apply conflict's stage-2/stage-3 blobs resolve identically to a merge's (verified in
 * `tests/stash.test.ts`'s conflict-handling describe block).
 *
 * FR-82: **stash list scope is the common git dir, not any one worktree's private git dir.**
 * Unlike `MERGE_HEAD`/rebase state (which really is per-worktree — see `repository.ts`), `git`
 * itself already stores `refs/stash` and its reflog in the repository's COMMON git directory and
 * transparently resolves them the same way regardless of which linked worktree's directory a git
 * command is invoked from. Every function below simply passes the caller's own working directory
 * (or repo path) as `cwd` to a real `git` invocation — never hand-rolls a `refs/stash`/reflog file
 * read — so this correct shared-visibility behavior falls out of shelling out to git rather than
 * needing any extra path-juggling here. Confirmed directly (not just assumed) by
 * `tests/stash.test.ts`'s two-linked-worktrees test: a stash created via one worktree's `cwd` is
 * immediately visible via `listStashes()` called with the OTHER worktree's `cwd`.
 */

// -------------------------------------------------------------------------------------------
// Shared helpers.
// -------------------------------------------------------------------------------------------

/**
 * Build a `stash@{N}` ref string from a caller-supplied index. `index` is always a `number` in
 * this module's public API (never a caller-controlled string reaching argv), so there is no
 * argument-injection surface here — this only guards against a nonsensical/out-of-range value
 * (negative, non-integer) reaching git as a malformed revision.
 */
function stashRef(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new InvalidArgumentError(`Stash index must be a non-negative integer: ${JSON.stringify(index)}`);
  }
  return `stash@{${index}}`;
}

/** True when `git rev-parse --verify -q HEAD` fails — i.e. HEAD is unborn (zero commits yet). */
async function isUnbornHead(cwd: string): Promise<boolean> {
  try {
    await runGit(["rev-parse", "--verify", "-q", "HEAD"], { cwd });
    return false;
  } catch {
    return true;
  }
}

// -------------------------------------------------------------------------------------------
// FR-81/FR-82: listStashes.
// -------------------------------------------------------------------------------------------

const STASH_FS = "\x1f"; // ASCII unit separator, same convention as branches.ts/refs.ts.
const STASH_RS_TOKEN = "%x00"; // NUL record separator — see commitLog.ts's LOG_FORMAT doc comment for why NUL.

// Field order must match the destructuring in listStashes() below.
//
// Deliberately `%cI` (committer date, strict ISO 8601 — needs no `--date=` option at all), NOT
// `%cd` plus a `--date=iso-strict` invocation flag: verified directly that passing `--date=` to
// `git stash list` at all changes how `%gd` itself renders — WITHOUT a `--date` option `%gd`
// prints the plain index form this module depends on (`stash@{0}`), but WITH one it renders the
// reflog selector's date-based form instead (`stash@{2026-09-01T02:37:46+03:00}`), which broke
// this module's own `index`/`ref` parsing outright the first time this was written using
// `--date=iso-strict` + `%cd`. `%cI`/`%aI` sidestep this entirely by carrying their own
// self-contained strict-ISO formatting, with no dependency on (or interference with) `--date`.
const STASH_FORMAT = `${STASH_RS_TOKEN}${["%gd", "%H", "%P", "%cI", "%gs"].join(STASH_FS)}`;

const WIP_MESSAGE_RE = /^WIP on ([^:]*): (.*)$/;
const CUSTOM_MESSAGE_RE = /^On ([^:]*): (.*)$/;

/**
 * Parse one stash's reflog subject (`%gs`) into FR-81's `message`/`branch` split.
 *
 * git writes exactly one of two forms for every stash it creates, and a branch name can never
 * itself contain a colon (git's own ref-name rules forbid it), so splitting on the first colon
 * after the "WIP on "/"On " prefix is unambiguous even when the message itself contains a colon:
 *  - No custom message: `WIP on <branch>: <sha> <subject>` (or `WIP on (no branch): ...` for a
 *    detached-HEAD stash) — `message` is this string verbatim (FR-81), `branch` is parsed out
 *    (null for the literal "(no branch)" sentinel).
 *  - Custom message (`git stash push -m "..."`): `On <branch>: <message>` — `message` is the
 *    custom text with git's wrapper stripped back out (FR-81's "a custom message verbatim");
 *    `branch` is always null here, by this module's contract, even though git's own wrapper
 *    happens to name one — FR-81 deliberately does not parse a branch out of a custom message.
 * Any other shape (a defensively-unusual `.git` state, or a stash created by some other tool)
 * falls back to treating the whole subject as an opaque message with a null branch, rather than
 * throwing — matching this package's "never crash on an unusual-but-real repository state" rule.
 */
export function parseStashSubject(subject: string): { message: string; branch: string | null } {
  const wip = WIP_MESSAGE_RE.exec(subject);
  if (wip) {
    const rawBranch = wip[1] ?? "";
    return { message: subject, branch: rawBranch === "(no branch)" ? null : rawBranch || null };
  }
  const custom = CUSTOM_MESSAGE_RE.exec(subject);
  if (custom) {
    return { message: custom[2] ?? "", branch: null };
  }
  return { message: subject, branch: null };
}

/**
 * FR-81: every entry from `git stash list`, read fresh from disk on every call (no cached
 * authoritative copy — same convention every other list-style function in this module follows).
 * Returns `[]` (not an error) when there are no stashes. See `Repository.listStashes()` for the
 * bare-repo `null` convention (this lower-level function is never called for a bare repo in
 * practice, but does not itself need to know about bare-ness — it would simply return `[]`).
 *
 * Uses a NUL record separator (`%x00` placed at the START of each record's format, same
 * technique `commitLog.ts`'s `LOG_FORMAT` uses and documents) rather than relying on
 * one-stash-per-newline. Because the separator is a PREFIX, git's own implicit trailing newline
 * after each formatted entry ends up attached to the END of that same record (i.e. inside the
 * last field, `%gs`) once split on `\0` — mirroring exactly how `commitLog.ts`'s `parseRecord()`
 * strips a trailing newline from its own last field for the same structural reason — so each
 * record has its trailing newline(s) stripped below before being split into fields.
 */
export async function listStashes(cwd: string): Promise<StashInfo[]> {
  const { stdout } = await runGit(["stash", "list", `--format=${STASH_FORMAT}`], { cwd });

  const records = stdout
    .split("\0")
    .map((r) => r.replace(/\n+$/, ""))
    .filter((r) => r.length > 0);

  const entries: StashInfo[] = [];
  for (const record of records) {
    const [gd, sha, parentsRaw, date, subject] = record.split(STASH_FS);
    if (!gd || !sha) continue;
    const indexMatch = /^stash@\{(\d+)\}$/.exec(gd);
    if (!indexMatch) continue; // defensively skip an unparseable selector rather than crash.
    const index = Number(indexMatch[1]);
    const parents = parentsRaw ? parentsRaw.split(" ").filter(Boolean) : [];
    const { message, branch } = parseStashSubject(subject ?? "");

    entries.push({
      index,
      ref: `stash@{${index}}`,
      sha,
      message,
      branch,
      date: date ?? "",
      parentSha: parents[0] ?? null,
    });
  }
  return entries;
}

// -------------------------------------------------------------------------------------------
// FR-83: getStashDiff — file list + per-file diff content, read-only.
// -------------------------------------------------------------------------------------------

/**
 * FR-83: the full set of files a stash would change if applied — including any untracked files
 * it captured (`--include-untracked`) — with diff content for each file computed up front,
 * reusing `diff.ts`'s existing binary/too-large guard pattern via `getFileDiff()`. Never touches
 * the working tree or index (every git call here reads existing objects only).
 *
 * A stash commit's tree structure (see git's own internals): parent 1 is always the pre-stash
 * `HEAD` (this module's "first-parent diff-base convention", same one `getChangedFiles()`/
 * `getCommitFileDiff()` already use for ordinary merge commits); parent 2 is a commit of the
 * stashed index state; parent 3 — present only when the stash was created with
 * `--include-untracked`/`--all` — is a ROOT commit (no parent of its own) whose tree is exactly
 * the untracked files that were captured. Tracked changes are diffed parent-1-relative (ordinary
 * first-parent diff); the untracked capture, when present, is diffed against git's own empty-tree
 * object (same convention `getChangedFiles()` already uses for a true root commit), which is
 * exactly "every file in it, shown as pure additions" — correct for a stash's untracked capture.
 */
export async function getStashDiff(
  cwd: string,
  index: number,
  options: DiffOptions = {},
): Promise<StashDiffResult> {
  const ref = stashRef(index);
  const { stdout: shaOut } = await runGit(["rev-parse", ref], { cwd });
  const stashSha = shaOut.trim();

  const { stdout: parentsOut } = await runGit(["show", "-s", "--format=%P", stashSha], { cwd });
  const parents = parentsOut.trim() ? parentsOut.trim().split(" ").filter(Boolean) : [];

  const trackedFiles = await getChangedFiles(cwd, stashSha, parents);
  const untrackedCommitSha = parents[2]; // present only for an --include-untracked stash.
  const untrackedFiles = untrackedCommitSha ? await getChangedFiles(cwd, untrackedCommitSha, []) : [];

  const files: StashDiffFile[] = [];
  for (const f of trackedFiles) {
    const diff = await getFileDiff(
      cwd,
      { kind: "commit", sha: stashSha, parents, path: f.path, oldPath: f.oldPath },
      options,
    );
    files.push({ ...f, isUntracked: false, diff });
  }
  for (const f of untrackedFiles) {
    const diff = await getFileDiff(
      cwd,
      { kind: "commit", sha: untrackedCommitSha!, parents: [], path: f.path, oldPath: f.oldPath },
      options,
    );
    files.push({ ...f, isUntracked: true, diff });
  }

  return { files };
}

// -------------------------------------------------------------------------------------------
// FR-84: createStash.
// -------------------------------------------------------------------------------------------

/**
 * Compute the exact pathspec `createStash()` will pass to `git stash push -- <paths>`, from an
 * already-fetched `WorkingDirectoryChanges` snapshot.
 *
 * Deliberately always enumerates and passes an explicit pathspec — never a bare, pathspec-less
 * `git stash push` — mirroring `stageAllFiles()`'s/`unstageAllFiles()`'s existing rationale
 * (`staging.ts`): a conflicted path must be structurally impossible to include, not merely
 * unlikely, and the only way to guarantee that is to build the file list ourselves from
 * `getWorkingDirectoryChanges()` (which already reports conflicted paths in their own separate
 * `conflicted` category, never inside `staged`/`unstaged`/`untracked`) rather than ever letting a
 * blanket "stash everything" default reach a repo mid-conflict.
 *
 * When `requestedPaths` is given, the result is `requestedPaths` intersected with the eligible
 * set (silently dropping a path that's already clean, or — when `includeUntracked` is false —
 * untracked) rather than erroring per-path; `createStash()` itself is responsible for refusing
 * the call entirely if the intersection ends up empty (FR-84's "nothing eligible" refusal).
 */
function computeEligiblePaths(
  changes: WorkingDirectoryChanges,
  requestedPaths: readonly string[] | undefined,
  includeUntracked: boolean,
): string[] {
  const eligible = new Set<string>([...changes.staged, ...changes.unstaged].map((f) => f.path));
  if (includeUntracked) {
    for (const f of changes.untracked) eligible.add(f.path);
  }

  if (requestedPaths && requestedPaths.length > 0) {
    return requestedPaths.filter((p) => eligible.has(p));
  }
  return Array.from(eligible);
}

/**
 * FR-84: `git stash push`. Refuses with a typed error — never a raw `GitCommandError` — for
 * every "can't possibly proceed" case:
 *  - `StashOnUnbornHeadError` — HEAD has no commit yet; `git stash` has no parent to create a
 *    stash commit against. Checked before anything else, so this takes priority even on an
 *    unborn HEAD that happens to already have staged content.
 *  - `NothingEligibleToStashError` — the clean-working-tree case, the every-changed-path-is-
 *    conflicted case, the "every explicitly-requested path was excluded" case, AND (verified
 *    directly against real git, not assumed) the case where ANY path anywhere in the repository
 *    is currently conflicted at all — even one having nothing to do with the requested pathspec.
 *    `git stash push`, with or without a pathspec, unconditionally refuses ("<path>: needs
 *    merge") the instant a single unmerged index entry exists ANYWHERE in the repo, regardless
 *    of whether that path is even mentioned in the pathspec — so simply excluding conflicted
 *    paths from the eligible set (as FR-84 requires) is not sufficient by itself to guarantee a
 *    clean partial stash succeeds while an unrelated conflict is present elsewhere; the whole
 *    operation must be refused up front in that case, with this same typed error, rather than
 *    letting git's real (and, out of context, confusing) refusal leak through as a raw
 *    `GitCommandError` for a path the caller never even asked to stash.
 *
 * The optional custom message is passed as a single `--message=<value>` argv token
 * (`optionEquals()`, the same convention this package already uses for every other
 * value-bearing flag) rather than split across two argv entries — `git stash push` has no
 * stdin-based message input the way `git commit -F -` does (there is no `git stash push -F`), so
 * this single-token form is the closest equivalent safety property available: the value can never
 * be misparsed as a separate flag regardless of its content, including a value that itself starts
 * with `-`.
 */
export async function createStash(workdir: string, options: CreateStashOptions = {}): Promise<CreateStashResult> {
  if (await isUnbornHead(workdir)) {
    throw new StashOnUnbornHeadError();
  }

  const changes = await getWorkingDirectoryChanges(workdir);
  if (changes.conflicted.length > 0) {
    throw new NothingEligibleToStashError();
  }

  const includeUntracked = options.includeUntracked ?? false;
  const paths = computeEligiblePaths(changes, options.paths, includeUntracked);
  if (paths.length === 0) {
    throw new NothingEligibleToStashError();
  }
  for (const p of paths) assertPathWithinWorkdir(workdir, p);

  const args = ["stash", "push"];
  if (includeUntracked) args.push("--include-untracked");
  const message = options.message?.trim();
  if (message) args.push(optionEquals("--message", message));
  args.push("--", ...paths);

  await runGit(withFsmonitorNeutralized(args), { cwd: workdir, mutatesRepository: true });

  // `git stash push` prints a human-readable confirmation line to stdout, not a
  // machine-parseable ref/sha — resolve the just-created entry directly instead of scraping it.
  const { stdout } = await runGit(["rev-parse", "stash@{0}"], { cwd: workdir });
  return { ref: "stash@{0}", sha: stdout.trim() };
}

// -------------------------------------------------------------------------------------------
// FR-85/FR-86/FR-87: applyStash / popStash.
// -------------------------------------------------------------------------------------------

/**
 * Shared implementation for `applyStash()`/`popStash()`: both are, at the git level, "run this
 * subcommand against this stash ref and see what happened" — the FR-87 pop-never-drops-on-
 * conflict behavior is git's OWN native behavior for `git stash pop` (it only runs the equivalent
 * of `git stash drop` internally after a clean apply), not something this module reimplements as
 * apply-then-drop — so there is exactly one code path here, not two.
 *
 * Conflict detection never parses stderr: a failed `git stash apply`/`pop` is only classified as
 * FR-86's "conflict" outcome when a fresh `getWorkingDirectoryChanges()` call afterward actually
 * shows `conflicted` entries (live index-stage state, same ground truth `conflicts.ts` already
 * treats as authoritative) — any other failure (e.g. "your local changes ... would be
 * overwritten", a refusal with nothing left unmerged) is re-thrown as-is, surfacing git's real
 * reason verbatim per FR-85.
 *
 * Before any of that, a pre-flight check (`assertNoPreExistingConflict`) refuses up front —
 * throwing `PreExistingConflictError`, making no `git stash apply|pop` call at all — if the
 * repository already has an unrelated conflict or in-progress operation. Without this, the
 * catch-and-re-read-conflicts logic above would misattribute a PRE-EXISTING, unrelated conflict
 * (e.g. a real merge genuinely in progress elsewhere, or leftover unmerged index entries from any
 * other cause) to this stash operation, since it has no way to tell "conflicted entries this apply
 * just produced" apart from "conflicted entries that were already there" by re-reading state
 * alone. See `PreExistingConflictError`'s doc comment (`errors.ts`).
 */
async function assertNoPreExistingConflict(workdir: string, requested: "apply" | "pop"): Promise<void> {
  const { gitDir } = await resolveRepositoryPaths(workdir);
  const [operation, changes] = await Promise.all([
    detectInProgressOperation(gitDir),
    getWorkingDirectoryChanges(workdir),
  ]);
  if (operation !== null || changes.conflicted.length > 0) {
    throw new PreExistingConflictError(requested, operation, changes.conflicted.map((f) => f.path));
  }
}

async function runStashApplyLike(
  workdir: string,
  subcommand: "apply" | "pop",
  index: number,
): Promise<StashApplyOutcome> {
  await assertNoPreExistingConflict(workdir, subcommand);
  const ref = stashRef(index);
  try {
    await runGit(withFsmonitorNeutralized(["stash", subcommand, ref]), {
      cwd: workdir,
      mutatesRepository: true,
    });
    return { status: "applied" };
  } catch (err) {
    if (!(err instanceof GitCommandError)) throw err;
    const changes = await getWorkingDirectoryChanges(workdir);
    if (changes.conflicted.length > 0) {
      return { status: "conflict", conflictedPaths: changes.conflicted.map((f) => f.path) };
    }
    throw err;
  }
}

/** FR-85: `git stash apply stash@{N}` — leaves the stash entry in the list either way (clean or conflicting). */
export async function applyStash(workdir: string, index: number): Promise<StashApplyOutcome> {
  return runStashApplyLike(workdir, "apply", index);
}

/**
 * FR-85/FR-87: `git stash pop stash@{N}` — removes the stash entry ONLY when the apply step
 * succeeds cleanly (git's own native behavior, not reimplemented here). On conflict, behaves
 * identically to `applyStash()`: the stash entry remains in `git stash list`, and the conflicted
 * files are left in the working tree/index for the user to resolve — there is no
 * `git stash pop --abort` and this module does not synthesize one (see this file's module doc
 * comment / specs/stash.md's "A sharp edge worth stating plainly").
 */
export async function popStash(workdir: string, index: number): Promise<StashApplyOutcome> {
  return runStashApplyLike(workdir, "pop", index);
}

// -------------------------------------------------------------------------------------------
// FR-88: dropStash.
// -------------------------------------------------------------------------------------------

/**
 * FR-88: `git stash drop stash@{N}` — a separately-named, explicit destructive export, never
 * reachable via `applyStash()`/`popStash()`'s code path (mirrors `forceDeleteBranch()`'s
 * isolation from `deleteBranch()` in `branches.ts`). Ref-only — never touches the working tree or
 * index — so no `withFsmonitorNeutralized()` guard is needed (FR-89, matching `git branch`'s own
 * precedent for a ref-only mutation).
 */
export async function dropStash(cwd: string, index: number): Promise<void> {
  const ref = stashRef(index);
  await runGit(["stash", "drop", ref], { cwd, mutatesRepository: true });
}
