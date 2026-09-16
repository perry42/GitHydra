# PRD: Drag One Commit Onto Another — Contextual Action Menu

Status: draft — ready for implementation
Owner: product-manager
Priority: v1.x discoverability enhancement, sequenced ahead of the rest of the Floaters list per the
user's explicit request (`ROADMAP.md`, 2026-09-14/15)

Builds on, and does not modify, three already-shipped surfaces: `specs/compare-commits.md`'s
multi-select + right-click "Compare 2 commits" flow (FR-181–196), `specs/cherry-pick.md`'s
multi-select + right-click cherry-pick flow (FR-103–122), and
`specs/merge-rebase-conflict-resolution.md`'s generic in-progress-operation detection/banner/
conflict-resolution infrastructure (FR-58–80), which already types `MergeOperationDetail` and
`RebaseOperationDetail` but has never had anything that *starts* a merge or rebase — that spec's own
Non-goals section explicitly deferred "initiating a merge, rebase, cherry-pick, or revert from the
UI... a separate follow-on spec." This spec is that follow-on, scoped narrowly to the one entry point
described here (dragging one commit node onto another); it is not a general "Merge branch X" /
"Rebase onto Y" UI added anywhere else in the app.

An interactive HTML draft (two menu-treatment concepts) was reviewed and approved by the user before
this spec was written; the list-menu concept (Concept B) is the shipped direction, and this spec's
copy/labels below are taken verbatim from that approved draft, not newly invented.

## Problem

GitHydra's only entry point to compare, cherry-pick, merge, or rebase two arbitrary commits is
"multi-select via ctrl/shift-click, then right-click" — a discoverable-once-you-know-it-exists
gesture, but not a self-evident one (`specs/compare-commits.md`'s own Non-goals flagged this same
drag idea during its UX review). Dragging one commit node onto another is a much more self-evident
gesture, and — bundled in for the first time here — GitHydra currently has no way to *start* a merge
or rebase from the UI at all (only to detect and resolve one already in progress). This spec adds a
second, more discoverable entry point to the two-commit action set, and is also the first spec to
let a user initiate a merge or rebase from GitHydra's UI.

## Target user

Same as every prior spec: any GitHydra user working in the commit graph, with no dependency on a
specific host (GitHub/GitLab/Bitbucket/self-hosted/local-only) or on a remote existing at all, and
working identically in a bare repository (see FR-308 for where bare repos gate this feature exactly
as they already gate cherry-pick).

## Must-have behavior

### Data & git semantics (git-core-engineer) — new `packages/git-core` surface

