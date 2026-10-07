// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The full IPC surface between the renderer (contextIsolation on, nodeIntegration off) and the
 * main process. Shared by `electron/` and `src/`, so it must stay free of Node-only imports.
 */
import type {
  BlameResult,
  ChangedFile,
  CloneResult,
  CommitInfo,
  CommitLogFilter,
  CommitLogPage,
  CommitPairRelationship,
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
  FetchAllRemotesResult,
  FetchProgressEvent,
  ApplyIdentityProfileOptions,
  BulkDiscardCandidate,
  BulkDiscardResult,
  BulkDiscardRow,
  BulkFingerprintResult,
  BulkRow,
  BulkStageResult,
  CombinedFileDiffResult,
  CombinedLineRef,
  ExpectedIdentityApplication,
  DiscardAllPlan,
  DiscardPreviewRow,
  EditProbeResult,
  EditReadResult,
  LineEnding,
  WriteEditedFileResult,
  FileDiffResult,
  IdentityConfigState,
  IgnoreReport,
  IgnoreScope,
  IgnoreTarget,
  ImageDiffResult,
  LocalBranchInfo,
  OrphanedHeadResult,
  PullOutcome,
  PullStrategy,
  PushOutcome,
  RefInfo,
  RemoteBranchInfo,
  RemoveIdentityProfileResult,
  RepositoryState,
  ResetMode,
  ResumeCommitLogFrom,
  StashApplyOutcome,
  StashDiffResult,
  StashInfo,
  SwitchResult,
  WorkingDirectoryChanges,
} from "@githydra/git-core";

/** specs/ignore-and-multiselect.md FR-494/FR-495/FR-500: the renderer's ignore request; main rebuilds it field by field. */
export interface IgnoreIpcRequest {
  /** Row paths as listed by status; a trailing `/` marks a directory row (an untracked nested repo). */
  paths: string[];
  scope: IgnoreScope;
  target: IgnoreTarget;
  /** REQUIRED by `ignoreAndStopTracking` (main refuses without it): the untrack paths the user previewed (planIgnore's
   * `stopTracking.paths`). git-core rejects with "IgnorePlanChangedError" (code IGNORE_PLAN_CHANGED) when the set differs now.
   * Not used by `ignorePaths`/`planIgnore`. */
  expectedUntrackPaths?: string[];
}

/**
 * specs/branch-panel-drag-merge.md FR-430: optional HEAD-binding for `switchBranch`/`switchToCommit`.
 * When `expectedDetachedHeadSha` is set (the `headSha` from the `getOrphanedHeadCommits()` result
 * the user confirmed), the main process re-verifies inside the same queued mutation that HEAD is
 * still detached at exactly that commit, else the call fails with `HeadMovedError` (error `.name`
 * === "HeadMovedError") and NOTHING is changed - re-query and re-confirm rather than retrying.
 * `createBranch({ switchToIt: true, expectedDetachedHeadSha })` accepts the same field.
 */
export interface GuardedSwitchIpcOptions {
  expectedDetachedHeadSha?: string;
}

