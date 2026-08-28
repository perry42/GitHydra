/**
 * specs/layout-and-view-polish.md Must-have C13: the min/max/default values for all five
 * resizable surfaces, in one place so ChangesPanel/DetailPanel/BranchesPanel don't each redefine
 * (and risk drifting on) the same numbers the spec names explicitly.
 */

export const CHANGES_PANEL_MIN_WIDTH = 420;
export const CHANGES_PANEL_DEFAULT_WIDTH = 680;

export const DETAIL_PANEL_MIN_WIDTH = 420;
export const DETAIL_PANEL_DEFAULT_WIDTH = 680;

export const BRANCHES_PANEL_MIN_WIDTH = 280;
export const BRANCHES_PANEL_DEFAULT_WIDTH = 420;

export const CHANGES_FILE_LIST_MIN_WIDTH = 160;
export const CHANGES_FILE_LIST_DEFAULT_WIDTH = 300;

export const DETAIL_FILE_LIST_MIN_WIDTH = 160;
export const DETAIL_FILE_LIST_DEFAULT_WIDTH = 260;

/** The existing `80vw` cap (unchanged from the shipped, non-resizable panels) — computed live so
 * it always reflects the current window size (Must-have C19), not a stale snapshot. */
export function eightyVw(): number {
  if (typeof window === "undefined") return 1000;
  return window.innerWidth * 0.8;
}
