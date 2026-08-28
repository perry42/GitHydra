# Spec Addendum: Auto-Diff on Selection + Two-Region DetailPanel Layout

Status: draft
Owner: product-manager
Parent spec: `specs/stage-unstage-diff.md` (extends FR-13, FR-28, FR-29, AC4 — no other FR/AC in
the parent spec changes)

This is a UX refinement to already-shipped functionality (commit graph + DetailPanel + Changes
panel), not a new v1 priority item.

## Problem

Selecting a commit (or the uncommitted-changes "checkpoint" pseudo-node) in the graph shows
metadata but not a diff — the user must separately click a file every single time they move
through history, which breaks the "browse history" flow GitKraken/Sourcetree/Fork users expect.
Clicking the checkpoint node today is worse than a no-op: it calls `onSelectCommit(null)`, which
closes any open panel instead of showing working-directory diffs. Separately, DetailPanel stacks
its changed-file list and `DiffView` in one scrolling column, so scrolling a long diff scrolls the
file list out of view — inconsistent with the Changes panel's already-shipped two-region layout
(FR-28: fixed file list beside a persistent, independently-scrolling diff pane).

## Target user

Same as the parent spec: a developer browsing commit history day to day, who expects selecting a
commit to immediately show what changed, the way it works in every comparable git GUI.

## Must-have behavior

1. **Auto-select first file (commit).** When `commitDetail` reaches `status: "ready"` with
   `files.length > 0`, DetailPanel loads the diff for `files[0]` (in the order `getChangedFiles`
   already returns) exactly as if the user had clicked it — no extra click required.
2. **Auto-select first file (checkpoint).** Clicking the uncommitted/checkpoint pseudo-node opens
   the Changes panel (`rightPanel = "changes"`) if it isn't already the visible right panel, and
   auto-selects the first diffable file in **Staged → Unstaged → Untracked** order (first
   non-empty section's first entry) — same load path `selectFile` already uses. Conflicted-only
   working directories are covered by #4.
3. **No flicker on reselection.** With the panel already open, selecting a different commit (or,
   for the Changes panel, the same checkpoint again after a mutation) updates SHA/metadata/file
   list/diff in place — the panel's root element is never unmounted/remounted, and `DiffView`'s
   idle "Select a file to view its diff." placeholder is never shown as an interstitial frame
   between two commits that each have changed files (state clears and re-selects together, not
   clear-then-idle-then-select).
4. **Explicit "no diff" state.** When the selected commit has zero changed files (empty commit),
   or the checkpoint's working directory has changes but none are diffable (all Conflicted), the
   diff pane shows an explicit message (e.g. "No diff found for this commit.") instead of being
   blank, instead of the generic "Select a file…" placeholder, and instead of the panel
   collapsing. The file-list region still renders its existing empty/Conflicted-only state
   unchanged.
5. **Two-region layout for DetailPanel.** DetailPanel adopts ChangesPanel's `__body--ready`
   pattern (`ChangesPanel.css:49-93`): changed-file list and `DiffView` render side by side in
   independently-scrolling regions (mirroring `__files`/`__diff`), not stacked in one scrolling
   column. Commit metadata (SHA, refs, message, author/committer, dates, parents) stays above this
   split and is unaffected by scrolling either region.
6. **No new component.** Reuses the existing `DiffView` component and its existing
   loading/error/binary/too-large/ok states (`DiffView.tsx`). The one net-new piece is a "no file
   to select" message for case #4 — a small addition to `DiffView` or an equivalent small
   affordance shared by both panels, not a new panel or component.

## Non-goals

- Changing which file's diff shows on a **manual** file click — that's existing FR-29 behavior,
  unchanged. Auto-select only governs the file shown immediately after a *selection*, not an
  auto-advance/auto-cycle through files.
- Keyboard shortcuts for stepping through files or commits.
- Multi-file or side-by-side diff view.
- Any change to how the checkpoint row is drawn/highlighted on the canvas (e.g. a "selected" ring)
  — only its click behavior (open Changes panel + auto-select first file) is in scope.
- Any change to Conflicted-file handling — still listed with no stage/unstage/diff control per
  FR-27; the "no diff" state for checkpoint applies only when there is no diffable file at all.
- Any change to ChangesPanel's own layout — it's already the reference implementation; the only
  change there is wiring a checkpoint click to open it (if not already open) and auto-select.
- Remembering "last file viewed per commit" across reselection — reselecting a commit always
  re-auto-selects its first file, even if the user previously clicked a different file on it
  earlier in the session.

## Acceptance criteria

1. Selecting a commit with ≥1 changed file immediately shows that file's (first file's) diff in
   DetailPanel with no additional click.
2. Selecting the checkpoint pseudo-node opens the Changes panel (if not already visible) and
   immediately shows the diff for the first diffable file in Staged → Unstaged → Untracked order,
   with no additional click.
3. With DetailPanel open on commit A's diff, clicking commit B updates SHA/metadata/file
   list/diff to B's data in place: the `aside.gh-detail-panel` element is never removed and
   re-added to the DOM, and `DiffView`'s "Select a file to view its diff." text is never rendered
   between two commits that each have changed files.
4. Selecting a commit with zero changed files (empty commit) leaves DetailPanel open, its file
   list shows "No files changed." as today, and the diff pane shows an explicit "no diff found"
   message rather than being blank or showing the generic placeholder.
5. In a mid-merge repo with only conflicted working-directory paths (no staged/unstaged/untracked
   entries), clicking the checkpoint node opens the Changes panel with the Conflicted section
   listed as today, and the diff pane shows the explicit "no diff found" message.
6. Manually clicking a different file in DetailPanel's file list after auto-selection still swaps
   the diff pane to that file (FR-29, unchanged) — auto-select does not fight a subsequent manual
   click on the same commit.
7. With 10+ changed files in DetailPanel, scrolling the file list does not move or reset the diff
   pane's scroll position, and vice versa — independently-verifiable `scrollTop` on the two
   regions, matching ChangesPanel's existing `__files`/`__diff` behavior.
8. DetailPanel's commit metadata (SHA, message, author/committer, parents) stays visible/reachable
   regardless of how far the file list or diff pane is scrolled.
9. Navigating commit A → commit B → commit A again (both with files) re-shows commit A's first
   file's diff each time — no stale caching of a file the user had manually selected on an earlier
   visit to A.
10. No network call occurs at any point in AC1–AC9 (local-only operation, inherited from the
    parent spec's product principles).
