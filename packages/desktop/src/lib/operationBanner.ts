// SPDX-License-Identifier: GPL-3.0-or-later
import type { InProgressOperation, InProgressOperationDetail } from "@githydra/git-core";

/** A banner-copy fragment: `mono` renders in the shared monospace convention (DESIGN.md) for
 * SHAs/branch names, plain text otherwise — lets `StatusBanner` render real identifiers distinctly
 * from prose without inventing a second typography system. */
export interface OperationBannerSegment {
  text: string;
  mono?: boolean;
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** Best-effort short label for a side of an operation: prefer a resolvable ref name, fall back to
 * an abbreviated SHA, and only fall back to a generic placeholder when neither is known (a
 * defensively-corrupt `.git` state — see `RebaseOperationDetail`'s doc comment). */
function refOrSha(ref: string | null, sha: string | null, placeholder: string): OperationBannerSegment {
  if (ref) return { text: ref, mono: true };
  if (sha) return { text: shortSha(sha), mono: true };
  return { text: placeholder };
}

function stepSuffix(currentStep: number | null, totalSteps: number | null): OperationBannerSegment[] {
  if (currentStep == null || totalSteps == null) return [];
  return [{ text: ` — step ${currentStep} of ${totalSteps}` }];
}

/**
 * FR-58/FR-60/FR-61: rich, per-operation-type banner copy built from `InProgressOperationDetail`
 * — never the generic "Merge in progress"/"Rebase in progress" once real detail is available.
 * `currentBranch` (from `RepositoryState`, not the detail object) fills in a merge's "into
 * <branch>" clause, since `MergeOperationDetail` itself only carries the HEAD-at-conflict SHA/
 * subject, not the human branch name.
 */
export function describeInProgressOperation(
  detail: InProgressOperationDetail,
  currentBranch: string | null,
): OperationBannerSegment[] {
  if (!detail) return [];
  switch (detail.kind) {
    case "merge": {
      const incoming = refOrSha(detail.incomingRef, detail.mergeHeadSha, "an unresolved ref");
      const target = currentBranch
        ? ({ text: currentBranch, mono: true } as OperationBannerSegment)
        : refOrSha(null, detail.headSha, "the current branch");
      return [{ text: "Merging " }, incoming, { text: " into " }, target];
    }
    case "rebase": {
      const original = detail.originalBranch
        ? ({ text: detail.originalBranch, mono: true } as OperationBannerSegment)
        : { text: "a detached HEAD" };
      const onto = refOrSha(detail.ontoRef, detail.ontoSha, "an unresolved ref");
      return [
        { text: "Rebasing " },
        original,
        { text: " onto " },
        onto,
        ...stepSuffix(detail.currentStep, detail.totalSteps),
      ];
    }
    case "cherry-pick": {
      const target = refOrSha(null, detail.targetSha, "an unresolved commit");
      const segments: OperationBannerSegment[] = [{ text: "Cherry-picking " }, target];
      if (detail.targetSubject) segments.push({ text: ` "${detail.targetSubject}"` });
      // specs/cherry-pick.md FR-117/"A sharp edge worth stating plainly": a deliberately less
      // complete readout than rebase's "step N of M" — git's cherry-pick sequencer never persists
      // the originally-requested total, only what's left in `.git/sequencer/todo`. `null` (no
      // sequencer state — a single-commit pick, or nothing queued after this one) and `0` (this is
      // the last queued commit) both render no suffix at all, rather than a misleading "0 more".
      if (detail.remainingAfterCurrent != null && detail.remainingAfterCurrent > 0) {
        segments.push({
          text: ` (${detail.remainingAfterCurrent} more queued)`,
        });
      }
      return segments;
    }
    case "revert": {
      const target = refOrSha(null, detail.targetSha, "an unresolved commit");
      const segments: OperationBannerSegment[] = [{ text: "Reverting " }, target];
      if (detail.targetSubject) segments.push({ text: ` "${detail.targetSubject}"` });
      return segments;
    }
    case "am":
      return [{ text: "Applying patches (am)" }, ...stepSuffix(detail.currentStep, detail.totalSteps)];
    case "bisect":
      // Spec's explicit non-goal: bisect gets no rich detail this pass, only the generic label
      // StatusBanner already falls back to.
      return [];
    default:
      return [];
  }
}

/** Plain-text rendering of `describeInProgressOperation`'s segments — for `aria-label`/`title`
 * attributes that can't host structured JSX. */
export function describeInProgressOperationText(
  detail: InProgressOperationDetail,
  currentBranch: string | null,
): string {
  return describeInProgressOperation(detail, currentBranch)
    .map((s) => s.text)
    .join("");
}

/** A short noun phrase for each operation kind, for prose that names the operation without the
 * full `describeInProgressOperation` detail (e.g. the externally-detected operation-state alert
 * below, which intentionally has no fresh `InProgressOperationDetail` to draw from yet — that's
 * the whole point of not having silently applied it). */
const OPERATION_NOUN: Record<Exclude<InProgressOperation, null>, string> = {
  merge: "merge",
  rebase: "rebase",
  am: "patch application (am)",
  "cherry-pick": "cherry-pick",
  revert: "revert",
  bisect: "bisect",
};

/**
 * specs/graph-head-indicator-and-refresh-alerting.md Problem 2: copy for the distinct
 * operation-state alert banner — deliberately different from both the generic "History changed
 * outside GitHydra" ref-churn banner and the rich per-operation `describeInProgressOperation`
 * copy (which requires a fresh, already-applied `InProgressOperationDetail` this alert
 * deliberately hasn't fetched/applied yet).
 */
export function describeOperationStateAlert(operation: Exclude<InProgressOperation, null>): string {
  return `The in-progress ${OPERATION_NOUN[operation]} changed outside GitHydra — click Refresh before continuing.`;
}

export interface OperationHeadline {
  segments: OperationBannerSegment[];
  /** Rebase/am only: rendered as its own "Step N of M" chip rather than inline prose. */
  step: { current: number; total: number } | null;
  /** Lower-case noun for button copy: "Continue merge". */
  noun: string;
}

/**
 * specs/mid-merge-landing.md FR-577: the conflict banner's bold headline — "Merge in progress: feature into main" — from the
 * same detail `describeInProgressOperation` reads. Falls back to the generic label when there is no detail yet.
 */
export function describeOperationHeadline(
  operation: Exclude<InProgressOperation, null>,
  detail: InProgressOperationDetail,
  currentBranch: string | null,
): OperationHeadline {
  const noun = OPERATION_NOUN[operation];
  const label = `${noun.charAt(0).toUpperCase()}${noun.slice(1)} in progress`;
  const fallback: OperationHeadline = { segments: [{ text: label }], step: null, noun };
  if (!detail) return fallback;
  switch (detail.kind) {
    case "merge": {
      const incoming = refOrSha(detail.incomingRef, detail.mergeHeadSha, "an unresolved ref");
      const target = currentBranch
        ? ({ text: currentBranch, mono: true } as OperationBannerSegment)
        : refOrSha(null, detail.headSha, "the current branch");
      return { segments: [{ text: `${label}: ` }, incoming, { text: " into " }, target], step: null, noun };
    }
    case "rebase": {
      const original = detail.originalBranch
        ? ({ text: detail.originalBranch, mono: true } as OperationBannerSegment)
        : { text: "a detached HEAD" };
      const onto = refOrSha(detail.ontoRef, detail.ontoSha, "an unresolved ref");
      const step =
        detail.currentStep != null && detail.totalSteps != null
          ? { current: detail.currentStep, total: detail.totalSteps }
          : null;
      return { segments: [{ text: `${label}: ` }, original, { text: " onto " }, onto], step, noun };
    }
    case "cherry-pick": {
      const segments: OperationBannerSegment[] = [
        { text: `${label}: ` },
        refOrSha(null, detail.targetSha, "an unresolved commit"),
      ];
      if (detail.targetSubject) segments.push({ text: ` "${detail.targetSubject}"` });
      if (detail.remainingAfterCurrent != null && detail.remainingAfterCurrent > 0) {
        segments.push({ text: ` (${detail.remainingAfterCurrent} more queued)` });
      }
      return { segments, step: null, noun };
    }
    default:
      return fallback;
  }
}

/** Plain-text headline, for title/aria strings. */
export function describeOperationHeadlineText(
  operation: Exclude<InProgressOperation, null>,
  detail: InProgressOperationDetail,
  currentBranch: string | null,
): string {
  const h = describeOperationHeadline(operation, detail, currentBranch);
  return h.segments.map((s) => s.text).join("") + (h.step ? ` (step ${h.step.current} of ${h.step.total})` : "");
}

/** Short capitalised label: "Merge in progress", "Cherry-pick in progress". */
export function operationProgressLabel(operation: Exclude<InProgressOperation, null>): string {
  const noun = OPERATION_NOUN[operation];
  return `${noun.charAt(0).toUpperCase()}${noun.slice(1)} in progress`;
}
