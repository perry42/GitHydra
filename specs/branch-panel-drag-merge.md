# PRD: Branches panel — drag a local branch card to merge (same gesture as the graph chip drag)

Status: approved by the user (2026-09-30), all four open questions answered with the recommendations below.
Owner: product-manager. Builds on the chip-onto-chip drag-to-merge shipped on `feat/ref-chip-drag-merge`
(behavior lives in `CommitGraph.tsx`: `beginDrag`, `dropMenu`, `handleChipDragPointerDown`), on
`specs/drag-commit-menu.md` (FR-295–319: `computeCommitPairRelationship`, `mergeCommit`, checkout-if-needed
FR-309, refresh FR-314, disabled-reason table FR-307/308) and on `specs/branch-management.md`.
FR numbers continue from FR-417.

## Decisions (user-approved)
- Other local cards ARE drop targets, in addition to graph chips (gutter and "+N" popover chips).
- Keyboard alternative: a Command Palette entry, "Merge branch into current branch…" (FR-437).
- The current branch's card CAN be dragged as the source (FR-420/429).
- Card affordance: grab cursor on hover only — no drag handle, no layout change.

## Must-have behavior

### Shared behavior (one implementation, both surfaces)
- FR-418: The drag session is ONE shared implementation used by graph chips and Branches panel cards (press +
  `DRAG_THRESHOLD_PX`, chip-shaped ghost with the branch name, self-drop rejection, hover-to-open "+N", drop
  resolution, the "Dragged A onto B" menu, the "Merge A into B" action). Because a panel-to-graph drag crosses
  components, the session and drop menu live above both (e.g. `App`), not inside `CommitGraph`. Internal shape
  (hook/component) is the implementer's call. Existing chip-drag and row-drag behavior/tests pass unchanged.
- FR-419: Ghost, hover/reject feedback, blocked cursor on self-drop, Escape/`pointercancel` abort and the 400ms
  "+N" auto-open are identical whether the drag began on a chip or a card.

### Drag sources
- FR-420: Every local branch card is a source, including the current branch and a branch checked out in another
  worktree. A is only merged in, never checked out.
- FR-421: Remote-tracking cards are neither sources nor targets.
- FR-422: Existing card controls keep working: a press-release below the threshold clicks normally; a real drag
  never fires the click of the control under the pointer; pressing directly on Checkout/Delete does not start a drag.

### Drop targets
- FR-423: Valid targets: local-branch chips in the gutter, local-branch chips in an open "+N" popover, other local
  cards. Invalid (no menu, no git call): remote chips/cards, tag chips, commit rows without a branch chip, empty
  space, the source itself (self-drop rejected like FR-302).
- FR-424: A branch's chip and card share one target identity (branch name + tip SHA); card A onto A's own chip is a
  self-drop.

### Menu and action
- FR-425: Menu identical to the chip-drag menu: header "Dragged A onto B", exactly one item "Merge A into B".
- FR-426: Enable/disable and reasons are the existing FR-307/308 computation, once at drop time
  (`computeCommitPairRelationship(tipA, tipB)`): A ancestor of B → disabled "Already up to date"; no shared
  history, ancestry read failure, operation in progress, bare repo, unborn HEAD → disabled with existing reasons.
  Reasons are tooltips, never color-only.
- FR-427: Selecting runs FR-309 checkout-if-needed for B (using the explicit `targetBranch`), then `mergeCommit(tipA)`.
  A checkout refusal is shown verbatim inline and no merge is attempted; conflicts surface through the existing
  StatusBanner/ConflictResolutionView (FR-315).
- FR-428: After the action refresh per FR-314 plus the Branches panel list (`reloadToken`: ahead/behind, Current badge).

