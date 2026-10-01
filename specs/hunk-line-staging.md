# Hunk and line staging

Status: draft (revised: checkbox model). Owner: product-manager. Extends `specs/stage-unstage-diff.md` (lifts its non-goal "Hunk- or line-level partial staging"; FR-19 to FR-32 otherwise unchanged except as annotated there). Layout and the commit form live in `specs/changes-panel-layout.md`.

## Problem
The diff pane stages whole files only. A developer who edited a file for two unrelated reasons cannot commit them separately without leaving for `git add -p`. GitKraken, Fork and Sourcetree all offer per-hunk and per-line staging, but with select-then-act flows. A checkbox on every changed line is faster and shows what is staged at a glance.

## Target user
Any working git user on any repo or host, committing atomic changes from a mixed working tree.

## Must-have behavior
- **FR-448, FR-450, FR-451, FR-452, FR-455, FR-456** stand as shipped in git-core: stage/unstage/discard a selection of hunks or lines from the unstaged or staged diff; the patch is built from git's raw diff bytes; applied with `git apply --cached` (stage), `--cached --reverse` (unstage) or `--reverse` (discard); eligibility is modified tracked text files only; discard needs confirmation; no network or hooks.
- **FR-449 (revised, stale guard):** for an eligible file the fingerprint covers the combined view inputs: HEAD blob id, index blob id and a hash of that file's worktree bytes. Every operation sends the fingerprint plus the selection. git-core recomputes it and on mismatch refuses with `STALE_DIFF` and changes nothing. A selection is never re-mapped onto a different diff.
- **FR-453 (rewritten, checkbox model):**
  - In an eligible file's diff every changed line (+ or -) has a small grey checkbox in its own narrow column before the old/new line-number columns. Context lines have none.
  - Ticked means the line is in the index; unticked means it is not. Unticked changed lines render slightly dimmed.
  - One click toggles that single line immediately via the stage/unstage selection operations. Shift-click applies one rule to the whole range from the last-clicked line to the clicked line: tick every changed line in it unless all of them are already ticked, in which case untick them all. The keyboard (Shift+Up/Down then Space) uses the same rule.
  - No +/- glyph buttons, hover icons, select-then-act action row, floating bar, hint line or sticky-header selection actions.
  - Selection changes and results are announced via an aria-live region.
- **FR-454 (rewritten, after action):** the combined diff reloads in place with scroll and cursor preserved, and the file list updates. On failure show git's message and revert the tick (FR-30). On `STALE_DIFF` show "File changed. Diff reloaded." and reload; never auto-retry. Focus stays on the toggled row.
- **FR-477 (hunk checkbox):** each hunk header has one checkbox in the same column, directly above the line checkboxes. It is visible on hover/focus, and always visible when ticked or mixed. States: unticked / ticked (all lines staged) / mixed dash (some). Click stages the whole hunk when not all lines are staged, otherwise unstages it. Focusable, with `aria-checked` true/false/mixed.
- **FR-478 (discard):** the hunk header's right side has a red Discard, revealed on hover/focus. The right-click menu on a hunk or lines offers Stage/Unstage and Discard. Discard is never on a checkbox. The FR-455 confirmation applies (names the file and the hunk/line count; says it is unrecoverable). Discard acts on worktree-vs-index only and is offered only for unstaged changed lines.
- **FR-479 (git-core combined diff):** a new operation `getCombinedFileDiff(path)` returns HEAD-vs-worktree hunks. Each changed line carries `staged: boolean`, and the result carries the FR-449 fingerprint. Per-line state is derived by comparing HEAD->index and index->worktree using git's own diff output, never UI strings, and must be exact.
- **FR-480 (operation mapping):** a UI toggle is translated in git-core into the stage/unstage selection operations. Selections are expressed in combined-diff line ids and re-derived against index or worktree. Staging a `-` line puts the deletion in the index; unstaging a `+` line removes the addition from the index. A range is one atomic apply.
- **FR-481 (fallback rule):** git-core returns `{ mode: "separate" }` and the UI shows today's behavior unchanged (whole-file stage/unstage, separate Staged/Unstaged diffs, no checkboxes) when either holds: the file is ineligible per FR-452 (untracked, new, deleted, renamed, binary, too large, non-UTF-8, conflicted, submodule, symlink, mode-only); or the mapping is ambiguous (a line's staged status cannot be proven, alignment of repeated identical lines is not unique, or the round-trip check fails — re-applying the derived staged set to HEAD must reproduce the index bytes). Never guess. For the ambiguous case only, show a neutral one-line note: "Line-level staging unavailable for this file."
- **FR-482 (file list):** git-core's FR-19 output is unchanged: a partly staged file still reports staged and unstaged entries. In the UI, a file that git-core lists in both Staged and Unstaged with status modified collapses by default to one row in the Unstaged section with a mixed marker (half-filled box), without waiting for per-file eligibility checks; the verdict (FR-479/481) then refines it lazily, and a file found ineligible or ambiguous splits back into both sections; a fully staged eligible file stays in Staged; ineligible files stay in the separate sections. On a mixed row: Stage stages all remaining, Unstage unstages all, Discard removes the unstaged part only, with the FR-31 confirmation.
- **FR-483 (keyboard):** Up/Down moves the row cursor over changed rows only. Space toggles the cursor row. Shift+Up/Down extends a range, and Space applies the FR-453 range rule to it as one operation. Esc clears the range anchor. The hunk checkbox is a tab stop toggled with Space. Command Palette: register "Stage/Unstage current hunk" and "Discard hunk" in `getCommands()` (`packages/desktop/src/lib/commands.ts`); they act on the hunk under the cursor and are enabled only when an eligible diff is focused; Discard still opens the FR-455 confirmation.
- **FR-484 (edit-in-diff):** while edit-in-diff is active (`specs/edit-in-diff.md`) the row and hunk checkboxes are hidden and not focusable; they return on exit with the fingerprint recomputed after save.
- **FR-485 (refresh):** toggles count as self-writes under `specs/self-write-refresh-suppression.md`. A live-refresh event (`specs/live-refresh.md`) that changes any of the three fingerprint inputs while the diff is open reloads the combined diff in place, keeping scroll and cursor.

