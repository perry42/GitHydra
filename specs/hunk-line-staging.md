# Hunk and line staging

Status: draft. Owner: product-manager. Extends `specs/stage-unstage-diff.md` (lifts its non-goal "Hunk- or line-level partial staging"; FR-19 to FR-32 otherwise unchanged).

## Problem
The diff pane is read-only and stages whole files only. A developer who edited a file for two unrelated reasons cannot commit them separately without leaving for `git add -p`. GitKraken, Fork and Sourcetree all offer per-hunk and per-line staging.

## Target user
Any working git user on any repo or host, committing atomic changes from a mixed working tree.

## Must-have behavior
- **FR-448 (git-core):** Expose operations on a file's current diff: stage, unstage, or discard a selection, where a selection is whole hunks or individual changed lines within hunks.
  - Stage works from the unstaged diff (worktree vs index).
  - Unstage works from the staged diff (index vs HEAD).
  - Discard is available from the unstaged diff only.
- **FR-449 (stale guard):** Each diff the UI shows carries a fingerprint (hash of the diff bytes). Every operation sends that fingerprint plus the selection. git-core re-reads the file's diff, recomputes the fingerprint, and on mismatch refuses with a typed `STALE_DIFF` error and changes nothing. A selection is never re-mapped onto a different diff.
- **FR-450 (patch build):** The patch is built from git's raw diff output, never re-serialized from UI strings. Unselected `+` lines are dropped; unselected `-` lines become context; hunk headers are recounted; `\ No newline at end of file` markers stay attached to their line; CRLF and other bytes are preserved exactly.
- **FR-451 (apply):** Stage: `git apply --cached` with the patch on stdin. Unstage: `git apply --cached --reverse`. Discard: `git apply --reverse` with no `--cached`. Argv arrays only, path containment, fsmonitor neutralized (same conventions as `staging.ts`). No `--3way` and no fuzz: if context does not match, git refuses and the error is surfaced.
- **FR-452 (eligibility):** Partial controls appear only for modified tracked text files. These stay whole-file-only, with the existing controls unchanged: untracked, added, deleted, renamed/copied, type-change or mode-only changes; binary, image, too-large, submodule and conflicted files; files whose diff is not valid UTF-8.
- **FR-453 (UI):** Each hunk offers Stage hunk / Unstage hunk (per the diff's side) and, on the unstaged side, Discard hunk, inline in the hunk's header row (Stage/Unstage always visible; Discard visible on hover/focus only, positioned away from Stage). Individual changed lines are selected by click-drag or shift-click on the line-number gutter, with a visible hover handle, a gutter tooltip and a dismissible hint line under the file name. When lines are selected, the selection actions ("N selected", Stage/Unstage N lines, Discard N lines, clear) appear in that hunk's sticky header, never as an overlay on the rows; a right-click menu offers the same actions. Selection changes and results are announced via an aria-live region, and focus returns to the nearest changed line after an action. (Revised after the Impeccable critique: replaces the original floating bar at the selection.)
- **FR-454 (after action):** The diff reloads in place with scroll preserved, and the file list updates (a partially staged file appears in both Staged and Unstaged, per FR-19). On failure, show git's error and revert any optimistic state (FR-30). On `STALE_DIFF`, show "File changed. Diff reloaded." and reload the diff; the user re-selects. Never auto-retry.
- **FR-455 (discard safety):** Discard hunk or lines requires confirmation naming the file and the number of hunks/lines, and stating it is unrecoverable (extends FR-31). No single-click destructive path.
- **FR-456:** No network, no hooks executed, identical on every host, including worktrees.

## Non-goals
- Partial staging for untracked/new/deleted/renamed files (whole-file controls remain).
- Staging from historical-commit diffs.
- Conflicted files (conflict-resolution UI owns them).
- Word-level or intra-line staging.
- Undo of a discard.
- A Command Palette entry (per-target actions are excluded by `CLAUDE.md`'s convention).
- Splitting a hunk into smaller hunks (line selection covers that need).

## Acceptance criteria
1. A file with 3 hunks: staging hunk 2 puts exactly hunk 2 in the index (`git diff --cached` shows only it), leaves the worktree byte-identical, and the file appears in both Staged and Unstaged.
2. Selecting 2 of 5 changed lines in a hunk and staging leaves the index with exactly those 2 lines (+/- mix, including an unselected `-` line correctly kept as context).
3. Unstage hunk and unstage lines are the exact inverse of criteria 1 and 2, verified via `git diff --cached`.
4. Stale guard: after the diff is displayed, edit the file externally, then click Stage hunk. Nothing changes in the index, the user sees "File changed. Diff reloaded.", and the diff now shows the new content.
5. Stale guard at apply: change the file between the fingerprint check and apply (injected). `git apply` refuses, the error surfaces, and the index is unchanged.
6. CRLF file: staged lines keep `\r\n` byte-exact. A file with no trailing newline: staging the last line or hunk yields a correct index with the marker preserved. Verified by byte comparison.
7. Non-UTF-8, binary, image, renamed, deleted, untracked and conflicted files show no hunk/line controls. Whole-file controls still work.
8. Discard hunk: a confirmation names the file and count. Cancel changes nothing. Confirm restores only those lines in the worktree, and the index is untouched, including when the file also has staged changes.
9. Scroll position in the diff pane is unchanged after a successful hunk action.
10. Zero network requests. Identical behavior on GitHub-, GitLab-, Bitbucket-, self-hosted-cloned and no-remote repos, and in a linked worktree.
11. A failed apply (for example a locked index) surfaces git's message and leaves the UI consistent with `git status --porcelain`.
