# ROADMAP — post-v1

Status: v1 core is fully shipped (see `CLAUDE.md`) — commit graph, stage/unstage + diff, branch
management, merge/rebase + conflict resolution UI, stash, cherry-pick, and blame & file history.
Everything below is queued for after v1 core.

This file is intake from a planning session — the raw asks and bug reports as discussed,
not formal specs. product-manager should read it and turn each item into a proper spec
(problem/acceptance-criteria, FR numbers, the works) the same way it has for every prior
feature — same as `AGENTS.md`'s existing spec-first workflow, nothing new here.

## Open tech debt — git-core test suite is flaky under full parallel load (queued)

Independently surfaced twice during the repo-open slowness investigation (the fs-fast-path fix and
the rev-parse consolidation): running `packages/git-core`'s full suite with default parallelism
(27 files at once) produces 10-13 spurious failures — timeouts on suites that spawn many real
`git.exe` processes simultaneously, Windows `EBUSY: resource busy or locked, rmdir` races in test
teardown, and one fs-watch debounce-timing assertion. Every failing file passes 100% cleanly when
re-run in isolation (single-fork, no cross-file contention) — confirmed twice, for two unrelated
changes, so this is resource contention from concurrent test-runner load on this dev machine, not a
real bug in the code under test.

**Fix direction (not yet scoped):** raise per-test timeouts for the heaviest git-spawning suites
(`commitLog.test.ts`, `noNetworkCalls.test.ts`, `watcher.test.ts`, `cherryPick.test.ts`,
`stash.test.ts`), and/or reduce default test-file parallelism, and/or retry the Windows rmdir race
specifically (a known class of issue with `fs.rm`'s recursive removal racing a just-closed file
handle). Low priority — doesn't block shipping anything, just makes "run the whole suite" a noisy
signal until addressed.