- FR-295: New ancestry-relationship read (exact module/file name is git-core-engineer's call,
  consistent with this codebase's one-module-per-operation convention — e.g. `commitPairs.ts`):
  `computeCommitPairRelationship(shaA: string, shaB: string)`, returning one of
  `"a-ancestor-of-b" | "b-ancestor-of-a" | "no-common-ancestor" | "diverged"`. Implemented as exactly
  three parallel git reads, one round trip: `git merge-base --is-ancestor <shaA> <shaB>` and
  `git merge-base --is-ancestor <shaB> <shaA>` (exit 0 = true, exit 1 = false — not an error; any
  other exit code, e.g. a shallow-clone boundary where git cannot determine ancestry, is treated as
  "false" for that direction rather than thrown, per the explicit product decision to fall back to
  the permissive/enabled state rather than add a dedicated unknown-ancestry UI case), and a plain
  `git merge-base <shaA> <shaB>` (empty/error output ⇒ `"no-common-ancestor"`, i.e. genuinely
  disconnected histories). Result is `"diverged"` only when neither `--is-ancestor` direction is true
  and a real merge-base was found. **Computed once, only at drop time — never during hover or while a
  drag is in progress** (each check is a real `git.exe` spawn; unbounded per-hover-frame spawning
  during a drag was confirmed too expensive).
- FR-296: Both SHAs are validated with the existing `HEX_SHA_RE` check before any git call, throwing
  `InvalidArgumentError` on failure — same convention `specs/compare-commits.md` FR-183 already
  established for a two-commit entry point. `shaA === shaB` is also rejected defensively at this
  layer (the UI layer never calls this function for a self-drop at all — FR-302 — but git-core does
  not trust the caller to have enforced that).
- FR-297: New `mergeCommit(otherSha: string)` — a single `git merge <otherSha>` call against current
  HEAD. Refuses up front, making no git call, via a typed error mirroring cherry-pick's
  `OperationAlreadyInProgressError` precedent (`specs/cherry-pick.md` FR-103) when
  `detectInProgressOperation()` is already non-null. Routes through `withFsmonitorNeutralized()`,
  argv array only, `shell: false`, `otherSha` passed through `withEndOfOptions()`. A clean
  fast-forward or a real merge commit is indistinguishable from a paused/conflicting outcome in this
  call's own return value — matching this codebase's established convention that in-progress-operation
  state is discovered by re-reading `RepositoryState`/`MergeOperationDetail` (already shipped,
  `specs/merge-rebase-conflict-resolution.md` FR-58), never returned out of band.
- FR-298: New `rebaseCommitOnto(newBaseSha: string)` — a single `git rebase <newBaseSha>` call
  against current HEAD, same refusal/argv/no-out-of-band-result conventions as FR-297. A paused
  conflict is discovered via the already-shipped `RebaseOperationDetail` (FR-58), not returned here.
- FR-299: Neither FR-297 nor FR-298 takes a target-branch parameter — both always act on whatever is
  currently HEAD, exactly matching `specs/cherry-pick.md` FR-113's existing "always targets HEAD, no
  target picker" precedent for `cherryPick()`. Getting HEAD onto the intended commit first (when it
  isn't already) is entirely the UI layer's job (FR-309), reusing branch-management's existing
  `git switch` (FR-38) / `git switch --detach` (FR-39) verbatim — this spec adds no new checkout
  variant to git-core.
- FR-300: No network call anywhere in FR-295/297/298. Identical behavior regardless of remote host
  (GitHub/GitLab/Bitbucket/self-hosted) or absence of one — restated per this project's
  non-negotiable no-network-by-default principle, matching `specs/compare-commits.md` FR-192 /
  `specs/cherry-pick.md` FR-110's precedent for the same guarantee.

### Rendering & interaction (ui-graphics) — `packages/desktop`

- FR-301: A pointer-driven drag interaction on commit nodes in `CommitGraph` — press and drag a
  node, release over another node. Exact drag mechanics (native HTML5 DnD vs. pointer-capture) are
  ui-graphics's implementation call; this codebase's one existing drag gesture
  (`useResizableWidth`/`ResizeHandle`) uses `PointerEvent`-based dragging, offered as precedent, not
  a mandate. **No modifier key (Ctrl/Alt/Shift/Cmd) changes this interaction in v1** — plain
  drag-and-release always opens the menu below; nothing else is bound. This is a final decision, not
  a placeholder for later modifier behavior.
- FR-302: **Self-drop is the only case where no menu opens at all.** Dragging a node onto itself is
  visually rejected during the drag (a blocked-cursor and/or `critical`-tinted highlight, per
  `DESIGN.md`'s `critical` token) and produces no menu, no git call, on release.
- FR-303: For every other pair of two distinct commits (A = dragged, B = dropped-on), releasing the
  drag immediately opens the menu (FR-304) in a brief "computing…" state while FR-295's three
  parallel ancestry reads resolve, then re-renders with the FR-307/308 enabled/disabled state once
  they return. This is the only time the ancestry check runs — never during the drag itself.
- FR-304: The menu reuses the shipped `ContextMenu` component's chrome pixel-for-pixel (same
  `gh-context-menu`/`gh-context-menu__item` classes — surface, border, radius, shadow, item
  treatment) rather than a new visual component. Concretely: `ContextMenuProps` gains an optional
  header slot (e.g. `header?: ReactNode`, rendered above the item list via a new
  `gh-context-menu__header` class in `ContextMenu.css`, styled from the same surface/ink tokens the
  rest of the component already uses) so this feature extends the real component instead of forking
  a visual duplicate. Exact prop/class naming is ui-graphics's call; the constraint is one shared
  component.
- FR-305: The header row identifies both commits using the format the approved draft already
  validated — **"Dragged `{A}` onto `{B}`"** — where `{A}`/`{B}` each resolve to: the commit's local
  branch name, else its remote-tracking branch name, else its tag name (first ref of the
  highest-priority type present, in the same order the row's own ref-chip badges already render — no
  new sort order invented), else the abbreviated SHA when the commit carries no ref at all. Source:
  `CommitInfo.refs` (`RefDecoration[]`), already populated per commit.
- FR-306: Exactly four menu items, each its own explicit entry (no combined/ambiguous item), using
  the same name-resolution as FR-305 and the exact label wording already validated in the approved
  draft:
  - **"Compare `{A}` with `{B}`"**
  - **"Cherry-pick `{A}` onto `{B}`"**
  - **"Merge `{A}` into `{B}`"**
  - **"Rebase `{B}` onto `{A}`"** — note the flipped subject: `{B}` (the dropped-on commit) is what
    moves, the opposite of the other three actions where `{A}` (the dragged commit) is the subject.
    This is deliberate and must not be "fixed" to match the other three.

  Items always render in this fixed order regardless of ancestry state.
- FR-307: Enabled/disabled state from FR-295's ancestry result, exactly as locked:

  | Action | A ancestor of B | B ancestor of A | No shared history (orphan) | Diverged, shares real history |
  |---|---|---|---|---|
  | Compare `{A}` with `{B}` | Enabled | Enabled | Enabled | Enabled |
  | Cherry-pick `{A}` onto `{B}` | Enabled | Enabled | Enabled | Enabled |
  | Merge `{A}` into `{B}` | Disabled — "Already up to date" | Enabled (fast-forward) | Disabled — "No shared history between these commits" | Enabled |
  | Rebase `{B}` onto `{A}` | Disabled — "Nothing to replay" | Enabled (fast-forward) | Disabled — "No shared history between these commits" | Enabled |

  Compare/Cherry-pick are deliberately always-enabled regardless of ancestry, matching
  `specs/cherry-pick.md`'s existing "no proactive ancestry pre-check" non-goal (cherry-pick's own
  graceful empty-result handling, FR-105/FR-118, already covers its no-op case) and
  `specs/compare-commits.md`'s FR-184 (a diff is meaningful for any two distinct commits). Only
  Merge/Rebase get proactive disabling, because their no-op case produces literally nothing
  actionable.

  **Fifth state, added during implementation (2026-09-15) — a genuine ancestry-read failure**, distinct
  from FR-295's own shallow-clone-boundary fallback. FR-295's "treat as false" fallback is scoped to
  git itself running successfully but returning an ambiguous exit code (the shallow-clone case) — it
  does not cover the read failing outright at the process/IPC level (e.g. a spawn error). For that
  distinct failure, Merge `{A}` into `{B}` and Rebase `{B}` onto `{A}` are disabled — **"Could not
  determine commit history — try again."** — while Compare/Cherry-pick are unaffected, since neither
  ever depended on the read. Decided over silently defaulting to enabled (FR-295's shallow-clone
  behavior) specifically because Merge/Rebase are this menu's two mutating actions: silently enabling
  a mutating action after a failed diagnostic read risks the user kicking off a merge/rebase against a
  repo in an unknown state with no warning, which is worse than a clear disabled-with-reason state and
  contradicts FR-317's own "never a silently-disabled item with no explanation" principle applied in
  reverse (never silently *enable* something that couldn't actually be verified, either).
- FR-308: Beyond FR-307's ancestry table, Cherry-pick/Merge/Rebase (never Compare, which never
  mutates anything) are further disabled, with their own specific reasons, exactly matching
  precedent already set elsewhere rather than inventing new rules: an operation is already in
  progress (checked client-side, mirroring `specs/cherry-pick.md` FR-115 and this spec's FR-297/298
  server-side refusal, so the two never disagree); the repo is bare (no working tree — matches
  `specs/cherry-pick.md`'s existing bare-repo gate, extended here to Merge/Rebase for the identical
  underlying reason: none of the three can complete without a working tree); or `HEAD` is unborn.
  Cherry-pick `{A}` onto `{B}` is additionally disabled when `{A}` is a merge commit (2+ parents),
  unchanged from `specs/cherry-pick.md` FR-115's existing restriction — this spec does not lift that
  non-goal. These checks resolve together with FR-295's ancestry read at drop time, same
  once-per-drop performance rationale as FR-303.
