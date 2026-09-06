// SPDX-License-Identifier: GPL-3.0-or-later
import { app, BrowserWindow, dialog, ipcMain, screen, shell } from "electron";
import * as os from "node:os";
import * as path from "node:path";
import {
  CherryPickNotAtEmptyResultError,
  CommitHookRejectedError,
  ConflictMarkersRemainError,
  ContinueBlockedError,
  GitCommandError,
  GitCommandTimeoutError,
  GitNotFoundError,
  InvalidArgumentError,
  MissingCommitIdentityError,
  NoOperationInProgressError,
  NotAGitRepositoryError,
  NothingEligibleToStashError,
  NothingStagedError,
  OperationAlreadyInProgressError,
  OperationCancelledError,
  PreExistingConflictError,
  StashOnUnbornHeadError,
  UnsupportedGitVersionError,
  validateBranchName,
  warmUpGitResolution,
  type ChangedFile,
  type ConflictedFileInfo,
  type CreateBranchOptions,
  type CreateCommitOptions,
  type CreateStashOptions,
  type DiffOptions,
} from "@githydra/git-core";
import { RepoSession } from "./repoSession";
import { resolveRepoRelativePath, realpathWithinWorkdir } from "./pathSafety";
import { IPC_CHANNELS, type IpcError, type IpcResult, type OpenRepoOutcome, type OpenRepoResult } from "../shared/ipcContract";
import { debounce, loadWindowBounds, resolveInitialBounds, saveWindowBounds } from "./windowBounds";

// FR-9/AC12: no network calls anywhere. Electron itself may try to reach the internet for
// things unrelated to this app's data (crash reporter, spellcheck dictionary download); turn
// those off explicitly rather than relying on defaults.
app.commandLine.appendSwitch("disable-http-cache");
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = app.isPackaged ? undefined : "true";

const session = new RepoSession();
let mainWindow: BrowserWindow | null = null;

// App-icon integration: electron-builder's Windows/macOS targets embed the app icon
// directly into the .exe/.app bundle (see electron-builder.yml's win.icon/mac.icon), so
// BrowserWindow's own `icon` option barely matters there. Linux has no such
// executable-icon concept, though, so this is the only place a *running* window's
// taskbar icon comes from on that platform — and it's cheap/harmless to set everywhere,
// so it's set unconditionally rather than gated per-platform. Dev (unpackaged) runs read
// straight from the generated build/ output; packaged runs read the copy
// electron-builder's `extraResources` places alongside the app (see electron-builder.yml)
// since build/ itself isn't part of the packaged app.asar.
const windowIconPath = app.isPackaged
  ? path.join(process.resourcesPath, "icons", "512x512.png")
  : path.join(__dirname, "..", "build", "icons", "512x512.png");