### Edge cases
- FR-429: Current branch as A: allowed (B checked out first). As B: allowed (no checkout). Onto itself: self-drop.
- FR-430: Detached HEAD: drag allowed. Before the FR-427 checkout of B leaves a detached HEAD that carries commits no
  branch, tag or remote-tracking ref reaches, the pre-checkout guard (git-core `getOrphanedHeadCommits()`, see
  `packages/git-core/README.md` "Detached-HEAD orphan guard") shows a dialog on ANY leave of such a HEAD, with
  "Create branch here...", "Leave commits behind" and "Cancel" (Cancel is the default). Cancel aborts the whole drag with
  nothing changed (no checkout, no merge). "Create branch here..." creates the branch (`createBranchAtCommit`) and then
  continues the drag. "Leave commits behind" proceeds and afterwards shows a dismissible banner offering
  "Create branch at <sha>". A guard result of `unknown` (check failed or timed out) is treated as "ask". The confirmation
  is bound to the exact detached HEAD shown: the checkout passes `expectedDetachedHeadSha`, and a `HeadMovedError` aborts
  it with nothing changed (the UI re-queries and re-asks). The same guard covers every GitHydra-initiated checkout that
  leaves a detached HEAD (Branches-panel Checkout, graph Checkout, palette), not only drag.
  Limits, documented deliberately: (a) a checkout done in the user's own terminal cannot be guarded; (b) `reset`,
  `pull`, and `rebase` while detached are out of scope for this guard; (c) mid-operation (rebase/bisect/merge/...) and
  bare-repo states are not guarded (the operation-in-progress rules of FR-431 already apply).
- FR-431: Bare repo or in-progress merge/rebase/cherry-pick: drag may start/drop, item disabled with the FR-308 reason.
- FR-432: A source works even if its branch has no rendered graph chip (needs only name + `tipSha`). Dropping onto a
  graph chip needs that chip rendered; no auto-paging of the graph. Card-to-card covers hidden branches.
- FR-433: With a panel search filter active, filtered-out cards are not sources/targets; a drag never changes the
  search text.
- FR-434: Tips are resolved from fresh state at drop time; a vanished/moved A shows the read-failure state.
- FR-435: Collapsed sidebar renders no cards, so no panel drag.
- FR-436: No auto-scroll during a drag in v1.

### Keyboard / accessibility
- FR-437: Add a Command Palette entry "Merge branch into current branch…" in `getCommands()`
  (`packages/desktop/src/lib/commands.ts`): a picker of local branches; selecting A runs `mergeCommit(tipA)` into
  current HEAD with the same FR-426 disabled reasons and FR-428 refresh. No default keybinding. The entry is always
  listed. Opening the picker in a bare repo or during an in-progress operation shows every branch disabled, or a single
  inline message, with the FR-308 reason (identical to the drag menu's). The picker has no silent empty state;
  keyboard-only users can reach it.
- FR-438: Cards keep tab order and Enter/Space activation; no focus traps; ghost/drop feedback `aria-hidden`.
- FR-439: Card look: `cursor: grab` on hover (grabbing while dragging), `user-select: none`, target highlight fills
  the whole target card; no handle, no layout shift.

## Non-goals
Compare/Cherry-pick/Rebase from a branch drag; remote cards as sources/targets; tag chips or plain commit rows as
targets; drag-to-reorder or create/delete; auto-scroll/auto-paging; modifier-key variants; merge options
(--no-ff, --squash, message); a second confirmation dialog.

## Acceptance criteria
1. A card drag shows the same chip-shaped ghost as a chip drag, from threshold to release/cancel.
2. Card A onto chip B (gutter or "+N" popover row) opens "Dragged A onto B" with one item "Merge A into B"; hovering
   "+N" mid-drag opens the popover after 400ms and it closes after the drag.
3. Drop onto self, a remote chip/card, a tag chip or empty space: no menu, no git call, blocked cursor on self-drop.
4. Card A onto card B works the same way, with the whole target card highlighted.
5. Ancestry: A ancestor of B → disabled "Already up to date"; B ancestor of A → enabled fast-forward; diverged →
   enabled real merge commit; unrelated → disabled with reason.
6. B not current → switch to B then merge A; B current → no switch; dirty-tree refusal shown inline, nothing changed.
7. Conflicting merge lands in the existing banner/ConflictResolutionView.
8. Bare repo / in-progress operation → item disabled with the FR-308 reason.
9. A branch with no rendered chip is still a working source.
10. With a search filter active only visible cards participate; search text untouched.
11. Clicking name/Checkout/Delete behaves as today; a real drag never triggers them; remote cards never drag.
12. After the action graph, Toolbar, ChangesPanel, banner and Branches panel update without restart.
13. Regression: all existing chip-drag and row-drag tests pass unmodified; graph chips run on the shared code path.
14. The palette command merges a chosen local branch into the current one with identical disabled reasons.
15. Zero network requests across the flow.
