# Repo-open feedback: cancel/path/lock bug fixes

## Problem
A real user hit a repro where picking a "Downloads" folder correctly (per normal git upward
directory-walk behavior) resolved to a stray, unrelated repo at their Windows profile root — that
specific stray repo has since been deleted by the user, but investigating the report via direct
source reading (not guesswork) surfaced three real, currently-shipping bugs in
`specs/repo-open-feedback.md` (FR-162-170, previously marked "landed... test-agent verified") that
will recur on any repo with a slow working-directory scan — a large monorepo, a thin
`.gitignore`, a network-mounted or virtualized working directory — independent of that specific
repro:

1. **Cancel silently stops working partway through `openRepo`'s sequence.** The Cancel button on
   the "Opening repository…" spinner (`OpeningSpinner` in `App.tsx`) is rendered, enabled, and
   looks identical for the entire `"opening"` duration, but only actually cancels the first phase
   (`Repository.open()`'s own validity/state check). `useRepositoryGraph.ts`'s
   `activeOpenRequestIdRef` is nulled the instant that first phase's IPC call resolves — before
   `refreshAuxData`'s refs/upstream/working-dir-changes/stash reads or `startReader`'s log-reader
   creation and first page fetch even start — so `cancelOpen()` is a silent no-op for the rest of
   the sequence. This isn't just a renderer bug: `RepoSession.open()`'s `AbortController` for a
   given `requestId` is deleted the moment `Repository.open()` itself resolves, and none of
   `getRefs`/`getUpstreamBranch`/`getWorkingDirectoryChanges`/`listStashes`/`createLogReader`/
   `readPage`'s IPC handlers or git-core method signatures accept a signal or requestId at all
   today — there is no cancellation plumbing past phase one to wire the renderer fix into without
   extending it first.
2. **Recent Repositories (and repo-path display generally) can show a misleading path.**
   `main.ts`'s `openRepo`/`openRepoCancellable` handlers return the caller-supplied raw path as
   `OpenRepoResult.path`, never git's own resolved toplevel (`RepositoryState.workdir`, already
   computed by every successful open). `onRepoOpened`/`useRecentRepos`, `RepoTab.repoPath`, and the
   cross-tab dedup check in `useRepoTabs.ts` all key off that raw path — so picking a subfolder of
   a larger repo (a normal, frequent, non-error case, e.g. a monorepo package) silently mislabels
   the Recent Repositories entry with the subfolder instead of the actual repo root. This is the
   same root cause as ROADMAP.md's existing "repo-open dedup uses exact string equality, no path
   normalization" tech-debt entry, folded into this fix rather than tracked separately.
3. **Whether `useRepoTabs.ts`'s `switching` global lock is scoped correctly** — its own doc comment
   calls it "defense in depth" behind an "authoritative" generation-counter fix in
   `RepoSession.open()`, worth re-evaluating now that it's under scrutiny. Investigated and
   answered below (Must-have 3.7): the lock stays exactly as broad as it is, for a stronger reason
   than its current doc comment states.

## Target user
Every GitHydra user opening or switching repositories — this is not host-specific or workflow-
specific. The triggering condition for bug 1 (a slow-to-open repo) is common: large monorepos,
`.gitignore`-thin working trees causing a slow `git status`, and network-mounted or virtualized
filesystems all measurably slow down the aux-data/log-reader phases this fix makes cancellable.

## Must-have behavior

### 3.1-3.5: Cancel works for the entire open sequence, not just phase one
- **FR-197:** Every `openRepoCancellable` attempt is cancellable for its entire lifecycle — from
  the moment `openRepo()` is invoked through `Repository.open()`'s validity/state check,
  `refreshAuxData`'s refs/upstream/working-dir-changes/stash reads, and `startReader`'s log-reader
  creation plus first `readPage` — not only the first phase. This requires extending the existing
  `signal`-based cancellation (already generic and proven end-to-end for `Repository.open()`'s own
  git calls, including the SIGTERM-then-SIGKILL escalation) to the IPC handlers and git-core
  methods `refreshAuxData`/`startReader` call, and extending `RepoSession`'s per-`requestId`
  `AbortController` lifetime to cover the whole sequence rather than being torn down right after
  `Repository.open()` resolves.
- **FR-198:** The renderer's "is an attempt cancellable right now" bookkeeping
  (`activeOpenRequestIdRef` or its replacement) is not cleared until the attempt has genuinely
  settled — success, error, or cancellation — never immediately after the first IPC call resolves.
  A Cancel click received at any point before true settlement is honored, not silently dropped.
