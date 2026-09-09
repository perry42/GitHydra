# FilterBar visual redesign

## Problem

`FilterBar.tsx`'s expanded form (SHA, Author, Message, From/To date, File path — all six fields,
one flat row) reads as visually dated next to the rest of the app's now-more-polished visual
language (selection halo, ref-chip gutter passes) — reported directly against the live app
(`ROADMAP.md`'s "Open design gap" entry, 2026-09-07). The most concrete symptom: raw, unstyled
browser `<input type="date">` controls (default "dd----yyyy" placeholder styling, default calendar
glyph) sit beside GitHydra's own token-styled text fields with no visual relationship to them.

The companion necessity/scope pass (product-manager, already complete — not re-litigated here)
settled two things this spec builds on directly:
1. All six fields earn their space and are kept — none cut.
2. The form restructures into two tiers: SHA/Author/Message as a primary, always-visible row;
   From/To date and File path collapsed behind a secondary "more filters" disclosure.

This spec covers only the remaining half: the visual restyle to `DESIGN.md`'s token system and
component language, and the concrete shape of the primary/secondary split. It reuses, rather than
reinvents, the collapsed-disclosure pattern `specs/layout-and-view-polish.md` already established
for `FilterBar`'s own outer toggle (and that `DetailPanel`'s metadata block also uses) — that
pattern is confirmed sound; nothing about the disclosure *mechanism* changes here.

## Target user

Same as `specs/layout-and-view-polish.md`: any developer with GitHydra open for extended,
repeated sessions, on any git host or none (GitHub/GitLab/Bitbucket/self-hosted/local-only) — pure
renderer/visual work, no dependency on host or remote presence.

## Must-have behavior

- FR-247: The primary row — SHA, Author, Message, the Search/Clear buttons, and the "Show all
  branches & tags" toggle — renders immediately when the existing outer "Search & filter"
  disclosure (`FilterBar.tsx`'s `expanded` state, unchanged) is activated. Unchanged fields/
  behavior from today; only their visual treatment changes (FR-252).
- FR-248: From, To, and File path move behind a new secondary disclosure — a "More filters"
  control living inside the expanded primary form (not a third top-level toolbar toggle) — and do
  not render until it is activated.
- FR-249: The secondary disclosure reuses the exact collapsed-disclosure component pattern already
  established (chevron + label button; expands in place; toggling it never remounts the form or
  clears/resets the From/To/Path field values already typed) — the same mechanism `FilterBar`'s
  own outer toggle and `DetailPanel`'s metadata block use, per `DESIGN.md`'s "Collapsed-metadata
  disclosure" / "Collapsed-disclosure filter bar" entries.
- FR-250: The secondary disclosure carries its own small filled-dot indicator (identical visual
  treatment to the outer toggle's existing dot, paired with equivalent visually-hidden text for
  screen readers) when any of From/To/Path currently holds a value — independent of the outer
  toggle's dot, which continues to reflect all six fields combined, unchanged.
- FR-251: The secondary disclosure's own expanded/collapsed state resets on every repo/tab open
  exactly the way the outer toggle's `expanded` state already does today (`openSequence`-driven,
  `lastOpenSequenceRef` pattern) — seeded to expanded if that tab's incoming filter has a From/To/
  Path value, else collapsed, mirroring the existing `isFilterActiveOf`-driven reseed logic applied
  to a From/To/Path-only subset rather than all six fields.
- FR-252: All six field inputs (SHA, Author, Message, From, To, Path) share one consistent,
  DESIGN.md-token-conformant input treatment — border `var(--gh-border)`, radius
  `var(--gh-radius-sm)`, background `var(--gh-page)`, ink `var(--gh-ink-primary)`, label ink
  `var(--gh-ink-muted)`, and the shared global `:focus-visible` accent-outline treatment on focus.
  No per-field bespoke styling.
- FR-253: From/To date inputs' outer chrome (border, radius, background, height, font-size) is
  visually indistinguishable from the text fields beside them. Only the browser-native internals
  that CSS can't otherwise reach are restyled: the calendar-picker icon is recolored to
  `var(--gh-ink-muted)` at rest (swapping to `var(--gh-accent)` on hover/focus, matching this
  system's existing interactive-affordance convention), and the empty "dd/mm/yyyy"-style
  placeholder segments render in `var(--gh-ink-muted)` rather than default browser black/gray —
  achieved via Chromium-specific pseudo-elements (`::-webkit-calendar-picker-indicator`,
  `::-webkit-datetime-edit-*-field`), which is safe here since Electron's renderer is always
  Chromium, unlike a cross-browser web app.
- FR-254: No new colors, radii, or spacing values are introduced. Every value used resolves to a
  token already in `DESIGN.md`'s existing tables (`--gh-border`, `--gh-radius-sm`, `--gh-page`,
  `--gh-ink-primary`/`--gh-ink-secondary`/`--gh-ink-muted`, `--gh-accent`, `--gh-space-*`).
- FR-255: If FR-253's calendar affordance is implemented (fully or partly) via a custom icon
  rather than a pure CSS recolor of the native glyph, that icon is added through `Icon.tsx`'s
  existing vocabulary conventions (shared 18x18 grid, `currentColor`, 2px stroke weight,
  decorative/`aria-hidden` by default) — never a new one-off inline SVG or a Unicode glyph
  standing in for it, per `DESIGN.md`'s Icon vocabulary section and its own stated rule.
