# ROADMAP — post-v1

**Status:** v1, V1.1, the design-pass/Floaters backlog, and **V2** (all five online-sync phases
plus Reset to here) are fully shipped. Nothing is queued as the next milestone.

**Convention:** this file is intake, not spec detail. Shipped items get one line — outcome + spec
reference; the full problem/acceptance-criteria/FR/review history lives in `specs/*.md` and git
log. Only genuinely open items keep their context, since that's what someone needs to act on them.

## Open

### `useIdentityProfileApplication`'s post-apply `reload()` reads a stale closure

Found 2026-09-27 by test-agent's real-Electron verification of the identity-interlock fix below —
pre-existing, unrelated to that fix, not introduced by it. `performApply` (and likely
`removeApplication` symmetrically) calls `reload()` synchronously right after
`applications.recordApplication(...)`, but `reload()`'s closure still captures the PRE-update
`applications` snapshot (a React state update hasn't committed yet in that same synchronous
continuation) — so `getIdentityConfigState()` runs with `knownApplication: null` and reports
`managedByGitHydra: false` for a profile that was just successfully applied. Result: immediately
after every successful Apply, the dialog wrongly shows "Set locally (not by GitHydra)" and disables
Remove with "No GitHydra-applied identity to remove from this repository" — misleading copy about
an action the user just took. Self-corrects the moment the dialog is closed and reopened (a fresh
hook mount re-reads the by-then-updated `applications` prop). 100% deterministic, confirmed via
real `localStorage` polling, not test flakiness — every existing jsdom/RTL test is structurally
blind to it because `mockGitHydra.ts`'s `getIdentityConfigState` mock ignores its `knownApplication`
argument entirely; only a real git-core round trip surfaces it. UX-correctness bug, not data-loss or
a live vulnerability — but it sits adjacent to the trust computation (`knownApplication`/
`managedByGitHydra`) a prior security review specifically hardened against a forgeable-config-marker
attack (`useIdentityApplications.ts`'s own doc comment), so route any fix through a fresh
security-reviewer pass before merge even though the fix itself is likely just "reorder/refetch with
the post-update value," no shell/path/credential logic involved. Owner: ui-graphics. A real-Electron
repro is documented inline in `identityNetworkInterlock.spec.ts`'s `applyProfileAndReopen()` helper
doc comment.

### Smaller open threads

- **Code signing.** Corrected 2026-09-25: the 2026-09-07 entry claiming a SignPath Foundation
  application had been "submitted" was wrong — user confirmed no application was ever actually
  filed. **Not applied yet.** Checked 2026-09-25 against `signpath.org/terms.html`: there's no formal
  user/download-count threshold, but eligibility is discretionary on "verifiable reputation" — their
  own wording is "we cannot sign binaries based on source code that nobody knows" — alongside active
  maintenance, OSI license, and an already-released signed(-ish) build. Practical implication is
  similar even without a hard number: promotion shouldn't wait on signing, since visible
  activity/adoption plausibly helps the application. Target technically-literate channels
  (HN/Reddit-r/opensource/dev communities) that will click through a SmartScreen warning rather than
  bounce off it. macOS has no free option, not pursued. Until resolved: ship unsigned, workaround
  documented in release notes. (No auto-update mechanism — explicit non-goal.)
- **Donate/support link** — approved in principle, not built, no urgency. Keep it a passive link,
  not a nag.
- **Repo-open cancel gap** — canceling a tab reactivation triggered by *closing* another tab has no
  well-defined "restore to" target; un-special-cased pending a product decision.
- **FR-245 resume-reader API** — finished and tested, but still not swapped in over the shipped
  fast-forward fix. That swap remains a separate future decision.
- **Stash visualization polish** — no concrete gap identified yet, not actionable.
- **`packages/desktop` pins `@githydra/git-core` at an exact version**, which is what silently
  froze git-core at `0.1.0` while the other two packages reached `0.2.0`: bumping git-core alone
  makes npm try to resolve an unpublished package from the registry and the install fails outright,
  so the bump gets reverted or skipped. Realigned by hand to `0.3.0` during that release. Changing
  the spec to `*` would end the recurrence permanently (the package is never published, so there is
  nothing for a range to resolve against but the workspace), but it touches what electron-builder
  bundles — worth its own change plus a real packaging test, not a ride-along on a release commit.
## Backlog — later ideas, not actively queued

Deprioritized by the user (2026-09-14); revisit only when explicitly picked back up.

- **Compare-commits' context-menu label doesn't name the two commits or their direction** — small,
  copy-only fast-follow to match the drag-menu's naming convention.
- **Remember last search/filter per repo.** An earlier draft spec (FR-197–207) was never saved; the
  user wants to redefine the shape before it's picked back up — don't reuse the old draft.
- **Auto-stash**, opt-in, default off. Only build if product-manager thinks it's needed.
- **Per-author identity marks** (commit-node avatars + right-panel chips). **Locally generated
  only** — deterministic initials/color-hash from author name+email, never a Gravatar/GitHub-avatar
  network fetch (hard product principle). Needs its own spec first.

## Standing constraints — apply to all future work

- **Online-sync scope boundaries:** force-push and delete-remote-branch are explicit non-goals, not
  deferred items. No credential storage, prompting, or management inside GitHydra ever — auth is
  delegated entirely to system git's credential helper and SSH agent. No remote add/edit/remove UI.
  PR/issue/host-API features stay V3. Anything touching `~/.ssh/config`, SSH agent key management,
  or our own token store is deferred indefinitely — it can break the user's git setup outside
  GitHydra and duplicates what credential managers already do.
- **Security review is required** for any work touching credentials or the network. The checklist
  is `specs/online-sync-security-flags.md`.
- **Credential redaction is structural**, living in `GitCommandError`/`GitCommandTimeoutError`/
  `OperationCancelledError`'s own constructors and covering `.message`/`.args`/`.stderr` uniformly.
  Don't reintroduce per-call-site redaction — that pattern already shipped one Critical leak.
- **`clone()` pins `-c core.sshCommand=ssh`** because its `cwd` is the destination's parent, which
  can sit inside an unrelated repo whose local config git would otherwise apply (a real RCE path).
  `fetchRemote()`/`push()` don't need it — their `cwd` is always the already-open target repo.
- **`git reset` rejects `--end-of-options`**, and a `--` separator is actively wrong there (git
  parses what follows as a pathspec) — hex-only `targetSha` validation is the compensating control.
  `blame.ts` has the same deviation documented.
- **Never put the user's real personal email in anything public-facing** (commit authorship,
  `package.json`) — use the GitHub no-reply address.

