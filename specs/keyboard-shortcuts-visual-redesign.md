# Keyboard shortcuts — keycap visual redesign

## Problem

Every keyboard shortcut in the app today — the Command Palette's per-row hint
(`CommandPalette.tsx`'s `.gh-command-palette__shortcut`) and the Keyboard Shortcuts reference
screen's per-row shortcut column (`KeyboardShortcutsScreen.tsx`'s `.gh-keyboard-shortcuts__shortcut`)
— renders via `keyComboLabel()` as a single small, muted, plain-text string (e.g. `"Ctrl+K"`, or
`"Ctrl+R / F5"` for a two-combo command). It reads as ordinary body text, not as "a key" — no visual
distinction from any other muted label in the UI. Users coming from GitKraken/Sourcetree/Fork/VS
Code expect shortcut hints to render as friendly, physical-looking "keycap" chips (individually
bordered/rounded per key, joined by a `+`), not a flat inline string. This is the `ROADMAP.md`-tracked
"keyboard shortcuts reference screen wants its own design/UX pass" entry's visual half — the
discoverability half (a toolbar `⋯` entry point) already shipped separately; the screen's own
layout/content, specifically its shortcut rendering, was never itself redesigned.

## Target user

Any GitHydra user, on any git host or none — pure local rendering change, identical regardless of
repo state, host, or remote presence.

## Must-have behavior

- FR-387: A new shared, reusable presentational component, `KeyCap`
  (`packages/desktop/src/components/KeyCap/KeyCap.tsx`), rendering one visual "keycap" chip per
  individual key token in a combo (e.g. `Ctrl+K` renders as two adjacent chips, "Ctrl" and "K",
  joined by a small `+` glyph — never one chip containing the whole string). Takes a `KeyCombo`
  (`platform.ts`) and internally decomposes it into ordered key-label parts. A new helper,
  `keyComboParts(combo: KeyCombo): string[]`, added to `platform.ts` alongside `keyComboLabel`, reuses
  the exact same mod/shift/key logic `keyComboLabel` already has (e.g. `["Ctrl", "K"]`,
  `["Ctrl", "Shift", "F"]`) — `keyComboLabel` itself is re-expressed as `keyComboParts(combo).join("+")`
  so there is exactly one place that decides key ordering/capitalization, not two independently
  maintained.
- FR-388: Visual treatment, deliberately reconciled with `DESIGN.md`'s existing "flat by default —
  no shadow except the one reserved always-on-top-modal context" system-wide rule: each `KeyCap` chip
  is **flat, no `box-shadow`** — rounded (`var(--gh-radius-sm)`, the same radius buttons already use),
  `1px solid var(--gh-border)` ring, a background one step off the surrounding surface (`--gh-page`
  against a `--gh-surface` parent, the same "flat, bordered where separation is needed" pattern
  `DESIGN.md` already documents elsewhere), and a visually heavier bottom border (e.g. 2px, a shade
  darker than the ring) reading as a keycap's bottom edge/lip. Label text uses the existing `gh-mono`
  class. This achieves "friendly, physical-looking key" through shape/border alone, not a bevel/glow
  effect this design system doesn't otherwise use anywhere outside `ConfirmDialog`-style modal
  overlays.
- FR-389: Multiple combos for one command (e.g. Refresh's `Ctrl+R` / `F5`) still render as separate
  combo-groups joined by the existing `" / "` text separator — only the *within-a-combo* rendering
  changes from a flat string to per-key chips-plus-`+`; the between-combos separator is unchanged.
- FR-390: Every existing shortcut-rendering call site swaps its current plain-text span for `KeyCap`-
  based rendering of the same `KeyCombo[]` values it already has — `CommandPalette`'s row hint and
  `KeyboardShortcutsScreen`'s row shortcut column (including both `STATIC_SHORTCUT_ROWS` rows) all
  route through the one `KeyCap` component; no second, independently-styled implementation.
- FR-391: `CommandPalette`'s highlighted/selected row already inverts to `--gh-accent`/
  `--gh-accent-ink` (existing CSS); the new keycap chips must stay legible against that inverted
  background (chip border/background swap to an accent-safe variant on `.gh-command-palette__item--
  highlighted`), the same override `.gh-command-palette__item--highlighted .gh-command-palette__
  shortcut` already does for the old plain-text version.
- FR-392: Purely a rendering/component change over the exact same `KeyCombo[]` values `commands.ts`/
  `STATIC_SHORTCUT_ROWS` already produce — no change to which shortcuts exist, how they're matched, or
  their availability logic. No new IPC, no new state, no git-core change.
- FR-393: No other layout change to `KeyboardShortcutsScreen` bundled into this spec (category
  headings, two-column grid, close button, row grouping/order all unchanged) — this spec scopes
  narrowly to the per-row shortcut visual only, satisfying the `ROADMAP.md` entry without reopening
  the whole screen's layout.

## Non-goals

- Any change to which shortcuts exist, their key combos, categories, or availability rules.
- A user-facing setting to toggle this visual style on/off — one visual language, always on.
- New color tokens beyond `DESIGN.md`'s existing `--gh-border`/`--gh-surface`/`--gh-page`/`--gh-ink-*`
  palette, unless ui-graphics finds contrast genuinely insufficient in dark theme using only those —
  flag back if so, don't invent tokens speculatively.
- Any change to the Toolbar's `⋯` menu entry point (already shipped) — this spec only touches the
  reference screen's/palette's row-level shortcut rendering.
- Press-down/depress animation on click, or any other interactivity — this is a static reference
  display, not a virtual keyboard.
- The rebinding/edit affordance described in `specs/keyboard-shortcut-rebinding.md` — that spec
  consumes this one's `KeyCap` component but is a separate, larger feature.

## Acceptance criteria

1. Every shortcut hint currently rendered via `keyComboLabel` (Command Palette rows, Keyboard
   Shortcuts reference screen rows, including both static rows) instead renders one `KeyCap` chip per
   individual key in the combo, joined by a `+` glyph within a combo and the existing `" / "` text
   separator between multiple combos for one command (e.g. Refresh shows "Ctrl"+"R" chips, then
   " / ", then an "F5" chip, on Windows/Linux).
2. Each `KeyCap` chip renders with no `box-shadow`, a `1px solid var(--gh-border)` ring,
   `var(--gh-radius-sm)` corners, and a visually distinct (heavier) bottom border — verifiable via
   computed style / class assertions, not a visual-only claim.
3. In `CommandPalette`, a highlighted/selected row's keycap chips remain legible (explicit style/class
   override present) against that row's inverted accent background.
4. `App.commandPalette.e2e.test.tsx`, `App.keyboardShortcuts.e2e.test.tsx`, `CommandPalette.test.tsx`,
   and `KeyboardShortcutsScreen.test.tsx` all still pass unmodified in behavior (only DOM structure for
   shortcut rendering changes) — no functional regression from this rendering-only change.
5. Works identically regardless of git host, repo state, or bare-repo status — this surface has no
   repo/network dependency today and this change doesn't introduce one.
