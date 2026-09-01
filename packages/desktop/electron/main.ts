import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import * as path from "node:path";
import {
  CommitHookRejectedError,
  ConflictMarkersRemainError,
  ContinueBlockedError,
  GitCommandError,
  GitNotFoundError,
  InvalidArgumentError,
  MissingCommitIdentityError,
  NoOperationInProgressError,
  NotAGitRepositoryError,
  NothingEligibleToStashError,
  NothingStagedError,
  StashOnUnbornHeadError,
  UnsupportedGitVersionError,
  validateBranchName,
  type ChangedFile,
  type ConflictedFileInfo,
  type CreateBranchOptions,
  type CreateCommitOptions,
  type CreateStashOptions,
  type DiffOptions,
} from "@githydra/git-core";
import { RepoSession } from "./repoSession";
import { resolveRepoRelativePath, realpathWithinWorkdir } from "./pathSafety";
import { IPC_CHANNELS, type IpcError, type IpcResult } from "../shared/ipcContract";

// FR-9/AC12: no network calls anywhere. Electron itself may try to reach the internet for
// things unrelated to this app's data (crash reporter, spellcheck dictionary download); turn
// those off explicitly rather than relying on defaults.
app.commandLine.appendSwitch("disable-http-cache");
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = app.isPackaged ? undefined : "true";

const session = new RepoSession();
let mainWindow: BrowserWindow | null = null;

function serializeError(err: unknown): IpcError {
  if (
    err instanceof GitCommandError ||
    err instanceof NotAGitRepositoryError ||
    err instanceof GitNotFoundError ||
    err instanceof UnsupportedGitVersionError ||
    err instanceof InvalidArgumentError ||
    // FR-25: typed create-commit failures — surfaced with their own already-actionable message
    // text (see errors.ts), never swallowed into a generic crash.
    err instanceof NothingStagedError ||
    err instanceof MissingCommitIdentityError ||
    err instanceof CommitHookRejectedError ||
    // specs/merge-rebase-conflict-resolution.md: typed conflict-resolution failures, surfaced
    // with their own already-actionable message text (errors.ts) — never swallowed.
    err instanceof ConflictMarkersRemainError ||
    err instanceof ContinueBlockedError ||
    err instanceof NoOperationInProgressError ||
    // specs/stash.md FR-84: typed create-stash refusals, surfaced with their own actionable
    // message text (errors.ts) — never swallowed into a generic crash.
    err instanceof NothingEligibleToStashError ||
    err instanceof StashOnUnbornHeadError ||
    err instanceof Error
  ) {
    return { name: err.name, message: err.message };
  }
  return { name: "UnknownError", message: String(err) };
}

