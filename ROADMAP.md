# ROADMAP — post-v1

Status: v1 core is fully shipped (see `CLAUDE.md`) — commit graph, stage/unstage + diff, branch
management, merge/rebase + conflict resolution UI, stash, cherry-pick, and blame & file history.
Everything below is queued for after v1 core.

This file is intake from a planning session — the raw asks and bug reports as discussed,
not formal specs. product-manager should read it and turn each item into a proper spec
(problem/acceptance-criteria, FR numbers, the works) the same way it has for every prior
feature — same as `AGENTS.md`'s existing spec-first workflow, nothing new here.

## Licensing decision (queued — not yet finalized)

Discussed during a naming/branding pass on the app icon (see `oss-licensing-guardrails` skill).
Not resolved yet — recorded here so it isn't re-litigated from scratch later.

- **License: leaning GPL-3.0, biased toward "always free."** User's stated priority is that
  GitHydra and any fork of it stay free/open forever, not maximizing commercial adoption — that
  points at GPL-3.0 (copyleft: anyone distributing a modified version must open-source their
  changes too) over MIT/Apache-2.0. AGPL-3.0's extra network-use clause doesn't add much here
  since this is a local desktop app, not a hosted service — revisit only if V2's "Online
  connection (push/pull)" item ever grows a hosted/server component. Not yet finalized: still
  needs an explicit final decision + the actual `LICENSE` file + SPDX headers before public
  release (`package.json` currently says `UNLICENSED`).
- **Dependency check: no blockers.** All current dependencies across the three `package.json`
  files (root, `packages/desktop`, `packages/git-core`) are permissively licensed (MIT/Apache-2.0:
  React, React DOM, Electron, Vite, TypeScript, Vitest, Playwright, Testing Library, jsdom) —
  none are copyleft, so none restrict which license GitHydra itself can use. `git-core` also
  shells out to the system `git` CLI rather than embedding `libgit2` (see
  `docs/tech-decisions.md`), which as a side effect avoids statically linking any GPL code.
- **README non-affiliation disclaimer — deferred, not decided against.** Discussed and
  deliberately held: project isn't public yet (no license chosen, not released), and user was
  wary of naming a competitor by name in a disclaimer (fear of the opposite effect — inviting
  scrutiny/comparison rather than deflecting it). Revisit alongside the final license decision,
  not before.

## Release pipeline (queued — the actual gap once packaging lands)

Separate from — and downstream of — the electron-builder work currently in progress via
ui-graphics (app icon set + `electron-builder.yml`, `packages/desktop/electron-builder.yml`,
`publish: null`). That work makes `npm run package` produce a Windows NSIS `.exe`, a macOS
`.dmg`, and a Linux AppImage/`.deb` **on the machine that ran it** — nothing hosts or publishes
those files anywhere a real user could download them. Until this item, GitHydra has never had a
way to get an installer in front of anyone who isn't building from source.

- **GitHub Actions workflow, triggered on a version tag (e.g. `v1.0.0`)** — matrix-build across
  windows-latest/macos-latest/ubuntu-latest runners, run `electron-builder` on each, upload the
  resulting installers as assets on a GitHub Release. This is the standard free distribution path
  for an OSS Electron project and needs no separate hosting or backend — consistent with the "no
  proprietary sync layer" principle, since it's pure CI infrastructure, not something the running
  app talks to or depends on.
- **Placement: right after the licensing decision, ahead of Design pass 2 and everything below
  it.** Both this and licensing are "makes v1 an actual public release, not just something
  runnable from a git clone" gates, not user-facing feature work — and shipping installers before
  a `LICENSE` file exists is backwards for an OSS project, so treat the two as adjacent, roughly
  sequenced (license decision should land first or alongside, not after installers are already
  circulating).
- **Depends on the in-progress electron-builder work landing first** (icon set +
  `electron-builder.yml`) — the workflow's actual build step is close to "run the same `package`
  script a contributor would run locally," so it can be spec'd now and wired up as soon as that
  lands, not blocked on a long lead time of its own.
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

## Open bug — repo-open spinner gives no feedback on a slow/failing folder pick (queued)

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

## Design pass 2 — branch/tag label gutter (queued)

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

- **Repo list.** Persist the set of repos the app knows about so opening one doesn't mean
  re-browsing the filesystem every time — also incidentally fixes the same repo getting opened
  in two tabs by accident. See the "repo-open spinner gives no feedback" open bug above for a
  case this needs to handle: a persisted path that's no longer a valid repo.
- **Remember last search/filter per repo.**
- **Remember last-selected file within a tab.** Today a tab remembers its selected commit and
  which right panel is open, but not which specific file was selected inside the Changes/
  DetailPanel file list — add that to the same per-tab persisted state.
- **Amend last commit.** Already flagged as an easy fast-follow in `stage-unstage-diff.md`'s
  non-goals — promote it, it's common enough to not leave indefinitely deferred.
- **Compare two commits directly.** Shift/ctrl-click a second commit in the graph, reuse the
  existing `DiffView`/`diff.ts` against those two arbitrary SHAs instead of one commit + its
  parent — cheap, since the diff renderer already exists.

## V1.5

- **Auto-stash**, opt-in setting, default off. only if product manager think we need it

## Floaters — no dependencies, slot in wherever there's a gap

- Stash visualization polish.
- Keyboard shortcuts / command palette — this is also the fix for the top toolbar being
  overcrowded: fewer default-visible icons, more shortcut-driven actions instead.

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
