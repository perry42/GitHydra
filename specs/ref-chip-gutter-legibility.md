# Ref-chip gutter legibility: type glyphs + multi-chip collapse

## Problem

Two confirmed, real legibility problems in the commit graph's persistent ref-chip gutter
(`RefChip.tsx`/`.css`, `CommitRow.tsx`, `CommitGraph.css`, `graphGeometry.ts`), both caught via real
screenshots, not code review:

1. **Type glyphs are illegible.** `.gh-refchip__icon` (the dot/ring/diamond/square distinguishing
   branch/remote-branch/tag/HEAD) is 6×6px — genuinely too small to read, especially at high DPI.
2. **Long branch/tag names truncate too aggressively once 2+ chips land on one row.** A row with two
   real chips splits the persistent 100px `REF_GUTTER_WIDTH` between them, producing illegible
   fragments ("docs/keybo…", "docs/keyca…") with no visible way to read the rest short of guessing to
   hover — a `title` tooltip exists on every chip today, but isn't discoverable without it. This is
   the item already tracked in `ROADMAP.md`'s Open section ("Ref-chip gutter with 2+ chips on one
   row") — this spec resolves it.

Not data loss in either case — every chip already carries a full `title`/`aria-label` — purely a
legibility/discoverability gap.

## Target user

Any GitHydra user viewing the commit graph on any repo, local or remote-backed, once either (a) they
notice the type glyphs at all, or (b) their repo has accumulated enough concurrent branches/tags on
shared history to land 2+ on one commit — which every actively-developed repo eventually does,
independent of host, size, or hosting.

## Must-have behavior

- **FR-406 — Glyph size.** `.gh-refchip__icon` grows from 6×6px to **8×8px**. Justification: an 11px
  chip label's cap-height is roughly 0.7em ≈ 7.7px — 8px reads as proportionate to the adjacent text
  (part of the same visual rhythm), where 6px (0.55em) reads as a stray speck and this system's other
  18px icon grid (`Icon.tsx`) would be ~1.6× the label's own font-size and dominate it instead of
  subordinating to it. The remote-branch ring's `border` thickens from 1.5px to 2px so the ring stays
  legible as a *ring* (not a filled dot) at the larger size; the branch dot's `border-radius: 50%`,
  tag's 45° rotation, and HEAD's `border-radius: 1px` square are otherwise unchanged, just scaled to
  the new box. `.gh-refchip`'s existing `height: 18px`/`gap: 4px` need no change — 8px still centers
  comfortably inside the existing row height.
- **FR-407 — Collapse scope excludes the synthetic HEAD marker.** `CommitRow.tsx`'s `showHeadMarker`
  badge (the always-on "HEAD" chip added by `graph-head-indicator-and-refresh-alerting.md` Problem 1,
  rendered *outside* the `chips` array) is entirely out of scope for this feature: always rendered,
  never counted toward the collapse trigger, never itself collapsible. The collapse mechanism below
  (FR-408–FR-411) operates only on the `chips` array `buildRefChips()` already produces. This is
  deliberate: without this exclusion, every checked-out commit's row (which already renders the HEAD
  badge *plus* the filled current-branch chip today) would spuriously trigger collapse and hide one of
  the two things Problem 1 explicitly fought to make simultaneously visible.
- **FR-408 — Collapse trigger.** A row collapses iff `chips.length >= 2` (exactly the ROADMAP item's
  "2+ chips on one row"). At `chips.length <= 1`, rendering is byte-for-byte unchanged from today.
