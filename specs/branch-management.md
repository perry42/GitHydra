# PRD: Branch Management (Create / Switch / Delete)

Status: draft — next in v1 build order after stage/unstage + diff
Owner: product-manager
Priority: P0 — third feature in the v1 build order (`PRODUCT.md`, `CLAUDE.md`)

Builds on the shipped commit graph (`specs/commit-graph.md`): FR-16 already stubbed a
context-menu extension point on commit nodes with disabled "Checkout" / "Create branch here"
items and explicitly deferred their git semantics to "the branch-management ... spec[s]" — this
spec is that spec. It also extends `refs.ts`'s read-only ref listing (used today only to
decorate the graph) with the first ref-*mutating* operations in the app.

**Sequencing:** this is primarily new git logic — `packages/git-core` currently has zero
branch-mutation functions (`refs.ts` only lists refs). **git-core-engineer builds first**
(create/switch/delete plumbing, typed errors, worktree cross-checks); **ui-graphics builds
second**, against those return shapes, wiring the new Branches panel and the graph's existing
context-menu/ref-chip stubs to it.

## Problem

A developer can see branch tips on the commit graph (`commit-graph.md` FR-11) but cannot create,
switch, or delete a branch from GitHydra at all — every one of those requires dropping to a
terminal. Branch create/switch/delete is the third-most-frequent git workflow behind viewing
history and staging/committing (`PRODUCT.md`'s v1 priority order), and today the app is entirely
read-only with respect to refs.

## Target user

Same as prior specs: a developer working day-to-day against a local-only repo, a
GitHub/GitLab/Bitbucket/self-hosted remote, or no remote at all — including bare repos (branch
refs can still be managed with no working tree), repos with hundreds of branches, worktrees
(where a branch may already be checked out elsewhere), and repos in a mid-merge/rebase/detached-
HEAD state.

## Must-have behavior

### Data & git semantics (git-core-engineer) — extends `packages/git-core`

- FR-33: New `listBranches()`: local branches with name, tip commit SHA + tip subject/author/
  committer-date (via a single batched `for-each-ref` call — extending the format string
  approach `refs.ts` already uses, not N+1 lookups per branch), whether it is the current branch,
  whether it is checked out in a *different* worktree (cross-referenced against
  `git worktree list --porcelain`), its configured upstream ref name if any, and ahead/behind
  counts vs that upstream computed locally (`rev-list --left-right --count` or equivalent)
  against whatever remote-tracking ref is already present on disk. This is read-only, additive,
  and does not modify the existing `listRefs()` used by the graph (avoid regressing shipped
  behavior).
- FR-34: New `listRemoteBranches()` (or a bucket on the same result): remote-tracking branches
  grouped by remote name, for use as create-branch start points and as switch/checkout-to-track
  targets. Read-only, reuses `refs.ts`'s existing remote-branch classification.
- FR-35: Create a new local branch (`git branch <name> [<start-point>]`). `start-point` may be
  omitted (defaults to HEAD), or be a local branch, remote-tracking branch, tag, or raw commit
  SHA — including a SHA supplied by the graph's "Create branch here" context-menu action
  (`commit-graph.md` FR-16). Validate the name with `git check-ref-format --branch <name>` first
  and return a typed, specific error before attempting the mutating call (mirrors FR-25's
  "typed error, not a crash" pattern).
- FR-36: Create-and-switch as one atomic call (`git switch -c <name> [<start-point>]`) when the
  caller asks to switch immediately, rather than two separate git invocations.
- FR-37: Creating a local branch whose start point is an existing remote-tracking branch wires
  tracking (`--track`, or relying on git's DWIM when the start point is exactly one remote's
  branch of that short name) so ahead/behind and `git status` are correct immediately afterward —
  the "check out a coworker's already-fetched branch" workflow. No network call: it only uses
  remote-tracking refs already present from whatever fetch happened outside GitHydra.
- FR-38: Switch the current worktree's HEAD to an existing local branch via `git switch <branch>`
  (not `git checkout`, to avoid the branch-name/path ambiguity `git switch` was introduced to
  remove — consistent with FR-23/24's precedent of preferring unambiguous modern porcelain).
  Must not force-discard or auto-stash uncommitted changes; if git refuses because the switch
  would overwrite local modifications, surface git's actual reason/file list to the caller rather
  than swallowing it or working around it.
- FR-39: Detached-HEAD checkout of an arbitrary commit-ish (`git switch --detach <commit-ish>`) —
  the git behavior behind the graph's existing "Checkout" context-menu stub (`commit-graph.md`
  FR-16), for checking out a commit that isn't a branch tip.
- FR-40: Delete a local branch, safe mode (`git branch -d <name>`). If git refuses because the
  branch isn't fully merged, return a specific, typed "not fully merged" error (distinguishable
  from other failure reasons) rather than raw stderr, so the UI can offer an explicit escalation.
