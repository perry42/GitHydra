// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The full IPC surface between the renderer (untrusted-by-policy, contextIsolation on,
 * nodeIntegration off) and the Electron main process (which alone talks to @githydra/git-core
 * and the filesystem). Both `electron/` and `src/` import this file — it must stay free of
 * Node-only imports (no `child_process`, `fs`, `electron`) so it's safe to bundle into the
 * renderer too.
 */
import type {
  BlameResult,
  ChangedFile,
  CommitInfo,
  CommitLogFilter,
  CommitLogPage,
  ConflictedFileInfo,
  ConflictFileDiff,
  ConflictMarkerScanResult,
  ConflictSideLabels,
  CreateBranchOptions,
  CreateBranchResult,
  CreateCommitOptions,
  CreateCommitResult,
  CreateStashOptions,
  CreateStashResult,
  DiffOptions,
  FileDiffResult,
  ImageDiffResult,
  LocalBranchInfo,
  RefInfo,
  RemoteBranchInfo,
  RepositoryState,
  StashApplyOutcome,
  StashDiffResult,
  StashInfo,
  SwitchResult,
  WorkingDirectoryChanges,
} from "@githydra/git-core";

export const IPC_CHANNELS = {
  openRepoDialog: "repo:openDialog",
  openRepo: "repo:open",
  // specs/repo-open-feedback.md FR-163/FR-164/FR-165: a cancellable variant of `openRepo`, keyed
  // by a caller-generated `requestId` — see `openRepoCancellable`'s own doc comment below for the
  // full contract. `openRepo` itself is untouched (never cancellable) for every existing caller.
  openRepoCancellable: "repo:openCancellable",
  cancelOpenRepo: "repo:openCancel",
  // specs/repo-list.md (revised IA) / security review: an explicit "tear down the live session
  // with no new repo replacing it" round trip — see `closeRepoSession`'s own doc comment on
  // `GitHydraApi` below for why this needed its own channel rather than reusing `openRepo`.
  closeRepoSession: "repo:closeSession",
  getState: "repo:getState",
  getRefs: "repo:getRefs",
  createLogReader: "repo:createLogReader",
  readPage: "repo:readPage",
  closeReader: "repo:closeReader",
  getCommit: "repo:getCommit",
  getChangedFiles: "repo:getChangedFiles",
  // specs/compare-commits.md FR-182/FR-188: the two-arbitrary-commit counterparts of
  // `getChangedFiles`/`getCommitFileDiff` above, both endpoints caller-supplied instead of one
  // being derived from `parents[0]`.
  getChangedFilesBetween: "repo:getChangedFilesBetween",
  getCommitRangeFileDiff: "repo:getCommitRangeFileDiff",
  getWorkingDirStatus: "repo:getWorkingDirStatus",
  getUpstreamBranch: "repo:getUpstreamBranch",
  refsChangedEvent: "repo:refsChanged",
  // FR-19/FR-28: per-file working-directory change list (Staged/Unstaged/Untracked/Conflicted).
  getWorkingDirectoryChanges: "repo:getWorkingDirectoryChanges",
  // FR-20/FR-21/FR-22/FR-29: diff content for each of the four bases the spec defines.
  getUnstagedFileDiff: "repo:getUnstagedFileDiff",
  getStagedFileDiff: "repo:getStagedFileDiff",
  getUntrackedFileDiff: "repo:getUntrackedFileDiff",
  getCommitFileDiff: "repo:getCommitFileDiff",
  // specs/image-diff-preview.md FR-142/FR-144: image-diff content for each of the same four
  // bases, mirroring the four `*FileDiff` channels above 1:1.
  getUnstagedImageDiff: "repo:getUnstagedImageDiff",
  getStagedImageDiff: "repo:getStagedImageDiff",
  getUntrackedImageDiff: "repo:getUntrackedImageDiff",
  getCommitImageDiff: "repo:getCommitImageDiff",
  // FR-23/FR-30: stage/unstage.
  stageFile: "repo:stageFile",
  unstageFile: "repo:unstageFile",
  stageAllFiles: "repo:stageAllFiles",
  unstageAllFiles: "repo:unstageAllFiles",
  // FR-24/FR-31: destructive, explicitly-named discard operations.
  discardTrackedFileChanges: "repo:discardTrackedFileChanges",
  discardUntrackedFile: "repo:discardUntrackedFile",
  // FR-25/FR-32: commit creation.
  createCommit: "repo:createCommit",
  // specs/amend-last-commit.md FR-154: amend HEAD's commit.
  amendCommit: "repo:amendCommit",
  // FR-33/FR-34: branch listing (Branches panel — independent of the graph's ref-filter state).
  listBranches: "repo:listBranches",
  listRemoteBranches: "repo:listRemoteBranches",
  // FR-35: client-side name validation before any mutating call is attempted.
  validateBranchName: "repo:validateBranchName",
  // FR-35/36/37: create (optionally create-and-switch, optionally tracking a remote start point).
  createBranch: "repo:createBranch",
  // FR-38/39: switch HEAD to an existing branch, or detach onto an arbitrary commit-ish.
  switchBranch: "repo:switchBranch",
  switchToCommit: "repo:switchToCommit",
  // FR-40/41: safe delete vs. explicit force delete — kept as separate channels/methods so the
  // renderer can never reach force-delete via the same code path as a normal delete.
  deleteBranch: "repo:deleteBranch",
  forceDeleteBranch: "repo:forceDeleteBranch",
  // specs/merge-rebase-conflict-resolution.md, FR-58 through FR-80.
  // FR-62/FR-63: every conflicted path's classification + stage content.
  getConflictedFiles: "repo:getConflictedFiles",
  // FR-64/FR-77/FR-78/FR-80: three-way (or two-way) comparison content for one conflicted file.
  getConflictFileDiff: "repo:getConflictFileDiff",
  // FR-61: concrete "your branch"/"incoming" labels for the current in-progress operation.
  getConflictSideLabels: "repo:getConflictSideLabels",
  // FR-66: scan a working-tree file for literal, unresolved conflict marker lines.
  scanConflictMarkers: "repo:scanConflictMarkers",
  // FR-65/FR-66/FR-78: whole-file accept-ours/accept-theirs.
  acceptConflictSide: "repo:acceptConflictSide",
  // FR-65/FR-66: mark a hand-resolved file as resolved.
  markConflictResolved: "repo:markConflictResolved",
  // FR-68/FR-69: abort the current merge/rebase/cherry-pick/revert.
  abortInProgressOperation: "repo:abortInProgressOperation",
  // FR-70/FR-71: continue the current operation.
  continueInProgressOperation: "repo:continueInProgressOperation",
  // Not itself a git-core method: opens a repo-relative path with the OS default application
  // ("Open in external editor"), main-process-only (shell.openPath), with the same path-
  // containment discipline git-core's own filesystem-touching operations use.
  openPathInExternalEditor: "repo:openPathInExternalEditor",
  // specs/stash.md, FR-81 through FR-90.
  listStashes: "repo:listStashes",
  getStashDiff: "repo:getStashDiff",
  createStash: "repo:createStash",
  applyStash: "repo:applyStash",
  popStash: "repo:popStash",
  dropStash: "repo:dropStash",
  // specs/cherry-pick.md, FR-103 through FR-110.
  cherryPick: "repo:cherryPick",
  skipCherryPickCommit: "repo:skipCherryPickCommit",
  commitEmptyCherryPick: "repo:commitEmptyCherryPick",
  // specs/blame.md, FR-123 through FR-130.
  getFileBlame: "repo:getFileBlame",
  createFileHistoryReader: "repo:createFileHistoryReader",
} as const;

