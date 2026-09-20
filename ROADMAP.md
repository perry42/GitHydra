# ROADMAP — post-v1

Status: v1 core is fully shipped (see `CLAUDE.md`). V1.1 and the Floaters/design-pass backlog
below are also fully cleared. **V2 is now fully shipped** — all five online-sync phases (fetch,
identity profiles, pull, push, clone) plus Reset to here. See "Recently shipped" for the rollup;
nothing is currently queued as the next milestone.

Convention: this file is intake, not spec detail. Each shipped item below is condensed to its
outcome + spec reference; the full problem/acceptance-criteria/FR history lives in `specs/*.md`
and git log, same as `CLAUDE.md`'s own "trim to a pointer" precedent. Only genuinely open/queued
items keep their full context, since that's what someone will need to act on them later.

## V2 — shipped

**Scoped 2026-09-16.** Online sync is the headline deliverable, split into **five phased specs**
rather than one — each independently reviewable and shippable, mirroring how stash, cherry-pick,
and branch management already shipped here. Build in this order:

1. **Fetch + diverged indicator + credential-failure UX** — `specs/online-sync-fetch.md`
   (FR-320–328). ✅ **Shipped 2026-09-17.** Deliberately first: the only read-only network action,
   so it was the safest place to build the app's first credential-failure handling, and it's what
   makes ahead/behind counts (permanently stale before this) real. Security-reviewed with no
   findings; credential redaction is applied at `GitCommandError` construction time (safe by
   construction, not per-call-site), and `fetchRemote()` blocks the `ext::`/`fd::` pseudo-transports
   so a hostile `.git/config` can't turn a fetch into command execution.
