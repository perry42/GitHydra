---
target: packages/desktop/src/components/RefChip/RefChip.tsx (commit-graph ref-chip gutter)
total_score: 17
max_score: 36
na_heuristics: 9
p0_count: 2
p1_count: 1
timestamp: 2026-09-28T23-04-06Z
slug: ackages-desktop-src-components-refchip-refchip-tsx
---
## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2/4 | Current/detached/diverged states are all encoded, but at 11px text / 8px glyph they're barely visible per the user's own complaint. |
| 2 | Match System / Real World | 2/4 | dot/ring/diamond/square is a learned vocabulary, not a recognized convention; worse, the branch glyph visually echoes the graph's own commit-node dot one column over. |
| 3 | User Control and Freedom | 2/4 | "+N" popover exists for crowded rows, but no way to widen the gutter or escape truncation on an ordinary single-chip row without a hover. |
| 4 | Consistency and Standards | 2/4 | Internally consistent with itself; diverges hard from the near-universal colored-pill ref-label convention users bring from GitKraken/GitHub Desktop/Fork. |
| 5 | Error Prevention | 3/4 | Real engineering care already here (double-context-menu prevention, keyboard-bubbling guard on the "+N" button), both from actual caught bugs. |
| 6 | Recognition Rather Than Recall | 1/4 | Truncating `docs/ref-chip-gutter-spec` to `docs/ref-ch…` forces recall/hover instead of glance-recognition — the crux of the complaint. |
| 7 | Flexibility and Efficiency | 1/4 | No resizable gutter, no setting; "+N" costs power users an extra click per crowded row. |
| 8 | Aesthetic and Minimalist Design | 2/4 | Minimalist in chrome/color (good), not in information density — up to 5 visual facts stacked in 100px on a HEAD+multi-ref row. |
| 9 | Error Recovery | n/a | No error states exist in a read-only label column. |
| 10 | Help and Documentation | 2/4 | `title`/`aria-label` carry the full name, but mouse-hover only; no in-product legend for the glyph vocabulary. |
| **Total** | | **17/36** | **Poor (≈47%)** |

## Design Specificity Verdict

**Intent: specific and authored. Execution: currently reads generic — and in one respect worse than generic.**

DESIGN.md's "Ref chip" entry is a real, bespoke thesis (transit-map metaphor: color belongs to the *lane*, never the *station name*; no background fill, no border color, filled/bold ink for current, italic+dashed for detached). That's genuine product-specific thinking.

But what actually renders doesn't deliver that thesis: an 8×8px ink-colored **circle** glyph (branch type) sits a few pixels from the graph's own **commit-node circle** (also 8px), inside a fixed 100px column that most real branch names in this very repo blow past, leaving 3-12 legible characters per row. A generic off-the-shelf "small tag in a narrow column" component would probably not have accidentally reused the row's own node-glyph vocabulary — that collision is a bespoke problem this bespoke design created for itself.

**Deterministic scan**: `detect.mjs` returned zero findings against both `RefChip/` and `CommitGraph/` (exit 0, empty JSON both times) — no false positives to explain, but also nothing useful: this class of bug (real-world truncation severity) isn't in this generic detector's rule set.

