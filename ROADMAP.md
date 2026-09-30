# ROADMAP — post-v1

**Status:** v1, V1.1, the design-pass/Floaters backlog, and **V2** (all five online-sync phases
plus Reset to here) are fully shipped. Nothing is queued as the next milestone.

**Convention:** this file is intake, not spec detail. Shipped items get one line — outcome + spec
reference; the full problem/acceptance-criteria/FR/review history lives in `specs/*.md` and git
log. Only genuinely open items keep their context, since that's what someone needs to act on them.

## Open

### Drag-to-merge: unverified corners (shipped 2026-09-30, see Shipped)

Not yet exercised in a real app run, only by design/unit tests: highlight/ring legibility on lane
colors other than the single default blue (scratch repos had one lane); the drop menu and the
"Merge branch" palette picker in the light theme; a dirty-tree checkout refusal and a conflicting
merge reached through a real drag; detached-HEAD merge and whether git's orphaned-commits warning
still surfaces (FR-430); dragging a card whose branch has no rendered chip; drag with a Branches
search filter active. Also: the palette entry is always available rather than hidden/disabled in
bare-repo/in-progress states (the palette hides unavailable commands; the picker shows the reason
inline) — a small deviation from FR-437. One full-suite vitest failure appeared once during this
work and did not reproduce; the failing test was never identified — check next time suite stability
gets attention (same family as the `App.repoOpenElapsed` note below).

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

**2026-09-30 — `@githydra/git-core` dependency spec in `packages/desktop` is now `*`.** Workspace resolution always wins, so bumping git-core alone no longer breaks `npm install` (proved by a scratch bump; real `package:dir` build bundles `git-core/dist`, packaged app starts). Added `npm run check:versions` (`scripts/check-versions.mjs`), also run in `release.yml`'s `version-check` job, to fail on version drift among the root, git-core and desktop packages.

**2026-09-30 — identity dialog stale post-apply/remove state fixed.** `useIdentityProfileApplication` now refetches with the just-written (apply) / just-cleared (remove) `knownApplication` instead of a pre-update closure, so Apply shows "Applied by GitHydra" with Remove enabled and Remove shows the correct disabled reason with no dialog reopen (both paths were affected); jsdom mock now honors `knownApplication`, real-Electron spec added; security-reviewer approved (two optional low-severity notes: no repo-still-current guard or request-sequence guard on `load`, same as before this fix).

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

**2026-09-30 - branch drag-to-merge: chips, "+N" popover rows and Branches cards.**
`specs/branch-panel-drag-merge.md` (FR-418-439). Grew from a user report that dragging a chip dragged
the whole gutter: local-branch chips became their own drag sources/targets, the "+N" popover rows
became real chips that are targets too (hover-to-open while dragging), and Branches-panel local cards
joined as sources and targets. The whole gesture (session, ghost, hover-open, drop menu, merge with an
explicit `targetBranch` so a branch sharing HEAD's commit is still checked out) is one shared hook,
`useBranchDragSession.tsx`; the Command Palette gained "Merge branch into current branch..." (a
picker, `MergeBranchPicker.tsx`) as the keyboard route. Verified in real Electron with real pointer
events (`e2e-playwright/electron/refChipDragMerge.spec.ts`), which caught two bugs jsdom could not:
disabled popover buttons are not hit-testable in Chromium, and a CSS-ordering slip left the popover
chip inset inside its row. Known gaps: no auto-scroll/auto-paging during a drag (v1), and dropping on
a graph chip needs that chip rendered; card-to-card covers hidden branches.

**2026-09-29 — ref-chip gutter redesign: wider column, lane-tinted background, literal icons.**
`specs/ref-chip-gutter-redesign.md` (FR-414–417). A dual-agent `impeccable critique` (design-review
+ detector/real-Electron-measurement, run independently) found the gutter above still failed in the
majority case for this project's own real branch names — a single, non-collapsed chip truncated to
~10-12 characters regardless of full length, always cutting inside the `fix/`/`docs/`/`feat/` type
prefix. Three changes: (1) `REF_GUTTER_WIDTH` widened 100px -> 148px, the exact arithmetic ceiling
`layoutBudget.test.ts` already had headroom for; (2) the abstract dot/ring/diamond/square glyphs
replaced with literal icons (`IconBranches` reused, new `IconRefTag`/`IconRefRemote`/`IconRefPin`)
so the branch glyph no longer visually collides with the graph's own commit-node dot; (3) same-day
addendum (FR-417) after the user reconsidered the initial neutral-border/no-color treatment: each
chip's background is now tinted with its own commit's lane color via `color-mix()`, at an opacity
derived from a new, independently-tested WCAG contrast-ratio utility (worst case ~5.7:1 against the
4.5:1 floor, checked across all 8 lane slots x both themes) rather than eyeballed — a real
accessibility floor, not a style choice, since 3 of the 8 lane hues are already documented as
sub-3:1 at full saturation. `DetailPanel.tsx`'s ref-chip caller (no real lane-color value available)
keeps the prior neutral-bordered fallback. Independently re-verified end to end by test-agent,
including its own from-scratch contrast re-derivation and real-Chromium `getComputedStyle()` read
against live rendered chips, not just a re-run of the implementer's own tests.

**2026-09-29 — ref-chip popover icons, local+upstream chip merge, and a real origin/HEAD bug.**
`specs/ref-chip-synced-upstream-merge.md`. Three things shipped together on one branch (user
request): (1) the "+N" ref-collapse popover never got the literal per-type icons from the redesign
pass above — plain text only, found via a real user report on a collapsed remote-tracking branch;
`ContextMenu.tsx` gained an optional `icon` slot, reused by both the popover and any future caller.
(2) New: a local branch and its EXACTLY-synced upstream (`ahead===0 && behind===0`, a real
configured upstream) now merge into one chip with both icons instead of two — proposed by the user
mid-review; reuses the same `listBranches()` call `useDivergedBranches.ts` already makes, no new
IPC. The checked-out row's HEAD-badge `iconOnly` crowding fix needed broadening: a merged chip's
extra icon widens it enough to reproduce the same squeeze even with no "+N" present, found via a
real screenshot. (3) Real, independently-confirmed `git-core` bug found while building #2 with an
actual `git clone` (every prior fixture in this area used synthetic branches, never a real clone):
`refs.ts`'s `listRefs()` was decorating commits with a phantom "origin/HEAD" remote-tracking chip —
a remote's symbolic HEAD pointer, which `branches.ts`'s `listRemoteBranches()` already excluded for
the Branches sidebar but this commit-graph path never had the same exclusion. Not an edge case — a
plain `git clone` creates this symref by default, so every cloned repo's graph was affected.
Test-agent's independent verification also found and this session fixed a fourth, unrelated
pre-existing bug: the "+N" popover (every row disabled by design) let Arrow/Home/End fall through
to the browser's native scroll, which the popover's own "close on scroll" rule then reacted to,
closing itself on a keypress meant to navigate it (`ContextMenu.tsx`).

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
