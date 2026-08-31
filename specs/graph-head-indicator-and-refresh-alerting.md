# Spec Addendum: HEAD Position Indicator + Refresh-Alert Semantics

Status: draft
Owner: product-manager
Parent specs: `specs/commit-graph.md` (amends FR-17, sharpens the "Detached HEAD" acceptance
criterion), `specs/branch-management.md` (extends FR-56's "refresh everywhere" precedent),
`specs/merge-rebase-conflict-resolution.md` (**revises FR-59** — this replaces its "silent
auto-refresh" plan before that branch merges, not a reversal of shipped behavior)

This is a UX-clarity/trust fix on already-shipped commit-graph behavior, plus a correction to
FR-59 before the branch implementing it merges to `main`, surfaced by user feedback after
reviewing the conflict-resolution feature. Not a new v1 priority item.

## Problem 1 — HEAD/current-position indicator is ambiguous

After an app-initiated checkout (or any action that moves HEAD), the graph's HEAD ring and the
row-selection ring render as the same color at nearly the same size, and selection never follows
HEAD — so a user who just checked out a commit sees two near-identical highlighted rows and can't
tell which one is actually current, unlike GitKraken's unambiguous "you are here" marker.

### Target behavior

1. The HEAD/current-position indicator must be visually distinct from the selection highlight by
   shape or label, not color/size alone (color-only differences are unreliable, including for
   color-vision-deficient users) — e.g. a small "HEAD" tag/pill anchored to the row, distinct from
   the accent-colored selection ring. Exact visual treatment is ui-graphics's call against
   `DESIGN.md`'s token system — the constraint is unambiguous at-a-glance distinguishability, not a
   specific pixel spec.
2. Any app-initiated action that moves HEAD — detached-HEAD checkout, branch switch, or completing
   a merge/rebase/cherry-pick/revert via Continue — moves the graph's *selection* to the new HEAD
   commit and scrolls it into view, in the same action that already refreshes refs. No extra click
   required; this is wiring `selectCommit(newHeadSha)` into paths that already know the new SHA,
   not new watcher/refresh plumbing.
3. This does not weaken `commit-graph.md` FR-17 (HEAD stays visually marked "at all times, not
   just on selection"): once auto-follow lands the user on the new HEAD, they remain free to click
   away to inspect a different commit — the HEAD indicator stays put on the HEAD commit while the
   selection ring moves with the click, and both are simultaneously visible and distinguishable.

### Non-goals

- A standalone "jump to HEAD" button/shortcut for the case where the user has scrolled away with
  no app action involved — real idea, but not what this feedback asked for; v2 fast-follow
  candidate, not built here.
- Any change to selection behavior for externally-initiated HEAD moves (e.g., someone runs
  `git checkout` in another terminal) — that's covered by Problem 2's alert model, not auto-follow;
  auto-follow only applies to actions GitHydra itself performed.
- Redesigning the general selection/DetailPanel model beyond this fix.

### Acceptance criteria

1. The HEAD indicator and the selection-highlight indicator are distinguishable by shape or label,
   not color alone — verified by design/visual review, in both light and dark theme.
2. Checking out a commit from GitHydra's own UI (detached HEAD) results in `selectedSha` equal to
   the new `headSha` and that row scrolled into view, verified without any additional click.
3. Switching branches from GitHydra's own UI produces the same auto-select-and-scroll to the new
   branch tip's SHA.
4. Completing a merge/rebase/cherry-pick/revert (Continue) from GitHydra's own UI produces the
   same auto-select-and-scroll to the resulting commit's SHA.
5. After auto-follow lands on the new HEAD, clicking a different, older commit moves the selection
   ring to that row while the HEAD indicator remains on the HEAD commit — both visible and
   distinguishable at once (regression check against `commit-graph.md` FR-17).
6. In detached-HEAD state, the same auto-follow and distinct-indicator behavior applies — extends
   `commit-graph.md`'s existing "Detached HEAD" acceptance criterion (today: HEAD label visually
   distinguished from branch-tip label; this adds: selection tracks it).

## Problem 2 — Refresh/staleness alerting model

### Target behavior — two categories, one consistent rule

**(a) App-initiated changes** (checkout, branch switch, stage/unstage/commit, and
merge/rebase/cherry-pick/revert continue or abort from inside GitHydra): **never** show a
stale/refresh-needed banner, at any point. These are handled by the action's own success path
directly calling the existing direct re-fetch functions — never routed through the
fs-watcher/`hasExternalChanges` path at all, so there's no staleness window to alert about.

**(b) Externally-initiated changes** (another terminal, a hook, a teammate, any process outside
this GitHydra window) — **always alert, never silently apply**, with no exception for the
operation-state case. This revises FR-59's silent-auto-refresh plan: the watcher's detection of
operation-state changes (MERGE_HEAD/rebase-merge/CHERRY_PICK_HEAD/REVERT_HEAD created, updated, or
removed) stands, but the *response* changes from silent auto-refresh to an alert, matching FR-6's
already-shipped manual-banner precedent, sharpened for this specific danger:
- The alert is a distinct variant from the ordinary "History changed outside GitHydra" ref-churn
  banner — distinct copy naming the operation (e.g. "The in-progress rebase changed outside
  GitHydra — click Refresh before continuing"), same or higher visual prominence.
- While that specific alert is unacknowledged, conflict-resolution actions (Continue, Abort, Accept
  Ours/Theirs, Mark as resolved) are disabled until the user clicks Refresh.

This resolves the tension in FR-59's original reasoning: "silent is safer" only weighed the risk
of a *stale* banner. It didn't weigh the symmetric risk silent auto-refresh introduces — content
(a diff the user is mid-reading) swapping under them without warning, or a button they were about
to click now mapping to different underlying data once clicked. An explicit, hard-to-miss,
one-click alert closes the "acting on stale data" danger without introducing that second danger.

### Non-goals

- No general notification/toast system. Reuse the existing `StatusBanner`/`hasExternalChanges`
  pattern with one additional distinct copy/priority variant for the operation-state case.
- No settings toggle for "silent vs. alert." One consistent behavior, no added configuration
  surface.
- No new polling mechanism. Still the existing best-effort `fs.watch`-based watcher and its already
  documented platform caveats — this addendum changes what happens after detection, not how
  detection works.
- No change to FR-6's existing ordinary ref-churn banner — it already matches "alert, don't
  silently apply," so it's unchanged.

### Acceptance criteria

1. Every app-initiated action listed in (a) never shows a stale/refresh-needed banner at any point
   during or after the action, and the UI reflects the action's own result (headSha, refs,
   conflicted-file list, banner text) with no user-clicked refresh required.
2. Running `git checkout`, `git merge`, `git rebase --continue`, or externally editing a conflicted
   file from a separate terminal while GitHydra has the same repo/worktree open never silently
   updates the graph, banner, or conflicted-file list — the previously-displayed state persists
   until the user clicks Refresh, verified immediately after the external change (within the
   watcher's debounce window) and again after the click.
3. When the externally-detected change specifically touches operation-state files, the alert shown
   is textually and visually distinct from the ordinary ref-churn banner, and is at least as
   prominent.
4. While that operation-state alert is unacknowledged, Continue/Abort/Accept Ours/Accept
   Theirs/Mark as resolved are disabled or blocked until Refresh is clicked.
5. Clicking Refresh on either banner variant re-fetches and clears only that banner's own staleness
   flag, with no new persistent dismissal state and no cross-tab bleed
   (`multi-repo-tabs.md`'s per-tab scoping applies unchanged).
6. Zero outbound network requests and zero new polling interval are introduced by either alert
   variant; both remain driven by the existing fs-watcher with its already-documented platform
   caveats.

## Addendum 2 — two verification gaps found by test-agent

Found while verifying Problem 1's implementation on `fix/graph-head-indicator-and-refresh-alerting`.
Both extend Problem 1's scope rather than standing alone.

### Problem 1a — stale ref-decoration chip survives a HEAD move

The "HEAD (detached)" text chip rendered per-row (`buildRefChips` in `refChips.ts`, consumed by
`CommitRow.tsx`) is derived from that row's own `commit.refs`, captured once when the row is
loaded/paginated in. `refreshRefs()` (`useRepositoryGraph.ts`) updates `repoState.headSha`/the
top-level ref list but never re-decorates already-loaded rows, so after a checkout or branch
switch the *old* HEAD row can keep showing a leftover "HEAD (detached)" chip while the *new*
row's triangle marker (correctly driven live off `repoState.headSha`) shows the real position —
two simultaneously-visible, differently-sourced "HEAD" signals. This directly undermines AC1
("distinguishable... not color alone") by reintroducing ambiguity through a second channel. This
is the FR-56 refresh contract (`branch-management.md`) actually being honored for per-row chip
data, not just `repoState`/toolbar/Branches-panel — FR-56's text is amended to say so explicitly.

**Target behavior**: any refresh that updates `repoState.headSha`/refs (per Problem 2's category
(a), app-initiated changes, and category (b) once the user clicks Refresh) also re-decorates the
ref data on every currently-loaded row so no row can show a "HEAD (detached)" chip, or any other
now-incorrect ref decoration, that doesn't match current repo state.

**Non-goals**: no change to how/when rows are initially decorated on load; no generalized
reactive/push-based re-decoration architecture; no re-fetch of full commit objects — only the
ref-decoration field needs correcting, and only for rows already in memory (unloaded rows don't
need it since they'll be freshly decorated whenever they do load).

**Acceptance criteria**:
1. After any checkout, branch switch, or merge/rebase/cherry-pick/revert Continue from GitHydra's
   own UI, no row in the currently-loaded set shows a "HEAD (detached)" (or any ref decoration
   inconsistent with current `repoState`) except the row that is actually current — verified
   immediately, no scroll/re-load/remount required.
2. This holds regardless of scroll position or how many rows are loaded — it must self-correct
   even if the stale row is currently off-screen at refresh time.
3. Regression check: `commit-graph.md`'s existing "Detached HEAD" acceptance criterion and this
   addendum's AC6 (detached-HEAD auto-follow) both still pass with this fix applied.

### Problem 1b — auto-follow no-ops silently when the target row isn't loaded

`CommitGraph.tsx`'s auto-follow effect looks up the new HEAD's row index via
`displayRows.findIndex(...)` against only the currently-loaded/paginated page. If the target
commit isn't loaded (e.g., switching to a branch whose tip is deep in history in a large repo),
the lookup returns -1 and the effect no-ops: `selectedSha` is internally correct but there is no
scroll and no visible feedback. Confirmed with a 300-commit fixture where only ~150 rows were
loaded. "Without an additional click" (AC2/AC3) was written and tested against the
already-loaded-row scenario — large/paginated repos genuinely weren't in scope of the original
criteria, so this is new ground, not a missed requirement.

**Target behavior**: when auto-follow's target row isn't in the currently-loaded page, the user
must get some visible acknowledgment that HEAD moved and a way to reach it — not silence. Exact
mechanism (e.g., trigger incremental `loadMore` until the target is found or a reasonable cap is
hit, vs. a lightweight inline affordance like "Jumped to a commit outside the loaded range —
click to load it") is ui-graphics's/git-core-engineer's call against `DESIGN.md` and
`commit-graph.md` FR-12's pagination-perf constraints; the requirement here is outcome-only.

**Non-goals**: no unbounded auto-load-until-found loop that could force-fetch an entire large
history in one action (would violate FR-12's paginated-load perf goal) — if an auto-load approach
is chosen, cap it and fall back to the affordance-based approach beyond the cap; no generalized
"jump to any commit" search feature (that's the explicitly-deferred v2 "jump to HEAD" idea from
Problem 1's existing non-goals — this is narrower: only for the specific commit auto-follow just
targeted, not a general-purpose jump/search tool).

**Acceptance criteria**:
1. When the auto-follow target row is not in the currently-loaded page, the user sees an
   unambiguous, immediate signal that HEAD moved (not merely correct-but-invisible internal
   state), verified in the same 300-commit/~150-loaded-rows scenario test-agent used.
2. The user can reach the new HEAD row without needing to know or guess its SHA/position — one
   additional interaction (e.g., one click on the affordance) is acceptable here, since this is
   the large-repo edge case the original zero-click bar (AC2/AC3) didn't cover; it must not
   require manually scrolling/searching through unloaded pages.
3. No change to behavior for the already-covered case (target row already loaded) — this is
   additive, not a replacement of the existing zero-click path.

### Priority

Fix Problem 1a first — it fires on every checkout/branch-switch regardless of repo size and
directly contradicts this session's own HEAD-indicator fix. Problem 1b is real but narrower (only
large/paginated repos) and can trail by a separate small change; a silent no-op today is a
regression only in "no feedback," not a functional one, since before this session's fix there was
no auto-follow at all.
