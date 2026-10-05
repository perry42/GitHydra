# Ignore and multi-select file actions (Changes panel)

Status: approved structure (D1 to D9 resolved, see end of file). Owner: product-manager. Needs a security review before build (writes repo files). Extends `specs/stage-unstage-diff.md` (FR-23, FR-24, FR-28, FR-30, FR-31), `specs/changes-panel-layout.md` (FR-487, FR-488) and `specs/hunk-line-staging.md` (FR-482 mixed rows). Interacts with `specs/live-refresh.md` (FR-460, FR-465) and the self-write suppression spec. FR numbers continue from FR-493. Default stance: behave like GitKraken unless there is a concrete improvement; improvements are flagged.

## Problem
1. A user cannot stop git from showing build output, logs, `.env` files or editor folders without leaving the app to hand-edit `.gitignore`. When the file is already tracked, they also need `git rm --cached` in a terminal.
2. The Changes list only acts on one file at a time. Staging, unstaging or discarding 40 files takes 40 clicks.

## Target user
A working developer on any repo (local, GitHub, GitLab, Bitbucket, self-hosted, worktree, submodule) with generated or noisy files. Writing a rule or untracking a file must be a safe, previewed action, never a surprise.

## Must-have behavior

### A. Ignore (git-core-engineer, `packages/git-core`)
- **FR-494 (scopes):** an ignore targets one file, or the selected files, by one scope:
  - **Name:** the exact path.
  - **Extension:** `*.ext`, last extension only (`a.tar.gz` gives `*.gz`). Not offered for files with no extension or dotfiles such as `.env`.
  - **Directory:** the file's parent directory, offered only when the parent is not the repo root. For a directory row it is that directory.
- **FR-495 (targets):**
  - **Root `.gitignore`** (GitKraken parity).
  - **Nearest `.gitignore`:** closest existing `.gitignore` walking up from the file's directory. If none exists, falls back to the root file, which is created. Never create a nested one implicitly.
  - **`.git/info/exclude`** (our improvement: private, never shows as a change). Resolve with `git rev-parse --git-path info/exclude` so it is correct in worktrees and submodules. In a worktree the exclude file is shared with the main checkout; UI copy must say so.
  - `core.excludesFile` (global) is out of scope.
- **FR-496 (rule text):**
  - Rules are anchored relative to the directory of the file they are written into. Name gives `/sub/file.txt`, directory gives `/build/`, extension gives `*.log` unanchored.
  - Exclude and root targets anchor to the repo root. A nested target anchors to its own directory.
  - Always `/` separators.
  - Backslash-escape a leading `#` or `!`, a trailing space, and any of `\ * ? [ ]` in names. Extension scope escapes the same characters.
  - Names containing CR, LF or NUL cannot be represented: refuse that scope with a stated reason; never write a corrupted rule.
- **FR-497 (no duplicates, already ignored):**
  - Compare against the target file's existing lines (trailing CR ignored). An identical rule is a no-op reported as "Already in <file>".
  - Run `git check-ignore -v --no-index` on the path (`--no-index` so tracked files are evaluated). If another rule in any file already ignores it, report "Already ignored by <file>:<line>" and write nothing.
  - For a tracked file in that state, only "Ignore and stop tracking" is offered.
  - After writing, re-run the check. If a later `!` negation still leaves the path unignored, say so instead of claiming success.
- **FR-498 (file fidelity):** append one line, touch no other byte. Preserve a UTF-8 BOM and the file's dominant line ending (CRLF or LF; new file uses LF); add a missing final newline before the new rule. Write temp-file-then-rename in the same directory, keep file mode, create new files without a BOM. The read-modify-write runs inside the mutation queue. If the file changed between read and write, re-read once, then fail with a message and write nothing.
- **FR-499 (containment, security):**
  - The path comes from a fresh status/index lookup in git-core, never a renderer-supplied string trusted as-is.
  - `assertPathWithinWorkdir` applies, plus the no-symlinked-parent-component check from `discardGuard.ts`.
  - Refuse if the target `.gitignore` or `info/exclude` is itself a symlink or lies outside the workdir or gitdir.
  - Argv arrays only. All pathspec operations (here and in section C) use `--literal-pathspecs`.
- **FR-500 ("Ignore and stop tracking"):** after the rule is written, run `git rm --cached -r -- <paths>` (worktree files are never deleted).
  - Acts only on the selected files, or on all tracked files under the chosen directory. It does not untrack other tracked files that merely match an extension; the confirm shows how many others remain tracked.
  - The confirmation states the counts, that files stay on disk, and that deletions appear as staged changes to commit.
  - For a mixed row it also says staged edits are dropped from the index.
  - For a staged rename it untracks the new path only and says the old path stays staged as deleted.
  - Order: preflight (target writable, paths valid), write rule, `rm --cached`. If `rm --cached` fails, restore the previous rule file only if its bytes are still exactly what we wrote, and report the true end state.
  - "Ignore only" on a tracked file writes the rule and keeps tracking; the UI states git keeps tracking it until untracked.