/** Minimal, structured-clone-safe serialization of git-core's typed Error classes. */
export interface IpcError {
  name: string;
  message: string;
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcError };

export interface OpenRepoResult {
  path: string;
  state: RepositoryState;
}

/**
 * specs/repo-open-feedback.md FR-165: `openRepoCancellable`'s return shape — a distinct, THIRD
 * outcome from both success and failure. Deliberately not folded into `IpcResult<OpenRepoResult>`
 * itself (e.g. a synthetic `{ ok: false, error: { name: "OperationCancelledError", ... } }`) so a
 * caller can branch on `outcome === "cancelled"` — a plain property check, never string-parsing an
 * error message, and never even needing to know the cancellation error class's exact `.name`
 * string. `"settled"` carries the exact same `IpcResult<OpenRepoResult>` shape `openRepo` always
 * has, so an `unwrap()`-style helper still works unchanged on `.result`.
 */
export type OpenRepoOutcome =
  | { outcome: "settled"; result: IpcResult<OpenRepoResult> }
  | { outcome: "cancelled" };

export interface WorkingDirectoryStatus {
  hasChanges: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
}

export interface ChangedFilesRequest {
  sha: string;
  parents: string[];
}

/** A file identifier, matching the subset of `ChangedFile` that `getCommitFileDiff` needs to
 * diff a rename/copy correctly (its `oldPath`, when set). */
