# Instant revisit for already-loaded tabs

Status: draft — proposed by product-manager per direct user request; not yet built.
Owner: product-manager
Sequencing: `packages/desktop` only (renderer-side caching + a `packages/git-core`-level reader
resumption detail for FR-245) — no Electron main-process IPC contract change; `RepoSession`
(`packages/desktop/electron/repoSession.ts`) is unchanged by this spec (see FR-244).
Revises one specific, previously-deliberate decision: `specs/multi-repo-tabs.md`'s Must-have 5/
Non-goal "activating a previously-visited tab shows the existing 'Opening repository…' loading
indicator... the commit list is refetched fresh from the top on activation" — that was correct
given the single-`RepoSession` constraint at the time, but always paying the full reload cost even
when nothing changed is worse than necessary, and this spec's whole point is showing a cheaper way
to honor the same constraint. Does not re-litigate `specs/restore-tabs-on-relaunch.md`'s FR-210
lazy-activation boundary — see Non-goals.

## Problem

Switching to a tab that was already open and already loaded earlier in the same session shows the
full "Opening repository…" spinner and refetches everything from scratch — commit rows, refs,
working-directory status, stash list — even when nothing in that repo has changed since the user
last looked at it. For a developer who keeps two or three repos open and glances back and forth
between them dozens of times a day (checking CI status on one while working in another, comparing
a fork against upstream), this turns every glance into a multi-hundred-millisecond full reload,
even though the underlying single-`RepoSession` architecture (`specs/multi-repo-tabs.md`'s
Architecture decision, option B) was chosen specifically because local git reads are supposed to be
fast. The cost is real but avoidable: most tab switches happen with nothing having changed in the
backgrounded repo at all.

## Target user

