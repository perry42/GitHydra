# Edit in diff

Status: draft. Owner: product-manager. Depends on `specs/hunk-line-staging.md` (and softly on `specs/live-refresh.md`).

## Problem
To fix a line while reviewing a diff, the user leaves for an editor. GitKraken offers "Edit this file" in the diff, with unsaved-state marking, Ctrl/Cmd+S, and Save and stage.

## Target user
A developer reviewing changes who wants a small fix without switching tools.

## Must-have behavior
- **FR-467 (entry):** An "Edit" button in the diff header of an unstaged or untracked text working file switches that pane into an editor on the working file; exit returns to the diff. The file list stays visible; a dirty dot shows in the list row and the header.
- **FR-468 (eligibility):** Text, non-binary, non-too-large, non-conflicted, non-symlink, non-submodule working files only. Staged-side diffs and historical commits are read-only.
- **FR-469 (editor):** Plain-text editor (line numbers, monospace per `DESIGN.md`). Preserve the file's line endings, BOM and trailing-newline state. Component choice (e.g. CodeMirror 6, MIT) is an engineering call; it must pass the `oss-licensing-guardrails` check and be recorded in `docs/tech-decisions.md`.
- **FR-470 (dirty and save):** Unsaved edits show a visible dirty indicator (shape or label, not color only). Ctrl/Cmd+S saves to the working file. "Save and stage" saves, then stages the whole file. Leaving with unsaved edits asks Save / Discard / Cancel.
- **FR-471 (write safety):** The write path is main-process only, enforces `assertPathWithinWorkdir` plus realpath containment (no writing through a symlink that leaves the repo), is atomic (temp file then rename) and preserves file mode. Needs security-reviewer sign-off.
- **FR-472:** In edit mode with no unsaved edits, an on-disk change reloads the editor quietly.
- **FR-473:** In edit mode with unsaved edits and an on-disk change, never overwrite either side. An inline banner at the top of the editor offers Reload (discards mine, after confirm), Keep mine, and Compare (mine vs disk). Keep mine still runs FR-474 on Save.
- **FR-474 (save guard):** The editor records the file's content hash at open or last load. Save refuses or confirms ("File changed on disk since you opened it. Overwrite?") if disk differs. Works even with live-refresh detection off.
- **FR-475:** After save, the diff and Changes list refresh via the normal path. Partial staging of the saved result uses `hunk-line-staging.md`.
- **FR-476:** No network, no hooks, identical across hosts.

## Non-goals
- GitKraken's "Stage saved changes only" (redundant with hunk/line staging after a save).
- Syntax highlighting, autocomplete, find/replace, multi-cursor, LSP, themes, settings.
- Editing staged-side or historical content, multi-file editing, editing conflicted files.
- Autosave.
- A general-purpose code editor.

## Acceptance criteria
1. Edit, dirty indicator appears, Ctrl/Cmd+S writes the file. `git diff` shows the edit, and CRLF/BOM/no-trailing-newline state is byte-preserved.
2. Save and stage leaves the file fully staged and the diff pane refreshed.
3. Leaving with unsaved edits prompts. Discard leaves the file untouched on disk.
4. Externally change the file in edit mode with no edits: the editor reloads with no prompt.
5. Externally change the file in edit mode with unsaved edits: neither side is overwritten, the banner appears with Reload / Keep mine / Compare, and each does what it says.
6. Change the file externally after opening, with live refresh disabled: Save still refuses or confirms (FR-474).
7. A symlink, a path escaping the repo via a symlink, a binary, too-large, conflicted or staged-side file offers no Edit action, and the write path rejects them when called directly.
8. A failed write (read-only file, disk error) surfaces the error and keeps the unsaved buffer.
9. Zero network requests. Identical across hosts and in a linked worktree.