export interface FileRefRequest {
  path: string;
  oldPath?: string;
}

/**
 * The API surface exposed on `window.gitHydra` by the preload script via
 * `contextBridge.exposeInMainWorld`. No other Node/Electron primitive is exposed to the
 * renderer — this object is the entire security boundary surface.
 */
export interface GitHydraApi {
  openRepoDialog(): Promise<IpcResult<string | null>>;
  openRepo(path: string): Promise<IpcResult<OpenRepoResult>>;
  /**
   * specs/repo-open-feedback.md FR-163/FR-164/FR-165: cancellable variant of `openRepo`, for the
   * UI's Cancel affordance (FR-167/FR-168) to build on. `requestId` is a caller-generated,
   * caller-unique-per-in-flight-attempt string (e.g. a UUID or an incrementing counter stringified)
   * — it has no meaning beyond correlating this call with a later `cancelOpenRepo(requestId)`
   * call for the SAME attempt, and is never persisted or reused across attempts.
   *
   * Resolves `{ outcome: "cancelled" }` (FR-165: a distinct, third outcome — never a rejected
   * promise, never an `IpcResult` carrying `GitCommandError`/`GitCommandTimeoutError`) if
   * `cancelOpenRepo(requestId)` won the race against this call settling; otherwise resolves
   * `{ outcome: "settled", result }` where `result` is the exact same `IpcResult<OpenRepoResult>`
   * shape `openRepo` itself always returns (success or a genuine error) — so a caller only needs
   * to branch once, on `outcome`, before falling back to `openRepo`'s existing success/error
   * handling unchanged.
   *
   * `openRepo` above is left completely untouched (no `requestId`, never cancellable via this
   * mechanism) for every other existing caller/test — this is a strictly additive surface.
   */
  openRepoCancellable(path: string, requestId: string): Promise<OpenRepoOutcome>;
  /**
   * specs/repo-open-feedback.md FR-163/FR-164: aborts the specific in-flight
   * `openRepoCancellable(path, requestId)` attempt matching `requestId`, terminating its
   * underlying git child process via the same SIGTERM-then-grace-then-SIGKILL escalation used
   * for a timeout (git-core's `armTimeout()`) — never leaves an orphaned OS process behind.
   * Resolves successfully as a no-op if `requestId` doesn't match any currently in-flight attempt
   * (already settled, already cancelled, or never existed) — cancelling is idempotent and safe to
   * call speculatively, no confirmation/preconditions required (FR-9 in the spec's acceptance
   * criteria: no confirmation step).
   */
  cancelOpenRepo(requestId: string): Promise<void>;
  /**
   * specs/repo-list.md (revised IA) / security review: tears down the ONE live main-process
   * session — closes every open commit-log/file-history reader, closes the ref-change file
   * watcher, and clears the live `Repository` — with no new repo replacing it. Every other way
   * a repo stops being "the live one" (`openRepo`/`openRepoCancellable` opening a different path)
   * already tears down the previous session as a side effect of `RepoSession.open()`'s own
   * teardown-then-reopen sequence; this channel exists for the one case that ISN'T immediately
   * followed by a new open — "+ New tab" (deactivates to the idle landing screen) and closing the
   * last remaining tab (`useRepositoryGraph`'s `closeRepo()`, this channel's one caller). Without
   * it, that previous repo's `fs.watch` handle stayed alive for as long as the app sat on the idle
   * screen afterward, firing `refsChangedEvent` into the main process for no live UI to act on.
   * Always resolves `{ ok: true, data: undefined }` — there is nothing about disposing a session
   * that can meaningfully fail; a no-op (no session was open) is not an error.
   */
  closeRepoSession(): Promise<IpcResult<void>>;
  getState(): Promise<IpcResult<RepositoryState>>;
  getRefs(): Promise<IpcResult<RefInfo[]>>;
  createLogReader(filter: CommitLogFilter | undefined): Promise<IpcResult<string>>;
  readPage(readerId: string, count: number): Promise<IpcResult<CommitLogPage>>;
  closeReader(readerId: string): Promise<IpcResult<void>>;
  getCommit(shaOrPrefix: string): Promise<IpcResult<CommitInfo | null>>;
  getChangedFiles(commit: ChangedFilesRequest): Promise<IpcResult<ChangedFile[]>>;
  /**
   * specs/compare-commits.md FR-182: files that differ between two arbitrary, caller-supplied
   * commits — no ancestry relationship required (FR-184). Works against a bare repository (FR-185).
   */
  getChangedFilesBetween(baseSha: string, targetSha: string): Promise<IpcResult<ChangedFile[]>>;
  getWorkingDirStatus(): Promise<IpcResult<WorkingDirectoryStatus | null>>;
  /** Short name of the current branch's upstream (e.g. "origin/main"), or null if none/detached. */
  getUpstreamBranch(): Promise<IpcResult<string | null>>;
  /** Subscribe to best-effort FR-6 ref-change notifications. Returns an unsubscribe function. */
  onRefsChanged(listener: () => void): () => void;

