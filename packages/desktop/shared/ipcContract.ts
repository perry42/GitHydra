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
