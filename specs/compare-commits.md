# Compare two commits directly

## Problem

GitHydra can only show a commit's diff against its own parent (`DetailPanel`'s file list +
`DiffView`, per `specs/detailpanel-auto-diff.md`). A working developer routinely needs to compare
two *arbitrary* commits instead — e.g. "what changed between these two tags," "what's different
between my branch's tip and main's tip," or "did commit A actually get picked up by commit B" —
none of which is a parent/child relationship. Today the only way to approximate this is external
to GitHydra entirely (a terminal `git diff`), which defeats the point of a visual git client.

## Target user

Any GitHydra user working in the commit graph — this has no dependency on a specific host
(GitHub/GitLab/Bitbucket/self-hosted/local-only), no dependency on a remote existing at all, and
works identically in a bare repository.

## Must-have behavior

- FR-181: A new `DiffSource` variant in `packages/git-core/src/diff.ts` for an arbitrary two-commit
  file diff — `{ kind: "commit-range"; baseSha: string; targetSha: string; path: string; oldPath?:
  string }` — wired through `getFileDiff()`'s existing binary/too-large/patch pipeline (FR-20/21/22
  from `specs/commit-graph.md`/`stage-unstage-diff.md`'s original diff work) unchanged. It reuses
  the same `--find-renames --find-copies` flags the existing `"commit"` kind already sets; the only
  difference is both endpoints are caller-supplied SHAs instead of one endpoint being derived from
  `parents[0]`.