- FR-309: **Checkout-if-needed shared precondition, for Cherry-pick/Merge/Rebase only (never
  Compare, which is read-only).** If `{B}` is not already the current `HEAD` commit, `HEAD` is
  switched to `{B}` first: `git switch` (branch-management FR-38) when `{B}` is a local branch tip,
  otherwise `git switch --detach` (branch-management FR-39) — never a new checkout variant. This is
  attempted automatically as part of invoking the action (not a separate confirmation step), since a
  clean switch is itself non-destructive, matching FR-38's own precedent of never force-discarding
  uncommitted changes. If the switch is refused (uncommitted-changes conflict, an operation already
  in progress, or `{B}`'s branch checked out in a different worktree), that refusal is surfaced
  verbatim in the same inline error surface as the action itself, and the action stops there — no
  cherry-pick/merge/rebase call is attempted afterward. When `{B}` is already `HEAD` (the common
  case — most drags are branch-tip onto the currently-checked-out branch tip), no checkout occurs at
  all. This switch is a real, visible side effect (the checked-out branch/HEAD position changes) from
  a menu item whose label doesn't say "switch branch" — see Non-goals for why this is not
  additionally gated by a proactive pre-check.
- FR-310: Selecting "Compare `{A}` with `{B}`" invokes the existing, unmodified compare-commits flow
  (`specs/compare-commits.md` FR-188/189) — opening `CompareView` for the pair. The panel's own
  base/target assignment continues to use FR-187's existing graph-order determinism (older-in-graph-
  order is always "base") unchanged by drag order; this spec's `{A}`/`{B}` labeling is a menu-copy
  concern only and does not alter which commit `CompareView` calls "base." The user's existing FR-193
  Swap control remains the way to flip that if desired.
