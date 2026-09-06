# Design

<!-- impeccable:design-note: recorded pre-build by explicit user request, ahead of the skill's
     normal post-build documenter pass, so the light/dark reasoning was captured while fresh.
     The commit graph surface has since shipped (packages/desktop) and was verified against
     this system via a real running-app pass (screenshots against all four fixture repos,
     see the merge commit) rather than the formal impeccable-documenter pass — the tokens and
     component specs below matched the build with one fix (a mislabeled detached-HEAD chip,
     corrected in code, not here). New surfaces should extend this file, not re-decide it.

     Update (post stage/unstage + diff, and the DetailPanel auto-diff follow-up pass): the
     Component language section below now also records what those two shipped surfaces
     established (ChangesPanel, DiffView, ConfirmDialog, FileStatusIcon, and DetailPanel's
     revised two-region layout). Documented from the built code in
     packages/desktop/src/components/{ChangesPanel,DiffView,ConfirmDialog,FileStatusIcon,
     DetailPanel}/ — no new tokens were introduced; every value below resolves to an existing
     chrome/ink/status token or the existing monospace convention. -->

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
| Page plane | `#f2f1ed` | `#0d0d0d` |
| Panel/surface | `#ffffff` | `#1a1a19` |
| Primary ink | `#0b0b0b` | `#ffffff` |
| Secondary ink | `#52514e` | `#c3c2b7` |
| Muted (labels, timestamps) | `#898781` | `#898781` |
| Gridline / hairline | `#e1e0d9` | `#2c2c2a` |
| Baseline / axis | `#c3c2b7` | `#383835` |
| Border (hairline ring) | `rgba(11,11,11,0.10)` | `rgba(255,255,255,0.10)` |
| Accent (selection, focus, primary action) | `#2a78d6` | `#3987e5` |

