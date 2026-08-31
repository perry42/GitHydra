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
