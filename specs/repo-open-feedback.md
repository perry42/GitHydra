# PRD: Repo-Open Feedback (elapsed-time indicator + cancel)

Status: draft — scoped and ready to build
Owner: product-manager
Sequencing: git-core-engineer first (cancellation signal plumbing through the open-repo git call,
plus the `resolveGitExecutablePath()` eager-resolution investigation), then ui-graphics builds the
spinner UI against it — same "new git logic goes first" rule `AGENTS.md` states. The elapsed-time
indicator alone needs no new git-core surface (a client-side timer keyed off `graph.status ===
"opening"`), so ui-graphics can start that piece in parallel; only the cancel button needs to wait
on git-core-engineer's abort plumbing landing first.

Raised as an open bug in `ROADMAP.md` ("Open bug — repo-open spinner gives no feedback on a slow/
failing folder pick"), investigated live against the real built app (Playwright-driven, a genuinely
non-git folder confirmed via `git rev-parse --show-toplevel` failing first) rather than just read
from code. This spec turns that investigation into buildable scope.

## Problem

Opening a repository — the first action of every GitHydra session — shows a static "Opening
repository…" spinner (`App.tsx`'s `MainArea`, `graph.status === "opening"` branch) with no elapsed-
time indication and no way to cancel, for however long the backend takes. The investigation found
this isn't a true hang: the error path is correct and already regression-tested
(`App.multiRepoTabs.test.tsx`, "AC7"). But time-to-resolution is wildly inconsistent — one fresh-
app-process attempt took 31 seconds before erroring; two other attempts on the same folder, same
machine, resolved in under a second — up to the full 120-second `DEFAULT_GIT_TIMEOUT_MS` ceiling
(`gitProcess.ts`) if a call is genuinely stuck. Leading hypothesis: a one-time cost on the very
first `git` process spawn in a session (AV real-time scanning of a freshly invoked `git.exe`, or a
slow `resolveGitExecutablePath()` PATH probe), not anything wrong in the request logic. A user
staring at an unmoving spinner for 30+ seconds with no elapsed time and no way to tell "stuck or
just slow" reads exactly like "GitHydra hangs," even on runs where the code was healthy the whole
time.

This gets more likely to be hit, not less, once `specs/repo-list.md` ships: one-click reopen of a
known path makes repo-opening a rapid, repeated action, and a persisted path that's since become
invalid (moved, deleted, `.git` removed) will silently hit this same unindicated-delay problem —
that spec's own cross-reference flags it should be "validated/surfaced the same way," which this
spec is what makes possible.

## Target user

Same as every prior spec: a developer opening any local-only, GitHub/GitLab/Bitbucket/self-hosted,
or no-remote repository — specifically on the first-in-session cold path where OS/AV/PATH overhead
is worst (a fresh app launch, or a machine with aggressive real-time antivirus scanning). Not
hypothetical — this is the exact scenario that surfaced the bug during live testing.

## Must-have behavior

### Data & git semantics (git-core-engineer) — extends `packages/git-core`

- FR-162: Investigate whether `resolveGitExecutablePath()`'s (`gitProcess.ts`) first-call PATH
  probe can be made faster, or resolved eagerly at app/main-process startup instead of lazily on
  the first repo-open. Document the finding either way — including "no code change warranted" as a
  valid outcome — this is investigation-first, not a guaranteed code change.
- FR-163: The git call(s) underlying `openRepo` (the repo-validity check plus whatever initial
  reads happen before `status` flips to `"ready"`) accept an `AbortSignal` end-to-end, reusing
  `gitProcess.ts`'s existing per-call `signal`/`AbortController` plumbing (`armTimeout()`'s shape,
  already threaded through every `spawnGit*` call) rather than inventing new cancellation
  machinery.
- FR-164: A canceled open request terminates the underlying git child process using the same
  SIGTERM-then-`TIMEOUT_SIGKILL_GRACE_MS`-escalation pattern `armTimeout()` already uses for
  timeouts — never leaves an orphaned OS process running after cancellation.
- FR-165: Cancellation is a distinct, third outcome from both success and error — it does not throw
  `GitCommandError`/`GitCommandTimeoutError`, and the renderer can branch on it without parsing an
  error message string.

### Rendering & interaction (ui-graphics) — `packages/desktop`

- FR-166: The "Opening repository…" spinner (`MainArea`'s `graph.status === "opening"` branch,
  `App.tsx`) shows running elapsed time (e.g. "Opening repository… 3s"), updating at least once per
  second, starting from 0 the moment `status` flips to `"opening"`.
