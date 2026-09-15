// SPDX-License-Identifier: GPL-3.0-or-later
import { runGit, withEndOfOptions, withFsmonitorNeutralized } from "./gitProcess";
import { OperationAlreadyInProgressError } from "./errors";
import { detectInProgressOperation, resolveRepositoryPaths } from "./repository";

/**
 * Implements specs/drag-commit-menu.md's git-core surface for FR-298: actually START a rebase of
 * current HEAD onto another commit. See `merge.ts`'s doc comment for the shared rationale (same
 * generic detect/abort/continue infrastructure this reuses unmodified, same "one module adds only
 * the start call" split `cherryPick.ts` already established).
 */

/**
 * Refuses (making no `git` call at all) when a merge/rebase/cherry-pick/revert/am/bisect is
 * already in progress. Mirrors `cherryPick.ts`'s/`merge.ts`'s identically-shaped private helper.
 */
async function assertNoOperationInProgress(workdir: string): Promise<void> {
  const { gitDir } = await resolveRepositoryPaths(workdir);
  const operation = await detectInProgressOperation(gitDir);
  if (operation !== null) {
    throw new OperationAlreadyInProgressError(operation, "rebase");
  }
}

/**
 * FR-298: `git rebase <newBaseSha>` — a single native call against current HEAD, git's plain
 * non-interactive form (no `--onto`, no todo-list editing — this feature never edits history
 * structurally itself, per the spec's own Non-goals). Refuses up front
 * (`OperationAlreadyInProgressError`, no `git rebase` call made) when
 * `detectInProgressOperation()` is already non-null. Same argv-array/`withEndOfOptions()`/
 * `withFsmonitorNeutralized()` conventions as `mergeCommit()`.
 *
 * FR-299: always rebases current HEAD onto `newBaseSha` — no target-branch parameter, matching
 * `cherryPick()`'s/`mergeCommit()`'s "always HEAD, no picker" precedent. Getting HEAD onto the
 * intended commit first is the UI layer's job (FR-309); this function adds no checkout logic.
 *
 * A no-op fast-forward, a real replay, and a paused conflict are all indistinguishable in this
 * call's own return value — the caller discovers which one happened by re-reading
 * `RepositoryState`/`RebaseOperationDetail` afterward, never out of band from this call.
 */
export async function rebaseCommitOnto(workdir: string, newBaseSha: string): Promise<void> {
  await assertNoOperationInProgress(workdir);

  await runGit(
    withFsmonitorNeutralized(["rebase", ...withEndOfOptions([newBaseSha])]),
    { cwd: workdir, mutatesRepository: true },
  );
}