  /** FR-19/FR-28: per-file working-directory change list. `null` for a bare repo. */
  getWorkingDirectoryChanges(): Promise<IpcResult<WorkingDirectoryChanges | null>>;
  /** FR-20(a)/FR-29: unstaged (worktree vs index) diff for a single file. */
  getUnstagedFileDiff(path: string, options?: DiffOptions): Promise<IpcResult<FileDiffResult>>;
  /** FR-20(b)/FR-29: staged (index vs HEAD) diff for a single file. */
  getStagedFileDiff(path: string, options?: DiffOptions): Promise<IpcResult<FileDiffResult>>;
  /** FR-20(c)/FR-29: untracked file diff, shown as all-addition against empty. */
  getUntrackedFileDiff(path: string, options?: DiffOptions): Promise<IpcResult<FileDiffResult>>;
  /** FR-20(d)/FR-29: a historical commit's file diff — closes FR-13's deferred scope. */
  getCommitFileDiff(
    commit: ChangedFilesRequest,
    file: FileRefRequest,
    options?: DiffOptions,
  ): Promise<IpcResult<FileDiffResult>>;
  /**
   * specs/compare-commits.md FR-181/FR-188: an arbitrary two-commit file diff, extending
   * `getChangedFilesBetween()`'s name-status-only comparison to full patch content — the same
   * binary/too-large/patch pipeline `getCommitFileDiff` uses. Works against a bare repository
   * (FR-185).
   */
  getCommitRangeFileDiff(
    baseSha: string,
    targetSha: string,
    file: FileRefRequest,
    options?: DiffOptions,
  ): Promise<IpcResult<FileDiffResult>>;

