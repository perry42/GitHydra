// SPDX-License-Identifier: GPL-3.0-or-later
import type { CommitInfo, RefDecoration, RepositoryState } from "@githydra/git-core";

export interface RefChipSpec {
  decoration: RefDecoration;
  filled: boolean;
  detached: boolean;
  /** specs/online-sync-fetch.md FR-326: true for a local-branch chip whose branch has diverged
   * (ahead > 0 AND behind > 0) from its upstream as of the last fetch. Always `false` for
   * remote-branch/tag/HEAD chips. */
  diverged: boolean;
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
  /** specs/online-sync-fetch.md FR-326: local branch names currently diverged from their upstream
   * — see `RefChipSpec.diverged`. Omitted (default: none diverged) for every pre-existing caller,
   * unchanged behavior. */
  divergedBranchNames: ReadonlySet<string> = new Set(),
): RefChipSpec[] {
  const isDetached = repoState?.isDetachedHead ?? false;
  const currentBranch = repoState?.currentBranch ?? null;
  const hasHeadHere = commit.refs.some((r) => r.type === "head");

  const chips: RefChipSpec[] = [];
  for (const decoration of commit.refs) {
    const key = decoration.fullName ?? "HEAD";
    if (!visibleRefNames.has(key)) continue;

    if (decoration.type === "head") {
      if (isDetached) chips.push({ decoration, filled: false, detached: true, diverged: false });
      continue; // attached: implied by the filled branch chip below, not a separate chip.
    }

    const filled =
      !isDetached && hasHeadHere && decoration.type === "local-branch" && decoration.name === currentBranch;
    const diverged = decoration.type === "local-branch" && divergedBranchNames.has(decoration.name);
    chips.push({ decoration, filled, detached: false, diverged });
  }
  return chips;
}