export const IPC_CHANNELS = {
  openRepoDialog: "repo:openDialog",
  openRepo: "repo:open",
  // specs/repo-open-feedback.md FR-163/FR-164/FR-165: cancellable `openRepo` (see its doc below).
  openRepoCancellable: "repo:openCancellable",
  cancelOpenRepo: "repo:openCancel",
  // specs/repo-open-feedback-fixes.md FR-197/FR-199: close out a cancellable open attempt (see
  // `commitOpenRepo`/`endOpenAttempt` below).
  commitOpenRepo: "repo:openCommit",
  endOpenAttempt: "repo:openEnd",
  // specs/repo-list.md / security review: tear down the live session with no replacement (see
  // `closeRepoSession`).
  closeRepoSession: "repo:closeSession",
  getState: "repo:getState",
  getRefs: "repo:getRefs",
  createLogReader: "repo:createLogReader",
  readPage: "repo:readPage",
  closeReader: "repo:closeReader",
  getCommit: "repo:getCommit",
  getChangedFiles: "repo:getChangedFiles",
  // specs/compare-commits.md FR-182/FR-188: two-arbitrary-commit variants of the commit diff calls.
  getChangedFilesBetween: "repo:getChangedFilesBetween",
  getCommitRangeFileDiff: "repo:getCommitRangeFileDiff",
  getWorkingDirStatus: "repo:getWorkingDirStatus",
  getUpstreamBranch: "repo:getUpstreamBranch",
  refsChangedEvent: "repo:refsChanged",
  // specs/live-refresh.md FR-458: working-tree change notifications, distinct from refsChangedEvent so a file
  // save never re-reads refs. Sent by electron/main.ts from git-core's worktree watcher; carries no payload.
  worktreeChangedEvent: "repo:worktreeChanged",
  // FR-19/FR-28: per-file working-directory change list (Staged/Unstaged/Untracked/Conflicted).
  getWorkingDirectoryChanges: "repo:getWorkingDirectoryChanges",
  // FR-20/FR-21/FR-22/FR-29: diff content for each of the four bases the spec defines.
  getUnstagedFileDiff: "repo:getUnstagedFileDiff",
  getStagedFileDiff: "repo:getStagedFileDiff",
  getUntrackedFileDiff: "repo:getUntrackedFileDiff",
  getCommitFileDiff: "repo:getCommitFileDiff",
  // specs/image-diff-preview.md FR-142/FR-144: mirrors the four `*FileDiff` channels 1:1.
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
  getDiscardFingerprint: "repo:getDiscardFingerprint",
  // specs/hunk-line-staging.md FR-479/FR-480/FR-478: the combined (checkbox-model) diff and its line toggles.
  getCombinedFileDiff: "repo:getCombinedFileDiff",
  toggleCombinedLines: "repo:toggleCombinedLines",
  discardCombinedLines: "repo:discardCombinedLines",
  // specs/ignore-and-multiselect.md FR-494..FR-509: ignore rules, bulk stage/unstage, guarded bulk discard.
  planIgnore: "repo:planIgnore",
  ignorePaths: "repo:ignorePaths",
  ignoreAndStopTracking: "repo:ignoreAndStopTracking",
  stagePaths: "repo:stagePaths",
  unstagePaths: "repo:unstagePaths",
  getBulkDiscardFingerprints: "repo:getBulkDiscardFingerprints",
  bulkDiscard: "repo:bulkDiscard",
  planDiscardAll: "repo:planDiscardAll",
  getDiscardPreview: "repo:getDiscardPreview",
  discardAllChanges: "repo:discardAllChanges",
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
  // specs/branch-panel-drag-merge.md FR-430: detached-HEAD orphan guard (read-only query + save path).
  getOrphanedHeadCommits: "repo:getOrphanedHeadCommits",
  createBranchAtCommit: "repo:createBranchAtCommit",
  // FR-40/41: separate channels so force-delete is never reachable via the normal delete path.
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
  // Main-process-only (shell.openPath); same path-containment discipline as git-core's fs operations.
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
  // specs/drag-commit-menu.md, FR-295 through FR-319.
  computeCommitPairRelationship: "repo:computeCommitPairRelationship",
  mergeCommit: "repo:mergeCommit",
  rebaseCommitOnto: "repo:rebaseCommitOnto",
  // specs/online-sync-fetch.md FR-326/FR-327: cancellable via `requestId` (like `openRepoCancellable`)
  // plus a main-to-renderer progress event channel.
  fetchAllRemotes: "repo:fetchAllRemotes",
  cancelFetch: "repo:fetchCancel",
  fetchProgressEvent: "repo:fetchProgress",
  // specs/online-sync-pull.md FR-338 through FR-343: same shape; progress only carries pull's
  // internal fetch phase.
  pull: "repo:pull",
  cancelPull: "repo:pullCancel",
  pullProgressEvent: "repo:pullProgress",
  // specs/online-sync-push.md FR-344 through FR-350: same shape; reuses `runNetworkGitProcess()` (FR-348).
  push: "repo:push",
  cancelPush: "repo:pushCancel",
  pushProgressEvent: "repo:pushProgress",
  // specs/online-sync-clone.md FR-351 through FR-358: same shape; reuses `runNetworkGitProcess()`
  // (FR-354). NOT repo-scoped: creates a new repository at an arbitrary destination.
  clone: "repo:clone",
  cancelClone: "repo:cloneCancel",
  cloneProgressEvent: "repo:cloneProgress",
  // FR-345: remote picker data source; wraps git-core's standalone `listConfiguredRemotes()` (local config read).
  listConfiguredRemotes: "repo:listConfiguredRemotes",
  // specs/reset-to-here.md, FR-359 through FR-377.
  resetCurrentBranch: "repo:resetCurrentBranch",
  countCommitsExclusiveToHead: "repo:countCommitsExclusiveToHead",
  // specs/git-identity-profiles.md, FR-329 through FR-337.
  getIdentityConfigState: "repo:getIdentityConfigState",
  applyIdentityProfile: "repo:applyIdentityProfile",
  removeIdentityProfileApplication: "repo:removeIdentityProfileApplication",
  // FR-332: not repo-scoped (no `session.getOpenRepo()` call in its handler) — the profile library
  // itself doesn't require any repo to be open.
  pickSshIdentityFile: "app:pickSshIdentityFile",
  // specs/edit-in-diff.md FR-468/FR-471/FR-474: the working copy of one text file; exactly these three, nothing generic.
  probeEditableFile: "repo:probeEditableFile",
  readEditableFile: "repo:readEditableFile",
  writeEditedFile: "repo:writeEditedFile",
} as const;

