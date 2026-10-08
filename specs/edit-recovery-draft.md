# Edit recovery draft

Status: draft v1 (user-approved feature, 2026-10-08). Owner: product-manager. Depends on `specs/edit-in-diff.md` (FR-468 eligibility, FR-471 write safety, FR-472..474 external change and save guard, FR-535 leave prompt). Storage follows `packages/desktop/electron/windowBounds.ts` (main process, `app.getPath('userData')`, guarded so it never throws).

## Problem
An edit session (`specs/edit-in-diff.md`) holds unsaved changes only in memory. A crash, power loss or shutdown loses them. The user wants to "continue from where we are" the next time they open the repo, without the app ever writing to the repo or the real file, and without keeping source code around forever.

## Target user
A developer who made a non-trivial edit in the diff editor and lost the session unexpectedly. Works on any repo (local-only, any host, linked worktree). No account, no network.

## Must-have behavior

**What is stored**
- **FR-541 (location):** Drafts live only in the main process, in `<userData>/recovery-drafts/`. Never in the repo, never `.git`, never `localStorage` (size, and the renderer must not own it), never the real file. Not synced or uploaded. This feature makes no network call and sends no telemetry (restating FR-476).
- **FR-542 (keys):** `repoKey = sha256(normalized realpath of the working-tree root)` (separators normalized, lowercased on Windows). `fileKey = sha256(repoKey + NUL + repo-relative posix path)`. Layout: `recovery-drafts/<repoKey>/<fileKey>.json`. A linked worktree has its own root, so its own `repoKey`. Directory and file names are hashes, so no repo path appears in clear text on disk listings and path traversal through names is impossible by construction.
- **FR-543 (record):** JSON, `version: 1`, fields: `relativePath` (needed to show the prompt; the absolute repo path is NOT stored), `content` (exact buffer text, so mixed EOLs are kept), `bom` (bool), `eol` (`lf|crlf|mixed`), `finalNewline` (bool), `expectedHash` (the FR-474 recorded hash at open or last load, opaque to this feature), `savedAt` (ms epoch). Not stored: undo history, cursor or selection, commit message.
- **FR-544 (privacy of data):** Directory mode 0700, file mode 0600 where the OS supports it. On Windows rely on the per-user `userData` ACL. Not encrypted in v1 (the same trust boundary as the user's working tree). `content` and file names are never logged or put in error messages.

**When written**
- **FR-545 (write policy):** Only while the buffer is dirty relative to the base text. Debounced 2 s after the last change, and immediately on editor blur and on window `visibilitychange` to hidden. Atomic: temp file in the same directory, then rename. Writes are serialized per `fileKey` and the newest wins. A pending write is cancelled by any delete (FR-546) so a late write can never resurrect a deleted draft. A clean buffer, or one that returns to equal the base, deletes the draft instead. Nothing is written for ineligible files (FR-468).
- **FR-546 (delete triggers):** The draft is deleted when the session ends normally: Save succeeded; Save and stage succeeded; leave prompt Discard (FR-535, including tab close, new repo and app close paths); Reload (discard mine) confirmed in the FR-473 banner; restore prompt Discard; Restore followed by Save; the file no longer exists on disk. Cancel on the leave prompt, a failed Save and a hard kill keep it.
- **FR-547 (caps and expiry):** Per draft: `content` over the editable-size cap (FR-468) is not written. Total: 50 MB and 200 drafts. When exceeded, evict oldest `savedAt` first, never the draft being written. Expiry: 7 days from `savedAt`. The purge runs at app start (main, before the first window opens, not blocking it) and again when a repo's drafts are listed. Expired, corrupt or unknown-version drafts are deleted silently.
- **FR-548 (failure is quiet):** If a draft write fails (disk full, permissions), editing continues unaffected. A one-line non-modal note in the editor footer says "Recovery copy unavailable" with a polite announcement. Never blocks Save or leaving.

**Restore flow**
- **FR-549 (offer):** When a repo is opened (including a restored tab's first activation, `specs/restore-tabs-on-relaunch.md` FR-210), main lists that repo's drafts (metadata only). For each, newest first and sequentially, show a ConfirmDialog "Restore your unsaved edits to `<file>`?" with Restore / Discard / Not now. Restore is focused, Discard is destructive-styled and never focused, Esc is Not now. Not now keeps the draft and stops the chain for this open. If the file no longer exists, the draft is deleted without a prompt. If the file is currently ineligible for another reason (FR-468: binary, too large, symlink, conflicted), no prompt is shown and the draft is kept until it expires.
- **FR-550 (restore, hash matches):** If the file's current content hash equals `expectedHash`, Restore selects the file and opens the editor with the draft text as the dirty buffer (EOL, BOM and final newline as stored), keeping the draft's `expectedHash`. The leave prompt (FR-535) applies as for any dirty buffer.
- **FR-551 (restore, file changed):** If the hash differs, the dialog adds a warning: "This file changed on disk since your draft was saved. Restoring keeps your draft in the editor. Saving will ask before overwriting." Restore keeps the draft's old `expectedHash`, so the FR-473 banner shows and the FR-474 overwrite guard runs on Save. Compare appears only if that slice has shipped. Nothing is merged automatically.
- **FR-552 (re-offer):** A dismissed (Not now) draft is offered again at the next repo open and via the Command Palette entry "Restore unsaved edits" (FR-533 convention; added to `getCommands()` in `packages/desktop/src/lib/commands.ts`, enabled only when the active repo has drafts, otherwise disabled with a reason).
- **FR-553 (concurrency):** Two app instances or windows on the same repo: last writer wins (atomic rename), no lock. Drafts are per `fileKey`, so different files never collide. Accepted.

**Security (security-reviewer sign-off required)**
- **FR-554 (IPC):** Four typed preload methods and nothing generic: `writeDraft`, `readDraft`, `deleteDraft`, `listDrafts`. Each takes the open repo's identity (its working-tree path as the renderer received it; main rejects a mismatch with `no-repository`) plus a repo-relative path, resolved in main to the root. Validate: relative path non-empty, not absolute, no `..`, no NUL, passes the FR-471 containment check; content is a string within the cap; bool and enum fields strictly typed; unknown keys are dropped (the options object is rebuilt field by field). `listDrafts` returns metadata only (relativePath, savedAt, size). `readDraft` returns one record. Errors are generic codes, never paths or content.
- **FR-555 (filesystem safety):** All draft IO is confined to `recovery-drafts/`. Entries are `lstat`ed and symlinks, junctions and non-regular files are never followed, read or deleted. The purge deletes only regular files whose names match `^[0-9a-f]{64}\.json$`, plus leftover `.tmp` files older than 1 h, and removes empty `<repoKey>` directories. No recursive delete on a path derived from input. Records over about 1.5 MB are refused on read. Restoring only fills the editor buffer. The real file is touched only by the normal Save (FR-471). `readDraft` re-validates the stored `relativePath` on read.

## Non-goals
Syncing or uploading drafts; drafts for anything but the diff editor's buffer (no staging state, no commit message); undo/redo or version-history persistence; encryption; autosave to the real file; a drafts manager or list UI; per-row "has draft" badges; a lock between app instances; following a repo that was moved or renamed (its drafts expire); a settings toggle (see Open questions).

## Acceptance criteria
1. Dirty buffer: a draft appears under `userData/recovery-drafts/<hash>/` within 2 s of the last keystroke (immediately on blur). Nothing is written inside the repo; `git status` and the real file are unchanged; no file or directory name contains the repo path or file name.
2. Drafts are deleted on Save, Save and stage, leave prompt Discard, Reload-confirm, restore-prompt Discard, Restore then Save, and when the file is deleted from disk. Unit tests plus a real-Electron test for Save, Discard and Restore-then-Save. A pending debounced write cannot recreate a draft after a delete (test).
3. A clean buffer, an edit reverted to equal the base, and an ineligible file (binary, over the cap, symlink, conflicted, non-UTF-8) never produce a draft.
4. Fake clock: a draft at 6 d 23 h survives; at 7 d 0 h 1 m it is purged at app start and on list. Purge at start does not delay the first window.
5. Caps: a buffer over the editable cap writes no draft; exceeding 50 MB or 200 drafts evicts oldest first and keeps the newest write.
6. Restore with a matching hash: dialog, Restore opens the editor dirty with identical text (CRLF, BOM and missing final newline preserved), Save writes it and deletes the draft. Mismatched hash: the warning text shows, the FR-473 banner shows, Save asks the FR-474 overwrite question with Cancel focused.
7. Real Electron: start an edit, wait for the draft, kill the process (hard), relaunch with the same `--user-data-dir`, open the repo, see "Restore your unsaved edits to `<file>`?"; Restore returns the exact text.
8. Not now keeps the draft and ends the chain; it is re-offered on the next open and via the palette entry. Multiple drafts are prompted newest first, one at a time.
9. Cancel on the leave prompt, or a failed Save, keeps the draft. A draft write failure shows the footer note and does not block editing or Save.
10. Security tests: a traversal-shaped `relativePath` (`..`, absolute, NUL) is rejected; a symlink or junction planted in `recovery-drafts/` is neither read nor deleted nor followed by the purge; unknown filenames are untouched; oversized or corrupt records are ignored or purged; error messages contain no paths or content. security-reviewer sign-off recorded.
11. Accessibility: the restore prompt is a ConfirmDialog with a focus trap, Restore focused, Discard never focused, previous focus restored on close, and an accessible name that includes the file name.
12. Zero network requests and no telemetry (extend the existing no-network test style). Identical on local-only, GitHub, GitLab, Bitbucket and self-hosted repos and in a linked worktree.

## Open questions for the user
1. Several drafts in one repo: sequential prompts newest first (assumed, simple) or one list dialog with per-file Restore/Discard? A list is more UI and is deferred.
2. Should there be a setting or an off switch for privacy-minded users? Assumed no setting in v1, on by default (feature approved). Add the toggle only if a settings screen already exists.
3. After "Not now", is a re-offer on the next open plus the palette entry enough, or also a small "Unsaved edits" marker in the UI? The marker is deferred.

## Size and slices
Size: M.
- **Slice A (main process, security review):** the store module (keys, atomic write, caps, eviction, expiry, safe purge at start), the four typed IPC methods with validation, and unit tests with a fake clock and a temp `userData`.
- **Slice B (renderer):** the debounce/blur write hook in the editor, all FR-546 delete triggers wired through the central guard, the restore ConfirmDialog chain, the FR-550/551 restore paths, the palette entry and the footer note.
- **Slice C (verification):** the real-Electron kill-and-relaunch test, plus real-Electron Save/Discard/Restore-then-Save tests and the no-network and security cases.