- FR-311: Selecting "Cherry-pick `{A}` onto `{B}`" runs FR-309's checkout-if-needed, then invokes the
  existing single-commit cherry-pick flow (`specs/cherry-pick.md` FR-103) with `shas = [A]` — the
  underlying `cherryPick()` call itself is completely unmodified; this is a new caller, not a new
  code path.
- FR-312: Selecting "Merge `{A}` into `{B}`" runs FR-309's checkout-if-needed, then invokes FR-297's
  `mergeCommit(A)`.
- FR-313: Selecting "Rebase `{B}` onto `{A}`" runs FR-309's checkout-if-needed, then invokes FR-298's
  `rebaseCommitOnto(A)`.
- FR-314: Standard refresh contract after every successful (or paused-on-conflict) Merge/Rebase/
  Cherry-pick triggered this way, and after FR-309's checkout step regardless of what follows it —
  refresh the commit graph (new commits/HEAD position), `HEAD`/current-branch decoration
  (`specs/commit-graph.md` FR-17), `ChangesPanel`, Toolbar working-dir badges, and the operation
  banner — matching the established `specs/branch-management.md` FR-56 / `specs/cherry-pick.md`
  FR-121 precedent. No restart or manual refresh required.
- FR-315: A conflicting Merge or Rebase started this way surfaces through the exact existing
  `StatusBanner`/`ConflictResolutionView` infrastructure (`specs/merge-rebase-conflict-resolution.md`
  FR-60/64/68) — no new conflict UI is built. This spec is purely a new initiation entry point on top
  of already-shipped detection/resolution.