**A second, complementary fix — implemented and measured (user's own idea, 2026-09-07):** on this
dev machine, real-time antivirus scanning was a real contributing suspect, not just OS-level
resource contention — every test file spawns many real `git.exe` processes touching many files in
parallel, and each touched file is a fresh AV scan target. `packages/git-core/tests/testRepo.ts`'s
`makeTempDir()` and `packages/desktop/src/test/gitFixture.ts`'s equivalent used to create fixture
repos under `os.tmpdir()` (Windows system temp), **outside** the project directory entirely — so
excluding just the project folder from AV scanning, on its own, would not have covered them. Both
now create fixtures under a gitignored `.tmp-test-repos/` folder inside their own package, so one
Windows Defender exclusion on the whole project folder (which the user added) actually covers the
fixture output too.

**Result, measured before/after with the user's exclusion in place:** two full-suite runs of
`packages/git-core` under default parallelism (the exact scenario that used to produce 10-13
spurious failures) both came back at **6 failed / 438 tests** — a real, consistent ~50% reduction,
not eliminated. The remaining failures are exactly the other two causes this entry already
named — a `watcher.test.ts` debounce-timing timeout and one `EBUSY: resource busy or locked, rmdir`
race — neither fixed by this change, both still needing the original fix direction above (raise
timeouts on the heaviest suites, and/or retry the Windows rmdir race specifically). Treat AV
contention and timeout/rmdir-race handling as two separate, both-still-partially-open causes of
the same symptom, not one fix that closes this entry outright.

## Open tech debt — `resolveGitExecutablePath()`'s slow first call (queued)

Promoted to its own item (2026-09-07) so it doesn't stay buried inside the flakiness entry above,
or inside `specs/repo-open-feedback.md`'s older status notes — genuinely still open, not resolved
by that spec's FR-162–165 despite that section's "implemented" wording (what actually landed was
the *investigation*, not a fix). Original observation: the very first `git` process spawned in a
session sometimes takes far longer than normal (one run took 31 seconds before an error appeared;
other runs, same machine, same folder, resolved in under a second), while a raw `git rev-parse`
in the same environment consistently takes ~60ms — pointing at a one-time cost specific to the
first spawn, not the request logic itself. Leading hypothesis, strengthened by this session's
AV-exclusion fix above: real-time antivirus scanning a freshly-invoked `git.exe`, or a slow `PATH`
probe during `resolveGitExecutablePath()`'s own directory search — plausibly the same root cause
as the test-suite flakiness fix above, just hitting a real user session instead of the test
runner. Not verified against a real repo-open session the way the test-suite fix was measured.

**Fix direction (not yet scoped):** confirm whether the same AV-exclusion effect applies to a real
app session (not just the test suite), and separately investigate resolving/caching this path
eagerly at app startup instead of on first repo-open, so the cost (whatever it turns out to be) is
paid once during launch rather than surfacing as an unexplained slow first open.

## Open tech debt — repo-open dedup uses exact string equality, no path normalization (queued)

Caught by security-reviewer during the Repo List landing-screen rebuild (`specs/repo-list.md`'s
global-dedup revision, `useRepoTabs.ts`'s `openNewTab`/`openRecentInNewTab`). The existing-tab dedup
check is `tabsRef.current.find(t => t.repoPath === path)` — exact string equality against whatever
raw path the OS dialog or the recent-list entry happens to carry, never git-core's own resolved/
canonical toplevel path (`main.ts`'s `openRepo`/`openRepoCancellable` handlers return the caller-
supplied raw path, not the resolved one, so the canonical value never reaches the tab layer).

Consequence: two different spellings of the same physical repo — a mapped network drive letter vs.
its UNC path, a symlink/junction vs. the real path, or a differently-cased path on a case-insensitive
filesystem — fail to dedupe, producing an extra tab for what's functionally the same repo. Not a
data-corruption risk (strict equality can't falsely merge two genuinely different repos into one
tab), just a missed dedup in specific path-spelling edge cases. Pre-existing pattern (the original
recent-list-only dedup had the same gap); this rebuild only widened its surface to manually-browsed
paths too.

**Fix direction:** resolved by `specs/repo-open-feedback-fixes.md` FR-202/FR-203 for the
subfolder-of-a-larger-repo case (the one this was originally caught on) — `main.ts`'s
`openRepo`/`openRepoCancellable` now return git's resolved `workdir` instead of the raw path, so
picking any subfolder of an already-open repo dedups correctly. Full path canonicalization
(symlinks, mapped drive letters vs. UNC paths, case-insensitivity beyond that) remains open —
still low priority, queue behind anything with real product pull.

## Licensing decision (done — GPL-3.0-or-later)

Discussed during a naming/branding pass on the app icon (see `oss-licensing-guardrails` skill),
finalized directly with the user afterward.

- **License: GPL-3.0-or-later, confirmed.** User's stated priority is that GitHydra and any fork
  of it stay free/open forever, not maximizing commercial adoption — copyleft (anyone
  distributing a modified version must open-source their changes too) serves that better than
  MIT/Apache-2.0 would. AGPL-3.0's extra network-use clause was considered and declined for now
  since this is a local desktop app, not a hosted service — revisit only if V2's "Online
  connection (push/pull)" item ever grows a hosted/server component. Landed: root
  `LICENSE` file (official FSF GPL-3.0 text), `"license": "GPL-3.0-or-later"` in all three
  `package.json` files (root, `packages/desktop`, `packages/git-core`, replacing `UNLICENSED`),
  and an SPDX header (`// SPDX-License-Identifier: GPL-3.0-or-later`) stamped on all 216
  `.ts`/`.tsx` source files across both packages. Build verified clean after stamping.
- **Dependency check: no blockers.** All current dependencies across the three `package.json`
  files (root, `packages/desktop`, `packages/git-core`) are permissively licensed (MIT/Apache-2.0:
  React, React DOM, Electron, Vite, TypeScript, Vitest, Playwright, Testing Library, jsdom) —
  none are copyleft, so none restrict which license GitHydra itself can use. `git-core` also
  shells out to the system `git` CLI rather than embedding `libgit2` (see
  `docs/tech-decisions.md`), which as a side effect avoids statically linking any GPL code.
- **README non-affiliation disclaimer — still deferred, not decided against.** No root `README.md`
  exists yet at all, so this isn't just a license-driven delay — it needs the actual README to be
  written first (separate task, not scoped here). User was previously wary of naming a competitor
  by name in a disclaimer (fear of the opposite effect — inviting scrutiny/comparison rather than
  deflecting it); revisit phrasing when the README itself gets written.
- **Donate/coffee link — approved in principle, not yet built.** Discussed and confirmed
  compatible with both GPL-3.0 and the "always free" principle: a purely voluntary donation link
  (GitHub Sponsors/Ko-fi/Buy Me a Coffee style) doesn't gate any feature behind payment and is
  common practice in copyleft OSS projects. No urgency — natural to add once the project is
  actually public, not before. Keep it passive (a link, not a nag/popup) when it's built.

## Release pipeline (done — v0.1.0 shipped)

**Status (2026-09-07):** `.github/workflows/release.yml` is landed and proven against a real tag,
not just reviewed on paper — `v0.1.0` was cut for real and iterated on until the whole pipeline
went green end-to-end. Five real runs, three distinct real bugs found and fixed along the way:
(1) `package-lock.json` still pinned `0.0.0` after the version bump, breaking `npm ci` — fixed by
regenerating the lockfile; (2) `packages/desktop/package.json`'s own dependency spec on the local
`@githydra/git-core` workspace package hadn't been bumped to match, so npm tried (and 404'd)
fetching it from the public registry — fixed by bumping that spec too; (3) the Linux `.deb`/
AppImage `executableName` was being derived from the scoped npm package name (`@githydra/desktop`,
invalid executable-name characters) — fixed by setting `executableName: GitHydra` explicitly in
`electron-builder.yml`; (4) the `.deb` target separately required `homepage`/`author.email` in
`package.json` and a Debian `Maintainer` — fixed by adding both plus an explicit `linux.maintainer`
in `electron-builder.yml`, using the project's GitHub no-reply address rather than a personal email
(same privacy rule as git commit authorship — see below). Run 6 succeeded on all three platforms
and published a real GitHub Release with all five installers + `SHA256SUMS.txt` attached at
`github.com/perry42/GitHydra/releases/tag/v0.1.0`.

**Privacy convention, not yet written down elsewhere:** the user's real personal email must never
appear in anything public-facing for this repo — not `package.json`, not git commit authorship.
Use the GitHub no-reply address (`84661701+perry42@users.noreply.github.com`) wherever a public
identity/email is required instead.

**Code-signing — application in progress, not yet decided/landed.** Unsigned Windows builds
trigger SmartScreen's "unknown publisher" warning; unsigned macOS builds get blocked by Gatekeeper.
The user is applying to **SignPath Foundation** (`signpath.org/apply.html`) for a free Windows
OV code-signing certificate for qualifying open-source projects (GitHydra's GPL-3.0-or-later
license and public repo qualify) — application submitted 2026-09-07, approval typically takes
days to weeks. Two open follow-ups once/if approved: (1) wire SignPath's GitHub Actions signing
step into `release.yml` (they submit the built `.exe` to SignPath's pipeline rather than handling
a private key directly — see `docs.signpath.io/trusted-build-systems/github`); (2) the download
page (GitHub Releases) needs to mention "signed via SignPath Foundation" per their program terms.
macOS still has no free option — Apple Developer Program ($99/yr) would still be required for
notarization regardless of SignPath approval; not pursued yet. Until any of this lands, the
working plan stays: ship unsigned, document the SmartScreen/Gatekeeper workaround in the release
notes (already done — see `release.yml`'s "Write release notes" step).

## Release pipeline — original scoping note (superseded by the shipped status above)

**Scoped:** `specs/release-pipeline.md` (FR-171–FR-180, 10 acceptance criteria) — a tag-triggered
GitHub Actions workflow that matrix-builds installers via electron-builder for win/mac/linux and
publishes them to a GitHub Release, plus the version-consistency guard, unsigned-binary disclaimer,
and README follow-up. Chosen by product-manager as the next mission (2026-09-06): it's the one
remaining item that changes who can use GitHydra at all, versus every other queued item (tech debt,
the ref-chip legibility gap the user asked to hold off on, floaters, V1.1/V1.5) which only matters
to someone who can already run the app.

Separate from — and downstream of — the electron-builder work, which **is already committed and
merged**, not in-progress: `e8e248e` (`feat(desktop): add app icon and electron-builder packaging
config`) landed the app icon set (`packages/desktop/build/icon.ico`/`.icns`/`icons/*.png`) and
`packages/desktop/electron-builder.yml` (win/mac/linux targets, icon paths, appId, productName,
`publish: null`) on `main` well before this note was corrected. That work makes `npm run package`
produce a Windows NSIS `.exe`, a macOS `.dmg`, and a Linux AppImage/`.deb` **on the machine that
ran it** — nothing hosts or publishes those files anywhere a real user could download them. Until
the item below lands, GitHydra has never had a way to get an installer in front of anyone who
isn't building from source.

**Correction (this file previously said this work was uncommitted, sitting only in a git
stash — that was wrong):** `stash@{0}` (`WIP on main: 7e73aee...`) does still exist, but
inspecting it (`git diff "stash@{0}^1" "stash@{0}"`) shows it predates `e8e248e` and its
electron-builder/icon changes are the *same* work `e8e248e` already landed independently
(identical `main.ts` icon-wiring, the same `package.json` script/dependency additions, the same
`.gitignore` `release/` entry) — plus a `package.json` description string and a `ROADMAP.md` draft
that are both already stale relative to `main`. The stash is superseded, not a pending
contribution: applying it now would just conflict with what's already merged. Whoever next
touches this should diff it against current `main` to confirm nothing unique survives, then drop
it, rather than trying to apply it.

- **GitHub Actions workflow, triggered on a version tag (e.g. `v1.0.0`)** — matrix-build across
  windows-latest/macos-latest/ubuntu-latest runners, run `electron-builder` on each, upload the
  resulting installers as assets on a GitHub Release. This is the standard free distribution path
  for an OSS Electron project and needs no separate hosting or backend — consistent with the "no
  proprietary sync layer" principle, since it's pure CI infrastructure, not something the running
  app talks to or depends on.
- **Placement: right after the licensing decision, ahead of Design pass 2 and everything below
  it.** Both this and licensing are "makes v1 an actual public release, not just something
  runnable from a git clone" gates, not user-facing feature work. Licensing is now done (see
  above) — this item is next.
- **No longer blocked on the electron-builder work landing** — it already has (`e8e248e`,
  above). The workflow's actual build step is close to "run the same `package` script a
  contributor would run locally," so it can be scoped and wired up now.
- **Code-signing — open question, flagged not decided.** Unsigned Windows builds trigger
  SmartScreen's "unknown publisher" warning; unsigned macOS builds get blocked by Gatekeeper
  unless the user right-click-opens or clears the quarantine attribute manually. Real
  code-signing certificates cost money annually (a Windows EV cert and an Apple Developer
  Program membership both aren't free), which may or may not fit a free hobby OSS project's
  constraints — that's a call for the user to make, not a default assumption either way. Until
  resolved, the working plan is: ship unsigned, document the workaround for both platforms in the
  release notes/README, and revisit signing only if it becomes a real adoption blocker.
- Non-goal for this item: no auto-update mechanism. That's a materially larger feature
  (update-check + in-app download/apply flow) and isn't required just to get versioned installers
  onto a Release page — track separately if it comes up later.

## Open bug — repo-open spinner gives no feedback on a slow/failing folder pick (done)

Reported by the user testing "select a folder with no git repo in it" — appeared to hang
indefinitely. Investigated by launching the real built app live (Playwright-driven,
`dialog.showOpenDialog` stubbed to return a genuinely non-git folder confirmed via `git
rev-parse --show-toplevel` failing first), not just reading the code.

- **The error path itself is correct and was hit successfully every time** — `MainArea`'s
  `status === "error"` branch (`App.tsx` ~line 661) does render "Could not open this
  repository" with the real git error message. This is not a true infinite hang; there's
  existing regression coverage for it too (`App.multiRepoTabs.test.tsx`, "AC7").
- **But how long it takes to get there is wildly inconsistent.** One fresh-app-process attempt
  took 31 seconds before the error appeared; two other fresh-process attempts (same folder,
  same machine, run minutes apart) resolved in under 1 second. Root cause not fully pinned
  down — leading hypothesis is a one-time cost on the very first `git` process spawn in a
  session (e.g., Windows Defender/AV real-time-scanning a freshly-invoked `git.exe`, or a slow
  PATH entry during `gitProcess.ts`'s `resolveGitExecutablePath()` directory probe), not
  anything wrong in the request logic — a raw `git rev-parse` in the same environment
  consistently takes ~60ms.
- **The real, always-true product gap regardless of root cause:** `MainArea`'s "Opening
  repository…" spinner gives zero feedback — no elapsed time, no cancel affordance, no
  explanation — for however long the backend takes, up to the full `DEFAULT_GIT_TIMEOUT_MS`
  120-second ceiling (`gitProcess.ts`). A user staring at a static spinner for 30+ seconds with
  no way to tell if it's stuck or just working reads exactly like "keeps loading forever," even
  on the runs where the code was already working correctly underneath.

**Fix direction (not yet scoped/spec'd):** add a cancel affordance and/or elapsed-time
indicator to the opening spinner. git-core-engineer should separately investigate whether
`resolveGitExecutablePath()`'s first-call PATH probe can be made faster or resolved eagerly at
app startup instead of on first repo-open, to reduce how often the slow path is even hit.

**Cross-reference — V1.1's "Repo list" item below:** once repo paths are persisted, a
previously-valid entry that's since become invalid (moved, deleted, `.git` removed) should be
validated/surfaced the same way, not silently hit this same unindicated-delay problem when the
user clicks back into it.

**Scoped:** `specs/repo-open-feedback.md` (FR-162–FR-170) — elapsed-time indicator, a cancel
affordance wired to a new `AbortSignal` end-to-end on the open-repo git call, and the
`resolveGitExecutablePath()` eager-resolution investigation. Handed to git-core-engineer
(FR-162–165) and ui-graphics (FR-166–170).

**Status:** landed and pushed as `0f1d3db`, security-reviewed and test-agent verified (all 9
acceptance criteria met). git-core-engineer's FR-162–165 (abort-signal plumbing,
`resolveGitExecutablePath()` investigation) and ui-graphics's FR-166–170 (elapsed-time readout, the
Cancel affordance, and its state-restoration wiring in `useRepositoryGraph`/`useRepoTabs`) are both
implemented and covered
by component/hook tests. One known follow-up gap found and flagged during FR-167–170 work, not yet
resolved: canceling a tab reactivation that was triggered by *closing* another tab (`useRepoTabs`'s
`closeTab` adjacent-tab-reactivation path) has no well-defined "restore to" target, since the tab
that was showing before that reactivation is the one the user just deliberately closed — left
un-special-cased (no rollback) pending a product decision on what it should do instead.
security-reviewer also caught, and git-core-engineer fixed, a cache-poisoning bug where a genuine
`git --version` timeout (not just a user cancellation) was permanently miscaching the version check
as unsupported. Remaining known gap: no full-stack (real Electron + real `RepoSession` + real
git-core + UI) test exercises this feature end-to-end — coverage is real but layered (git-core's
own process tests, `RepoSession`-level tests with git-core mocked, IPC-handler tests with
`RepoSession` mocked, UI tests with the whole API mocked), because real-Electron e2e reportedly
cannot launch in this sandboxed dev environment. Revisit once that constraint is resolved.

**Update — regression found post-"verified" (queued fix):** a real user report (picking a
"Downloads" folder that resolved upward to an unrelated repo — expected git behavior, not itself a
bug) led to direct source investigation that found three real problems in this "landed... verified"
feature, none related to that specific stray repo (since deleted): (1) Cancel only works during
`Repository.open()`'s own phase — `refreshAuxData`'s refs/upstream/working-dir-changes/stash reads
and `startReader`'s log-reader/first-page fetch are not cancellable at all today (no `signal`/
`requestId` reaches those IPC handlers or git-core methods), so Cancel silently no-ops for the rest
of a slow open even though the button stays visually enabled the whole time; (2) the Recent
Repositories list (and tab identity) is keyed off the raw path the user picked, not git's own
resolved toplevel (`RepositoryState.workdir`, already computed on every open) — this is the same
root cause as this file's "repo-open dedup uses exact string equality" tech-debt entry below, now
folded into the same fix rather than tracked separately; (3) `useRepoTabs.ts`'s `switching`
global-lock scope was re-evaluated and confirmed correct as-is — not loosened — since the app's
single shared `RepoSession` makes two tabs' opens genuinely running concurrently unsafe today,
independent of the existing generation counter. Full write-up, FR-197 through FR-207, and
acceptance criteria: `specs/repo-open-feedback-fixes.md`. This also resolves the "repo-open dedup
uses exact string equality, no path normalization" tech-debt entry below for the subfolder-of-a-
larger-repo case (full path canonicalization for symlinks/mapped-drives/case remains open and
separately tracked, per that entry's own scope).

## Open design gap — ref-chip gutter with 2+ chips on one row (queued)

Reported by the user against the live app: a commit with two branch chips on it (e.g. right
after branching — both the source and new branch still point at the same tip commit) rendered
both chip labels as illegible fragments.

Not an accidental bug — `REF_GUTTER_WIDTH` (`graphGeometry.ts`, currently 100px) is a
deliberately tuned value with its own regression history: it was shrunk from 160px after an
earlier fix found the wider column crushed the commit-subject column to ~0 visible characters
at the app's default window size (`layoutSizes.ts`'s `RIGHT_PANEL_DEFAULT_WIDTH` comment has the
full story). `CommitGraph.css`'s `.gh-commit-row__refgutter .gh-refchip` rule already handles
multiple co-located chips by shrinking each independently rather than overflowing the column —
that was a deliberate design decision, just never validated for *legibility* with 2+ chips
sharing the row, only for "doesn't break the layout." Every chip already carries a real `title`
attribute with its full un-truncated name (hover reveals it), so this is a readability gap, not
a data-loss one.

**Not fixed yet — documented per user's explicit request to hold off on a fix for now.**
Options surfaced and left open for a future design pass (ui-graphics): prioritize the current/
checked-out chip's space over secondary chips; stack 2+ chips vertically within the gutter
instead of squeezing them horizontally; or collapse secondary chips behind a small "+N" affix.
Given this area's regression-test history (`App.branchTagGutter.e2e.test.tsx`,
`layoutBudget.test.ts` pin the current arithmetic), whichever direction is chosen should go
through the same real-Electron-screenshot verification the 160→100 change did, not a
code-only guess.

