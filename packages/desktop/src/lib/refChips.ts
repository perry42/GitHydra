import type { CommitInfo, RefDecoration, RepositoryState } from "@githydra/git-core";

export interface RefChipSpec {
  decoration: RefDecoration;
  filled: boolean;
  detached: boolean;
}

/**
 * Decides which of a commit's ref decorations to render as chips, and how (FR-11, AC4): the
 * synthetic HEAD decoration collapses into the checked-out branch chip (filled) when attached, or
 * becomes its own distinctly-marked chip when detached — never both, and never silently identical
 * to a normal branch tip.
 */
export function buildRefChips(
  commit: Pick<CommitInfo, "refs">,
  visibleRefNames: ReadonlySet<string>,
  repoState: Pick<RepositoryState, "isDetachedHead" | "currentBranch"> | null,
): RefChipSpec[] {
  const isDetached = repoState?.isDetachedHead ?? false;
  const currentBranch = repoState?.currentBranch ?? null;
  const hasHeadHere = commit.refs.some((r) => r.type === "head");

  const chips: RefChipSpec[] = [];
  for (const decoration of commit.refs) {
    const key = decoration.fullName ?? "HEAD";
    if (!visibleRefNames.has(key)) continue;

    if (decoration.type === "head") {
      if (isDetached) chips.push({ decoration, filled: false, detached: true });
      continue; // attached: implied by the filled branch chip below, not a separate chip.
    }

    const filled =
      !isDetached && hasHeadHere && decoration.type === "local-branch" && decoration.name === currentBranch;
    chips.push({ decoration, filled, detached: false });
  }
  return chips;
}