- **FR-501 (not offered, with a reason):**
  - Bare repo: nothing offered.
  - Submodule gitlink rows: Ignore disabled (ignoring does not untrack it; untracking would break `.gitmodules`). A nested repo shown as an untracked directory may be ignored by directory name.
  - Conflicted rows: disabled.
  - Directory rows get no Discard (the guard refuses directories); Ignore is allowed.
- **FR-502 (result, side effects):**
  - The write is a self-write (self-write suppression applies). The watcher's ignore list is refreshed after any ignore write, including `info/exclude` (closes the ROADMAP gap).
  - A newly ignored untracked file leaves the list. If it was the open diff, FR-461 applies.
  - Editing `.gitignore` shows as an ordinary change (Untracked if new). Never auto-staged.
  - The success notice names the rule and file written, announced via aria-live.

### B. Per-file entry points (ui-graphics)
- **FR-503:** per-file right-click menu and the row's keyboard-reachable action expose Ignore, per D1/D2/D3. Menu key and Shift+F10 open the same menu.
- **FR-504 (Command Palette, CLAUDE.md convention):** add entries to `getCommands()` for "Ignore selected file(s)...", "Stage selected", "Unstage selected", "Discard selected...", "Discard all changes...", "Select all in section". Each disabled with a reason when nothing applies.

### C. Multi-select and bulk actions
- **FR-505 (selection model):** plain click selects one row and opens its diff (unchanged). Ctrl/Cmd-click toggles. Shift-click selects the range from the anchor. Arrow keys move focus, Shift+Arrow extends, Ctrl+A selects the section, Space toggles, Esc clears. Row key is `path + section`. Cross-section behavior is D4.
- **FR-506 (eligibility per row):**
  - Stage: Unstaged, Untracked, mixed. Unstage: Staged. Discard: Unstaged, Untracked, mixed (unstaged part only, FR-31). Ignore: Unstaged, Untracked, Staged non-gitlink.
  - Conflicted rows take no Stage, Unstage or Discard (FR-27). An ineligible partly staged file appears as two rows (FR-488), each acting on its own side.
  - Ineligible selected rows are skipped and the UI states "N skipped" before the action runs. Mixed rows keep FR-23/FR-30/FR-31 semantics.
- **FR-507 (bulk stage/unstage):** one mutation-queue entry, batched argv (Windows command-line limit), literal pathspecs. On failure revert optimistic state and report which paths did not change (FR-30).
- **FR-508 (bulk discard reuses the guard):**
  - Never a path-only bulk discard. Each row's fingerprint is read with `getDiscardFingerprint` when the confirmation opens and sent with that row.
  - In the queue slot, pass 1 verifies every fingerprint with no mutation. Any mismatch refuses the whole batch with `STALE_DIFF`, changes nothing, names the stale paths.
  - Pass 2 runs each file through `guardedDestructive` or `guardedUnlinkUntracked` (per-file re-check and safety copy). If a file fails midway, stop and report what was and was not discarded.
  - Directories, symlinked parents and unreadable files are refused per file with a reason and skipped.
  - ROADMAP safety-copy residuals apply unchanged.
- **FR-509 ("Discard all changes"):** discards worktree changes for all Unstaged and mixed rows, plus Untracked only per D7. Uses the FR-508 flow over every eligible row, never `git clean -fd` or `git checkout .`, behind the D6 confirmation. The confirmation shows counts (tracked reset, untracked deleted), up to N paths with "and M more", and states staged content is untouched and the action is unrecoverable (safety copy not promised).
- **FR-510 (bulk Ignore):** selected files share one scope and one target per operation. Directory scope dedupes to unique directories. Rules are written in one read-modify-write. "Stop tracking" is offered if any selected row is tracked, with the FR-500 confirmation aggregated.
- **FR-511 (live refresh):**
  - Selection is kept by `path + section`. A path that moves section keeps selection in its new section. A vanished path drops silently and the count updates.
  - Refresh never changes which rows a pending action targets: dialogs and fingerprints are snapshots (FR-493 principle); a mismatch refuses rather than retargets.
  - Focus after an action falls to the nearest surviving row.
  - An open bulk dialog counts as a modal under FR-465 (idle gate).
- **FR-512 (diff pane):** with more than one row selected, behavior follows D8. Single selection unchanged.
- **FR-513 (a11y):** `aria-multiselectable` on the list, `aria-selected` on rows; live region announces "3 files selected" and results; menus and dialogs keyboard-complete with focus return; destructive actions never default-focused; selection shown by more than color (DESIGN.md); hover-only controls reachable by focus (FR-487).
- **FR-514 (empty/edge states):** Ignore and bulk controls hidden or disabled with a reason when a section is empty, the repo is bare, or nothing is selected. Selection cleared on repo/tab change.
- **FR-515 (principles):** no network, account, telemetry, or required setting. Identical on every host and on a repo with no remote.

