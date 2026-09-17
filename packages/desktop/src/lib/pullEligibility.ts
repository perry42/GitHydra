// SPDX-License-Identifier: GPL-3.0-or-later
import type { RepositoryState } from "@githydra/git-core";

/**
 * specs/online-sync-pull.md FR-343: Pull's disabled-with-reason state for the Toolbar button,
 * mirroring `lib/dragCommitMenu.ts`'s `computeMergeOrRebaseDisabledReason`/
 * `lib/resetEligibility.ts`'s `computeResetDisabledReason` convention — checked client-side so
 * this can never disagree with `pull()`'s own server-side refusal (`NoUpstreamConfiguredError`/
 * `OperationAlreadyInProgressError`).
 *
 * Two of FR-343's four listed reasons (no configured upstream, an operation already in progress)
 * are also enforced inside git-core's own `pull()`; the other two (a bare repository, an unborn
 * `HEAD`) are deliberately NOT — git-core's own doc comment for `Repository.pull()` explains why
 * (a bare repo has no working directory at all, matching every other working-tree-touching method
 * on that class; an unborn `HEAD` would actually fast-forward cleanly, but disabling it here is a
 * product judgment call, not a git-core limitation — see this function's own module-level FR-343
 * reference). Both are still gated here, client-side only, per that same doc comment's explicit
 * "FR-343 lists it as a UI-layer disabled-with-reason affordance" instruction.
 *
 * `hasUpstream` is `"loading"` for the brief window before the current branch's own
 * `LocalBranchInfo.upstreamName` has been read (see `useCurrentBranchUpstream.ts`) — treated the
 * same permissive-while-pending way `computeMergeOrRebaseDisabledReason`'s own `"computing"`
 * ancestry state is: Pull is disabled with a "still loading" reason rather than either wrongly
 * enabled (a Pull click during that window could race `pull()`'s own upstream check) or wrongly
 * shown as "no upstream" before that's actually confirmed.
 */
export function computePullDisabledReason(
  repoState: RepositoryState | null,
  hasUpstream: boolean | "loading",
  busy: boolean,
): string | null {
  if (busy) return "A pull is already running.";
  if (!repoState) return "Repository state is still loading.";
  if (repoState.isBare) return "This is a bare repository — it has no working directory to pull into.";
  if (repoState.inProgressOperation) {
    return `Pull is disabled while a ${repoState.inProgressOperation} is already in progress.`;
  }
  if (repoState.isUnbornHead) {
    return "This repository has no commits yet, so there is nothing to pull into.";
  }
  if (repoState.isDetachedHead || repoState.currentBranch === null) {
    return "Pull isn't available in a detached HEAD — there is no current branch to pull into.";
  }
  if (hasUpstream === "loading") return "Checking this branch's upstream configuration…";
  if (!hasUpstream) return "This branch has no upstream configured — set one before pulling.";
  return null;
}