## Priority 0 — bug (fixed)

- **Selection ring renders on the wrong commit** when the selected row isn't the first one
  visible in the current scroll position — fixed. Root cause: `GraphCanvas.tsx`'s `<canvas>`
  element was CSS-pinned at `top: 0` while each `CommitRow` DOM element tracks scroll via inline
  `top: index * ROW_HEIGHT`, so everything the canvas drew (including the selection ring)
  rendered `startIndex * ROW_HEIGHT` pixels above the actual DOM rows once scrolled. Fix: the
  canvas element now sets the same `top: startIndex * ROW_HEIGHT`. Covered by a regression test
  (`GraphCanvas.test.tsx`) that fails without the fix and passes with it. Do-not-reintroduce note
  now lives in `CLAUDE.md`'s Known pitfalls section.

## Design pass — its own milestone, not folded into feature work (done)

(Same principle as everywhere else in this project: design needs to be the main task
sometimes, not permanent background polish squeezed in around feature work.)

Both items below are shipped. Full rationale lives in `DESIGN.md`'s "Component language (added:
design pass — selection halo, Branches sidebar relocation)" section; this entry is kept as the
historical record of what was asked for.

- **Selection vs. merge-node visual conflation — fixed.** Both a selected commit and a merge
  commit used to render as an enlarged circle — a selected merge commit was doubly ambiguous, and
  two unrelated merge commits near each other were hard to tell apart from "is one of these
  selected." Fixed: selection is now an independent overlay layer (`GraphCanvas.tsx`'s
  `drawSelectionHalo`), painted in its own pass strictly after all node-type art, using a
  genuinely different technique (a translucent halo wash + a separate crisp outer contour) from
  the merge node's own plain opaque ring — never a second same-style ring. Node size/shape
  continues to encode commit type only, never selection state; regression-covered by
  `GraphCanvas.test.tsx`.

