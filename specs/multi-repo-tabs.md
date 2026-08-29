# PRD: Multi-Repo Tabs

Status: final — workflow enhancement sequenced ahead of stage 4 (merge/rebase + conflict UI) at
the user's explicit request. Not itself one of `PRODUCT.md`'s v1 priority-order items (commit
graph → stage/unstage → branch mgmt → merge/rebase → stash → cherry-pick → blame); sequenced here
because it changes the app's outer shell, which every later feature then has to sit inside of.
Owner: product-manager
Sequencing: `packages/desktop` only — see "Architecture decision" below for why this does **not**
require any `packages/git-core` change, and does not require any Electron main-process IPC
contract change either (a real risk this spec identifies and deliberately avoids taking on).
Depends loosely on `specs/layout-and-view-polish.md`'s global `githydra:layout:rightPanel`
preference (Must-have 10) but is independently buildable/shippable in either order relative to it.

## Problem

GitHydra can only have one repository open at a time — opening a second repository (via
"Open repository…") replaces the first, discarding its selection/filter/panel state. A developer
who works across multiple repositories in a day (a common pattern — a service repo and its
frontend, a fork and its upstream, a couple of client projects) has to fully re-navigate each one
from scratch every time they switch, the way a browser without tabs would force a "close this
page, open that one" workflow instead of switching instantly between kept-open tabs.

## Target user

Same as every prior spec, specifically developers who keep more than one repository in play at
once during a session — a working pattern `PRODUCT.md`'s "Users" section already describes
("solo or on a team," "GitHub, GitLab, Bitbucket, self-hosted... or bare repos") without currently
being able to view more than one at a time in the app.

## Architecture decision (read before scoping work)

The Electron main process (`packages/desktop/electron/repoSession.ts`, wired up in `main.ts`) holds
**exactly one** live `Repository` instance, one set of paged commit-log readers, and one file
watcher, all behind a module-level `RepoSession` singleton (`const session = new RepoSession()` in
`main.ts`). Every IPC channel (`getRefs`, `createLogReader`, `stageFile`, `createBranch`, etc.)
calls `session.getOpenRepo()` with **no repo/session/tab identifier parameter at all** —
`session.open(path)` explicitly closes all existing readers and the watcher before opening the new
path (`repoSession.ts` lines 20–26). `repoSession.ts`'s own doc comment records the prior decision
this superseded: "v1 treats each open worktree/repo as its own window/session... no need to juggle
multiple repos in one session" — true today (the app is also single-`BrowserWindow`, confirmed via
`main.ts`'s `createWindow`), but this spec's whole premise (multiple repos, one window) replaces
that one-repo-per-window assumption with tabs, so this comment is now stale, not a design to
preserve.

Two ways to satisfy "multiple repos open at once, each with independent state" follow from this:

- **(A) Rearchitect for true concurrency:** give `RepoSession` (or its replacement) a
  `Map<tabId, {Repository, readers, watcher}>`, and thread a `tabId` through every IPC channel and
  every `GitHydraApi` call. This is real new surface area in the IPC contract
  (`shared/ipcContract.ts`) and every handler in `main.ts` — a materially bigger, riskier change
  than "UI/state-only," and it reopens questions this pass shouldn't have to answer yet (e.g. two
  tabs pointed at the exact same repo path, each running its own file watcher against the same
  `.git` directory).
