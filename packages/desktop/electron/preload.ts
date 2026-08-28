import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS, type GitHydraApi } from "../shared/ipcContract";
import type { DiffOptions } from "@githydra/git-core";

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

  stageFile: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.stageFile, path),
  unstageFile: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.unstageFile, path),
  stageAllFiles: () => ipcRenderer.invoke(IPC_CHANNELS.stageAllFiles),
  unstageAllFiles: () => ipcRenderer.invoke(IPC_CHANNELS.unstageAllFiles),

  discardTrackedFileChanges: (path: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.discardTrackedFileChanges, path),
  discardUntrackedFile: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.discardUntrackedFile, path),

  createCommit: (options) => ipcRenderer.invoke(IPC_CHANNELS.createCommit, options),
};

contextBridge.exposeInMainWorld("gitHydra", api);
