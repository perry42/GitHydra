// SPDX-License-Identifier: GPL-3.0-or-later
import type { WorkingDirectoryStatus } from "../../shared/ipcContract";

/**
 * specs/stash.md FR-100: the "New Stash…" action (both entry points — StashPanel's header and
 * ChangesPanel's secondary button) is disabled with a stated reason rather than ever submitting a
 * call that would produce an empty stash or a crash.
 *
 * git-core-engineer's discovery while building `createStash()` (see specs/stash.md's task
 * hand-off notes): `git stash push` refuses ("<path>: needs merge") the instant a single unmerged
 * index entry exists ANYWHERE in the repository, regardless of whether that path is even part of
 * the requested pathspec — so this check disables create on ANY conflict repo-wide
 * (`workingDirStatus.conflicted > 0`), not just "every changed path happens to be conflicted".
 *
 * Returns `null` when create is eligible; otherwise the exact `title`/message reason to show.
 */
export function computeCreateStashDisabledReason(options: {
  isBare: boolean;
  isUnbornHead: boolean;
  workingDirStatus: WorkingDirectoryStatus | null;
}): string | null {
  const { isBare, isUnbornHead, workingDirStatus } = options;
  if (isBare) {
    return "This is a bare repository — it has no working directory, so there is nothing to stash.";
  }
  if (isUnbornHead) {
    return "This repository has no commits yet, so there is nothing to stash against.";
  }
  if (!workingDirStatus) {
    // Working-directory status hasn't loaded yet — treat as not-yet-eligible rather than allowing
    // a submit against unknown state.
    return "Working-directory status is still loading.";
  }
  if (workingDirStatus.conflicted > 0) {
    return "Cannot create a stash while there are unresolved conflicts.";
  }
  if (workingDirStatus.staged + workingDirStatus.unstaged + workingDirStatus.untracked === 0) {
    return "There are no changes to stash.";
  }
  return null;
}