**Light page/surface raised (design pass, fix #3):** `#f9f9f7`→`#f2f1ed` (page) and
`#fcfcfb`→`#ffffff` (surface), replacing this table's original pair. Reason: a dual-agent design
critique comparing a real screenshot of the shipped app against this file's own ambition found the
two light-mode planes sat only about 1% apart in lightness — panels (Toolbar, ChangesPanel,
BranchesPanel, etc.) read as the exact same flat plane as the page behind them instead of a
distinct surface, undermining the depth the component language elsewhere relies on (bordered
cards, panel dividers). Re-validated via the `dataviz` skill's `validate_palette.js` against the
existing ink tokens before landing: `--gh-ink-primary` (`#0b0b0b`), `--gh-ink-secondary`
(`#52514e`), and `--gh-ink-muted` (`#898781`) all clear contrast against both new values. Dark
mode's tokens (`#0d0d0d`/`#1a1a19`) were left untouched — already validated, already reading with
real separation. No other chrome/ink token, branch-lane hue, or status token changed in this pass.

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
identity confusion; revisit only if real screenshots show otherwise. (Ref chips are no
longer part of this "chip/button shape" reuse at all, since the branch/tag/HEAD gutter pass
below removed lane-hue coloring from ref chips entirely — the reuse now only concerns actual
UI-action chips/buttons, e.g. Toolbar's accent-bordered panel toggles.)

**Evaluated and held at 8 (design pass, prompted by the GitKraken reference screenshots looking
more colorful):** counted concurrent *lane* hues actually visible on-screen in the two real
GitKraken screenshots supplied as reference (`191bd7d4-image.png`, an `electron` repo view;
`8226354a-image.jpg`, `nodegit`) rather than assuming more color variety meant a larger palette.
`191bd7d4` shows about 5 concurrent lane hues (teal, magenta, violet, orange, an olive/yellow-
green) across a merge-heavy, 1181-commit view; `8226354a` shows about 3 (teal, purple, magenta) in
its visible viewport. Both sit comfortably inside our existing 8-slot budget — neither screenshot
is evidence GitKraken's actual lane-color set is larger than ours. Most of the *extra* perceived
color variety in both images is a separate channel entirely: GitKraken's per-author avatar
badges (colored initials/mascot icons on each commit node) encode author identity, not branch
lane — a dimension GitHydra's transit-map grammar deliberately doesn't conflate with lane color
(THESIS above: "one deliberate color per line"). Recommendation: hold the categorical set at 8,
not expand it. The existing set is already validated (`dataviz`'s `validate_palette.js`) against
lightness/chroma/CVD-separation bands for both themes (worst adjacent ΔE 9.1 light / 8.4 dark,
against an ≥8 floor; worst normal-vision floor 19.6 light / 19.3 dark, against a ≥15 floor) — adding
more slots would tighten those margins and risks reintroducing failures the light mode's existing 3
WARN'd contrast slots (aqua/yellow/magenta) already sit close to. If more per-commit color variety
is wanted, a per-author avatar-badge channel (mirroring GitKraken's, rendered in GitHydra's own
visual language, never their icon set) is the more faithful lever — a distinct future product idea,
not part of this design pass.

### Tokens — status (fixed, never themed; git file-status / operation-state use)

| Role | Hex | Use |
|---|---|---|
| good | `#0ca30c` | added / clean / fast-forward |
| warning | `#fab219` | modified / diverged |
| serious | `#ec835a` | conflicted (soft) / detached HEAD |
| critical | `#d03b3b` | deleted / conflict / error |

Always icon + label, never color alone (dark clears 3:1 on all four; light warning/serious
sit sub-3:1 by design, per `dataviz`'s status-palette rule).

Shipped usage confirms the mapping holds beyond the graph surface: `changedFileStatusColorVar`
(`packages/desktop/src/lib/format.ts`) resolves added → good, modified/type-changed/copied/
renamed → warning, unmerged (conflict) → serious, deleted/unknown → critical — the same four
tokens, applied to working-directory and diff file status rather than graph nodes. Diff line
coloring (below) extends the same pair (good/critical) to add/remove lines.

## Typography

- UI chrome: `system-ui, -apple-system, "Segoe UI", sans-serif` — workhorse face, no
  display/serif anywhere. Operate-mode default per Impeccable's own guidance.
- SHAs, diffs, commit metadata, file paths: `ui-monospace, "Cascadia Code", "SF Mono",
  Consolas, monospace` — required for fixed-width alignment of hashes and diff columns.
- Tabular figures (`font-variant-numeric: tabular-nums`) reserved for columns that must
  align vertically (commit counts, file-change counts); proportional elsewhere.

Confirmed in the shipped diff/changes surfaces: diff line numbers carry
`font-variant-numeric: tabular-nums` (`.gh-diff-view__line-no`) so old/new columns stay
aligned; file paths, SHAs, and the collapsed-metadata SHA summary all carry the shared
`gh-mono` class rather than a component-local font declaration.

## Component language (first surface: commit graph)

- **Lane**: 2px stroke, rounded joins, curves (not sharp elbows) at merges/branches, one
  categorical hue per concurrently-visible lane.
- **Commit node**: filled circle on its lane; interchange-style (larger, ringed) when a
  merge commit (2+ parents); octopus merges (3+) get a proportionally larger ring, not a
  new shape. Node radius/shape encodes commit type only — selection is never expressed by
  resizing or re-ringing the node itself (see Selection halo, below).
- **Selection halo** (design-pass fix, `GraphCanvas.tsx`'s `drawSelectionHalo`): the
  selected commit's mark is an independent overlay layer, painted in its own pass after
  every node in the visible slice has already been drawn for its type — never interleaved
  with, and never changing, node geometry. Deliberately a different paint technique from
  the merge node's own ring (a single opaque stroke): a translucent accent-colored wash
  (a filled disc at reduced alpha) plus one crisp full-opacity outer contour line, at a
  radius offset from whatever node is underneath (small dot or large merge ring) — a
  halo/glow idiom, not "one more hollow interchange ring." Fixes the prior conflation
  where a selected merge commit read as two same-style rings stacked, and where an
  unselected merge commit could be mistaken for a selected regular commit at a glance.
  Regression-covered by `GraphCanvas.test.tsx`'s "selection halo vs. merge-node
  conflation" suite, which asserts the merge ring's radius is unchanged by selection and
  that the halo paints are provably a distinct technique at a distinct radius, strictly
  after all node-type art.
- **Ref chip** (revised, branch/tag gutter pass — `RefChip.tsx`/`CommitRow.tsx`): lives in a
  persistent gutter column *before* the graph canvas, present on every row as real reserved
  space (`REF_GUTTER_WIDTH`, `graphGeometry.ts`) even when a row has no ref — never a
  placeholder element, just an empty column. This replaces the prior placement (a pill "at
  line-ends," inline after the SHA, rendered only where a ref existed) because a fixed column
  reads as a stable transit-map "station name" position the eye can return to at a glance,
  rather than a label that jumps around the row depending on which lane happened to have a ref.
  The label itself is now plain ink text with a small type-glyph (dot/ring/diamond/square for
  branch/remote-branch/tag/HEAD, unchanged shapes) — no border, no background pill, no lane-hue
  color anywhere on the chip. Reason: the transit-map thesis is that color is the *lane's*
  identity, not the station name's — a real subway map prints station names in plain black
  beside a colored line, never colors the name text itself; coloring the label too was
  redundant with the lane it already sits beside once the two are visually adjacent instead of
  overlapping. The current/checked-out ref is now marked by primary ink + bold weight (was: a
  lane-hue-filled background); a detached HEAD is marked by an italic label with a dashed
  underline (was: a dashed border) — both changes keep the type/state distinction on
  text/icon/weight, never color, consistent with this system's "never color alone" policy.
  Consequence: this chip's border no longer serves as the light-mode relief channel for the 3
  sub-3:1 categorical lane slots (aqua/yellow/magenta) mentioned in "Color strategy" above — that
  relief was already structural for a different reason (ref chips and commit metadata carry text
  labels, not color-only identity), and remains true: the label text itself is the relief, not
  its former border hue.
- **Detail panel**: slides in from the graph's edge on commit selection; monospace for
  SHA/dates, system sans for prose (commit message body).
- **Uncommitted-changes pseudo-node**: visually distinct from a real commit (dashed ring
  or hatched fill, never a solid node) per FR-18 — must not be mistakable for a
  selectable SHA target.

## Component language (added: stage/unstage + diff, and the DetailPanel auto-diff pass)

- **DiffView** (`packages/desktop/src/components/DiffView/`): shared, presentational diff
  renderer used by both the Changes panel and the commit DetailPanel — one component, two
  callers, so diff rendering never forks. Heading and hunk body both carry the shared
  monospace convention (`gh-mono`); hunk header text sits in the accent color on the page
  plane (`var(--gh-accent)` on `var(--gh-page)`), visually distinct from the diff lines it
  introduces. Each line is a 4-column grid (old line no. / new line no. / +/- marker /
  content) with `tabular-nums` line numbers, right-aligned, muted ink — so add/remove/
  context rows stay column-aligned the way a diff has to. Add lines: `good`-token text and
  marker over a 14%-mixed `good` background tint; remove lines: the same treatment with
  `critical`. Context lines carry no tint, primary ink only — color marks change, not
  presence. Four explicit non-diff states are named states, not blank panes: loading
  ("Loading diff…", `aria-busy`), error (`role="alert"`, critical-ink), binary ("Binary
  file — content not shown"), and too-large (with the byte/line-count reason inlined) —
  plus an idle placeholder whose text a caller can override (`emptyMessage`) when there is
  nothing diffable at all (e.g. an all-conflicted working directory) rather than showing
  the generic "Select a file" copy where it would be misleading.
- **Changes panel** (`packages/desktop/src/components/ChangesPanel/`): a right-edge panel
  (680px, capped `80vw`, matching the DetailPanel's width for cross-panel consistency)
  divided into a fixed-width (300px) scrolling file-list column and a flexible scrolling
  diff column, separated by a hairline border — the same two-region split the DetailPanel
  now also uses (see below). Files are grouped into four labeled sections in a fixed order
  — Staged, Unstaged, Untracked, Conflicted — each heading uppercase, letter-spaced, muted
  ink, with a live count in parens. Each file row pairs a `FileStatusIcon` with the
  monospace path (rename rows show `oldPath → path`); the row is a selectable button
  (accent-bordered when selected) for any diffable category, or a plain (non-interactive)
  label for Conflicted rows, which carry no diff. Stage/Unstage/Discard sit as small
  bordered buttons at the row's trailing edge; Discard is styled in the `critical` token
  and always routes through ConfirmDialog rather than acting on click. A commit composer
  (subject + optional body) sits below the sections as the panel's terminal element, its
  submit button filled in the accent token and disabled (falls back to page/muted-border
  styling) until the form is valid. Three explicit non-file-list states — loading, error
  (with a Retry action), and bare-repository ("no working directory... nothing to stage,
  unstage, or commit") — replace the file-list body rather than leaving it blank.
- **ConfirmDialog** (`packages/desktop/src/components/ConfirmDialog/`): the system's one
  destructive-confirmation pattern — generic (title/message/confirmLabel), not
  discard-specific, so any future destructive action (branch delete, force-push, etc.)
  reuses it rather than growing a bespoke dialog. Centered modal over a 40%-black scrim,
  panel-surface background, hairline border, `0 16px 48px rgba(0,0,0,0.32)` shadow — the
  one drop-shadow used anywhere in the system, reserved for this single always-on-top
  modal context. Cancel is bordered/page-background; Confirm is accent-filled by default
  and swaps to the `critical` token (`background`/`border`/white text) only when the
  caller marks the action `destructive`. Confirm auto-focuses on open; Escape cancels.
  **The No Single-Click Destruction Rule.** Any action that discards user data must route
  through ConfirmDialog — never a bare click-to-delete control — confirmed by Discard in
  the Changes panel and written generically so it holds for every future destructive
  action, not just this one.
- **FileStatusIcon** (`packages/desktop/src/components/FileStatusIcon/`): a single
  uppercase letter (first letter of the git status word — `A`/`M`/`D`/`U`/etc.), fixed
  14px box, monospace, bold, colored via the existing status tokens
  (`changedFileStatusColorVar`: added→good, modified/type-changed/copied/renamed→warning,
  unmerged→serious, deleted/unknown→critical) with a visually-hidden text label alongside
  for screen readers — color is never the only signal, consistent with the status-token
  policy above. One component shared verbatim by the Changes panel's file rows and the
  DetailPanel's changed-file list, so file-status identity reads identically in both
  places.
- **Two-region split panel layout** (pattern, not a single component — first established
  by ChangesPanel, then reused by DetailPanel): a fixed-width, independently-scrolling
  list column beside a flexible, independently-scrolling detail column, separated by a
  hairline `var(--gh-border)` rule, inside a fixed-width (680px / `80vw` cap) edge panel.
  DetailPanel's file list narrows to 260px (vs. Changes panel's 300px) to leave room for
  its metadata region above the split, but the split mechanics — column widths via
  `flex: none` / `flex: 1`, each column's own `overflow-y: auto`, shared border-right —
  are identical between the two. **The Independent-Scroll Rule.** A panel's file list and
  its detail pane scroll independently of each other and of the panel chrome; neither a
  long file list nor a long diff should force the other out of view.
- **Collapsed-metadata disclosure** (DetailPanel): the commit metadata block (full SHA,
  ref chips, message body, author/committer/dates, parents) defaults to collapsed behind a
  one-line summary button — a chevron, the short SHA (monospace, muted ink) and the
  message's first line (truncated) — so it doesn't compete with the file-list/diff split
  for vertical space. Clicking the summary expands the full `<dl>` metadata block in place;
  the expanded/collapsed state is a UI-state toggle, not tied to which commit is selected
  (deliberately does not reset on reselection). This is a space-saving disclosure pattern
  applied to existing metadata fields — it does not change what metadata is shown, only
  when it's expanded by default.

## Component language (added: branch create/switch/delete)

- **BranchesPanel** (`packages/desktop/src/components/BranchesPanel/`): originally shipped as a
  right-edge toggleable panel; **relocated to a persistent left sidebar by the design pass** — see
  "Component language (added: design pass — selection halo, Branches sidebar relocation)" below
  for what changed (position, collapse behavior, search-jump). The rest of this entry (row
  content/chrome) is unchanged and still accurate. (420px, capped `80vw` — narrower than
  ChangesPanel/DetailPanel's 680px, since it's a single scrolling list rather than a list+diff
  split) listing local branches, then remote-tracking
  branches grouped by remote name as their own labeled sections — the same uppercase,
  letter-spaced, muted-ink section-heading convention ChangesPanel established, each with a live
  count in parens. A search box (`type="search"`) plus a filled-accent "+ New Branch" button sit
  in a header row below the panel title, matching Toolbar's button-in-a-row convention. Each row
  is a bordered card (not a plain list item) carrying: the branch name (mono, bold), a filled
  accent "Current" pill for the checked-out branch, a `status-serious`-filled "Checked out
  elsewhere" pill when checked out in another worktree, upstream/ahead-behind (↑/↓ counts, mono,
  secondary ink) when configured, the last-commit subject/author/date line (muted ink, truncated),
  and trailing Checkout/Delete buttons. Never hides a disabled control — Checkout/Delete on the
  current or elsewhere-checked-out branch, and Checkout on a bare repo, render disabled with a
  `title` naming the specific reason, extending the same "disabled + reason, not hidden" policy
  `DetailPanel`'s worktree indicator uses. Delete is styled in the `critical` token, matching
  ChangesPanel's Discard.
- **NewBranchDialog** (`packages/desktop/src/components/NewBranchDialog/`): a centered modal
  reusing ConfirmDialog's exact overlay/panel/shadow treatment (440px, same scrim, hairline
  border, the system's one drop-shadow) but as a form rather than a message — name field, a
  start-point `<select>` (HEAD default, optgroups for local branches / each remote / tags, plus a
  free-text "Custom" escape hatch), and a "switch to new branch" checkbox. An unborn-HEAD/
  zero-commit repo collapses the whole form to a one-line explanatory message plus a single Close
  button rather than showing controls that can't do anything yet — the same "explicit state, not
  a broken form" policy the graph's own empty-repo handling established.
- **Ahead/behind "last-known" captioning** (BranchesPanel): every ahead/behind + upstream-name
  display carries a `title` tooltip stating it reflects the last fetch performed outside
  GitHydra, never live — a text-carried caveat (never color-only), consistent with the status-
  token policy of never encoding meaning in color alone.
- **Toolbar current-branch indicator** (`Toolbar.tsx`): the current branch's short name (mono),
  prefixed with a small filled dot, doubles as the Branches panel's toggle button — the same
  toggle-button treatment (`gh-toolbar__button--active` on open) the Changes toggle already
  established. Falls back to a neutral "Branches" label (no dot emphasis implied) for detached
  HEAD or a bare repo, rather than showing a blank or misleading branch name.
- **Graph ref-chip context menu** (`RefChip.tsx`/`CommitRow.tsx`/`CommitGraph.tsx`): a local-
  branch ref chip gains a right-click menu (Checkout/Delete, reusing the existing `ContextMenu`
  component) — remote-branch/tag/HEAD chips never get one. The commit node's existing FR-16
  context-menu stubs ("Checkout commit"/"Create branch here…") are now wired to real actions
  rather than permanently disabled placeholders; cherry-pick/revert/reset remain stubs pending
  their own specs.

## Component language (added: layout & view polish — filter-bar collapse, diff sizing, resizable panels)

- **Collapsed-disclosure filter bar** (`FilterBar.tsx`): the same space-saving disclosure pattern
  DetailPanel's metadata block established (collapsed by default behind a one-line summary
  control, expands in place, doesn't reset on unrelated state changes) applied to the commit-graph
  filter form — a single `gh-toolbar__button`/`--active`-styled toggle ("Search & filter") stands
  in for the full SHA/Author/Message/date/path form until activated. Unlike the metadata
  disclosure, this one *does* reset every time (App.tsx unmounts/remounts `FilterBar` on every
  repo open, which doubles as the "always starts collapsed" reset for free) — collapsing never
  touches the applied filter itself, only the form's visibility. A small filled accent dot on the
  collapsed control (plus a screen-reader-only text equivalent, never color-only) signals an
  active filter, consistent with the status-token policy of pairing color with a text/shape
  signal.
- **Resize handle** (`ResizeHandle.tsx`, backed by the `useResizableWidth` hook): the system's one
  drag-to-resize pattern, shared verbatim by all five resizable surfaces (ChangesPanel/
  DetailPanel/BranchesPanel width, and the file-list/diff divider inside the first two) — a narrow
  (9px hit target, 1px visible rule) `role="separator"` strip on an existing hairline border,
  invisible until hover/focus/drag (accent-colored grip line, 1px → 2px on focus), `cursor:
  col-resize`. Keyboard-operable (Left/Right arrow keys, 16px steps) with a focus treatment that
  swaps the global `:focus-visible` outline for an inset accent line specifically for this
  component, since a handle sitting flush against a panel's own `overflow: hidden` edge would
  otherwise clip an outward-facing outline. Sizes persist to `localStorage` (global, not per-repo)
  using `useTheme.ts`'s exact try/catch-guarded pattern, debounced to one write per drag gesture.
  Any future resizable surface (a left-edge sidebar, per the spec's own note) reuses this
  component/hook rather than growing a bespoke splitter.

## Component language (added: merge/rebase conflict resolution)

- **Operation banner** (`StatusBanner.tsx`): extends the existing persistent, non-dismissible
  banner stack (unchanged shape/tokens) with FR-58's rich per-operation copy — "Rebasing
  `feature-x` onto `main` — step 2 of 5", "Merging `origin/main` into `feature-x`" — built from
  `inProgressOperationDetail` (`lib/operationBanner.ts`), falling back to the prior generic "X in
  progress" label only when no detail is available yet. Ref/SHA segments carry `gh-mono`, prose
  segments don't — the same mono-for-identifiers/sans-for-prose split the DetailPanel already
  established. A live "N of M conflicts resolved" readout (`gh-tabular`, muted ink) sits inline,
  computed by `useConflictProgress` entirely from the live conflicted-file count (never a
  client-tracked resolved flag, FR-67). Continue/Abort sit as small bordered buttons at the
  banner's trailing edge, matching the banner's existing `__action` button treatment — Continue
  disabled (with a `title` reason) until zero conflicts remain, Abort routing through
  `ConfirmDialog` (destructive) before calling `abortInProgressOperation()`, per the system's No
  Single-Click Destruction Rule.
- **ConflictResolutionView** (`packages/desktop/src/components/ConflictResolutionView/`): opened
  in place of `DiffView` inside the Changes panel's existing diff column when a Conflicted row is
  clicked (FR-72 supersedes that row's prior non-interactive treatment) — no new panel or modal,
  reusing the established two-region split rather than growing a second diff surface. Renders one
  of six classification-driven bodies (`lib/conflictClassification.ts`): a tabbed `DiffView` (base
  vs. ours / base vs. theirs / ours vs. theirs) for the common text-conflict and add/add cases, a
  rename old→new path list, explicit "Deleted in X, modified in Y" prose for delete/modify (no
  diff pane), an "only present in X" note for add-only, and a plain SHA `<dl>` for a submodule
  gitlink (no attempted diff, per FR-77). Every side reference — tab labels, action-button text,
  the rename list — always resolves through `getConflictSideLabels()`'s concrete label, never the
  bare words "ours"/"theirs" (FR-61). File-level actions only (FR-65): Accept-side buttons carry
  the accent-filled treatment ChangesPanel's Commit button established (`gh-conflict-view__accept`
  class, not a positional selector); Mark as resolved disables itself with a `title` naming the
  exact marker line numbers when `scanConflictMarkers` finds any (FR-66), and is hidden outright
  (not just disabled) for binary/submodule content, where no marker-based resolution path exists.
  Accept Ours/Accept Theirs deliberately do NOT route through ConfirmDialog — an on-brand judgment
  call, not a spec requirement: unlike Discard/Delete-branch, picking a conflict side never
  discards anything from git's history (both stage-2/stage-3 blobs stay reachable until the
  operation is continued), so it's treated like any other reversible resolution step rather than a
  destructive one.

## Component language (added: stash)

- **StashPanel** (`packages/desktop/src/components/StashPanel/`): a two-region split panel
  (680px/`80vw`-capped default width, resizable via the existing `ResizeHandle`/
  `useResizableWidth` pattern) following `ChangesPanel`/`DetailPanel`'s established
  list-column/diff-column convention rather than `BranchesPanel`'s narrower single-list
  treatment, since a stash needs the same file-list+diff split a commit does. Each row shows
  the stash's message, its origin branch (or a "(detached HEAD)" caption — distinguished from
  a custom-message stash with no resolvable branch, a real bug caught and fixed via the
  running app: both cases resolve `StashInfo.branch` to `null`, but only one of them is
  actually detached HEAD) and a relative date. Apply/Pop sit as small bordered buttons with no
  `ConfirmDialog` — applying/popping never discards anything the user doesn't already have, so
  this is deliberately not a No-Single-Click-Destruction-Rule case — while Drop routes through
  `ConfirmDialog` (`destructive: true`), matching `ChangesPanel`'s Discard and `BranchesPanel`'s
  Delete.
- **CreateStashDialog** (`packages/desktop/src/components/CreateStashDialog/`): reuses
  `ConfirmDialog`'s modal shell as a form, matching `NewBranchDialog`'s precedent — an optional
  message field, a `FileStatusIcon`-based file checklist (defaults to all checked), and an
  "Include untracked files" checkbox (defaults unchecked, matching git's own default). Reachable
  both from `StashPanel`'s header and as a secondary entry point from `ChangesPanel`.
- **Stash-conflict chrome deliberately differs from merge/rebase conflict chrome**: a
  stash-apply/pop conflict opens the existing `ConflictResolutionView` unmodified (same
  component `ChangesPanel`'s Conflicted rows already open — no new conflict UI was built), but
  with no operation banner and no Continue/Abort controls, since `git stash apply`/`pop`
  produces no in-progress-operation state and there is no `git stash apply --abort` to wire up.
  Instead, a distinct inline notice ("Applying stash left conflicts to resolve — the stash was
  not removed from the list", worded per whether Apply or Pop was invoked) points at the
  newly-populated Conflicted section.

## Component language (added: cherry-pick)

- **Multi-select on the commit graph** (`CommitGraph.tsx`/`CommitRow.tsx`): ctrl/cmd-click and
  shift-click extend the graph's existing single-select with a second, independent selection set
  — entirely new interaction surface, no new tokens. A multi-selected row gets its own visual
  treatment (`.gh-commit-row--multi-selected`: a dashed accent inset outline plus a small filled
  checkmark before the sha, `.gh-commit-row__multi-marker`) deliberately distinct from
  `.gh-commit-row--selected`'s solid accent-tinted background, so a row that's simultaneously the
  single `DetailPanel`-driving selection and part of the multi-selection reads as both at once
  rather than one masking the other. `aria-selected` is set for both cases and the listbox gains
  `aria-multiselectable="true"`, matching this system's existing policy of pairing every visual
  selection state with the corresponding ARIA state, not color alone.
- **Context-menu Cherry-pick action** (`CommitGraph.tsx`, `ContextMenu.tsx`): the previously
  permanently-disabled stub is now enabled and reads "Cherry-pick" or "Cherry-pick N commits"
  depending on the effective target set. `ContextMenuItem` gained a `title` field (rendered as the
  button's native tooltip) so a disabled item always carries a stated reason — reused for every
  disabled-with-explanation case FR-115 requires (operation in progress, bare repo, unborn HEAD, a
  merge commit in the selection), never a silently-disabled control.
- **`CherryPickEmptyResultNotice`** (`packages/desktop/src/components/CherryPickEmptyResultNotice/`):
  the FR-105/FR-118 empty-result pause's distinct, non-conflict notice — reuses `StatusBanner`'s
  exact banner/action-button classes and tokens (`gh-status-banner--neutral`,
  `gh-status-banner__op-actions`) rather than inventing new chrome, since structurally it's one
  more status banner that happens to render Skip/Commit-empty instead of Continue/Abort. Always
  renders directly below the persistent operation banner (both are simultaneously visible during a
  paused empty-result step — the operation banner still shows Continue/Abort for the sequence as a
  whole, this notice offers the two ways to resolve the current step). Named after the exact commit
  it applies to (short SHA, mono, plus subject) — no color-only signal, matching FR-122.
- **Stash-conflict precedent extended, not re-derived**: a conflicting cherry-pick reuses
  `StatusBanner`/`ConflictResolutionView` completely unmodified (same components merge/rebase
  conflicts already use) — the one addition is `operationBanner.ts`'s cherry-pick case appending
  "(N more queued)" when `remainingAfterCurrent` is known and positive, deliberately never a
  rebase-style "step N of M" (git's cherry-pick sequencer doesn't persist an originally-requested
  total — see `specs/cherry-pick.md`'s "sharp edge").

## Component language (added: blame & file history)

- **`BlamePanel`** (`packages/desktop/src/components/BlamePanel/`): a right-edge panel following
  `BranchesPanel`'s single-column resizable-width precedent (680px/`80vw`-capped, matching
  `ChangesPanel`/`DetailPanel`/`StashPanel`'s width, since blame content needs the same breathing
  room a diff does) rather than those three panels' list+diff split — blame has only one file, so
  there's no second per-item list to split against. Opened as an overlay on top of whichever rail
  panel had the file row the user right-clicked (`ChangesPanel`/`DetailPanel`), superseding it
  while open and revealing it again on close, rather than claiming its own slot in the app's
  persisted "last open panel" preference — a Blame invocation is content-scoped (this file, this
  revision), not a layout choice, the same reasoning `DetailPanel`'s "commit" panel state already
  isn't persisted. Contiguous same-commit lines are visually banded into one block
  (`lib/blameBlocks.ts`'s `groupBlameLines`) with the commit's abbreviated SHA/author/relative
  date/subject shown once per block as a clickable heading (`gh-mono`/`gh-tabular` for the SHA and
  date, matching `DiffView`'s line-number convention), not repeated per line. `getFileBlame`'s
  binary/too-large/not-found/empty results each render as an explicit named state text, extending
  `DiffView`'s established non-diff-state pattern to blame rather than inventing a new one. The
  uncommitted-lines block renders with no clickable affordance and a distinct muted-warning tint,
  but its real distinguishing signal is textual, not the tint: git's own literal "Not Committed
  Yet" author text, rendered as plain (non-button) text where every real block is a button.
- **File history disclosure** (within `BlamePanel`): reuses `DetailPanel`'s collapsed-by-default
  metadata-toggle pattern (chevron + label button) rather than a permanently-visible second
  region, paged via the same `CommitPager` (`readPage`/`closeReader`) contract the commit graph's
  own reader already uses — a "Load more" button, never a full-history fetch blocking the panel's
  open. Each row matches `StashPanel`'s row convention (subject line, then a muted meta line of
  mono SHA + author + relative date) since `DetailPanel` itself has no existing commit-row list to
  mirror (only a file-row list) — `StashPanel`'s row shape was the closer existing precedent for
  "one commit summarized in a list item." Selecting a row re-blames the same panel in place
  (`onReblame`), never opening a second panel.
- **Blame context-menu entries** (`ChangesPanel`/`DetailPanel`): `ContextMenu`'s first use on a
  file row (previously only graph rows and ref chips) — reuses its existing `disabled`/`title`
  contract unmodified. Untracked and Conflicted rows in `ChangesPanel` show Blame disabled with an
  explicit reason string (never hidden), matching cherry-pick's established disabled+reason
  policy on this same component.

## Component language (added: design pass — selection halo, Branches sidebar relocation)

Two items from `ROADMAP.md`'s "Design pass" milestone — its own deliberate task, not background
polish squeezed into feature work, per that file's own framing.

- **Selection halo** — see the "Commit node"/"Selection halo" bullets in "Component language
  (first surface: commit graph)" above, updated in place rather than duplicated here.
- **Branches sidebar relocation** (`BranchesPanel.tsx`, `App.tsx`, `Toolbar.tsx`): the Branches
  panel moved from a toggleable right-hand rail (mutually exclusive with Changes/Stashes/commit
  detail, opened/closed via `rightPanel` state) to a **persistent left sidebar** — rendered
  unconditionally for the lifetime of an open repo, positioned first in `.gh-app__body`'s flex row
  (before the graph), independent of `rightPanel` entirely. This is the first left-hand chrome the
  shell has ever had; `.gh-app__body` remains a plain flex row, so a future left-hand surface (V1.1's
  repo list, per `ROADMAP.md`'s explicit sequencing note to land this relocation first) is expected
  to slot in as a sibling `<aside>`/section rather than requiring another shell rework — deliberately
  not generalized into a multi-section sidebar container ahead of that actually being built.
  - **Collapse, not close.** The sidebar has no "×"; it collapses to a 36px slim rail (a vertical
    "Branches" label plus a single re-expand button, `»`) instead of unmounting — always
    discoverable, never hidden outright, consistent with this system's existing "disabled + reason,
    never hidden" policy for persistent affordances. Collapsed state persists to `localStorage`
    (`githydra:layout:sidebarCollapsed`, global not per-repo — the same scope every other layout
    preference in this system uses), defaulting to expanded. Toolbar's existing current-branch
    button (`branchesOpen`/`onToggleBranches`) is repurposed verbatim (same label/position) to
    toggle this collapse state instead of opening/closing a panel — no new toolbar chrome added.
  - **Mirrored, not copied, chrome.** Border/resize-handle move from the panel's left edge to its
    right edge (`border-right`, handle `right: 0`) and `useResizableWidth`'s `direction` flips from
    `-1` to `1` — the exact same resize mechanics every other panel uses, mirrored for a left-hand
    surface rather than forked into new logic.
  - **Search now jumps, not just filters** (FR-50 extended): a branch's name is a real button
    (`onLocateBranch`) that jumps the graph to that branch's tip commit — reusing `App.tsx`'s
    `jumpToSha` (extracted verbatim from FR-134's blame-jump logic: apply the graph's sha filter
    only if the target isn't already reachable in the loaded page, then select it; `CommitGraph`'s
    own follow effect drives the actual scroll/auto-page-load) rather than a second, bespoke jump
    mechanism, per `ROADMAP.md`'s explicit instruction to reuse the existing pattern. Pressing
    Enter in the search box jumps to the current top match (local branches before remote-tracking
    ones, matching the list's own section order) for a zero-extra-click search-to-graph flow. The
    name button is styled to look like the same plain bold label it always was (transparent
    background/border, only a hover underline + the existing focus-visible ring signal it's
    interactive) so the row doesn't sprout a second visually competing button next to
    Checkout/Delete — clicking it never mutates anything (no checkout), only navigates.
  - **Performance bar held, not renegotiated**: the relocation and the added jump affordance touch
    only rendering/interaction — `useBranchList`'s two-batched-call fetch and client-side
    substring filter (specs/branch-management.md AC16: 300+ branches, no dropped frames, constant
    git-call count) are untouched, and the new jump path never issues an additional git call (it
    only ever selects/filters already-loaded or already-fetchable graph data via the existing
    `applyFilter`/`selectCommit` path).
  - **Assumption, flagged for product-manager**: "persistent" was read as "always mounted while a
    repo is open, collapsible but not closeable" (matching the GitKraken-style reference layout the
    user supplied — a permanent left nav, not a togglable overlay) rather than "always full-width,
    uncollapsible." This is an on-brand interpretation, not a literal spec line item (the design
    pass's ROADMAP entry doesn't specify collapse behavior) — flagging it since it's the one place
    this task made a judgment call with real UI-behavior consequences, per this role's standing
    instruction to flag material scope/behavior decisions back rather than silently deciding them.

## Component language (added: design pass — chrome hierarchy: toolbar clusters, icon vocabulary, row truncation, filter-bar footer)

Fixes the remaining four items (of five) from the same dual-agent design critique the light-mode
token pass above addressed — the critique's central finding: the commit graph itself already
executes this file's transit-map thesis well, but everything *around* it (toolbar, commit rows,
surfaces) read as unstyled scaffolding by comparison. This pass extends the existing system to
close that gap; no new colors or typography were introduced anywhere in it.

- **Icon vocabulary** (`packages/desktop/src/components/Icon/Icon.tsx`): the system's first
  authored icon set — real SVG paths on one shared 18x18 grid, `currentColor` stroke, 2px stroke
  weight (matching the graph's own lane-line weight, "Lane" above), never a Unicode glyph or emoji
  standing in for an icon. Ten icons cover every chrome affordance this pass touches: Branches,
  Changes, Stashes, Open repository, Refresh, theme toggle (Sun/Moon), New Branch, Checkout,
  Delete — each exported as its own component (`IconBranches`, `IconChanges`, etc.) sharing one
  `IconBase` wrapper. Decorative by default (`aria-hidden`, `focusable="false"`); every caller
  pairs the icon with either visible text or an `aria-label` on the containing control, extending
  this system's "color/shape is never the only signal" policy to icon-only buttons. Reused
  verbatim — never redrawn per caller — by `Toolbar` (all six of its buttons) and `BranchesPanel`'s
  row-level New Branch/Checkout/Delete buttons, so the same concept always reads as the same glyph
  everywhere it appears. The pre-existing `«`/`»` sidebar-collapse glyphs and `×` close glyphs are
  deliberately untouched — out of this pass's scope per the brief, not an oversight.
- **Toolbar role clusters** (`Toolbar.tsx`/`.css`): the prior six identical bordered-gray-rectangle
  buttons are now three visually distinct clusters, separated by a hairline `__divider`:
  1. **Panel-toggle chips** (Branches/Changes/Stashes) — unchanged bordered-chip treatment and
     active-state styling (`--gh-accent` border), now each carrying its icon-vocabulary glyph
     before its label.
  2. **Dialog-launcher** (Open repository…) — kept bordered (it opens a native OS dialog, a
     heavier action than a toggle), now with an icon.
  3. **Utility actions** (Refresh, theme toggle) — demoted to icon-only ghost buttons
     (`.gh-toolbar__icon-button`: transparent background/border until hover or focus, 28x28,
     no visible label text). The icon alone is unambiguous, backed by a `title` tooltip and an
     explicit `aria-label` for the accessible name — visible text was dropped, not the accessible
     name.
  Deliberately no single "hero" button: the commit graph remains the primary surface (FIRST
  VIEWPORT above) — this is about demoting utilities and grouping toggles by role, not crowning one
  dominant action.
- **Commit-row column priority** (`CommitGraph.css`'s `__subject`/`__author`): the message/subject
  column previously had the *same* effective shrink priority as it does now (`flex-shrink: 1`) but
  a much smaller floor (`min-width: 80px`) while `__author`/`__sha`/`__date` were entirely
  non-shrinking (`flex: none`) — so under width pressure, the subject column absorbed the *entire*
  squeeze alone, both for real commit subjects and the uncommitted-changes pseudo-row (shares the
  same `__subject` class), producing the "Uncommitted changes (16…" mid-word-clipped symptom this
  fixes. Now `__subject` carries `flex: 2 1 240px; min-width: 200px` (low shrink factor, high grow
  factor, a real floor) while `__author` carries `flex: 0 4 160px; min-width: 40px` (much higher
  shrink factor) — under pressure, the author column now gives up width well before the subject
  column reaches its floor. One CSS rule fixes both symptoms named in the brief, since the pseudo-
  row's "Uncommitted changes (…)" text and a real commit's subject share the same element/class.
- **FilterBar collapsed-row status readout** (`FilterBar.tsx`/`.css`): the collapsed row previously
  left most of its width empty (the disclosure toggle hugs the left edge, nothing else in the row).
  A new optional `loadedCommitCount`/`hasMoreCommits` pair renders a quiet, right-aligned readout —
  "1,532 commits loaded" or "1,532+ commits loaded" once more history exists beyond the current
  page — in the same row, via a new `__top-row` flex wrapper (`justify-content: space-between`)
  around the toggle button and the readout. Deliberately worded "loaded," never "total," and the
  "+" suffix only appears when `hasMoreCommits` is true: this is only ever the currently-fetched
  page (`useRepositoryGraph`'s pagination), so the copy never implies more than is actually known —
  the same "never claim more than the last-known state" framing `BranchesPanel`'s ahead/behind
  captioning already established. `App.tsx` derives both values from `graph.displayRows`/
  `graph.hasMore` at render time — no new hook state, no change to `useRepositoryGraph`'s data-
  loading logic.

## Component language (added: compare two commits directly)

- **`CompareView`** (`packages/desktop/src/components/CompareView/`): joins the same mutually-
  exclusive right-panel slot as `ChangesPanel`/`DetailPanel`/`StashPanel` (`RIGHT_PANEL_DEFAULT_WIDTH`,
  the same file-list+diff two-region split, the same `DETAIL_FILE_LIST_DEFAULT_WIDTH`-width file
  column) rather than `BranchesPanel`/`BlamePanel`'s narrower single-column treatment, since
  comparing two commits needs the same file-list+diff split a single commit's `DetailPanel` does.
  Its close button (`gh-compare-view__close`) is pixel-for-pixel the same rule set as
  `DetailPanel`'s, and the file list reuses `FileStatusIcon`/the same rename-similarity percentage
  treatment verbatim — no new file-row visual language was invented for this surface.
- **Header identifies both compared commits** (FR-190): abbreviated SHA (`gh-mono`) + first
  message line for each side, each explicitly labeled "Base"/"Target" in small-caps muted-ink
  text — the same role-labeling weight `BranchesPanel`'s section headings use.
- **Swap control** (FR-193, `gh-compare-view__swap`): a small bordered ghost button (transparent
  at rest, `--gh-page` on hover — the same treatment `StashPanel`'s `__diff-file-button` already
  established) sitting between the two commit summaries, flipping which is labeled base/target.
  **Known inconsistency, flagged rather than silently left in place:** this button's "⇄" is a raw
  Unicode glyph, not a real `Icon.tsx` SVG — a deviation from the icon-vocabulary pass's own rule
  ("never a Unicode glyph or emoji standing in for an icon"), which every other recently-added
  button (`+ New Branch` → `IconNewBranch`, Checkout, Delete) now follows. The `×` close and
  `«`/`»` collapse glyphs are grandfathered as pre-existing/out-of-scope for that pass; this is a
  brand-new control, so it doesn't inherit that exception. Carries a real text label ("Swap")
  alongside the glyph, so it isn't a color/icon-only violation — just an unvetted glyph where a
  proper icon belongs. Left as-is pending a deliberate icon-design pass rather than freehanding an
  SVG path outside that process; revisit before this reads as the system's new precedent for
  future buttons.
- **Always-visible, disabled-with-tooltip context-menu entry** (FR-186, `CommitGraph.tsx`): unlike
  `cherryPickTargets`' single-row fallback, "Compare 2 commits" has no fallback — it's enabled only
  at exactly 2 selected — but it is never conditionally hidden the way an earlier draft of this
  spec originally had it. A deliberate discoverability decision (product-manager UX review,
  2026-09-06): the item is always present, disabled with an explanatory `title` outside the
  exactly-2 case, so a user who never learns the ctrl/shift-click multi-select gesture on their own
  still discovers the feature exists via the same right-click every user already tries — extending
  this system's existing "disabled + reason, never hidden" policy (`BranchesPanel`'s
  Checkout/Delete, cherry-pick's own menu item) to a case that previously would have hidden the
  control outright instead of disabling it.
- **Persistent dashed multi-select highlight while open** (FR-196): the two commits being compared
  keep `CommitRow`'s existing `.gh-commit-row--multi-selected` treatment (cherry-pick's dashed
  accent inset outline + checkmark) for as long as `CompareView` stays open, independent of
  `CommitGraph`'s own internal ctrl/shift-click selection state — no new visual treatment, just the
  existing multi-select mark kept alive by a second, App-owned data source
  (`App.tsx`'s `compareTarget`) layered on top of it.

New component-language entries get appended here as they're built, not re-litigated.
