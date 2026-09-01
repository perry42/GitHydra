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
  new shape.
- **Ref chip**: small pill, text label (branch/tag/HEAD name), border in the owning
  lane's hue, filled background only for the current HEAD/checked-out ref — this chip is
  the light-mode relief channel for the 3 sub-3:1 categorical slots.
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

- **BranchesPanel** (`packages/desktop/src/components/BranchesPanel/`): a right-edge panel
  (420px, capped `80vw` — narrower than ChangesPanel/DetailPanel's 680px, since it's a single
  scrolling list rather than a list+diff split) listing local branches, then remote-tracking
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

New component-language entries get appended here as they're built, not re-litigated.