**Real evidence (independent Playwright-Electron measurement, this repo's own actual branch names, not synthetic worst-cases)**: every one of 5 real single-chip rows tested was visually truncated to ~10-12 characters regardless of the full name's length — and in every case the cut lands inside the `fix/`/`docs/`/`feat/` type prefix, before the part of the name that actually distinguishes it from its siblings:

| Branch (full name, length) | Visible text | Chars shown / full |
|---|---|---|
| `fix/context-menu-viewport-clamp` (31) | `fix/context-…` | 12 / 31 |
| `docs/keyboard-shortcuts-specs` (29) | `docs/keybo…` | 10 / 29 |
| `docs/ref-chip-gutter-legibility` (31) | `docs/ref-ch…` | 11 / 31 |
| `feat/online-sync-clone` (22) | `feat/online…` | 11 / 22 |
| `fix/keyboard-shortcuts-label-truncation` (39) | `fix/keyboar…` | 11 / 39 |

Full name is always recoverable via `title`/`aria-label` (verified for all 5) — this is a *sighted-glance* legibility bug, not a data-loss or accessibility bug. Glyph size itself measured a clean 8×8px on every row — the size fix from two days ago holds; it isn't the cause of "too many info."

## Overall Impression

The fixed 100px gutter isn't failing on an edge case — it fails on the **majority case** for a repo that actually uses descriptive branch names (which this very project does). The distinguishing part of nearly every real name is exactly what gets cut. Two compounding problems, not one: (1) the column is too narrow for real names, and (2) the branch-type glyph (a filled circle) is visually near-identical to the graph's own commit-node dot one column over, adding a second kind of confusion on top of the truncation.

## What's Working

- The plain-ink "never color alone" thesis is real design conviction worth keeping — it deliberately avoids GitKraken's own channel conflation (color used simultaneously for lane identity, label category, and per-author avatars), which DESIGN.md's "Color strategy" section already correctly rejects.
- Accessibility plumbing is solid: `refChipAccessibleLabel()` is a single source of truth for the full name + type + divergence state, reused verbatim by the "+N" popover — truncation is sighted-only, never an assistive-tech gap.
- The team is iterating from real evidence already (the `iconOnly` HEAD-badge fix two days ago, the documented 160→100px gutter-width history, a double-context-menu fix) — this is real prior art, not a blank slate.

## Priority Issues

**[P0] Fixed 100px column truncates almost every real branch name to an unreadable, indistinguishable prefix.** Confirmed with this repo's own real names: 10-12 characters survive regardless of full length, always cutting before the distinguishing suffix (`-viewport-clamp`, `-specs`, `-legibility`, `-label-truncation`). Every `fix/…`-prefixed branch becomes visually identical to every other `fix/…` branch. This breaks the graph's core promise — "find your branch at a glance" — for exactly the naming convention this project itself uses.
**Why it matters**: a user scanning for a specific branch among several `fix/…`/`docs/…` rows cannot tell them apart without hovering each one individually — this is the direct cause of "too many info" (dense, illegible rows) and "not like i asked" (the user expects to read a name, not decode a fragment).
**Fix**: either make the gutter width adaptive/resizable rather than a hardcoded constant, or truncate intelligently (keep the meaningful suffix, not the generic prefix) — a straight ellipsis-at-end strategy is actively the worst choice for `type/scope-description` naming.
**Suggested command**: `/impeccable layout`

**[P0/P1] The local-branch glyph (8px filled circle) visually duplicates the graph's own commit-node glyph (also an 8px circle) one column to its right.** Two unrelated objects share an identical shape, disambiguated only by position/color — the inverse of this system's own "never color alone" policy.
**Why it matters**: this is the "glyph not ok" complaint — at a glance, the ref-type dot and the commit-node dot are the same shape, adding a second source of confusion on the same row.
**Fix**: give ref glyphs a shape family with zero overlap with the node vocabulary (e.g., a small branch-fork icon) instead of dot/ring. This is directly adoptable from GitKraken's own actual icon choice (a fork glyph, not a dot) and does **not** conflict with the transit-map thesis — that policy is about color, not shape.
**Suggested command**: `/impeccable typeset` or `/impeccable layout`

**[P1] HEAD marker + branch chip + "+N" stack as 3+ independently-truncating elements on exactly the row a user cares most about** (the checked-out tip). The `iconOnly` fix shipped two days ago removed the HEAD *text* but not the *glyph count* — there are still 2-3 separate glyphs competing for space on that row.
**Why it matters**: the checked-out row is the single highest-value row in the whole graph, and it's still the most crowded one.
**Fix**: merge into one compound token when HEAD and the current branch coincide, rather than two glyphs each fighting for space. GitKraken's own top-row treatment (one grouped badge, not two adjacent glyphs) is directly applicable and doesn't touch color.
**Suggested command**: `/impeccable layout`

**[P2] "+N" hides ref identity behind a click with no inline preview**, forcing a user hunting for a specific tag/branch on a crowded row to open a popover instead of scanning.
**Fix**: a hover-preview flyout reusing the already-built `refChipAccessibleLabel()` strings — no new copy needed.
**Suggested command**: `/impeccable delight` or `/impeccable layout`

**[P3] No taught legend for the dot/ring/diamond/square vocabulary** anywhere persistent — discoverable only per-chip via hover. Minor since the tooltip text is accurate, just not proactive.
**Suggested command**: `/impeccable onboard`

## Persona Red Flags

**Alex (power user scanning a busy repo for a specific branch)**: Fails on direct evidence. The measured rows — `fix/…`, `docs/ref-ch…`, `fix/context-…`, `fix/keyboar…`, `docs/keybo…` — are visually indistinguishable from each other. Alex cannot scan-and-stop; he must hover row-by-row, defeating the entire point of a graph tool built for fast visual lookup.

**Sam (screen-reader/keyboard-only)**: Better served at the semantic layer — full name always in `aria-label`, "+N" is a real focusable button with a descriptive label and hardened Enter/Space handling. Two real gaps found in the code: (1) the chip's outer `<span>` carries `title`/`aria-label` but no `tabIndex` — a keyboard-only user has no way to focus an individual chip to reach its tooltip when there's no "+N" affix on that row (the common single-chip case). (2) No confirmed focus-return behavior after the "+N" popover closes.

## Minor Observations

- The Branches sidebar (a different component, out of scope for this critique) shows the same real branch names truncating similarly (`fix/context-...`) — flagged in case a broader legibility pass is wanted later, not measured here.
- Detector (`detect.mjs`) came back completely clean on both directories — expected, since real-world truncation severity isn't a rule a generic static scanner catches; the real-Electron measurement was what actually substantiated the P0 finding.

## Questions to Consider

- What if the gutter had no fixed *width*, only a fixed *left edge* — preserving the "stable station position" argument while letting content width (plus a user drag-handle) do what GitKraken's unconstrained label already does, without abandoning the transit-map anchor?
- What if "browse all refs on this commit" moved entirely into the Branches panel GitHydra already ships, letting the gutter show only the one ref that matters (current/HEAD) and nothing else?
- Is the local vs. remote-tracking glyph distinction (dot vs. ring) solving a distinction most users ever need at a glance — would dropping it free enough legibility budget for the name itself?