  // --- image diff preview (specs/image-diff-preview.md FR-142/FR-144) ---
  // Same four bases as the `*FileDiff` methods above, mirrored 1:1 — see `ImageDiffResult`'s own
  // doc comment (git-core) for the "ok"/"too-large" shape. No `DiffOptions`: image content has no
  // hunk-context/changed-line-count guard to configure, only FR-141's fixed 25MB-per-side cap.
  /** FR-142: unstaged (worktree vs index) image-diff content for a single image-eligible file. */
  getUnstagedImageDiff(path: string): Promise<IpcResult<ImageDiffResult>>;
  /** FR-142: staged (index vs HEAD) image-diff content for a single image-eligible file. */
  getStagedImageDiff(path: string): Promise<IpcResult<ImageDiffResult>>;
  /** FR-142: untracked image-eligible file content, shown as an "Added" image with no old side. */
  getUntrackedImageDiff(path: string): Promise<IpcResult<ImageDiffResult>>;
  /** FR-142: a historical commit's image-diff content, mirroring `getCommitFileDiff`'s rename
   * handling via `file.oldPath`. */
  getCommitImageDiff(commit: ChangedFilesRequest, file: FileRefRequest): Promise<IpcResult<ImageDiffResult>>;

  /** FR-23/FR-30: stage a single file (`git add --`). */
  stageFile(path: string): Promise<IpcResult<void>>;
  /** FR-23/FR-30: unstage a single file (`git restore --staged --`); worktree file is untouched. */
  unstageFile(path: string): Promise<IpcResult<void>>;
  /** FR-23/FR-30: stage every eligible (non-conflicted) unstaged/untracked file. */
  stageAllFiles(): Promise<IpcResult<void>>;
  /** FR-23/FR-30: unstage every currently-staged (non-conflicted) file. */
  unstageAllFiles(): Promise<IpcResult<void>>;

  /** FR-24/FR-31: discard a tracked file's working-tree changes. Destructive, unrecoverable —
   * callers must confirm with the user before invoking this (see `ConfirmDialog`). */
  discardTrackedFileChanges(path: string): Promise<IpcResult<void>>;
  /** FR-24/FR-31: delete a single untracked file from disk. Destructive, unrecoverable — same
   * confirm-before-call requirement as `discardTrackedFileChanges`. */
  discardUntrackedFile(path: string): Promise<IpcResult<void>>;

  /** FR-25/FR-32: create a commit from currently-staged content. */
  createCommit(options: CreateCommitOptions): Promise<IpcResult<CreateCommitResult>>;

  /** specs/amend-last-commit.md FR-154: amend HEAD's commit — same `CreateCommitOptions` shape as
   * `createCommit`, folding whatever is currently staged (if anything) into the amended commit. */
  amendCommit(options: CreateCommitOptions): Promise<IpcResult<CreateCommitResult>>;

  /** FR-33: local branches — name, current/checked-out-elsewhere flags, upstream + ahead/behind
   * (captioned as last-known state by the caller, FR-57 — this call never fetches). */
  listBranches(): Promise<IpcResult<LocalBranchInfo[]>>;
  /** FR-34: remote-tracking branches, for use as create/checkout start points. */
  listRemoteBranches(): Promise<IpcResult<RemoteBranchInfo[]>>;
  /** FR-35: validate a proposed branch name (`git check-ref-format --branch`) before the "New
   * Branch" dialog attempts to submit it. Resolves with an error result (never throws) for an
   * invalid name — the caller renders `result.error.message`. */
  validateBranchName(name: string): Promise<IpcResult<void>>;
  /** FR-35/36/37: create a local branch, optionally switching to it immediately and/or wiring
   * tracking to a remote-tracking start point. */
  createBranch(options: CreateBranchOptions): Promise<IpcResult<CreateBranchResult>>;
  /** FR-38: switch the working tree's HEAD to an existing local branch. Never force-discards or
   * auto-stashes — see `BranchSwitchConflictError`. */
  switchBranch(branchName: string): Promise<IpcResult<SwitchResult>>;
  /** FR-39: detached-HEAD checkout of an arbitrary commit-ish (the graph's "Checkout" action). */
  switchToCommit(commitish: string): Promise<IpcResult<SwitchResult>>;
  /** FR-40: safe-delete (`git branch -d`) — throws `BranchNotFullyMergedError` /
   * `BranchCheckedOutError` as typed, specific errors the caller can branch on by `.name`. */
  deleteBranch(branchName: string): Promise<IpcResult<void>>;
  /** FR-41: force-delete (`git branch -D`), discarding unmerged commits. A separate, explicitly-
   * named method — never reachable via the same call as `deleteBranch`. */
  forceDeleteBranch(branchName: string): Promise<IpcResult<void>>;