- FR-167: A "Cancel" affordance is present on the spinner from the start of every open attempt —
  not gated behind a time threshold — regardless of entry point (native folder picker, "Open
  repository…" replace-tab flow, or, once shipped, a Repo List recent-entry click).
- FR-168: Clicking Cancel aborts the in-flight attempt (wired to FR-163's signal) and returns the
  tab to whatever it was showing immediately before this attempt started — the idle "No repository
  open" empty state for a fresh tab, or the previously-open repo still `"ready"` if this attempt was
  replacing an already-open tab's repo — never to the new, canceled attempt's error or ready state.
  Exact state-restoration mechanism (snapshot-and-revert vs. simply not tearing down the prior
  state until the new one resolves) is ui-graphics's implementation call, same convention as this
  project's other specs.
- FR-169: A canceled attempt never renders the "Could not open this repository" error UI — that
  surface stays reserved for genuine git-reported failures on the existing `graph.status ===
  "error"` branch.
- FR-170: This treatment is uniform across every entry point that calls `openRepo` — no special-
  casing per caller — since native-dialog opens, tab-replace opens, and (once `specs/repo-list.md`
  ships) recent-entry opens all funnel through the same underlying call.

## Non-goals

- **Eliminating the underlying delay itself** (e.g. working around AV scanning behavior). Out of
  GitHydra's control; only making the wait legible and escapable is in scope.
- **A general-purpose "cancel any git operation" affordance.** Scoped to repo-open only — no other
  operation today exhibits this open-ended-wait failure mode. A broader cancel mechanism, if ever
  needed, is a separate future spec.
- **Auto-retry after a cancel or timeout.** The user manually re-triggers the open; no automatic
  retry logic.
- **`specs/repo-list.md`'s own "recent entry not found / remove from list" UI.** This spec only
  fixes the underlying spinner-feedback gap that flow will rely on; Repo List's own recent-list
  affordances remain that spec's scope, unchanged.
- **A determinate progress bar / percentage.** Elapsed time only — there's no way to compute true
  percent-complete for an indeterminate git spawn, and a fake progress bar would be actively
  misleading.
- **Changing `DEFAULT_GIT_TIMEOUT_MS`'s 120-second ceiling.** Cancellation gives the user a manual
  escape hatch well before that ceiling; the ceiling itself is unchanged, separately-justified
  defense-in-depth (per `gitProcess.ts`'s own doc comments).

## Acceptance criteria

1. From the moment `graph.status` flips to `"opening"`, the spinner shows elapsed time, updating at
   least once per second, for as long as the attempt is in flight.
2. A "Cancel" affordance is visible on the spinner from the start of every open attempt, across all
   entry points (native dialog, replace-tab, recent-list), with no delay threshold gating it.
3. Clicking Cancel during a slow open: (a) terminates the underlying git process for that attempt
   with no orphaned OS process left running, (b) returns the tab to exactly what it showed
   immediately before the attempt (idle empty state for a fresh tab; the previous repo still ready
   if this was a replace-in-place), and (c) triggers no further git calls for the canceled attempt.
4. A canceled attempt never shows the "Could not open this repository" error UI.
5. An open that resolves (success or genuine error) before the user cancels behaves exactly as
   today — no regression to the existing success/error paths; `App.multiRepoTabs.test.tsx`'s "AC7"
   coverage continues to pass, asserting the same behavior it always has. Its mock target changing
   from `api.openRepo` to `api.openRepoCancellable` is expected, not a violation of this AC — FR-170
   requires every entry point to funnel through one uniform cancellable call, so the test's mock
   necessarily follows; "unregressed" here means the observable behavior and assertions are
   unchanged, not that the test's internals are untouched.
6. On a fast open (under 1 second), the spinner may appear only briefly or not at all — no minimum
   artificial display duration is introduced.
7. The `resolveGitExecutablePath()` investigation (FR-162) is documented regardless of outcome; if a
   code change results, the first repo-open of a fresh app session shows a measurably faster or
   equal time-to-ready/time-to-error versus before, with no behavior change to subsequent opens in
   the same session.
8. Zero outbound network requests introduced by this feature — canceling/timing a local process
   spawn has no network surface, consistent with every prior spec's no-network guarantee.
9. Canceling requires no confirmation step — it's non-destructive and instantly re-triggerable, so
   it stays a single click, not a confirm-or-cancel flow like FR-158's pushed-commit warning.

## References

- `ROADMAP.md`, "Open bug — repo-open spinner gives no feedback on a slow/failing folder pick" —
  the original investigation, root-cause hypothesis, and fix direction this spec formalizes.
- `packages/desktop/src/App.tsx` (`MainArea`, `graph.status === "opening"`/`"error"` branches,
  ~lines 664–680) — the spinner and error UI this spec extends in place.
- `packages/desktop/src/hooks/useRepositoryGraph.ts` (`openRepo`, `generation`/
  `generationRef` mechanism, ~lines 495–537) — the existing stale-response-suppression pattern a
  cancel affordance's state-restoration (FR-168) can build on.
- `packages/git-core/src/gitProcess.ts` — `resolveGitExecutablePath()` (~line 178),
  `DEFAULT_GIT_TIMEOUT_MS`/`armTimeout()`/`TIMEOUT_SIGKILL_GRACE_MS` (~lines 366–456) — the existing
  timeout/`AbortSignal` infrastructure FR-163/FR-164 reuse rather than duplicate.
- `packages/desktop/src/App.multiRepoTabs.test.tsx`, "AC7" — existing regression coverage for the
  error path that must keep passing unmodified (AC5 above).
- `specs/repo-list.md` — the V1.1 feature whose recent-entry-click flow will make this bug more
  frequently hit; this spec is a prerequisite in spirit, not a hard code dependency (buildable and
  shippable independently, in either order).
