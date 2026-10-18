# ROADMAP archive — shipped history

Moved verbatim from `ROADMAP.md`'s `## Shipped` section (2026-10-12) to keep the live roadmap small.
Purely historical: what shipped, when, and why. Open work, backlog and standing constraints stay in `ROADMAP.md`.
Full requirements and acceptance criteria live in `specs/*.md` (see `specs/INDEX.md`).

## Shipped

**2026-09-30 — detached-HEAD orphaned-commits guard (FR-430) + drag-to-merge real-Electron verification + FR-437 spec amendment.** Leaving a detached HEAD that carries commits no ref reaches now shows a pre-checkout dialog (Create branch here… / Leave commits behind / Cancel, Cancel default; a generic "couldn't check" variant when git can't tell) from every GitHydra checkout path through one `guardedCheckout` choke point, then a dismissible "Create branch at <sha>" banner; new palette entry "Create branch at detached HEAD". git-core: `getOrphanedHeadCommits` (two bounded read-only calls, fails closed), HEAD-bound `switchBranch`/`switchToCommit`/`createBranch` (`HeadMovedError`), narrow `createBranchAtCommit`. Security-reviewed at design and code level (one medium memory-bound finding fixed before merge); real-Electron spec `detachedHeadOrphanGuard.spec.ts` plus the drag-corner spec pass. FR-437's palette-entry deviation resolved by amending the spec. See `specs/branch-panel-drag-merge.md` and `packages/git-core/README.md`.

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
  as predating both changes). **Fixed 2026-09-30 (`fix/small-fixes-batch`).** Root cause (a test
  race, not a product bug): the "0s" readout is `useElapsedSeconds`'s initial state, so the test's
  first `waitFor` could pass before the passive effect that registers the faked `setInterval` had
  run; under load `vi.advanceTimersByTime(3000)` then fired nothing, the interval registered
  against the already-advanced fake clock, and the readout stayed "0s" (failure was a wrong value,
  `Unable to find an element with the text: 3s` with the DOM showing `0 s`, not a waitFor timeout).
  Fix: an empty `await act(async () => {})` (`flushEffects()`) before each clock advance. Evidence:
  1 failure in 12 runs while a second `vitest run e2e` process loaded the box (reproduced, same
  assertion at line 84); after the fix 50/50 consecutive runs passed under the same load.

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

- **Mid-merge landing (`specs/mid-merge-landing.md`, FR-577..583)** — built on `feat/mid-merge-landing`: conflict banner with Resolve conflicts, calm resolved state, conflict-styled working-directory row (fixes the cherry-pick label/connector overlap), once-per-operation auto-open, tab badge and window title, "Resolve conflicts" palette entry. Open: background tabs show no badge (only the live tab knows its count).

- **Worktrees (`specs/worktrees.md`, `specs/external-programs.md`, `specs/worktree-copy-ignored.md`, `specs/banner-uniform-look.md`, FR-601..648)** — merged to `main` 2026-10-18 (merge `268c250`, tag `pre-worktrees-merge` = old main): git-core engine (list/add/remove/prune, destination and metadata trust, hook consent fingerprint, forged-gitdir protection on old git, junction-safe removal, copy engine with manifest), create dialog, Worktrees section, open as a new tab, remove flows with typed count, editor picker (accordion, Programs dialog, detection on Windows/macOS/Linux, launcher), hook-consent dialog with a main-side native box, copy ignored files with a per-repo memory and read-only `.worktreeinclude`, uniform banner look (no side stripe). Every slice was security-reviewed with its changes applied; verified on git 2.31.1 and 2.56.0. Follow-ups stay in `ROADMAP.md` ("Post-merge TODO").
