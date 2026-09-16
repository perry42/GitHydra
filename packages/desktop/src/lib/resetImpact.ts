// SPDX-License-Identifier: GPL-3.0-or-later
import type { CommitPairRelationship } from "@githydra/git-core";

/**
 * `computeCommitPairRelationship()`'s four real outcomes, plus one more this feature's own dialog
 * short-circuits before ever calling it: the target commit is exactly the current `HEAD` commit.
 * `computeCommitPairRelationship()` itself throws on two identical SHAs (`commitPairs.ts`'s own
 * `shaA === shaB` guard) — this case is detected by the caller instead, never by forcing that call.
 */
export type ResetImpactRelationship = CommitPairRelationship | "same";

export interface ResetImpact {
  text: string;
  /** FR-368: the no-common-ancestor variant renders with the `critical` token — the same emphasis
   * used for the system's most severe warnings elsewhere (DESIGN.md's status-token policy). */
  critical: boolean;
}

function pluralCommits(n: number): string {
  return `${n} commit${n === 1 ? "" : "s"}`;
}

/**
 * specs/reset-to-here.md FR-368: the dialog's one impact line, computed once when it opens from
 * FR-364's count (`null` when that read failed — every branch below degrades to non-numeric wording
 * rather than showing a broken/undefined count) and FR-365's ancestry classification.
 */
export function describeResetImpact(
  relationship: ResetImpactRelationship,
  count: number | null,
  branchLabel: string,
): ResetImpact {
  if (relationship === "same") {
    return { text: `No commits are being undone — ${branchLabel} is already here.`, critical: false };
  }

  if (relationship === "b-ancestor-of-a") {
    // Forward case: HEAD is an ancestor of the target — nothing is ever undone here, so the count
    // (always 0 in this direction, per `countCommitsExclusiveToHead`'s own doc comment) isn't shown.
    return {
      text: `No commits will be lost — ${branchLabel} moves forward, nothing is undone.`,
      critical: false,
    };
  }

  if (relationship === "a-ancestor-of-b") {
    const text =
      count === null
        ? `Some commits will no longer be on ${branchLabel}.`
        : `${pluralCommits(count)} will no longer be on ${branchLabel}.`;
    return { text, critical: false };
  }

  if (relationship === "diverged") {
    const tail =
      count === null
        ? `Some commits currently unique to ${branchLabel} will no longer be reachable from it.`
        : `${pluralCommits(count)} currently unique to ${branchLabel} will no longer be reachable from it.`;
    return { text: `${branchLabel} will move to a divergent commit. ${tail}`, critical: false };
  }

  // "no-common-ancestor"
  const tail =
    count === null
      ? `All of ${branchLabel}'s current commits will no longer be reachable from it.`
      : `All ${count} of ${branchLabel}'s current commit${count === 1 ? "" : "s"} will no longer be reachable from it.`;
  return { text: `This commit shares no history with ${branchLabel}. ${tail}`, critical: true };
}

/**
 * specs/reset-to-here.md FR-369: the live "uncommitted changes" danger callout's counts line,
 * naming exactly which non-empty categories contribute (staged/unstaged/conflicted — conflicted
 * files can exist with no in-progress operation at all, e.g. left over from a stash-apply conflict,
 * per `specs/stash.md`'s own "no operation banner" conflict chrome, so this is checked even though
 * FR-366 already gates the ordinary merge/rebase/etc. in-progress case out of the entry point
 * entirely). Returns `null` when every category is empty — the callout itself is never shown then
 * (FR-369: never appears for a clean working tree).
 */
export function describeResetHardDangerCounts(staged: number, unstaged: number, conflicted: number): string | null {
  const parts: string[] = [];
  if (staged > 0) parts.push(`${staged} staged`);
  if (unstaged > 0) parts.push(`${unstaged} unstaged`);
  if (conflicted > 0) parts.push(`${conflicted} conflicted`);
  if (parts.length === 0) return null;

  const total = staged + unstaged + conflicted;
  const joined =
    parts.length === 1
      ? parts[0]
      : parts.length === 2
        ? `${parts[0]} and ${parts[1]}`
        : `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
  return `${joined} change${total === 1 ? "" : "s"} will be permanently discarded.`;
}
