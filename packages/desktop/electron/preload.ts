import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS, type GitHydraApi } from "../shared/ipcContract";
import type { CreateBranchOptions, CreateStashOptions, DiffOptions } from "@githydra/git-core";

/**
 * Security boundary: contextIsolation is on and nodeIntegration is off (see main.ts), so this
 * preload script is the ONLY bridge between the renderer and Node/Electron. It exposes a single
 * narrow, typed object (`window.gitHydra`) with one method per operation the UI needs — never
 * `ipcRenderer` itself, never a generic `invoke(channel, ...)` passthrough (that would let a
 * compromised/malicious renderer script invoke arbitrary main-process handlers). Every argument
 * crossing this boundary is a plain, structured-clone-safe value (strings, numbers, plain
 * objects) — no functions, no class instances.
 */
const api: GitHydraApi = {
  openRepoDialog: () => ipcRenderer.invoke(IPC_CHANNELS.openRepoDialog),
  openRepo: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.openRepo, path),
  // specs/repo-open-feedback.md FR-163/FR-164/FR-165
  openRepoCancellable: (path: string, requestId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.openRepoCancellable, path, requestId),
  cancelOpenRepo: (requestId: string) => ipcRenderer.invoke(IPC_CHANNELS.cancelOpenRepo, requestId),
  // specs/repo-list.md (revised IA) / security review
  closeRepoSession: () => ipcRenderer.invoke(IPC_CHANNELS.closeRepoSession),
  getState: () => ipcRenderer.invoke(IPC_CHANNELS.getState),
  getRefs: () => ipcRenderer.invoke(IPC_CHANNELS.getRefs),
  createLogReader: (filter) => ipcRenderer.invoke(IPC_CHANNELS.createLogReader, filter),
  readPage: (readerId: string, count: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.readPage, readerId, count),
  closeReader: (readerId: string) => ipcRenderer.invoke(IPC_CHANNELS.closeReader, readerId),
  getCommit: (shaOrPrefix: string) => ipcRenderer.invoke(IPC_CHANNELS.getCommit, shaOrPrefix),
  getChangedFiles: (commit) => ipcRenderer.invoke(IPC_CHANNELS.getChangedFiles, commit),
  getWorkingDirStatus: () => ipcRenderer.invoke(IPC_CHANNELS.getWorkingDirStatus),
  getUpstreamBranch: () => ipcRenderer.invoke(IPC_CHANNELS.getUpstreamBranch),
  onRefsChanged: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on(IPC_CHANNELS.refsChangedEvent, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.refsChangedEvent, handler);
  },

  getWorkingDirectoryChanges: () => ipcRenderer.invoke(IPC_CHANNELS.getWorkingDirectoryChanges),
  getUnstagedFileDiff: (path: string, options?: DiffOptions) =>
    ipcRenderer.invoke(IPC_CHANNELS.getUnstagedFileDiff, path, options),
  getStagedFileDiff: (path: string, options?: DiffOptions) =>
    ipcRenderer.invoke(IPC_CHANNELS.getStagedFileDiff, path, options),
  getUntrackedFileDiff: (path: string, options?: DiffOptions) =>
    ipcRenderer.invoke(IPC_CHANNELS.getUntrackedFileDiff, path, options),
  getCommitFileDiff: (commit, file, options?: DiffOptions) =>
    ipcRenderer.invoke(IPC_CHANNELS.getCommitFileDiff, commit, file, options),

  // specs/image-diff-preview.md FR-142/FR-144
  getUnstagedImageDiff: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.getUnstagedImageDiff, path),
  getStagedImageDiff: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.getStagedImageDiff, path),
  getUntrackedImageDiff: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.getUntrackedImageDiff, path),
  getCommitImageDiff: (commit, file) => ipcRenderer.invoke(IPC_CHANNELS.getCommitImageDiff, commit, file),

  stageFile: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.stageFile, path),
  unstageFile: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.unstageFile, path),
  stageAllFiles: () => ipcRenderer.invoke(IPC_CHANNELS.stageAllFiles),
  unstageAllFiles: () => ipcRenderer.invoke(IPC_CHANNELS.unstageAllFiles),

  discardTrackedFileChanges: (path: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.discardTrackedFileChanges, path),
  discardUntrackedFile: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.discardUntrackedFile, path),

  createCommit: (options) => ipcRenderer.invoke(IPC_CHANNELS.createCommit, options),
  amendCommit: (options) => ipcRenderer.invoke(IPC_CHANNELS.amendCommit, options),

  listBranches: () => ipcRenderer.invoke(IPC_CHANNELS.listBranches),
  listRemoteBranches: () => ipcRenderer.invoke(IPC_CHANNELS.listRemoteBranches),
  validateBranchName: (name: string) => ipcRenderer.invoke(IPC_CHANNELS.validateBranchName, name),
  createBranch: (options: CreateBranchOptions) => ipcRenderer.invoke(IPC_CHANNELS.createBranch, options),
  switchBranch: (branchName: string) => ipcRenderer.invoke(IPC_CHANNELS.switchBranch, branchName),
  switchToCommit: (commitish: string) => ipcRenderer.invoke(IPC_CHANNELS.switchToCommit, commitish),
  deleteBranch: (branchName: string) => ipcRenderer.invoke(IPC_CHANNELS.deleteBranch, branchName),
  forceDeleteBranch: (branchName: string) => ipcRenderer.invoke(IPC_CHANNELS.forceDeleteBranch, branchName),

  getConflictedFiles: () => ipcRenderer.invoke(IPC_CHANNELS.getConflictedFiles),
  getConflictFileDiff: (file, options?: DiffOptions) =>
    ipcRenderer.invoke(IPC_CHANNELS.getConflictFileDiff, file, options),
  getConflictSideLabels: () => ipcRenderer.invoke(IPC_CHANNELS.getConflictSideLabels),
  scanConflictMarkers: (filePath: string) => ipcRenderer.invoke(IPC_CHANNELS.scanConflictMarkers, filePath),
  acceptConflictSide: (filePath: string, side: "ours" | "theirs") =>
    ipcRenderer.invoke(IPC_CHANNELS.acceptConflictSide, filePath, side),
  markConflictResolved: (filePath: string) => ipcRenderer.invoke(IPC_CHANNELS.markConflictResolved, filePath),
  abortInProgressOperation: () => ipcRenderer.invoke(IPC_CHANNELS.abortInProgressOperation),
  continueInProgressOperation: () => ipcRenderer.invoke(IPC_CHANNELS.continueInProgressOperation),
  openPathInExternalEditor: (filePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.openPathInExternalEditor, filePath),

  listStashes: () => ipcRenderer.invoke(IPC_CHANNELS.listStashes),
  getStashDiff: (index: number, options?: DiffOptions) =>
    ipcRenderer.invoke(IPC_CHANNELS.getStashDiff, index, options),
  createStash: (options?: CreateStashOptions) => ipcRenderer.invoke(IPC_CHANNELS.createStash, options),
  applyStash: (index: number) => ipcRenderer.invoke(IPC_CHANNELS.applyStash, index),
  popStash: (index: number) => ipcRenderer.invoke(IPC_CHANNELS.popStash, index),
  dropStash: (index: number) => ipcRenderer.invoke(IPC_CHANNELS.dropStash, index),

  cherryPick: (shas: readonly string[]) => ipcRenderer.invoke(IPC_CHANNELS.cherryPick, shas),
  skipCherryPickCommit: () => ipcRenderer.invoke(IPC_CHANNELS.skipCherryPickCommit),
  commitEmptyCherryPick: () => ipcRenderer.invoke(IPC_CHANNELS.commitEmptyCherryPick),

  getFileBlame: (path: string, revision: string | null) =>
    ipcRenderer.invoke(IPC_CHANNELS.getFileBlame, path, revision),
  createFileHistoryReader: (revision: string, path: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.createFileHistoryReader, revision, path),
};

contextBridge.exposeInMainWorld("gitHydra", api);
