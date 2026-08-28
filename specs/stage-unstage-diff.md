# PRD: Stage/Unstage + Diff View

Status: draft — next in v1 build order after commit graph visualization
Owner: product-manager
Priority: P0 — second feature in the v1 build order (`PRODUCT.md`, `CLAUDE.md`)

Builds on the shipped commit graph (`specs/commit-graph.md`): its FR-13 explicitly deferred
file diff *content* here ("Showing the actual file diff content is out of scope for this
spec... the file list and change-type per file is in scope") and FR-18's uncommitted-changes
pseudo-node already tells the user changes exist without exposing what they are. This spec
closes both gaps and adds the actions (stage/unstage/discard/commit) that make that state
actionable.

## Problem

A developer can already see *that* the working tree has changes (FR-18's pseudo-node,
`getWorkingDirectoryStatus()`'s counts) and *that* a historical commit touched a file
(FR-13's changed-file list), but not *what changed* in either case, and has no way to act on
uncommitted changes at all — no stage, unstage, discard, or commit — without leaving GitHydra
for a terminal. That's the single most frequent git workflow (edit → review diff → stage →
commit), and today the app can't do any of it.

## Target user

Same as `specs/commit-graph.md`: a developer working day-to-day against a local-only repo,
GitHub/GitLab/Bitbucket/self-hosted remote, or no remote at all — including bare repos (no
working directory to stage against), mid-merge/mid-rebase/mid-cherry-pick repos (conflicted
paths present), and repos with untracked, binary, or very large files.

## Must-have behavior

### Data & git semantics (git-core-engineer) — extends `packages/git-core`

- FR-19: Expose a **per-file** working-directory change list (not just the summary counts
  `getWorkingDirectoryStatus()` already returns) split into Staged (index vs HEAD), Unstaged
  (worktree vs index), Untracked, and Conflicted, with each entry's status
  (added/modified/deleted/renamed/copied/type-changed) — same status vocabulary as
  `ChangedFile`. A path may appear in both Staged and Unstaged simultaneously (staged one
  edit, then edited again). Returns `null` for a bare repo, same convention as the existing
  `getWorkingDirectoryStatus()`.
- FR-20: Expose diff **content** (unified patch text with add/remove/context lines and line
  numbers) for: (a) unstaged file diff (worktree vs index), (b) staged file diff (index vs
  HEAD), (c) untracked file (shown as all-addition against empty), and (d) a historical
  commit's file diff — extending `changedFiles.ts`'s existing first-parent/empty-tree base
  selection (used for merges and root commits) from name-status-only to full patch content.
- FR-21: Report `isBinary: true` (no line-level patch) for binary files instead of attempting
  to render binary bytes as text.
- FR-22: Guard large diffs (e.g. >5,000 changed lines or file >2MB) with a truncated /
  "too large to display inline" result rather than returning unbounded data or blocking.
- FR-23: Stage (`git add --`) and unstage (`git restore --staged --`) a file, plus stage-all
  / unstage-all. Paths always passed after a literal `--`, matching `changedFiles.ts`'s
  existing convention; argv array only, `shell: false` (existing `gitProcess.ts` invariant).
- FR-24: Discard working-tree changes for a tracked file (`git restore --`) and remove a
  single untracked file (`git clean -f --` scoped to that one path — never a bare
  `git clean -fd` on the whole tree). Exposed as its own explicitly-named method, distinct
  from unstage, so the UI cannot reach it via the same code path by accident.
- FR-25: Create a commit from currently-staged content (`git commit -F -`, message piped via
  stdin — never `-m` string concatenation) with a required non-empty subject. Returns a typed
  error, not a crash, when: nothing is staged, `user.name`/`user.email` is unset, or a
  commit-msg/pre-commit hook rejects the commit (hook stderr surfaced to the caller).
- FR-26: All of the above make no network call (no `push`/`pull`/`fetch`) and behave
  identically regardless of remote host or absence of one.
- FR-27: Conflicted paths (from the existing `RepositoryState.inProgressOperation`) are
  reported as their own status category, distinguishable from a normal staged/unstaged
  change — listed, not offered a plain stage/unstage control (see Non-goals).

### Rendering & interaction (ui-graphics) — `packages/desktop`

- FR-28: A Changes panel lists Staged / Unstaged / Untracked / Conflicted files in separate
  sections with counts, using `DESIGN.md`'s status tokens (good/warning/serious/critical) and
  file-status iconography consistent with the existing commit DetailPanel's changed-file list.
- FR-29: Clicking a file — in the Changes panel, **or** in the existing commit DetailPanel's
  file list (FR-13, previously list-only) — opens a diff view: added/removed/context lines
  with line numbers, monospace per `DESIGN.md`, add/remove colored with the good/critical
  status tokens, and explicit binary / too-large states per FR-21/FR-22.
- FR-30: Per-file stage/unstage controls plus stage-all/unstage-all. Optimistic UI update is
  fine, but on a failed git call the UI must revert the optimistic state and surface the
  error rather than showing a staged/unstaged state that contradicts git's actual index.
- FR-31: Discard requires an explicit confirmation step naming the file and stating the
  change is unrecoverable before calling FR-24 — no single-click destructive path.
- FR-32: A commit composer (subject + optional body) that calls FR-25; Commit button disabled
  when there are zero staged files or an empty subject; on success, clears the composer and
  refreshes the Changes panel (and the graph, if open, since a new commit now exists).

### Edge cases & constraints

Bare repo (no Changes panel content, explicit empty state, no error); mid-merge/rebase with
conflicted files (listed, not resolvable here — see Non-goals); binary and very large files
(FR-21/FR-22); non-ASCII filenames; untracked file deleted/moved outside git before staging;
missing `user.name`/`user.email` (surfaced as an actionable error, not a crash); a
pre-commit/commit-msg hook rejecting the commit (surfaced, not swallowed); the commit always
reflects whatever is in the index at commit time (git's own behavior), so a race where the
index changes between "stage" and "commit" click cannot produce a silently-wrong commit.

## Non-goals (v1)

- **Hunk- or line-level partial staging.** File-level stage/unstage only in v1; this is the
  single largest scope item deliberately deferred — flag as a fast-follow, not silently
  dropped.
- **Amend last commit.** Simple enough to add later; kept out to hold v1 scope.
- **Interactive conflict-resolution UI.** Conflicted files are listed (FR-27/FR-28), not
  resolved here — separate merge/rebase spec, next-but-one in priority order.
- **Push/pull/fetch or any remote sync.** No network calls in this spec, per product
  principles; a future push/pull spec is separate and must be an explicit user action.
- **Stash.** Separate, lower-priority spec per the v1 order.
- **Diffing two arbitrary commits/branches ("compare" view).** This spec's diff view covers
  working-directory state and a single historical commit's file changes only (closing FR-13's
  deferred scope) — a general compare view is a future spec.
- **Telemetry on staging/commit activity.** None, by default, per product principles.

## Acceptance criteria

1. A repo with staged and unstaged changes to different files shows them in separate Staged/
   Unstaged sections with correct per-file status and counts.
2. An untracked file appears in its own Untracked section and, when clicked, shows its
   content as an all-addition diff.
3. Clicking an unstaged file shows its worktree-vs-index diff; after staging that same file,
   clicking it again shows its index-vs-HEAD diff instead — both as unified diff with line
   numbers and add/remove coloring.
4. Clicking a file in the existing commit DetailPanel's changed-file list now shows that
   file's diff content for the selected commit (closing FR-13's deferred scope).
5. Clicking Stage on an unstaged file moves it to Staged with the on-disk file unchanged;
   clicking Unstage reverses it — both verified via `git status --porcelain` before/after.
6. Stage-all / unstage-all acts on every eligible (non-conflicted) file in one action.
7. Discarding an unstaged file's changes requires confirming a dialog naming the file; after
   confirming, the file's content matches HEAD/index and it leaves the Unstaged section;
   canceling leaves the file untouched.
8. Entering a subject and clicking Commit with 1+ staged files creates a real commit
   (verified via `git log -1`), clears the composer, and the Changes panel shows zero staged
   files afterward; Commit is disabled with zero staged files or an empty subject.
9. A repo mid-merge with conflicted files shows them in a distinct Conflicted section with no
   plain stage/unstage control offered, and no crash.
10. A bare repository shows an explicit "no working directory" state for the Changes panel,
    not an error or blank panel.
11. A binary file's diff view shows a "binary file" state, not garbled content; a diff past
    the size threshold shows "too large to display" instead of hanging the UI.
12. Zero outbound network requests occur during a full stage → view diff → unstage → commit
    flow on a repo with a remote configured.
13. The same stage → view diff → unstage → commit sequence behaves identically on repos
    cloned from GitHub, GitLab, Bitbucket, a self-hosted remote, and a purely local repo with
    no remote — host has zero effect.