function serializeError(err: unknown): IpcError {
  if (
    err instanceof GitCommandError ||
    // A bounded git invocation was force-killed after exceeding its timeout (gitProcess.ts's
    // DEFAULT_GIT_TIMEOUT_MS — most commonly a hung repository hook) — distinguished from a
    // normal GitCommandError so the UI can eventually explain this specifically, rather than
    // showing a raw non-zero-exit message for a process that never actually exited on its own.
    err instanceof GitCommandTimeoutError ||
    err instanceof NotAGitRepositoryError ||
    err instanceof GitNotFoundError ||
    err instanceof UnsupportedGitVersionError ||
    err instanceof InvalidArgumentError ||
    // FR-25: typed create-commit failures — surfaced with their own already-actionable message
    // text (see errors.ts), never swallowed into a generic crash.
    err instanceof NothingStagedError ||
    err instanceof MissingCommitIdentityError ||
    err instanceof CommitHookRejectedError ||
    // specs/amend-last-commit.md FR-149/FR-151: `NoCommitToAmendError`/`AmendBlockedByOperationError`
    // aren't individually named here (unlike their sibling typed errors above) because git-core's
    // `index.ts` doesn't currently re-export them from `errors.ts` — see this repo's "don't touch
    // packages/git-core" constraint for this feature. They still surface correctly: both extend
    // `Error` with an already-actionable `message` (see errors.ts), caught by the generic
    // `err instanceof Error` fallback below, exactly like every other typed git-core error would if
    // it were similarly unlisted.
    // specs/merge-rebase-conflict-resolution.md: typed conflict-resolution failures, surfaced
    // with their own already-actionable message text (errors.ts) — never swallowed.
    err instanceof ConflictMarkersRemainError ||
    err instanceof ContinueBlockedError ||
    err instanceof NoOperationInProgressError ||
    // specs/stash.md FR-84: typed create-stash refusals, surfaced with their own actionable
    // message text (errors.ts) — never swallowed into a generic crash.
    err instanceof NothingEligibleToStashError ||
    err instanceof StashOnUnbornHeadError ||
    // specs/stash.md FR-85/FR-86: applyStash/popStash's pre-flight refusal (security-reviewer
    // finding) — surfaced distinctly from a stash-produced conflict, never folded into it.
    err instanceof PreExistingConflictError ||
    // specs/cherry-pick.md FR-103/FR-106: typed pre-flight refusals — surfaced with their own
    // already-actionable message text (errors.ts), never swallowed into a generic crash.
    err instanceof OperationAlreadyInProgressError ||
    err instanceof CherryPickNotAtEmptyResultError ||
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

  // specs/repo-open-feedback.md FR-163/FR-164/FR-165: cancellable variant of `openRepo` above —
  // `openRepo` itself is completely untouched. `session.open(repoPath, requestId)` threads an
  // `AbortController` (keyed by `requestId`) through to git-core's `Repository.open()`, which
  // threads it further into every underlying `git` invocation the repo-validity check and initial
  // state reads make (see `getRepositoryState()`'s doc comment, git-core's `repository.ts`).
  // `instanceof OperationCancelledError` is checked here on the LIVE (not-yet-IPC-serialized)
  // error — never via a `.name` string comparison after the fact — so this is the single, most
  // direct point to distinguish "the user cancelled" (FR-165's distinct third outcome) from a
  // genuine open failure, before either ever reaches `toResult`/`serializeError`.
  ipcMain.handle(
    IPC_CHANNELS.openRepoCancellable,
    async (_evt, repoPath: string, requestId: string): Promise<OpenRepoOutcome> => {
      try {
        const repo = await session.open(repoPath, requestId);
        session.startWatch(() => {
          mainWindow?.webContents.send(IPC_CHANNELS.refsChangedEvent);
        });
        const data: OpenRepoResult = { path: repoPath, state: repo.getState() };
        return { outcome: "settled", result: { ok: true, data } };
      } catch (err) {
        if (err instanceof OperationCancelledError) return { outcome: "cancelled" };
        return { outcome: "settled", result: { ok: false, error: serializeError(err) } };
      }
    },
  );

  // Deliberately not wrapped in `toResult`/`IpcResult` — see `GitHydraApi.cancelOpenRepo`'s doc
  // comment (`ipcContract.ts`): this is a best-effort, always-succeeds, idempotent signal, not an
  // operation with a meaningful failure mode to surface.
  ipcMain.handle(IPC_CHANNELS.cancelOpenRepo, (_evt, requestId: string) => {
    session.cancelOpen(requestId);
  });

  // specs/repo-list.md (revised IA) / security review: explicit "close the live session, no new
  // repo replacing it" — see `GitHydraApi.closeRepoSession`'s doc comment (`ipcContract.ts`) for
  // the full contract and why this needed its own channel.
  ipcMain.handle(IPC_CHANNELS.closeRepoSession, () =>
    toResult(async () => {
      session.dispose();
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

  // specs/image-diff-preview.md FR-142/FR-144
  ipcMain.handle(IPC_CHANNELS.getUnstagedImageDiff, (_evt, path: string) =>
    toResult(async () => session.getOpenRepo().getUnstagedImageDiff(path)),
  );
  ipcMain.handle(IPC_CHANNELS.getStagedImageDiff, (_evt, path: string) =>
    toResult(async () => session.getOpenRepo().getStagedImageDiff(path)),
  );
  ipcMain.handle(IPC_CHANNELS.getUntrackedImageDiff, (_evt, path: string) =>
    toResult(async () => session.getOpenRepo().getUntrackedImageDiff(path)),
  );
  ipcMain.handle(
    IPC_CHANNELS.getCommitImageDiff,
    (_evt, commit: { sha: string; parents: string[] }, file: Pick<ChangedFile, "path" | "oldPath">) =>
      toResult(async () => session.getOpenRepo().getCommitImageDiff(commit, file)),
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

  // specs/amend-last-commit.md FR-154
  ipcMain.handle(IPC_CHANNELS.amendCommit, (_evt, options: CreateCommitOptions) =>
    toResult(async () => session.getOpenRepo().amendCommit(options)),
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

  // --- cherry-pick (specs/cherry-pick.md, FR-103 through FR-110) ---

  ipcMain.handle(IPC_CHANNELS.cherryPick, (_evt, shas: readonly string[]) =>
    toResult(async () => session.getOpenRepo().cherryPick(shas)),
  );
  ipcMain.handle(IPC_CHANNELS.skipCherryPickCommit, () =>
    toResult(async () => session.getOpenRepo().skipCherryPickCommit()),
  );
  ipcMain.handle(IPC_CHANNELS.commitEmptyCherryPick, () =>
    toResult(async () => session.getOpenRepo().commitEmptyCherryPick()),
  );

  // --- blame & file history (specs/blame.md, FR-123 through FR-130) ---

  ipcMain.handle(IPC_CHANNELS.getFileBlame, (_evt, path: string, revision: string | null) =>
    toResult(async () => session.getOpenRepo().getFileBlame(path, revision)),
  );
  // Reuses the same reader registry (`session.createReader`/`readPage`/`closeReader`) FR-1's
  // `createLogReader` already established — a `CommitPager` is a `CommitPager` regardless of
  // which git-core read path produced it.
  ipcMain.handle(IPC_CHANNELS.createFileHistoryReader, (_evt, revision: string, path: string) =>
    toResult(async () => {
      const reader = await session.getOpenRepo().getFileHistory(revision, path);
      return session.createReader(reader);
    }),
  );
}

function createWindow(): void {
  // Layout-persistence fix: restore the OS window's own size/position/maximized state across
  // relaunches — see windowBounds.ts's module doc comment for the full reasoning. Guarded against
  // an off-screen saved position (e.g. a since-unplugged second monitor) by validating against the
  // CURRENT display arrangement, not just trusting the saved file.
  const userDataPath = app.getPath("userData");
  const savedBounds = loadWindowBounds(userDataPath);
  const displayWorkAreas = screen.getAllDisplays().map((d) => d.workArea);
  const primaryWorkArea = screen.getPrimaryDisplay().workAreaSize;
  const initialBounds = resolveInitialBounds(savedBounds, displayWorkAreas, primaryWorkArea);

  mainWindow = new BrowserWindow({
    x: initialBounds.x,
    y: initialBounds.y,
    width: initialBounds.width,
    height: initialBounds.height,
    minWidth: 880,
    minHeight: 560,
    // Restoring maximized: create hidden at the un-maximized bounds, maximize, then show — avoids
    // a visible "small window snaps to full size" flash on launch.
    show: !initialBounds.isMaximized,
    backgroundColor: "#0d0d0d",
    autoHideMenuBar: true,
    icon: windowIconPath,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  if (initialBounds.isMaximized) {
    mainWindow.maximize();
    mainWindow.show();
  }

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

  // Debounced on resize/move (not a write per pixel of a drag, mirroring useResizableWidth.ts's
  // AC14 "one write per gesture" precedent) — plus one final, immediate, un-debounced save on
  // close so a maximize/restore or a drag that ends right as the window closes isn't lost to a
  // pending debounce timer that never fires.
  const persistBounds = () => {
    if (!mainWindow) return;
    const isMaximized = mainWindow.isMaximized();
    // getNormalBounds() reflects the restored (non-maximized) size/position even while currently
    // maximized — getBounds() would instead capture the full-screen bounds, which is useless as a
    // "restore to this size" value once un-maximized again.
    const normal = mainWindow.getNormalBounds();
    saveWindowBounds(userDataPath, { ...normal, isMaximized });
  };
  const debouncedPersistBounds = debounce(persistBounds, 500);
  mainWindow.on("resize", debouncedPersistBounds);
  mainWindow.on("move", debouncedPersistBounds);
  mainWindow.on("close", persistBounds);

  mainWindow.on("closed", () => {
    mainWindow = null;
    session.dispose();
  });
}

app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();
  // specs/repo-open-feedback.md FR-162: fire-and-forget — never awaited, never on the critical
  // path to the window actually showing (see `warmUpGitResolution`'s own doc comment,
  // git-core's `gitProcess.ts`, for the full investigation finding). `os.tmpdir()` is used rather
  // than any repo-derived path since this runs before the user has opened (or even picked) any
  // repository at all — it only needs to be SOME directory that's guaranteed to exist.
  warmUpGitResolution(os.tmpdir());

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