2. **Git Identity & SSH Key Profiles** — `specs/git-identity-profiles.md` (FR-329–337, plus the
   FR-378/379 amendment). ✅ **Shipped 2026-09-17.** The free counterpart to a named GitKraken
   paid-only feature ("multiple profiles"). Sequenced before Push, where "pushed as the wrong
   account" is the worst failure mode. `core.sshCommand` construction (the milestone's single
   highest-value review target) uses reject-not-escape validation, empirically verified against
   real git on Windows rather than assumed from docs. Two review rounds: the first found the
   in-config `githydra.managed-*` marker was forgeable by anyone who could plant a `.git/config`
   (defeating FR-334/336's confirmation guarantees) plus a Windows UNC-path gap in the SSH path
   validator — fixed by moving the trust source to an app-storage record of exactly what GitHydra
   wrote, and rejecting UNC paths outright; the second round verified both closed and caught one
   more Low (a hand-duplicated `core.sshCommand` string with no test keeping it in sync with
   git-core's own builder). The FR-378/379 amendment (added after a user question about identity
   vs. authorization) makes the UI honest that switching a profile with no SSH key set changes only
   cosmetic name/email, never silently implying an SSH-identity change. Same-key-across-profiles
   fingerprint detection (via `ssh-keygen -lf`) was scoped out to its own future increment.
3. **Pull** — `specs/online-sync-pull.md` (FR-338–343). ✅ **Shipped 2026-09-18.** Cheapest mutating
   op: its conflict path reuses the already-shipped merge/rebase conflict UI verbatim, adding no
   new conflict UX — verified by a real e2e test reusing the manual-merge spec's own assertions
   against a pull-triggered conflict. `pull()` is composed entirely from existing primitives
   (`fetchRemote()` + `mergeCommit()`/`rebaseCommitOnto()`), never a literal `git pull` subprocess;
   fast-forward uses git's own `--ff-only`, conflict-incapable by construction. Full (non-abbreviated,
   per explicit request) security review re-traced fetch's credential-redaction and
   dangerous-transport-block guarantees through the new call path from scratch rather than relying
   on the Phase 1 result — confirmed no wrapping loses redaction anywhere in the chain; a Low finding
   (missing regression test for redaction through `pull()`'s own error path) was closed before merge.
4. **Push** — `specs/online-sync-push.md` (FR-344–350). ✅ **Shipped 2026-09-18.** Highest risk
   (the only primitive that mutates the shared remote) — shipped once the other three had proven
   the infrastructure. The push API surface has no options parameter anywhere in the
   renderer-to-argv chain capable of carrying a force flag at all — a stronger guarantee than a
   runtime allow-list, confirmed by an independent full (non-abbreviated) security review with no
   critical/high/medium findings. Non-fast-forward rejections are classified distinctly and
   surfaced as "pull first," with zero retry-with-force escalation anywhere, not even hidden.
   Reuses Fetch's exact cancellation/progress/credential-redaction infrastructure rather than a
   parallel implementation.
5. **Clone** — `specs/online-sync-clone.md` (FR-351–358). ✅ **Shipped 2026-09-18.** Last by design
   despite being the visible "front door": it had the most net-new UI and the most failure modes, so
   it reused Phase 1's proven progress/cancel/credential plumbing rather than inventing it — the
   landing screen's previously-disabled "Clone a repository" button is now live. `clone()`'s argv is
   the only place in this milestone where a raw, caller-supplied URL becomes a literal positional
   git argument (fetch/pull/push only ever pass a pre-configured remote *name*), which made this the
   riskiest phase for argument-injection and the `ext::`/`fd::` transport guard — both hold by
   construction, verified by the same black-box argv-inspection technique the other phases used.
   Security review found and closed two real issues before merge: a **Critical** — a
   credential-bearing clone URL could leak in plaintext via `GitCommandTimeoutError`/
   `GitCommandError.message` (which embeds raw argv and was never redaction-covered the way `.stderr`
   already was, a gap invisible until clone put a real URL in argv) on a timeout or any error with
   empty stderr; originally fixed by redacting `.message` in `clone()`'s own catch path plus a
   defense-in-depth pass in `useCloneAction`'s error fallback (superseded 2026-09-18, see below) —
   and a **Medium** — the destination-folder auto-fill (`deriveRepoNameFromUrl`) could return `".."`
   for a crafted URL, resolving one level above the folder the user picked; fixed by treating `.`/`..`
   the same as an empty segment. Cancel-cleanup (FR-355) tracks "did GitHydra itself create this
   directory" as an explicit flag captured once at creation, never re-derived from directory
   emptiness — a pre-existing directory the user pointed at is never touched on any path. test-agent
   verified all 7 acceptance criteria against the real, launched app (not just the test suite) via a
   real bare-fixture clone, including the destination-exists refusal and mid-clone cancel actually
   removing only the GitHydra-created folder.
   - **2026-09-18 cross-phase audit follow-up (git-core, no UI change needed):** a later,
     whole-milestone re-review of the shipped fetch/pull/push/clone/identity-profiles surface found
     three more real issues, all fixed in the same pass. **High** — `clone()` runs `git clone` with
     `cwd` set to the destination's PARENT directory, which can be anywhere on disk including inside
     an existing unrelated repo (e.g. cloning into `some-project/vendor/new-dep`); git's own upward
     config discovery would then apply that unrelated repo's local `core.sshCommand` — a real RCE
     path, per the Phase 2 positive-control test proving `core.sshCommand` executes unconditionally.
     Fixed by always pinning `-c core.sshCommand=ssh` for `clone()`'s own invocation, composed with
     the existing `ext::`/`fd::` transport guard — `fetchRemote()`/`push()` don't need this, since
     their `cwd` is always the caller's already-open target repo. **Medium** — `clone()` tracked
     destination existence via `fs.mkdir`'s `EEXIST`, which also fires for a pre-existing SYMLINK
     without dereferencing it, so clone would follow it and write the whole repo outside the folder
     the user chose; fixed by an `fs.lstat` check ahead of any `fs.mkdir`/git call, refusing with a
     new `CloneDestinationIsSymlinkError`. **Medium** — the Critical fix above turned out to be a
     clone-specific patch rather than a structural one: `GitCommandError`/`GitCommandTimeoutError`
     were built with no redaction at all by four of `gitProcess.ts`'s five spawn-task functions (only
     the fetch/push/clone-shared network harness pre-redacted), a latent trap for any future caller
     (e.g. a Remotes panel) rather than an exploitable gap today. Generalized by moving redaction into
     `GitCommandError`'s/`GitCommandTimeoutError`'s/`OperationCancelledError`'s own constructors,
     covering `.message`/`.args`/`.stderr` uniformly regardless of which spawn-task function
     constructed the error — `clone.ts`'s bespoke patch is now redundant and was removed.
   - **Verification pass (security-reviewer) found one more, closed before merge:** the symlink
     fix's own `fs.lstat`-then-`fs.mkdir` sequence left a narrow TOCTOU window — an `EEXIST` from
     `mkdir` was treated as "pre-existing, leave alone" with no re-check that the entry hadn't
     become a symlink in the gap between the two calls. Closed by re-`fs.lstat`ing on `EEXIST`
     before ever invoking git, with a regression test simulating the race (one `lstat` call
     reporting a simulated miss while the real filesystem already has the symlink planted).
   - **2026-09-20 `/code-review` follow-up, two more real bugs (both fixed) plus one question
     investigated and closed with no change needed:** `fs.mkdir(destination)` was non-recursive,
     on the mistaken theory that this mirrored real `git clone`'s own behavior — verified against
     real git that it in fact creates every missing intermediate directory itself, so GitHydra's
     version threw a raw `ENOENT` for a destination like `newproject\my-repo` where `newproject`
     didn't exist yet, never even invoking git. Fixed with `{recursive:true}`, which required
     re-deriving the symlink/TOCTOU/FR-355-cleanup logic above around its different semantics
     (it no longer throws `EEXIST` for an existing directory, and its return value — the topmost
     directory actually created — now drives cleanup of the whole created subtree on failure, not
     just the leaf, so a failed clone into a newly-created nested path never leaves orphaned empty
     parent directories behind either). Also: `clone()` was the only network primitive never gated
     by `checkGitVersion()` (fetch/pull/push all get it for free through `Repository.open()`, but
     clone is reachable before any repo is ever opened) — fixed by calling it explicitly, after the
     destination-safety checks so its own `git --version` spawn gets a `cwd` guaranteed to exist.
     Investigated whether clone's checkout also needs the `core.fsmonitor` neutralization
     `core.sshCommand` got above, for the identical ambient-config-execution threat class —
     empirically confirmed (real git, positive-control-verified harness) that a fresh clone's
     checkout never consults an ambient `core.fsmonitor`, so no change was made; documented with a
     permanent regression test. Verified by security-reviewer (no findings) and test-agent (real
     Electron launch cloning into a missing-parent-directories destination end to end, plus new
     coverage for many-levels-deep creation and cancel-mid-clone whole-subtree cleanup through the
     real UI — closing the one gap the fix's own unit tests didn't reach).