Any GitHydra user with more than one tab open who switches between them more than once per repo —
which is the entire point of tabs existing at all (`specs/multi-repo-tabs.md`'s target user). No
dependency on a specific git host or the presence of a remote, since this is pure local read
caching and re-verification.

## Must-have behavior

- FR-239: An in-memory, per-tab cache of the last-confirmed commit-log/aux-data snapshot, captured
  at the exact same moment `useRepoTabs.ts`'s `snapshotActiveTab()` already captures a tab's
  `RepoTabRemembered` (i.e., whenever that tab is backgrounded — an ordinary switch, or "+ New tab"
  deactivating it). Held only for currently-open tabs; a closed tab's cache entry is discarded
  immediately (extends `specs/multi-repo-tabs.md` Must-have 8's "closing a tab permanently discards
  its in-memory state" to this cache too — no separate eviction policy needed, since cache count is
  already bounded by open-tab count exactly the way `RepoTabRemembered` already is). Never written
  to `localStorage` or any other persisted store — this is strictly current-session, in-memory data,
  independent of `specs/restore-tabs-on-relaunch.md`'s FR-208 persistence.
- FR-240: What gets cached, and the size boundary that gates it: the tab's live rows + `hasMore` +
  lane-assignment state, and its parked unfiltered-baseline rows/`hasMore`/lane-assignment if one
  exists (`specs/multi-repo-tabs.md`'s AC-10 baseline snapshot) — but ONLY when each of those row
  arrays is at most `PAGE_SIZE` (150, `useRepositoryGraph.ts`'s existing constant) long at the
  moment the tab is backgrounded. A tab whose live view or parked baseline exceeds 150 rows (the
  user scrolled/loaded more before switching away) is not cached at all — every future reactivation
  of that specific tab does a full reload, unchanged from today. When eligible, also cached: `refs`,
  `repoState`, `workingDirChanges`, `stashCount`, `upstreamShortName`, the last-confirmed ref/HEAD
  snapshot and stash signature this hook already computes (`recordConfirmedSnapshot`,
  `stashSignature` in `useRepositoryGraph.ts`), and — if `commitDetail.status === "ready"` — that
  ready commit detail, keyed to its own sha.
- FR-241: Reactivating a tab with a valid FR-239/FR-240 cache entry always performs one fresh,
  cheap read against the target repo before deciding anything — the same `getState`/`getRefs`/
  `listStashes` calls `evaluateWatcherEvent` already performs for idle drift-detection today. This
  unavoidably requires pointing the single live `RepoSession` at the target tab's path first (every
  IPC read is session-scoped — see FR-244), but is a handful of quick git-plumbing spawns, not a
  commit-history walk. No new staleness-comparison logic is introduced: the fresh read is compared
  against the tab's cached last-confirmed snapshot using the exact same `hasUnexpectedRefChange`/
  `noChangeExpected` functions (`selfWriteGate.ts`) and `stashSignature` equality this app already
  trusts for the live tab's own external-change detection.
- FR-242: If FR-241's comparison finds no change at all (ref/HEAD state identical to the cached
  last-confirmed snapshot, and the stash signature unchanged): the cached rows/`hasMore`/
  lane-assignment (and cached `commitDetail`, if its sha still matches the tab's remembered
  selection) are applied directly — no `createLogReader`/`readPage` call is made. `repoState`/
  `refs`/`workingDirChanges`/`stashCount`/`upstreamShortName` are set from the FRESH read FR-241 just
  performed, never the cached copy — working-directory edits and stash changes (neither of which
  ever invalidates commit rows) are always shown live regardless of hit or miss. `status` is never
  set to `"opening"`, and the "Opening repository…" spinner is never shown for this path — mirroring
  the no-teardown precedent `refresh()`/`refreshRefsAndRows()` (`specs/refresh-without-teardown.md`)
  already established for other cases that must not force a full-page remount. `openSequence` still
  bumps exactly as it does for every repo-identity change, so `ChangesPanel`/`DetailPanel`/
  `BranchesPanel` correctly remount and re-fetch their own data (none of which is cached by this
  spec) for the newly-active tab.
- FR-243: If FR-241's comparison finds ANY change — a HEAD move, a branch/tag created/deleted/moved,
  an in-progress-operation starting or ending, a differing stash signature — or the tab has no
  eligible cache entry at all (FR-240's size boundary, a brand-new tab, or a
  restore-tabs-on-relaunch.md tab not yet activated this session): the tab falls back to exactly
  today's full reopen — `status` moves to `"opening"`, the existing spinner shows, and
  `createLogReader`/`readPage` reload the commit rows from the top. This spec narrows *when* a full
  reload happens; it does not change *what* a full reload does.
- FR-244: The single live `RepoSession` architecture (`specs/multi-repo-tabs.md`'s Architecture
  decision, option B) is completely unchanged. At most one tab's `Repository`/readers/watcher are
  ever live in the Electron main process. Reactivating a cached tab still tears down the previously
  active tab's watcher/readers and points the session at the newly active tab's path — FR-241's
  cheap read requires exactly that pointer swap. The "instant" feel this spec delivers comes from
  skipping the expensive commit-log walk on a hit, not from keeping multiple sessions alive; no
  second `Repository`, reader, or watcher is ever introduced per tab.
- FR-245: `loadMore()` on a tab that just fast-path-reactivated (FR-242) — which has cached rows but
  no live reader yet, since FR-242 never called `createLogReader` — transparently creates one and
  serves correct, contiguous results for anything beyond the cached first page; the user never sees
  a gap, a duplicate row, or an error from clicking "load more" afterward. The exact mechanism (e.g.
  a fresh reader silently fast-forwarding past the already-shown first page before returning page
  two) is git-core-engineer's implementation call, not prescribed here.
- FR-246: Zero new network calls anywhere in this feature, and identical behavior regardless of git
  host or the presence of a remote — restated per this project's standing non-negotiable, matching
  every prior spec's equivalent FR.

## Non-goals

- **Restoring exact scroll position** within the commit list on a fast-path reactivation. Whether
  the cached rows happen to make this incidentally possible is not required or tested — matches
  `specs/multi-repo-tabs.md`'s existing "scroll position is not guaranteed" non-goal, unchanged.
- **Caching more than the first page (150 rows)** of a tab's commit log. A tab scrolled deeper than
  that before being backgrounded always pays today's full-reload cost on its next reactivation
  (FR-240/FR-243) — a deliberate memory/complexity bound, not an oversight. Revisit only if real
  usage shows this boundary is hit often enough to matter.
- **Any second live `RepoSession`, `Repository`, reader, or file watcher per tab.** Deferred exactly
  as `specs/multi-repo-tabs.md`'s Architecture decision already defers "true concurrency" (option
  A) — this feature is renderer-level data caching only, not a backend rearchitecture.
- **Real-time detection of a change to a backgrounded tab's repo.** A backgrounded tab has no live
  watcher (single-session constraint, unchanged by this spec) — staleness is only ever discovered
  at the moment that specific tab is reactivated (FR-241), never before, and never as a background
  notification while some other tab is active.
- **Persisting this cache across an app relaunch.** Pure in-session, in-memory data.
  `specs/restore-tabs-on-relaunch.md`'s FR-210/FR-212 lazy-activation behavior is completely
  untouched — a relaunched tab's first activation this session always does a full reload, cache or
  no cache, exactly as that spec already specifies.
- **Changing what counts as an "external change" for the currently-ACTIVE tab's own live-watcher
  banner** (`hasExternalChanges`/`operationStateAlert`,
  `specs/graph-head-indicator-and-refresh-alerting.md`). That mechanism, and the functions it uses,
  are reused (FR-241) but not modified — this feature only concerns what happens the moment a
  background tab becomes active again.
- **A distinct "checking for changes…" indicator** for FR-241's cheap read phase. Given that read's
  own cost (a few plumbing calls, not a history walk), no new loading affordance is introduced
  beyond the existing `switching`-driven control-disabling (`useRepoTabs.ts`) already used for every
  tab switch today.

