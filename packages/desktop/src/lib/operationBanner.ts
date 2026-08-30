import type { InProgressOperationDetail } from "@githydra/git-core";

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
