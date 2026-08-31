# Amendment: self-write suppression for app-initiated checkout/branch-switch

Amends: `specs/commit-graph.md` FR-6 / AC11 (`hasExternalChanges`). To be folded into
`specs/graph-head-indicator-and-refresh-alerting.md` Problem 2, category (a), once that branch
merges — same target behavior, this is the first concrete AC + mechanism for the general
(non-operation-state) case.

## Problem

Every app-initiated checkout or branch switch shows the "History changed outside GitHydra —
Refresh" banner about its own action, because the fs-watcher has no way to distinguish a
self-caused write from a genuine external one. Root cause chain, confirmed in code: the app does
call a direct refresh (`refreshRefs()`) after its own checkout/switch, but `repoSession.ts`'s
`startWatch`/`watcher.ts` forwards every watcher fire to the renderer unconditionally, and
`useRepositoryGraph.ts`'s `onRefsChanged` handler sets `hasExternalChanges = true` on every such
event regardless of cause. Once the watcher's debounced event lands (~150ms after the checkout's
own disk write), the flag flips true and nothing clears it except a manual Refresh click.

This is not a new bug class — Problem 2(a)'s target behavior ("app-initiated changes never route
through the watcher/`hasExternalChanges` path") was already the stated intent — it just was never
implemented for the general checkout/switch case; only a narrower operation-state mechanism exists
elsewhere (the merge/rebase branch). This amendment gives the general case a concrete requirement
and mechanism.

## Target user

Same as `commit-graph.md` — any working git user, any host, any repo shape. This affects the
single most common mutating action in the app (checking out/switching branches), so it's a
high-frequency false positive, not an edge case.

## Must-have behavior

- **FR-6a:** The watcher-fired handler must not unconditionally set `hasExternalChanges = true`.
  It must compare a fresh read of ref/HEAD state against the last ref/HEAD snapshot GitHydra
  itself last confirmed, and only alert on an actual mismatch — consistent with the codebase's
  existing "read fresh state, no cached authoritative copy" pattern. The snapshot is updated after
  every comparison, match or mismatch.
- **FR-6b:** Because the watcher's fs event is debounced and can arrive either before or after the
  app-initiated operation's own confirming read resolves, a pure state comparison alone races: if
  the watcher's fresh read lands before the operation's own confirming read has updated the
  last-known snapshot, comparison against the stale (pre-operation) snapshot produces a false
  positive anyway. Close this by gating watcher-driven comparisons on the specific operation's own
  in-flight window — from the moment a mutating call (switchBranch, checkoutCommit, and future
  merge/rebase/cherry-pick/stash mutations) is issued until its own confirming read has resolved
  and updated the snapshot — not a fixed duration. A watcher event arriving during that window is
  deferred and re-evaluated once the operation's own read lands, rather than fired immediately or
  after a guessed timeout. The decision is always the FR-6a comparison; the gate only controls
  timing, never bypasses the comparison.
- **FR-6c:** This must cover both existing call sites that funnel through `App.tsx`'s
  `refreshAfterBranchOp`: `BranchesPanel` row checkout and the graph's commit-node "Checkout"
  context-menu action — one mechanism, not two.
- Implementation home: `useRepositoryGraph.ts`, since it already owns the `refs`/`repoState`
  snapshot and the `refreshRefs()`/`refresh()` calls that constitute "last confirmed state" —
  renderer-only change, no IPC contract change.

## Non-goals

- Rebuilding `watcher.ts`'s architecture (recursive `fs.watch`, debounce coalescing, the
  documented Linux recursive-watch gap) — unrelated, out of scope here.
- Watching `MERGE_HEAD`/`rebase-merge/`/etc. — that's `merge-rebase-conflict-resolution.md`
  FR-59's job, on its own branch.
- Suppressing genuine external changes. A `git pull`, hook, or teammate action — anything that
  produces ref/HEAD state GitHydra didn't itself just confirm — must still show the banner exactly
  as today. This amendment narrows false positives only; it must not create false negatives.
- Any change to `refreshWorkingDirStatus()` or the working-directory-status refresh path — that's
  separate from `hasExternalChanges`/refs and isn't gated by this flag today.
- Time-based/fixed-duration suppression as the actual accept/reject mechanism — a gate tied to an
  operation's real lifecycle is fine; a guessed millisecond window standing in for correctness is
  not.

## Acceptance criteria

1. Checking out a branch/commit via `BranchesPanel` or the graph's commit context menu never
   shows the "History changed outside GitHydra" banner as a result of that action alone — verified
   across 5+ consecutive checkouts in one session, not just the first.
2. After the app-initiated operation's own `refreshRefs()` resolves, `hasExternalChanges` remains
   `false` even after waiting past the watcher's debounce window with margin (e.g. 500ms+).
3. Artificially delaying the watcher's fs event well past any plausible fixed-window suppression
   (e.g. 2+ seconds) still correctly no-ops for a self-caused write — proves the mechanism is
   state-comparison-based, not a longer timer in disguise.
4. A genuine external change (checkout/commit/amend run in a separate terminal against the same
   repo while GitHydra is open and idle, no app-initiated operation in flight) still sets
   `hasExternalChanges = true` and shows the banner, unchanged from today.
5. An external change that races in during an app-initiated operation's in-flight window (mutate
   the repo from a second process between issuing the checkout and `refreshRefs()` resolving) is
   still detected and alerted once the in-flight window closes — the gate defers, it does not
   silently drop.
6. Manual "Refresh" continues to clear `hasExternalChanges` and reload exactly as today.
7. No regression to `commit-graph.md` AC11 (external rewrite while idle still requires/triggers a
   refresh).
8. Verified on Windows and macOS at minimum (the watcher's documented supported platforms); no new
   regression to Linux's already-documented degraded recursive-watch behavior.
