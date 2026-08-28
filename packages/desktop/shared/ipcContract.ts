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
  CreateCommitOptions,
  CreateCommitResult,
  DiffOptions,
  FileDiffResult,
  RefInfo,
  RepositoryState,
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
}
