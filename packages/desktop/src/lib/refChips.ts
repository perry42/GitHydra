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
  /**
   * specs/ref-chip-synced-upstream-merge.md FR-3: set on a `local-branch` chip whose branch is
   * EXACTLY synced (ahead===0 && behind===0) with a real upstream, when that upstream's own
   * remote-branch decoration is ALSO on this same commit — the two decorations merge into this one
   * `RefChipSpec` rather than each producing their own chip. `null` for every other chip (including
   * a synced local branch whose upstream decoration doesn't happen to be on this exact commit).
   */
  syncedRemote: RefDecoration | null;
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
  /** specs/ref-chip-synced-upstream-merge.md FR-1/FR-3: local branch name -> its upstream's short
   * name (e.g. "origin/main"), for branches EXACTLY synced with a real, non-gone upstream — see
   * `RefChipSpec.syncedRemote`. Omitted (default: none synced) for every pre-existing caller,
   * unchanged behavior. */
  syncedUpstreamByBranch: ReadonlyMap<string, string> = new Map(),
): RefChipSpec[] {
  const isDetached = repoState?.isDetachedHead ?? false;
  const currentBranch = repoState?.currentBranch ?? null;
  const hasHeadHere = commit.refs.some((r) => r.type === "head");

  // FR-3: every remote-branch decoration this commit carries, so a local branch's own configured
  // upstream can be looked up by name (not just "any remote-branch decoration present") — a plain
  // Map since decoration names are already unique per commit (git itself never decorates the same
  // full ref twice).
  const remoteDecorationsByName = new Map(
    commit.refs.filter((r) => r.type === "remote-branch").map((r) => [r.name, r] as const),
  );
  // Every remote-branch decoration consumed by a merge below — excluded from its own separate
  // chip so the pair renders exactly once (FR-3).
  const consumedRemoteNames = new Set<string>();
  for (const decoration of commit.refs) {
    if (decoration.type !== "local-branch") continue;
    const upstreamName = syncedUpstreamByBranch.get(decoration.name);
    if (upstreamName == null) continue;
    const remoteDecoration = remoteDecorationsByName.get(upstreamName);
    // The remote decoration must independently pass the same visibility filter every other chip
    // does — merging must never SURFACE a remote-tracking ref that "show all branches & tags"
    // (or any other visibility rule) would otherwise keep hidden entirely.
    if (remoteDecoration && visibleRefNames.has(remoteDecoration.fullName ?? "HEAD")) {
      consumedRemoteNames.add(upstreamName);
    }
  }

  const chips: RefChipSpec[] = [];
  for (const decoration of commit.refs) {
    const key = decoration.fullName ?? "HEAD";
    if (!visibleRefNames.has(key)) continue;

    if (decoration.type === "head") {
      if (isDetached) chips.push({ decoration, filled: false, detached: true, diverged: false, syncedRemote: null });
      continue; // attached: implied by the filled branch chip below, not a separate chip.
    }
    // FR-3: a remote-branch decoration already consumed by a local branch's merge above renders
    // nothing of its own — its icon/name are carried by the merged local-branch chip instead.
    if (decoration.type === "remote-branch" && consumedRemoteNames.has(decoration.name)) continue;

    const filled =
      !isDetached && hasHeadHere && decoration.type === "local-branch" && decoration.name === currentBranch;
    const diverged = decoration.type === "local-branch" && divergedBranchNames.has(decoration.name);
    const upstreamName = decoration.type === "local-branch" ? syncedUpstreamByBranch.get(decoration.name) : undefined;
    // Only actually merge when that upstream decoration was independently confirmed visible above
    // (`consumedRemoteNames`) — never surface a filtered-out remote ref just because it happens to
    // be this branch's configured upstream.
    const syncedRemote =
      upstreamName != null && consumedRemoteNames.has(upstreamName)
        ? (remoteDecorationsByName.get(upstreamName) ?? null)
        : null;
    chips.push({ decoration, filled, detached: false, diverged, syncedRemote });
  }
  return chips;
}
