# Ref-chip gutter redesign: wider column, visible chip border, literal type icons

## Problem

A fresh dual-agent UX critique (2026-09-29), validated via real Electron screenshots against this
repo's own actual branch names, found the ref-chip gutter shipped by
`specs/ref-chip-gutter-legibility.md` (FR-406–413) still fails in the majority case, not a rare edge
case:

1. **The 100px gutter (FR-413) truncates real names before their distinguishing part.** Testing this
   repo's own branches (`fix/context-menu-viewport-clamp`, `docs/keyboard-shortcuts-specs`,
   `docs/ref-chip-gutter-legibility`, `feat/online-sync-clone`,
   `fix/keyboard-shortcuts-label-truncation`) as a single, non-collapsed chip: every one truncated to
   ~10-12 visible characters, and in every case the cut landed **inside** the `fix/`/`docs/`/`feat/`
   type prefix — before the part of the name that actually distinguishes it from its siblings. This
   project's own naming convention makes this the common case, not an outlier.
2. **The type-glyph vocabulary (dot/ring/diamond/square) collides with the graph's own vocabulary.**
   The local-branch glyph (`.gh-refchip__icon--branch`, an 8×8px filled circle) is shape-identical to
   the graph's own commit-node dot (`NODE_RADIUS = 4`, `graphGeometry.ts`), one column to the right —
   two unrelated objects sharing one shape, disambiguated only by position.
3. **A truncated fragment reads as loose text, not a labeled object.** With no visible chip boundary,
   a clipped name (e.g. "fix/co…") doesn't visually announce itself as a discrete, hoverable thing —
   unlike GitKraken's own chips, which (per a corrected read of the reference screenshots — GitKraken
   *also* truncates and collapses multiples behind a "+1"-style affix, same architecture GitHydra
   already ships) do carry a visible border, plus literal recognizable per-type icons instead of
   abstract shapes.

Not data loss — every chip still carries its full name via `title`/`aria-label`
(`refChipAccessibleLabel()`) — this is a sighted-glance legibility/recognizability problem, same
category as the prior spec, on the same component.