- **FR-199:** A cancellation landing during `refreshAuxData` or `startReader` (i.e. after
  `Repository.open()` itself already succeeded) produces the exact same outcome contract
  FR-165/FR-168 already defined for a phase-one cancellation: `openRepo()` resolves `true`,
  `status`/`errorMessage`/`selectedSha`/`commitDetail`/`hasExternalChanges`/`operationStateAlert`/
  `filter`/`stashCount`/the mutation-gate state are restored to the pre-attempt snapshot, and the
  calling hook's own optimistic tab bookkeeping (`useRepoTabs.ts`'s new-tab-array entry, an
  in-place `repoPath` replacement) is rolled back exactly as it is today for a phase-one
  cancellation. The main process's live `repo`/readers/watcher must never be left half-updated (a
  live `Repository` with no matching reader, or a reader-id the renderer no longer holds).
- **FR-200:** No path through the open sequence — successful settle, genuine error, or
  cancellation at any phase — leaves `status` stuck at `"opening"` after Cancel was clicked and
  acknowledged. Every reachable outcome transitions out of `"opening"` within one IPC round trip.
- **FR-201:** No new user-facing affordance is introduced — the existing single Cancel button
  (FR-167) is visually and behaviorally unchanged; this fix is entirely that it now does something
  for the full duration it is already rendered for.

### 3.6: Recent Repositories (and repo-path display) show the resolved path
- **FR-202:** The path recorded as `OpenRepoResult.path`/`RepositoryState`-derived display path
  after any successful open (cancellable or not) is git's actual resolved repository root —
  `RepositoryState.workdir` for an ordinary (non-bare) repository — never the raw caller-supplied
  path when the two differ. For a bare repository (no separate working directory to resolve to),
  the caller-supplied path is used unchanged, matching today's behavior.
- **FR-203:** Every consumer of that path — `onRepoOpened`/`useRecentRepos`, `RepoTab.repoPath`,
  and the existing-tab dedup check in `useRepoTabs.ts`'s `openNewTab`/`openRecentInNewTab` —
  receives and stores this resolved path, not the raw picked path. This closes ROADMAP.md's
  "repo-open dedup uses exact string equality" tech-debt entry for the specific case it was caught
  on (a subfolder-of-an-already-open-repo pick now dedups correctly, since both opens resolve to
  the same `workdir`). Full path canonicalization (symlinks, mapped drive letters vs. UNC paths,
  case-insensitive comparison beyond what this fix already needs) remains a separately-tracked
  non-goal — this fix only guarantees a subfolder-of-the-same-repo pick resolves to one canonical
  path, not general path-spelling equivalence.
- **FR-204:** When the resolved path genuinely differs from the path the user picked (a real
  directory-hierarchy difference — the subfolder-of-a-larger-repo case — not merely a trivial
  spelling variant FR-203 already normalizes away), the Recent Repositories entry for that repo
  shows the resolved path as its primary label (since that's what reopening the entry actually
  opens), and separately, persistently surfaces the originally-picked path as secondary context
  (e.g. a subtitle line or hover tooltip on that entry) — not a one-time toast/banner that
  disappears, so a user isn't confused days later about why the list shows a different path than
  what they clicked. This is a deliberate UX decision: divergence is common and expected for
  monorepo users, so it must be quietly always-available, not a one-shot interruption or a loud,
  recurring warning.
- **FR-205:** Entries where the picked and resolved paths match (the common case) render exactly
  as they do today — no new UI. The same "always show the resolved path" rule (without the
  secondary-context affordance, which is specific to Recent Repositories) applies to any other
  surface displaying an opened repo's path (tab labels, etc.).

### 3.7: The `switching` lock's scope — evaluated, kept as-is
- **FR-206:** The `switching` global lock in `useRepoTabs.ts` remains exactly as broad as it is
  today — blocking every tab-bar/landing-screen control app-wide for the duration of any
  `newTab`/`activateTab`/`openNewTab`/`openRecentInNewTab` call or close-triggered reactivation,
  not scoped down to "only the same tab/slot." Reasoning: the main process holds exactly one live
  `RepoSession` (one `Repository`, one reader map, one file watcher) shared by every tab.
  `RepoSession.open()`'s generation counter only decides which of two concurrent `open()` calls'
  *results* wins `this.repo`; it does nothing to protect a still-in-flight tab's
  `refreshAuxData`/`startReader` reads from a second, concurrently-started tab's `open()` call,
  which unconditionally tears down every live reader and the watcher at its very top, before any
  `await`. Loosening this lock to "only block the same tab" would let two different tabs' opens
  genuinely interleave against that one shared session today — a real correctness hazard (a
  reader torn out from under an in-flight read, `this.repo` reassigned mid-read), independent of
  and not fixed by the generation counter. This is not scoped down as part of this fix; revisit
  only if the main process is re-architected to hold one independent session per tab (a
  materially larger, separate change).