**Security review is required on every phase** — this is the first work in the project's history
touching credentials and the network. The specific things to look for are consolidated in
`specs/online-sync-security-flags.md` (credential redaction in remote URLs; the reframed
`noNetworkCalls.test.ts` contract; `core.sshCommand` being shell-parsed by git; mechanical
enforcement of force-flag absence; clone's URL/destination handling).

**Confirmed scope boundaries:** safe actions only — force-push and delete-remote-branch are
explicit non-goals, not deferred items. No credential storage, prompting, or management inside
GitHydra ever; auth is delegated entirely to the system git's own credential helper and SSH agent.
No remote add/edit/remove UI this milestone. PR/issue/host-API features stay V3. Anything touching
`~/.ssh/config`, SSH agent key management, or our own token store is deferred indefinitely, not to
a later phase — it can break the user's git setup outside GitHydra and duplicates what credential
managers already do.

**Competitive note (researched 2026-09-16):** GitKraken's free tier requires account sign-in even
to open a purely local repo, paywalls private-repo access, and paywalls multiple profiles — all
confirmed against their own pages. The first two GitHydra already wins today by construction (no
account layer exists to gate on); the third is Phase 2 above. This research changed positioning
copy, not scope — no new features were pulled into V2 as a result.

- **Reset to here.** The other V2 item — unrelated code, no credentials, no network, much lower
  risk, and recommended to run in parallel with Phase 1 rather than queue behind it. Reset the
  current branch to an arbitrary earlier commit from the graph; destructive, so it needs a
  confirmation UI, should default to a non-destructive form (soft reset, or "create a branch at
  this commit") rather than hard reset, with reflog-based recovery surfaced so it never feels like
  data actually vanished. ✅ **Shipped 2026-09-17** (`specs/reset-to-here.md`, FR-359–377):
  `resetCurrentBranch()`/`countCommitsExclusiveToHead()` in git-core, the mode-selection dialog
  with impact preview, the two-tier destructive escalation gated on a *fresh* working-dir read
  taken at click time (not the dialog's preview snapshot), the reflog-based undo banner, and the
  commit-graph context-menu entry. Security review raised one Medium — `mode` reached argv with
  only a compile-time type guarding it, which doesn't survive the IPC boundary — fixed with a
  runtime allow-list in git-core plus a negative test. Note for future git-core work:
  `git reset` rejects `--end-of-options`, and a `--` separator is actively wrong there (git parses
  what follows as a pathspec), so `targetSha`'s hex-only validation is the compensating control;
  `blame.ts` has the same deviation documented.

## Open design gap — ref-chip gutter with 2+ chips on one row (queued, holding off)

A commit with two branch chips (e.g. right after branching) renders both labels as illegible
fragments once squeezed into the 100px `REF_GUTTER_WIDTH` gutter. Not a data-loss bug — every
chip carries a real `title` with its full name — just a legibility gap. **User has explicitly
asked to hold off on a fix for now.** Options left open for a future design pass: prioritize the
checked-out chip's space, stack chips vertically, or collapse extras behind a "+N" affix. Given
this area's regression history (`App.branchTagGutter.e2e.test.tsx`, `layoutBudget.test.ts`),
whichever direction is chosen should go through real-Electron-screenshot verification, not a
code-only guess.

## Floaters — no dependencies, slot in wherever there's a gap

- **Stash visualization polish** — no concrete gap identified yet, not actionable.
- Keyboard shortcuts / command palette — done, see below.
- **No interlock between identity-profile apply/remove and an in-flight fetch/pull/push/clone.**
  Found 2026-09-18 by a full-app cross-phase security audit (the first whole-system review of
  online-sync, after each phase had only been reviewed individually as it shipped). A user can
  switch/remove an identity profile in `IdentityProfilesDialog` while a network op targeting the
  same repo is already mid-flight — not a data-integrity or privilege issue (git reads config once
  per invocation, config writes are individually lock-protected), but which SSH key/committer
  identity an in-flight op actually used can end up inconsistent with what the UI shows as
  "current" the moment the switch lands. Judged a product/UX decision, not a vulnerability, so not
  fixed as part of that audit's fix round — needs product-manager's call on the right treatment
  (e.g. disable apply/remove while a network op targeting the open repo is in flight, mirroring
  this app's existing "operation already in progress" gating pattern elsewhere) before building.
- **Clone: minor rough edges found by a 2026-09-20 `/code-review` pass — ✅ all fixed 2026-09-20**
  (`fix/roadmap-code-review-cleanup`, merged to `main`). Every item this bullet used to list as
  open is resolved: a manually-typed relative *destination* path is now rejected at submit with an
  inline validation message rather than silently resolving against the Electron main process's
  hidden cwd (the URL field's own relative-path handling was deliberately left alone — that's
  between the user and their own filesystem/shell conventions, not GitHydra's ambiguity to fix);
  `deriveRepoNameFromUrl()` now rejects Windows-reserved device names (`CON`, `NUL`, `COM1`-`9`,
  `LPT1`-`9`, case-insensitive, checked against the base name before any extension); `joinDestinationPath()`'s
  separator choice is now based on the path's actual Windows shape (drive letter / UNC prefix)
  instead of content-sniffing for a bare backslash; `isErrnoException()` is deduplicated between
  `clone.ts`/`pathSafety.ts` (one now imports the other's export); `EmptyState.test.tsx`'s
  click-doesn't-fire-when-disabled assertions are restored. The dialog focus/Escape/backdrop-click
  duplication is closed via a new shared `useDialogChrome` hook
  (`packages/desktop/src/hooks/useDialogChrome.ts`), migrated into 7 of the 8 duplicating
  components (CloneDialog, NewBranchDialog, ResetBranchDialog, CreateStashDialog, ConfirmDialog,
  IdentityProfilesDialog, CommandPalette, KeyboardShortcutsScreen) with each dialog's real behavioral
  variance preserved exactly (e.g. CloneDialog's Escape-cancels-in-flight-clone / backdrop-dismiss-
  disabled-while-cloning guarantee) — `FindCommitsOverlay` was deliberately left unmigrated since
  it's a non-modal overlay with genuinely different dismissal semantics (FR-259), not a case of
  forced-but-false uniformity. `useCloneAction.ts`'s `ClonePhase.done` value was investigated and
  left as-is (not a bug): it deliberately mirrors `FetchPhase`/`PushPhase`/`PullPhase`'s identical
  three-state shape and has its own dedicated test coverage — CloneDialog just doesn't currently
  branch on it separately from `"idle"`, which is a UI nit, not dead code needing removal. Verified
  by an independent security-reviewer pass (no critical/high/medium findings; one low note about a
  bare-leading-`/` Windows destination still depending on the process's current drive, a narrower,
  documented, non-exploitable residual of the original problem) and test-agent (full real-Electron-
  launch verification of the migrated dialogs, not just jsdom tests).
  - **Same fix round also cleared three Floaters**, all found independently but fixed together
    since they're the same small-edge-case/duplication class: root `npm test` now fails fast
    (`&&`-chained per-workspace instead of `--workspaces`' continue-on-error, which previously let
    a workspace test failure slip past the root exit code); the `refreshWorkingDirStatus`
    fire-and-forget unhandled-rejection risk got the same `refreshWorkingDirStatusInBackground()`
    treatment `CLAUDE.md`'s Known Pitfalls already established for `refreshRefsAndRows`;
    `App.repoOpenElapsed.test.tsx`'s scheduler-flush flake under full-suite load is fixed (root
    cause: a synchronous `expect()` right after a synchronous `act()` doesn't reliably see React's
    real MessageChannel-based scheduler flush fake timers alone can't drive — fixed with
    `await act(async () => vi.advanceTimersByTime(...))`).
  - **Bonus fix found by this round's own test-agent verification pass, same bug class, not
    originally on this list:** `refreshRefs` itself (distinct from `refreshRefsAndRows`, which
    already had the `...InBackground` treatment) had the identical fire-and-forget
    unhandled-rejection exposure — every real call site (`App.tsx`'s direct calls, and every
    mutation hook's unawaited `onMutationSettled: graph.refreshRefs` wiring) turned out to be
    fire-and-forget with no caller depending on its throw, so (unlike its two siblings, which kept
    a throwing variant *and* added a background-safe one because `refresh()` depends on the throw)
    `refreshRefs` itself was simply made to never reject, with the original throwing logic moved
    into an unexported `refreshRefsCore`. No call sites needed changes as a result — they already
    call `refreshRefs` by name.

## Backlog — later ideas, not actively queued

Deprioritized by the user (2026-09-14); revisit only when explicitly picked back up.

- **Compare-commits' context-menu label doesn't name the two commits or their direction** —
  small, low-priority, copy-only fast-follow to match the drag-menu's naming convention. Tracked,
  not blocking anything.
- **Remember last search/filter per repo.** An earlier draft spec (FR-197–207) was never saved;
  the user wants to redefine the shape before it's picked back up — don't reuse the old draft.
- **Auto-stash**, opt-in, default off. Only build if product-manager thinks it's needed when it
  comes back up.
- **Per-author identity marks** (commit-node avatars + right-panel chips). **Must be locally
  generated only** — deterministic initials/color-hash from author name+email, never a
  Gravatar/GitHub-avatar network fetch (hard product-principle constraint, no network calls by
  default — unrelated to V2's "Online connection" item despite both involving "online" in
  conversation). Needs its own spec before implementation. Sequenced after V2.

## Recently shipped

- **Drag one commit node onto another for a contextual action menu** (`specs/drag-commit-menu.md`,
  FR-295–319). Compare/Cherry-pick/Merge/Rebase between any two dropped commits, ancestry-aware
  gating computed once at drop time, checkout-if-needed precondition, ContextMenu now closes on
  scroll app-wide as a side benefit. Plus two addenda: a cursor-following drag ghost, and the
  ghost resolving to the real branch/tag name. Fully merged to `main`.
- **Landing page premium design pass + SEO fundamentals.** `gh-pages` rebuilt around a "transit /
  rail wayfinding" visual system (matching the in-app graph metaphor), real captured screenshots,
  self-hosted fonts, full on-page SEO (title/meta/OG/JSON-LD/sitemap). No guarantee of ranking for
  competitive head terms — realistic target is brand-name search + long-tail queries.
- **Image diff preview** (`specs/image-diff-preview.md`) — before/after rendering for changed
  image files in `DiffView`.
- **V1.1, all four items done:** Repo list / Recent Repositories (`specs/repo-list.md`); remember
  last-selected file per tab (`specs/remember-last-selected-file.md`); restore open tabs across
  relaunch (`specs/restore-tabs-on-relaunch.md`); amend last commit (`specs/amend-last-commit.md`);
  compare two commits directly (`specs/compare-commits.md`).
- **Keyboard shortcuts / Command Palette + reference overlay**
  (`specs/keyboard-shortcuts-command-palette.md`, `specs/keyboard-shortcuts-reference.md`). Single
  `commands.ts` registry backs `Ctrl/Cmd+K` palette, direct keybindings, and the `Ctrl/Cmd+/`
  reference screen. **Convention landed in `CLAUDE.md`: new user-facing actions must get a
  `commands.ts` entry as part of the feature, not a cleanup pass.**
- **Find Commits overlay** (`specs/find-commits-overlay.md`) — replaced the old permanently-mounted
  `FilterBar` row with a floating panel opened via toolbar/palette/`Ctrl+Cmd+Shift+F`. `Ctrl/Cmd+F`
  separately focuses the Branches sidebar search.
- **Design passes 1 & 2** (`DESIGN.md` has full rationale) — selection halo replacing the
  ambiguous enlarged-circle overlap with merge nodes; Branches panel moved to a persistent left
  sidebar with search-to-jump; branch/tag chips moved to a persistent leading gutter column.
- **Tech debt: consolidated working-directory-status git spawns** — `useRepositoryGraph` is now
  the single fetch owner; `useChangesPanel` consumes it as a prop instead of double-fetching,
  closing an intermittent Windows `.git/index` lock collision.
- **Priority 0 bug: selection ring rendered on the wrong commit after scrolling** — root cause and
  do-not-reintroduce note now live in `CLAUDE.md`'s Known Pitfalls section.
- **Repo-open spinner gives no feedback on a slow/failing folder pick**
  (`specs/repo-open-feedback.md`, `specs/repo-open-feedback-fixes.md`) — elapsed-time indicator +
  cancel affordance, `resolveGitExecutablePath()` eager warm-up at startup. **One known gap left
  open:** canceling a tab reactivation triggered by *closing* another tab has no well-defined
  "restore to" target — un-special-cased pending a product decision.
- **Licensing: GPL-3.0-or-later**, landed across root `LICENSE` + all `package.json`s + SPDX
  headers on all source files. No dependency blockers. The README non-affiliation disclaimer this
  file long listed as "deferred until a README exists" is **done** — `README.md` exists and line 86
  already carries it, phrased generically ("not affiliated with, endorsed by, or sponsored by any
  other git client") rather than naming a competitor, which was the user's stated preference.
  **Still open:** a donate/support link (approved in principle, not yet built, no urgency — keep it
  a passive link, not a nag). **Standing convention:** never put the user's real personal email in
  anything public-facing for this repo (commit authorship, `package.json`) — use the GitHub
  no-reply address instead.
- **Release pipeline: v0.1.0 shipped for real** — tag-triggered `release.yml` matrix-builds
  win/mac/linux installers to a GitHub Release. **Still open:** code-signing — user has applied to
  SignPath Foundation for a free Windows cert (submitted 2026-09-07, pending); macOS has no free
  signing option, not pursued. Until resolved: ship unsigned, workaround documented in release
  notes. No auto-update mechanism (explicit non-goal).
- **Tech debt, all resolved:** git-core/desktop test suites' flakiness under full parallel load
  (root-caused to a vitest config regression + shadowed per-test timeouts + a Windows rmdir race +
  a debounce-timing race + a stale-lock ordering assumption — all fixed and measured clean);
  `resolveGitExecutablePath()`'s slow first call (eager `warmUpGitResolution()` at app startup);
  repo-open tab dedup exact-string-equality gap (junction/symlink already worked, case-
  insensitivity fixed platform-aware, mapped-network-drive-vs-UNC left as a documented non-goal —
  no per-call comparison can catch it without a larger cross-tab canonical-key change);
  `ipcTransport.spec.ts`'s ambiguous button selector; the FR-245 resume-reader API finished and
  tested (still not swapped in over the shipped fast-forward fix — that remains a separate future
  decision); instant revisit for already-loaded tabs (`specs/instant-tab-revisit.md`) — skips the
  full reload on a verified cache hit, bounded to ≤150 cached rows per tab.