- FR-182: A new `getChangedFilesBetween(repoPath: string, baseSha: string, targetSha: string):
  Promise<ChangedFile[]>` in `packages/git-core/src/changedFiles.ts`, using the same
  `--name-status -z --find-renames --find-copies` machinery `getChangedFiles` already uses, just
  taking both SHAs explicitly instead of deriving `base` from `parents[0]`. (Optional, non-binding
  suggestion: `getChangedFiles` could be refactored to call this internally with
  `base = parents[0] ?? EMPTY_TREE_SHA` for DRY — implementer's call, not required.)
- FR-183: Both new entry points validate each SHA independently with the existing `HEX_SHA_RE`
  check and throw `InvalidArgumentError` on failure — matching every existing SHA-accepting
  function in these two modules, no new validation style introduced.
- FR-184: No ancestry relationship between `baseSha`/`targetSha` is required or checked. `git diff
  <a> <b>` already produces a correct tree-to-tree diff for two unrelated/non-ancestor commits (two
  diverged branch tips, for example) — no `merge-base --is-ancestor` pre-check is added, consistent
  with this codebase's existing "git's on-disk state is the source of truth" convention
  (`specs/cherry-pick.md`'s Non-goals precedent for the same call).
- FR-185: Works identically against a bare repository — like the existing `"commit"` diff source,
  this only ever reads two existing commits' tree objects, never the working tree or index.
- FR-186: A new "Compare 2 commits" context-menu item in `CommitGraph.tsx`, **always visible** in
  the context menu (not conditionally rendered), placed near "Cherry-pick." Its enabled/disabled
  state and label depend on the current `multiSelected` size at right-click time, reusing the
  FR-111 shift-click-range / ctrl-or-cmd-click-toggle mechanism already shipped for cherry-pick (no
  new selection UI): at exactly 2 selected, it reads "Compare 2 commits" and is enabled; at 0 or 1
  selected, it is disabled with a tooltip ("Ctrl/Cmd-click another commit, then right-click to
  compare"); at 3+ selected, it is disabled with a tooltip ("Select exactly 2 commits to compare
  (N selected)"). Always showing the item, rather than hiding it outside the exactly-2 case, is a
  deliberate discoverability decision (per product-manager's UX review, 2026-09-06): a user who
  never learns the multi-select gesture on their own still discovers this feature exists via the
  same right-click every user already tries, instead of having no path to it at all.
- FR-187: Selecting it derives `[baseSha, targetSha]` via the existing `sortShasInGraphOrder`
  helper (the same one FR-114 uses for cherry-pick ordering): the more-ancestral/older-in-graph-
  order commit is always `baseSha`, the other is always `targetSha`, regardless of which of the two
  the user clicked first or second. This makes the diff direction deterministic — the same two
  commits always produce the same comparison regardless of click order.
- FR-188: Opens a new `CompareView` panel, structurally mirroring `DetailPanel`'s already-shipped
  file-list + `DiffView` split (`specs/detailpanel-auto-diff.md`'s pattern): a changed-file list
  (from FR-182's `getChangedFilesBetween`) on the left, `DiffView` on the right, the first file's
  diff auto-loading on open exactly like `DetailPanel`'s existing auto-diff behavior — reusing the
  same `useFileDiff` hook, pointed at a new IPC call built on FR-181 instead of `getCommitFileDiff`.
- FR-189: `CompareView` is a new top-level panel slot following the exact mutual-exclusion
  precedent `blameTarget` already establishes in `App.tsx` — a new `compareTarget: { baseSha:
  string; targetSha: string } | null` state that, when non-null, pre-empts rendering of all four
  existing `rightPanel` states (`"commit"`/`"changes"`/`"stashes"`/`"none"`) *and* `blameTarget`
  itself, the same way `blameTarget` currently pre-empts those four today. Opening Compare while
  any other right panel (including Blame) is open closes that other panel; closing Compare (its own
  close button) restores whatever `rightPanel` was already set to — matching `BlamePanel`'s
  existing close-restoration behavior exactly, not a new pattern.
- FR-190: The panel header identifies both commits unambiguously — abbreviated SHA + first line of
  commit message for each side, explicitly labeled which is "base" (older, per FR-187) and which is
  "target" (newer). No swap/reverse control in v1 (see Non-goals).
- FR-191: Same width-resizing/persistence pattern as `DetailPanel`/`StashPanel`/`BlamePanel`
  (`useResizableWidth`, sharing `RIGHT_PANEL_STORAGE_KEY`'s existing precedent) — no new layout
  mechanism invented for this one panel.
- FR-192: No network call anywhere in this feature. Both new git-core entry points only ever shell
  out to local `git diff`/`git cat-file` against already-fetched local commit objects — identical
  behavior regardless of remote host (GitHub/GitLab/Bitbucket/self-hosted) or absence of one.
  Restated explicitly per this project's non-negotiable no-network-by-default principle, matching
  `specs/cherry-pick.md` FR-110's precedent for the same guarantee.
- FR-193: A "Swap" control in `CompareView`'s header flips which of the two commits is currently
  labeled "base" vs. "target" and reloads the file list/diff accordingly (added per
  product-manager's UX review, 2026-09-06, replacing the flat no-swap stance FR-187 originally
  took). FR-187's graph-order pick remains the *default* on open — Swap is a user-initiated
  override, not a replacement for the deterministic default.
- FR-194: A plain single click on any commit row while `CompareView` is open closes `CompareView`
  and applies normal single-select behavior (updating `rightPanel`/opening `DetailPanel`) instead
  of being silently absorbed by `compareTarget`'s panel precedence. This amends FR-189: `blameTarget`
  suppresses a plain click's visible effect while active and `compareTarget` must not copy that
  specific behavior, since a Compare user is more likely to be casually clicking around the graph
  mid-session than a Blame user is.
- FR-195: Invoking "Compare 2 commits" again on a newly-made 2-commit selection while `CompareView`
  is already open replaces `compareTarget` in place — reloading the header/file list/diff for the
  new pair — rather than requiring the panel to be closed and reopened first.
- FR-196: The dashed multi-select highlight (`gh-commit-row--multi-selected`) on the two commits
  being compared persists in the graph for as long as `CompareView` stays open, so the user can
  visually confirm which two rows they're looking at. This is also a prerequisite for FR-195 to
  feel coherent (selecting a new pair while one is already displayed).

## Non-goals (v1)

- Comparing more than 2 commits at once (a 3-way or range summary). Selection sizes other than
  exactly 2 simply don't show the action (FR-186) — no error, no degraded mode. Revisit only if
  real demand shows up.
- Image diff parity (`specs/image-diff-preview.md`'s before/after rendering) inside `CompareView`.
  Image files fall back to `DiffView`'s existing generic "Binary file — content not shown."
  message for this pass. Wiring a `getCommitRangeImageDiff` equivalent is a small, isolated
  fast-follow once this ships, not required to land together with it.
- Comparing a commit against the working directory/uncommitted changes. That's a different,
  already-covered need (the existing unstaged/staged diff views) — this feature is specifically
  for two arbitrary already-committed points.
- Any new keyboard shortcut or command-palette entry point for triggering Compare. Reachable via
  the context menu only in this pass, consistent with "Keyboard shortcuts / command palette"
  being tracked as its own, separately-scoped floater. This decision is contingent on FR-186's
  always-visible-but-disabled discoverability fix landing together with this feature, not shipped
  independently — a hidden-unless-you-already-know-the-gesture entry point would not justify
  skipping a shortcut the same way a discoverable one does.
- A drag-one-commit-node-onto-another interaction for triggering Compare (or any other two-commit
  action). Raised during this spec's UX review (2026-09-06) as a potentially more discoverable
  entry point, but scoped as its own, separate, later initiative — see `ROADMAP.md`'s floater
  entry. It would need its own contextual drop-menu design covering every node-to-node action
  (compare, cherry-pick-onto, eventually merge/rebase-onto), not something derived piecemeal from
  this feature alone.
- Persisting `compareTarget` across a repo reopen/relaunch. Like `blameTarget`, it starts `null` on
  every fresh app/tab open — not folded into `rightPanel`'s existing persistence.

## Acceptance criteria

1. Ctrl/cmd-clicking a second commit row, then right-clicking either of the two selected rows,
   shows an enabled "Compare 2 commits" item in the context menu. Right-clicking any row while 0 or
   1 commits are selected shows the same item, disabled, with a tooltip explaining how to select a
   second commit.
2. Shift-clicking a contiguous 2-row range produces the same enabled "Compare 2 commits" item.
   Shift- or ctrl-selecting a 3+ row range shows the item disabled, with a tooltip stating how many
   commits are currently selected and that exactly 2 are required.
3. Selecting "Compare 2 commits" opens `CompareView`, replacing whatever right panel (Commit
   details/Changes/Stashes) or Blame view was previously showing.
4. The panel header identifies both commits (abbreviated SHA + first message line each), with the
   graph-order-older commit always labeled "base" and the newer "target" — verified by selecting
   the same two commits in the opposite click order and confirming the header and loaded diff
   content are identical either way.
5. The file list shows exactly the files that differ between the two commits (via
   `getChangedFilesBetween`), using the same status icons/rename-percentage treatment
   `DetailPanel` already uses; clicking a file loads its diff via FR-181's new diff source.
6. The first changed file's diff auto-loads immediately on opening the panel — no click required,
   no visible "Select a file" flash — matching `DetailPanel`'s existing auto-diff behavior.
7. Comparing two commits with identical trees (e.g. an empty commit compared to itself) shows "No
   files changed," the same state `DetailPanel` already renders for a no-change commit.
8. Comparing two commits where neither is an ancestor of the other (tips of two diverged branches)
   succeeds and produces a correct tree-to-tree diff — no ancestry-related error or crash.
9. Behavior and network-call count are identical with and without a configured remote — covered by
   a zero-network-calls test in the same style as the existing no-network-calls suite
   (`specs/cherry-pick.md` FR-110's precedent / `noNetworkCalls.test.ts`).
10. Closing `CompareView` restores the right panel to whatever it was showing before Compare was
    opened (or to fully closed, if nothing was open before) — matching `BlamePanel`'s existing
    close-restoration behavior.
11. Works against a bare repository the same as `DetailPanel`'s existing single-commit diff already
    does, since both only ever read commit tree objects, never the working tree.
12. A "Swap" control in the panel header swaps which commit is labeled "base" vs. "target" and
    reloads the file list/diff accordingly.
13. A plain single click on any commit row while `CompareView` is open closes `CompareView` and
    applies normal single-select behavior (opening `DetailPanel`/updating `rightPanel`) — the click
    is never silently swallowed.
14. Invoking "Compare 2 commits" on a newly-made 2-commit selection while `CompareView` is already
    open replaces the comparison in place, without requiring the panel to be closed first.
15. The two commits being compared keep their dashed multi-select highlight in the graph for as
    long as `CompareView` stays open.

## References

- `packages/git-core/src/diff.ts` (`DiffSource`, `planDiffArgs`, `getFileDiff`) — FR-181 extends
  this; FR-20/21/22's binary/too-large/patch pipeline is untouched.
- `packages/git-core/src/changedFiles.ts` (`getChangedFiles`) — FR-182's sibling function.
- `packages/desktop/src/components/CommitGraph/CommitGraph.tsx` (`multiSelected`,
  `multiSelectAnchorRef`, `sortShasInGraphOrder`, `cherryPickTargets`, `contextMenuItems`) — FR-186/
  187 reuse this verbatim; see `specs/cherry-pick.md` FR-111/112/114 for its original design.
- `packages/desktop/src/components/DetailPanel/DetailPanel.tsx` and
  `specs/detailpanel-auto-diff.md` — the file-list + `DiffView` split and auto-load-first-file
  behavior FR-188 mirrors.
- `packages/desktop/src/App.tsx` (`blameTarget`, `rightPanel`) — the panel-precedence pattern
  FR-189's `compareTarget` follows exactly.
- `packages/desktop/src/components/DiffView/DiffView.tsx` — reused as-is, no changes needed; it's
  already decoupled from "single commit vs. parent."
- `specs/cherry-pick.md` FR-110 — the no-network-call precedent FR-192 restates.
