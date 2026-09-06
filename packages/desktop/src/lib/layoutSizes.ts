// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * specs/layout-and-view-polish.md Must-have C13: the min/max/default values for all five
 * resizable surfaces, in one place so ChangesPanel/DetailPanel/BranchesPanel don't each redefine
 * (and risk drifting on) the same numbers the spec names explicitly.
 */

// Layout-persistence fix (confirmed directly with the user): ChangesPanel, StashPanel,
// DetailPanel, and BlamePanel all render into the exact same visual slot in App.tsx and are
// mutually exclusive — `rightPanel` is a single enum value, and BlamePanel's own render gate
// (`!blameTarget && rightPanel === "..."` guards the other three) means at most ONE of these four
// components is ever mounted at a time. They used to each own a DIFFERENT localStorage key (and,
// since the gutter-crush fix below, different defaults: ChangesPanel/StashPanel/BlamePanel at
// 680, DetailPanel at 560), so resizing one and switching to another produced a visible, jarring
// width jump. They now all share exactly ONE persisted width/min/max — `RIGHT_PANEL_*` below —
// passed to the same `storageKey` from all four call sites. This is safe as four independent
// `useResizableWidth` instances (rather than needing state lifted to App.tsx) specifically
// *because* of that mutual exclusivity: only one of the four ever has a mounted instance reading
// or writing the key at a given moment, so there's no concurrent-write race, and a freshly-mounted
// panel's `useState` initializer reads the just-persisted value synchronously at mount time — the
// same behavior a lifted/controlled prop would give, without the extra indirection.
export const RIGHT_PANEL_STORAGE_KEY = "githydra:layout:rightPanelWidth";
// Most restrictive of the four panels' old individual minimums — they were already all 420, so no
// reconciliation was actually needed here.
export const RIGHT_PANEL_MIN_WIDTH = 420;
// test-agent regression fix (gutter-crush bug): was 680 (ChangesPanel/StashPanel/BlamePanel's old
// default) for three of the four panels, already 560 for DetailPanel. 560 is the one that's
// already proven safe — DetailPanel is the one right panel that renders concurrently with the
// commit graph's own per-row content (sha/subject/author/date) behind it, not just a file list. At
// 1400x900 (this app's own default window size, main.ts's `createWindow()`) with BranchesPanel
// also at its default width, 680 left the center commit-list column too narrow to show a legible
// commit subject once the branch/tag gutter column (graphGeometry.ts's `REF_GUTTER_WIDTH`) and the
// graph's own lane art claimed their share — a real screenshot showed the subject column with ~0
// visible characters, not just "tight." Still comfortably above `RIGHT_PANEL_MIN_WIDTH` (420).
// `layoutBudget.test.ts` pins this exact arithmetic — it must keep passing unmodified.
export const RIGHT_PANEL_DEFAULT_WIDTH = 560;

// Kept as aliases (not fresh literals) so nothing can silently drift the four panels' width back
// out of sync with each other again — every one of the four below is now the same value.
export const CHANGES_PANEL_MIN_WIDTH = RIGHT_PANEL_MIN_WIDTH;
export const CHANGES_PANEL_DEFAULT_WIDTH = RIGHT_PANEL_DEFAULT_WIDTH;

export const DETAIL_PANEL_MIN_WIDTH = RIGHT_PANEL_MIN_WIDTH;
export const DETAIL_PANEL_DEFAULT_WIDTH = RIGHT_PANEL_DEFAULT_WIDTH;

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

// specs/stash.md FR-94: same shared right-panel-slot width as ChangesPanel/DetailPanel/BlamePanel
// (not BranchesPanel's narrower single-list treatment) — StashPanel needs the same file-list+diff
// split ChangesPanel/DetailPanel use.
export const STASH_PANEL_MIN_WIDTH = RIGHT_PANEL_MIN_WIDTH;
export const STASH_PANEL_DEFAULT_WIDTH = RIGHT_PANEL_DEFAULT_WIDTH;
export const STASH_LIST_MIN_WIDTH = 220;
export const STASH_LIST_DEFAULT_WIDTH = 320;

// specs/blame.md FR-132: same shared right-panel-slot width as ChangesPanel/DetailPanel/StashPanel
// (not BranchesPanel's narrower single-list treatment) — blame content is line-by-line file
// content, same "needs breathing room" reasoning a diff does. Single-width only (no inner
// divider): unlike those three panels, blame has no second per-item list column to split against
// — FR-133's file history is a collapsible region within the one column, not a side-by-side split.
export const BLAME_PANEL_MIN_WIDTH = RIGHT_PANEL_MIN_WIDTH;
export const BLAME_PANEL_DEFAULT_WIDTH = RIGHT_PANEL_DEFAULT_WIDTH;

/** The existing `80vw` cap (unchanged from the shipped, non-resizable panels) — computed live so
 * it always reflects the current window size (Must-have C19), not a stale snapshot. */
export function eightyVw(): number {
  if (typeof window === "undefined") return 1000;
  return window.innerWidth * 0.8;
}
