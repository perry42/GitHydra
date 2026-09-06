// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Test-only helper: a `GitHydraApi` backed by a REAL `RepoSession` (the actual production class
 * `packages/desktop/electron/repoSession.ts` uses) talking to a REAL `@githydra/git-core`
 * `Repository`, which in turn shells out to a REAL `git` binary against a REAL temp repo on disk.
 *
 * This exists because `makeMockGitHydra` (fully in-memory) is exactly the kind of mock
 * test-agent's mandate warns against for integration coverage: "mocks tend to hide the exact bugs
 * that matter here." Everything below mirrors `packages/desktop/electron/main.ts`'s
 * `registerIpcHandlers()`/`toResult()`/`serializeError()` logic function-for-function, just called
 * directly instead of through `ipcMain.handle`/`ipcRenderer.invoke` — the actual Electron
 * contextBridge/structured-clone transport is exercised separately (`electron/main.test.ts`,
 * `electron/preload.ts`'s own review), so skipping it here is a deliberate, narrow scope
 * reduction: this harness verifies "does the real React UI correctly reflect what real git-core
 * actually did," not "does Electron's IPC transport serialize correctly."
 *
 * `openRepoDialog()` is the one method that can't have a real implementation (there is no real
 * native dialog in a test) — it resolves to whatever path `setDialogPath()` last configured,
 * mirroring a user having picked that folder.
 */
import { RepoSession } from "../../electron/repoSession";
import {
  CherryPickNotAtEmptyResultError,
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
  OperationAlreadyInProgressError,
  OperationCancelledError,
  PreExistingConflictError,
  StashOnUnbornHeadError,
  UnsupportedGitVersionError,
  validateBranchName,
} from "@githydra/git-core";
import type { GitHydraApi, IpcError, IpcResult, OpenRepoOutcome } from "../../shared/ipcContract";

