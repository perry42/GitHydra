// SPDX-License-Identifier: GPL-3.0-or-later
import type { RepositoryState } from "@githydra/git-core";

/**
 * specs/online-sync-push.md FR-349: Push's disabled-with-reason state for the Toolbar button and
 * Command Palette entry, mirroring `pullEligibility.ts`'s `computePullDisabledReason` convention
 * (same precedent that spec itself points at) — checked entirely client-side, since `push()` in
 * git-core deliberately does NOT gate on bare/detached/unborn/in-progress (its own doc comment:
 * "FR-349's bare-repo/detached-HEAD/unborn-HEAD/operation-in-progress disabled-with-reason gating
 * is the UI layer's job").
 *
 * `remotes` is `"loading"` for the brief window before `listConfiguredRemotes()` has resolved —
 * treated the same permissive-while-pending way `computePullDisabledReason`'s own `hasUpstream ===
 * "loading"` case is: Push is disabled with a "still checking" reason rather than either wrongly
 * enabled (a click during that window has no remote to push to yet) or wrongly shown as "no
 * remotes" before that's actually confirmed. An empty (settled) remotes list is a genuine, distinct
 * reason: there is nowhere for `push()` to send anything.
 */
export function computePushDisabledReason(
  repoState: RepositoryState | null,
  remotes: readonly string[] | "loading",
  busy: boolean,
): string | null {
  if (busy) return "A push is already running.";
  if (!repoState) return "Repository state is still loading.";
  if (repoState.isBare) return "This is a bare repository — there is no checked-out branch to push.";
  if (repoState.inProgressOperation) {
    return `Push is disabled while a ${repoState.inProgressOperation} is already in progress.`;
  }
  if (repoState.isUnbornHead) {
    return "This repository has no commits yet, so there is nothing to push.";
  }
  if (repoState.isDetachedHead || repoState.currentBranch === null) {
    return "Push isn't available in a detached HEAD — there is no current branch to push.";
  }
  if (remotes === "loading") return "Checking configured remotes…";
  if (remotes.length === 0) return "This repository has no remotes configured — add one before pushing.";
  return null;
}
