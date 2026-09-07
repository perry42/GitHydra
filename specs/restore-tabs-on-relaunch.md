# Restore open tabs across app relaunch

## Problem

Closing GitHydra throws away every open tab — `useRepoTabs.ts`'s `tabs` state always starts as
`[]` on launch (`useState<RepoTab[]>([])`). A user who works across several repos in one sitting
(e.g. three tabs open: `GitHydra`, a client project, a fork) has to manually reopen each one from
the Recent Repositories list (`specs/repo-list.md`, already shipped) every single time they
relaunch — one click per repo, every session, forever. Recent Repositories reduces that friction
from an OS folder dialog to one click; this closes the remaining gap to zero.

## Target user

Any GitHydra user who keeps more than one repo open across a work session and relaunches the app
regularly (a new day, an OS restart, an app update) — no dependency on a specific git host or on a
remote existing at all, since this is pure local tab/path bookkeeping.

## Must-have behavior

- FR-208: Tab identity — the ordered list of open tabs' `repoPath`s, and which one was active —
  persists to a new `localStorage` key (e.g. `githydra:sessionTabs`), written on every change to
  the tab list (tab opened, tab closed) and read once on `useRepoTabs`' initial mount. Same
  try/catch-guarded, gracefully-degrading pattern already used by `useTheme.ts`/
  `useResizableWidth.ts`/`useRecentRepos.ts` for every other persisted preference in this app — a
  read/write failure (e.g. private/sandboxed mode with `localStorage` unavailable) falls back to
  today's behavior (empty landing screen every launch), never a crash.
- FR-209: On launch, if a persisted session with one or more tabs exists, the tab bar is rebuilt
  immediately with those tabs in their prior order and the prior `activeTabId` restored (including
  the case where `activeTabId` was `null` — the user had quit while on the blank "+ New tab"
  landing screen with other real tabs still open in the background; see AC7). Rebuilding the tab
  bar itself makes no git calls for any tab — it is pure local state hydration from FR-208's stored
  data.
- FR-210: Only the previously-active tab (if any) is eagerly opened — a real `graph.openRepo` call
  — at launch, exactly mirroring what `activateTab` already does for an in-memory tab switch today.
  Every other restored tab stays idle, with no git process spawned for it, until the user actually
  clicks into it — at which point it goes through the exact same `activateTab` path (and pays the
  same real git-read cost) an ordinary mid-session tab switch already pays today. No new fetch path
  is introduced; restoration just re-enters the existing lazy-activation behavior across the reload
  boundary instead of only within one running session.
- FR-211: Each tab's `RepoTabRemembered` (`selectedSha`, `filter`, `showAllRefs`, `rightPanel`) is
  included in FR-208's persisted payload, so that when a lazily-restored tab is eventually
  activated, it replays exactly as it does for any other tab switch today (`activateTab`'s existing
  replay logic, unchanged) — not a fresh/empty state.
