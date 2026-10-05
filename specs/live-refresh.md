# Live refresh

Status: decided (user quiz, 2026-10-05); working-tree watcher spike pending. Owner: product-manager. **Revises** `specs/graph-head-indicator-and-refresh-alerting.md` Problem 2(b) ("always alert, never silently apply") and the "external HEAD move" non-goal in its Problem 1. Amends `specs/self-write-refresh-suppression.md` AC4/AC7 and `specs/commit-graph.md` FR-6/AC11. Keeps FR-59's operation-state alert unchanged (FR-464). Default stance: behave like GitKraken unless there is a concrete improvement.

## Problem
1. External edits (IDE, script, `git add` in a terminal) are never detected: `watcher.ts` watches refs/HEAD/operation-state only, so the Changes list goes stale.
2. External ref and HEAD changes always raise a banner needing a click, even when the user is idle.

Rule: the thing the user is actively interacting with is never changed under them; everything else stays current without asking.

## Target user
A developer who edits in an IDE or terminal with GitHydra open beside it, on any repo or host.

## Must-have behavior
- **FR-457 (revision):** Problem 2(b)'s "always alert" is replaced by FR-463 to FR-465 and FR-492. "Never act on stale data" survives for in-progress operations (FR-464) and partial staging (FR-449, FR-493).
- **FR-458 (working-tree detection, spike first):** detect external working-tree/index changes by (1) window focus/visibility regain, (2) the existing `gitDir` watch firing on index writes, (3) a best-effort recursive working-tree watch (Windows/macOS) ignoring `.git` and git-ignored top-level directories. Budget: idle CPU near zero and a bounded event flood on repos with `node_modules` or 100k files. If the budget fails, ship (1)+(2) only. The Linux recursive gap stays documented.
- **FR-459 (hygiene):** live status refreshes are debounced, coalesced (one in flight plus one trailing), and run with `--no-optional-locks`. They never write the index and never trigger the watcher. Any watcher event source excludes paths a refresh itself touches (e.g. `index.lock`).
- **FR-460 (file list):** the Changes list updates by itself within about 1s of the change, with no click. The selected file stays selected by path and list scroll is kept. If it moves sections (e.g. staged externally), selection follows the path and the diff reloads from the new side. No "changed" flash or marker. The list is not subject to the idle gate (FR-465); typing a commit message does not pause it.
- **FR-461 (open diff):** an open diff whose content fingerprint changed (not merely mtime) reloads quietly in place, keeping scroll position. Unchanged diffs are not re-rendered. If the file no longer has changes, the pane shows "This file no longer has changes" and waits. It never auto-selects another file; the list drops the entry.
- **FR-462 (self-writes):** FR-6a/6b are unchanged. After an app mutation the direct refresh runs. A following watcher refresh is deduped by status signature (no flicker, reselect or scroll change). An external change inside a mutation's in-flight window is still caught by the closing `refreshRefs()` diff and then follows FR-463 to FR-465 and FR-492.
- **FR-463 (graph, idle):** when idle, external ref/branch/tag/stash changes (fetch, push, ref updates) apply silently. Selection is kept by SHA; scroll and loaded-row count are kept (`refresh-without-teardown`); chips and the HEAD indicator are re-decorated on loaded rows (Addendum 2).
- **FR-464 (operation-state alert, unchanged):** merge/rebase/cherry-pick/revert started, changed or ended externally keeps today's distinct alert. Continue/Abort/Accept/Mark-resolved stay disabled until Refresh. This is never silent and never idle-applied. Decided with product-manager while the user was away (2026-10-05); user to confirm on return.
- **FR-465 (idle gate):** not idle means any of: modal/menu/popover open; commit composer focused or draft non-empty; drag in progress; mutation in flight; conflict-resolution view; an unacknowledged operation-state alert. While not idle, changes FR-463/FR-492 would apply show the existing ordinary Refresh banner. Applying while busy is deferred (FR-492), never dropped.
- **FR-466:** no settings toggle, no polling timer, no network. A silent apply leaves no visual trace.
- **FR-492 (HEAD moved externally; one rule):**
  1. Applies to a checkout, a branch switch, or a commit on the current branch from a terminal, including detached HEAD. It is detected by `evaluateWatcherEvent`'s comparison against the last confirmed snapshot, not by `selectedSha` changes.
  2. Idle: apply silently, as if the app had done it. Refs/rows refresh, then selection and scroll follow the new HEAD (the same `followSignal` path as an app-initiated checkout; chase-pagination per Addendum 1b). The DetailPanel and Changes panel switch to it. No banner.
  3. Not idle: show the ordinary banner, change nothing, and apply automatically when the app next becomes idle (the banner clears). Manual Refresh applies immediately. This avoids yanking a half-typed commit or an open modal.
  4. If an operation-state alert is unacknowledged, rule 2 does not run until Refresh. Rebases move HEAD repeatedly, so only the operation alert shows.
  5. Addendum 3 stands: tab reactivation and relaunch replay never scroll. Only a genuine detected HEAD move (app-initiated or externally detected) follows.
  6. Rule 2 follows even when the idle user is reading a commit they selected (what GitKraken does). Decided with product-manager while the user was away; fallback if it feels aggressive: follow only when the selection was on the old HEAD or empty. Revisit after real use.