- **Branches panel relocation + search rebuild — done.** The Branches panel moved from a
  toggleable right-hand rail to a persistent left sidebar (`BranchesPanel.tsx`, rendered
  unconditionally while a repo is open, collapsible to a slim rail rather than closeable). Its
  search (`branch-management.md` FR-50) now also jumps the graph to a matched branch's tip commit
  — a branch's name is a real button, and pressing Enter in the search box jumps to the top
  match — reusing `App.tsx`'s `jumpToSha` (extracted from the blame feature's FR-134 jump logic)
  rather than a new mechanism, per this item's own instruction. `useBranchList`'s two-batched-call
  fetch and client-side filter (the responsiveness bar `branch-management.md` AC16 committed to:
  300+ branches, no dropped frames, constant git-call count) are untouched — the relocation and
  jump addition only touch rendering/navigation, no new git calls.

## Tech debt — its own line item, not silently absorbed into the next feature branch (done)

(Same principle as the design pass above: this needs a deliberate task, not another
one-off patch landed as a side effect of unrelated feature work.)

- **Consolidate the two independent working-directory-status git spawns — fixed.**
  `useChangesPanel.ts` and `useRepositoryGraph.ts` used to independently fetch overlapping
  working-directory data (porcelain v2 per-file vs. v1 aggregate), often within
  milliseconds of each other right after a mutation settled — occasionally colliding as a
  transient `.git/index` lock error on Windows. git-core-engineer first empirically proved
  (`packages/git-core/tests/statusCountEquivalence.test.ts`, 14 scenarios including
  rename/rename conflicts and submodule gitlinks) that `WorkingDirectoryStatus`'s aggregate
  counts are exactly derivable as `.length` of `WorkingDirectoryChanges`'s per-file arrays —
  not just probably. `useRepositoryGraph` (always mounted) is now the single owner of the
  fetch and derives its own summary counts via the new pure `deriveWorkingDirStatus`
  (`packages/desktop/src/lib/workingDirStatus.ts`); `useChangesPanel` (only mounted while
  its panel is open) consumes that shared data as a prop instead of independently
  re-fetching, keeping its own optimistic overlay for instant stage/unstage/discard
  feedback. A new integration test proves exactly one fetch happens per stage/unstage
  action end-to-end (not just on panel open), closing the actual scenario that caused the
  original lock collisions. `withGitLockRetry` stays as defense-in-depth, per the original
  plan. Security-reviewed (one pre-existing, low-severity, self-correcting optimistic-UI
  race noted — unrelated to this change, not blocking) and test-agent verified.

