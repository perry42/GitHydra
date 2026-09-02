import {
  runGit,
  runGitWithInput,
  withEndOfOptions,
  withFsmonitorNeutralized,
} from "./gitProcess";
import {
  CherryPickNotAtEmptyResultError,
  InvalidArgumentError,
  OperationAlreadyInProgressError,
} from "./errors";
import {
  computeCherryPickIsEmptyResult,
  computeRemainingAfterCurrentPicks,
  detectInProgressOperation,
  resolveRepositoryPaths,
} from "./repository";

/**
 * `GIT_EDITOR=true` is the standard cross-platform no-op-editor idiom — see `conflicts.ts`'s
 * identically-named/identically-valued constant (`NO_INTERACTIVE_EDITOR_ENV`) for the full
 * rationale; duplicated here (rather than imported) only because `conflicts.ts` doesn't export
 * it, not because the value differs. Used below for the internal `cherry-pick --continue` this
 * module's own `commitEmptyCherryPick()` sometimes has to issue (see its doc comment).
 */
const NO_INTERACTIVE_EDITOR_ENV = { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" } as const;

/**
 * Implements specs/cherry-pick.md's git-core surface (FR-103 through FR-110): actually start a
 * cherry-pick (single-commit or a multi-commit sequence), and resolve the FR-105 empty-result
 * pause via skip/commit-empty. See `Repository`'s own methods (index.ts) for the facade most
 * callers should use; the functions here are the lower-level implementation, matching every
 * other module's split in this package (stash.ts, conflicts.ts, branches.ts, ...).
 *
 * Everything else this feature needs is infrastructure `specs/merge-rebase-conflict-
 * resolution.md` already ships generically across every `InProgressOperation` kind, cherry-pick
 * included: `RepositoryState.inProgressOperation`/`inProgressOperationDetail`
 * (`repository.ts`), the FR-59 `CHERRY_PICK_HEAD` watcher coverage, and — critically — the
 * UNMODIFIED `abortInProgressOperation`/`continueInProgressOperation` (`conflicts.ts`). This
 * module adds only the one thing that infrastructure was built to detect but never itself
 * initiate: starting a cherry-pick, plus the two cherry-pick-specific pause resolutions
 * (skip / commit-empty) FR-105's empty-result case introduces.
 */

/**
 * Refuses (making no `git` call at all) when a merge/rebase/cherry-pick/revert/am/bisect is
 * already in progress. Shared by every mutating export below — `cherryPick()` needs this because
 * starting a second operation on top of an unresolved one would leave the repository in a
 * confusing, hard-to-recover state; `skipCherryPickCommit()`/`commitEmptyCherryPick()` need the
 * narrower "is this genuinely a cherry-pick" check from `assertPausedOnEmptyResult` below instead
 * (not this one), since by definition they're only ever called while ones IS already in progress.
 */
async function assertNoOperationInProgress(workdir: string): Promise<{ gitDir: string }> {
  const { gitDir } = await resolveRepositoryPaths(workdir);
  const operation = await detectInProgressOperation(gitDir);
  if (operation !== null) {
    throw new OperationAlreadyInProgressError(operation);
  }
  return { gitDir };
}

/**
 * FR-103: `git cherry-pick <sha1> <sha2> ... <shaN>` — a single native call, in exactly the
 * order given (ordering is the CALLER's contract to uphold; FR-114's "derive order from graph
 * position, not click order" is ui-graphics's job, not this function's). Using git's own
 * multi-arg sequencer for a multi-commit request — rather than GitHydra issuing one `git
 * cherry-pick` call per commit itself — is deliberate: it's what makes the *existing, unmodified*
 * `abortInProgressOperation`/`continueInProgressOperation` (`conflicts.ts`) correct for a
 * multi-commit sequence for free. Native `--abort` restores the pre-sequence `HEAD` (not just the
 * current step); native `--continue` auto-advances through the remaining queue, pausing again
 * only if a later commit also conflicts or is itself an empty result. Self-orchestrating
 * single-commit calls instead would silently diverge from that real git behavior (an abort
 * mid-sequence would only undo the current step, leaving earlier picks committed) — see
 * specs/cherry-pick.md's "A sharp edge worth stating plainly".
 *
 * Refuses up front, with no git call made, when:
 *  - `shas` is empty (`InvalidArgumentError`) — nothing to pick.
 *  - `detectInProgressOperation()` is already non-null (`OperationAlreadyInProgressError`,
 *    mirroring `stash.ts`'s `PreExistingConflictError` precedent).
 *
 * FR-104: returns once git exits 0 — `HEAD` has advanced by exactly `shas.length` new commits. A
 * paused outcome (a real conflict, OR the FR-105 empty-result case) is never distinguished in
 * this return value, matching this codebase's established convention that in-progress-operation
 * state lives on disk and is discovered by re-reading `RepositoryState`/`WorkingDirectoryChanges`
 * afterward, never returned out of band by the call that triggered it.
 *
 * Routes through `withFsmonitorNeutralized()` (this refreshes the index, same as `git status`/
 * `git add`/`git commit`) and only ever builds an argv array — every element of `shas` is passed
 * after `--end-of-options` (`withEndOfOptions()`) so a `-`-prefixed value (accidental or
 * adversarial) can never be misparsed as a flag by git itself.
 */
export async function cherryPick(workdir: string, shas: readonly string[]): Promise<void> {
  if (shas.length === 0) {
    throw new InvalidArgumentError("cherryPick() requires at least one commit SHA to pick.");
  }

  await assertNoOperationInProgress(workdir);

  await runGit(
    withFsmonitorNeutralized(["cherry-pick", ...withEndOfOptions(shas as string[])]),
    { cwd: workdir, mutatesRepository: true },
  );
}

/**
 * Refuses (`CherryPickNotAtEmptyResultError`, no `git` call made) unless the repository is
 * GENUINELY a cherry-pick currently paused on FR-105's empty-result state — re-verified fresh
 * from disk here (never trusted from a caller-supplied value, and never inferred from the mere
 * fact that a caller chose to call `skipCherryPickCommit()`/`commitEmptyCherryPick()`). Shared by
 * both of those exports, which differ only in which `git` call they issue once this passes.
 */
async function assertPausedOnEmptyResult(
  workdir: string,
  requested: "skip" | "commit-empty",
): Promise<{ gitDir: string }> {
  const { gitDir } = await resolveRepositoryPaths(workdir);
  const operation = await detectInProgressOperation(gitDir);
  if (operation !== "cherry-pick") {
    throw new CherryPickNotAtEmptyResultError(requested);
  }
  const isEmptyResult = await computeCherryPickIsEmptyResult(gitDir, workdir);
  if (!isEmptyResult) {
    throw new CherryPickNotAtEmptyResultError(requested);
  }
  return { gitDir };
}

/**
 * FR-106: `git cherry-pick --skip` — advance past the currently-paused step with no commit
 * created for it. Only valid while FR-105's empty-result state is genuinely present (see
 * `assertPausedOnEmptyResult`) — throws `CherryPickNotAtEmptyResultError` otherwise, rather than
 * calling git blind against a real, unresolved conflict (where `--skip` would silently discard
 * the user's in-progress resolution work).
 *
 * After a successful skip, git's own sequencer automatically advances to the next queued commit,
 * or ends the cherry-pick entirely if none remain — no separate "advance" call exists or is
 * needed (confirmed directly: a multi-commit sequence's remaining `pick` lines apply completely
 * unattended after this single call when none of them also pause).
 */
export async function skipCherryPickCommit(workdir: string): Promise<void> {
  await assertPausedOnEmptyResult(workdir, "skip");
  await runGit(withFsmonitorNeutralized(["cherry-pick", "--skip"]), { cwd: workdir, mutatesRepository: true });
}

/**
 * FR-106: `git commit --allow-empty`, reusing the paused commit's ORIGINAL message verbatim —
 * read directly from that commit object (`git show -s --format=%B <CHERRY_PICK_HEAD>`), not from
 * `COMMIT_EDITMSG`/`MERGE_MSG` (which this module never trusts as a source of truth, since
 * either could in principle have been altered independently of the commit object itself) — piped
 * to `git commit`'s stdin via the same `-F -` technique `createCommit()` (`commitChanges.ts`)
 * already uses, never an interactive editor and never `-m`/string concatenation. Only valid while
 * FR-105's empty-result state is genuinely present — throws `CherryPickNotAtEmptyResultError`
 * (no `git` call made) otherwise.
 *
 * **A sharp edge, verified directly against real git (2026-09-01), that this function exists
 * specifically to paper over:** unlike `--skip`, a plain `git commit --allow-empty` does NOT by
 * itself advance a MULTI-commit cherry-pick's sequencer past the step it just committed — it
 * clears `CHERRY_PICK_HEAD` but leaves `.git/sequencer/todo` (and therefore any still-queued
 * commits) untouched and unapplied, silently stalling the sequence, UNLESS this was the last
 * queued commit (in which case the plain commit alone does correctly end the whole operation).
 * So that FR-106's promised "no separate advance call exists or is needed" is actually true from
 * the CALLER's perspective, this function checks `remainingAfterCurrent` before committing and,
 * when more commits remain queued, itself issues the necessary `cherry-pick --continue`
 * afterward (same no-interactive-editor environment `continueInProgressOperation` uses) — the
 * caller never needs to, and never should, call that separately for this case.
 */
export async function commitEmptyCherryPick(workdir: string): Promise<void> {
  const { gitDir } = await assertPausedOnEmptyResult(workdir, "commit-empty");

  const { stdout: targetShaRaw } = await runGit(["rev-parse", "CHERRY_PICK_HEAD"], { cwd: workdir });
  const targetSha = targetShaRaw.trim();
  const { stdout: message } = await runGit(["show", "-s", "--format=%B", targetSha], { cwd: workdir });
  const remainingAfterCurrent = await computeRemainingAfterCurrentPicks(gitDir);

  await runGitWithInput(
    withFsmonitorNeutralized(["commit", "--quiet", "--allow-empty", "-F", "-"]),
    { cwd: workdir, mutatesRepository: true },
    message,
  );

  if (remainingAfterCurrent !== null && remainingAfterCurrent > 0) {
    await runGit(withFsmonitorNeutralized(["cherry-pick", "--continue"]), {
      cwd: workdir,
      extraEnv: NO_INTERACTIVE_EDITOR_ENV,
      mutatesRepository: true,
    });
  }
}
