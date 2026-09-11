# Find Commits overlay

**Supersedes `specs/filter-bar-visual-redesign.md` (FR-247–256).** That spec's shipped two-tier
FilterBar restyle looked worse than the original in the live app per a design critique; this spec
replaces the whole permanent-row approach rather than patching it further. Decided directly with
the user in an extended live conversation, not a unilateral product-manager call — every
requirement below is final; this document only assigns FR numbers and ties it to real code.

## Problem

`FilterBar.tsx` renders a permanently-mounted row above the commit graph in every state, even
fully collapsed (`gh-filter-bar-collapsed-row`, `min-height: 44px`) — a standing cost against
`DESIGN.md`'s "FIRST VIEWPORT" thesis (the graph should fill the window edge-to-edge with no
reserved chrome) that the FR-247–256 restyle pass made *more* visually prominent, not less. The
underlying capability (search/filter the commit log by SHA/Author/Message/From/To/Path) is real
and worth keeping; the "always-there, taking up a row" presentation is the actual problem, and a
prefix-syntax query language (seriously considered as an alternative) was rejected once "reclaim
the screen space" was identified as the real goal — a simpler UI shape solves it without changing
the query model at all.

## Target user

Any developer with GitHydra open for extended sessions, on any git host or none — pure
renderer/UI work, no dependency on host or remote presence, no `git-core` change.

## Must-have behavior

- **FR-257:** `FilterBar.tsx`'s permanently-mounted row is removed from `App.tsx` entirely —
  including its collapsed-state 44px row — so no vertical space is reserved above the commit graph
  for search/filter in any state. `FilterBar.tsx`/`FilterBar.css`/`FilterBar.test.tsx` are retired
  (not left dead in the tree); their reusable pieces (form-state helpers, token-styled input CSS,
  the `IconCalendar` technique) move into the new component below rather than being duplicated.
- **FR-258:** A new icon-only ghost button ("Find commits") is added to `Toolbar.tsx`'s existing
  utility-actions cluster (`gh-toolbar__group--utility`), positioned before the Refresh button,
  using the identical `gh-toolbar__icon-button` treatment (28×28, no border until hover/focus,
  `title` tooltip, `aria-label`) Refresh and the theme toggle already use. Rendered via a new
  `Icon.tsx`-vocabulary component (18×18 grid, `currentColor`, 2px stroke, `aria-hidden` by
  default — same vocabulary rule FR-255 already established, no one-off inline SVG). Shown under
  the exact same gate `FilterBar` used to render under: `graph.status === "ready" &&
  graph.repoState && !graph.repoState.isEmpty && !graph.repoState.isUnbornHead`.
- **FR-259:** Clicking the toolbar icon, invoking it from the Command Palette, or pressing
  `Ctrl+Shift+F` (`Cmd+Shift+F` on macOS) opens a floating "Find commits" overlay positioned over
  the commit graph, anchored under the toolbar — not a centered full-screen modal like
  `CommandPalette`. Owned as a plain boolean in `App.tsx` (`findCommitsOpen`, parallel to
  `paletteOpen`), conditionally rendered exactly like `{paletteOpen && <CommandPalette .../>}`.
- **FR-260:** The overlay contains exactly the fields `CommitLogFilter` maps to today — SHA,
  Author, Message, From date, To date, File path — as plain labeled inputs, explicitly **no
  prefix-syntax query language**. Search and Clear buttons and the existing "Show all branches &
  tags" checkbox are carried over unchanged. All fields render together, flat — the prior
  primary/secondary "More filters" two-tier disclosure (`filter-bar-visual-redesign.md`
  FR-248/249) is dropped: the overlay's own open/closed state already *is* the one disclosure
  layer needed now.
- **FR-261:** On open, all fields seed from the active tab's current `filter`/`showAllRefs` state
  (`filterToForm`, reused verbatim from the retired `FilterBar.tsx`) — reopening the overlay for a
  tab with an already-applied filter shows those values, not a blank form. The SHA field is
  auto-focused on open, matching this codebase's established focused-input-on-open convention
  (`CommandPalette`, `NewBranchDialog`).