## Design pass 2 — branch/tag label gutter (done)

Prompted by the user comparing GitHydra directly against their GitKraken-style reference images
again and asking for closer structural alignment, not just the first pass's chrome hierarchy.
product-manager reviewed the full ask (branch/tag gutter, per-author avatars, toolbar style,
right-panel avatar chips) and split it: this item ships now, the rest are recorded separately
below rather than bundled in.

- **Branch/tag chips move to a persistent gutter column before the graph**, replacing
  DESIGN.md's current "chip lives at line-ends" placement (a mark on the line, rendered only
  where a ref exists) with a GitKraken-style leading column present on every row. This is a
  deliberate, reasoned revision of that component-language decision, not a silent overwrite —
  DESIGN.md gets updated to record why, matching this project's habit of writing decisions down
  (`CLAUDE.md`'s Known Pitfalls precedent). Color stays restricted to the graph's own lane
  lines/nodes; the gutter label itself stays plain text, per the user's own instruction and
  consistent with the transit-map system's "station name in plain ink beside a colored line"
  convention.
- **Toolbar icon-above-label reversal — considered, declined.** GitKraken's larger icon-above-
  label toolbar buttons were in the original ask; product-manager flagged that adopting them
  would reverse the compact-toolbar fix from the first design pass (which specifically fixed "no
  hierarchy among six identical buttons" from the 25/40 critique). User was asked directly and
  deferred to best judgment; kept the compact toolbar. Not queued.

**Shipped — confirmed, not just assumed.** `DESIGN.md`'s "Ref chip (revised, branch/tag gutter
pass — `RefChip.tsx`/`CommitRow.tsx`)" entry documents the finished design in the past tense;
`graphGeometry.ts`'s `REF_GUTTER_WIDTH` comment is explicitly annotated
"post-shipping-the-gutter"; and `App.branchTagGutter.e2e.test.tsx` /`layoutBudget.test.ts`
regression-cover the resulting layout. The separate "Open design gap — ref-chip gutter with 2+
chips on one row" entry above is a legibility bug found *in* this already-shipped gutter, not
evidence this item is still pending — left open per that entry's own note (user asked to hold
off on a fix).

