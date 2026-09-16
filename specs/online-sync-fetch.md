# PRD: Online Sync — Fetch, Diverged Indicator, Credential-Failure UX

Status: draft — **Phase 1 of 5**, V2's online-sync milestone. First feature in the project's
history to make a network call; see `ROADMAP.md`'s V2 entry and `CLAUDE.md`'s no-network-calls
principle, which this phase is the first to legitimately change.

Sequencing: git-core-engineer builds first (new fetch surface in `packages/git-core`,
credential-failure classification, `noNetworkCalls.test.ts` contract change); ui-graphics builds
second (progress/cancel UI reusing `specs/repo-open-feedback.md`'s pattern, the diverged
indicator's display layer, the credential-failure banner). **security-reviewer review required
before merge** — see `specs/online-sync-security-flags.md`.

## Problem

GitHydra has never made a network call — every ahead/behind count and upstream name is permanently
stale ("last known," per `branch-management.md` FR-57) because nothing in the app can ever refresh
a remote-tracking ref. A developer has to leave GitHydra to run `git fetch` in a terminal just to
know whether their branch is behind, then come back. This is the single most basic gap keeping
GitHydra from being a working git client for anyone with a remote.

## Target user

Same as every prior spec — developers against GitHub, GitLab, Bitbucket, self-hosted, or no remote
at all, including private repos requiring real SSH/HTTPS auth, and repos with zero, one, or
several configured remotes.

## Must-have behavior

- **FR-320:** New `fetchRemote(remoteName)` in `packages/git-core`: runs `git fetch <remoteName>`
  (plain — no `--prune`, no `--tags` beyond git's own default, see Non-goals) for exactly one
  configured remote, updating that remote's tracking refs on success.
- **FR-321:** New `fetchAllRemotes()`: iterates every remote from `git remote` **sequentially, one
  `fetchRemote()` call per remote**, not a single `git fetch --all`, so a failure on one remote is
  attributable to that specific remote and never silently swallows or blends with another remote's
  result. A repo with zero remotes returns an empty, non-error result (nothing to fetch, not a
  failure).
- **FR-322:** Fetch is cancellable via the same `AbortSignal` mechanism `Repository.open()` already
  uses (`repo-open-feedback.md` FR-163) and reports incremental progress by parsing git's own
  `--progress` stderr output — reuse, don't reinvent, that spec's elapsed-time/cancel UI pattern.
- **FR-323:** Credential-failure classification (`classifyGitNetworkError()`, new): parses a failed
  fetch's stderr into a small closed set of named outcomes — SSH key rejected, host-key
  verification failed, HTTPS auth failed/expired, host unreachable, unknown — each carrying a short
  actionable message pointing at the user's own SSH agent / credential helper / git config,
  **never** a claim that GitHydra can fix or store anything. Anything not matching a known pattern
  falls back to "unknown" with the raw stderr still available, never hidden.
- **FR-324:** Any credential embedded in a remote URL (`https://user:TOKEN@host/...`) is redacted
  (`***`) before that URL appears in ANY user-visible surface (error banner, progress line,
  collapsible raw-stderr detail) or is passed to a logging call. This applies to every remote URL
  displayed anywhere in the app from this point forward, not just fetch's own error path.
- **FR-325:** Zero stored-credential assumptions: no credential prompt, no token/password input
  field anywhere in this feature. Auth is entirely delegated to the system git's own credential
  helper and SSH agent, exactly as a terminal `git fetch` would behave.
  **Correction #1 (2026-09-16, found empirically while building FR-323 — this FR originally claimed
  `GIT_TERMINAL_PROMPT=0` alone was sufficient, and that was wrong):** `gitProcess.ts`'s existing
  `safeEnv()` does set `GIT_TERMINAL_PROMPT=0`, but that only suppresses *terminal* prompts. A
  GUI-based credential helper — e.g. `credential.helper=manager-core`, the Git Credential Manager
  default on Windows and present on this dev machine — is not a terminal prompt, and a real
  `git fetch` against an auth-requiring host was observed hanging past 20 seconds despite both
  `GIT_TERMINAL_PROMPT=0` and `GIT_ASKPASS=""`. The fix implemented at the time was to explicitly
  neutralize the helper on the invocation itself (`-c credential.helper=`).

  **Correction #2 (2026-09-16, found empirically by security review, superseding Correction #1's
  fix — not its diagnosis): the neutralization in Correction #1 was itself wrong and has been
  removed.** The 20+ second "hang" it worked around was re-investigated and directly observed, twice,
  to be Git Credential Manager legitimately displaying its own GUI dialog and waiting for a human —
  once by the security reviewer's own test run, and once by re-running the exact same spawn
  configuration (`spawnGitRaw()`'s piped stdio, `shell: false`, `windowsHide: true`) that both the
  test suite and the real Electron app use, which reproduced the identical ~25-30 second,
  zero-stderr wall observed originally. `spawnGitRaw()` is the single spawn path for tests and the
  real app alike, with identical stdio wiring — GCM cannot tell them apart, so the same dialog
  appears in the shipped app too, where a real user simply answers it (exactly how GitKraken and
  Sourcetree behave with a GUI credential helper configured). Neutralizing the helper unconditionally,
  as Correction #1 did, permanently broke the single most common authenticated case instead: a
  private HTTPS repo could never authenticate at all, since the only mechanism that could ever
  supply a credential was disabled and terminal prompts are separately off by design. That
  contradicted this very FR's own stated intent ("auth is entirely delegated to the system git's own
  credential helper and SSH agent") and undercut a core product claim (private repos working
  freely). It also nudged users toward embedding tokens directly in remote URLs to work around the
  broken helper — the exact dangerous pattern `credentialRedaction.ts` exists to contain, not cause.

  **Current, corrected behavior:** `fetchRemote()` does not touch `credential.helper` at all. A
  fetch requiring authentication behaves exactly as a terminal `git fetch` would — the system's own
  credential helper (GUI or terminal) or SSH agent is free to prompt, and the user answers it
  directly. This is not an unbounded wait: `DEFAULT_GIT_TIMEOUT_MS` (absent a caller `signal`) and
  FR-322's own cancellation both still apply to this invocation exactly as to every other one in
  `packages/git-core`, so "it could sit on a credential dialog" was never actually "it could hang
  forever." The test suite achieves its own required deterministic, non-interactive behavior a
  different way: by having each test that needs one clear `credential.helper` for its own fixture
  repo (local git config, which overrides system/global config per git's own documented precedence)
  rather than the product code disabling it for every real invocation — see `fetch.test.ts`'s FR-325
  describe block. This correction applies equally to the not-yet-built Push and Clone phases: neither
  should neutralize the credential helper either.
- **FR-326:** Diverged indicator: extends `listBranches()`'s existing ahead/behind (`branches.ts`,
  FR-33) with a "last fetched" timestamp, freshened when FR-320/321 succeed. Rendered on the
  Toolbar's current-branch indicator, each `BranchesPanel` row (superseding FR-57's permanently-
  stale caption with a real "fetched 3m ago" / "never fetched this session" label), and a small
  `warning`-token (per `DESIGN.md`'s status tokens) glyph on a diverged branch's graph ref chip.
  Updates immediately on fetch completion, no restart or manual refresh (same standard as
  `commit-graph.md` FR-6).
- **FR-327:** A "Fetch" action (Toolbar + Command Palette entry, per `CLAUDE.md`'s Conventions)
  triggers FR-321 for the active tab's repo. No repo-open, tab-switch, timer, or any other implicit
  trigger ever calls fetch — every network call remains an explicit user action.
- **FR-328:** `noNetworkCalls.test.ts`'s existing describe blocks are left completely unmodified —
  every pre-V2 surface (staging, branch management, stash, cherry-pick, blame, compare-commits,
  drag-commit-menu) must continue asserting **zero** fetch/pull/push subcommands, forever. A new,
  separate describe block asserts the **opposite** for exactly `fetchRemote`/`fetchAllRemotes`: a
  real `fetch` subcommand is spawned, and it is the only new network-capable code path this phase
  introduces.

## Non-goals

- **`--prune`, `--tags` beyond git's default, or any other fetch flag beyond a plain fetch.**
  `branch-management.md` flagged pruning remote-tracking refs as pairing naturally with
  `fetch --prune`; that pairing is deliberately deferred again here as its own follow-up, not
  solved as a side effect of this phase.
- **Auto-fetch** on open, interval, tab switch, or window focus. Every fetch is user-initiated
  (FR-327).
- **Remote add/edit/remove UI.** Fetch only acts on remotes that already exist (from a terminal
  `git remote add`, or a future Clone).
- **Any credential storage, prompt, or management inside GitHydra.** Auth failures are surfaced,
  never resolved by the app.
- **Push/pull/clone.** Separate phases and specs.

## Acceptance criteria

1. Fetching a repo with one configured remote pointing at a real, reachable bare fixture repo
   updates that remote's tracking refs — verified via `git rev-parse origin/main` changing to match
   the fixture's new tip.
2. A repo with two remotes, one reachable and one pointing at an unreachable host, reports success
   for the reachable one and a specific, attributable failure for the other — never one opaque
   combined error.
3. Fetching against a remote requiring SSH auth with no usable key configured produces the "SSH key
   rejected" classified message, with the real stderr still available via Details.
4. A remote URL containing an embedded token, when it fails and its error is displayed, shows the
   token redacted everywhere in the UI — verified by inspecting the rendered error text and any
   console/log output.
5. Ahead/behind counts and the "last fetched" caption update in the Toolbar, BranchesPanel, and
   graph ref chips immediately after a successful fetch, with no app restart or manual refresh.
6. Cancelling an in-flight fetch stops the underlying process (verified via the same escalation
   mechanism `repo-open-feedback.md` already tests) and leaves the repo's refs exactly as they were
   before the fetch began.
7. Every existing `noNetworkCalls.test.ts` describe block still passes unmodified; a new describe
   block confirms `fetchRemote`/`fetchAllRemotes` are the only functions in the codebase that spawn
   a `fetch` subcommand.
8. ~~No fetch call ever prompts interactively or hangs waiting on a credential~~ — **superseded by
   FR-325's Correction #2**: a fetch requiring authentication MAY prompt interactively via the
   system's own credential helper (GUI or terminal) or SSH agent, exactly as a terminal `git fetch`
   would, and that is the correct, intended behavior for a working authenticated-fetch feature. What
   remains true and still verified: the wait is never unbounded — `DEFAULT_GIT_TIMEOUT_MS` (absent a
   caller `signal`) and FR-322's own cancellation both bound it, and a missing/rejected credential
   (whether from no helper being configured, or the helper's own prompt being answered incorrectly
   or cancelled) still resolves to one of FR-323's classified errors once the process actually
   exits.