This spec reopens FR-413's "REF_GUTTER_WIDTH stays at 100px, not touched" decision on purpose. That
decision was correct given the evidence at the time (two real chips squeezing each other, solved by
FR-408–411's collapse mechanism, arithmetic not clearly justifying more). The new evidence above is
different: even a single, non-collapsed chip — the common post-collapse case FR-408-411 already
produces — fails on this project's own real names. That's new information, not scope creep.

## Target user

Any GitHydra user viewing the commit graph on any repo, local or remote-backed, using a `type/scope`
or similarly-prefixed branch naming convention (a majority convention among working git users, not
GitHydra-specific) — i.e. effectively every user browsing a repo with more than a handful of
branches/tags.

## Must-have behavior

FR numbers continue from `specs/ref-chip-gutter-legibility.md`'s FR-413.

- **FR-414 — Widen `REF_GUTTER_WIDTH` to its real arithmetic ceiling: 148px.**
  `layoutBudget.test.ts`'s own pinned real-window arithmetic gives
  `availableForSubject = 298 - REF_GUTTER_WIDTH` (at the app's default 1388px window content width,
  default BranchesPanel (340px) + DetailPanel (560px) widths, and a realistic busy-row 4-lane count),
  which must stay `>= 150` (`SUBJECT_LEGIBLE_MIN_WIDTH`). Solving that inequality: **148px is the
  exact, already-derivable ceiling** (`298 - 148 = 150`, the floor exactly) — not an arbitrary bigger
  constant. This is the same 48px of headroom the prior spec's own FR-413 identified and declined to
  spend (`100 + 48 = 148`); the only thing that changed is the justification for spending it.
  Concretely:
  - `graphGeometry.ts`: `export const REF_GUTTER_WIDTH = 148;` — update the constant's doc comment to
    append this spec's reasoning as a second historical entry (following the existing 160→100 entry's
    own convention), recording *both* the new value and why 100 turned out to be leaving real headroom
    unused.
  - `layoutBudget.test.ts`: the two arithmetic-relationship tests ("leaves the subject column a legible
    width…" and "documents the regression…old 160px…") must continue to pass **unmodified** — they
    test the actual relationship, not a hardcoded cap, and 148 satisfies both. The separate hard
    numeric guard (`expect(REF_GUTTER_WIDTH).toBeLessThanOrEqual(110)`, with its "still fails loudly if
    REF_GUTTER_WIDTH regresses back toward 160" comment) must be updated: raise the ceiling to reflect
    148 as the new deliberate value and rewrite the comment to explain this is an intentional, spec'd
    widening (with its own justifying evidence), not the regression the original guard was written to
    catch. Do not simply delete the guard — keep it re-pinned at the new number so a *future*
    accidental creep back toward 160 (or beyond 148) still fails loudly.
  - `Toolbar.css`'s comment referencing `REF_GUTTER_WIDTH`'s "single-chip max-width" convention should
    be checked for staleness and updated if it quotes the old 100px number by name.
  - No other consumer needs code changes — `CommitRow.tsx`, `GraphCanvas.tsx`, and their existing tests
    already reference the `REF_GUTTER_WIDTH` constant symbolically, not a hardcoded pixel value, and
    will pick up 148 automatically.

- **FR-415 — Give every ref chip a visible, neutral-ink border.** `.gh-refchip` gains
  `border: 1px solid var(--gh-border)` (the existing neutral hairline token — NOT
  `--gh-border-subtle`, which is too faint at this text scale to read as a discrete boundary; NOT a
  lane hue) plus a small `border-radius` (e.g. `3px`) and enough horizontal padding (e.g. `0 4px`) that
  the border doesn't crowd the icon/label against it — `box-sizing: border-box`, chip height stays
  `18px` unchanged. This border color/weight is identical across every chip state
  (`filled`/`detached`/plain) — it is not a second signal layered on top of the existing
  bold/italic/dashed-underline state treatments, just a constant object-boundary. This is a narrow,
  explicitly-scoped exception to DESIGN.md's "Ref chip" entry ("no border, no background pill, no
  lane-hue color") — the exception is the border itself (sourced only from a neutral ink token, never
  a lane hue), not a reversal of the broader policy: still no background fill, still no lane color on
  the label, still no color-alone signaling anywhere on the chip.

- **FR-416 — Replace the abstract dot/ring/diamond/square type-glyphs with literal, recognizable
  icons**, reusing `Icon.tsx`'s existing 18×18/`currentColor`/2px-stroke vocabulary and its existing
  small-icon-in-a-chip precedent (`IconWarning`, already shipping inside this exact component at
  `size={props.size ?? 14}`) rather than inventing a new size or a new file:
  - **Local branch**: reuse the existing `IconBranches` icon verbatim (already means "branch"
    everywhere else in the app — Toolbar, BranchesPanel) — no new shape drawn.
  - **Tag**: new `IconRefTag` added to `Icon.tsx` — a literal price-tag shape (tag body + punch-hole),
    following `IconBase`'s conventions.
  - **Remote-tracking branch**: new `IconRefRemote` added to `Icon.tsx` — a literal cloud shape,
    following `IconBase`'s conventions.
  - **HEAD (the detached-HEAD ref-decoration chip, `decoration.type === "head"` — NOT the separate
    `showHeadMarker` badge, which FR-407 already excluded from this component's scope and remains
    untouched)**: new `IconRefPin` added to `Icon.tsx` — a literal map-pin/drop-marker shape.
    Deliberately not a checkmark: `IconCheck` already carries a distinct, established meaning
    elsewhere (`ContextMenu`'s radio-style "currently selected" rows) — reusing it here would overload
    that vocabulary rather than extend it.
  - All four default to `size={14}` in this context (matching `IconWarning`'s own already-shipped
    precedent for this exact 11px-label chip, so the row doesn't grow a third distinct icon size),
    render in `currentColor` with no explicit color prop (so a `filled` chip's primary-ink/bold state
    still colors its icon automatically, no separate color logic needed), and stay `aria-hidden` —
    the chip's own `title`/`aria-label` remains the sole accessible name, unchanged.
  - `RefChip.tsx`: replace the `<span className="gh-refchip__icon ...">` div-based glyph with the
    matching icon component per `decoration.type`. `RefChip.css`: remove
    `.gh-refchip__icon`/`--branch`/`--remote`/`--tag`/`--head` rules entirely (superseded).
  - Every new/reused icon here must remain visually distinguishable, at this chip's rendered size,
    from the graph's own commit-node dot (`NODE_RADIUS = 4` filled circle) — this is the fix for the
    shape-collision finding above; a literal fork/cloud/tag/pin shape at 14px against a plain 4px-radius
    filled circle satisfies this by construction, but this must still be visually confirmed (AC7).

## Non-goals

- **Reserving a dedicated, never-reused color for the checked-out branch's graph lane.** A real,
  separate idea raised alongside this critique, but it touches `GraphCanvas.tsx`'s lane-coloring
  algorithm — a different, more fragile component with its own documented scroll-sync pitfall
  (`CLAUDE.md`). Tracked as a follow-up idea only; not specified here.
- **A GitKraken-style filled/colored pill background.** Explicitly rejected by the user — conflicts
  with the transit-map thesis (color belongs to the lane, never the label/chip fill).
- **Any change to which refs are visible, IPC, or git-core.** Purely a rendering-layer change over
  refs already fetched by existing calls.
- **The "+N" collapse mechanism, its popover, the HEAD-badge `iconOnly` fix, or the tooltip/
  `aria-label` fallback** (`specs/ref-chip-gutter-legibility.md` FR-407–411) — all unchanged, reused
  as-is.
- **Reopening the general "never color alone" / "color is the lane's identity" policy** beyond the one
  narrowly-scoped neutral-ink chip border in FR-415.

## Acceptance criteria

1. `REF_GUTTER_WIDTH` is `148` in `graphGeometry.ts`; `layoutBudget.test.ts`'s two arithmetic tests
   pass unmodified, and its hard numeric cap assertion is updated (no longer `<=110`) to re-pin at the
   new deliberate ceiling with an updated comment — not deleted (FR-414).
2. Every existing test that references `REF_GUTTER_WIDTH` symbolically (`CommitRow.test.tsx`,
   `App.branchTagGutter.e2e.test.tsx`, etc.) passes unmodified against the new value with no hardcoded
   `100`/`148` literals needed in those files.
3. Every `.gh-refchip` renders with a visible 1px neutral border (`var(--gh-border)`) in both light and
   dark theme, with no background fill and no lane-hue color anywhere on the chip, in every state
   (`filled`, `detached`, plain, diverged) (FR-415).
4. The local-branch, tag, remote-branch, and detached-HEAD ref chips each render a distinct, literal
   icon (fork/reused `IconBranches`, price-tag, cloud, pin respectively) — no dot/ring/diamond/square
   shapes remain anywhere in `RefChip.css`/`.tsx` (FR-416).
5. **Real-Electron screenshot verification, using this repo's own actual branch names** (not synthetic
   short ones) — consistent with this area's established regression-testing convention
   (`App.branchTagGutter.e2e.test.tsx`, `App.branchTagGutter... GraphCanvas` precedent,
   `layoutBudget.test.ts`'s own "jsdom can't verify real layout" admission): create local branches
   (recreating them if no longer live, since only the literal string matters for this rendering-only
   feature) named `fix/context-menu-viewport-clamp`, `docs/keyboard-shortcuts-specs`,
   `docs/ref-chip-gutter-legibility`, `feat/online-sync-clone`, and
   `fix/keyboard-shortcuts-label-truncation` pointing at distinct commits in a real temp repo, launch
   the real app at its documented default window size (1400×900) with BranchesPanel + DetailPanel both
   at default width, and confirm via screenshot that each name's single, non-collapsed chip now shows
   its full type prefix (`fix/`, `docs/`, `feat/`) plus a meaningfully longer visible fragment of the
   distinguishing suffix than the pre-fix ~10-12-character/mid-prefix cut — not necessarily the full
   name (the `title`/`aria-label` fallback remains the source of truth for anything still clipped).
   CSS-only reasoning or DOM/class assertions alone are not sufficient sign-off for this criterion.
6. The same real-Electron screenshot pass in AC5 also visually confirms: (a) the new chip border is
   visible and reads as a discrete boundary at this text scale in both themes, (b) each type-glyph icon
   is legible and distinguishable from the others and from the graph's own commit-node dot, at both
   100% and a high-DPI (e.g. 150-200%) display scale — same dual-scale convention
   `ref-chip-gutter-legibility.md`'s AC9 already established for this component.
7. On a branch-heavy row (4+ concurrent lanes, matching `layoutBudget.test.ts`'s own
   `REALISTIC_BUSY_ROW_LANE_COUNT`), the commit subject text is still visible and legible at the app's
   documented default window size with both side panels open at default width — i.e. FR-414's widening
   has not silently reintroduced the original "subject pushed entirely off-screen" regression this
   area's tests already guard against.
8. Behavior is identical regardless of git host, repo type (local-only, GitHub, GitLab, self-hosted,
   bare, submodule, worktree), or number of remotes — no new IPC or git process spawn introduced by
   this feature.
9. Every icon added or reused in FR-416 remains `aria-hidden`; the chip's accessible name/tooltip
   (`refChipAccessibleLabel()`) is byte-for-byte unchanged from today (this spec only changes the
   sighted-glance rendering, never the accessible-name string).