function serializeError(err: unknown): IpcError {
  if (
    err instanceof GitCommandError ||
    err instanceof NotAGitRepositoryError ||
    err instanceof GitNotFoundError ||
    err instanceof UnsupportedGitVersionError ||
    err instanceof InvalidArgumentError ||
    err instanceof NothingStagedError ||
    err instanceof MissingCommitIdentityError ||
    err instanceof CommitHookRejectedError ||
    // specs/amend-last-commit.md FR-149/FR-151: `NoCommitToAmendError`/
    // `AmendBlockedByOperationError` aren't individually named here — see `main.ts`'s
    // `serializeError` doc comment for why (git-core's `index.ts` doesn't currently re-export them
    // from `errors.ts`, and this feature's task scope excludes touching `packages/git-core`). Both
    // still surface correctly via the generic `err instanceof Error` fallback below.
    err instanceof ConflictMarkersRemainError ||
    err instanceof ContinueBlockedError ||
    err instanceof NoOperationInProgressError ||
    err instanceof NothingEligibleToStashError ||
    err instanceof StashOnUnbornHeadError ||
    err instanceof PreExistingConflictError ||
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

export interface RealGitHydraHandle {
  api: GitHydraApi;
  session: RepoSession;
  /** Configures what `openRepoDialog()` resolves to next, mimicking a user's folder pick. */
  setDialogPath: (path: string | null) => void;
  /** Directly invokes every `onRefsChanged` listener — for tests that want to simulate "the
   * watcher's debounced callback fired" without waiting on a real `fs.watch` debounce window. Most
   * tests should prefer letting the REAL watcher fire (see `waitForRealWatcher` below); this is an
   * escape hatch for tests that are asserting something else and don't want fs.watch's timing. */
  fireWatcherListeners: () => void;
  dispose: () => void;
}

/** Builds one real `GitHydraApi` (+ its backing `RepoSession`) for a single test. */
export function createRealGitHydraApi(): RealGitHydraHandle {
  const session = new RepoSession();
  let dialogPath: string | null = null;
  const listeners = new Set<() => void>();

  const api: GitHydraApi = {
    openRepoDialog: () => toResult(async () => dialogPath),
    openRepo: (path: string) =>
      toResult(async () => {
        const repo = await session.open(path);
        session.startWatch(() => {
          for (const l of listeners) l();
        });
        return { path, state: repo.getState() };
      }),
    // specs/repo-open-feedback.md FR-163/FR-164/FR-165: mirrors main.ts's real
    // `openRepoCancellable` handler function-for-function (see this file's own module doc
    // comment) — a REAL `RepoSession`/`AbortController`/git-core `Repository.open()` chain, so a
    // test exercising cancellation here exercises the real production cancellation plumbing, not a
    // simulated one.
    openRepoCancellable: async (path: string, requestId: string): Promise<OpenRepoOutcome> => {
      try {
        const repo = await session.open(path, requestId);
        session.startWatch(() => {
          for (const l of listeners) l();
        });
        return { outcome: "settled", result: { ok: true, data: { path, state: repo.getState() } } };
      } catch (err) {
        if (err instanceof OperationCancelledError) return { outcome: "cancelled" };
        return { outcome: "settled", result: { ok: false, error: serializeError(err) } };
      }
    },
    cancelOpenRepo: async (requestId: string) => {
      session.cancelOpen(requestId);
    },
    // security review (specs/repo-list.md, revised IA): mirrors main.ts's real handler — a REAL
    // `session.dispose()` call, so a test exercising this closes the REAL watcher/readers/repo.
    closeRepoSession: () =>
      toResult(async () => {
        session.dispose();
      }),
    getState: () => toResult(async () => session.getOpenRepo().refreshState()),
    getRefs: () => toResult(async () => session.getOpenRepo().getRefs()),
    createLogReader: (filter) =>
      toResult(async () => {
        const reader = await session.getOpenRepo().createCommitLogReader(filter);
        return session.createReader(reader);
      }),
    readPage: (readerId: string, count: number) => toResult(async () => session.getReader(readerId).readPage(count)),
    closeReader: (readerId: string) =>
      toResult(async () => {
        session.closeReader(readerId);
      }),
    getCommit: (shaOrPrefix: string) => toResult(async () => session.getOpenRepo().getCommit(shaOrPrefix)),
    getChangedFiles: (commit) => toResult(async () => session.getOpenRepo().getChangedFiles(commit)),
    // specs/compare-commits.md FR-182
    getChangedFilesBetween: (baseSha: string, targetSha: string) =>
      toResult(async () => session.getOpenRepo().getChangedFilesBetween(baseSha, targetSha)),
    getWorkingDirStatus: () => toResult(async () => session.getWorkingDirectoryStatus()),
    getUpstreamBranch: () => toResult(async () => session.getUpstreamBranch()),
    onRefsChanged: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getWorkingDirectoryChanges: () => toResult(async () => session.getOpenRepo().getWorkingDirectoryChanges()),
    getUnstagedFileDiff: (path, options) => toResult(async () => session.getOpenRepo().getUnstagedFileDiff(path, options)),
    getStagedFileDiff: (path, options) => toResult(async () => session.getOpenRepo().getStagedFileDiff(path, options)),
    getUntrackedFileDiff: (path, options) => toResult(async () => session.getOpenRepo().getUntrackedFileDiff(path, options)),
    getCommitFileDiff: (commit, file, options) =>
      toResult(async () => session.getOpenRepo().getCommitFileDiff(commit, file, options)),
    // specs/compare-commits.md FR-181
    getCommitRangeFileDiff: (baseSha: string, targetSha: string, file, options) =>
      toResult(async () => session.getOpenRepo().getCommitRangeFileDiff(baseSha, targetSha, file, options)),

    // specs/image-diff-preview.md FR-142/FR-144
    getUnstagedImageDiff: (path: string) => toResult(async () => session.getOpenRepo().getUnstagedImageDiff(path)),
    getStagedImageDiff: (path: string) => toResult(async () => session.getOpenRepo().getStagedImageDiff(path)),
    getUntrackedImageDiff: (path: string) => toResult(async () => session.getOpenRepo().getUntrackedImageDiff(path)),
    getCommitImageDiff: (commit, file) => toResult(async () => session.getOpenRepo().getCommitImageDiff(commit, file)),

    stageFile: (path: string) => toResult(async () => session.getOpenRepo().stageFile(path)),
    unstageFile: (path: string) => toResult(async () => session.getOpenRepo().unstageFile(path)),
    stageAllFiles: () => toResult(async () => session.getOpenRepo().stageAllFiles()),
    unstageAllFiles: () => toResult(async () => session.getOpenRepo().unstageAllFiles()),

    discardTrackedFileChanges: (path: string) => toResult(async () => session.getOpenRepo().discardTrackedFileChanges(path)),
    discardUntrackedFile: (path: string) => toResult(async () => session.getOpenRepo().discardUntrackedFile(path)),

    createCommit: (options) => toResult(async () => session.getOpenRepo().createCommit(options)),
    amendCommit: (options) => toResult(async () => session.getOpenRepo().amendCommit(options)),

    listBranches: () => toResult(async () => session.getOpenRepo().listBranches()),
    listRemoteBranches: () => toResult(async () => session.getOpenRepo().listRemoteBranches()),
    validateBranchName: (name: string) => toResult(async () => validateBranchName(session.getOpenRepo().path, name)),
    createBranch: (options) => toResult(async () => session.getOpenRepo().createBranch(options)),
    switchBranch: (branchName: string) => toResult(async () => session.getOpenRepo().switchBranch(branchName)),
    switchToCommit: (commitish: string) => toResult(async () => session.getOpenRepo().switchToCommit(commitish)),
    deleteBranch: (branchName: string) => toResult(async () => session.getOpenRepo().deleteBranch(branchName)),
    forceDeleteBranch: (branchName: string) => toResult(async () => session.getOpenRepo().forceDeleteBranch(branchName)),

    getConflictedFiles: () => toResult(async () => session.getOpenRepo().getConflictedFiles()),
    getConflictFileDiff: (file, options) => toResult(async () => session.getOpenRepo().getConflictFileDiff(file, options)),
    getConflictSideLabels: () => toResult(async () => session.getOpenRepo().getConflictSideLabels()),
    scanConflictMarkers: (filePath: string) => toResult(async () => session.getOpenRepo().scanConflictMarkers(filePath)),
    acceptConflictSide: (filePath: string, side: "ours" | "theirs") =>
      toResult(async () => session.getOpenRepo().acceptConflictSide(filePath, side)),
    markConflictResolved: (filePath: string) => toResult(async () => session.getOpenRepo().markConflictResolved(filePath)),
    abortInProgressOperation: () => toResult(async () => session.getOpenRepo().abortInProgressOperation()),
    continueInProgressOperation: () => toResult(async () => session.getOpenRepo().continueInProgressOperation()),
    // No real OS shell in a test environment — never exercised by the stash integration suite.
    openPathInExternalEditor: () => toResult(async () => undefined),

    listStashes: () => toResult(async () => session.getOpenRepo().listStashes()),
    getStashDiff: (index: number, options) => toResult(async () => session.getOpenRepo().getStashDiff(index, options)),
    createStash: (options) => toResult(async () => session.getOpenRepo().createStash(options)),
    applyStash: (index: number) => toResult(async () => session.getOpenRepo().applyStash(index)),
    popStash: (index: number) => toResult(async () => session.getOpenRepo().popStash(index)),
    dropStash: (index: number) => toResult(async () => session.getOpenRepo().dropStash(index)),

    cherryPick: (shas: readonly string[]) => toResult(async () => session.getOpenRepo().cherryPick(shas)),
    skipCherryPickCommit: () => toResult(async () => session.getOpenRepo().skipCherryPickCommit()),
    commitEmptyCherryPick: () => toResult(async () => session.getOpenRepo().commitEmptyCherryPick()),

    getFileBlame: (path: string, revision: string | null) =>
      toResult(async () => session.getOpenRepo().getFileBlame(path, revision)),
    createFileHistoryReader: (revision: string, path: string) =>
      toResult(async () => {
        const reader = await session.getOpenRepo().getFileHistory(revision, path);
        return session.createReader(reader);
      }),
  };

  return {
    api,
    session,
    setDialogPath: (path: string | null) => {
      dialogPath = path;
    },
    fireWatcherListeners: () => {
      for (const l of listeners) l();
    },
    // Clears listeners FIRST, before closing the underlying fs.watch handle: `watcher.ts`'s
    // debounce is a plain `setTimeout` uncoupled from the watch handle's lifecycle, so an event
    // already in its debounce window when a test ends can still fire after this `dispose()`
    // returns. Emptying `listeners` up front makes that a harmless no-op instead of an unhandled
    // "No repository is open" rejection from a stale `session.getOpenRepo()` call racing this
    // same session's teardown — a real timing property of this test harness (real fs.watch +
    // real, rapid, close-succession repo open/close), not a production bug: the actual Electron
    // app never opens/closes this many repos back-to-back in one process lifetime.
    dispose: () => {
      listeners.clear();
      session.dispose();
    },
  };
}
