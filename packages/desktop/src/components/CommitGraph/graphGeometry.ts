export const ROW_HEIGHT = 28;
export const LANE_WIDTH = 18;
export const GRAPH_LEFT_PADDING = 14;
export const NODE_RADIUS = 4;
export const MERGE_NODE_RADIUS = 6;
export const OCTOPUS_NODE_RADIUS = 7.5;
export const LANE_STROKE_WIDTH = 2;

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
