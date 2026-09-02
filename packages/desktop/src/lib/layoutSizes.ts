/**
 * specs/layout-and-view-polish.md Must-have C13: the min/max/default values for all five
 * resizable surfaces, in one place so ChangesPanel/DetailPanel/BranchesPanel don't each redefine
 * (and risk drifting on) the same numbers the spec names explicitly.
 */

export const CHANGES_PANEL_MIN_WIDTH = 420;
export const CHANGES_PANEL_DEFAULT_WIDTH = 680;

export const DETAIL_PANEL_MIN_WIDTH = 420;
// test-agent regression fix: was 680 (matching ChangesPanel/StashPanel/BlamePanel's default) —
// dropped to 560 specifically for DetailPanel because it's the one right panel that renders
// concurrently with the commit graph's own per-row content (sha/subject/author/date) behind it,
// not just a file list. At 1400x900 (this app's own default window size, main.ts's
// `createWindow()`) with BranchesPanel also at its default width, 680 left the center commit-list
// column too narrow to show a legible commit subject once the branch/tag gutter column
// (graphGeometry.ts's `REF_GUTTER_WIDTH`) and the graph's own lane art claimed their share — a
// real screenshot showed the subject column with ~0 visible characters, not just "tight." Still
// comfortably above `DETAIL_PANEL_MIN_WIDTH` (420) — more headroom above min than ChangesPanel's
// unchanged 680-vs-420 ratio loses. ChangesPanel/StashPanel/BlamePanel are left at 680 (unchanged,
// per specs/layout-and-view-polish.md Must-have C13 / specs/stash.md FR-94 / specs/blame.md
// FR-132) — they were not the reported regression's scenario and changing them is a materially
// bigger scope call than this branch's own bug fix; flagged to product-manager as a possible
// follow-up rather than done unilaterally here.
export const DETAIL_PANEL_DEFAULT_WIDTH = 560;

export const BRANCHES_PANEL_MIN_WIDTH = 280;
// test-agent regression fix: was 420 — same reasoning as DETAIL_PANEL_DEFAULT_WIDTH above, this
// panel is the other side of the same squeeze (it's the persistent sidebar rendered alongside the
// graph on every screen, not gated on a toggle). 340 is still 60px above BRANCHES_PANEL_MIN_WIDTH
// (280) and was re-verified against BranchesPanel.css's own content (branch/tag rows already
// ellipsize their names and wrap their action buttons) via a real Electron screenshot, not just
// computed on paper.
export const BRANCHES_PANEL_DEFAULT_WIDTH = 340;

export const CHANGES_FILE_LIST_MIN_WIDTH = 160;
export const CHANGES_FILE_LIST_DEFAULT_WIDTH = 300;

export const DETAIL_FILE_LIST_MIN_WIDTH = 160;
export const DETAIL_FILE_LIST_DEFAULT_WIDTH = 260;

// specs/stash.md FR-94: same 680px/80vw-capped default width as ChangesPanel/DetailPanel (not
// BranchesPanel's narrower single-list treatment) — StashPanel needs the same file-list+diff
// split those two use.
export const STASH_PANEL_MIN_WIDTH = 420;
export const STASH_PANEL_DEFAULT_WIDTH = 680;
export const STASH_LIST_MIN_WIDTH = 220;
export const STASH_LIST_DEFAULT_WIDTH = 320;

// specs/blame.md FR-132: same 680px/80vw-capped default width as ChangesPanel/DetailPanel/
// StashPanel (not BranchesPanel's narrower single-list treatment) — blame content is line-by-line
// file content, same "needs breathing room" reasoning a diff does. Single-width only (no inner
// divider): unlike those three panels, blame has no second per-item list column to split against
// — FR-133's file history is a collapsible region within the one column, not a side-by-side split.
export const BLAME_PANEL_MIN_WIDTH = 420;
export const BLAME_PANEL_DEFAULT_WIDTH = 680;

/** The existing `80vw` cap (unchanged from the shipped, non-resizable panels) — computed live so
 * it always reflects the current window size (Must-have C19), not a stale snapshot. */
export function eightyVw(): number {
  if (typeof window === "undefined") return 1000;
  return window.innerWidth * 0.8;
}