- **FR-409 — Visible-slot priority.** When collapsed, exactly one chip renders in full width (still
  subject to its own existing per-chip ellipsis truncation, FR-412) in this priority order:
  1. The chip with `filled === true` (the checked-out local branch), if one exists in `chips`.
  2. Else, the chip with `decoration.type === "head" && detached === true` (the detached-HEAD chip
     `buildRefChips` itself produces), if present.
  3. Else, `chips[0]` — the existing array order (git's own decoration order), unchanged, no new sort
     introduced.

  Justification: the checked-out ref is the single highest-value fact in the gutter, and this matches
  the real GitKraken screenshot the user supplied (which keeps the checked-out branch visible and
  collapses the rest behind its own "+1").
- **FR-410 — "+N" affix.** The remaining `chips.length - 1` chips collapse behind a small, real
  `<button type="button">` (not a `<span>` — must be keyboard-focusable/operable) rendered after the
  visible chip inside the existing `.gh-commit-row__refgutter` flex row: `flex: none` (never itself
  truncates), no type glyph, muted-ink text reading `+N` (e.g. `+1`, `+2`), `aria-label="{N} more refs
  on this commit — view all"`.
- **FR-411 — "+N" reveal mechanism.** Clicking the affix (or Enter/Space while it's focused) opens the
  existing `ContextMenu` component (`packages/desktop/src/components/ContextMenu/ContextMenu.tsx`) —
  reused verbatim, not a new component — anchored at the affix's own `getBoundingClientRect()`
  (bottom-left corner) as the `x`/`y` point, inheriting its already-hardened viewport-clamping,
  Escape/click-outside/scroll-dismissal, and focus-management behavior with zero new code in that
  component. Populated with one row per collapsed chip, in the same order as `chips`, each row:
  `disabled: true` (informational only — see Non-goals), `label` = the exact same accessible-label
  string `RefChip.tsx` already computes for that chip (`` `${TYPE_LABEL[type]}: ${name}` ``, including
  its existing "(diverged from its upstream)" suffix when applicable) — reusing that existing
  string-building logic rather than inventing new copy. No header/footer needed.
- **FR-412 — Individual truncation is supplemented, not replaced.** The one visible chip's own existing
  `.gh-refchip__label` ellipsis-truncation + `title` tooltip (RefChip.tsx/.css, unchanged) still
  applies if that single name alone exceeds the available width. This feature only removes the need to
  *split* the gutter's width across 2+ names; it does not change how a lone long name is handled.
- **FR-413 — `REF_GUTTER_WIDTH` stays at 100px; not touched by this spec.** Real arithmetic (using
  `layoutBudget.test.ts`'s own pinned baseline): at the app's default window size with BranchesPanel +
  DetailPanel both at default width, the subject column has 198px available today against a 150px
  legible floor — 48px of true headroom, but the suite's own regression-guard assertion
  (`expect(REF_GUTTER_WIDTH).toBeLessThanOrEqual(110)`) caps any headroom usable without editing that
  test to just +10px. Given FR-408–FR-411 already fix the actual reported problem (2 real chips
  squeezing each other) without spending any of that budget, reopening this already-once-regressed,
  explicitly-documented constant for a ~1-2-character gain on a lone long name isn't justified. No
  change to `graphGeometry.ts`'s `REF_GUTTER_WIDTH` constant or its doc comment in this spec.

## Non-goals

- Vertical stacking of chips — already explicitly rejected with the user; conflicts with the
  fixed-`ROW_HEIGHT` constraint `GraphCanvas`/`CommitRow` share (`CLAUDE.md` Known Pitfalls).
- Widening `REF_GUTTER_WIDTH` (FR-413) — arithmetic doesn't justify it given FR-408–FR-411 already
  solve the reported problem.
- Making the FR-411 popover's rows actionable (e.g. Checkout/Delete on a currently-collapsed
  local-branch chip) — v1 ships informational-only rows (`disabled: true`). A currently-collapsed
  local branch's right-click Checkout/Delete (`FR-55`) is not reachable from this popover in v1; it
  remains reachable via the Branches sidebar, unchanged. Revisit only if real usage shows this gap
  matters.
- Any change to `showHeadMarker`'s own already-shipped behavior/appearance (FR-407 explicitly
  excludes it from this feature's scope).
- A new standalone component for the "+N" popover — FR-411 reuses `ContextMenu` verbatim.
- Any change to which refs are visible at all (`visibleRefNames` filtering, `commit-graph.md` FR-15) —
  purely a rendering/layout change to refs already selected for display.
- Touching the type-glyph *shapes* (dot/ring/diamond/square) or the "never color alone" policy — only
  the glyph box size changes (FR-406).

## Acceptance criteria

1. A commit row with exactly one ref chip renders identically to today (no glyph-size regression
   aside, no "+N" affix, no collapse) — glyph size is the only visible change (FR-406, FR-408).
2. A commit row with exactly two ref chips (e.g. two local branches, neither checked out) shows one
   full chip (whichever is `chips[0]`) and a `+1` button; the other chip's full name is not rendered
   inline anywhere on the row (FR-408, FR-409 priority 3).
3. On the checked-out commit's own row, with the current branch plus one other branch/tag present:
   the "HEAD" badge (from `showHeadMarker`) renders exactly as it does today, uncollapsed; the
   *current branch's* chip is the one visible chip (not the other ref); the other ref collapses behind
   `+1` (FR-407, FR-409 priority 1).
4. A row with one real ref chip plus `showHeadMarker`'s badge (i.e. `chips.length === 1`) does **not**
   trigger collapse — FR-407/FR-408 (this is the regression this spec must not introduce: it would
   otherwise hide the HEAD badge or the sole real chip on the majority of "just checked out, no other
   ref" rows).
5. Clicking `+2` on a row with three collapsed-behind-it refs opens a floating list (the reused
   `ContextMenu`) showing all three refs' full names/types (not truncated), positioned to stay fully
   inside the viewport even when the row is near the window's bottom or right edge; pressing `Escape`
   or clicking outside closes it without side effects; scrolling the commit graph while it's open also
   closes it (inherited `ContextMenu` behavior, no new code).
6. Every row in the FR-411 popover is inert (clicking one does nothing — no checkout, no navigation)
   and each carries the same full type+name text a hover over the original chip's `title` would show,
   including the "(diverged from its upstream)" suffix for a diverged local branch.
7. A single ref chip whose name alone (e.g. `feature/merge-rebase-conflict-resolution`) still exceeds
   the gutter's available width once it is the sole visible chip still ellipsizes with its own `title`
   tooltip — unchanged existing behavior (FR-412).
8. `layoutBudget.test.ts` continues to pass unmodified — `REF_GUTTER_WIDTH` is untouched (FR-413).
9. The type glyph is visibly larger and distinguishable (dot vs. ring vs. diamond vs. square) in a
   real screenshot at both 100% and a high-DPI (e.g. 150–200%) display scale — **this criterion must be
   verified against real Electron screenshots, not DOM/class assertions or jsdom snapshots alone**,
   per this area's own documented regression history (`CLAUDE.md`'s `GraphCanvas` scroll-sync pitfall,
   `layoutBudget.test.ts`'s own "jsdom can't verify real layout" admission, and the
   `App.branchTagGutter.e2e.test.tsx` precedent for this exact component). CSS-only reasoning is not
   sufficient sign-off for this spec.
10. The "+N" affix is keyboard-reachable (Tab) and operable (Enter/Space opens the popover) without a
    mouse, and receives this system's standard visible focus treatment.
11. Behavior is identical regardless of git host, repo type (local-only, GitHub, GitLab, self-hosted,
    bare, submodule, worktree), or number of remotes — purely a rendering layer over refs already
    fetched by existing `git-core` calls; no new IPC or git process spawn introduced by this feature.
