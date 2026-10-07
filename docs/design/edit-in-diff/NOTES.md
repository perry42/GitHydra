# Edit in diff — design notes (2026-10-07, pre-build)

Status: **mockup v3 (staged-file editing) approved by user; spec updated (draft v2, FR-467..476 + FR-527..538); not built.** Spec: `specs/edit-in-diff.md` (FR-467..476).
Open `mockup.html` in a browser: `?view=rec&layout=B&s=dirty&theme=dark` (`layout=A|B|C`, `view=gk|rec|both`).
Branch `feat/edit-in-diff` holds only this folder; no feature code yet.

## Reviews done
- GitKraken baseline (help.gitkraken.com/gitkraken-desktop/editing-files): diff/editor fills the whole central area (graph hidden), "Edit this file" button, blue unsaved dot, Ctrl/Cmd+S, Stage File dialog (Save and stage / Stage saved changes only / Cancel), encoding dropdown, Markdown preview, file tabs.
- Impeccable critique: 3 P0 + 8 P1 applied in the mockup (2-row header, Tab/Esc/Ctrl+M keyboard contract, no always-on beside pane, one-line banners, ConfirmDialog for destructive prompts, one-line footer, Hebrew-safe e.code shortcuts).
- Product-manager review: see "Decided so far" and "Spec changes".

## Decided so far (user)
- Double-click to edit IS in (plus visible Edit button and E key). Autosave dismissed entirely.

## Recommended, awaiting user confirmation
1. Layout B default: graph stays visible, drawer widens to ~80vw while editing, file list collapses to a thin strip; Expand (Ctrl/Cmd+Shift+Enter, Esc restores) is optional and first to cut. Dirty buffer, cursor, scroll survive widen/collapse.
2. v1 UTF-8 only (BOM ok); non-UTF-8 = Edit disabled "Not UTF-8, edit externally". Encoding dropdown, Markdown preview, tabs = v1.1.
3. Entry points: Edit button, double-click (not on checkbox, hunk header, line-staging gutter, expand-context, ineligible files -> hint), E key, Command Palette entries (Edit file, Save, Save and stage). Right-click "Edit file" only if a file-row context menu already exists.
4. Save is the single filled button; Save and stage secondary and leaves the editor; leave prompt Save/Discard/Cancel with Save focused; Tab indents, Esc leaves; staging checkboxes hidden while editing.
5. Gutter markers only (vs HEAD for normal files, "new file" for untracked), click/Alt+Shift+D peeks deleted lines.

## Spec changes to make before building (PM)
FR-467 (entry points, wider drawer, rail), FR-468 (+non-UTF-8), FR-469 (no encoding conversion), FR-470 (ConfirmDialog prompts, Tab/Esc), FR-473 (one-row banner), new FR-477 double-click, FR-478 Expand, FR-479 physical-key shortcuts + palette entry, FR-480 one-line footer, non-goals (+encoding dropdown, Markdown preview, tabs; autosave decided no), ACs 10-14. Check the highest existing FR number first.
Also needed: size limit (suggest 1 MB edit, markers off above ~256 KB), closing app/tab with dirty buffer prompts, explicit read-only check on write, security-reviewer sign-off on the write path, CodeMirror 6 license check + `docs/tech-decisions.md` entry, real-Electron tests.

## Update 2026-10-07 (later)
- User approved: files with staged changes ARE editable (working copy; index untouched; persistent note; 'Save and stage whole file'; row Stage/Unstage/Discard disabled while dirty).
- UI-lead review of the spec: approve with small edits, applied. Must-knows for the build: closing the app needs a new main-process close interception + typed preload event (security review); tab/drawer/commit/panel switches need one central dirty-leave guard (App.tsx guardedTabAction + `onRemoveTab` bypass); drawer widening is a transient override (never rewrite stored width; graph 280px floor wins); file column collapses by width only (display:none would break useListWindowing); editor keyed by file path, may outlive its Changes row; DiffView plain-diff region needs a focusable region for the E key; Esc must not bubble to CombinedHunks/ChangesPanel handlers.
- Build estimate: L (2-3 weeks). Cut candidates: Expand, Compare view, peek, gutter markers.
- Mockup open decisions still listed on the page: two rows vs one mixed row after save; 240ms combined-diff delay (mock only).