## Non-goals
- A combined view for untracked/new/deleted/renamed/ineligible files (the FR-481 fallback applies).
- Staging from historical-commit diffs.
- Word-level or intra-line staging, or splitting hunks.
- Undo of a discard; discarding staged lines.
- Select-then-act modes, floating bars, hover icons or +/- glyph buttons (rejected in the approved mock).
- Network or host-specific behavior.

## Acceptance criteria
1. A 3-hunk file: clicking the hunk-2 checkbox puts exactly hunk 2 in the index (`git diff --cached` shows only it) and the worktree is byte-identical. Hunk 2 shows ticked; hunks 1 and 3 show unticked.
2. Clicking one line's checkbox stages exactly that line: the index equals HEAD plus that one change, byte-for-byte. Clicking again restores the prior index bytes.
3. Byte-exact cases: CRLF lines keep `\r\n`; in a no-EOF-newline file, toggling the last line leaves the `\ No newline` marker correct; an unselected `-` neighbor stays as context.
4. Hunk checkbox states: none staged = unticked, some = mixed, all = ticked. Click in mixed stages the rest; click in ticked unstages the whole hunk.
5. Shift-click from line 2 to line 6 in a hunk applies the range rule (tick all unless all are already ticked, then untick all) to every changed line between them, context skipped, in one atomic operation. Ticking row 2 then Shift-clicking row 6 leaves rows 2-6 ticked. On failure none of it applies. The mouse and keyboard paths give identical results.
6. Mixed file: after staging one of three hunks, the file appears once in the list with the mixed marker. Row Stage stages the rest; row Unstage unstages all; row Discard confirms and removes only unstaged changes, leaving the index unchanged.
7. Stale guard: edit the file externally after the diff shows, then tick a line: the index is unchanged, the user sees "File changed. Diff reloaded.", and the diff shows the new content. A change injected between the fingerprint check and apply is refused by `git apply`, the error surfaces, and the index is unchanged.
8. Fallback: untracked, new, deleted, renamed, binary, image, too-large, non-UTF-8, conflicted, submodule and symlink files show no checkboxes and keep whole-file controls plus separate diffs. A seeded ambiguous-mapping fixture (round-trip fails) also falls back and never half-ticks.
9. Discard: the red header Discard and the right-click menu both open a confirmation naming the file and count. Cancel changes nothing. Confirm restores only those unstaged lines and the index is untouched, including when the file also has staged changes. No Discard appears on the checkbox.
10. Keyboard: Up/Down skips context lines; Space toggles the cursor row; Shift+Down then Space toggles the range; Esc clears the anchor; Tab reaches the hunk checkbox; the Command Palette entries run the same operations.
11. Scroll position and cursor are unchanged after a successful toggle.
12. While editing in the diff no checkboxes are present; after save or cancel they return with a fresh fingerprint.
13. A failed apply (locked index) surfaces git's message and the checkbox reverts. The UI matches `git status --porcelain`.
14. Zero network requests. Identical behavior on GitHub-, GitLab-, Bitbucket-, self-hosted-cloned and no-remote repos and in a linked worktree. No hooks run.
15. aria-live announces tick, untick and failure. The hunk checkbox reports `aria-checked` correctly in all three states.