## Non-goals
- Rule editor/manager, undo for ignore, "open .gitignore" shortcut.
- Pattern wizards beyond name/extension/directory, negation rules, the global excludes file.
- Auto-staging or auto-committing the `.gitignore` change.
- Parsing nested `.gitignore` for dedupe beyond `check-ignore`.
- Marquee select, select-by-status filters, bulk actions in the commit DetailPanel.
- Virtualizing the list (separate ROADMAP item).
- Hunk/line-level bulk operations.
- Discarding directories or submodules.

## Acceptance criteria
1. Ignore by name, extension and directory each write exactly one correct anchored rule to the root `.gitignore`. `git status` no longer lists the untracked file; the `.gitignore` change appears as a normal unstaged change.
2. Nearest `.gitignore` writes into `a/b/.gitignore` with a rule relative to `a/b`; with none present it creates the root file. `.git/info/exclude` writes the rule, `.gitignore` is untouched, nothing new in status. In a linked worktree it writes to the shared exclude and the UI says so.
3. Fidelity: BOM, CRLF-only, LF-only, no-trailing-newline and empty-file targets keep every existing byte and gain exactly one line in the right EOL. A repeat reports "Already in <file>" with bytes unchanged.
4. Escaping: files named `#a`, `!b`, `a b ` (trailing space), `x[1].txt`, `we*rd.txt` and a non-ASCII name each produce a rule for which `git check-ignore` matches that file and no sibling. A name with a newline is refused with a reason, nothing written. Windows backslashes never appear in a rule.
5. A path already ignored by another file's rule reports "Already ignored by <file>:<line>" and writes nothing. A path matching a later `!` rule gets an honest "still not ignored" message.
6. Tracked file: "Ignore only" writes the rule, file stays tracked and listed. "Ignore and stop tracking" shows the confirm (counts, stays on disk, staged-deletion note), then the file is staged as deleted and survives on disk. Directory scope untracks every tracked file under it and no others. Extension scope untracks only the selected files and states how many other matches stay tracked.
7. Mixed row + stop tracking: confirm warns staged edits are dropped. Staged rename + stop tracking untracks the new path only, with the note. A forced `rm --cached` failure leaves the rule file as before, or reports the true state.
8. A symlinked parent directory, a symlinked `.gitignore` or `info/exclude`, and a path outside the workdir are refused with no write. A path not in current status/index is refused. A file named `:(glob)*` or `*.txt` operates on that literal file only. Submodule and conflicted rows have Ignore disabled with a reason. A bare repo offers nothing.
9. Ctrl/Cmd-click, Shift-click ranges and keyboard selection work per FR-505 without a mouse. Screen readers hear the selection count. Selection is not color-only.
10. Bulk Stage/Unstage of 500 mixed rows (spaces, non-ASCII, glob characters) complete in one queued operation; status afterwards matches git's own; the Windows command-line limit is never hit.
11. Bulk Discard of 20 rows (tracked + untracked) resets/removes exactly those paths. Editing one selected file externally after the confirmation opens refuses the whole batch as `STALE_DIFF`, nothing changed, path named. Directories and symlinked-parent rows skipped with reasons. A test shows no code path discards by path alone (every row carries a fingerprint).
12. "Discard all changes" requires the D6 confirmation, shows counts and a path sample, does not delete untracked files unless D7 says so, leaves staged content intact, never runs `git clean -fd`. Cancel changes nothing.
13. Selection survives live refresh: an externally staged selected file stays selected in Staged, a vanished file drops with the count updated, a pending dialog's targets do not change.
14. A mixed file acts per FR-506. An ineligible partly staged file shows two rows; acting on one never touches the other side.
15. Conflicted rows never receive Stage, Unstage, Discard or Ignore from a bulk action; skipped count shown before the action runs.
16. Command Palette entries exist, are disabled with a reason when nothing applies, and match menu behavior.
17. After any ignore write, a new matching file created in a previously watched directory does not trigger a watcher refresh, including for `info/exclude`.
18. Zero outbound requests on a repo with a remote; same behavior on a no-remote repo.

## Structure decisions (resolved by the user 2026-10-05; all chose the recommended option)
- **D1:** Ignore submenu: This file / All *.ext files / All files in <dir>.
- **D2:** After picking a scope, a small popover "Add to:" Root .gitignore (preselected) / Nearest .gitignore / Private (.git/info/exclude); last choice remembered per repo, locally.
- **D3:** The "Ignore only" / "Ignore and Stop Tracking" / Cancel dialog appears only for tracked files.
- **D4:** One selection spans Staged and Unstaged; each bulk action applies to eligible rows and reports "N skipped" first.
- **D5:** A bulk bar at the top of the file column appears at 2+ selected (count, Stage / Unstage / Discard / Ignore, Clear); the context menu on a selected row also works; section "Stage all / Unstage all" stay.
- **D6:** "Discard all changes": modal with counts + path sample, Discard not default-focused; above 20 files also type-to-confirm.
- **D7:** The confirm has an "Also delete N untracked files" checkbox, unchecked by default.
- **D8:** With several rows selected, the diff pane keeps the last clicked/focused row's diff.
- **D9:** After Ignore, a one-line notice beside the diff ("Added /x to .gitignore"), no undo.