- **FR-493 (checkbox diff):** rows and fingerprint are replaced atomically in one render commit. A toggle sends the fingerprint of the rows it was clicked on, so a refresh can never change which rows a pending toggle applies to; a mismatch refuses with `STALE_DIFF` ("File changed. Diff reloaded.") per FR-449/FR-454, with no retry. While a toggle or range apply is in flight, a live reload is deferred until it resolves. A reload that changes the fingerprint clears the Shift-range anchor and any mid-toggle focus target that no longer exists (focus falls to the nearest surviving row or hunk header). Scroll and cursor are kept (FR-485). Edit mode: `specs/edit-in-diff.md` owns conflict handling; a live reload never replaces text the editor holds.

## Non-goals
- Edit-mode conflict handling (`specs/edit-in-diff.md`, FR-474).
- Toasts/notifications, "what changed" views.
- New polling, or Linux recursive-watch parity.
- Live refresh of historical-commit diffs (immutable).
- Changing the operation-state alert design.
- A "jump to HEAD" button.

## Acceptance criteria
1. Edit a file externally while idle: the list reflects it within about 1s, no click, no marker. (If the spike disables the tree watch: on focus regain.)
2. `git add` externally: the file moves to Staged, selection stays by path, no banner.
3. A changed open diff reloads with scroll kept. An unchanged open diff keeps the same DOM nodes.
4. Revert the open file to HEAD externally: the pane says "This file no longer has changes", the list drops it, nothing else is auto-selected, and it waits.
5. Idle, external `git fetch`: no banner; selection SHA, scroll and loaded rows unchanged.
6. Idle, external `git checkout <branch>`, `git checkout <sha>` (detached) and a terminal commit on the current branch: each applies silently with no banner. The HEAD indicator and chips are correct, selection and scroll land on the new HEAD, and the DetailPanel shows it.
7. The same three moves while a modal is open, the composer has a draft, a drag is active, a mutation is in flight, or the conflict view is open: ordinary banner, graph and selection unchanged. When the condition clears, it applies by itself and the banner clears. Manual Refresh applies immediately.
8. Regression: external rebase/merge/cherry-pick/revert start, change and end raise the operation alert, disable gated actions until Refresh, and are never idle-applied. The rebase's HEAD moves do not trigger FR-492 rule 2.
9. Five consecutive app mutations show no banner (self-write AC1). The concurrent watcher refresh causes no duplicate refresh, reselect or scroll change.
10. Live refreshes leave `.git/index` bytes and mtime unchanged. Idle for 30s produces zero refreshes, including with the tree watch on.
11. Shift-range toggle with an external edit landing between the anchor and the second click: the apply either sees the matching fingerprint and hits the intended rows, or is refused as `STALE_DIFF`. It never hits other rows. The anchor is cleared after the reload. Same for a single toggle mid-flight.
12. Tab reactivation or relaunch still never scrolls the graph (Addendum 3 AC1 to AC3 unregressed).
13. Zero outbound requests; manual Refresh still clears any banner (self-write AC6).