- **FR-207:** The `switching` doc comment in `useRepoTabs.ts` is corrected to reflect FR-206's
  reasoning — it no longer describes the lock as mere "defense in depth" behind an "authoritative"
  generation-counter fix. The two mechanisms protect different things (which result wins the
  shared `this.repo`, vs. whether two opens may run concurrently against the shared session at
  all); removing this lock without first giving each tab its own session would reintroduce a real
  reader/watcher-teardown hazard, not just a narrower version of an already-covered race.

## Non-goals
- Building a per-tab/per-repo independent backend session (multiple concurrent
  `Repository`/reader-set/watcher instances) — the prerequisite architecture change that would
  make loosening the `switching` lock (FR-206) actually safe. A separate, materially larger
  project if ever taken on.
- Full path canonicalization (symlinks, mapped drives vs. UNC, case-insensitivity beyond what
  FR-203 needs) — tracked separately; this fix only resolves the subfolder-of-the-same-repo case.
- A new or richer cancel-progress UI (per-phase progress text, a "cancelling…" transitional state)
  — the existing single Cancel button/spinner is sufficient once FR-197-200 make it actually work
  end-to-end.
- Resolving `specs/repo-open-feedback.md` FR-162's still-open `resolveGitExecutablePath()`
  first-call-PATH-probe investigation — a separate, pre-existing open question, untouched here.
- Changing what happens when a picked path genuinely no longer exists or isn't a git repo at all —
  that's the existing "error" outcome (FR-165), unaffected by this spec.
- Telemetry or logging of cancellation events — no telemetry, per product principles.

## Acceptance criteria
1. Opening a repo with an artificially slowed `getWorkingDirectoryChanges`/`getRefs`/`listStashes`
   call (test double) and clicking Cancel while `refreshAuxData` is in flight: the underlying git
   child process(es) for the in-flight call(s) are terminated (no orphaned process survives the
   test); `openRepo()`'s returned promise resolves `true`; `status` returns to exactly what it was
   before the attempt; no rows/refs/stash count from the cancelled attempt are ever rendered.
2. Same as AC1 but cancelling while `startReader`'s `createLogReader`/first `readPage` is in
   flight instead — same assertions.
3. Clicking Cancel twice in rapid succession during any phase: no error thrown, no double
   rollback, the second click is a genuine no-op.
4. Clicking Cancel after the attempt has already fully settled (success or genuine error): no-op,
   no crash, no state change.
5. Opening a repo by picking a subfolder of a larger repo's working tree (fixture: a nested
   directory inside a parent repo's worktree): `graph.repoPath` equals the resolved toplevel (the
   parent directory), not the picked subfolder; the new Recent Repositories entry shows the
   resolved toplevel as its primary path.
6. In the AC5 scenario, the Recent Repositories entry also exposes the originally-picked subfolder
   path as secondary, persistently-available context (verifiable via the DOM/accessible name —
   tooltip text or a subtitle element — not just an internal state flag).
7. Opening a repo by picking its actual root directly (no divergence): the Recent Repositories
   entry renders exactly as it does today — no secondary-context UI.
8. Opening the same physical repo twice — once via its root, once via a subfolder of it — dedups
   into a single tab via `useRepoTabs`'s existing-tab check, since both resolve to the same
   `workdir`.
9. Opening a bare repository: `graph.repoPath`/the Recent Repositories entry show the
   caller-supplied path unchanged (no resolution attempted) — confirms the bare-repo fallback in
   FR-202 doesn't regress today's bare-repo behavior.
10. With `useRepoTabs`'s `switching` true (one tab's open in flight), attempting to start a
    second, different tab's open via `openNewTab`/`openRecentInNewTab`/`activateTab` is still
    blocked exactly as it is today (a no-op, or `"cancelled"` per `RecentOpenResult`) — confirms
    FR-206's "no change" decision didn't silently regress into something narrower.
11. `useRepoTabs.ts`'s `switching` doc comment in the diff reflects FR-206/FR-207's reasoning (no
    longer frames the lock as mere "defense in depth" behind an "authoritative" fix) — reviewed by
    security-reviewer/test-agent as part of this change's review, not independently runtime-testable.
12. `OpeningSpinner`'s existing tests (button presence, copy, elapsed-time readout) continue to
    pass unmodified — confirming FR-201's "no new UI" constraint — alongside new tests added for
    AC1-4.
