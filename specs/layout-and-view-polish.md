# PRD: Layout & View Polish (filter-bar collapse, diff sizing, resizable/persisted panels)

Status: final (shipped) — UX polish pass on already-shipped surfaces, sequenced ahead of stage 4
(merge/rebase + conflict UI) at the user's explicit request. Not itself a new item in the v1
priority order (`PRODUCT.md`).
Owner: product-manager
Sequencing: pure `packages/desktop` (renderer) work. No `packages/git-core` changes — nothing
here reads or mutates git state differently than today; it only changes how existing UI is
shown, sized, and remembered. Independent of `specs/multi-repo-tabs.md` (this spec's panel-size
and panel-open preferences are a **global** app preference, not per-tab — see Must-have C and
that spec's own note) — buildable and shippable before, after, or in parallel with tabs.

Builds on `specs/stage-unstage-diff.md`, `specs/detailpanel-auto-diff.md`, and
`specs/branch-management.md` — extends their shipped ChangesPanel/DetailPanel/BranchesPanel/
FilterBar surfaces in place; does not change what data they show or how git operations behave.

## Problem

Three papercuts reported after living with the shipped app:

1. The commit-history filter fields (SHA, Author, Message, From/To dates, File path) render as a
   permanent row across the top of the window at all times, even for the common case of not
   filtering at all — wasted vertical space on every screen.
2. Opening a diff (in the Changes panel or the commit DetailPanel) can render a pane taller than
   the visible window, forcing the user to scroll before they can see the first line of the very
   diff they just asked to view.
3. Every fixed-width panel (Changes panel, DetailPanel, Branches panel, and the file-list/diff
   split inside the first two) is a hard-coded size with no way to resize it, and nothing about
   the app's layout (panel sizes, or which utility panel was left open) survives a relaunch —
   only the light/dark theme choice does (`useTheme.ts`, `githydra:theme`).

## Target user

Same as every prior spec: a developer who has GitHydra open for extended, repeated sessions
across a workday, on displays ranging from a small laptop panel to an ultrawide monitor, who
expects a desktop git GUI to fit its content to the window it's given and to remember how they
last arranged it — the way any comparable git GUI (GitKraken, Sourcetree, Fork) or IDE does.

## Must-have behavior

### A. Filter bar consolidation (`FilterBar.tsx`)

1. The existing `FilterBar` form (SHA/Author/Message/From/To/File path fields, Search/Clear
   buttons, "Show all branches & tags" toggle — all unchanged) is not rendered inline by default.
   In its place, a single collapsed control (a toggle button, consistent with `Toolbar`'s existing
   `gh-toolbar__button`/`--active` treatment) sits where the filter bar used to render, labeled to
   indicate its purpose (e.g. "Search & filter"). Collapsed, it occupies no more vertical space
   than one toolbar-height row.
2. Activating the control expands the full existing form in place (same behavior/fields as
   today — this is a visibility wrapper, not a rewrite of `FilterBar`'s internals); activating it
   again collapses it. `aria-expanded` reflects state; the control is operable via Enter/Space.
3. Collapsing never clears or alters the currently-applied filter (`graph.filter` /
   `CommitLogFilter`) — only the form's visibility changes. A user can apply a filter, collapse the
   control, and the graph stays filtered.
4. While collapsed, if a filter is currently active (`isFilterActive`, already computed in
   `FilterBar.tsx`), the collapsed control visibly indicates this (e.g. a count/dot), so a
   filtered graph is never silently unexplained — consistent with `PRODUCT.md`'s "legibility of
   structure over configuration" principle.
5. The control always starts collapsed — on every fresh app launch and every newly opened
   repository — regardless of whether a filter was applied or the form was left expanded in a
   prior session. (No persistence of the expand/collapse UI state itself — see Non-goals.)
6. Existing conditions for whether the filter bar renders at all are unchanged: still gated on
   `graph.status === "ready" && repoState && !isEmpty && !isUnbornHead` (App.tsx's current
   condition) — an empty/unborn-HEAD repo still shows no filter control, collapsed or otherwise.

### B. Diff panel default sizing (`DiffView.tsx`/`.css`, `ChangesPanel.css`, `DetailPanel.css`)

7. On first opening any diff, no scrollbar or content overflow appears at any level **above** the
   diff column itself — not the app window/document, not the panel (`.gh-changes-panel` /
   `.gh-detail-panel`), not the two-region body (`__body--ready` / `__split`). The diff column
   (`.gh-changes-panel__diff` / `.gh-detail-panel__diff`) remains the only scroll boundary
   introduced by a long diff, per DESIGN.md's already-documented Independent-Scroll Rule.
8. The first line of a newly selected file's diff is visible without the user needing to scroll
   anything — the diff column's scroll position starts at the top on every fresh file selection
   (including auto-selection per `specs/detailpanel-auto-diff.md`).
9. A short diff (fits within the diff column's available height) renders at its natural content
   height — no forced minimum height, no empty filler stretching the bordered hunks box
   (`.gh-diff-view__hunks`) to fill unused vertical space.
10. A diff long enough to exceed the diff column's available height scrolls **internally within
    that column only**; scrolling it must not move the file-list column, the panel chrome, or the
    app window.
11. `DiffView`'s hunks region (`.gh-diff-view__hunks`) carries a default max-height equal to the
    lesser of (a) the space actually available in its parent column at render time, or (b) `70vh`
    — so even if `DiffView` is ever mounted in a context that doesn't fully bound its parent's
    height (e.g. a future caller), no single diff by default consumes more than 70% of the
    viewport before switching to internal scroll. This is a floor/safety value, not a replacement
    for properly bounding the two existing callers' layout (item 7).
12. This holds at the panels' existing default widths (680px, `80vw` cap) and continues to hold
    after a panel is resized (Must-have C) or the app window itself is resized smaller, down to
    each panel's defined minimum width — the fix must not be tied to one specific window size.

**Note for ui-graphics (not a prescribed cause):** reading the CSS alone did not conclusively
locate why the diff pane currently over-grows past the viewport — reproduce the bug in the running
app first (Playwright MCP or manual launch, on a diff long enough to trigger it) and confirm the
actual cause before changing anything. One candidate worth checking early: `.gh-changes-panel__diff`
and `.gh-detail-panel__diff` are flex items in a row container but don't set `min-height: 0`, and a
flex item's default `min-height: auto` can prevent it from ever shrinking below its content's
intrinsic height — a classic cause of exactly this symptom. Confirm against the real render before
treating this as the fix; the acceptance criteria above are written as the observable requirement,
not this specific mechanism.

### C. Resizable panels + persisted layout (extends `specs/detailpanel-auto-diff.md`'s two-region
layout; reuses `useTheme.ts`'s persistence pattern)

No layout persistence exists in the shipped app today beyond theme (`githydra:theme`, in
`useTheme.ts`) — panel open/closed state (`rightPanel` in `App.tsx`) and every panel width
(680px/680px/420px, and the 300px/260px internal file-list columns) are hard-coded and reset on
every relaunch. This section is new scope, not an extension of existing persistence.

"Sidebar" (as named in the originating request) does not exist as a component in the shipped app
today (confirmed: no `Sidebar` component anywhere in `packages/desktop/src`) — the closest existing
analog is the right-edge `BranchesPanel`, which this spec treats as the intended target. If a true
left-edge navigational sidebar is built later, it inherits this same resize/persistence pattern
rather than reopening this spec.

13. Four resizable surfaces get a drag handle on their existing hairline border
    (`var(--gh-border)`), each independently draggable:
    - `ChangesPanel`'s left edge (panel width) — min 420px, max `80vw` (existing cap), default
      680px (unchanged).
    - `DetailPanel`'s left edge (panel width) — min 420px, max `80vw`, default 680px (unchanged).
    - `BranchesPanel`'s left edge (panel width) — min 280px, max `80vw`, default 420px (unchanged).
    - The file-list/diff divider inside `ChangesPanel` (`__files`/`__diff`) — file-list column min
      160px, max 50% of the panel's current total width, default 300px (unchanged).
    - The equivalent divider inside `DetailPanel` (`__files`/`__diff` in its `__split`) — same
      160px minimum and 50%-of-panel-width maximum, default 260px (unchanged).
    (Five handles total across the four bullet points above — the last two are separate instances
    of the same pattern, one per panel, matching DESIGN.md's note that the two panels reuse the
    same split mechanics with different defaults.)
14. Dragging a handle resizes live (no separate "apply" step); the resize is clamped to its
    min/max at every point during the drag, never allowing the graph pane to be squeezed to zero
    width or a panel to be dragged off-screen.
15. Each handle is keyboard-operable: focusable, `role="separator"`, `aria-orientation="vertical"`,
    `aria-valuenow`/`aria-valuemin`/`aria-valuemax` reflecting the current/min/max size, and
    resizable via the Left/Right arrow keys in fixed 16px increments while focused.
16. The five sizes above, plus which of the three toggleable right panels (`"none"` / `"changes"`
    / `"branches"` — **not** `"commit"`, which has no independent toggle and is derived purely
    from whether a commit is selected, itself not persisted) was last showing, persist to
    `localStorage` using the same try/catch-guarded read/write pattern `useTheme.ts` already
    establishes (so a private-mode/unavailable-storage environment degrades to "doesn't persist,"
    never a crash). Suggested keys (non-binding, for consistency): `githydra:layout:rightPanel`,
    `githydra:layout:changesPanelWidth`, `githydra:layout:detailPanelWidth`,
    `githydra:layout:branchesPanelWidth`, `githydra:layout:changesFileListWidth`,
    `githydra:layout:detailFileListWidth`.
17. **Persistence is global, not per-repo/per-tab** — one shared set of size/open-panel
    preferences for the whole app, the same scope `githydra:theme` already has. Resizing a panel
    (or leaving one open) while one repository is active, then opening or switching to a different
    repository, shows that same size/open-panel choice there too. (This is a deliberate simplicity
    call: panel size is treated as a property of the user's display/window, not of which repo is
    open — see Non-goals, and see `specs/multi-repo-tabs.md`'s note on how a newly created tab
    seeds its initial right-panel state from this same preference.)
18. On app launch (or opening a repo for the first time this session), each panel/divider reads
    its persisted size if one exists and is still valid (see item 19), else falls back to its
    shipped default; the last-open-panel preference likewise defaults to `"none"` (today's
    existing default) if nothing has ever been persisted.
19. A persisted width that would now exceed the current window's live `80vw` cap (e.g. the app was
    last resized on a larger monitor) is clamped down to `80vw` (or the panel's minimum, whichever
    is larger) at render time — never used verbatim if it would push content off-screen.
20. Writes to storage are debounced/batched per drag gesture (e.g. committed once on pointer-up),
    not on every intermediate pixel of movement during a drag — dragging a handle back and forth
    rapidly must not produce one `localStorage` write per mouse-move event.

## Non-goals

- **Persisting the filter bar's own expanded/collapsed UI state.** It always starts collapsed on
  every launch/repo-open, per the literal "closed by default" ask (Must-have A5). Only the applied
  filter's *effect* on the graph persists across a collapse/expand within a session — this was
  already true before this spec and is unchanged.
- **Per-tab or per-repo independent panel-size/open-panel preferences.** One global preference set
  shared by the whole app (and, once `specs/multi-repo-tabs.md` ships, by every tab) — not decided
  per repository. If real usage later shows people want per-repo layouts, that's a future spec.
- **Resizing the commit graph area itself**, or resizing panel *height* (right-edge panels already
  always span the app-body's full height) — only the five width/split handles in Must-have C13 are
  in scope. No floating/undocked/pop-out panel windows.
- **Introducing a new left-edge navigational sidebar component.** "Sidebar" in the originating ask
  is treated as referring to the existing `BranchesPanel` (see Must-have C's framing note) — no new
  component is built to satisfy the word literally.
- **Remembering which commit/checkpoint was selected, or which specific filter values were
  entered**, across a relaunch. Unchanged, pre-existing behavior (`selectedSha`/`filter` reset on
  repo open) — only panel *chrome* (sizes, which utility panel was open) is in scope as "layout."
- **A specific prescribed CSS root cause for the diff-sizing bug.** This spec states the observable
  requirement (Must-have B); ui-graphics is expected to reproduce and root-cause in the running
  app rather than build against an assumed cause.
- **Touch/pen-specific resize gestures.** Standard pointer events for mouse-driven desktop use are
  sufficient; no dedicated touch affordance.

## Acceptance criteria

1. On a repo with commits, the five filter field groups (SHA, Author, Message, From/To, File path)
   are not visible on initial render — only a single collapsed "Search & filter" control is shown,
   no taller than one toolbar row.
2. Activating the collapsed control expands the full form with all fields functional exactly as
   before this spec; activating it again collapses it. `aria-expanded` toggles correctly and both
   states are reachable via keyboard alone.
3. Applying a filter, then collapsing the control, leaves the graph filtered (row count/content
   unchanged from just before collapsing) — collapsing never calls `onClear` or resets `filter`.
4. With a filter active and the control collapsed, a visible indicator on the collapsed control
   communicates that a filter is applied (distinguishable from the no-filter-active collapsed
   state).
5. Relaunching the app (or opening a new repository) always shows the control collapsed, even if
   it was left expanded, or a filter was left applied, in the prior session/repo.
6. Opening a diff whose content is longer than the visible window produces zero scrollable
   overflow at the app-window, panel, or two-region-body level — only the diff column itself
   scrolls, and its scroll position is at the top on first render (first line visible with no
   scrolling).
7. A one-line diff renders at its natural (short) height inside the diff column, not stretched to
   fill the column's remaining space.
8. The behavior in AC6 holds at the shipped 680px panel width, after a panel is resized narrower
   (down to its 420px minimum, AC9 below), and after the app window itself is resized shorter.
9. Each of the five resize handles (Changes panel width, DetailPanel width, Branches panel width,
   Changes panel's file-list/diff divider, DetailPanel's file-list/diff divider) can be dragged to
   change its element's size live, is clamped at its documented min/max, and is operable via
   Left/Right arrow keys when focused (`role="separator"` with correct `aria-value*` attributes).
10. After dragging any of the five handles to a non-default size and relaunching the app (or
    remounting the app root against the same storage), that element reopens at the last-dragged
    size, not its shipped default — verified independently per handle.
11. Toggling the Changes panel open (or Branches panel open), then relaunching, reopens with that
    same panel shown by default; a fresh install/first launch with no prior preference defaults to
    no panel open, matching today's shipped behavior.
12. Resizing a panel while repository A is active, then opening repository B, shows repository B's
    same panel at the size just set under repository A — confirming the global (not per-repo)
    persistence scope.
13. A width persisted from a larger window is clamped to the current window's `80vw` cap (or the
    panel's minimum, whichever is larger) when reopened in a smaller window — the graph pane is
    never squeezed to zero or off-screen.
14. Dragging a handle back and forth rapidly during one continuous drag results in at most one
    persisted-storage write for that gesture (verified by counting writes to the underlying storage
    mechanism during a single drag), not one write per pointer-move event.
15. No network request or telemetry event occurs at any point across AC1–AC14 (inherited product
    principle).
