# Changes panel layout

Status: draft. Owner: product-manager. Supports `specs/hunk-line-staging.md` (checkbox column needs the width) and revises the commit-form placement in `specs/stage-unstage-diff.md` (FR-32).

## Problem
The Changes drawer is too narrow for a diff that has a checkbox column: file names truncate to "packages…", and the commit form sits mid-column and scrolls out of reach in a long file list.

## Target user
A working git user staging and committing many files, on any repo or host.

## Must-have behavior
- **FR-486 (width):** the drawer defaults to about 60% of the window and is resizable by a drag handle; the diff keeps at least about 480px. Width is persisted locally (no telemetry). Double-clicking the handle resets to the default. In a window too small for the minimum, the diff wins and the file column shrinks to its own minimum.
- **FR-487 (file column):** rows show the file name first, then the directory dimmed and truncated from the left, then the status letter. Per-file Stage and Discard appear on hover and keyboard focus and are reachable by Tab. Discard keeps its FR-31 confirmation.
- **FR-488 (list structure):** sections are Staged, Unstaged, Untracked and Conflicted. An eligible partly staged file appears once, in Unstaged, with the mixed marker (hunk-line-staging FR-482). Fully staged eligible files stay in Staged.
- **FR-489 (commit form):** the form is pinned at the bottom of the file column and the subject is always visible. The body and Amend-last-commit expand when the form has focus and stay open while text is present. The file list scrolls above the form.
- **FR-490 (notices):** errors and stale notices appear next to the diff, collapsed to one line with details on demand. aria-live announcements are preserved.
- **FR-491:** no network and no account anywhere in this layout.

## Non-goals
- Redesign of the graph or other drawers.
- Layout presets.
- Pop-out or detachable panels.
- Syncing the width anywhere.

## Acceptance criteria
1. First open shows the drawer at about 60% of the window width. Dragging resizes it and the diff never drops below about 480px. A restart restores the width. Double-click resets it.
2. A long path shows the file name intact and the directory truncated from the left with an ellipsis.
3. Hover or Tab focus on a row shows Stage and Discard. Neither is visible otherwise.
4. With 500 changed files the commit subject is still visible and clickable without scrolling.
5. Focusing the subject expands the body and Amend. Blurring with an empty body collapses them. Typed text is never lost.
6. A `STALE_DIFF` shows a one-line notice beside the diff, expandable to details, and aria-live announces it.
7. A partly staged eligible file appears once with the mixed marker. An ineligible partly staged file still appears in both sections.
8. Zero network requests.
