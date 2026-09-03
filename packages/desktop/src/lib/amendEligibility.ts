import type { InProgressOperation } from "@githydra/git-core";

/**
 * specs/amend-last-commit.md FR-155: the commit composer's "Amend last commit" checkbox is
 * disabled, with an explanatory tooltip, on exactly the two conditions git-core's `amendCommit()`
 * itself refuses up front (FR-149/FR-151: unborn HEAD, or a merge/rebase/cherry-pick/revert/am/
 * bisect already in progress) — surfacing that guard client-side before a git call is ever
 * attempted, not just relying on the error round-trip. Mirrors `computeCreateStashDisabledReason`'s
 * shape (`stashEligibility.ts`) for the same reason: one small pure function, one disabled-reason
 * string, reused for both the checkbox's `disabled` and its `title`.
 *
 * Returns `null` when the checkbox is eligible; otherwise the exact `title`/message reason to show.
 */
export function computeAmendDisabledReason(options: {
  isUnbornHead: boolean;
  inProgressOperation: InProgressOperation;
}): string | null {
  const { isUnbornHead, inProgressOperation } = options;
  if (isUnbornHead) {
    return "This repository has no commits yet, so there is nothing to amend.";
  }
  if (inProgressOperation) {
    return `Cannot amend while a ${inProgressOperation} is already in progress. Resolve or abort it first.`;
  }
  return null;
}