- FR-256: All existing `FilterBar` functional behavior is unchanged by this pass: filter-apply/
  clear logic, the SHA-takes-over-all-other-fields rule, Clear's disabled-when-inactive state, the
  `showAllRefs` checkbox, the `loadedCommitCount`/`hasMoreCommits` status readout, and the outer
  disclosure's own expand/collapse + `openSequence` reset behavior. This is a visual/structural
  pass on top of unchanged logic, not a behavior change.

## Non-goals

- **Cutting or renaming any of the six fields.** Already settled by the prior necessity/scope
  pass; not reopened here.
- **Persisting either disclosure's (outer or new secondary) open/collapsed state to
  `localStorage` across relaunches.** Both continue to reset on every launch/repo-open, matching
  the outer toggle's existing, deliberate non-persistence
  (`specs/layout-and-view-polish.md`'s own Non-goals).
- **Restyling the Search/Clear buttons or the "Show all branches & tags" checkbox.** Already
  token-conformant from the prior layout-and-view-polish pass; may be repositioned to fit the new
  two-tier layout, but their visual treatment is out of scope here.
- **Building a custom calendar/date-picker dropdown widget.** Scope is restyling the existing
  native `<input type="date">`'s chrome (FR-253), not replacing its interaction model with a
  bespoke calendar UI.
- **A Command Palette entry for the new "More filters" toggle.** Per `CLAUDE.md`'s convention,
  this is a context-specific control nested inside an already-expanded form (you must first open
  "Search & filter" to reach it) rather than a discrete action a user would trigger "from
  anywhere" — the same reasoning that already excludes the existing outer "Search & filter" toggle
  itself from `commands.ts`'s registry today.
- **Changing the outer "Search & filter" disclosure's own behavior, position, or persistence.**
  Untouched by this spec — see FR-247/256.

## Acceptance criteria

1. Activating the outer "Search & filter" toggle shows SHA, Author, Message, Search, Clear, and
   "Show all branches & tags" immediately; From, To, and File path are not present in the DOM
   until the secondary "More filters" control is also activated.
2. A "More filters" disclosure control is visible within the expanded primary form, styled
   consistently with the outer toggle (same collapsed-disclosure visual pattern); activating it
   reveals From/To/Path in place with no reflow/jump of the SHA/Author/Message fields already
   shown; a second activation collapses it again. `aria-expanded` reflects state correctly and it
   is operable via Enter/Space when focused (keyboard-only reachable, matching the outer toggle's
   existing test coverage pattern in `FilterBar.test.tsx`).
3. Typing a value into From, To, or Path, then collapsing "More filters," then re-expanding it,
   shows the same values still present — collapsing/expanding the secondary disclosure never
   clears field state.
4. With "More filters" collapsed and at least one of From/To/Path holding a value, the "More
   filters" control shows a distinguishable active-indicator (dot + screen-reader text), separate
   from and in addition to the outer toggle's own existing indicator.
5. Opening a new repository/tab whose incoming filter has a From/To/Path value shows "More
   filters" already expanded on first render of that tab; a tab with no such value (even if SHA/
   Author/Message alone are filtered) shows it collapsed by default — verified across at least two
   tabs with different filter states, per `FilterBar.tsx`'s existing `openSequence` mechanism.
6. All six field inputs render with visually identical outer chrome (border, corner radius,
   background, height) inspectable in a running Electron build or computed-style snapshot — no
   field looks structurally different from the others at the box level.
7. The From/To date inputs' calendar-picker icon renders in the muted ink token (not the browser
   default black/gray) at rest, and the empty-state placeholder segments (day/month/year) render
   in the same muted ink token rather than default browser rendering — confirmed via a real
   Electron screenshot (not a code-only read), matching this codebase's established verification
   bar for CSS-affecting changes (`ROADMAP.md`'s branch/tag-gutter precedent).
8. No new hex color, non-token radius, or non-token spacing value appears in the diff introduced
   by this spec — every visual value traces to an existing `DESIGN.md` token.
9. If a custom icon is introduced for the calendar affordance, it is implemented as a new
   `Icon.tsx`-vocabulary component (18x18 grid, `currentColor`, 2px stroke, `aria-hidden` by
   default) — not an inline one-off SVG or Unicode glyph.
10. `FilterBar.test.tsx`'s existing behavioral assertions (filter apply/clear, SHA-wins-all,
    Clear disabled state, `showAllRefs`, keyboard operability of the outer toggle) continue to
    pass, updated only where the new two-tier DOM structure requires an additional "expand More
    filters" step before asserting on From/To/Path — no assertion about filter *logic* changes.
11. No network request or telemetry event occurs at any point across AC1–AC10 (inherited product
    principle).

## References

- `packages/desktop/src/components/FilterBar/FilterBar.tsx`, `FilterBar.css`,
  `FilterBar.test.tsx` — the component, styles, and existing test suite this spec extends in
  place.
- `specs/layout-and-view-polish.md` Must-have A — the outer collapsed-disclosure pattern this spec
  reuses verbatim for the new secondary "More filters" control, including its `openSequence`
  reset precedent (see `specs/multi-repo-tabs.md`'s fix, documented in `FilterBar.tsx`'s own
  header comment).
- `DESIGN.md`'s "Tokens — chrome & ink," "Collapsed-metadata disclosure," "Collapsed-disclosure
  filter bar," and "Icon vocabulary" entries — the token set and component-language precedents
  this redesign must conform to, not re-decide.
- `ROADMAP.md`'s "Open design gap — FilterBar's expanded form looks dated" entry — this spec's
  originating report and the necessity/scope verdict it builds on.
