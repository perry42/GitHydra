// SPDX-License-Identifier: GPL-3.0-or-later
import type { CommitInfo } from "@githydra/git-core";

/** One lane touching a given row — used by the renderer to draw the vertical/curved segments. */
export interface LaneRowSegment {
  lane: number;
  colorSlot: number;
  /** Was this lane already active immediately above this row (draw a top half-segment)? */
  above: boolean;
  /** Is this lane still active immediately below this row (draw a bottom half-segment)? */
  below: boolean;
}

export interface LaidOutRow {
  commit: CommitInfo;
  /** This commit's own lane (where its node is drawn). */
  lane: number;
  colorSlot: number;
  isMerge: boolean;
  isOctopus: boolean;
  /** True root: zero parents and not a shallow/graft history boundary. */
  isRoot: boolean;
  /** Every lane whose line passes through this row's vertical span, primary lane included. */
  lanes: LaneRowSegment[];
}

const PALETTE_SIZE = 8;

interface LaneSlot {
  /** The commit sha this lane is waiting to reach as it walks down through history. */
  expectedSha: string;
  colorSlot: number;
}

/**
 * Incremental lane assigner: standard topological git-graph layout (as used by `git log --graph`,
 * gitk, and every GitKraken-style client), fed one commit at a time in the topo-ordered stream
 * `CommitLogReader` already produces (`git log --topo-order`, so a commit is always emitted
 * before its parents — see commitLog.ts). Kept as an incremental class (not a pure
 * recompute-from-scratch function) so paging in more commits as the user scrolls a 100k+ commit
 * history is O(new commits), never O(total loaded so far) — see FR-3/FR-12.
 *
 * Algorithm sketch:
 * - Each active lane "expects" a specific sha next (the sha it'll land on further down).
 * - A commit occupies whichever lane(s) expect its sha (a commit can be expected by more than
 *   one lane at once — that's a merge/convergence, drawn as multiple incoming lines curving into
 *   one node). If none do, it's a fresh branch tip / root / orphan root: allocate a new lane.
 * - The first parent continues in the SAME lane (mainline). Additional parents (merge commits)
 *   either continue an already-tracked lane (if some other lane already expects that parent — the
 *   merged-in branch was already visible) or spawn a new lane.
 * - Lane slots freed during a row (by convergence, or a root/history-boundary lane ending) are
 *   only reused starting the NEXT row — never within the same row a different lane is still being
 *   drawn through that column, which would make one canvas column silently represent two
 *   unrelated logical lanes in the same row.
 */
export class LaneAssigner {
  private activeLanes: Array<LaneSlot | null> = [];

  next(commit: CommitInfo): LaidOutRow {
    const before = this.activeLanes.slice();

    // 1. Every lane currently expecting this commit's sha converges here.
    const convergingLanes: number[] = [];
    for (let i = 0; i < before.length; i++) {
      if (before[i]?.expectedSha === commit.sha) convergingLanes.push(i);
    }

    let primaryLane: number;
    if (convergingLanes.length > 0) {
      primaryLane = Math.min(...convergingLanes);
    } else {
      primaryLane = this.allocateLane(before);
    }
    const colorSlot = primaryLane % PALETTE_SIZE;

    // 2. Non-primary converging lanes terminate at this row (their line curves into primaryLane).
    for (const laneIdx of convergingLanes) {
      if (laneIdx !== primaryLane) this.activeLanes[laneIdx] = null;
    }

    const isRoot = commit.parents.length === 0 && !commit.isHistoryBoundary;
    const isMerge = commit.parents.length >= 2;
    const isOctopus = commit.parents.length >= 3;

    // 3. Extend/spawn lanes for this commit's parents (unless history ends here).
    if (commit.parents.length === 0 || commit.isHistoryBoundary) {
      this.activeLanes[primaryLane] = null;
    } else {
      this.activeLanes[primaryLane] = { expectedSha: commit.parents[0]!, colorSlot };
      for (let p = 1; p < commit.parents.length; p++) {
        const parentSha = commit.parents[p]!;
        const alreadyTracked = this.activeLanes.some(
          (slot, idx) => idx !== primaryLane && slot?.expectedSha === parentSha,
        );
        if (!alreadyTracked) {
          const newLane = this.allocateLane(before);
          this.activeLanes[newLane] = { expectedSha: parentSha, colorSlot: newLane % PALETTE_SIZE };
        }
      }
    }

    const after = this.activeLanes.slice();
    const maxLen = Math.max(before.length, after.length);
    const lanes: LaneRowSegment[] = [];
    for (let i = 0; i < maxLen; i++) {
      const above = before[i] != null;
      const below = after[i] != null;
      if (!above && !below && i !== primaryLane) continue;
      lanes.push({
        lane: i,
        colorSlot: i === primaryLane ? colorSlot : (before[i] ?? after[i])!.colorSlot,
        above,
        below,
      });
    }

    return { commit, lane: primaryLane, colorSlot, isMerge, isOctopus, isRoot, lanes };
  }

  /** First lane index that was free in `before` (never one freed earlier in this same row); else grow. */
  private allocateLane(before: Array<LaneSlot | null>): number {
    for (let i = 0; i < before.length; i++) {
      if (before[i] == null) return i;
    }
    return this.activeLanes.length;
  }

  /** Highest lane index ever used so far — drives the renderer's canvas width. */
  get maxLaneIndexSeen(): number {
    return Math.max(0, this.activeLanes.length - 1);
  }
}

/** Convenience wrapper for tests / small fixtures — lays out a whole array in one call. */
export function assignLanes(commits: CommitInfo[]): LaidOutRow[] {
  const assigner = new LaneAssigner();
  return commits.map((c) => assigner.next(c));
}

/** Palette slot -> CSS custom property, per DESIGN.md's fixed branch-lane token order (1-indexed). */
export function laneColorVar(colorSlot: number): string {
  const slot = ((colorSlot % PALETTE_SIZE) + PALETTE_SIZE) % PALETTE_SIZE;
  return `var(--gh-lane-${slot + 1})`;
}