/** specs/edit-in-diff.md FR-471: renderer-side cap on `content` (UTF-16 units); git-core still enforces the exact 1 MB on the encoded bytes. 2x leaves room for CRLF-to-LF shrink. */
export const MAX_EDIT_CONTENT_CHARS = 2 * 1024 * 1024;
export const MAX_EDIT_PATH_CHARS = 4096;

/** specs/edit-in-diff.md FR-537: why an edit call failed, with no paths or raw errors. "no-repository" and "invalid-argument" are the caller's bug. */
export type EditIpcFailureCode =
  | "invalid-argument"
  | "no-repository"
  | "read-only"
  | "content-too-large"
  | "contains-nul"
  | "invalid-content"
  | "io"
  | "access"
  | "internal";

/** Deliberately not `IpcResult`: the failure carries a closed code plus fixed text, never an error name, stderr or path. */
export type EditIpcResult<T> = { ok: true; data: T } | { ok: false; code: EditIpcFailureCode; message: string };

/** FR-471/FR-474 write options; `expectedHash` is the `contentHash` of the last read/write (64 lowercase hex chars). */
export interface WriteEditedFileIpcOptions {
  expectedHash: string;
  eol: LineEnding;
  hasBom: boolean;
  finalNewline: boolean;
  force?: boolean;
}

/** Minimal, structured-clone-safe serialization of git-core's typed Error classes. */
export interface IpcError {
  name: string;
  message: string;
  /**
   * specs/online-sync-push.md FR-346: set only for a real `GitCommandError` — its credential-redacted
   * stderr, which `classifyGitNetworkError()` needs. Omitted for every other error kind.
   */
  stderr?: string;
  /**
   * specs/ignore-and-multiselect.md: the typed error's own `code` (e.g. "STALE_DIFF", "BULK_STAGING_FAILED"), when it has one.
   */
  code?: string;
  /**
   * specs/ignore-and-multiselect.md FR-507/FR-508/FR-500: plain, structured-clone-safe fields of the new bulk errors
   * (StaleBatchError.paths, BulkStagingError.changed/unchanged, IgnoreUntrackError.rolledBack/ruleFilesLeftModified,
   * IgnoreFileChangedError.file). Whitelisted per class in main.ts, never a blind copy of the error object.
   */
  details?: Record<string, unknown>;
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcError };

export interface OpenRepoResult {
  /**
   * specs/repo-open-feedback-fixes.md FR-202: git's resolved repository root (`RepositoryState.workdir`),
   * not the raw picked path; equals `pickedPath` for a bare repo. Consumers should key off this.
   */
  path: string;
  /** FR-202/FR-204: the raw path the caller supplied, kept so UI can show "picked X, resolved to Y". */
  pickedPath: string;
  state: RepositoryState;
}

/**
 * specs/repo-open-feedback.md FR-165: `openRepoCancellable`'s result. Cancellation is a distinct
 * third outcome (not a synthetic `IpcResult` error) so callers branch on `outcome`, not an error name.
 */
export type OpenRepoOutcome =
  | { outcome: "settled"; result: IpcResult<OpenRepoResult> }
  | { outcome: "cancelled" };

/** specs/online-sync-fetch.md FR-322/FR-327: same distinct-cancelled convention as `OpenRepoOutcome`. */
export type FetchOutcome =
  | { outcome: "settled"; result: IpcResult<FetchAllRemotesResult> }
  | { outcome: "cancelled" };

/**
 * specs/online-sync-pull.md FR-338/FR-343: same convention as `FetchOutcome`. `ok: false` includes a
 * paused merge/rebase conflict (FR-338: indistinguishable from drag-menu Merge/Rebase); callers tell
 * it from a refusal by re-reading `getState()` (see `usePullAction.ts`).
 */
export type PullIpcOutcome =
  | { outcome: "settled"; result: IpcResult<PullOutcome> }
  | { outcome: "cancelled" };

/**
 * specs/online-sync-push.md FR-344/FR-348: same convention as `FetchOutcome`. A non-fast-forward
 * rejection (FR-346) is detected by classifying `result.error.stderr`.
 */
