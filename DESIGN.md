# Design

<!-- impeccable:design-note: recorded pre-build by explicit user request, ahead of the skill's
     normal post-build documenter pass, so the light/dark reasoning was captured while fresh.
     The commit graph surface has since shipped (packages/desktop) and was verified against
     this system via a real running-app pass (screenshots against all four fixture repos,
     see the merge commit) rather than the formal impeccable-documenter pass — the tokens and
     component specs below matched the build with one fix (a mislabeled detached-HEAD chip,
     corrected in code, not here). New surfaces should extend this file, not re-decide it. -->

## Direction contract

THESIS: GitHydra's interface treats the commit graph the way a transit map treats a rail
network — branches are lines, merges are interchange stations, commits are stops. Not
"hacker terminal," not "generic SaaS dashboard": a schematic-diagram grammar (Harry
Beck/London-Underground style — clean angled connectors, one deliberate color per line,
legible interchange nodes) applied to real git topology, because the metaphor is
structurally true to what a branch graph *is*, not decoration borrowed from elsewhere.

OWN-WORLD: Dark graphite UI ground by default (matches where developers actually work —
low-light, multi-monitor, alongside a terminal/IDE) with a validated light-theme
equivalent, same system. One restrained accent for UI chrome (selection, focus, primary
actions). Branch lanes each carry their own saturated color from a validated 8-hue
categorical set — functional data-encoding like transit lines, not brand decoration.
System UI font stack for chrome (workhorse, not a display face); monospace stack for
SHAs/diffs/metadata (functionally required for fixed-width alignment).

STORY: A developer opens a repo and immediately reads its shape — which lines are
branches, where they diverge and rejoin, where they are right now (HEAD) — the way a
commuter reads a transit map, not the way they'd parse `git log --graph` text.

FIRST VIEWPORT: The commit graph fills the window edge-to-edge — lanes as clean
angled/curved connectors, merge commits as filled interchange-style nodes, ref labels
(branch/tag/HEAD) as small pill chips at line-ends. No hero, no marketing chrome — the
graph *is* the product from pixel one.

FORM: Schematic transit-map diagram grammar, chosen directly with the user (pragmatic
path, not the dice-rolled catalog ritual — see new-work.md's "Create or replace the
visual world," skipped by explicit user choice in favor of speed across many v1
features).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish
review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.

## Mode

Operate. Expression never obscures task, state, or familiar affordance. Legibility and
information density outrank visual flourish; brand lives in precise details (the transit
grammar), not in surface decoration.

## Color strategy

Restrained: neutrals plus one accent, both themes selected (not an automatic light/dark
flip — each stepped and validated against its own surface). Branch-lane colors are a
separate categorical channel (data identity, not brand), validated with
`dataviz`'s `scripts/validate_palette.js` — both modes PASS on lightness band, chroma
floor, CVD separation (worst adjacent ΔE 9.1 light / 8.4 dark, target ≥8), and
normal-vision floor (≥15, worst 19.6 light / 19.3 dark). Light mode carries a contrast
WARN on 3 of 8 slots (aqua, yellow, magenta — below 3:1 on the light surface): the
required relief is already structural, not an add-on — ref chips and commit metadata
carry text labels, never color-only identity.

### Tokens — chrome & ink

| Role | Light | Dark |
|---|---|---|
| Page plane | `#f9f9f7` | `#0d0d0d` |
| Panel/surface | `#fcfcfb` | `#1a1a19` |
| Primary ink | `#0b0b0b` | `#ffffff` |
| Secondary ink | `#52514e` | `#c3c2b7` |
| Muted (labels, timestamps) | `#898781` | `#898781` |
| Gridline / hairline | `#e1e0d9` | `#2c2c2a` |
| Baseline / axis | `#c3c2b7` | `#383835` |
| Border (hairline ring) | `rgba(11,11,11,0.10)` | `rgba(255,255,255,0.10)` |
| Accent (selection, focus, primary action) | `#2a78d6` | `#3987e5` |

### Tokens — branch-lane categorical (fixed order, never cycled within a visible window; recycles from slot 1 only past 8 concurrent on-screen lanes, matching the commit-graph spec's lane-collapse behavior for high branch counts)

| Slot | Hue | Light | Dark |
|---|---|---|---|
| 1 | blue | `#2a78d6` | `#3987e5` |
| 2 | orange | `#eb6834` | `#d95926` |
| 3 | aqua | `#1baf7a` | `#199e70` |
| 4 | yellow | `#eda100` | `#c98500` |
| 5 | magenta | `#e87ba4` | `#d55181` |
| 6 | green | `#008300` | `#008300` |
| 7 | violet | `#4a3aa7` | `#9085e9` |
| 8 | red | `#e34948` | `#e66767` |

Note: slot 1 (blue) doubles as the UI accent above. A lane and a UI action never share
context (thin connector line vs. chip/button shape), so the reuse doesn't read as
identity confusion; revisit only if real screenshots show otherwise.

### Tokens — status (fixed, never themed; git file-status / operation-state use)

| Role | Hex | Use |
|---|---|---|
| good | `#0ca30c` | added / clean / fast-forward |
| warning | `#fab219` | modified / diverged |
| serious | `#ec835a` | conflicted (soft) / detached HEAD |
| critical | `#d03b3b` | deleted / conflict / error |

Always icon + label, never color alone (dark clears 3:1 on all four; light warning/serious
sit sub-3:1 by design, per `dataviz`'s status-palette rule).

## Typography

- UI chrome: `system-ui, -apple-system, "Segoe UI", sans-serif` — workhorse face, no
  display/serif anywhere. Operate-mode default per Impeccable's own guidance.
- SHAs, diffs, commit metadata, file paths: `ui-monospace, "Cascadia Code", "SF Mono",
  Consolas, monospace` — required for fixed-width alignment of hashes and diff columns.
- Tabular figures (`font-variant-numeric: tabular-nums`) reserved for columns that must
  align vertically (commit counts, file-change counts); proportional elsewhere.

## Component language (first surface: commit graph)

- **Lane**: 2px stroke, rounded joins, curves (not sharp elbows) at merges/branches, one
  categorical hue per concurrently-visible lane.
- **Commit node**: filled circle on its lane; interchange-style (larger, ringed) when a
  merge commit (2+ parents); octopus merges (3+) get a proportionally larger ring, not a
  new shape.
- **Ref chip**: small pill, text label (branch/tag/HEAD name), border in the owning
  lane's hue, filled background only for the current HEAD/checked-out ref — this chip is
  the light-mode relief channel for the 3 sub-3:1 categorical slots.
- **Detail panel**: slides in from the graph's edge on commit selection; monospace for
  SHA/dates, system sans for prose (commit message body).
- **Uncommitted-changes pseudo-node**: visually distinct from a real commit (dashed ring
  or hatched fill, never a solid node) per FR-18 — must not be mistakable for a
  selectable SHA target.

## Open for later surfaces

Diff viewer, branch panel, and conflict-resolution UI inherit this system (lanes/ink/
type) rather than re-opening the world; new component-language entries get appended
here as they're built, not re-litigated.