async function toResult<T>(work: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    return { ok: true, data: await work() };
  } catch (err) {
    return { ok: false, error: serializeError(err) };
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.openRepoDialog, () =>
    toResult(async () => {
      if (!mainWindow) return null;
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ["openDirectory", "showHiddenFiles"],
        title: "Open a git repository",
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0] ?? null;
    }),
  );

  ipcMain.handle(IPC_CHANNELS.openRepo, (_evt, repoPath: string) =>
    toResult(async () => {
      const repo = await session.open(repoPath);
      session.startWatch(() => {
        mainWindow?.webContents.send(IPC_CHANNELS.refsChangedEvent);
      });
      return { path: repoPath, state: repo.getState() };
    }),
  );

  // FR-56: a live re-read (`refreshState()`), not the cached snapshot from `open()`/
  // `Repository.getState()` — this is the only caller of this channel (the renderer's
  // `refreshRefs()`, run after every branch create/switch/delete), and `Repository.state` is
  // otherwise only ever updated by a full `openRepo` round-trip. Without this, the Toolbar's
  // current-branch indicator and the graph's HEAD decoration would keep showing the branch that
  // was current when the repo was first opened, even after a real `git switch` succeeded on
  // disk — `listBranches()`/`listRemoteBranches()` don't have this problem since they call the
  // stateless `getRepositoryState()` fresh on every invocation instead of reading a cached field.
  ipcMain.handle(IPC_CHANNELS.getState, () =>
    toResult(async () => session.getOpenRepo().refreshState()),
  );

  ipcMain.handle(IPC_CHANNELS.getRefs, () =>
    toResult(async () => session.getOpenRepo().getRefs()),
  );

  ipcMain.handle(IPC_CHANNELS.createLogReader, (_evt, filter) =>
    toResult(async () => {
      const reader = await session.getOpenRepo().createCommitLogReader(filter);
      return session.createReader(reader);
    }),
  );

  ipcMain.handle(IPC_CHANNELS.readPage, (_evt, readerId: string, count: number) =>
    toResult(async () => session.getReader(readerId).readPage(count)),
  );

  ipcMain.handle(IPC_CHANNELS.closeReader, (_evt, readerId: string) =>
    toResult(async () => {
      session.closeReader(readerId);
    }),
  );

  ipcMain.handle(IPC_CHANNELS.getCommit, (_evt, shaOrPrefix: string) =>
    toResult(async () => session.getOpenRepo().getCommit(shaOrPrefix)),
  );

  ipcMain.handle(IPC_CHANNELS.getChangedFiles, (_evt, commit: { sha: string; parents: string[] }) =>
    toResult(async () => session.getOpenRepo().getChangedFiles(commit)),
  );

  ipcMain.handle(IPC_CHANNELS.getWorkingDirStatus, () =>
    toResult(async () => session.getWorkingDirectoryStatus()),
  );

  ipcMain.handle(IPC_CHANNELS.getUpstreamBranch, () =>
    toResult(async () => session.getUpstreamBranch()),
  );

  // FR-19/FR-28
  ipcMain.handle(IPC_CHANNELS.getWorkingDirectoryChanges, () =>
    toResult(async () => session.getOpenRepo().getWorkingDirectoryChanges()),
  );

  // FR-20/FR-21/FR-22/FR-29
  ipcMain.handle(IPC_CHANNELS.getUnstagedFileDiff, (_evt, path: string, options?: DiffOptions) =>
    toResult(async () => session.getOpenRepo().getUnstagedFileDiff(path, options)),
  );
  ipcMain.handle(IPC_CHANNELS.getStagedFileDiff, (_evt, path: string, options?: DiffOptions) =>
    toResult(async () => session.getOpenRepo().getStagedFileDiff(path, options)),
  );
  ipcMain.handle(IPC_CHANNELS.getUntrackedFileDiff, (_evt, path: string, options?: DiffOptions) =>
    toResult(async () => session.getOpenRepo().getUntrackedFileDiff(path, options)),
  );
  ipcMain.handle(
    IPC_CHANNELS.getCommitFileDiff,
    (
      _evt,
      commit: { sha: string; parents: string[] },
      file: Pick<ChangedFile, "path" | "oldPath">,
      options?: DiffOptions,
    ) => toResult(async () => session.getOpenRepo().getCommitFileDiff(commit, file, options)),
  );

  // FR-23/FR-30
  ipcMain.handle(IPC_CHANNELS.stageFile, (_evt, path: string) =>
    toResult(async () => session.getOpenRepo().stageFile(path)),
  );
  ipcMain.handle(IPC_CHANNELS.unstageFile, (_evt, path: string) =>
    toResult(async () => session.getOpenRepo().unstageFile(path)),
  );
  ipcMain.handle(IPC_CHANNELS.stageAllFiles, () =>
    toResult(async () => session.getOpenRepo().stageAllFiles()),
  );
  ipcMain.handle(IPC_CHANNELS.unstageAllFiles, () =>
    toResult(async () => session.getOpenRepo().unstageAllFiles()),
  );

  // FR-24/FR-31 — destructive; the renderer is responsible for confirming with the user first.
  ipcMain.handle(IPC_CHANNELS.discardTrackedFileChanges, (_evt, path: string) =>
    toResult(async () => session.getOpenRepo().discardTrackedFileChanges(path)),
  );
  ipcMain.handle(IPC_CHANNELS.discardUntrackedFile, (_evt, path: string) =>
    toResult(async () => session.getOpenRepo().discardUntrackedFile(path)),
  );

  // FR-25/FR-32
  ipcMain.handle(IPC_CHANNELS.createCommit, (_evt, options: CreateCommitOptions) =>
    toResult(async () => session.getOpenRepo().createCommit(options)),
  );

  // FR-33/FR-34: branch listing.
  ipcMain.handle(IPC_CHANNELS.listBranches, () =>
    toResult(async () => session.getOpenRepo().listBranches()),
  );
  ipcMain.handle(IPC_CHANNELS.listRemoteBranches, () =>
    toResult(async () => session.getOpenRepo().listRemoteBranches()),
  );

  // FR-35: standalone (not a Repository method) — validate before any mutating call is attempted.
  ipcMain.handle(IPC_CHANNELS.validateBranchName, (_evt, name: string) =>
    toResult(async () => validateBranchName(session.getOpenRepo().path, name)),
  );

  // FR-35/36/37
  ipcMain.handle(IPC_CHANNELS.createBranch, (_evt, options: CreateBranchOptions) =>
    toResult(async () => session.getOpenRepo().createBranch(options)),
  );

  // FR-38/39 — the renderer is responsible for confirming with the user first where the spec
  // requires it (delete); switch/checkout have no confirmation requirement of their own.
  ipcMain.handle(IPC_CHANNELS.switchBranch, (_evt, branchName: string) =>
    toResult(async () => session.getOpenRepo().switchBranch(branchName)),
  );
  ipcMain.handle(IPC_CHANNELS.switchToCommit, (_evt, commitish: string) =>
    toResult(async () => session.getOpenRepo().switchToCommit(commitish)),
  );

  // FR-40/41 — kept as two distinct channels/handlers, exactly mirroring `git-core`'s separation,
  // so force-delete is never reachable from the same IPC call as a normal delete.
  ipcMain.handle(IPC_CHANNELS.deleteBranch, (_evt, branchName: string) =>
    toResult(async () => session.getOpenRepo().deleteBranch(branchName)),
  );
  ipcMain.handle(IPC_CHANNELS.forceDeleteBranch, (_evt, branchName: string) =>
    toResult(async () => session.getOpenRepo().forceDeleteBranch(branchName)),
  );

  // --- merge/rebase conflict resolution (specs/merge-rebase-conflict-resolution.md, FR-58 through FR-80) ---

  ipcMain.handle(IPC_CHANNELS.getConflictedFiles, () =>
    toResult(async () => session.getOpenRepo().getConflictedFiles()),
  );
  ipcMain.handle(
    IPC_CHANNELS.getConflictFileDiff,
    (_evt, file: Pick<ConflictedFileInfo, "base" | "ours" | "theirs" | "isSubmodule">, options?: DiffOptions) =>
      toResult(async () => session.getOpenRepo().getConflictFileDiff(file, options)),
  );
  ipcMain.handle(IPC_CHANNELS.getConflictSideLabels, () =>
    toResult(async () => session.getOpenRepo().getConflictSideLabels()),
  );
  ipcMain.handle(IPC_CHANNELS.scanConflictMarkers, (_evt, filePath: string) =>
    toResult(async () => session.getOpenRepo().scanConflictMarkers(filePath)),
  );
  ipcMain.handle(IPC_CHANNELS.acceptConflictSide, (_evt, filePath: string, side: "ours" | "theirs") =>
    toResult(async () => session.getOpenRepo().acceptConflictSide(filePath, side)),
  );
  ipcMain.handle(IPC_CHANNELS.markConflictResolved, (_evt, filePath: string) =>
    toResult(async () => session.getOpenRepo().markConflictResolved(filePath)),
  );
  ipcMain.handle(IPC_CHANNELS.abortInProgressOperation, () =>
    toResult(async () => session.getOpenRepo().abortInProgressOperation()),
  );
  ipcMain.handle(IPC_CHANNELS.continueInProgressOperation, () =>
    toResult(async () => session.getOpenRepo().continueInProgressOperation()),
  );
  // "Open in external editor" — a main-process-only affordance (no git-core equivalent): resolves
  // the caller-supplied repo-relative path against the open repo's workdir with the same path-
  // containment check every git-core filesystem-touching operation uses, then hands it to the OS
  // default application via shell.openPath. shell.openPath resolves with a non-empty string (an
  // OS-level failure reason, e.g. "no application associated") instead of throwing — surfaced
  // here as a real error rather than a silent no-op.
  //
  // security-reviewer finding: `resolveRepoRelativePath`'s containment check is textual only, so
  // it can't see a conflicted path whose working-tree entry is a symlink (git blob mode 120000)
  // pointing outside the repo — `shell.openPath` follows symlinks and can execute them for some
  // file types. `realpathWithinWorkdir` re-verifies containment against the resolved realpath
  // (catching an intermediate symlinked directory too) before shell.openPath ever sees the path;
  // it throws rather than falling back, so a symlink escape is refused, not silently opened.
  ipcMain.handle(IPC_CHANNELS.openPathInExternalEditor, (_evt, filePath: string) =>
    toResult(async () => {
      const state = session.getOpenRepo().getState();
      if (!state.workdir) {
        throw new InvalidArgumentError("Cannot open a file — this repository has no working directory.");
      }
      const absolutePath = resolveRepoRelativePath(state.workdir, filePath);
      const realPath = await realpathWithinWorkdir(state.workdir, absolutePath);
      const failureReason = await shell.openPath(realPath);
      if (failureReason) {
        throw new GitCommandError(`Could not open "${filePath}" in an external application: ${failureReason}`, [], null, failureReason);
      }
    }),
  );

  // --- stash (specs/stash.md, FR-81 through FR-90) ---

  ipcMain.handle(IPC_CHANNELS.listStashes, () =>
    toResult(async () => session.getOpenRepo().listStashes()),
  );
  ipcMain.handle(IPC_CHANNELS.getStashDiff, (_evt, index: number, options?: DiffOptions) =>
    toResult(async () => session.getOpenRepo().getStashDiff(index, options)),
  );
  ipcMain.handle(IPC_CHANNELS.createStash, (_evt, options?: CreateStashOptions) =>
    toResult(async () => session.getOpenRepo().createStash(options)),
  );
  ipcMain.handle(IPC_CHANNELS.applyStash, (_evt, index: number) =>
    toResult(async () => session.getOpenRepo().applyStash(index)),
  );
  ipcMain.handle(IPC_CHANNELS.popStash, (_evt, index: number) =>
    toResult(async () => session.getOpenRepo().popStash(index)),
  );
  // FR-88 — kept as its own explicit channel/handler, never reachable from the same call as
  // applyStash/popStash, mirroring deleteBranch/forceDeleteBranch's separation above.
  ipcMain.handle(IPC_CHANNELS.dropStash, (_evt, index: number) =>
    toResult(async () => session.getOpenRepo().dropStash(index)),
  );
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 880,
    minHeight: 560,
    backgroundColor: "#0d0d0d",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  // Open any external link (e.g. a future "view on host" affordance) in the OS browser rather
  // than navigating this window or spawning a new Electron BrowserWindow.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
    session.dispose();
  });
}

app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  session.dispose();
  if (process.platform !== "darwin") app.quit();
});

// Defense in depth against FR-9/AC12 (no network calls): deny any renderer navigation away from
// our own bundled index.html/dev-server origin, and deny arbitrary new-window creation.
app.on("web-contents-created", (_event, contents) => {
  contents.on("will-navigate", (navigationEvent, url) => {
    const devServerUrl = process.env.VITE_DEV_SERVER_URL;
    const allowed = devServerUrl ? url.startsWith(devServerUrl) : url.startsWith("file://");
    if (!allowed) navigationEvent.preventDefault();
  });
});