export type PushIpcOutcome =
  | { outcome: "settled"; result: IpcResult<PushOutcome> }
  | { outcome: "cancelled" };

/**
 * specs/online-sync-clone.md FR-352/FR-354: same convention as `FetchOutcome`. `ok: false` includes the
 * FR-353 "destination not empty" refusal and FR-357 credential failures (both via `error.stderr`).
 */
export type CloneIpcOutcome =
  | { outcome: "settled"; result: IpcResult<CloneResult> }
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
   * specs/repo-open-feedback.md FR-163/FR-164/FR-165: cancellable `openRepo`. `requestId` is a
   * caller-generated id, unique per in-flight attempt, correlating this call with
   * `cancelOpenRepo(requestId)`. Resolves `{ outcome: "cancelled" }` if the cancel won the race (never
   * a rejection); otherwise `{ outcome: "settled", result }` with `openRepo`'s own result.
   */
  openRepoCancellable(path: string, requestId: string): Promise<OpenRepoOutcome>;
  /**
   * specs/repo-open-feedback.md FR-163/FR-164: aborts the matching in-flight attempt, killing its git
   * child via SIGTERM-then-SIGKILL (git-core's `armTimeout()`). Idempotent no-op for an unknown
   * `requestId`; no confirmation needed.
   */
  cancelOpenRepo(requestId: string): Promise<void>;
  /**
   * specs/repo-open-feedback-fixes.md FR-197/FR-199: promotes `requestId`'s pending repo to the live
   * session (tearing down the previous one only now) and starts its ref watcher. Call only after every
   * later phase of the same attempt (each passed `requestId`) succeeded. No-op if nothing is staged for
   * `requestId`; always resolves `{ ok: true }`. Must be followed by `endOpenAttempt(requestId)`.
   */
  commitOpenRepo(requestId: string): Promise<IpcResult<void>>;
  /**
   * specs/repo-open-feedback-fixes.md FR-197: releases `requestId`'s cancellation signal and any
   * uncommitted pending repo/reader. Call exactly once per attempt, unconditionally (e.g. `finally`),
   * or the bookkeeping leaks. Idempotent; safe for an unknown `requestId`.
   */
  endOpenAttempt(requestId: string): Promise<void>;
  /**
   * specs/repo-list.md / security review: tears down the live session (readers, ref watcher,
   * `Repository`) with no replacement. Needed for "+ New tab" and closing the last tab, which
   * `openRepo`'s own teardown doesn't cover; otherwise the old repo's `fs.watch` stays alive on the
   * idle screen. Always resolves `{ ok: true }`; no session open is not an error.
   */
  closeRepoSession(): Promise<IpcResult<void>>;
  getState(): Promise<IpcResult<RepositoryState>>;
  /**
   * specs/repo-open-feedback-fixes.md FR-197: `requestId`, when supplied, is the caller's in-flight
   * cancellable open attempt — resolves against its pending repo and is abortable via its signal until
   * `commitOpenRepo`/`endOpenAttempt`. Other callers omit it.
   */
  getRefs(requestId?: string): Promise<IpcResult<RefInfo[]>>;
  /**
   * specs/instant-tab-revisit.md FR-245: `resumeAfter` fast-forwards the new reader past
   * `resumeAfter.skip` cached commits (verified against `resumeAfter.sha`), so its first `readPage()`
   * returns what would otherwise be page two. Rejects with error `.name` "ReaderResumeMismatchError" if
   * the position doesn't match — callers fall back to a full reload (FR-243), never retry or toast.
   */
  createLogReader(
    filter: CommitLogFilter | undefined,
    requestId?: string,
    resumeAfter?: ResumeCommitLogFrom,
  ): Promise<IpcResult<string>>;
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
  /** Short name of the current branch's upstream (e.g. "origin/main"), or null if none/detached.
   * `requestId`: see `getRefs`. */
  getUpstreamBranch(requestId?: string): Promise<IpcResult<string | null>>;
  /** Subscribe to best-effort FR-6 ref-change notifications. Returns an unsubscribe function. */
  onRefsChanged(listener: () => void): () => void;
  /**
   * specs/live-refresh.md FR-458: best-effort working-tree change notifications (git-core's recursive tree watch).
   * Optional: absent or silent where the platform/watch isn't available; the Changes list then still refreshes on
   * window focus regain and index writes (FR-458 (1)/(2)).
   */
  onWorktreeChanged?(listener: () => void): () => void;

  /** FR-19/FR-28: per-file working-directory change list. `null` for a bare repo.
   * `requestId`: see `getRefs`. */
  getWorkingDirectoryChanges(requestId?: string): Promise<IpcResult<WorkingDirectoryChanges | null>>;
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
   * specs/compare-commits.md FR-181/FR-188: full-patch diff of one file between two arbitrary commits
   * (same pipeline as `getCommitFileDiff`). Works against a bare repository (FR-185).
   */
  getCommitRangeFileDiff(
    baseSha: string,
    targetSha: string,
    file: FileRefRequest,
    options?: DiffOptions,
  ): Promise<IpcResult<FileDiffResult>>;

  // --- image diff preview (specs/image-diff-preview.md FR-142/FR-144) ---
  // Mirrors the four `*FileDiff` methods; no `DiffOptions` (only FR-141's fixed 25MB-per-side cap).
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
  discardTrackedFileChanges(path: string, expectedFingerprint: string): Promise<IpcResult<void>>;
  /** FR-24/FR-31: delete a single untracked file from disk. Destructive, unrecoverable — same
   * confirm-before-call requirement as `discardTrackedFileChanges`. */
  discardUntrackedFile(path: string, expectedFingerprint: string): Promise<IpcResult<void>>;
  /**
   * Whole-file discard guard (security review H1): the fingerprint to pass as `expectedFingerprint`, read when the user
   * opens the confirmation. The discard rejects with error `.name` "StaleDiffError" (file changed; nothing touched),
   * "DiscardFingerprintError" (could not be verified; refused) or "DiscardBackupError" (safety copy failed; refused).
   */
  getDiscardFingerprint(path: string, kind: "tracked" | "untracked"): Promise<IpcResult<string>>;

  /**
   * specs/hunk-line-staging.md FR-479/FR-481: HEAD-vs-worktree diff of one file with a per-line `staged`
   * flag, or `{ mode: "separate", reason }` when the UI must fall back to the separate Staged/Unstaged diffs.
   * Read-only. Deliberately no `contextLines` option.
   */
  getCombinedFileDiff(path: string): Promise<IpcResult<CombinedFileDiffResult>>;
  /**
   * FR-480: stage or unstage `lines` of the combined diff as one atomic apply. `fingerprint` is the
   * combined diff's. Rejects with error `.name` "StaleDiffError" (nothing changed; reload, never retry),
   * "PartialStagingIneligibleError" (`reason` "ambiguous" included), "InvalidArgumentError" or
   * "GitCommandError". Lines already in the target state are skipped by git-core.
   */
  toggleCombinedLines(
    path: string,
    fingerprint: string,
    lines: CombinedLineRef[],
    target: "stage" | "unstage",
  ): Promise<IpcResult<void>>;
  /** FR-478/FR-455: discard unstaged combined-diff lines from the worktree (index untouched). Destructive,
   * unrecoverable - callers must confirm first. Also rejects with "LinesNotDiscardableError". */
  discardCombinedLines(path: string, fingerprint: string, lines: CombinedLineRef[]): Promise<IpcResult<void>>;

  // --- specs/ignore-and-multiselect.md ---
  /** FR-494..FR-500 preview: rules, target files, refusals and (with `stopTracking`) the untrack counts. Reads only. */
  planIgnore(req: IgnoreIpcRequest & { stopTracking?: boolean }): Promise<IpcResult<IgnoreReport>>;
  /** FR-494..FR-498: append one rule per row to the chosen target in a single read-modify-write. Rejects with
   * "IgnoreFileChangedError" (nothing written) or other typed errors. */
  ignorePaths(req: IgnoreIpcRequest): Promise<IpcResult<IgnoreReport>>;
  /** FR-500: ignorePaths, then untrack exactly the selected tracked files (worktree untouched). Rejects with
   * "IgnoreUntrackError" (`details.rolledBack`, `details.ruleFilesLeftModified`) when untracking failed. */
  ignoreAndStopTracking(req: IgnoreIpcRequest): Promise<IpcResult<IgnoreReport>>;
  /** FR-507: bulk stage in one queued operation; ineligible rows come back in `skipped`. Rejects with
   * "BulkStagingError" (`details.changed`/`details.unchanged`). */
  stagePaths(rows: BulkRow[]): Promise<IpcResult<BulkStageResult>>;
  /** FR-507: bulk unstage of Staged rows (worktree untouched). */
  unstagePaths(rows: BulkRow[]): Promise<IpcResult<BulkStageResult>>;
  /** FR-508: one fingerprint per candidate row, read when the confirmation opens. */
  getBulkDiscardFingerprints(rows: BulkDiscardCandidate[]): Promise<IpcResult<BulkFingerprintResult[]>>;
  /** FR-508: guarded bulk discard. Every row MUST carry the fingerprint from `getBulkDiscardFingerprints`. Rejects with
   * "StaleBatchError" (`details.paths`; nothing changed) when any file changed since. Destructive: confirm first. */
  bulkDiscard(rows: BulkDiscardRow[]): Promise<IpcResult<BulkDiscardResult>>;
  /** FR-509: snapshot for "Discard all changes" (rows with fingerprints, skipped, counts). Reads only. */
  planDiscardAll(): Promise<IpcResult<DiscardAllPlan>>;
  /** specs/ignore-and-multiselect.md FR-521: +/- line counts for the files a discard dialog lists (at most 50 paths). Reads only. */
  getDiscardPreview(paths: string[]): Promise<IpcResult<DiscardPreviewRow[]>>;
  /** FR-509: run the confirmed snapshot; untracked rows only when `includeUntracked`. Destructive: confirm first. */
  discardAllChanges(rows: BulkDiscardRow[], includeUntracked: boolean): Promise<IpcResult<BulkDiscardResult>>;

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
  switchBranch(branchName: string, options?: GuardedSwitchIpcOptions): Promise<IpcResult<SwitchResult>>;
  /** FR-39: detached-HEAD checkout of an arbitrary commit-ish (the graph's "Checkout" action). */
  switchToCommit(commitish: string, options?: GuardedSwitchIpcOptions): Promise<IpcResult<SwitchResult>>;
  /**
   * specs/branch-panel-drag-merge.md FR-430: which commits would be left behind if the current
   * detached HEAD were left now? Read-only. The result is ALWAYS delivered as `ok: true` (git
   * failures are folded into `status: "unknown"` by git-core). The renderer MUST treat
   * `status: "unknown"` exactly like `"orphaned"` (ask the user) and only skip the dialog for
   * `status: "none"`. Commit subjects arrive already sanitized/truncated. Operates on the repo the
   * main process has open - no path argument.
   */
  getOrphanedHeadCommits(): Promise<IpcResult<OrphanedHeadResult>>;
  /**
   * specs/branch-panel-drag-merge.md FR-430: create local branch `name` at commit `sha` (a full
   * 40/64-char lowercase hex id, e.g. `OrphanedHeadResult.headSha`) WITHOUT switching. Deliberately
   * narrower than `createBranch` (no free-form start point). Errors: `InvalidRefNameError` (bad or
   * already-existing name), `InvalidArgumentError` (bad/unknown sha), `BranchCreationFailedError`;
   * none carries git stderr or a path.
   */
  createBranchAtCommit(name: string, sha: string): Promise<IpcResult<CreateBranchResult>>;
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

  /** FR-81/FR-82: every `git stash list` entry, read fresh. `null` for a bare repo. `requestId`: see
   * `getRefs` (specs/repo-open-feedback-fixes.md FR-197). */
  listStashes(requestId?: string): Promise<IpcResult<StashInfo[] | null>>;
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

  // --- drag-commit contextual action menu (specs/drag-commit-menu.md, FR-295 through FR-319) ---

  /** FR-295/303: the drag-drop menu's ancestry classification for a distinct commit pair —
   * called exactly once, at drop time (never during the drag itself, never on hover). Works
   * against a bare repository (no `requireWorkdir` call in git-core — matches FR-17's "Compare
   * remains fully usable on a bare repo" requirement). */
  computeCommitPairRelationship(shaA: string, shaB: string): Promise<IpcResult<CommitPairRelationship>>;
  /** FR-297/FR-312: `git merge <otherSha>` against current HEAD. A clean fast-forward/merge
   * commit and a paused conflict are indistinguishable from this call's own settlement alone —
   * the caller re-reads `getState()` afterward, exactly like `cherryPick()`. */
  mergeCommit(otherSha: string): Promise<IpcResult<void>>;
  /** FR-298/FR-313: `git rebase <newBaseSha>` against current HEAD, git's plain non-interactive
   * form. Same "re-read state afterward" contract as `mergeCommit`. */
  rebaseCommitOnto(newBaseSha: string): Promise<IpcResult<void>>;

  // --- fetch (specs/online-sync-fetch.md, FR-320 through FR-328) ---

  /**
   * FR-321/FR-327: IPC wrapper over git-core's `fetchAllRemotes()`. `requestId` is a caller-generated,
   * per-attempt-unique id (as in `openRepoCancellable`) correlating `cancelFetch` and `onFetchProgress`
   * events. Resolves `{ outcome: "cancelled" }` if the cancel won the race; else `settled`, where
   * `ok: false` means only a transport failure (e.g. no repo open) — one remote's failure is an entry
   * in `result.data.outcomes` (FR-321), never collapsed into a single error.
   */
  fetchAllRemotes(requestId: string): Promise<FetchOutcome>;
  /**
   * FR-322: aborts the matching in-flight fetch (SIGTERM-then-SIGKILL on the running remote's child).
   * Idempotent no-op for an unknown `requestId`. Remotes already fetched keep their updated refs.
   */
  cancelFetch(requestId: string): Promise<void>;
  /**
   * FR-322: subscribe to progress for every in-flight fetch. Events carry their `requestId` so a
   * listener can ignore cancelled/superseded attempts. Returns an unsubscribe function.
   */
  onFetchProgress(listener: (requestId: string, event: FetchProgressEvent) => void): () => void;

  // --- pull (specs/online-sync-pull.md, FR-338 through FR-343) ---

  /**
   * FR-338/FR-339: git-core's `pull()` on the active repo — fetch upstream, then fast-forward or
   * merge/rebase. `options.strategy` is FR-339's per-pull override; omitted, git-core resolves
   * `branch.<name>.rebase`/`pull.rebase` like real `git pull` (neither key is ever written).
   * Cancellable like `fetchAllRemotes`, but only the fetch phase (see `PullOptions.signal`).
   * `ok: false` includes a paused conflict; re-read `getState()` to tell it from a refusal (FR-338).
   */
  pull(requestId: string, options?: { strategy?: PullStrategy }): Promise<PullIpcOutcome>;
  /**
   * FR-339: aborts the in-flight pull's fetch phase; same idempotent no-op contract as `cancelFetch`.
   * After the fetch completes, the local integrate step isn't cancellable, so a late cancel is a no-op.
   */
  cancelPull(requestId: string): Promise<void>;
  /** FR-339: progress for every in-flight pull's fetch phase; same shape as `onFetchProgress`. */
  onPullProgress(listener: (requestId: string, event: FetchProgressEvent) => void): () => void;

  // --- push (specs/online-sync-push.md, FR-344 through FR-350) ---

  /**
   * FR-345: every remote name `git remote` lists, in git's order — feeds the remote picker (shown only
   * with more than one remote). Local-config read, no network.
   */
  listConfiguredRemotes(): Promise<IpcResult<string[]>>;
  /**
   * FR-344/FR-345: git-core's `push(remoteName, localBranchName)`. Pushes to the branch's configured
   * upstream on `remoteName` if one exists (explicit `<local>:<upstream>` refspec), else publishes via
   * `--set-upstream`. Same cancellable/progress convention as fetch/pull, reusing
   * `runNetworkGitProcess()` (FR-348). `ok: false` includes a non-fast-forward rejection (FR-346):
   * classify `result.error.stderr` with `classifyGitNetworkError()`.
   *
   * The signature is deliberately closed — no force/delete/tags/all/mirror option can be threaded
   * through (specs/online-sync-push.md Non-goals; `noForcePush.test.ts`).
   */
  push(requestId: string, remoteName: string, localBranchName: string): Promise<PushIpcOutcome>;
  /** FR-348: aborts the in-flight push; same idempotent no-op contract as `cancelFetch`. */
  cancelPush(requestId: string): Promise<void>;
  /** FR-348: progress for every in-flight push; same shape as `onFetchProgress`. */
  onPushProgress(listener: (requestId: string, event: FetchProgressEvent) => void): () => void;

  // --- clone (specs/online-sync-clone.md, FR-351 through FR-358) ---

  /**
   * FR-352: git-core's `clone(url, destination)` — two positional args only (no
   * `--depth`/`--recurse-submodules`/`--mirror`/`--bare`, per the spec's Non-goals). Same
   * cancellable/progress convention as fetch/pull/push (FR-354). NOT scoped to an open repo.
   *
   * FR-353: `ok: false` includes git's refusal when `destination` has files (verbatim in
   * `error.stderr`/`.message`; never merged or overwritten). FR-355: cancel deletes `destination` only
   * if this call created it (tracked by git-core, not inferred from emptiness). FR-357: credential
   * failures classify via `classifyGitNetworkError()` on `error.stderr`.
   * On success `result.data.path` is the resolved absolute destination.
   */
  clone(requestId: string, url: string, destination: string): Promise<CloneIpcOutcome>;
  /** FR-354: aborts the in-flight clone; same idempotent no-op contract as `cancelFetch`. */
  cancelClone(requestId: string): Promise<void>;
  /** FR-354: progress for every in-flight clone; same shape as `onFetchProgress`. */
  onCloneProgress(listener: (requestId: string, event: FetchProgressEvent) => void): () => void;

  // --- reset current branch/HEAD to here (specs/reset-to-here.md, FR-359 through FR-377) ---

  /**
   * FR-359: move current `HEAD` (attached or detached) to `targetSha` via exactly one of
   * `git reset --soft/--mixed/--hard`; `mode` is always explicit, there's no target-branch parameter.
   * Throws `InvalidArgumentError` for a malformed `targetSha` (FR-361) and
   * `OperationAlreadyInProgressError` (no git call made) mid merge/rebase/cherry-pick/revert/am/bisect
   * (FR-360). No bare-repo/unborn-HEAD check here — the UI (FR-366) gates those.
   */
  resetCurrentBranch(targetSha: string, mode: ResetMode): Promise<IpcResult<void>>;
  /**
   * FR-364: `git rev-list --count <targetSha>..<headSha>`, a read-only preview for FR-368. Never
   * rejects for ordinary failures (bad SHA, shallow boundary): resolves `{ ok: true, data: null }`
   * ("unknown") so the dialog falls back to non-numeric wording.
   */
  countCommitsExclusiveToHead(targetSha: string, headSha: string): Promise<IpcResult<number | null>>;

  // --- git identity & SSH key profiles (specs/git-identity-profiles.md, FR-329 through FR-337) ---

  /**
   * FR-335: the active repo's local/global/GitHydra-managed `user.name`, `user.email`, and
   * `core.sshCommand`, read fresh each call.
   *
   * security-reviewer finding: `knownApplication` (the renderer's `useIdentityApplications.ts`
   * localStorage record, or `null`) is the ONLY trust source for "GitHydra-managed" — never the repo's
   * own `.git/config`, which may come from an untrusted source (e.g. a zip).
   */
  getIdentityConfigState(
    knownApplication: ExpectedIdentityApplication | null,
  ): Promise<IpcResult<IdentityConfigState>>;
  /**
   * FR-330/FR-331/FR-333: applies a profile to the active repo's LOCAL git config only. Throws
   * `InvalidArgumentError` (naming the offending character, AC3) for an invalid `sshIdentityFilePath`
   * (FR-333, incl. Windows UNC paths) and `UnmanagedIdentityConfigConflictError` when it would overwrite
   * a value `options.knownApplication` doesn't account for and `options.force` isn't true (FR-334) —
   * both before any write. Re-call with `force: true` only after explicit user confirmation of that
   * error's `.message`.
   */
  applyIdentityProfile(options: ApplyIdentityProfileOptions): Promise<IpcResult<void>>;
  /**
   * FR-336: unsets exactly the local keys `knownApplication` accounts for — never user/other-tool keys,
   * global config, or anything decided by the repo's own `.git/config` (see `getIdentityConfigState`).
   * A no-op (empty `removedKeys`) when `knownApplication` is `null` or matches nothing.
   */
  removeIdentityProfileApplication(
    knownApplication: ExpectedIdentityApplication | null,
  ): Promise<IpcResult<RemoveIdentityProfileResult>>;
  /** FR-332: the ONLY way an SSH identity-file path ever enters this app — a native OS "open file"
   * dialog, never a free-text field. Resolves `null` if the user cancels. Not repo-scoped: usable
   * while building/editing a profile in the library regardless of whether any repo is open. */
  pickSshIdentityFile(): Promise<IpcResult<string | null>>;

  // --- edit in diff (specs/edit-in-diff.md FR-468/FR-471/FR-474/FR-536) ---

  /** FR-468: can this repo-relative path be edited? Ineligibility is a normal `ok: true` data value with a reason. Read-only. */
  probeEditableFile(path: string): Promise<EditIpcResult<EditProbeResult>>;
  /** FR-468/FR-474: the verbatim text plus `contentHash`/`eol`/`hasBom`/`finalNewline` to hand back to `writeEditedFile`. Read-only. */
  readEditableFile(path: string): Promise<EditIpcResult<EditReadResult>>;
  /**
   * FR-471/FR-474/FR-536: atomic, hash-guarded save of the working copy; never touches the index. Branch on `data.status`:
   * "written" (record `contentHash`), "changed-on-disk" (confirm, then re-call with `force: true`), "ineligible".
   * A successful save is registered as a self-write in main, so it raises no external-change event; refresh the diff/Changes list yourself (FR-475).
   */
  writeEditedFile(path: string, content: string, options: WriteEditedFileIpcOptions): Promise<EditIpcResult<WriteEditedFileResult>>;
}