  // --- merge/rebase conflict resolution (specs/merge-rebase-conflict-resolution.md, FR-58 through FR-80) ---

  /** FR-62/FR-63: every conflicted path's classification and stage content, read fresh from the
   * index on every call (FR-74). `null` for a bare repository. */
  getConflictedFiles(): Promise<IpcResult<ConflictedFileInfo[] | null>>;
  /** FR-64/FR-77/FR-78/FR-80: three-way (base->ours, base->theirs) plus a direct ours->theirs
   * comparison for one already-classified conflicted file. */
  getConflictFileDiff(
    file: Pick<ConflictedFileInfo, "base" | "ours" | "theirs" | "isSubmodule">,
    options?: DiffOptions,
  ): Promise<IpcResult<ConflictFileDiff>>;
  /** FR-61: concrete "your branch"/"incoming" (or "onto"/"your branch" for a rebase) labels for
   * the CURRENT in-progress operation. `null` when there's no in-progress operation, or for
   * `"am"`/`"bisect"`. */
  getConflictSideLabels(): Promise<IpcResult<ConflictSideLabels | null>>;
  /** FR-66: scan a working-tree file for literal, unresolved conflict marker lines — the check
   * every "resolve" action runs before staging anything. */
  scanConflictMarkers(filePath: string): Promise<IpcResult<ConflictMarkerScanResult>>;
  /** FR-65/FR-66/FR-78: whole-file "Accept Ours" (`side: "ours"`) or "Accept Theirs"
   * (`side: "theirs"`) — pair `side` with `getConflictSideLabels()`'s concrete label for display,
   * never the bare words "ours"/"theirs" in UI copy. Throws `ConflictMarkersRemainError` if
   * marker text is somehow still present after checkout. */
  acceptConflictSide(filePath: string, side: "ours" | "theirs"): Promise<IpcResult<void>>;
  /** FR-65/FR-66: "Mark as resolved" for a file the user hand-edited. Throws
   * `ConflictMarkersRemainError` (making no `git add` call) if marker lines remain. */
  markConflictResolved(filePath: string): Promise<IpcResult<void>>;
  /** FR-68/FR-69: abort the current merge/rebase/cherry-pick/revert, restoring the pre-operation
   * branch tip, index, and working tree. `git rebase --quit` is never exposed. Throws
   * `NoOperationInProgressError` if nothing is in progress. Git's own refusal surfaces verbatim
   * (`GitCommandError`), never swallowed or retried. */
  abortInProgressOperation(): Promise<IpcResult<void>>;
  /** FR-70/FR-71: continue the current operation, never spawning an interactive external editor.
   * Throws `ContinueBlockedError` (naming every still-blocking path) if any conflict/marker
   * remains, or `NoOperationInProgressError` if nothing is in progress. */
  continueInProgressOperation(): Promise<IpcResult<void>>;
  /** Opens a repo-relative path with the OS default application ("Open in external editor").
   * Resolves with an error result (never a thrown IPC fault) when the OS itself couldn't open it
   * (e.g. no default handler registered for the file type). */
  openPathInExternalEditor(filePath: string): Promise<IpcResult<void>>;