- **(B) Lazily-active tabs (this spec's choice):** keep `RepoSession` exactly as it is today —
  still exactly one live `Repository`/readers/watcher, for whichever tab is currently
  **foregrounded**. Background tabs hold only lightweight renderer-side display state (selected
  commit sha, applied filter, which right panel is open — no live main-process resources at all).
  Switching the active tab calls `session.open(newPath)` — precisely the call that already exists
  today for opening any repo — tearing down the previous tab's readers/watcher and standing up the
  new tab's, then replays that tab's remembered selection/filter/panel against the freshly loaded
  data. This is the existing, already-shipped, already-correct single-repo flow, invoked once per
  tab switch instead of once per "Open repository…" click.

This spec is written against **(B)**. It costs one visible thing in exchange for the much smaller,
lower-risk surface area: switching to a tab shows a brief loading state (the same
"Opening repository…" indicator that already exists for a first open) rather than an instant,
zero-latency browser-style hot-swap. For local git operations (shelling out to the system `git`
CLI against on-disk data, no network) this is expected to be fast — tens to low hundreds of
milliseconds for a first page of commits — and is judged an acceptable, honest trade for not
rewriting the IPC layer. If real usage later shows this loading flash is a genuine problem, (A) is
the documented fast-follow path, not a re-litigation of whether tabs should exist.

## Must-have behavior

1. **Tab bar.** A tab bar (ui-graphics's call on exact placement/chrome, consistent with
   `DESIGN.md`) is always visible, even with only one tab or zero repos open — this is the
   discoverable affordance for the feature, not something that appears only once a second repo is
   opened. Each tab shows a short label derived from its repo path (e.g. the final path segment /
   folder name) with the full path available as a tooltip (mirroring `Toolbar`'s existing
   `repoPath` title-attribute pattern), plus a close (×) control. The active tab is visually
   distinguished, extending — not re-deciding — `Toolbar`'s existing `gh-toolbar__button--active`
   treatment.
2. **Opening repos into tabs.** A dedicated "+ New tab" control in the tab bar opens the existing
   repo-picker dialog (`openRepoDialog`) into a **new** tab, leaving every other open tab
   untouched. The existing `Toolbar` "Open repository…" control's behavior is **unchanged**: it
   replaces the repo shown in the **currently active tab only** (exactly today's single-repo
   replace behavior, just now scoped to "the active tab" instead of "the only session") — it does
   not itself create a new tab. This preserves existing muscle memory for that control while adding
   tabs as a clearly separate, additive affordance.
3. **Per-tab state.** Each tab owns an independent copy of everything `useRepositoryGraph()`
   already tracks per repo today — status, repo state/refs, selected commit + its detail, applied
   filter, working-dir status, loaded rows/lane assignment — plus its own `rightPanel` value
   (`"none"`/`"commit"`/`"changes"`/`"branches"`, `App.tsx`'s existing type). A tab that has never
   been opened (e.g. mid-dialog, before a path is chosen) has no such state yet.
4. **One live backend session (Architecture decision, option B).** At any moment, exactly one
   tab's repo is "live" in the Electron main process — the `RepoSession` singleton, unchanged.
   Activating a different tab calls `session.open(thatTab'sPath)` (tearing down the previously
   active tab's readers/watcher, per `RepoSession.open`'s existing implementation), then re-issues
   whatever calls are needed to redisplay that tab's remembered selection/filter/panel (re-select
   the same commit sha if one was selected, re-apply the same filter, reopen the same right panel).
   Background tabs never hold a live reader or file watcher.
5. **Loading state on switch.** Activating a previously-visited tab shows the existing
   "Opening repository…" loading indicator (scoped to the graph/detail area — the tab bar itself
   does not reload or flicker) until that tab's data and remembered state have been redisplayed —
   never a blank flash with no loading indication.
6. **Scroll position is not guaranteed across a switch.** Because the commit list is refetched
   fresh from the top on activation (matching today's `refresh()`/reopen semantics — no attempt to
   restore a prior page-scroll offset), only the specific state named in Must-have 3 (selection,
   filter, panel) is guaranteed to be restored — see Non-goals.
7. **Independent errors.** A tab whose repo fails to (re)open (not a git repo, path deleted since
   last visited, etc.) shows the existing `graph.status === "error"` state scoped to that tab only
   — other tabs are unaffected and remain switchable.
8. **Closing tabs.** Closing a tab (×) permanently discards its in-memory state (no undo re-opening
   restores prior selection/filter/panel — a freshly reopened tab at the same path starts clean).
   Closing the active tab activates an adjacent tab if one exists. Closing the last remaining tab
   returns the window to the existing "No repository open" `EmptyState` (App.tsx's current
   `graph.status === "idle"` rendering) — the application window itself is never closed as a
   side effect.
9. **Duplicate repo paths allowed.** Opening the same repo path in two separate tabs is allowed and
   not deduplicated/merged — each tab's renderer-side state (selection, filter, panel) is
   independent even though they'd both eventually read the same on-disk `.git` data when
   foregrounded (matches the browser-tab framing: nothing stops opening the same URL twice).
10. **Seeding a new tab's panel state.** A brand-new tab (never before opened) defaults its
    `rightPanel` to `specs/layout-and-view-polish.md`'s persisted global `githydra:layout:rightPanel`
    preference if that spec has shipped, else `"none"` — not copied from whichever tab happened to
    be active when the new tab was created, and not independently persisted per tab (panel-size and
    last-used-panel remain a single global preference, per that spec's Must-have 17).
11. **No new `packages/git-core` work.** `Repository.open(path)` is already a plain, reusable,
    per-path constructor with no singleton assumption at the git-core layer — the single-live-repo
    constraint is entirely in `packages/desktop/electron/repoSession.ts`'s wrapper, which this spec
    deliberately keeps as-is (Architecture decision). Nothing in `packages/git-core` changes.
12. **No network calls introduced.** Creating, switching, and closing tabs makes zero network
    requests, host-independent — same inherited product principle as every prior spec.

## Non-goals

- **True concurrent background tabs** (each holding its own live `Repository`/reader/file-watcher
  in the main process). Deferred per the Architecture decision's option (A) — a larger, separately
  scoped rewrite of the IPC/session layer if ever justified by real usage.
- **Instant, zero-latency tab switching.** A brief loading state on activating a previously-visited
  tab is expected and acceptable (Must-have 5) — this is the explicit cost of not taking on (A).
- **Restoring exact commit-list scroll position across a tab switch.** Only selection, filter, and
  open panel are guaranteed restored (Must-have 6); the list itself reloads from the top.
- **Persisting the open tab set across an app relaunch** (reopening the same repos next launch).
  Explicitly deferred, not solved here: today's app doesn't persist `repoPath` at all
  (`useRepositoryGraph.ts`'s `repoPath` is plain `useState`, reset on relaunch), and restoring a
  tab set well would also require deciding fidelity (restore selection? filter? scroll?) — a
  separate, larger spec if pursued. Every app launch starts with the same single "No repository
  open" state as today, now presented as a zero/one-tab starting point rather than a persisted set.
- **Tiled/side-by-side viewing of two repos at once.** Tabs are strictly exclusive/sequential like
  a browser — one active repo view at a time, never two rendered simultaneously.
- **Renaming tabs or custom tab titles.** A tab's label is always derived automatically from its
  repo path; not user-editable in this pass.
- **Drag-to-reorder tabs.** Tabs append in creation order; reordering is a possible later polish
  item, not required here.
- **Any Electron main-process IPC contract change**, and any `packages/git-core` change — see
  Architecture decision and Must-have 11.
- **Per-tab independent panel-size or last-open-panel preferences.** These remain one global
  preference shared by the whole app (`specs/layout-and-view-polish.md`'s scope) — a new tab reads
  that shared preference (Must-have 10) rather than getting its own.
- **Multiple `BrowserWindow`s per repo.** Tabs live inside the single existing window; this spec
  does not add a "new window per repo" option alongside tabs.

## Acceptance criteria

1. With two tabs open on two different local repositories, selecting a different commit, applying
   a filter, or opening a right panel in tab A does not change tab B's selected commit, filter, or
   open panel, and vice versa — verified by switching back and forth and inspecting each tab's
   displayed state.
2. Using the tab bar's "+ New tab" control to open a repository creates an additional tab without
   closing or altering any other open tab's repo or state.
3. Using `Toolbar`'s existing "Open repository…" control replaces only the currently active tab's
   repo (today's existing single-repo replace behavior) — every other open tab is unaffected.
4. Filter A applied in tab A, then a different filter applied in tab B, then switching back to tab
   A: tab A's original filter (both the filter-bar's field values and the resulting filtered graph
   rows) is still showing — not tab B's filter, and not cleared.
5. Opening the Changes panel in tab A, switching to tab B (no panel open there), then back to tab
   A: the Changes panel is still open in tab A; tab B remained unaffected throughout.
6. At any point in time, only one repository's git-core reader/watcher resources are alive in the
   Electron main process — verified by confirming the previously-active tab's reader id(s) no
   longer resolve (e.g. a subsequent `readPage` against them fails or the equivalent internal check
   shows they were closed) once a different tab has been activated.
7. Switching to a previously-visited tab shows a loading indicator before that tab's remembered
   selection/filter/panel are redisplayed — never an unindicated blank frame.
8. Closing the active tab, with at least one other tab open, activates an adjacent tab; reopening
   the closed tab's repo path afterward (via a new tab) starts with no memory of its prior
   selection/filter/panel.
9. Closing the last open tab shows the existing "No repository open" empty state without closing
   the application window.
10. Opening the same repo path in two separate tabs is permitted; switching the checked-out branch
    via one tab's Branches panel does not change the other tab's displayed current-branch label
    until that other tab is itself (re)activated.
11. With `specs/layout-and-view-polish.md`'s `githydra:layout:rightPanel` preference set to
    `"changes"`, a brand-new tab's Changes panel is showing once its repo finishes loading, without
    the user manually opening it.
12. Zero outbound network requests occur across creating, switching to, and closing multiple tabs,
    on repos configured against GitHub, GitLab, Bitbucket, a self-hosted remote, and no remote at
    all.
13. Within a single active tab, every existing acceptance criterion in `specs/commit-graph.md`,
    `specs/stage-unstage-diff.md`, `specs/detailpanel-auto-diff.md`, and
    `specs/branch-management.md` still passes unmodified — tabs are additive chrome around the
    existing feature set, not a behavioral change to it.
