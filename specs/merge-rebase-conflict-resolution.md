# PRD: Merge/Rebase Conflict Resolution — Product/UX Risk Review

Status: draft — pre-implementation risk review, stage 4 of the v1 build order (`PRODUCT.md`, `CLAUDE.md`), ahead of merge/rebase + conflict resolution UI
Owner: product-manager
Priority: P0 — fourth feature in the v1 build order, immediately after branch management (shipped)

Builds on `RepositoryState.inProgressOperation` (`packages/git-core/src/types.ts:57`, computed by `detectInProgressOperation()` in `packages/git-core/src/repository.ts:75`) and `WorkingDirectoryChanges.conflicted` (`packages/git-core/src/types.ts:181`, already its own category, sourced live from `git status` rather than derived from `inProgressOperation` — see the doc comment at `types.ts:174-180`). Both already exist and are correctly worktree-scoped (`gitDir` is per-worktree, not `commonGitDir`) — this spec does not re-derive that detection, it extends it. It also intentionally reopens one shipped decision: `stage-unstage-diff.md`'s Conflicted rows are currently non-interactive labels with "no diff" (confirmed in `DESIGN.md`'s ChangesPanel section) — that was correct scoping *then* ("Interactive conflict-resolution UI" was that spec's explicit non-goal, deferred to "the separate merge/rebase spec, next-but-one in priority order" — that spec is this one).

## Problem

Git's own mid-merge/mid-rebase UX is a well-known trust hazard even for experienced users: it's easy to lose track of *which* operation is in progress, misread "ours" vs "theirs" (the meaning inverts between merge and rebase), run `git add` on a file that still has literal conflict markers in it (git does not validate this — it silently accepts the file as resolved), or hit `--abort` after it's too late to cleanly undo. A visual client's entire value proposition here is answering three questions a raw `git status` output does not answer clearly: *what state am I in, what exactly am I resolving, and can I safely get out.* If GitHydra gets any of these three wrong — or is silent where git itself is silent (the `git add`-with-markers-still-present case) — it actively makes conflict resolution *more* dangerous than the terminal, not less, which breaks the tool's core trust proposition for the single scariest workflow a git GUI handles.

## Target user

Same as every prior spec: a developer working day-to-day against local-only, GitHub/GitLab/Bitbucket/self-hosted, or no-remote repos, including worktrees (operation state is per-worktree), submodules, repos with binary assets, and repos where a merge/rebase/cherry-pick/revert may have been *started outside GitHydra* (a terminal, a script, a teammate's hook) — GitHydra must correctly detect and resolve a conflict it did not itself initiate, not only one started from its own UI.

## Must-have behavior

### 1. In-progress state detection & disambiguation

- FR-58: Extend the existing `InProgressOperation` detection into a richer per-operation detail object (git-core-engineer's exact shape): for **merge** — `MERGE_HEAD` SHA/subject and, when resolvable, the ref name that was being merged (from `MERGE_MSG`); for **rebase** — the original branch name (`rebase-merge/head-name` / `rebase-apply`'s equivalent), the "onto" ref/SHA, and current-step/total-step numbers (`rebase-merge/msgnum` + `rebase-merge/end`, or the `rebase-apply` equivalents); for **cherry-pick**/**revert** — the target commit's SHA + subject. Read-only, no new mutating calls.
- FR-59: **Close the watcher's documented gap.** `watchRepositoryRefs()` (`packages/git-core/src/watcher.ts:26`) explicitly does not watch `MERGE_HEAD`/`rebase-merge/`/etc. today ("a mid-rebase state change won't trigger an automatic refresh in this version"). This spec requires that gap closed: the operation-state files (`MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `rebase-merge/`, `rebase-apply/`) must be watched so that starting, continuing, or aborting an operation from a terminal alongside an open GitHydra window triggers an automatic refresh — this is the single most likely source of "GitHydra is showing something stale I can't trust" during exactly the workflow this feature exists for.
- FR-60: A persistent, non-dismissible banner (app chrome, not buried in a panel) whenever `inProgressOperation !== null`, naming the specific operation with the FR-58 detail (e.g. "Rebasing `feature-x` onto `main` — step 2 of 5", "Merging `origin/main` into `feature-x`", "Cherry-picking `a1b2c3d` 'Fix off-by-one'"). Must be visible regardless of which panel (Changes/Branches/DetailPanel) is currently open, and must disappear only when git's own on-disk state says the operation ended — never a client-side "dismiss."
- FR-61: **Ours/theirs is not one fixed mapping — it must be computed per operation type, and labeled with names, not the bare words "ours"/"theirs."** Merge: "ours" = current branch/HEAD, "theirs" = the incoming ref. Rebase: git replays commits with roles *inverted* from a merge — the target ("onto") is `--ours` and the commit being replayed (the user's own original work) is `--theirs`. Cherry-pick/revert: "ours" = current HEAD, "theirs" = the commit being applied/reverted. The UI must always show a concrete label sourced from FR-58/FR-59's detail (e.g. "Your branch (`feature-x` @ `a1b2c3`)" / "Incoming (`main` @ `d4e5f6`)") rather than raw "ours"/"theirs," and the underlying stage (2 vs 3) that maps to "your branch" must be selected correctly per operation kind so the label is never backwards during a rebase.

### 2. Conflict resolution clarity

- FR-62: Conflicted-file count and per-file conflict content are always sourced live from git's index stages (`git show :1:<path>` / `:2:<path>` / `:3:<path>`) and the working-tree file content — never cached client state that could drift from git's actual index.
- FR-63: Each conflicted path is classified by which index stages are present into: both-modified (normal three-way text conflict), added-by-us/added-by-them (add/add, no common-ancestor stage), deleted-by-us/deleted-by-them (delete/modify — no textual diff on the deleted side), rename conflict (both sides' old→new path shown explicitly), and binary. Classification drives which resolution UI renders (FR-66).
- FR-64: For a text conflict, show a three-way (or two-way when a stage is absent) comparison using FR-61's labeled ours/theirs, reusing `DiffView`'s existing line-rendering conventions (monospace, tabular line numbers, good/critical add/remove tinting) rather than inventing a new visual language.
- FR-65: **Scope decision, explicit to avoid drift into a bigger build than this stage needs:** v1 resolution is **file-level**, not hunk-level. Users get: view the three-way content (FR-64), "Accept Ours" / "Accept Theirs" (whole file), "Open in external editor," and "Mark as resolved" once no conflict markers remain. An inline, hunk-by-hunk pick/edit merge editor is *not* built this pass — it is a materially larger UI/text-editing surface than anything shipped so far (every existing diff surface is read-only) and file-level granularity matches the precedent `stage-unstage-diff.md` already set (hunk-level partial staging was deferred there too). See Non-goals.

### 3. Staged/unstaged state must not misrepresent resolution progress

- FR-66: **Close a real git footgun, not a hypothetical one:** `git add <path>` on a conflicted file does not validate that conflict markers are gone — git will happily mark a file "resolved" even if `<<<<<<<`/`=======`/`>>>>>>>` are still literally in it. GitHydra's "Mark as resolved" / "Accept Ours" / "Accept Theirs" actions must scan the file for those marker lines before staging; if markers remain, the action is blocked with an explicit reason ("conflict markers still present in this file"), not silently allowed through to `git add`.
- FR-67: The "N of M conflicts resolved" count (wherever shown — banner, ChangesPanel section header) is computed from `WorkingDirectoryChanges.conflicted`'s live length, never a separately-tracked "user clicked resolve" flag that could drift from git's actual state.

### 4. Abort/continue safety

- FR-68: Abort (`merge --abort` / `rebase --abort` / `cherry-pick --abort` / `revert --abort`) is offered whenever `inProgressOperation !== null`, regardless of whether any conflicts currently remain (a multi-commit rebase can be conflict-free on the current step but still mid-operation). Git's own refusal (e.g. abort attempted after a manual commit already closed the operation) is surfaced verbatim, never swallowed or silently retried.
- FR-69: `rebase --quit` is never exposed as an affordance — it leaves HEAD in the interrupted state rather than restoring the pre-rebase branch, which is the opposite of what a user reaching for "abort" expects.
- FR-70: Continue (`--continue` on whichever operation is active) is invoked without ever spawning an interactive external editor (Electron's `child_process` has no TTY to host one) — accepts git's generated commit message by default; a "customize message" step, if offered, reuses the existing commit-composer pattern (`stage-unstage-diff.md` FR-25/FR-32) as a follow-up amend, not an editor handoff.
- FR-71: Continue is client-side blocked (control disabled, with the specific blocking file(s) named) unless `WorkingDirectoryChanges.conflicted` is empty **and** FR-66's marker scan finds no leftover markers in any already-staged path — defense in depth, since git's own `--continue` refusal only catches the first condition, not the second.

### 5. Conflict file visibility in existing UI

- FR-72: ChangesPanel's Conflicted section rows (currently non-interactive labels, per shipped `stage-unstage-diff.md`/`DESIGN.md`) become clickable, opening the FR-64/65 resolution view — this spec intentionally supersedes that prior "no diff for conflicted rows" behavior. The section's live count (already an established convention — "Conflicted (3)") and the `FileStatusIcon`'s existing `unmerged`→serious-token mapping are unchanged.
- FR-73: The operation banner (FR-60) is visible at all times an operation is in progress, independent of whether the Changes panel is open — a user must not have to know to open a specific panel to discover they're mid-rebase.

### 6. Recovery safety

- FR-74: All operation/conflict state is read fresh from disk on every repo open, tab activation (per `multi-repo-tabs.md`'s lazily-active-tab architecture — reactivating a tab re-fetches rather than reusing a stale in-memory snapshot), and FR-59's watcher trigger. GitHydra holds no authoritative in-memory copy of conflict-resolution progress — git's on-disk state (`MERGE_HEAD`, index stages, marker text) *is* the state, always. A crash or force-close mid-resolution loses nothing to recover, because there was never anything to lose: relaunching and reopening the repo reconstructs the identical banner and conflicted-file list from disk.
- FR-75: Editing a conflicted file externally (a separate editor/IDE) while GitHydra is open is reflected the next time its resolution view is (re)opened or FR-59's watcher fires — never a cached diff from before the external edit.

### 7. Edge cases

- FR-76: **Worktrees.** Operation state is detected from the per-worktree `gitDir`, never `commonGitDir` (already correct in `detectInProgressOperation`) — a rebase in progress in one linked worktree must not show a banner in a different worktree/tab of the same repo.
- FR-77: **Submodules.** A conflict on a submodule's gitlink (the recorded submodule commit, not file content) is rendered as its own state — the three candidate commit SHAs (short, with subject when resolvable), not an attempted text diff — with only whole-file Accept Ours/Accept Theirs available. GitHydra never recurses into the submodule's own repository to resolve conflicts inside it (see Non-goals).
- FR-78: **Delete/modify conflicts.** Rendered with explicit "Deleted in `<side>`, modified in `<side>`" copy and Keep-file/Delete-file resolution actions — never a blank or broken diff pane.
- FR-79: **Rename conflicts** (rename/rename, rename/modify) show both sides' old→new path mapping explicitly, plus whatever textual diff content exists for the modified side(s).
- FR-80: **Binary conflicts** reuse `DiffView`'s existing "Binary file — content not shown" non-diff state (already established for FR-21) and offer only whole-file Accept Ours/Accept Theirs — no marker-based resolution path exists for binary content.

## Non-goals (this stage)

- **Hunk-by-hunk inline merge editing.** File-level resolution only (FR-65) — flagged as a fast-follow, not dropped, consistent with the same file-level-not-hunk-level precedent `stage-unstage-diff.md` already set for staging.
- **Initiating** a merge, rebase, cherry-pick, or revert from the UI (a "Merge branch X into current" or "Rebase onto Y" action). This spec covers detecting and safely resolving an operation already in progress — regardless of how it started — not starting one. Initiation is a separate follow-on spec; today a user starts these from a terminal and GitHydra must handle whatever state that leaves behind.
- **Interactive rebase** (reorder/squash/edit/drop todo-list editing). Out of scope — this spec handles the conflict-pause state of any rebase, not building the interactive-rebase planning UI.
- **Bisect.** Already typed by `InProgressOperation`, but produces no merge-style conflicts and gets no banner copy/actions in this pass.
- **Resolving conflicts inside a submodule's own repository.** A submodule pointer conflict (FR-77) is resolved at the pointer level only; the user opens the submodule path as its own repo/tab for anything deeper.
- **Any network call** as part of detect/view/resolve/abort/continue — none, per product principles; identical behavior with or without a configured remote, regardless of host.
- **Telemetry on conflict frequency, resolution choices, or abort/continue rates.** None, by default.

## Acceptance criteria

1. Opening a repo with an unresolved `git merge` in progress shows the operation banner reading "Merging" with the correct incoming ref name, and does so whether the merge was started from GitHydra or a terminal before GitHydra opened the repo.
2. Opening a repo mid-rebase shows "Rebasing `<branch>` onto `<ref>` — step N of M" with N/M matching `cat .git/rebase-merge/msgnum` / `rebase-merge/end` (or the `rebase-apply` equivalent) exactly.
3. In a merge conflict, the resolution view's "Your branch" label maps to stage-2 content and "Incoming" maps to stage-3 content; in a rebase conflict on the same underlying file pair, the labels remain correctly attributed to the user's own original commit vs. the target branch — i.e. never visibly swapped between the two operation types — verified against `git show :2:<path>` / `:3:<path>` directly.
4. Attempting "Mark as resolved" on a file that still contains a literal `<<<<<<<` marker line is blocked with an explicit reason, and no `git add` call is made (verified: `git status` still shows the path unmerged).
5. "Mark as resolved" on a file with markers fully removed succeeds, and the file moves out of the Conflicted count.
6. Clicking Continue while any conflicted file remains is disabled/blocked; after resolving all conflicted files, Continue becomes enabled and completes the operation (verified: `inProgressOperation` becomes `null` and, for a merge, `MERGE_HEAD` no longer exists).
7. Clicking Continue never launches or hangs waiting on an external editor process.
8. Clicking Abort on a mid-merge, mid-rebase (multi-commit), mid-cherry-pick, and mid-revert repo each fully restores the pre-operation branch tip, index, and working tree — verified via `git rev-parse HEAD` matching the pre-operation SHA and `git status --porcelain` showing no unmerged entries — for all four operation types.
9. A delete/modify conflict shows explicit "deleted in X / modified in Y" copy with Keep/Delete actions, not an empty or broken diff pane; a rename/rename conflict shows both sides' old→new paths; a binary conflict shows the existing "Binary file" state with only whole-file accept actions; a submodule gitlink conflict shows three candidate commit SHAs with no attempted text diff.
10. In a repo with two worktrees, starting a rebase in worktree A shows the operation banner only when worktree A's tab/session is active — worktree B's tab shows no operation in progress.
11. With GitHydra open on a mid-rebase repo, running `git rebase --continue` from a separate terminal updates GitHydra's banner/conflicted-file list without requiring a manual refresh, within the watcher's debounce window.
12. Force-closing GitHydra mid-conflict-resolution and reopening the same repo reproduces the identical operation banner and conflicted-file list as before the close, with zero data loss (nothing was held only in memory).
13. Editing a conflicted file in an external editor while its resolution view is open in GitHydra, then refocusing/reopening that view, shows the externally-edited content, not a stale cached diff.
14. Zero outbound network requests occur during a full detect → view conflict → resolve → continue flow and a full detect → abort flow, on a repo with a remote configured.
15. The same conflict-resolution flow behaves identically on repos cloned from GitHub, GitLab, Bitbucket, a self-hosted remote, and a purely local repo with no remote.

## References

- `packages/git-core/src/repository.ts` (`detectInProgressOperation`, `getRepositoryState`) — existing detection this spec extends.
- `packages/git-core/src/types.ts` (`InProgressOperation`, `RepositoryState`, `WorkingDirectoryChanges`, `WorkingDirectoryFileChange`) — existing types this spec extends.
- `packages/git-core/src/watcher.ts` — documented gap (does not watch `MERGE_HEAD`/`rebase-merge/`) that FR-59 requires closing; the biggest regression risk if skipped, since it's the difference between GitHydra reflecting reality and GitHydra silently going stale during the single riskiest workflow this feature covers.
- `packages/desktop/src/components/ChangesPanel/ChangesPanel.tsx` — shipped Conflicted-row treatment (non-interactive) that FR-72 intentionally supersedes.
- `specs/stage-unstage-diff.md`, `specs/branch-management.md`, `specs/multi-repo-tabs.md` — prior specs whose conventions (FR numbering continuation from FR-57, `DiffView`/`ConfirmDialog` reuse, per-tab lazy-reactivation architecture) this spec builds on rather than re-deciding.
