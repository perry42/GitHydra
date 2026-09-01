import type { CommitInfo, RepositoryState } from "@githydra/git-core";

/**
 * specs/cherry-pick.md FR-115: computes the exact disabled-with-reason state for the context
 * menu's Cherry-pick action (single or multi-commit) — checked client-side, mirroring
 * `cherryPick()`'s own server-side pre-flight refusal (FR-103), so the menu item's disabled state
 * and the underlying refusal never disagree (AC3).
 *
 * Returns `null` when cherry-pick is eligible; otherwise the exact `title`/disabled reason to show.
 * `busy` (a cherry-pick/skip/commit-empty call from THIS session already in flight) is checked
 * first since it's the most immediate/transient reason and doesn't require inspecting the
 * selection at all.
 */
export function computeCherryPickDisabledReason(
  repoState: RepositoryState | null,
  selectedCommits: readonly Pick<CommitInfo, "parents">[],
  busy: boolean,
): string | null {
  if (busy) {
    return "A cherry-pick is already running.";
  }
  if (!repoState) {
    return "Repository state is still loading.";
  }
  if (repoState.inProgressOperation) {
    return "Cherry-pick is disabled while another operation is already in progress.";
  }
  if (repoState.isBare) {
    return "This is a bare repository — it has no working directory to cherry-pick onto.";
  }
  if (repoState.isUnbornHead) {
    return "This repository has no commits yet, so there is nothing to cherry-pick onto.";
  }
  // Non-goal (specs/cherry-pick.md): cherry-picking a merge commit requires a mainline-selection
  // UI this spec doesn't build — disable the WHOLE selection rather than silently dropping the
  // merge commit from it (FR-115: "the cherry-picked commits are always exactly what the user
  // selected, never a silently-narrowed subset").
  if (selectedCommits.some((c) => c.parents.length >= 2)) {
    return "Cherry-picking a merge commit isn't supported yet — deselect it to cherry-pick the rest.";
  }
  return null;
}