- FR-41: Force-delete a local branch (`git branch -D <name>`) as its own explicitly-named,
  separately-exported method — distinct from FR-40 the same way `discardTrackedFileChanges` is
  kept separate from `unstageFile` in `staging.ts`, so the UI cannot reach it via the same code
  path as a normal delete by accident.
- FR-42: Deleting the currently-checked-out branch, or a branch checked out in a different
  worktree, is rejected by git itself — surface that specific reason (naming the conflicting
  worktree path when git's own output provides it) rather than crashing or no-op'ing silently.
- FR-43: `git switch` and the worktree cross-check in FR-33/FR-42 consult working-tree/index
  state and repo-local config the same way `status`/`add`/`restore` do — route them through
  `withFsmonitorNeutralized()` (`gitProcess.ts`) the same as every other working-tree-touching
  call, closing off the same category of hook-execution gap security-reviewer already found once
  on the stage/unstage work (see `AGENTS.md`, "Where things stand"). `git branch` create/delete
  do not touch the working tree and do not need this guard.
- FR-44: All mutating calls use argv arrays only, `shell: false`; branch names and start-points
  are passed through `withEndOfOptions()` (`gitProcess.ts`) before being appended to argv, exactly
  as the module's existing doc comment requires for any user/repo-controlled revision-like string
  — this is the concrete reason the git ≥2.24 floor exists.
- FR-45: None of FR-33–FR-42 make a network call (no `fetch`/`push`/`pull`), and all behave
  identically regardless of remote host or absence of one — same guarantee as FR-26.
- FR-46: Rename — not built this pass (see Non-goals).

### Rendering & interaction (ui-graphics) — `packages/desktop`

- FR-47: A Branches panel (new; ui-graphics's call on exact placement/chrome, consistent with
  `DESIGN.md`) lists all local branches and remote-tracking branches (grouped by remote),
  **independent of the graph's current ref-filter state** (`commit-graph.md` FR-15) — a branch
  hidden by the graph's default filter must still be reachable here, since switching only to
  branches currently visible on a filtered graph would silently break on exactly the ref-heavy
  repos FR-15 was written for.
- FR-48: Each local branch row shows: name, current-branch indicator, upstream name + ahead/
  behind counts when available (FR-33), last-commit subject/author/date, and a distinct
  "checked out in another worktree" indicator (shown as a disabled switch control with a reason,
  not hidden).
- FR-49: A "New Branch" action opens a dialog: name field (validated client-side against FR-35's
  `check-ref-format` result before submitting), a start-point picker defaulting to current HEAD
  and selectable to any local/remote branch, tag, or the graph's currently-selected commit, and a
  "switch to new branch" checkbox — checked by default when a working tree exists, hidden/
  disabled on a bare repo (FR-36 requires a worktree to switch into).
- FR-50: A search/filter box in the Branches panel (name substring) — same legibility principle
  as `commit-graph.md` FR-15/FR-7, needed for repos with hundreds of branches.
- FR-51: A "Checkout"/switch control on a non-current local branch row calls FR-38; on git's
  refusal (uncommitted-changes conflict, in-progress operation, or checked out elsewhere), show
  the actual reason, not a generic failure message.
- FR-52: Delete on a local branch row opens the existing `ConfirmDialog` component
  (`destructive: true`), naming the branch, and calls FR-40 on confirm. If FR-40 fails
  specifically with the "not fully merged" typed error, show a **second**, more severe
  confirmation (naming the branch again, with explicit "commits on this branch may become
  unreachable" wording) before calling FR-41 — never a single click straight to force-delete.
- FR-53: Checking out a remote-tracking branch (via the picker in FR-49, or a direct "Checkout"
  control on a remote-branch row — ui-graphics's call which affordance(s) to expose) routes to
  FR-37, not a plain FR-35 create with no tracking wired up.
- FR-54: The graph's existing context-menu stubs (`commit-graph.md` FR-16) are wired up:
  "Checkout" on a commit → FR-39 (detached HEAD); "Create branch here" → opens FR-49's dialog
  pre-filled with that commit as the start point.
- FR-55: A ref chip on the graph representing a local branch gets a right-click menu with
  Checkout and Delete (Rename excluded — see Non-goals), equivalent to but not required to
  duplicate every affordance of the Branches panel — users expect to act on the label they're
  already looking at, not only via a separate panel.
- FR-56: After any successful create/switch/delete: refresh the current-branch indicator
  everywhere it appears (Toolbar, ref chips, Branches panel), the graph's HEAD/current-branch
  decoration (`commit-graph.md` FR-17), and the Branches panel list — no restart required, same
  standard `commit-graph.md` FR-6 already set.
- FR-57: Ahead/behind counts and upstream names are visibly captioned as reflecting the
  last-known local state of the remote-tracking ref (e.g. a tooltip: "as of last fetch"), since
  GitHydra makes no network calls and cannot know if the remote has moved since a fetch performed
  outside the app. This sets correct expectations without implying live sync.

### Edge cases & constraints

Bare repo (Branches panel and create/delete work — `git branch` needs no working tree; switch/
checkout controls disabled with an explanation, since there's no working tree to switch into);
unborn HEAD / zero-commit repo (no start-point commit exists yet — "New Branch" reflects this,
disabled or explicit message, matching `commit-graph.md`'s empty-repo handling); detached HEAD
(Branches panel shows no branch as current; "Create branch here" from the currently-checked-out
commit, FR-39+FR-49 composed, is the natural way back to a named branch — no new mechanism
needed); worktrees (switching to or deleting a branch checked out in a different worktree is
rejected by git and surfaced verbatim, FR-42, never silently retried or forced); mid-merge/
rebase/cherry-pick/bisect (switch is expected to fail — git's own behavior, surfaced not worked
around; create/delete still function since they don't touch the working tree); hundreds of
branches (FR-50's search plus FR-33/34's single batched calls, not N+1, keep this responsive);
non-ASCII/unusual-but-valid branch names round-trip correctly; genuinely invalid names are
rejected by FR-35's `check-ref-format` check before any mutating call is attempted.

## Non-goals (v1)

- **Rename (`git branch -m`).** Deferred as a fast-follow, not dropped. Reasoning: not named in
  `PRODUCT.md`/`CLAUDE.md`'s explicit "branch create/switch/delete" v1 line item; it's a single
  git call with no new data model once this spec's plumbing exists, so it's cheap to add later;
  and holding it out keeps this first pass scoped to the three operations actually prioritized.
- **Deleting a branch on the remote host** (`git push origin --delete <branch>`), and **any
  push/pull/fetch triggered by a branch operation** — no auto-set-upstream-via-network on create,
  no auto-fetch to refresh ahead/behind counts. Push/pull isn't in `PRODUCT.md`'s v1 priority
  list at all yet; branch management must not quietly introduce networked git as a side effect of
  a supposedly-local feature. A future push/pull spec, if built, is separate and every network
  call in it must be an explicit user action.
- **Pruning/deleting remote-tracking refs** (`git branch -d -r`, `git remote prune`). This
  naturally pairs with `fetch --prune`, which doesn't exist in the app yet — deferred with it,
  not solved here as a standalone action.
- **Branch protection rules, required reviewers, or any host-specific policy.** These are
  GitHub/GitLab/Bitbucket server-side concepts, not local git state — permanently out of scope
  for a host-agnostic tool, not merely deferred.
- **Auto-stash-and-pop around a switch**, or any other interactive-rebase/merge-like convenience
  layered on top of FR-38. Git's own uncommitted-changes-conflict behavior is surfaced as-is; a
  stash-aware convenience overlaps the separate, later-priority stash spec.
- **Nested/hierarchical branch folders** in the Branches panel (e.g. treating `feature/x` as a
  tree node) beyond flat list + search + remote-name grouping (FR-47). A tree view is a possible
  v2 polish item.
- **Branch list drag-and-drop, favoriting/pinning, or per-branch color-coding.**
- **Telemetry on branch usage.** None, by default, per product principles.

## Acceptance criteria

1. Creating a branch from HEAD with a valid name creates a real local branch pointing at HEAD's
   commit (verified via `git rev-parse <name>` equals `git rev-parse HEAD`), with "switch to new
   branch" unchecked leaving HEAD unmoved.
2. Using the graph's "Create branch here" on a non-HEAD commit, then confirming, creates a
   branch pointing at exactly that commit's SHA — verified via `git rev-parse <name>`.
3. Creating a branch with "switch to new branch" checked both creates the branch and moves HEAD
   to it in one action — verified via `git symbolic-ref --short HEAD`.
4. Creating a branch from an existing remote-tracking branch (e.g. `origin/feature-x`) as the
   start point results in a local branch whose upstream is that remote branch — verified via
   `git rev-parse --abbrev-ref <name>@{u}` — with zero outbound network requests during the
   entire operation.
5. Attempting to create a branch with an invalid name (e.g. containing a space or a trailing
   `.lock`) is rejected with a specific error before any `git branch` call is attempted (no
   partial/corrupt ref left behind).
6. Switching to an existing local branch with a clean working tree moves HEAD to that branch —
   verified via `git symbolic-ref --short HEAD` — and the graph's current-branch decoration and
   Toolbar update without an app restart.
7. Switching to a branch while the working tree has changes that would be overwritten is
   rejected, and the UI surfaces git's real reason/file list rather than a generic error or a
   silent forced switch; the working tree and index are unchanged afterward.
8. Deleting a fully-merged local branch (not current, not checked out elsewhere) after a single
   confirmation removes it — verified via `git branch --list` no longer showing it.
9. Deleting a local branch with unmerged commits is rejected by the safe-delete path; the UI then
   offers a second, distinctly-worded confirmation, and only after that second confirmation is
   force-delete performed and the branch actually removed. Canceling either confirmation step
   leaves the branch untouched.
10. Attempting to delete the currently-checked-out branch, or a branch checked out in a different
    worktree, shows the specific git-provided reason and does not delete the branch or crash.
11. On a bare repository, the Branches panel lists branches and create/delete succeed with no
    working tree required; every switch/checkout control is disabled with an explanation instead
    of erroring when clicked.
12. On a freshly-initialized repo with zero commits (unborn HEAD), "New Branch" reflects that
    there is no start-point commit yet (disabled or explicit message), not a crash or a branch
    pointing at nothing.
13. In a detached-HEAD state, the Branches panel shows no branch as current, and "Create branch
    here" from the checked-out commit produces a branch pointing at that exact commit.
14. Ahead/behind counts and upstream name display for a branch with a configured upstream, are
    captioned as reflecting last-known state (not live), and never trigger a `fetch`/`pull`
    network call to compute or refresh.
15. Right-clicking a local branch's ref chip on the graph offers Checkout and Delete, and both
    behave identically to the equivalent Branches-panel controls (AC6, AC8/AC9).
16. In a repo with 300+ local and remote branches, typing in the Branches panel's search box
    narrows the list responsively (no dropped frames/hang), and the underlying data fetch is a
    small constant number of git invocations, not one per branch.
17. Zero outbound network requests occur during a full create → switch → delete flow (including
    the unmerged → force-delete escalation) on a repo with a remote configured.
18. The same create → switch → delete sequence behaves identically on repos cloned from GitHub,
    GitLab, Bitbucket, a self-hosted remote, and a purely local repo with no remote — host has
    zero effect.
