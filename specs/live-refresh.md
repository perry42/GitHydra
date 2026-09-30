# Live refresh

Status: draft. Owner: product-manager. **Revises** `specs/graph-head-indicator-and-refresh-alerting.md` Problem 2(b) ("always alert, never silently apply"). Amends `specs/self-write-refresh-suppression.md` AC4 and AC7, and `specs/commit-graph.md` FR-6/AC11. It does **not** revisit FR-59's operation-state alert (see FR-464).

## Problem
1. External edits to working files (an IDE, a script, `git add` in a terminal) are never detected: `watcher.ts` watches refs/HEAD/operation-state only, so the Changes list goes stale until the user acts.
2. External ref changes (a fetch, a push from elsewhere) always raise a banner needing a click, even when the user is doing nothing. The original decision protected a user mid-task from content changing under them; it was applied to every moment, including idle ones.

GitKraken auto-updates the file list but not an open diff. We go further with an ownership rule: the thing the user is actively interacting with is never changed under them; everything else stays current.

## Target user
A developer who edits in an IDE or terminal and keeps GitHydra open beside it, on any repo or host.

## Must-have behavior
- **FR-457 (revision statement):** Problem 2(b)'s "always alert, never silently apply" is replaced by FR-463 to FR-465. "Never act on stale data" is preserved for in-progress operations (FR-464) and for partial staging via `specs/hunk-line-staging.md` FR-449.
- **FR-458 (working-tree detection, spike first):** Detect external working-tree/index changes via window focus/visibility regain; the existing `gitDir` watch firing on index writes; and a best-effort recursive working-tree watch (Windows/macOS), ignoring `.git` and git-ignored top-level directories. git-core-engineer spike with a performance budget (idle CPU and event flood on a repo with `node_modules` or 100k files). If the budget fails, ship focus plus index events only. The Linux recursive gap stays documented.
- **FR-459 (refresh hygiene):** Live status refreshes are debounced, coalesced (at most one in flight plus one trailing), and use `--no-optional-locks`. They must never write to the index or trigger the watcher themselves.
- **FR-460 (file list):** The Changes file list updates live. The selected file stays selected by path; list scroll is preserved. If the selected file moves between sections (e.g. staged externally), selection follows the path and its diff reloads from the new side.
- **FR-461 (open diff):** An open diff reloads live when its content fingerprint changed (not merely its mtime), keeping scroll position. If the file no longer has changes, the pane shows "This file no longer has changes" and waits for the user to pick another file (no auto-select).
- **FR-462 (self-writes):** Self-write suppression (FR-6a/6b) is unchanged. Working-tree refreshes have no alert to suppress; after an app mutation the existing direct refresh runs, and a following watcher-triggered refresh is deduped by status signature with no flicker, reselect or scroll change. An external change during a mutation's in-flight window is still captured by the closing `refreshRefs()` diff (self-write AC5), and its outcome follows FR-463 to FR-465.
- **FR-463 (graph, idle):** When idle, external ref/branch/tag/stash changes (e.g. a fetch) are applied silently. Selection is kept by SHA, the loaded-row count and scroll position are kept (reuse `refresh-without-teardown`), and the HEAD indicator updates.
- **FR-464 (still alerts):** These keep the alert exactly as shipped: operation-state changes (merge/rebase/cherry-pick/revert started, changed or ended externally), with Continue/Abort/Accept/Mark-resolved disabled until Refresh; and HEAD moved externally (checkout, or a commit on the current branch from a terminal), because the user's context changed. Revisit silent fast-forward HEAD moves after real use.
- **FR-465 (idle gate):** The app is not idle when a modal, menu or popover is open; the commit composer has focus or a non-empty draft; a drag is in progress; a mutation is in flight; or the user is in the conflict-resolution view. While not idle, graph changes FR-463 would apply raise the existing ordinary banner (Refresh button) instead.
- **FR-466:** No settings toggle, no polling timer, no network. A live update leaves no visual trace (the content change is the signal).

## Non-goals
- Edit-mode conflict handling (`specs/edit-in-diff.md` owns it).
- A notification/toast system, or a "what changed" diff of the graph.
- New polling.
- Live refresh of historical-commit diffs (immutable).
- Changing the operation-state alert design.
- Linux recursive-watch parity.

## Acceptance criteria
1. Edit a file in another editor and save while GitHydra is open and idle. The Changes list reflects it within about 1s of the watcher debounce (or on focus regain if the watcher is disabled by the spike), with no click.
2. Stage a file in a terminal with `git add`. It moves to Staged in the list, selection is preserved by path, and there is no banner.
3. An open diff on a changed file reloads with scroll retained. An open diff on an unchanged file is not reloaded (no flicker, verified by DOM node identity).
4. Externally revert an open file to match HEAD. The pane shows "no longer has changes" and the list drops the entry.
5. Idle, run `git fetch` externally. The graph updates with no banner, selection stays on the same SHA, scroll is unchanged, loaded rows are not reset.
6. Run `git checkout` or commit externally. The HEAD-moved alert appears and nothing is applied until Refresh.
7. Start a rebase or merge externally. The operation-state alert appears and gated actions are disabled, unchanged (regression on the original Problem 2 AC3/AC4).
8. With a modal open, the commit composer focused, a drag in progress, or a mutation in flight, an external fetch does not change the graph; the ordinary banner appears instead.
9. Five consecutive app-initiated mutations never show a banner (self-write AC1 unregressed). Live refresh running concurrently causes no duplicate refresh and no selection change.
10. Live refreshes never modify `.git/index` (mtime and bytes unchanged) and never self-trigger a loop: idle for 30s produces zero further refreshes.
11. Affected ACs updated: graph-head-indicator Problem 2 AC2 narrowed to "HEAD/operation changes are never silently applied"; self-write AC4 and AC7 require the banner only for HEAD/operation changes or when not idle; manual Refresh still clears any banner (self-write AC6).
12. Zero outbound requests.
