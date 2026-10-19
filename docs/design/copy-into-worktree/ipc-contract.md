# IPC contract: copy ignored files into an existing worktree

Source of truth: `specs/worktree-copy-ignored.md` section G (FR-649..657), amended 2026-10-19. Types live in
`packages/desktop/shared/ipcContract.ts` (search `WorktreeExisting`). Backend: `packages/git-core/src/worktreeCopyExisting.ts`
(+ `worktreeCopyExistingPure.ts`, renderer-safe), main side: `packages/desktop/electron/worktreeIpc.ts` and `worktreeCopyTokens.ts`.
No dialog, menu, palette entry or banner exists yet; this note is what the UI builds on.

## Channels (`window.gitHydra`, all answer `IpcResult<T>`; all four fail closed for any sender except our own window)

| Method | Argument | Result |
|---|---|---|
| `listIgnoredForExisting` | `{ destId: string \| null }` (worktree id from the Worktrees list, `null` = main worktree; never a path) | `WorktreeExistingListing` |
| `copyIgnoredIntoExisting` | `{ token: string; rowIds: string[] }` (max 2000 ids of 1024 chars) | `WorktreeExistingCopyResult` |
| `cancelIgnoredCopyIntoExisting` | none | `void` (stops after the current file; idempotent) |
| `releaseIgnoredForExisting` | none | `void` (dialog closed: kills this purpose's token only, never Create's) |
| `onIgnoredCopyIntoExistingProgress?` | listener | unsubscribe; pushes `{filesDone, filesTotal, bytesDone}` (numbers only), first after 2 s, then at most 1/s |

Neither of the two main calls takes a repo key, source path or destination path; the repo is the session's open repo (the SOURCE
worktree is that repo's own working tree, i.e. the active tab). Unknown keys in a request throw `InvalidArgumentError`.

## Listing (`WorktreeExistingListing`)

- `status: "failed"`: `{ reason, message }`. `message` is fixed text: `Not a worktree of this repository.` for `not-a-worktree`,
  `untrusted-list`, `source-is-destination`, `locked`, `missing`, `unsupported`, `bare`; `Couldn't check which files <B> tracks.` for
  `tracked-check-failed`; `Couldn't list ignored files.` for everything else (`timeout`, `too-many-files`, `git-failed`, `cancelled`).
- `status: "ok"`: `{ token, source: {name}, destination: {id, name, path, branch, detached, shortHead}, rows, include }`.
  `token` is `""` when there are no rows (render the muted `No ignored files to copy in this repository.` and one Close button).
  All names (A, B, path, branch) come from main and are already escaped (`U+XXXX` for control/bidi/format characters) and middle-truncated at 120
  characters: show them as text nodes, never from the renderer's own worktree list. A detached HEAD has `detached: true` and `shortHead`
  (`detached at <short sha>` in the picker sub line).
- `rows[]` (`WorktreeExistingRow`): `id` (send this back), `path` (exact), `displayPath` (render this), `isDirectory`,
  `fileCount` (M), `existingCount` (N, "N of M already exist"), `copyableCount`, `bytes` (copyable bytes), `disabledReason` + `disabledText`
  (fixed text; strongest reason by `inside another repository` > `destination folder is a link` > `tracked in <B>` > `already exists`),
  `secret`, `runsCode`, `large`, `changesGit` (tag `changes how git behaves in <B>`), `notIgnoredInDestination` (`boolean | null`, informational, never disables; `null` = the check could not answer and is treated as not ignored for pre-tick and explicit-Copy;
  FR-654: such a secret row is never pre-ticked and shows the critical sentence), `droppedFiles`, `droppedReasons`.
- `include`: `.worktreeinclude` matches as for Create (`WorktreeCopyInclude`). Pre-tick rules (FR-654): `decideInitialTicks` restricted to
  enabled rows, and in this dialog never a `runsCode` row, never a `secret` row with `notIgnoredInDestination`.
- Over-limit readout (FR-651): count only ENABLED TICKED files (`copyableCount` of ticked rows) and bytes against 5,000 / 200 MB
  (`COPY_MAX_FILES`, `COPY_MAX_BYTES` from `@githydra/git-core`). Main enforces it again at copy time (`overLimit`).

## Copy (`WorktreeExistingCopyResult`)

- `status: "done" | "cancelled" | "limit"`: `{ copied, bytes, skipped[], skippedTotal, from, into }`. `skipped` has at most 20
  entries `{ path (escaped), reason (git-core code), text (fixed FR-655 string) }`; `skippedTotal` is the real count. Cancelled copies do not list
  the unprocessed files as skipped. Map to the FR-655 banner table: `cancelled` -> `Copy cancelled. ...`, `limit` -> `Stopped at the limit ...`;
  success tone only when `skippedTotal === 0`.
- `status: "refused"`: `{ reason, message, into }` and NOTHING was written. Reasons: `tokenInvalid`, `tokenExpired`, `purposeMismatch`, `destinationChanged`,
  `notAWorktree`, `busy`, `selectionChanged`, `overLimit`, plus `trackedCheckFailed` and `sourceChanged` (not named in the spec's list). `message` is fixed text
  (`<B> is no longer a worktree of this repository.`, `<B> changed. Open this dialog again.`, `Another copy is already running.`,
  `This selection is no longer valid. Review it again.`, `Couldn't check which files <B> tracks.`). Show it in the in-dialog critical
  alert; the primary becomes **Try again** = a new `listIgnoredForExisting`. `busy` keeps the token (retry with the same one is fine).
- A running copy aborts like Cancel when the active tab is switched or closed (main polls the session repo); the result is then `cancelled`.

## Authority and invariants (do not weaken in the UI)

- Purpose-bound token (`copy-into-existing`), separate slot from Create's: a listing/release of one never kills the other; a Create token is
  `purposeMismatch` here and the reverse. Single-use, 10 minutes, bound to repo key, source, destination id + realpath (validated at listing),
  and the sorted row-id set; consumed only after the cheap checks, the mutex and the destination re-resolution pass.
- ONE per-repo mutex (`createRepoMutex`) shared by Create's post-add copy (a busy repo still creates the worktree, copy refused), this copy,
  worktree remove, remove-and-delete-branch and prune (these wait their turn). A future `move` must use `mutex.run` too.
- The renderer never sends paths; names shown come from main; reasons come from the fixed tables in
  `worktreeCopyExistingPure.ts` (`existingReasonText`, `existingSkipText`).