- **FR-262:** Submitting the form (Search button or Enter) applies the filter via the existing
  `onApply`/`graph.applyFilter` contract, unchanged: entering a SHA still takes over and clears all
  other fields (git-core's documented sha-wins-all behavior), exactly as today.
- **FR-263:** Closing the overlay — via Esc, clicking outside it, or re-clicking the toolbar
  icon/re-firing the shortcut while it's open — both hides it and clears the active filter back to
  empty (`onClear`), regardless of whether the visible field values were ever submitted. This is a
  "find," not a "keep a narrowed view open" feature, per the user's own framing ("closing it ...
  will close the filter because its not something many people use").
- **FR-264:** The `loadedCommitCount`/`hasMoreCommits` status readout (today's "1,532+ commits
  loaded" text in `FilterBar`'s collapsed row) moves inside the overlay itself, rendered only while
  it's open — no replacement persistent status line is added elsewhere, consistent with FR-257's
  "no reserved space in any state."
- **FR-265:** The overlay force-closes (via the same FR-263 close-and-clear path) when
  `useRepositoryGraph`'s `openSequence` changes — i.e., switching tabs or closing the active tab
  while the overlay is open — so it never sits open pointed at a stale tab's filter. Reuses the
  existing `openSequence` prop `FilterBar` already consumed; no new signal invented.
- **FR-266:** `findCommitsOpen` is folded into `App.tsx`'s `anyModalDialogOpen` gate, the same
  lift-up pattern every other dialog/overlay (`ConfirmDialog`, `NewBranchDialog`, `CommandPalette`,
  `ContextMenu` instances) already follows — so the global keybinding layer defers to the
  overlay's own local key handling (typing, Enter-to-submit, Esc-to-close) while it's open, and
  `Ctrl+Shift+F` doesn't refire into it a second time. This codebase has twice shipped and had to
  fix a "forgot to fold a new overlay into `anyModalDialogOpen`" gap (`ROADMAP.md`'s command-palette
  entry) — land it correctly from the start here.
- **FR-267:** `Ctrl+F` (`Cmd+F` on macOS) is reassigned from unbound to: expand the Branches
  sidebar if currently collapsed, then move DOM focus into its existing search input
  (`BranchesPanel.tsx`'s `gh-branches-panel__search`), selecting any existing text — a
  higher-frequency action than commit search per the user's explicit ranking. Implementation note
  for ui-graphics: add a `focusSearchToken?: number` prop to `BranchesPanel`, bumped by `App.tsx`
  on `Ctrl+F`, consumed via a `useEffect`+`ref` — the same bump-a-counter-prop convention this
  component already uses for `reloadToken`, rather than a new mechanism.
- **FR-268:** Both new actions are registered in `commands.ts`'s `getCommands()` registry per
  `CLAUDE.md`'s standing convention — "Find commits…" (`keybindings: [{ key: "f", mod: true, shift:
  true }]`, `isAvailable` matching FR-258's toolbar gate, `run` sets `findCommitsOpen = true`) and
  "Focus branches search" (`keybindings: [{ key: "f", mod: true }]`, `isAvailable: (c) =>
  c.showBranchesToggle`, `run` performs FR-267's expand+focus). Both categorized `"view"` — grouped
  with the existing sidebar/panel-visibility commands (`toggle-branches-sidebar`,
  `toggle-changes-panel`) rather than `"git"`, since neither mutates repository state, matching
  that category's existing membership. **Product-manager call, not explicitly confirmed by the
  user** — flag if this reads wrong once built.
- **FR-269:** The overlay reuses, rather than rebuilds, `filter-bar-visual-redesign.md`'s FR-252
  token-unified input styling (border `var(--gh-border)`, radius `var(--gh-radius-sm)`, background
  `var(--gh-page)`, ink tokens, shared `:focus-visible` outline) and its FR-253/255
  `IconCalendar`-over-hidden-native-glyph technique for the From/To date fields — copied into the
  new component's CSS file, not re-derived or re-verified from scratch (already confirmed correct
  by that spec's real-Electron pixel-sampling test).
- **FR-270:** No `packages/git-core` change. `CommitLogFilter` (`packages/git-core/src/types.ts`)
  already has every field this needs; this is UI-layer-only, same prop contract shape
  (`filter`/`onApply`/`onClear`/`showAllRefs`/`onShowAllRefsChange`/`openSequence`/
  `loadedCommitCount`/`hasMoreCommits`) `FilterBar` already had, minus the now-unneeded
  `expanded`/`moreExpanded` disclosure state (the overlay's own mount/unmount replaces both).

## Non-goals

- **A prefix-syntax query language.** Explicitly considered and rejected by the user (requirement
  3) — plain labeled fields only.
- **Persisting the filter across the overlay closing, a tab switch, or a relaunch.** Deliberately
  transient by design (FR-263/265); this is unrelated to — and does not resolve — `ROADMAP.md`'s
  still-queued, not-yet-scoped "Remember last search/filter per repo" V1.1 item, which needs a
  separate user conversation per that entry's own note.
- **Rebuilding the primary/secondary "More filters" two-tier disclosure.** Superseded by FR-260 —
  all six fields render together in the overlay.
- **A custom calendar/date-picker widget.** Same as the superseded spec's non-goal — restyling
  `<input type="date">`'s chrome only, not replacing its interaction model.
- **Any `git-core` or IPC contract change.**

## Acceptance criteria

1. With a repo open (non-empty, non-unborn-HEAD), no `FilterBar`/search-related element occupies
   any vertical space above the commit graph before the overlay is ever opened — confirmed via a
   layout/DOM check, not just visual inspection.
2. The "Find commits" toolbar button is present in the utility cluster, 28×28, matching Refresh's
   visual treatment, with a working `title` and `aria-label`; absent when no repo is open or the
   repo is empty/unborn-HEAD.
3. Clicking the toolbar button, invoking "Find commits…" from the Command Palette, and pressing
   `Ctrl+Shift+F` (`Cmd+Shift+F` on macOS) each independently open the overlay.
4. The overlay shows SHA, Author, Message, From, To, File path, Search, Clear, and "Show all
   branches & tags" — no other fields, no query-syntax hint text. The SHA field has DOM focus
   immediately on open.
5. Opening the overlay for a tab with an already-applied filter shows those values pre-filled, not
   a blank form.
6. Submitting the form applies the filter (graph re-queries per the existing `onApply` contract);
   entering a SHA clears/ignores the other fields, unchanged from today's behavior.
7. Pressing Esc, clicking outside the overlay, and re-triggering the open action while it's
   already open each close the overlay AND reset that tab's active filter to empty — verified by
   checking `graph.filter` is empty afterward, not just that the overlay is hidden.
8. Typing values into fields without pressing Search, then closing the overlay, discards those
   typed values — reopening shows the tab's last-applied (or empty) filter, not the discarded draft.
9. Switching to a different tab (or closing the active tab and landing on an adjacent one) while
   the overlay is open closes it and clears the filter on the tab that had it open.
10. While the overlay is open, `Ctrl/Cmd+K`, `Ctrl+Tab`/`Ctrl+Shift+Tab`, and `Ctrl+Shift+F` itself
    have no effect on the app underneath (verified the same way this codebase already tests
    `anyModalDialogOpen` suspension for `CommandPalette`/`ContextMenu`).
11. `Ctrl+F` (`Cmd+F` on macOS) expands the Branches sidebar if collapsed and moves focus into its
    search input; if already expanded, it just moves focus. Does not open the Find Commits overlay.
12. The From/To date inputs inside the overlay render with the same muted-ink calendar icon and
    placeholder-segment styling already verified (via real Electron screenshot) for the superseded
    FilterBar — confirmed still correct in the overlay's new markup, not re-derived and re-tested
    from first principles pixel-by-pixel (existing token/technique reuse is enough; a smoke check
    that the same CSS rules apply is sufficient here).
13. Both new commands appear in the Command Palette and the `Ctrl/Cmd+/` keyboard-shortcuts
    reference screen (inherited for free from `commands.ts` registration, per FR-268).
14. No network request or telemetry event occurs at any point across AC1–AC13 (inherited product
    principle).
15. `DESIGN.md`'s "Collapsed-disclosure filter bar" entry is revised (not silently deleted) to
    document this replacement, matching this project's established habit of recording reasoned
    component-language revisions rather than overwriting them silently.

## References

- `packages/desktop/src/components/FilterBar/FilterBar.tsx` — retired; form-state helpers
  (`filterToForm`, `isFilterActiveOf`) and CSS reused verbatim in the new component.
- `specs/filter-bar-visual-redesign.md` — superseded by this spec (see header note); its FR-252/253
  token styling and `IconCalendar` technique are the one thing explicitly carried forward.
- `packages/desktop/src/components/Toolbar/Toolbar.tsx`, `Toolbar.css` — the utility-actions
  cluster this feature's new button joins.
- `packages/desktop/src/components/BranchesPanel/BranchesPanel.tsx` — `Ctrl+F`'s target search box.
- `packages/desktop/src/lib/commands.ts`, `useGlobalKeybindings.ts` — the registry both new
  commands are added to.
- `packages/desktop/src/App.tsx`'s `anyModalDialogOpen` — the gate this overlay's own open state
  must be folded into (FR-266).
- `packages/git-core/src/types.ts`'s `CommitLogFilter` — unchanged, already sufficient (FR-270).
