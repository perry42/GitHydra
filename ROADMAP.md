# ROADMAP — post-v1

Status: v1 core is fully shipped (see `CLAUDE.md`) — commit graph, stage/unstage + diff, branch
management, merge/rebase + conflict resolution UI, stash, cherry-pick, and blame & file history.
Everything below is queued for after v1 core.

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

## Documentation cleanup — done

v1 shipped in full (cherry-pick + blame both landed). All three items below are complete:

- `CLAUDE.md`'s Status section is trimmed to a short "v1 shipped in full" pointer at `specs/`
  and this file, rather than a growing per-feature narrative.
- `specs/*.md` and `DESIGN.md` were left exactly where they are — no reorganizing, since they're
  cross-referenced by path throughout (`commit-graph.md FR-15` etc.).
- A "Known pitfalls" section now lives in `CLAUDE.md`, with the selection-ring bug as its first
  (and so far only) entry.