## Acceptance criteria

1. Open a repo in tab A, switch to tab B and back to tab A with nothing changed on disk in between:
   tab A's graph, refs, and selection reappear immediately, with no "Opening repository…" spinner
   shown at any point.
2. Same setup, but a commit lands in tab A's repo (from an external terminal or a `git pull`) while
   tab A is backgrounded: reactivating tab A shows the spinner and reloads from the top, correctly
   including the new commit(s) — never silently shows the stale pre-change graph.
3. Same, but the external change is a non-current branch/tag being created, deleted, or force-moved
   with HEAD's own sha unchanged: reactivating that tab still detects it and does a full reload.
4. Same, but the external change is a merge/rebase/cherry-pick being started or continued from
   another tool, with no named ref moving yet (`repoState.inProgressOperation` changes only):
   reactivating that tab still detects it, does a full reload, and shows the in-progress-operation
   UI correctly instead of a stale idle graph.
5. A tab backgrounded while already showing an undismissed `hasExternalChanges` banner (GitHydra
   had already detected drift before the tab was backgrounded): reactivating it always does a full
   reload — a stale confirmed-baseline snapshot is never mistaken for a cache hit.
6. Only a working-directory edit (a file modified externally, nothing staged or committed, no ref
   moved) between visits to a tab: reactivating it uses the fast path (no spinner, cached rows shown
   immediately) AND correctly shows the updated working-directory status (Changes badge count,
   uncommitted pseudo-node) — proving working-dir freshness never depends on which path was taken.
7. Only a stash created externally between visits to a tab (no ref/HEAD change): reactivating that
   tab performs a full reload, not the fast path, and shows the new stash count.
8. A tab whose live commit list had more than 150 rows loaded before switching away: reactivating it
   always does a full reload, even when nothing actually changed — verified by a case where the
   ref/HEAD/stash comparison alone would otherwise have been a clean hit.
9. Clicking "Load more" on a tab that just fast-path-reactivated (only its cached first page shown,
   no live reader yet) returns the correct next page of history with no duplicate or missing
   commits and no user-visible error.
10. Closing a tab discards its cache entry — reopening the same repo path afterward in a new tab
    always does a full reload on its first activation, never inherits a stale cache from the
    previously closed tab.
11. Across creating, switching to (fast- or full-path), and closing tabs on repos configured against
    GitHub, GitLab, Bitbucket, a self-hosted remote, and no remote at all: zero outbound network
    requests occur at any point.
12. A merge/rebase/cherry-pick conflict paused in tab A; switch to tab B and back to A with the
    conflict still unresolved and nothing else changed: the fast path applies (no spurious reload of
    the paused state), and every conflict-resolution action (Continue/Abort/Accept Ours/Accept
    Theirs/Mark as resolved) still works exactly as before switching away.
13. A brand-new tab (never activated this session) and a `specs/restore-tabs-on-relaunch.md`
    lazily-restored tab not yet activated this session both always show the full "Opening
    repository…" spinner on their first activation — the fast path never applies to a tab with no
    prior in-session cache entry.

## References

- `specs/multi-repo-tabs.md` — Architecture decision (option B, single live `RepoSession`, unchanged
  here per FR-244); Must-have 5/Non-goals ("commit list refetched fresh... on activation") is the
  specific decision this spec revises, with a stated reason (see header).
- `specs/restore-tabs-on-relaunch.md` FR-210/FR-212 — the lazy-activation boundary this spec
  deliberately leaves untouched (AC13): a tab with no in-session cache always full-reloads.
- `packages/desktop/src/hooks/useRepositoryGraph.ts` — `refreshAuxData`, `evaluateWatcherEvent`,
  `recordConfirmedSnapshot`, `stashSignature`, `PAGE_SIZE`, `OpenAttemptSnapshot` (the existing
  "capture everything before it might be overwritten" pattern FR-240's cache mirrors), and
  `refresh()`/`refreshRefsAndRows()`'s established "never touch `status`" precedent FR-242 reuses.
- `packages/desktop/src/hooks/selfWriteGate.ts` — `hasUnexpectedRefChange`/`noChangeExpected`,
  reused verbatim by FR-241 rather than reimplemented.
- `packages/desktop/src/hooks/useRepoTabs.ts` — `snapshotActiveTab`, `activateTab`/
  `activateTabCore`, `RepoTabRemembered` (the existing per-tab display-state precedent FR-239's
  cache sits alongside, but does not persist to `localStorage` the way `RepoTabRemembered` does).
- `packages/desktop/electron/repoSession.ts` — `RepoSession.open()`'s teardown/commit semantics;
  confirms every IPC read is session-scoped (no path parameter), which is why FR-241's cheap read
  still requires the pointer swap FR-244 describes.
