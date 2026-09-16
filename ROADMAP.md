# ROADMAP — post-v1

Status: v1 core is fully shipped (see `CLAUDE.md`). V1.1 and the Floaters/design-pass backlog
below are also fully cleared. **V2 is next** (see that section) — nothing is queued ahead of it.

Convention: this file is intake, not spec detail. Each shipped item below is condensed to its
outcome + spec reference; the full problem/acceptance-criteria/FR history lives in `specs/*.md`
and git log, same as `CLAUDE.md`'s own "trim to a pointer" precedent. Only genuinely open/queued
items keep their full context, since that's what someone will need to act on them later.

## V2 — next

**Scoped 2026-09-16.** Online sync is the headline deliverable, split into **five phased specs**
rather than one — each independently reviewable and shippable, mirroring how stash, cherry-pick,
and branch management already shipped here. Build in this order:

1. **Fetch + diverged indicator + credential-failure UX** — `specs/online-sync-fetch.md`
   (FR-320–328). Deliberately first: the only read-only network action, so it's the safest place
   to build the app's first credential-failure handling, and it's what makes ahead/behind counts
   (permanently stale today) real.
2. **Git Identity & SSH Key Profiles** — `specs/git-identity-profiles.md` (FR-329–337). The free
   counterpart to a named GitKraken paid-only feature ("multiple profiles"). Sequenced before Push,
   where "pushed as the wrong account" is the worst failure mode.
3. **Pull** — `specs/online-sync-pull.md` (FR-338–343). Cheapest mutating op: its conflict path
   reuses the already-shipped merge/rebase conflict UI verbatim, adding no new conflict UX.
4. **Push** — `specs/online-sync-push.md` (FR-344–350). Highest risk (mutates the shared remote),
   so it ships once the other three have proven the infrastructure.
5. **Clone** — `specs/online-sync-clone.md` (FR-351–358). Last by design despite being the visible
   "front door": it has the most net-new UI and the most failure modes, so it reuses Phase 1's
   proven progress/cancel/credential plumbing instead of inventing it. Until this ships, the
   landing screen's disabled "Clone a repository" button stays exactly as it is — a deliberate
   call, since GitHydra has no real user base yet for a dead control to cost anything.

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
  data actually vanished. **`specs/reset-to-here.md` is written (FR-359 onward) and
  implementation is underway** — the git-core surface (`resetCurrentBranch()`,
  `countCommitsExclusiveToHead()`) has landed; the ui-graphics pass (dialog, IPC wiring, undo
  banner) is next.

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
