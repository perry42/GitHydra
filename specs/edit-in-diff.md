# Edit in diff

Status: draft v2 (user-confirmed decisions folded in 2026-10-07). Owner: product-manager. Depends on `specs/hunk-line-staging.md` (FR-479, FR-481, FR-484) and softly on `specs/live-refresh.md` and `specs/self-write-refresh-suppression.md`. Supersedes FR-467's "file list stays visible" and FR-468's "staged-side is read-only".

## Problem
To fix a line while reviewing a diff, the user leaves for an editor. GitKraken offers "Edit this file" in the diff, with unsaved-state marking, Ctrl/Cmd+S, and Save and stage. GitHydra should offer a small, safe, plain-text version of this, and it must work on any repo with no host dependency.

## Target user
A developer reviewing changes who wants a small fix without switching tools. They may have already staged part or all of the file.

## Must-have behavior

**Entry**
- **FR-467 (entry):** Edit opens the WORKING copy of an eligible file in an editor in the diff pane. Entry points: (a) an "Edit" button in the diff header; (b) double-click on a diff row's content (NOT on a stage checkbox, hunk header or its buttons, line-staging gutter controls, or expand-context controls; double-click never toggles any line or hunk checkbox, and content areas of changed lines are not checkbox targets; on an ineligible file it shows a brief non-modal reason instead of editing); (c) the `E` key, only when focus is inside the diff pane and not in a text input; (d) Command Palette entries (FR-533); (e) "Edit file" in the existing file-row context menu (FR-534). Ineligible files show the Edit button disabled with the reason as tooltip and `aria-disabled`.
- **FR-527 (physical key codes):** Letter shortcuts (`E`, Ctrl/Cmd+S, Ctrl/Cmd+Shift+S) match `KeyboardEvent.code` (`KeyE`, `KeyS`), not `key`, so they work on the Hebrew layout. Scope: implemented inside the diff-pane and editor handlers only; the global keybinding registry need not be retrofitted. The Shortcuts screen lists them either way. Save shortcuts are active only while the editor is open.

**Eligibility**
- **FR-468 (eligibility):** Editable: text working files, including untracked files, files staged as renamed/added/intent-to-add, and files with staged content. NOT editable, with a reason string: binary; too large (over 1 MB, "File too large to edit here"); symlink, including one that escapes the repo; conflicted (use the resolution view); not valid UTF-8 ("Not UTF-8, edit externally"; a UTF-8 BOM is fine; never convert or re-encode); submodule; deleted in the working tree; any file shown from a historical commit.

**Staged content**
- **FR-528 (staged files):** Saving writes the working file only and never touches the index. When the index differs from HEAD for this file, a persistent one-line note shows: "Editing the working copy. Your staged version is unchanged. Stage again to include these edits." The header shows a "Working copy" label. No note appears when the index equals HEAD.
- **FR-529 (Edit from a Staged row):** Edit on a Staged row switches the pane to the combined HEAD-to-worktree diff (FR-479) when available, and the editor opens on the working copy. When FR-481 forces the fallback, the editor still opens and the pane stays in the separate-diff layout.
- **FR-530 (save and stage):** "Save and stage" saves, then stages the whole file. When the file has staged content the label reads "Save and stage whole file", with tooltip "Replaces your current staged version with the full working copy." No confirm dialog. After Save and stage the editor stays open and clean with the status "Saved and staged". If the stage step fails after the write succeeded, the file stays saved, the buffer is clean, and the stage error is shown. Save and Save and stage are `aria-disabled` with the reason "No unsaved edits" while the buffer is clean.
- **FR-531 (dirty locks row actions):** While the buffer is dirty, Stage, Unstage and Discard on that file's rows are `aria-disabled` with the reason "Save or discard your edits first". Per FR-484 the row and hunk staging checkboxes are hidden and not focusable during editing, and any ticks are dropped. They return on exit with the fingerprint recomputed.