## Shipped

**2026-09-28 — ref-chip gutter legibility (glyph size + multi-chip collapse).**
`specs/ref-chip-gutter-legibility.md` (FR-406–413). Two real legibility bugs found via user
screenshots, both fixed: (1) `.gh-refchip__icon` type glyphs grew 6x6px -> 8x8px (remote-branch
ring border 1.5px -> 2px so it stays a ring, not a filled dot, at the larger size); (2) a row with
2+ real ref chips (`buildRefChips()`'s array, never the separate synthetic HEAD badge) now collapses
to one visible chip (checked-out branch, else detached-HEAD, else `chips[0]`) plus a real, keyboard-
operable "+N" button that opens the existing `ContextMenu` with one informational row per collapsed
ref — resolves the "Ref-chip gutter with 2+ chips on one row" item this file previously tracked as
open. `REF_GUTTER_WIDTH` deliberately untouched (FR-413's own arithmetic). Found and fixed one real,
reachable keyboard bug along the way: the "+N" button's Enter/Space bubbled up to `CommitGraph`'s
listbox-level `handleKeyDown` (which unconditionally treats Enter/Space as "select the active row"
and calls `preventDefault()`), silently swallowing the button's own native activation — caught by a
real keyboard-only test, fixed with a local `stopPropagation()` on the button's own `onKeyDown`.
Glyph-size fix independently verified via real Electron screenshots (both themes, 100% and 200%
device scale), not just DOM/class assertions, per this area's own regression history.

**2026-09-29 — follow-up fix: checked-out row's HEAD badge/branch chip/+N crowding.** Found via a
real user screenshot the day after the above shipped: on the checked-out row, the synthetic HEAD
badge, the visible branch chip, and the "+N" affix all shared the fixed 100px gutter with no width
floor, so both text labels shrank via their own ellipsis down to one character ("H..", "m.") —
the acceptance test above only checked the right elements were present, never that they'd stay
legible at real pixel width. Fix: the HEAD badge now renders icon-only (full aria-label/title
unaffected) whenever a real ref is also collapsing on that row; the plain checked-out-with-no-
other-ref case is untouched. Verified with a new real-Electron screenshot test reproducing the
exact scenario.

**2026-09-27 — keyboard shortcuts reference screen design/UX pass complete.** Requested by the user
2026-09-20; discoverability (a toolbar affordance) was already closed by the earlier toolbar
action-row redesign's `⋯` menu — this pass covers the screen's own visual treatment and adds a
genuinely new capability.
- **Keycap visual redesign** — `specs/keyboard-shortcuts-visual-redesign.md` (FR-387–393). Plain-text
  shortcut hints ("Ctrl+K") replaced with bordered "keycap" chips (one per key) in both the Command
  Palette and this screen. Security-reviewed clean; independently verified via real screenshots in
  both themes, including the Command Palette's highlighted-row contrast (a state-dependent edge case
  that's easy to get subtly wrong and was confirmed, not assumed).
- **Customizable shortcuts (rebinding)** — `specs/keyboard-shortcut-rebinding.md` (FR-394–405). Any
  command's shortcut can now be rebound inline in the same screen (confirmed via the `impeccable`
  skill as the right structural call over a separate settings screen — matches this app's "reuse one
  surface" pattern and the VS Code keybindings-editor precedent this audience already knows), with
  conflict detection (Reassign/Cancel, never a silent overwrite), reserved bindings
  (Ctrl/Cmd+K, Ctrl/Cmd+Tab), a required-modifier rule (closes a real gap: the global keydown
  listener has no text-input guard, so an unmodified custom binding would've clobbered typing
  app-wide), and per-row/global reset. Security review caught one real low-severity finding (an
  unguarded `__proto__` key in the localStorage-shape sanitizer — not exploitable given the fixed
  command registry, but fixed directly with `Object.create(null)` before merge) and independently
  verified all 11 acceptance criteria via real Electron launches (a rebind actually firing the real
  command from outside any dialog, a real conflict/Reassign flow, and persistence across an actual
  process relaunch against the same profile).
- One unrelated, pre-existing flaky test was noted during verification
  (`App.repoOpenElapsed.test.tsx`, a fake-timer-under-full-suite-load flake, confirmed via `git log`
  as predating both changes) — not blocking, but worth a look next time suite stability gets
  attention.

**2026-09-27 — identity-profile apply/remove interlocked with in-flight fetch/pull/push.**
`specs/identity-profile-network-interlock.md` (FR-380–386). `IdentityProfilesDialog`'s Apply and
Remove buttons now disable (native `disabled`, not just a no-op click) with "Disabled while {a
fetch/a pull/a push} is in progress on this repository." whenever one targets the open repo — reuses
the existing `pushEligibility.ts`/`pullEligibility.ts` disabled-with-reason pattern, no new state, no
git-core changes. Clone deliberately excluded (FR-381). Security-reviewed clean (purely additive UI
gating, native-disabled genuinely blocks the IPC calls, no info-disclosure in the title text).
Independently verified against all 9 ACs, including a real Electron/contextBridge/ipcMain round trip
for AC1/AC3/AC9. One spec-wording nit surfaced, not a functional bug: AC7 assumes
`IdentityProfilesDialog` and `CloneDialog` can be open simultaneously, but real-Electron testing
proved that's unreachable by any actual user action (`App.tsx`'s modal-exclusivity gate plus
`CloneDialog`'s own in-flight-blocks-dismissal behavior both independently prevent it) — FR-381 is
still correct by construction (the disabled-reason function never reads clone state at all), so this
didn't block merge; AC7's wording just needs reconciling by whoever next touches that spec. Also
surfaced a real, pre-existing, unrelated bug during verification — see Open section above
(`useIdentityProfileApplication`'s stale-closure `reload()`).

**2026-09-25 — commit graph `refs/original/*` backup-ref leak fixed.** `commitLog.ts`'s
`buildRevisionArgs()` widened its `--exclude` to also cover `refs/original/*` (previously only
`refs/stash` was excluded), so a repo that's ever had `git filter-branch` run on it no longer
renders duplicate pre-/post-rewrite commits or phantom `On main:`/`index on main:`/
`untracked files on main:` rows. Orphan-branch histories (e.g. `gh-pages`) are unaffected — still
render as their own separate root, confirmed unchanged. Security-reviewed (no findings — fixed
literal argv string, no injection surface) and independently verified against both the git-core
unit suite and a real launched-Electron UI check with an actual `filter-branch`'d fixture repo
(caught and worked around a worktree `node_modules` resolution trap along the way — now documented
in `CLAUDE.md`'s Known Pitfalls).

**V2 — online sync (2026-09-17 → 2026-09-20).** Five phased specs, built in dependency/risk order,
each security-reviewed before merge; clone additionally went through three follow-up review rounds
(whole-milestone cross-phase audit, symlink/TOCTOU verification, `/code-review`). All findings were
fixed — details in git log and the specs.

- Fetch + diverged indicator + credential-failure UX — `specs/online-sync-fetch.md` (FR-320–328)
- Git Identity & SSH Key Profiles — `specs/git-identity-profiles.md` (FR-329–337, +FR-378/379)
- Pull — `specs/online-sync-pull.md` (FR-338–343)
- Push — `specs/online-sync-push.md` (FR-344–350)
- Clone — `specs/online-sync-clone.md` (FR-351–358)
- Reset to here — `specs/reset-to-here.md` (FR-359–377)

**Earlier milestones.**

- 2026-09-20 code-review cleanup — clone destination edge cases, shared `useDialogChrome` hook
  across 7 components, flaky tests, root `npm test` exit-code trap, and the
  `refreshWorkingDirStatus`/`refreshRefs` unhandled-rejection bug class.
- Drag one commit node onto another for a contextual action menu — `specs/drag-commit-menu.md`
  (FR-295–319), plus cursor-following drag ghost and real-ref-name resolution.
- Landing page premium design pass + SEO fundamentals on `gh-pages` ("transit / rail wayfinding"
  system, real screenshots, self-hosted fonts, title/meta/OG/JSON-LD/sitemap).
- Release pipeline — tag-triggered `release.yml` matrix-builds win/mac/linux installers to a
  GitHub Release. `v0.1.0` was the first real one; `v0.3.0` is the current release.
- Image diff preview — `specs/image-diff-preview.md`.
- V1.1, all items — `specs/repo-list.md`, `specs/remember-last-selected-file.md`,
  `specs/restore-tabs-on-relaunch.md`, `specs/amend-last-commit.md`, `specs/compare-commits.md`.
- Keyboard shortcuts / Command Palette + reference overlay —
  `specs/keyboard-shortcuts-command-palette.md`, `specs/keyboard-shortcuts-reference.md`. Landed
  `CLAUDE.md`'s convention that new user-facing actions must get a `commands.ts` entry.
- Find Commits overlay — `specs/find-commits-overlay.md`; replaced the permanently-mounted
  `FilterBar`. `Ctrl/Cmd+F` separately focuses the Branches sidebar search.
- Design passes 1 & 2 (`DESIGN.md` has the rationale) — selection halo, persistent left Branches
  sidebar with search-to-jump, persistent leading ref-chip gutter column.
- Repo-open spinner feedback — `specs/repo-open-feedback.md`, `specs/repo-open-feedback-fixes.md`.
- Instant revisit for already-loaded tabs — `specs/instant-tab-revisit.md`.
- Licensing: GPL-3.0-or-later across root `LICENSE`, all `package.json`s, and SPDX headers on every
  source file. No dependency blockers; `README.md`'s non-affiliation disclaimer is in place.
- Priority 0 bug: selection ring on the wrong commit after scrolling — root cause and
  do-not-reintroduce note now live in `CLAUDE.md`'s Known Pitfalls.
- Tech debt, all resolved — consolidated working-directory-status git spawns (`useRepositoryGraph`
  is the single fetch owner); test-suite flakiness under full parallel load;
  `resolveGitExecutablePath()` eager warm-up; repo-open tab dedup case-insensitivity
  (mapped-network-drive-vs-UNC left a documented non-goal); `ipcTransport.spec.ts`'s ambiguous
  button selector.