- FR-316: Escape, clicking outside the menu, and scrolling the graph while the menu is open all close
  it. This is explicit regression coverage for the real bug the design-review round found and fixed
  in the draft (an inline `style.display = "block"` used to measure the menu before positioning it
  silently out-specificity'd the CSS class controlling visibility, so scroll/Escape/outside-click all
  appeared wired but did nothing) — the shipped implementation must not reintroduce that pattern.
  **Implemented as a property of the shared `ContextMenu` component itself** (a capture-phase
  `scroll` listener alongside its existing Escape/outside-click handling) rather than scoped to only
  this feature's own menu instance — every existing
  `ContextMenu` caller (commit-row menu, ref-chip Checkout/Delete menu, `DetailPanel`/`ChangesPanel`'s
  file-row Blame menus) now also closes on scroll. This is an intentional consistency fix, not an
  unintended side effect: none of those existing menus ever re-anchored to their originating row as it
  scrolled (all position from a one-time `clientX`/`clientY` snapshot), so a menu surviving a scroll
  was already a latent inconsistency everywhere `ContextMenu` is used, not a behavior any existing spec
  ever specified as intended. Forking dismiss behavior per-instance on one shared component (e.g. a
  `dismissOnScroll` prop) was considered and rejected as the actual scope-creep risk — two diverging
  dismiss contracts on the same component with no caller wanting the old "survives scroll" behavior in
  the first place. **Confirmed directly by the user (2026-09-15), after product-manager's initial
  recommendation** — this app-wide behavior change (beyond this feature's own footprint) was
  surfaced to the user explicitly rather than left standing on product-manager's call alone; kept as
  global, no scope-back needed.
- FR-317: Every disabled item's reason (FR-307/308) is exposed via `ContextMenuItem`'s existing
  `title` mechanism — matching `specs/cherry-pick.md` FR-115/122's precedent: never color-only, never
  a silently-disabled item with no explanation.
- FR-318: No network call anywhere in the full drag → menu → action flow, on top of FR-300's
  git-core-level guarantee — the reused checkout (FR-38/39)/cherry-pick (FR-103)/compare
  (FR-181/182) calls this spec invokes are each already independently zero-network per their own
  specs. Identical behavior on repos configured against GitHub, GitLab, Bitbucket, a self-hosted
  remote, and a purely local repo with no remote.
- FR-319: **Additional entry point only.** The existing multi-select + right-click Compare
  (`specs/compare-commits.md` FR-186/187) and Cherry-pick (`specs/cherry-pick.md` FR-111–114) flows
  are completely unmodified by this spec — both entry points coexist and either can be used in the
  same session, on the same or different commit pairs.

## Non-goals (v1)

- **Any modifier-key (Ctrl/Alt/Shift/Cmd) variant of the drag gesture.** Decided against for v1, not
  deferred: no dominant default exists among the four actions (three of which mutate repo state), no
  cross-platform convention to anchor one to, and no existing semantic drag gesture in the app to
  stay consistent with. Revisit only if usage data later shows one action dominating enough to earn
  a shortcut.
- **Retrofitting this feature's `{A}`/`{B}` naming clarity into the existing Compare-commits
  multi-select + right-click entry point.** Tracked as its own separate, low-priority `ROADMAP.md`
  backlog item, not bundled into or blocked by this spec.
- **Any drag-based history editing** (reordering commits, squashing via drag, interactive-rebase
  todo-list planning). Already an existing non-goal in `specs/commit-graph.md`
  ("graph-driven history editing... scoped separately"); this feature only ever triggers existing
  whole-operation flows (compare/cherry-pick/merge/rebase) via git's plain, non-interactive form
  (`git merge`, `git rebase <upstream>` with no `--onto`/todo-list editing) — it never edits history
  structurally itself.
- **A general merge/rebase-initiation UI elsewhere in the app** (a toolbar "Merge branch…" action, a
  branch-chip drag target, etc.). `specs/merge-rebase-conflict-resolution.md` deferred "initiating" a
  merge/rebase generally; this spec fulfills that deferral only for the two-arbitrary-commits drag
  entry point described here, not a standalone merge/rebase-initiation feature.
- **A keyboard or Command Palette entry point for this feature.** The interaction is inherently a
  pointer/drag gesture; consistent with `specs/compare-commits.md`'s own precedent of shipping
  without a keyboard entry point, this pass does not add one either. This is a real, acknowledged
  accessibility gap, not an oversight — a keyboard-accessible equivalent (e.g. a "commit actions"
  command reachable from a selected pair) is a candidate fast-follow, not required for this spec.
- **Proactively disabling Cherry-pick/Merge/Rebase based on whether FR-309's checkout-if-needed step
  would itself succeed** (uncommitted-changes conflict, worktree conflict). Surfaced as a normal
  runtime refusal at click time, exactly like every existing switch/cherry-pick/merge/rebase refusal
  in this codebase — only the FR-307 ancestry table and FR-308's operation-in-progress/bare-repo/
  merge-commit checks are precomputed into the menu's enabled state.
- **A dedicated disabled/"unknown ancestry" UI state** for the rare case git itself runs successfully
  but cannot determine ancestry (e.g. a shallow-clone boundary — git returns an ambiguous exit code,
  not an error). Falls back to enabled per FR-295's explicit design, not worth the added complexity
  for v1. **This is narrower than "any ancestry-read failure"** — a genuine read failure (the process/
  IPC-level read never completing at all, distinct from git running and giving an ambiguous answer)
  is its own, deliberately different case; see FR-307's fifth state.
- **A toast or other transient confirmation on a successful action.** Matches `specs/cherry-pick.md`
  FR-116's precedent: success is communicated by the graph/panel/banner refresh itself (FR-314), not
  a separate notification. (The design draft's "clicking shows a toast naming the action" behavior
  was scaffolding for an intentionally non-wired mockup, not a shipped requirement.)

## Acceptance criteria

1. Dragging a commit node and releasing it onto a different commit node opens a menu styled
   identically to the existing right-click `ContextMenu` (same classes/visual treatment), showing a
   brief "computing…" state before settling into its final four-item, enabled/disabled state.
2. Dragging a commit node onto itself never opens a menu at any point; a blocked-cursor and/or
   `critical`-tinted rejection highlight shows during the drag instead.
3. The header reads "Dragged `{A}` onto `{B}`", using each commit's local branch name, else remote-
   tracking branch name, else tag name, else abbreviated SHA — verified against a commit with a local
   branch, a commit with only a tag, and a commit with no ref at all.
4. All four combinations of `computeCommitPairRelationship` are verified end-to-end: **A ancestor of
   B** → Merge disabled ("Already up to date"), Rebase disabled ("Nothing to replay"), Compare/
   Cherry-pick enabled; **B ancestor of A** → Merge/Rebase enabled (fast-forward), Compare/Cherry-pick
   enabled; **no common ancestor** → Merge/Rebase disabled ("No shared history between these
   commits"), Compare/Cherry-pick enabled; **diverged with real shared history** → all four enabled.
5. Selecting "Compare `{A}` with `{B}`" opens `CompareView` with the identical base/target assignment
   the existing multi-select + right-click flow would produce for the same two commits, regardless of
   which was dragged.
6. Selecting "Cherry-pick `{A}` onto `{B}`" when `{B}` is already `HEAD` cherry-picks `{A}` directly
   with no branch switch. When `{B}` is not `HEAD`, `HEAD` first switches to `{B}` (a real branch
   switch when `{B}` is a branch tip, a detached checkout otherwise), then `{A}` is cherry-picked —
   both the switch and the new commit are reflected in the graph/Toolbar with no app restart.
7. Selecting "Merge `{A}` into `{B}`" when B is an ancestor of A fast-forwards `{B}`'s branch to `{A}`
   with no merge commit created; on a diverged pair, creates a real merge commit — both verified via
   `git rev-parse`/`git log`.
8. Selecting "Rebase `{B}` onto `{A}`" when B is an ancestor of A is a no-op fast-forward; on a
   diverged pair, replays `{B}`'s unique commits onto `{A}` — verified via `git log` and confirming
   the replayed commits' content matches their pre-rebase diffs.
9. When FR-309's checkout-if-needed step is refused (e.g. uncommitted changes that would be
   overwritten by switching to `{B}`), the real git refusal reason is shown inline, no
   merge/cherry-pick/rebase call is made, and `HEAD`/working tree/index are unchanged.
10. A Merge or Rebase started from this menu that conflicts shows the same `StatusBanner`/
    `ConflictResolutionView` a terminal-started conflict would, with Abort and Continue both
    functional exactly as `specs/merge-rebase-conflict-resolution.md`'s existing acceptance criteria
    already require.
11. Escape, clicking outside the open menu, and scrolling the graph while it's open all close it —
    explicit regression coverage for the inline-style dismiss bug found during design review.
12. Every disabled menu item shows its specific reason via a tooltip; no disabled item is
    color-only or unexplained.
13. Re-running `specs/compare-commits.md`'s and `specs/cherry-pick.md`'s existing acceptance criteria
    against the multi-select + right-click flow passes unchanged — this feature adds a second entry
    point without altering the first.
14. Zero outbound network requests occur across all four actions and the FR-309 checkout step, on
    repos configured against GitHub, GitLab, Bitbucket, a self-hosted remote, and a purely local repo
    with no remote.
15. Repeating the full drag → menu → action flow with each of Ctrl, Alt, Shift, and Cmd/Meta held
    throughout the drag produces identical behavior to no modifier held.
16. No `merge-base`/`--is-ancestor` git process spawns occur while a node is being actively dragged
    (before release); exactly one round of three parallel spawns occurs immediately after release.
17. On a bare repository, Compare remains fully usable (matching `specs/compare-commits.md` AC11);
    Cherry-pick/Merge/Rebase are disabled with the existing bare-repo reason, not a new one.

## References

- `packages/desktop/src/components/ContextMenu/ContextMenu.tsx`, `ContextMenu.css` — the component
  FR-304 extends with an optional header slot, reused pixel-for-pixel.
- `packages/desktop/src/components/CommitGraph/CommitGraph.tsx` (`multiSelected`,
  `sortShasInGraphOrder`, `contextMenuItems`, `cherryPickTargets`) — the existing multi-select +
  right-click flow FR-319 leaves untouched; this spec's drag menu is a sibling entry point in the
  same file.
- `packages/git-core/src/types.ts` (`RefDecoration`, `CommitInfo.refs`, `MergeOperationDetail`,
  `RebaseOperationDetail`) — FR-305's name resolution and FR-315's conflict-pause detection both
  already exist and are reused as-is.
- `packages/git-core/src/errors.ts` (`OperationAlreadyInProgressError`,
  `InvalidArgumentError`) — the typed-refusal precedent FR-296/297/298 follow.
- `specs/compare-commits.md` (FR-181–196) — the Compare flow FR-310 invokes unmodified.
- `specs/cherry-pick.md` (FR-103–122, especially FR-113's "always targets HEAD, no picker"
  invariant and FR-115's disablement conditions) — the Cherry-pick flow FR-308/311 invoke unmodified.
- `specs/merge-rebase-conflict-resolution.md` (FR-58 detail types, FR-60/64/68 banner/resolution UI)
  — the detection/resolution infrastructure FR-297/298/315 build on; this spec is that spec's
  deferred "initiating a merge/rebase" follow-on, scoped to this one entry point only.
- `specs/branch-management.md` (FR-38 `git switch`, FR-39 `git switch --detach`) — reused verbatim
  by FR-309's checkout-if-needed precondition; no new checkout variant is added.
- `specs/commit-graph.md`'s Non-goals ("graph-driven history editing... scoped separately") — the
  prior non-goal this feature is related to but broader than; restated in this spec's own Non-goals
  for clarity.
- `DESIGN.md` (`critical` token, `#d03b3b`) — the self-drop rejection tint FR-302 reuses.
- `.playwright-mcp/page-2026-09-14T23-33-41-812Z.yml` — the approved design-draft accessibility
  snapshot this spec's exact header/label copy (FR-305/306) is taken from verbatim.

## Addendum 1 — cursor-following drag ghost (2026-09-16)

Reported by a real end user: today's drag feedback (FR-301's row dimming to 50% opacity in
place, plus `--drag-over`/`--drag-reject` on whatever row the pointer is over) gives no feedback
that tracks the cursor itself — nothing visually "moves" during the drag. User's own words: "when
i drag i dont see the drag action i thought of somthing like drag the ball itself." Given a choice
between a cursor-following ghost/dot, a connecting line only, or leaving it as-is, the user chose
the ghost/dot.

### Problem

`handleRowDragPointerDown` (`CommitGraph.tsx`) already tracks the drag's live state
(`dragState.sourceSha`/`hoverSha`) on every `pointermove`, but nothing renders at the pointer's
actual position — the only visible drag feedback is anchored to fixed row positions (the dimmed
source row, the highlighted hover row). A user whose eyes are on the cursor, not the row list, gets
no confirmation a drag is in progress at all until they happen to look at a row.

### Target user

Same as the base spec — no host/backend dependency, no new precondition.

### Must-have behavior

- **FR-322**: While `dragState` is non-null (i.e., for the exact duration `DRAG_THRESHOLD_PX` has
  already been crossed and a real drag is live — never during the pre-threshold jitter window),
  render a small floating element that repositions to the current pointer coordinates on every
  `pointermove`, offset a small fixed amount from the literal cursor tip (exact offset is
  ui-graphics's call) so it reads as "attached to the cursor" without sitting directly under it.
  Content: a filled dot in the dragged commit's lane color (the same "filled circle on its lane"
  treatment `DESIGN.md`'s "Commit node" convention already establishes — reuse the row's existing
  lane-hue token, no new color introduced) immediately followed by the dragged commit's abbreviated
  SHA in the app's existing monospace (`gh-mono`) convention. The dot alone doesn't disambiguate
  *which* commit is being carried when multiple lanes share a hue slot past 8 concurrent lanes
  (`DESIGN.md`'s lane-recycling note) — the SHA text is the non-color-dependent identity channel,
  consistent with this codebase's "never color alone" pattern applied to a new case.
- **FR-323**: The ghost element is `pointer-events: none` (or equivalent) at all times, so
  `resolveHoverSha`'s existing `document.elementFromPoint` + `.closest("[data-commit-sha]")`
  hit-testing is completely unaffected regardless of the ghost's z-order or momentary position —
  it must never itself be the element `elementFromPoint` returns.
- **FR-324**: When `dragState.hoverSha === dragState.sourceSha` (the self-drop case FR-302 already
  rejects), the ghost's styling reflects that same reject state — recoloring the dot (or an
  equivalent non-color-only change, e.g. swapping to the `critical` token consistent with
  `.gh-commit-row--drag-reject`'s existing treatment) rather than continuing to show its normal
  lane color as if the drop were valid. This is additive to, not a replacement for, the existing
  `not-allowed` cursor and `--drag-reject` row highlight — all three signals must agree, never
  contradict each other.
- **FR-325**: The ghost's mount/unmount lifecycle is exactly `dragState`'s own — it renders
  whenever `dragState` is non-null and is removed the instant it becomes `null`, no independent
  fade/lingering. Confirmed against the current code, `setDragState(null)` fires at exactly these
  two moments in `handleRowDragPointerDown`, and no others — both are non-negotiable cleanup
  points for the ghost as well:
  1. `onUp` (the `pointerup` handler) — called unconditionally on release, whether the gesture
     never crossed `DRAG_THRESHOLD_PX` (an ordinary click), ended in a self-drop, ended by
     releasing off any commit row, or ended by opening `dropMenu` on a valid distinct-commit drop.
  2. `onCancel` (the `pointercancel` handler).

### Non-goals

- **No new drop action, and no change to what Merge/Rebase/Cherry-pick/Compare do.** Purely an
  added visual affordance during the existing drag gesture defined by FR-301–303.
- **No native HTML5 drag-and-drop API adoption.** The existing pointer-capture-based gesture
  (FR-301's precedent, mirroring `useResizableWidth`) is unchanged; the ghost is a plain positioned
  element driven by the same `pointermove` handler already updating `dragState`, not an HTML5
  drag-image.
- **No animation/easing, trailing effect, or configurable appearance.** A single element that
  snaps to the current pointer position on each move — matching this drag gesture's existing
  un-animated, immediate feedback style (row dimming/highlighting are also instant, not eased).
- **No ref/branch-name resolution on the ghost** (unlike the drop menu's FR-305 header). The
  abbreviated SHA is sufficient identity for a transient cursor-follow element; the dragged row
  itself (already dimmed in place per FR-301) remains available for a user who wants full ref
  context.
- **No keyboard-accessible equivalent.** Same acknowledged, deliberate gap the base spec's own
  Non-goals already carries for this pointer-only gesture — this addendum doesn't change that.

### Acceptance criteria

18. From the moment a drag genuinely starts (past `DRAG_THRESHOLD_PX`) until it ends, a small
    element showing the dragged commit's lane-colored dot and abbreviated SHA is visible and
    updates its position on every pointer move, tracking the cursor.
19. The ghost never intercepts `resolveHoverSha`'s hit-testing — dropping directly on top of where
    the ghost is currently rendered still resolves to the real commit row underneath it, verified
    by a drop succeeding at a pointer position where the ghost visually overlaps the target row.
20. Hovering the drag back over the source commit's own row recolors the ghost to the same
    `critical`-token treatment `.gh-commit-row--drag-reject` already uses, in sync with the
    existing `not-allowed` cursor and row highlight — never contradicting either.
21. The ghost disappears immediately (same render frame, no lingering) on both: (a) releasing the
    pointer (`onUp`), covering the ordinary-click, self-drop, off-row-release, and valid-drop-menu
    outcomes alike, and (b) a `pointercancel` event (`onCancel`).
22. No change to any existing acceptance criterion (1–17) in this spec — the drop menu, ancestry
    checks, and all four actions behave identically with the ghost present.
