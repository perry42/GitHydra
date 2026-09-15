// SPDX-License-Identifier: GPL-3.0-or-later
import { runGit, withEndOfOptions, withFsmonitorNeutralized } from "./gitProcess";
import { OperationAlreadyInProgressError } from "./errors";
import { detectInProgressOperation, resolveRepositoryPaths } from "./repository";

/**
 * Implements specs/drag-commit-menu.md's git-core surface for FR-297: actually START a merge
 * against current HEAD. Everything else this feature needs is the SAME generic infrastructure
 * specs/merge-rebase-conflict-resolution.md already ships for every `InProgressOperation` kind —
 * `RepositoryState.inProgressOperation`/`inProgressOperationDetail` (`repository.ts`, already
 * typing `MergeOperationDetail`), and the UNMODIFIED `abortInProgressOperation`/
 * `continueInProgressOperation` (`conflicts.ts`). This module adds only the one thing that
 * infrastructure was built to detect but never itself initiate — mirroring `cherryPick.ts`'s own
 * split (a mutating "start" function here, generic detection/resolution elsewhere) for the
 * identical reason.
 */

/**
 * Refuses (making no `git` call at all) when a merge/rebase/cherry-pick/revert/am/bisect is
 * already in progress. Mirrors `cherryPick.ts`'s identically-named, identically-shaped private
 * helper exactly — starting a second operation on top of an unresolved one would leave the
 * repository in a confusing, hard-to-recover state, the same reasoning that guards `cherryPick()`.
 */
async function assertNoOperationInProgress(workdir: string): Promise<void> {
  const { gitDir } = await resolveRepositoryPaths(workdir);
  const operation = await detectInProgressOperation(gitDir);
  if (operation !== null) {
    throw new OperationAlreadyInProgressError(operation, "merge");
  }
}

/**
 * FR-297: `git merge <otherSha>` — a single native call against current HEAD. Refuses up front
 * (`OperationAlreadyInProgressError`, no `git merge` call made) when
 * `detectInProgressOperation()` is already non-null. Routes through `withFsmonitorNeutralized()`
 * (same as every other mutating call in this package), builds only an argv array (`shell: false`
 * is `gitProcess.ts`'s own unconditional default), and passes `otherSha` through
 * `withEndOfOptions()` so it can never be misparsed as a flag.
 *
 * FR-299: always targets current HEAD — there is no target-branch parameter, matching
 * `cherryPick()`'s existing "always HEAD, no picker" precedent. Getting HEAD onto the intended
 * commit first is the UI layer's job (FR-309), reusing the already-shipped `git switch`/
 * `git switch --detach` — this function adds no checkout logic of its own.
 *
 * A clean fast-forward, a real merge commit, and a paused conflict are all indistinguishable in
 * this call's own return value (FR-297) — the caller discovers which one happened by re-reading
 * `RepositoryState`/`MergeOperationDetail` afterward, never out of band from this call.
 */
export async function mergeCommit(workdir: string, otherSha: string): Promise<void> {
  await assertNoOperationInProgress(workdir);

  await runGit(
    withFsmonitorNeutralized(["merge", ...withEndOfOptions([otherSha])]),
    { cwd: workdir, mutatesRepository: true },
  );
}