  // --- stash (specs/stash.md, FR-81 through FR-90) ---

  /** FR-81/FR-82: every entry from `git stash list`, read fresh from disk on every call. `null`
   * for a bare repository (no working directory — matches `getWorkingDirectoryChanges()`'s
   * convention). */
  listStashes(): Promise<IpcResult<StashInfo[] | null>>;
  /** FR-83: the full set of files one stash would change if applied, with diff content per file
   * computed up front. Never touches the working tree or index. `null` for a bare repository,
   * matching `listStashes()`. */
  getStashDiff(index: number, options?: DiffOptions): Promise<IpcResult<StashDiffResult | null>>;
  /** FR-84: `git stash push`. Throws `StashOnUnbornHeadError` on a zero-commit repository, or
   * `NothingEligibleToStashError` when there is nothing eligible (clean working tree, every
   * changed/requested path conflicted, or ANY conflict exists anywhere in the repository). */
  createStash(options?: CreateStashOptions): Promise<IpcResult<CreateStashResult>>;
  /** FR-85/FR-86: `git stash apply stash@{N}` — leaves the stash entry in `git stash list`
   * either way (clean apply or conflict). */
  applyStash(index: number): Promise<IpcResult<StashApplyOutcome>>;
  /** FR-85/FR-87: `git stash pop stash@{N}` — removes the stash entry ONLY on a clean apply;
   * on conflict, behaves identically to `applyStash`, leaving the entry in the list. */
  popStash(index: number): Promise<IpcResult<StashApplyOutcome>>;
  /** FR-88: `git stash drop stash@{N}` — a separate, explicit destructive method, never
   * reachable via `applyStash`/`popStash`. */
  dropStash(index: number): Promise<IpcResult<void>>;

  // --- cherry-pick (specs/cherry-pick.md, FR-103 through FR-110) ---

  /** FR-103/FR-114: `git cherry-pick <sha1> ... <shaN>`, in exactly the order given — the caller
   * (FR-114) is responsible for sorting into graph order before calling this. Resolves once git
   * exits 0 (HEAD advanced by `shas.length` new commits); a paused outcome (a real conflict, or
   * the FR-105 empty-result case) rejects — never distinguished from a genuine failure in the
   * rejection itself, matching `cherryPick()`'s own git-core contract (FR-104) — the caller
   * re-reads `getState()` to tell the two apart. */
  cherryPick(shas: readonly string[]): Promise<IpcResult<void>>;
  /** FR-106: `git cherry-pick --skip` — advance past the currently-paused FR-105 empty-result
   * step with no commit created for it. Throws `CherryPickNotAtEmptyResultError` if the repository
   * isn't genuinely paused on an empty result. */
  skipCherryPickCommit(): Promise<IpcResult<void>>;
  /** FR-106: `git commit --allow-empty`, reusing the paused commit's original message verbatim,
   * then auto-advancing the sequencer if more commits remain queued. Throws
   * `CherryPickNotAtEmptyResultError` if the repository isn't genuinely paused on an empty
   * result. */
  commitEmptyCherryPick(): Promise<IpcResult<void>>;

  // --- blame & file history (specs/blame.md, FR-123 through FR-130) ---

  /** FR-123/124/125/126/127/128: blame `path`, either the current working-tree content
   * (`revision: null` — includes uncommitted edits) or as of a historical commit
   * (`revision: <sha>`). Pure read — never touches HEAD/the index/the working tree. */
  getFileBlame(path: string, revision: string | null): Promise<IpcResult<BlameResult>>;
  /** FR-129: opens a paged `git log --follow` reader over `path`'s history starting at
   * `revision` — same `readPage(count)`/`closeReader(id)` contract as `createLogReader()`'s
   * result; the caller must call `closeReader()` when done. Pre-rename history is included by
   * default. */
  createFileHistoryReader(revision: string, path: string): Promise<IpcResult<string>>;
}