**Layout (supersedes FR-467's "file list stays visible")**
- **FR-532 (layout):** The commit graph stays visible. While editing, the drawer widens to up to 80vw as a TRANSIENT override: the stored width is never rewritten, and the squeeze-to-fit rule and the graph's 280px floor still win in small windows. The file column stays mounted and laid out and collapses to a thin rail by width only (never `display:none`, `hidden` or unmounted, which would defeat list windowing); hover or keyboard focus expands it as an overlay without reflowing the editor. The dirty buffer, cursor, selection, scroll and commit-composer text survive, and the editor is never remounted. The editor is keyed by file path, never by section, and stays open if the saved file drops out of the Changes list. Optional Expand (Ctrl/Cmd+Shift+Enter, Esc restores) is the FIRST THING TO CUT if scope tightens.

**Editor**
- **FR-469 (editor):** Plain-text editor with line numbers and monospace per `DESIGN.md`. Preserves the file's line endings (including mixed), BOM and final-newline state, never converts them. Engineering picks the component (e.g. CodeMirror 6, MIT); it must pass the `oss-licensing-guardrails` check and be recorded in `docs/tech-decisions.md`.
  - Gutter markers only (added, modified, removed) against HEAD for normal files; untracked files show "new file" with every line added; in the FR-481 fallback, markers are against the index. Debounced, off above about 256 KB.
  - Clicking a marker, or Alt+Shift+D, peeks the deleted lines.
  - NO always-on beside-diff pane. The only side-by-side is the transient "Mine vs on disk" compare from the banner's Compare button.
  - Tab indents (multi-line selection indents every line); Shift+Tab outdents.
  - Ctrl+M moves focus between editor and toolbar (Tab is not a focus trap).
  - Esc leaves the editor, with the FR-535 prompt if dirty, and is ignored during IME composition.
  - A one-line footer shows "Ln, Col · EOL · encoding · final newline".

**Dirty and leave**
- **FR-470 (dirty and save):** Unsaved edits show a dot plus the word "Unsaved" in the diff header (not color only). The file row shows an 8px non-amber dot with hidden text for screen readers. Save is Ctrl/Cmd+S.
- **FR-535 (leave prompt):** Leaving with a dirty buffer opens a ConfirmDialog with Save / Discard / Cancel. Save focused, Discard never focused. Covers switching file, Back to diff, closing the drawer, selecting a commit or opening any other right-hand panel, switching/closing/new repo tab, opening another repo, and closing the app. One central guard is asked by every path; no path may drop a dirty buffer silently. Closing the app needs a main-process close interception with a typed preload event (never a native `beforeunload` dialog, never a generic channel). Cancel aborts the leave. If Save fails, the leave is aborted and the buffer is kept.

**Write safety and external change**
- **FR-471 (write safety):** Main-process only. Enforces `assertPathWithinWorkdir` plus realpath containment. Atomic (temp file then rename), preserves file mode, with an explicit read-only check before writing that refuses a read-only file with a clear error. Needs security-reviewer sign-off.
- **FR-472:** In edit mode with no unsaved edits, an on-disk change reloads the editor quietly.
- **FR-473:** With unsaved edits and an on-disk change, never overwrite either side. A one-line banner (`role=alert`) pinned over the editor offers Reload (discards mine, behind a ConfirmDialog), Keep mine, Compare (transient "Mine vs on disk" view), Show details. Keep mine still runs FR-474 on Save.
- **FR-474 (save guard):** The editor records the file's content hash at open or last load. If disk differs at Save, show a ConfirmDialog ("File changed on disk since you opened it. Overwrite?") with Cancel focused. Works with live-refresh detection off.
- **FR-536 (own-save is silent):** Our own save is registered as a self-write (`specs/self-write-refresh-suppression.md`) and updates the recorded hash, so it never triggers the FR-473 banner or FR-472 reload.
- **FR-537 (save errors):** On a write failure, show "Couldn't save. Check that you can write to this folder and file." Raw error in Show details. The buffer stays dirty and intact.
- **FR-475:** After save, the diff and Changes list refresh via the normal path. Partial staging of the saved result uses `hunk-line-staging.md`.
- **FR-476:** No network, no hooks, identical across hosts.

**Command Palette and context menu**
- **FR-533 (commands):** Add "Edit file", "Save", and "Save and stage" (relabelled "Save and stage whole file" when staged content exists) to `getCommands()` in `packages/desktop/src/lib/commands.ts`. "Edit file" enabled only with an eligible file selected; "Save" and "Save and stage" only while the editor is open. Disabled entries show the reason. Shortcuts per FR-527.
- **FR-534 (file-row context menu):** The file-row context menu in `ChangesPanel.tsx` (`onRowContextMenu`) gets "Edit file", single-row target only, disabled with the reason on ineligible files. Multi-select does not offer it.

- **FR-538 (accessibility):** The editor has an accessible name "Editing <path>" and is described by the footer. Entering edit focuses the editor (caret at the clicked line/column for double-click); leaving returns focus to the Edit button, and closing the leave dialog restores the previous focus. Save, "Saved and staged" and external-change events are announced in a polite live region. Gutter markers differ by shape, not color alone. Disabled controls give the reason as text or `aria-describedby`, not tooltip only. The dirty dot meets 3:1 contrast in both themes. The rail expands on keyboard focus-within and has the label "Changed files". Rail transitions and flash animations honor `prefers-reduced-motion`. ConfirmDialog's `secondaryAction` gains a destructive style option (used for Discard).

## Non-goals
Autosave (decided no); "Stage saved changes only"; encoding dropdown or any re-encoding; Markdown preview; per-file editor tabs (v1.1); syntax highlighting, autocomplete, find/replace, multi-cursor, LSP, themes, settings; an always-on beside-diff pane; multi-file editing, editing conflicted files, editing historical-commit content; writing to the index from the editor other than the explicit Save and stage; a general-purpose code editor.

## Acceptance criteria
1. Edit, dirty indicator appears, Ctrl/Cmd+S writes the file. `git diff` shows the edit; CRLF/BOM/no-trailing-newline state byte-preserved.
2. Save and stage leaves the file fully staged and the diff pane refreshed.
3. Leaving with unsaved edits prompts Save / Discard / Cancel (Save focused, Discard never focused). Discard leaves the file untouched on disk. Cancel stays in the editor.
4. External change in edit mode, no edits: editor reloads with no prompt.
5. External change with unsaved edits: neither side overwritten, banner with Reload (confirm) / Keep mine / Compare, each does what it says.
6. External change after opening, live refresh disabled: Save shows the overwrite ConfirmDialog with Cancel focused (FR-474).
7. Symlink (incl. escaping the repo), binary, too-large, conflicted, submodule, deleted-in-worktree, non-UTF-8 or historical-commit file offers no Edit, each with its reason; the write path rejects them when called directly. Staged-as-renamed/added/intent-to-add files and files with staged content ARE editable.
8. Failed write (read-only file, disk error): FR-537 banner, raw error in details, buffer kept.
9. Zero network requests. Identical across hosts and in a linked worktree.
10. Staged-file editing: Edit opens the working copy; after save `git diff --cached` is byte-identical to before; the note shows only when the index differs from HEAD; button reads "Save and stage whole file" with tooltip and replaces the index version with no confirm.
11. Edit from a Staged row opens the editor on the working copy and shows the combined HEAD-to-worktree diff when FR-479 is available; in the FR-481 fallback the editor still opens.
12. Double-click on a diff row's content enters edit; on a stage checkbox, hunk header or its buttons, line-staging gutter control or expand-context control does nothing; on an ineligible file shows a non-modal reason.
13. Hebrew layout: the physical `E` key enters edit with focus in the diff pane (not in a text input); Ctrl+S and Ctrl+Shift+S work.
14. Palette entries "Edit file", "Save", "Save and stage" exist and are disabled with a reason when not applicable; "Edit file" appears in the single-row file context menu, not on multi-select.
15. Entering edit widens the drawer to up to 80vw (never below the graph's 280px floor; stored width unchanged) and collapses the file list to a rail that expands on hover/focus; graph stays visible; dirty buffer, cursor and scroll identical before/after.
16. Saving does not show the external-change banner or reload; a second immediate save does not trigger the FR-474 prompt.
17. An untracked file opens with every line marked added ("new file"); saved and staged correctly.
18. A non-UTF-8 file offers no Edit, shows "Not UTF-8, edit externally", bytes unchanged; a UTF-8 BOM file is editable and the BOM preserved.
19. Dirty buffer: closing the repo tab or the app opens the leave prompt (Cancel keeps it open); that file's row Stage/Unstage/Discard are `aria-disabled` with "Save or discard your edits first"; staging checkboxes hidden.
20. Esc during IME composition does not leave the editor; Tab/Shift+Tab indent/outdent incl. multi-line selection; Ctrl+M moves focus to the toolbar and back.
21. Write path tests: realpath escape, symlink, read-only file, mode preservation; security-reviewer sign-off recorded.

## Open questions for the user (PM)
1. "Edit file" in the context menu: hidden or shown disabled with the reason on ineligible files? (assumed: disabled with reason)
2. Optional Expand mode (Ctrl/Cmd+Shift+Enter): ship in the first cut or v1.1? (PM recommends cut first)
3. 1 MB edit limit and 256 KB gutter-marker cutoff are PM defaults.
4. (Decided in FR-530) Stage failure after a successful write keeps the file saved, buffer clean, error shown.