- FR-212: If a restored tab's `repoPath` no longer resolves to a valid repo (moved, deleted, `.git`
  removed since the last session), that is only discovered — and only surfaced — when the user
  actually activates that specific tab (consistent with FR-210's lazy-fetch principle: never
  eagerly probe every restored tab's validity at launch just to find this out sooner). The failure
  is shown the same way a stale Recent Repositories entry is shown today (`specs/repo-list.md`'s
  inline "not found" + "remove from list" treatment) — never a silent failure, and never allowed to
  abort restoring the rest of the session.
- FR-213: No network call anywhere in session persistence or restoration itself — this only ever
  reads/writes local paths and replays existing local git reads through the existing `activateTab`
  path. Restated per this project's non-negotiable no-network-by-default principle, matching
  `specs/cherry-pick.md` FR-110 / `specs/compare-commits.md` FR-192's precedent for the same
  guarantee.
- FR-214: Works identically for local-only, GitHub, GitLab, Bitbucket, self-hosted, and bare
  repos in the restored tabs, and identically with or without a remote configured — no host-specific
  behavior anywhere in this feature.

## Non-goals (v1)

- Restoring in-memory graph data, scroll position, or anything `useRepositoryGraph` itself holds —
  only tab identity plus the same `RepoTabRemembered` fields already persisted-in-memory across an
  ordinary tab switch today. Everything else is cheap to refetch on activation, per that type's own
  existing doc comment.
- Eagerly pre-fetching every restored tab's git data in the background at launch. Explicitly
  rejected in favor of FR-210's lazy activation — fetching N tabs' worth of git data concurrently
  at startup would both waste work on tabs the user may not revisit this session and compound the
  concurrent-git-spawn contention already tracked in `ROADMAP.md`'s flaky-test-suite entry.
- The separate, already-queued "remember last-selected file within a tab" item. Orthogonal — both
  extend tab-scoped persisted state, but neither depends on the other and they can land in either
  order.
- Fixing `resolveGitExecutablePath()`'s slow-first-call issue (`ROADMAP.md`, separately tracked).
  The eagerly-restored active tab (FR-210) is still subject to that same first-spawn cost if it
  remains unresolved — this feature doesn't make that faster, it just automates reaching the same
  point a manual reopen would.
- Any cross-device or cloud sync of session state. Pure local `localStorage`, matching every other
  persisted preference in this app (theme, layout widths, recent repos) — no proprietary backend.
- Reordering tabs by drag. Not part of this feature; if it's added later, FR-208's persistence
  needs to track order-changes too, but no reordering UI exists today so there's nothing to persist
  beyond append/remove order.

## Acceptance criteria

1. Open 3 different repos in 3 tabs, quit the app, relaunch — the tab bar shows the same 3 tabs, in
   the same order, on the very first render after launch.
2. The tab that was active when the app quit is active again on relaunch, and its commit graph
   loads automatically with no user interaction required.
3. The other (inactive) restored tabs appear in the tab bar but trigger zero git process spawns
   until clicked — verified by a call-count assertion at launch, the same style as the existing
   zero-network-calls tests (`noNetworkCalls.test.ts` precedent) but asserting on git-spawn count
   instead.
4. Clicking an inactive restored tab loads it exactly like `activateTab` already does for an
   in-memory-only tab switch today, replaying that tab's remembered `selectedSha`/`filter`/
   `showAllRefs`/`rightPanel`.
5. If a restored tab's path no longer resolves to a valid repo, activating it shows the same inline
   "not found" handling as a stale Recent Repositories entry — not a crash, and not an app-wide
   error screen that swallows the rest of the restored session.
6. Quitting with zero tabs open (already on the empty landing screen) and relaunching shows the
   empty landing screen again — never a phantom tab.
7. Quitting while on the blank "+ New tab" landing state (`activeTabId === null`) with other real
   tabs still open in the background restores those real tabs, unfocused, with the landing screen
   shown on top — matching exactly the state the user left, not silently refocusing one of the
   background tabs.
8. No network calls occur anywhere in session persistence or restoration — only the existing,
   already-covered local git reads triggered by the restored active tab's `activateTab` call.
9. Restoration behaves identically regardless of git host (GitHub/GitLab/Bitbucket/self-hosted/
   local-only) or the presence of a remote at all.
10. With `localStorage` unavailable (e.g. a private/sandboxed environment), the app falls back to
    today's behavior — an empty landing screen every launch — never a crash or unhandled exception.

## References

- `packages/desktop/src/hooks/useRepoTabs.ts` (`RepoTab`, `RepoTabRemembered`, `activateTab`,
  `tabs`/`activeTabId` state) — this feature persists and rehydrates exactly these shapes; FR-210's
  lazy activation reuses `activateTab` verbatim, no new fetch path.
- `packages/desktop/src/hooks/useRecentRepos.ts` (`RECENT_REPOS_KEY`) and
  `packages/desktop/src/hooks/useTheme.ts` (`STORAGE_KEY`) — the try/catch-guarded
  read/write-on-change `localStorage` pattern FR-208 follows.
- `specs/repo-list.md` — the inline "not found" + "remove from list" treatment FR-212 reuses for a
  stale restored tab, and the existing Recent Repositories list this feature is the natural next
  step beyond.
- `specs/cherry-pick.md` FR-110 / `specs/compare-commits.md` FR-192 — the no-network-call precedent
  FR-213 restates.
- `ROADMAP.md`'s "Open tech debt — git-core test suite is flaky under full parallel load" and
  `resolveGitExecutablePath()` entries — the concurrent-git-spawn contention this spec's lazy
  activation (FR-210) deliberately avoids compounding, and the separate first-call latency issue
  this spec does not attempt to fix.
