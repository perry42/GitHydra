// SPDX-License-Identifier: GPL-3.0-or-later
import { app, BrowserWindow, dialog, ipcMain, Menu, screen, shell, type MenuItemConstructorOptions } from "electron";
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
import { looksLikeSamePath } from "../shared/pathEquivalence";
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

/**
 * specs/repo-open-feedback-fixes.md FR-202/FR-203: the path recorded for a successful open —
 * git's own resolved toplevel (`RepositoryState.workdir`) for an ordinary repository, but ONLY
 * when it genuinely diverges from the raw caller-supplied `pickedPath` (e.g. the user picked a
 * subfolder of a larger repo's working tree — a normal, frequent case, not an error): AC7
 * requires the non-divergent common case to render exactly as it always has, including the
 * original path's own spelling — so this deliberately does NOT unconditionally prefer `workdir`,
 * which would otherwise cosmetically reformat every ordinary open's displayed path (e.g. to
 * forward slashes on Windows) even when nothing about the resolved directory actually changed. A
 * bare repository has no separate working directory to resolve to, so `pickedPath` is used
 * unchanged, matching this app's existing bare-repo behavior everywhere else.
 */
function resolveOpenedPath(pickedPath: string, state: { isBare: boolean; workdir: string | null }): string {
  if (state.isBare || !state.workdir) return pickedPath;
  if (looksLikeSamePath(pickedPath, state.workdir)) return pickedPath;
  return state.workdir;
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
      const state = repo.getState();
      // specs/repo-open-feedback-fixes.md FR-202/FR-203
      return { path: resolveOpenedPath(repoPath, state), pickedPath: repoPath, state };
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
  //
  // specs/repo-open-feedback-fixes.md FR-197/FR-199: unlike before, this handler deliberately does
  // NOT call `session.startWatch()`/commit anything to the live session anymore — `session.open()`
  // with a `requestId` only STAGES the newly-opened repo (see `RepoSession.open()`'s own doc
  // comment); the renderer's `openRepo()` only calls `commitOpenRepo` (below) once the ENTIRE
  // sequence — this call, plus the aux-data reads and log-reader creation/first page it issues
  // afterward for the same `requestId` — has actually succeeded. This is what makes a cancellation
  // landing during those LATER phases roll back cleanly: the previous session's repo/readers/
  // watcher are never touched at all until that final commit.
  ipcMain.handle(
    IPC_CHANNELS.openRepoCancellable,
    async (_evt, repoPath: string, requestId: string): Promise<OpenRepoOutcome> => {
      try {
        const repo = await session.open(repoPath, requestId);
        const state = repo.getState();
        // specs/repo-open-feedback-fixes.md FR-202/FR-203
        const data: OpenRepoResult = { path: resolveOpenedPath(repoPath, state), pickedPath: repoPath, state };
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

  // specs/repo-open-feedback-fixes.md FR-197/FR-199: promotes `requestId`'s staged-but-not-yet-live
  // repo (from `openRepoCancellable` above) to the live session, and only NOW starts its
  // ref-change watcher — called by the renderer once every phase of the open sequence (the
  // repo-validity check above, plus the aux-data reads and log-reader creation/first page it
  // issues afterward) has succeeded. `session.commitOpen()` is a safe no-op (never throws) if
  // `requestId` has nothing staged (e.g. the attempt was cancelled or superseded before reaching
  // this point) — see its own doc comment.
  ipcMain.handle(IPC_CHANNELS.commitOpenRepo, (_evt, requestId: string) =>
    toResult(async () => {
      const committed = session.commitOpen(requestId);
      if (committed) {
        session.startWatch(() => {
          mainWindow?.webContents.send(IPC_CHANNELS.refsChangedEvent);
        });
      }
    }),
  );

  // specs/repo-open-feedback-fixes.md FR-197: releases every piece of `requestId`'s cancellation/
  // pending-repo/pending-reader bookkeeping (see `RepoSession.endOpenAttempt()`) once the
  // renderer's own `openRepo()` attempt has genuinely settled — success (always called AFTER
  // `commitOpenRepo` on that path too, as a harmless no-op), a genuine error anywhere in the
  // sequence, a cancellation at any phase, or an attempt superseded by a newer one before it even
  // finished the repo-validity check. Deliberately not wrapped in `toResult`/`IpcResult`, same
  // convention as `cancelOpenRepo` — a best-effort, always-succeeds, idempotent cleanup call with
  // no meaningful failure mode to surface.
  ipcMain.handle(IPC_CHANNELS.endOpenAttempt, (_evt, requestId: string) => {
    session.endOpenAttempt(requestId);
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

  // specs/repo-open-feedback-fixes.md FR-197: `requestId`, when supplied — always by
  // `useRepositoryGraph.ts`'s `refreshAuxData`, only while it's part of a still-in-flight
  // cancellable `openRepo` attempt — resolves against that attempt's own (possibly still-pending,
  // not-yet-committed) repo via `getOpenRepoFor`, and makes the call abortable via `getOpenSignal`.
  // Every other, non-open-sequence caller omits it and gets today's exact behavior unchanged.
  ipcMain.handle(IPC_CHANNELS.getRefs, (_evt, requestId?: string) =>
    toResult(async () => session.getOpenRepoFor(requestId).getRefs(session.getOpenSignal(requestId))),
  );

  ipcMain.handle(IPC_CHANNELS.createLogReader, (_evt, filter, requestId?: string) =>
    toResult(async () => {
      const reader = await session
        .getOpenRepoFor(requestId)
        .createCommitLogReader(filter, session.getOpenSignal(requestId));
      return session.createReader(reader, requestId);
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

  // specs/compare-commits.md FR-182
  ipcMain.handle(IPC_CHANNELS.getChangedFilesBetween, (_evt, baseSha: string, targetSha: string) =>
    toResult(async () => session.getOpenRepo().getChangedFilesBetween(baseSha, targetSha)),
  );

  ipcMain.handle(IPC_CHANNELS.getWorkingDirStatus, () =>
    toResult(async () => session.getWorkingDirectoryStatus()),
  );

  // specs/repo-open-feedback-fixes.md FR-197: see `getRefs`'s comment above — same optional
  // open-attempt `requestId` convention.
  ipcMain.handle(IPC_CHANNELS.getUpstreamBranch, (_evt, requestId?: string) =>
    toResult(async () =>
      session.getOpenRepoFor(requestId).getUpstreamBranch(session.getOpenSignal(requestId)),
    ),
  );

  // FR-19/FR-28. specs/repo-open-feedback-fixes.md FR-197: same optional `requestId` convention.
  ipcMain.handle(IPC_CHANNELS.getWorkingDirectoryChanges, (_evt, requestId?: string) =>
    toResult(async () =>
      session.getOpenRepoFor(requestId).getWorkingDirectoryChanges(session.getOpenSignal(requestId)),
    ),
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

  // specs/compare-commits.md FR-181
  ipcMain.handle(
    IPC_CHANNELS.getCommitRangeFileDiff,
    (
      _evt,
      baseSha: string,
      targetSha: string,
      file: Pick<ChangedFile, "path" | "oldPath">,
      options?: DiffOptions,
    ) => toResult(async () => session.getOpenRepo().getCommitRangeFileDiff(baseSha, targetSha, file, options)),
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

  // specs/repo-open-feedback-fixes.md FR-197: same optional `requestId` convention as `getRefs`.
  ipcMain.handle(IPC_CHANNELS.listStashes, (_evt, requestId?: string) =>
    toResult(async () => session.getOpenRepoFor(requestId).listStashes(session.getOpenSignal(requestId))),
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

/**
 * specs/keyboard-shortcuts-command-palette.md FR-226/AC7 support fix: this app never calls
 * `Menu.setApplicationMenu()` (see the `render-process-gone` handler's own doc comment below,
 * which already flagged this), so Electron's built-in DEFAULT application menu is still fully
 * active — `autoHideMenuBar: true` on the `BrowserWindow` only hides the menu BAR from view, it
 * does not disable the menu or its accelerators. That default menu's "View" submenu binds
 * Ctrl+R/Cmd+R to Reload and Ctrl+Shift+R/Cmd+Shift+R to Force Reload — both of which would
 * otherwise silently win the native-accelerator race against this feature's own Ctrl/Cmd+R
 * "Refresh commit graph" keybinding (`useGlobalKeybindings.ts`) and reload the entire renderer,
 * discarding every bit of in-memory app state. Verified by inspecting Electron's own default-menu
 * template — this isn't a new gap this feature introduces, but shipping Ctrl+R as an in-app
 * keybinding without addressing it would make AC7 fail in exactly the case it exists to cover.
 *
 * This template preserves every other role Electron's default menu offers (the standard macOS app
 * menu, Edit's clipboard/undo roles — needed for Cmd+C/Cmd+V to keep working in text inputs on
 * macOS, which isn't automatic without an Edit menu — DevTools/zoom/fullscreen, and the Window
 * menu) and only drops the two Reload accelerators.
 */
function buildApplicationMenu(): Menu {
  const isMac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: "appMenu" as const }] : []),
    { role: "editMenu" as const },
    {
      label: "View",
      submenu: [
        { role: "toggleDevTools" as const },
        { type: "separator" as const },
        { role: "resetZoom" as const },
        { role: "zoomIn" as const },
        { role: "zoomOut" as const },
        { type: "separator" as const },
        { role: "togglefullscreen" as const },
      ],
    },
    { role: "windowMenu" as const },
  ];
  return Menu.buildFromTemplate(template);
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

  // security-reviewer finding (specs/repo-open-feedback-fixes.md follow-up): a renderer crash
  // replaces the renderer's entire JS context without ever firing `BrowserWindow`'s `"closed"`
  // event below. (Previously this could also happen via an ordinary Ctrl+R/Cmd+R reload — Electron's
  // default application menu's built-in Reload accelerator was still fully active despite
  // `autoHideMenuBar: true` above only hiding the menu BAR, not the menu itself. Fixed by
  // `buildApplicationMenu`'s custom menu — specs/keyboard-shortcuts-command-palette.md FR-226/AC7 —
  // which drops the Reload/Force Reload accelerators entirely, so this scenario is now genuinely a
  // crash, not routine window-chrome-key-combo behavior. Kept as unconditional defense in depth
  // regardless, since a crash is still possible.)
  // `useRepositoryGraph.ts`'s `openRepo()` only cleans up `RepoSession`'s per-`requestId`
  // bookkeeping (`openAbortControllers`/`pendingRepos`/`pendingReaderIds`, including a live
  // `CommitLogReader` child process during the `startReader` phase) via a `finally` block that
  // depends on that same JS context surviving long enough to run — a crash or reload mid-open
  // skips it entirely, leaking that bookkeeping (and any still-running `git log` child process)
  // for the rest of the app's lifetime. Route both cases through the exact same `session.dispose()`
  // teardown `"closed"`/`"window-all-closed"` already use below, rather than inventing a second
  // cleanup path — `dispose()` is idempotent and safe to call speculatively (see its own doc
  // comment), so calling it here even when nothing was in flight is harmless.
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    // details.reason: "crashed" | "oom" | "killed" | "abnormal-exit" | ... — whatever the reason,
    // the renderer's JS context (and anything it was tracking, like `activeOpenRequestIdRef`) is
    // gone for good; nothing will ever run its own cleanup now.
    void details;
    session.dispose();
  });
  // Compatibility watch-point (security review, repo-open-feedback-fixes round 2): these
  // positional args (`url`, `isInPlace`, `isMainFrame`, ...) are marked `@deprecated` in
  // electron@44's own type defs in favor of a single `details: Event<...>` object, though still
  // emitted correctly as of this pinned version (confirmed against `electron.d.ts` and exercised
  // by `main.test.ts`). If a future Electron major drops the deprecated positional form, both
  // values silently become `undefined` and this handler stops firing for a real reload with no
  // visible failure — re-check this against `electron.d.ts` on the next Electron major bump.
  mainWindow.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
    // `isInPlace` excludes same-document navigations (hash changes, `history.pushState`, ...),
    // which never replace the JS context and so need no cleanup. A real reload (Ctrl+R, or the
    // menu's Reload item — both ultimately call `webContents.reload()`, which DOES emit this
    // event, unlike `will-navigate`) is `isMainFrame && !isInPlace`, same as this app's own
    // initial `loadURL`/`loadFile` call above — disposing on that initial navigation too is a
    // harmless no-op (nothing has been opened yet) rather than something worth special-casing.
    if (isMainFrame && !isInPlace) session.dispose();
  });

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
  // specs/keyboard-shortcuts-command-palette.md FR-226/AC7: see `buildApplicationMenu`'s own doc
  // comment — must be set before `createWindow()` so the window never has even a brief window with
  // Electron's own default (Reload-accelerator-carrying) menu active.
  Menu.setApplicationMenu(buildApplicationMenu());
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
