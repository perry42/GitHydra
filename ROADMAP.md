# ROADMAP — post-v1

Status: v1 core is not finished yet (cherry-pick shipped, blame spec written and queued for
implementation — see `CLAUDE.md`). Everything below is queued for after v1 core wraps.

This file is intake from a planning session — the raw asks and bug reports as discussed,
not formal specs. product-manager should read it and turn each item into a proper spec
(problem/acceptance-criteria, FR numbers, the works) the same way it has for every prior
feature — same as `AGENTS.md`'s existing spec-first workflow, nothing new here.

## Priority 0 — bug (fixed)

- **Selection ring renders on the wrong commit** when the selected row isn't the first one
  visible in the current scroll position — fixed. Root cause: `GraphCanvas.tsx`'s `<canvas>`
  element was CSS-pinned at `top: 0` while each `CommitRow` DOM element tracks scroll via inline
  `top: index * ROW_HEIGHT`, so everything the canvas drew (including the selection ring)
  rendered `startIndex * ROW_HEIGHT` pixels above the actual DOM rows once scrolled. Fix: the
  canvas element now sets the same `top: startIndex * ROW_HEIGHT`. Covered by a regression test
  (`GraphCanvas.test.tsx`) that fails without the fix and passes with it. A "known pitfalls" note
  for this is still planned per the Documentation cleanup section below, once v1 is fully done.

## Design pass — its own milestone, not folded into feature work

(Same principle as everywhere else in this project: design needs to be the main task
sometimes, not permanent background polish squeezed in around feature work.)

- **Selection vs. merge-node visual conflation.** Both a selected commit and a merge commit
  currently render as an enlarged circle — a selected merge commit is doubly ambiguous, and two
  unrelated merge commits near each other are hard to tell apart from "is one of these selected."
  Proposal: selection becomes an independent ring/halo layer drawn around whatever node is
  already there (small dot or big merge/interchange node); node size/shape continues to encode
  commit type only, never selection state.

- **Branches panel relocation + search rebuild.** Move the Branches panel to a persistent left
  sidebar (currently lives elsewhere). Wire its existing search (`branch-management.md` FR-50) to
  scroll/jump the graph to the matched branch, reusing the same jump pattern the commit filter
  already uses. Hold the rebuilt search to the responsiveness bar that spec already committed to
  (AC16: 300+ branches, no dropped frames, constant number of git calls) rather than treating
  "make it faster" as new, undefined scope.

## Tech debt — its own line item, not silently absorbed into the next feature branch

(Same principle as the design pass above: this needs a deliberate task, not another
one-off patch landed as a side effect of unrelated feature work.)

- **Consolidate the two independent working-directory-status git spawns.**
  `useChangesPanel.ts` (`getWorkingDirectoryChanges()`, `git status --porcelain=v2`, powers
  the Changes panel's per-file Staged/Unstaged/Untracked/Conflicted lists) and
  `useRepositoryGraph.ts` (`getWorkingDirStatus()`, `git status --porcelain=v1`, powers the
  Toolbar badge and StatusBanner's aggregate counts) independently fetch overlapping
  information, often within milliseconds of each other right after a conflict resolve or
  mutation settles. On Windows this occasionally collides as a transient `.git/index`
  lock error — real, reproduced, currently worked around with a one-shot retry
  (`gitHydraClient.ts`'s `withGitLockRetry`/`withGitLockRetryThrowing`, `c1adbba`/`ca231c8`
  on `feature/cherry-pick`) rather than fixed at the root. `WorkingDirectoryStatus`'s
  aggregate counts are almost certainly derivable as `.length` of
  `WorkingDirectoryChanges`'s corresponding per-file arrays — `useRepositoryGraph` (always
  mounted) should become the single owner of the full per-file fetch and derive its own
  summary counts from it; `useChangesPanel` (only mounted while the panel is open) should
  consume that shared data instead of independently re-fetching. This eliminates the
  redundant concurrent git spawn — and the whole class of lock collision it enables —
  rather than just retrying around it. Keep the retry helper as defense-in-depth, not as
  the primary fix. Low user-visible urgency (rare, Windows-specific, already mitigated) but
  cheap to do properly while both hooks are fresh in mind — don't let the workaround
  quietly become the permanent architecture.

## V1.1

- **Repo list.** Persist the set of repos the app knows about so opening one doesn't mean
  re-browsing the filesystem every time — also incidentally fixes the same repo getting opened
  in two tabs by accident.
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

## Documentation cleanup — once cherry-pick + blame ship (v1 fully done)

- Trim `CLAUDE.md`'s Status section from a growing per-feature narrative down to a short
  "v1 shipped in full" pointer at `specs/` and this file, instead of continuing to append prose
  per feature forever.
- Leave `specs/*.md` and `DESIGN.md` exactly where they are — don't reorganize or move them.
  They're cross-referenced by path throughout (`commit-graph.md FR-15` etc.); moving them breaks
  those references for no real benefit. They're a fine historical record as-is.
- Add a short "known pitfalls" note (a few sentences each, not a changelog) for the handful of
  bugs worth a specific do-not-reintroduce warning. The selection-ring bug above is the first
  candidate, once it's fixed.
