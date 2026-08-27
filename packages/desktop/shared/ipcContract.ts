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
  RefInfo,
  RepositoryState,
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
}
