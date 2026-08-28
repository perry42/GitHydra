/**
 * The full IPC surface between the renderer (untrusted-by-policy, contextIsolation on,
 * nodeIntegration off) and the Electron main process (which alone talks to @githydra/git-core
 * and the filesystem). Both `electron/` and `src/` import this file — it must stay free of
 * Node-only imports (no `child_process`, `fs`, `electron`) so it's safe to bundle into the
 * renderer too.
 */
import type {
  ChangedFile,
  CommitInfo,
  CommitLogFilter,
  CommitLogPage,
  CreateBranchOptions,
  CreateBranchResult,
  CreateCommitOptions,
  CreateCommitResult,
  DiffOptions,
  FileDiffResult,
  LocalBranchInfo,
  RefInfo,
  RemoteBranchInfo,
  RepositoryState,
  SwitchResult,
  WorkingDirectoryChanges,
} from "@githydra/git-core";

export const IPC_CHANNELS = {
  openRepoDialog: "repo:openDialog",
  openRepo: "repo:open",
  getState: "repo:getState",
  getRefs: "repo:getRefs",
  createLogReader: "repo:createLogReader",
  readPage: "repo:readPage",
  closeReader: "repo:closeReader",
  getCommit: "repo:getCommit",
  getChangedFiles: "repo:getChangedFiles",
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
  getState(): Promise<IpcResult<RepositoryState>>;
  getRefs(): Promise<IpcResult<RefInfo[]>>;
  createLogReader(filter: CommitLogFilter | undefined): Promise<IpcResult<string>>;
  readPage(readerId: string, count: number): Promise<IpcResult<CommitLogPage>>;
  closeReader(readerId: string): Promise<IpcResult<void>>;
  getCommit(shaOrPrefix: string): Promise<IpcResult<CommitInfo | null>>;
  getChangedFiles(commit: ChangedFilesRequest): Promise<IpcResult<ChangedFile[]>>;
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
}
