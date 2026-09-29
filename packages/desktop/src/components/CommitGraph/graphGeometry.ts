// SPDX-License-Identifier: GPL-3.0-or-later
export const ROW_HEIGHT = 28;
export const LANE_WIDTH = 18;
export const GRAPH_LEFT_PADDING = 14;
export const NODE_RADIUS = 4;
export const MERGE_NODE_RADIUS = 6;
export const OCTOPUS_NODE_RADIUS = 7.5;
export const LANE_STROKE_WIDTH = 2;

/**
 * DESIGN.md "Ref chip" (gutter revision): width of the persistent branch/tag/HEAD gutter column
 * that sits *before* the graph's own lane art, present on every row (real space, not a
 * placeholder element, even when a row has no ref). Consumed by both `GraphCanvas` (the lane
 * art's `left` offset) and `CommitRow` (the sha/subject content's `paddingLeft`, added on top of
 * `graphWidth()`) — the same two-consumer pattern `graphWidth()` itself already established,
 * extended rather than duplicated.
 *
 * test-agent regression (post-shipping-the-gutter, real Electron + DOM measurement, not a
 * jsdom-invisible edge case): this used to be 160px — the single-chip `max-width` a *lone* ref
 * name gets before ellipsizing. Reserving that unconditionally on every row, even rows with zero
 * or one short chip, on top of `graphWidth()` for any repo with more than 1-2 concurrent lanes,
 * left the commit message (the one thing this product exists to show) with no room at the app's
 * own documented default window size (1400x900) with the Branches sidebar and a right panel both
 * at their spec'd default widths — measured `padding-left` of 264px against a ~276px-wide row.
 * 100px keeps the gutter reading as a real, aligned column (RefChip's `title`/`aria-label` still
 * carry the full ref name for anything ellipsis clips — truncation was never the accessibility
 * story here) while cutting the worst-case unconditional reservation by 60px. This alone doesn't
 * fully close the gap on a branch-heavy repo's high-lane-count rows — see CommitGraph.css's
 * container-query author/date degradation and layoutSizes.ts's default-width note for the rest.
 *
 * specs/ref-chip-gutter-redesign.md (FR-414): widened again, this time to 148px — the real
 * arithmetic ceiling, not an arbitrary bigger number. A fresh dual-agent UX critique, validated
 * against this repo's own real branch names (`fix/context-menu-viewport-clamp`,
 * `docs/keyboard-shortcuts-specs`, etc.), found that even a single, non-collapsed chip — the
 * common post-collapse case FR-408-411 already produces, not a rare edge case — truncated to
 * ~10-12 visible characters at 100px, and the cut landed *inside* the `fix/`/`docs/`/`feat/` type
 * prefix every time, before the part of the name that actually distinguishes it from its siblings
 * (this project's own `type/scope` branch naming convention makes that the common case, not an
 * outlier). `layoutBudget.test.ts`'s own pinned arithmetic
 * (`availableForSubject = 298 - REF_GUTTER_WIDTH`, at the app's default window size/panel widths/a
 * realistic busy-row lane count) must stay `>= 150` (`SUBJECT_LEGIBLE_MIN_WIDTH`) — solving that
 * inequality gives 148px as the exact ceiling (`298 - 148 = 150`, the floor exactly). This is the
 * same 48px of headroom the 100px revision above already identified and declined to spend
 * (`100 + 48 = 148`) — the arithmetic didn't change, only the evidence for why spending it is worth
 * the real-name truncation cost.
 */
export const REF_GUTTER_WIDTH = 148;

/** Past this many concurrent on-screen lanes, additional lanes collapse into one shared overflow
 * column rather than growing canvas width unboundedly (edge case: "merge-heavy / high
 * branch-count repos" in specs/commit-graph.md). A future iteration could offer an explicit
 * "collapse merged branches into their merge commit" control; this bound is the v1 mitigation. */
export const MAX_VISIBLE_LANES = 12;

export function displayLane(lane: number): number {
  return Math.min(lane, MAX_VISIBLE_LANES);
}

export function laneX(lane: number): number {
  return GRAPH_LEFT_PADDING + displayLane(lane) * LANE_WIDTH;
}

export function graphWidth(maxLaneSeen: number): number {
  return laneX(maxLaneSeen) + LANE_WIDTH;
}