## Floaters — no dependencies, slot in wherever there's a gap (continued)

- **Per-author identity marks** (commit-node avatars + right-panel avatar chips), matching the
  same functional idea GitKraken uses (identity as a compact visual mark) but in GitHydra's own
  visual language, never GitKraken's specific avatar/mascot treatment. **Must be locally
  generated only** — deterministic initials/color-hash derived from author name+email, never a
  Gravatar/GitHub-avatar network fetch — this is a hard product-principle constraint (no network
  calls by default), not a style choice, and is entirely unrelated to V2's "Online connection
  (push/pull)" item below despite both involving the word "online" in casual conversation. Can be
  built independently, whenever prioritized — no dependency on V2. Needs its own spec (shared
  identity-generation scheme reused consistently across both surfaces) before implementation,
  same as any other feature.

## V1.1

- **Repo list — done.** Spec: `specs/repo-list.md` (9 acceptance criteria, all met). A
  localStorage-backed, most-recently-opened-first list (capped at 20) surfaces as "Recent
  repositories" on the empty state, "+ New tab", and "Open repository…" — clicking an entry opens
  it directly with no OS dialog, deduping to an already-open tab rather than creating a duplicate
  (manual native-dialog browsing to the same path is deliberately left undeduped, per the spec's
  own non-goal). A not-found entry (moved/deleted path) shows an inline "not found" + "remove from
  list" state, never a silent failure. Pure renderer/app-level state — no `git-core` or IPC
  contract change. Security-reviewed (one medium finding fixed: Toolbar's recent-list menu wasn't
  gated by the in-flight tab-switch guard the way TabBar's was) and test-agent verified, including
  a real, unmocked e2e test for the zero-network-calls guarantee (with and without a remote
  configured).
- **Remember last search/filter per repo — needs a conversation with the user before scoping.**
  product-manager already drafted a full spec for this once (FR-197–207, before the repo-open bug
  report interrupted it) but it was never saved, and the user has since said they want to redefine
  it before it's picked back up — do not silently reuse the old draft's shape. Ask/confirm with the
  user first, next time this item comes up.
- **Remember last-selected file within a tab.** Today a tab remembers its selected commit and
  which right panel is open, but not which specific file was selected inside the Changes/
  DetailPanel file list — add that to the same per-tab persisted state.
- **Restore open tabs across app relaunch.** Raised by the user 2026-09-07, initially phrased as
  "remember last selected file" before being clarified into this separate, distinct ask. Today
  `useRepoTabs.ts`'s `tabs` state always starts as `[]` on launch — closing the app throws away
  every open tab, and the user has to manually reopen each repo via the Recent Repositories list
  (`specs/repo-list.md`, already shipped) one click at a time. This item: persist tab identity
  (repo paths, order, which tab was active) across a full quit/relaunch, not just the recent-repo
  list, and restore the tab bar on next launch instead of landing on the empty state.
  Product-manager's take (2026-09-07): real but incremental value — the shipped Recent Repositories
  list already gets most of the way there (one click per repo instead of an OS dialog), so this
  only shaves that down to zero clicks. Worth building, not worth jumping the line for; same tier
  as "remember last-selected file" above, queue behind anything still half-built or with more daily
  friction attached. Scoping notes for whoever picks this up: restoring tab *identity* is cheap
  (no git-core/IPC contract change, same shape as the recent-list persistence); each restored tab
  still pays a real git-read cost on activation since no git data itself is cached across restarts
  — favor lazy-loading each tab's content on first activation (only the previously-active tab
  fetches eagerly on launch) over eagerly re-fetching all restored tabs at once, both to avoid
  wasted work on tabs the user may not revisit this session and to avoid compounding the
  concurrent-git-spawn contention already tracked in this file's flaky-test-suite entry.
  **Scoped:** `specs/restore-tabs-on-relaunch.md` (FR-208–FR-214, 10 acceptance criteria).
  Product-manager reviewed and approved the spec (2026-09-07) — handed to ui-graphics for
  implementation (pure renderer/app-level state, no `git-core` or IPC contract change, same shape
  as `specs/repo-list.md`'s already-shipped persistence).
- **Amend last commit — done.** Spec: `specs/amend-last-commit.md` (FR-148–FR-161, all 11
  acceptance criteria implemented). Landed as `f9174bc` (desktop composer UI, FR-155–161),
  `cb2de72` (git-core: export `NoCommitToAmendError`/`AmendBlockedByOperationError`),
  `d2a432e` (real-Electron e2e coverage), `fe904a2` (no-network test extended to the full AC10
  host matrix), merged at `2e21002`.
- **Compare two commits directly — done.** Spec: `specs/compare-commits.md` (FR-181–FR-196, 15
  acceptance criteria, all met). Reuses `CommitGraph.tsx`'s existing cherry-pick multi-select
  mechanism (`specs/cherry-pick.md` FR-111/112/114) as its selection UI and `App.tsx`'s
  `blameTarget` panel-precedence pattern for the new `CompareView` (with the deliberate FR-194
  deviation: a plain click closes Compare instead of being swallowed). Landed as `be00abe` (feat:
  context menu -> CompareView, both git-core FR-181–185 and UI FR-186–196), merged at `6573554`,
  documented in DESIGN.md at `696bc9f`. Compare-commits-specific tests: 50/50 passing
  (`App.compareCommits.e2e.test.tsx`, `CompareView.test.tsx`, `useCompare.test.ts`,
  `CommitGraph.test.tsx`).

## V1.5

- **Auto-stash**, opt-in setting, default off. only if product manager think we need it

## Floaters — no dependencies, slot in wherever there's a gap

- Stash visualization polish.
- Keyboard shortcuts / command palette — this is also the fix for the top toolbar being
  overcrowded: fewer default-visible icons, more shortcut-driven actions instead.
- **Drag one commit node onto another to get a contextual action menu** (idea from the user,
  2026-09-06, raised while product-manager was mid-UX-review of `specs/compare-commits.md`).
  Instead of today's per-feature entry points (multi-select + right-click for compare/cherry-pick),
  drag commit A's node onto commit B's node in the graph and get a menu of every operation valid
  between exactly those two commits — compare, cherry-pick, and potentially (later) merge/
  rebase-onto. Directly relevant to compare-commits' own discoverability question: the spec's
  "select 2, then remember to right-click" entry point requires already knowing the trick exists,
  whereas dragging one node onto another is a much more self-evident gesture. Related to, but
  broader than, `specs/commit-graph.md`'s existing non-goal note ("graph-driven history editing —
  drag-and-drop interactive rebase, drag-to-reorder, drag-to-merge... scoped separately") — that
  note only anticipated drag-to-*edit* history, not drag-as-a-general-action-picker between two
  arbitrary commits. Not yet scoped; needs product-manager to decide whether this should actually
  become compare-commits' entry point now, or ship as its own later unification once more
  two-commit operations exist.

## Image diff preview (done)

Shipped. Before/after rendering for changed `.png`/`.ico`/`.jpg`/`.jpeg`/`.gif`/`.bmp`/`.svg`
files in `DiffView`, replacing the generic "Binary file — content not shown." message for those
extensions. Spec: `specs/image-diff-preview.md` (FR-139–FR-147, all implemented). Landed as:
`2bfc3da` (PRD), `934e1e6` (git-core: image blob diff reading, FR-139–143), `627d53e` (desktop:
image diff rendering, FR-144–147), `666123d` (regression tests against the spec's acceptance
criteria), `ccf994d` (bugfix: aligned image-eligibility with git-core's own `path.extname`
semantics).

## V2

- **Reset to here.** Destructive — needs a confirmation UI first, and should default to a
  non-destructive form (soft reset, or "create a branch at this commit") rather than hard reset,
  with reflog-based recovery surfaced so it never feels like data actually vanished.
- **Online connection (push/pull).** The biggest single item here — real auth/credential
  handling and network surface, the heaviest security-reviewer involvement of anything on this
  list. Treat it as the headline V2 deliverable, not one row among several.

## Documentation cleanup — done

v1 shipped in full (cherry-pick + blame both landed). All three items below are complete:

- `CLAUDE.md`'s Status section is trimmed to a short "v1 shipped in full" pointer at `specs/`
  and this file, rather than a growing per-feature narrative.
- `specs/*.md` and `DESIGN.md` were left exactly where they are — no reorganizing, since they're
  cross-referenced by path throughout (`commit-graph.md FR-15` etc.).
- A "Known pitfalls" section now lives in `CLAUDE.md`, with the selection-ring bug as its first
  (and so far only) entry.
