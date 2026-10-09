// SPDX-License-Identifier: GPL-3.0-or-later
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, powerMonitor, screen, shell, type MenuItemConstructorOptions } from "electron";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BulkStagingError,
  IgnoreFileChangedError,
  IgnoreUntrackError,
  StaleBatchError,
  IgnorePlanChangedError,
  BULK_DISCARD_ROW_LIMIT,
  IGNORE_ROW_LIMIT,
  CherryPickNotAtEmptyResultError,
  CommitHookRejectedError,
  ConflictMarkersRemainError,
  ContinueBlockedError,
  GitCommandError,
  GitCommandTimeoutError,
  GitNotFoundError,
  // specs/branch-panel-drag-merge.md FR-430
  HeadMovedError,
  BranchCreationFailedError,
  InvalidArgumentError,
  MissingCommitIdentityError,
  NoOperationInProgressError,
  NotAGitRepositoryError,
  NothingEligibleToStashError,
  NothingStagedError,
  OperationAlreadyInProgressError,
  OperationCancelledError,
  PreExistingConflictError,
  // specs/instant-tab-revisit.md FR-245
  ReaderResumeMismatchError,
  StashOnUnbornHeadError,
  // specs/git-identity-profiles.md FR-334
  UnmanagedIdentityConfigConflictError,
  UnsupportedGitVersionError,
  validateBranchName,
  warmUpGitResolution,
  type ApplyIdentityProfileOptions,
  type BulkDiscardCandidate,
  type BulkDiscardRow,
  type BulkRow,
  type ExpectedIdentityApplication,
  type ChangedFile,
  type CombinedLineRef,
  clone as cloneImpl,
  type CloneResult,
  type ConflictedFileInfo,
  type CreateBranchOptions,
  type CreateCommitOptions,
  type CreateStashOptions,
  type DiffOptions,
  type FetchAllRemotesResult,
  listConfiguredRemotes,
  type PullOutcome,
  type PullStrategy,
  type PushOutcome,
  type ResetMode,
  type ResumeCommitLogFrom,
  type WorktreeChange,
} from "@githydra/git-core";
import { RepoSession } from "./repoSession";
import { createEditFileHandlers, mapEditError, pickEditPath, SelfWriteRegistry } from "./editFileIpc";
import { resolveRepoRelativePath, realpathWithinWorkdir } from "./pathSafety";
import { CLOSE_ACK_TIMEOUT_MS, createCloseGuard, type NativeConfirmReason } from "./closeGuard";
import { createCloseDialog } from "./closeDialogWindow";
import { loadThemeHint, parseThemeHint, saveThemeHint, type ThemeHint } from "./themeHint";
import { createRecoveryDraftHandlers, draftFailure } from "./recoveryDraftIpc";
import { RecoveryDraftStore } from "./recoveryDrafts";
import {
  IPC_CHANNELS,
  type CloneIpcOutcome,
  type FetchOutcome,
  type IpcError,
  type GuardedSwitchIpcOptions,
  type IgnoreIpcRequest,
  type IpcResult,
  type OpenRepoOutcome,
  type OpenRepoResult,
  type PullIpcOutcome,
  type PushIpcOutcome,
} from "../shared/ipcContract";
import { resolveOpenedPath } from "../shared/pathEquivalence";
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
    // specs/instant-tab-revisit.md FR-245: a resumed reader's fast-forward position didn't match
    // the caller's cache — surfaced distinctly so the renderer can tell "fall back to a full
    // reload" apart from a generic reader-creation failure (see this error's own doc comment,
    // git-core's errors.ts).
    // FR-430: sha-only / fixed-text messages (never git stderr or a path) - safe to surface as-is.
    err instanceof HeadMovedError ||
    err instanceof BranchCreationFailedError ||
    err instanceof ReaderResumeMismatchError ||
    // specs/git-identity-profiles.md FR-334: surfaced with its own already-descriptive message
    // (naming every conflicting key/value, errors.ts) — never swallowed into a generic crash. The
    // renderer branches on `.name === "UnmanagedIdentityConfigConflictError"` (the same
    // `err.name`-string convention `BranchNotFullyMergedError`'s two-tier confirm already uses)
    // before showing that message as an explicit confirmation, then retries with `force: true`.
    err instanceof UnmanagedIdentityConfigConflictError ||
    err instanceof Error
  ) {
    // specs/online-sync-push.md FR-346: a `GitCommandError`'s own `stderr` is carried alongside
    // `message` (never in place of it) so the renderer can run `classifyGitNetworkError()` against
    // the exact stderr text git produced, with no "git <args> exited with code N:" prefix glued
    // onto it — see `IpcError.stderr`'s own doc comment (shared/ipcContract.ts).
    const code = (err as { code?: unknown }).code;
    const details = errorDetails(err);
    return {
      name: err.name,
      message: err.message,
      ...(err instanceof GitCommandError ? { stderr: err.stderr } : {}),
      ...(typeof code === "string" ? { code } : {}),
      ...(details ? { details } : {}),
    };
  }
  return { name: "UnknownError", message: String(err) };
}

/**
 * specs/ignore-and-multiselect.md FR-500/FR-507/FR-508: the whitelisted plain fields of the bulk errors, so the UI can name
 * exactly which paths changed. Copied per class, never the error object itself.
 */
const MAX_DETAIL_PATHS = 50;
function boundedStrings(list: readonly string[]): string[] {
  return list.slice(0, MAX_DETAIL_PATHS);
}

function errorDetails(err: unknown): Record<string, unknown> | undefined {
  if (err instanceof StaleBatchError) return { paths: boundedStrings(err.paths), totalPaths: err.totalCount };
  if (err instanceof IgnorePlanChangedError) {
    return {
      expected: boundedStrings(err.expected),
      actual: boundedStrings(err.actual),
      expectedCount: err.expectedCount,
      actualCount: err.actualCount,
    };
  }
  if (err instanceof BulkStagingError) return { changed: [...err.changed], unchanged: [...err.unchanged], gitMessage: err.gitMessage };
  if (err instanceof IgnoreUntrackError) {
    return { rolledBack: err.rolledBack, ruleFilesLeftModified: [...err.ruleFilesLeftModified], gitMessage: err.gitMessage };
  }
  if (err instanceof IgnoreFileChangedError) return { file: err.file };
  return undefined;
}

async function toResult<T>(work: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    return { ok: true, data: await work() };
  } catch (err) {
    return { ok: false, error: serializeError(err) };
  }
}

/**
 * specs/hunk-line-staging.md FR-480: rebuild the renderer-supplied combined-diff line refs from plain integers only (never forward the object as-is). Each ref
 * is rebuilt from two integers (non-negative, so a crafted value never reaches git-core's index maths) and
 * the array is capped so a hostile renderer cannot make main build an unbounded patch.
 */
const MAX_COMBINED_LINE_REFS = 200_000;
function pickCombinedLineRefs(lines: unknown): CombinedLineRef[] {
  if (!Array.isArray(lines)) throw new InvalidArgumentError("lines must be an array.");
  if (lines.length > MAX_COMBINED_LINE_REFS) throw new InvalidArgumentError("too many lines in one request.");
  return lines.map((item: unknown) => {
    const { hunkIndex, lineIndex } = (item ?? {}) as { hunkIndex?: unknown; lineIndex?: unknown };
    if (!Number.isInteger(hunkIndex) || (hunkIndex as number) < 0) {
      throw new InvalidArgumentError("lines[].hunkIndex must be a non-negative integer.");
    }
    if (!Number.isInteger(lineIndex) || (lineIndex as number) < 0) {
      throw new InvalidArgumentError("lines[].lineIndex must be a non-negative integer.");
    }
    return { hunkIndex: hunkIndex as number, lineIndex: lineIndex as number };
  });
}

/** The renderer is untrusted: a non-string path/fingerprint must fail typed here, not deep inside git-core. */
function pickString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new InvalidArgumentError(`${name} must be a string.`);
  return value;
}

function pickToggleTarget(target: unknown): "stage" | "unstage" {
  if (target === "stage" || target === "unstage") return target;
  throw new InvalidArgumentError('target must be "stage" or "unstage".');
}

// Caps what a hostile renderer can make main allocate; a real selection is bounded by the file list itself.
const MAX_BULK_ROWS = 200_000;
const BULK_SECTIONS = ["staged", "unstaged", "untracked", "mixed", "conflicted"] as const;
const DISCARD_SECTIONS = ["unstaged", "untracked", "mixed"] as const;

// Discard calls hash/read every file and can run for seconds, so they get a far lower cap than stage/ignore (same limit
// git-core enforces); a larger batch is refused with a message the dialog can show as-is.
const MAX_DISCARD_ROWS = BULK_DISCARD_ROW_LIMIT;
const TOO_MANY_TO_DISCARD = "Too many files, discard in chunks.";

function pickRowArray(rows: unknown, name: string, max = MAX_BULK_ROWS): Record<string, unknown>[] {
  if (!Array.isArray(rows)) throw new InvalidArgumentError(`${name} must be an array.`);
  if (rows.length > max) {
    throw new InvalidArgumentError(max === MAX_DISCARD_ROWS ? TOO_MANY_TO_DISCARD : `${name} has too many entries.`);
  }
  return rows.map((r) => {
    if (typeof r !== "object" || r === null) throw new InvalidArgumentError(`${name} entries must be objects.`);
    return r as Record<string, unknown>;
  });
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  throw new InvalidArgumentError(`${name} is not a valid value.`);
}

/** Rebuilds each row from its known string fields only (never forwards the renderer's object). */
function pickBulkRows(rows: unknown): BulkRow[] {
  return pickRowArray(rows, "rows").map((r) => ({
    path: pickString(r.path, "path"),
    section: pickEnum(r.section, BULK_SECTIONS, "section"),
  }));
}

function pickDiscardCandidates(rows: unknown): BulkDiscardCandidate[] {
  return pickRowArray(rows, "rows", MAX_DISCARD_ROWS).map((r) => ({
    path: pickString(r.path, "path"),
    section: pickEnum(r.section, DISCARD_SECTIONS, "section"),
  }));
}

function pickDiscardRows(rows: unknown): BulkDiscardRow[] {
  return pickRowArray(rows, "rows", MAX_DISCARD_ROWS).map((r) => ({
    path: pickString(r.path, "path"),
    section: pickEnum(r.section, DISCARD_SECTIONS, "section"),
    expectedFingerprint: pickString(r.expectedFingerprint, "expectedFingerprint"),
  }));
}

function pickIgnoreRequest(req: unknown): IgnoreIpcRequest {
  const r = (req ?? {}) as Record<string, unknown>;
  if (!Array.isArray(r.paths)) throw new InvalidArgumentError("paths must be an array.");
  if (r.paths.length > IGNORE_ROW_LIMIT) throw new InvalidArgumentError("paths has too many entries.");
  const picked: IgnoreIpcRequest = {
    paths: r.paths.map((p) => pickString(p, "path")),
    scope: pickEnum(r.scope, ["name", "extension", "directory"] as const, "scope"),
    target: pickEnum(r.target, ["root", "nearest", "exclude"] as const, "target"),
  };
  // Security finding L2: the previewed untrack set, so git-core can refuse if it changed since the preview.
  if (r.expectedUntrackPaths !== undefined) {
    if (!Array.isArray(r.expectedUntrackPaths)) throw new InvalidArgumentError("expectedUntrackPaths must be an array.");
    if (r.expectedUntrackPaths.length > MAX_BULK_ROWS) throw new InvalidArgumentError("expectedUntrackPaths has too many entries.");
    picked.expectedUntrackPaths = r.expectedUntrackPaths.map((p) => pickString(p, "expectedUntrackPath"));
  }
  return picked;
}

/** Copy ONLY the known field out of renderer-supplied options (never forward an arbitrary object). */
function pickGuardedSwitchOptions(options: GuardedSwitchIpcOptions | undefined): GuardedSwitchIpcOptions {
  return typeof options?.expectedDetachedHeadSha === "string"
    ? { expectedDetachedHeadSha: options.expectedDetachedHeadSha }
    : {};
}

const selfWrites = new SelfWriteRegistry();

// The prompt must not ask the main renderer (it may be the hung one), so the theme comes from the last value the
// renderer pushed (persisted next to window-bounds.json), else the OS colour scheme.
let themeHint: ThemeHint | null | undefined;
const currentTheme = (): ThemeHint => {
  if (themeHint === undefined) themeHint = loadThemeHint(app.getPath("userData"));
  return themeHint ?? (nativeTheme.shouldUseDarkColors ? "dark" : "light");
};

/** OS message box: only used if our own close prompt window cannot be shown within its load timeout. */
async function nativeCloseConfirm(reason: NativeConfirmReason, parent: BrowserWindow | null): Promise<boolean> {
  const options = {
    type: "warning" as const,
    buttons: ["Close anyway", "Keep open"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    ...(reason === "unresponsive"
      ? {
          title: "GitHydra is not responding",
          message: "GitHydra is not responding, and you have unsaved edits in the editor.",
          detail: "If you close now, those edits are lost.",
        }
      : {
          title: "Close GitHydra?",
          message: "You have unsaved edits in the editor.",
          detail: "A Save / Discard / Cancel prompt is already open in the window. If you close now, those edits are lost.",
        }),
  };
  const r = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  return r.response === 0;
}

const closeDialog = createCloseDialog({
  getParent: () => mainWindow,
  getTheme: currentTheme,
  nativeFallback: nativeCloseConfirm,
  assetsDir: __dirname,
});

// specs/edit-in-diff.md FR-535: asks the renderer before closing with an unsaved editor buffer. If the renderer never
// answers within 5 s it is treated as hung and the user gets a native confirm (close anyway / keep open); we never
// close silently, because that would drop the buffer, and never refuse forever, because that would make the app unclosable.
const closeGuard = createCloseGuard({
  requestClose: () => {
    if (!mainWindow) return;
    // The prompt lives in the window, so a close from the taskbar of a minimized window must bring it back.
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send(IPC_CHANNELS.closeRequestedEvent);
  },
  closeNow: ({ quit }) => {
    if (quit) app.quit();
    else mainWindow?.close();
  },
  confirmUnresponsive: (reason) => closeDialog.confirm(reason),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  ackTimeoutMs: CLOSE_ACK_TIMEOUT_MS,
});
const editFile = createEditFileHandlers(() => session.getOpenRepo(), selfWrites);

// specs/edit-recovery-draft.md FR-541: drafts live only under userData, resolved lazily so importing this module touches nothing.
let draftStore: RecoveryDraftStore | null = null;
const getDraftStore = (): RecoveryDraftStore => (draftStore ??= new RecoveryDraftStore({ root: path.join(app.getPath("userData"), "recovery-drafts") }));
const recoveryDrafts = createRecoveryDraftHandlers(() => session.getOpenRepo(), getDraftStore);

// Payload-free on purpose: the renderer re-reads status itself, so no path ever crosses the bridge.
// specs/edit-in-diff.md FR-536: the echo of our own save is dropped; the editor refreshes explicitly (FR-475).
function notifyWorktreeChanged(change?: WorktreeChange): void {
  const send = (): void => void mainWindow?.webContents.send(IPC_CHANNELS.worktreeChangedEvent);
  let workdir: string | null | undefined;
  try {
    workdir = session.getOpenRepo().getState().workdir;
  } catch {
    workdir = null;
  }
  if (!change || !workdir) return send();
  // Fail open: a stat error or throw must never swallow a real change.
  selfWrites.coversChange(workdir, change).then((covered) => (covered ? undefined : send()), send);
}

/** FR-535: only our own window may drive the close guard (an event always carries its sender; test doubles may not). */
function requireMainWindowSender(evt: { sender?: unknown } | undefined): void {
  if (evt?.sender !== undefined && mainWindow && evt.sender !== mainWindow.webContents) {
    throw new InvalidArgumentError("Not allowed from this sender.");
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
      session.startWatch(() => mainWindow?.webContents.send(IPC_CHANNELS.refsChangedEvent), notifyWorktreeChanged);
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
        session.startWatch(() => mainWindow?.webContents.send(IPC_CHANNELS.refsChangedEvent), notifyWorktreeChanged);
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

  // specs/instant-tab-revisit.md FR-245: `resumeAfter`, when the renderer supplies it, is passed
  // straight through to git-core's own `createCommitLogReader()` — see that method's and
  // `GitHydraApi.createLogReader()`'s doc comments for the full contract. Omitted by every
  // pre-existing caller, so their behavior is completely unchanged.
  ipcMain.handle(
    IPC_CHANNELS.createLogReader,
    (_evt, filter, requestId?: string, resumeAfter?: ResumeCommitLogFrom) =>
      toResult(async () => {
        const reader = await session
          .getOpenRepoFor(requestId)
          .createCommitLogReader(filter, session.getOpenSignal(requestId), resumeAfter);
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
  // Security review H1: the fingerprint is required; git-core re-verifies it inside the mutation queue. onBackup is not forwarded.
  ipcMain.handle(IPC_CHANNELS.discardTrackedFileChanges, (_evt, path: unknown, expectedFingerprint: unknown) =>
    toResult(async () =>
      session
        .getOpenRepo()
        .discardTrackedFileChanges(pickString(path, "path"), { expectedFingerprint: pickString(expectedFingerprint, "expectedFingerprint") }),
    ),
  );
  ipcMain.handle(IPC_CHANNELS.discardUntrackedFile, (_evt, path: unknown, expectedFingerprint: unknown) =>
    toResult(async () =>
      session
        .getOpenRepo()
        .discardUntrackedFile(pickString(path, "path"), { expectedFingerprint: pickString(expectedFingerprint, "expectedFingerprint") }),
    ),
  );
  ipcMain.handle(IPC_CHANNELS.getDiscardFingerprint, (_evt, path: unknown, kind: unknown) =>
    toResult(async () => {
      if (kind !== "tracked" && kind !== "untracked") throw new InvalidArgumentError('kind must be "tracked" or "untracked".');
      return session.getOpenRepo().getDiscardFingerprint(pickString(path, "path"), kind);
    }),
  );

  // specs/hunk-line-staging.md FR-479/FR-480/FR-478: the checkbox model. Errors cross IPC by `.name`
  // (StaleDiffError, PartialStagingIneligibleError, LinesNotDiscardableError) via serializeError's Error
  // fallback. discardCombinedLines is destructive - the renderer confirms first (FR-455).
  ipcMain.handle(IPC_CHANNELS.getCombinedFileDiff, (_evt, path: unknown) =>
    toResult(async () => session.getOpenRepo().getCombinedFileDiff(pickString(path, "path"))),
  );
  ipcMain.handle(
    IPC_CHANNELS.toggleCombinedLines,
    (_evt, path: unknown, fingerprint: unknown, lines: unknown, target: unknown) =>
      toResult(async () =>
        session
          .getOpenRepo()
          .toggleCombinedLines(
            pickString(path, "path"),
            pickString(fingerprint, "fingerprint"),
            pickCombinedLineRefs(lines),
            pickToggleTarget(target),
          ),
      ),
  );
  ipcMain.handle(IPC_CHANNELS.discardCombinedLines, (_evt, path: unknown, fingerprint: unknown, lines: unknown) =>
    toResult(async () =>
      session
        .getOpenRepo()
        .discardCombinedLines(pickString(path, "path"), pickString(fingerprint, "fingerprint"), pickCombinedLineRefs(lines)),
    ),
  );

  // specs/ignore-and-multiselect.md: every argument is rebuilt from known fields (pick*), and git-core re-validates each
  // path against a fresh status/index read (FR-499). Destructive calls need fingerprints; the renderer confirms first.
  ipcMain.handle(IPC_CHANNELS.planIgnore, (_evt, req: unknown) =>
    toResult(async () => {
      const { expectedUntrackPaths: _unused, ...picked } = pickIgnoreRequest(req);
      return session.getOpenRepo().planIgnore({ ...picked, stopTracking: (req as { stopTracking?: unknown }).stopTracking === true });
    }),
  );
  // FR-502: even a failed write may have changed a rule file, so the watcher's ignore list is refreshed either way.
  ipcMain.handle(IPC_CHANNELS.ignorePaths, (_evt, req: unknown) =>
    toResult(async () => {
      try {
        const { expectedUntrackPaths: _unused, ...picked } = pickIgnoreRequest(req);
        return await session.getOpenRepo().ignorePaths(picked);
      } finally {
        session.refreshWorktreeIgnoreList();
      }
    }),
  );
  ipcMain.handle(IPC_CHANNELS.ignoreAndStopTracking, (_evt, req: unknown) =>
    toResult(async () => {
      try {
        // Not a fresh literal: git-core's IgnoreRequest gains `expectedUntrackPaths` separately.
        const picked = pickIgnoreRequest(req);
        // Stop tracking acts only on the list the user confirmed (security L2): no list, no untrack.
        if (!picked.expectedUntrackPaths) throw new InvalidArgumentError("Stop tracking needs the confirmed file list from the preview.");
        return await session.getOpenRepo().ignoreAndStopTracking(picked);
      } finally {
        session.refreshWorktreeIgnoreList();
      }
    }),
  );
  ipcMain.handle(IPC_CHANNELS.stagePaths, (_evt, rows: unknown) =>
    toResult(async () => session.getOpenRepo().stagePaths(pickBulkRows(rows))),
  );
  ipcMain.handle(IPC_CHANNELS.unstagePaths, (_evt, rows: unknown) =>
    toResult(async () => session.getOpenRepo().unstagePaths(pickBulkRows(rows))),
  );
  ipcMain.handle(IPC_CHANNELS.getBulkDiscardFingerprints, (_evt, rows: unknown) =>
    toResult(async () => session.getOpenRepo().getBulkDiscardFingerprints(pickDiscardCandidates(rows))),
  );
  ipcMain.handle(IPC_CHANNELS.bulkDiscard, (_evt, rows: unknown) =>
    toResult(async () => session.getOpenRepo().bulkDiscard(pickDiscardRows(rows))),
  );
  ipcMain.handle(IPC_CHANNELS.planDiscardAll, () => toResult(async () => session.getOpenRepo().planDiscardAll()));
  ipcMain.handle(IPC_CHANNELS.getDiscardPreview, (_evt, paths: unknown) =>
    toResult(async () => {
      if (!Array.isArray(paths) || paths.length > 50) throw new Error("getDiscardPreview takes at most 50 paths");
      return session.getOpenRepo().getDiscardPreview(paths.map((p) => pickString(p, "path")));
    }),
  );
  ipcMain.handle(IPC_CHANNELS.discardAllChanges, (_evt, rows: unknown, includeUntracked: unknown) =>
    toResult(async () =>
      session.getOpenRepo().discardAllChanges({ rows: pickDiscardRows(rows), includeUntracked: includeUntracked === true }),
    ),
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
  ipcMain.handle(IPC_CHANNELS.switchBranch, (_evt, branchName: string, options?: GuardedSwitchIpcOptions) =>
    toResult(async () => session.getOpenRepo().switchBranch(branchName, pickGuardedSwitchOptions(options))),
  );
  ipcMain.handle(IPC_CHANNELS.switchToCommit, (_evt, commitish: string, options?: GuardedSwitchIpcOptions) =>
    toResult(async () => session.getOpenRepo().switchToCommit(commitish, pickGuardedSwitchOptions(options))),
  );

  // specs/branch-panel-drag-merge.md FR-430: detached-HEAD orphan guard. Both operate on the
  // session's own open repo (never a renderer-supplied path). `getOrphanedHeadCommits` never
  // rejects for git failures (they surface as `status: "unknown"`), so no raw stderr can leak.
  ipcMain.handle(IPC_CHANNELS.getOrphanedHeadCommits, () =>
    toResult(async () => session.getOpenRepo().getOrphanedHeadCommits()),
  );
  ipcMain.handle(IPC_CHANNELS.createBranchAtCommit, (_evt, name: string, sha: string) =>
    toResult(async () => session.getOpenRepo().createBranchAtCommit(name, sha)),
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

  // specs/edit-in-diff.md FR-468/FR-471/FR-474: validation, error mapping and self-write registration live in editFileIpc.ts.
  // Sender-checked like readConflictSides; a foreign sender gets the same closed-code failure as a bad argument.
  const fromOwnWindow = <A extends unknown[], R>(fn: (...a: A) => R | Promise<R>) =>
    async (evt: { sender?: unknown } | undefined, ...a: A) => {
      try {
        requireMainWindowSender(evt);
      } catch (err) {
        return mapEditError(err);
      }
      return fn(...a);
    };
  ipcMain.handle(IPC_CHANNELS.probeEditableFile, fromOwnWindow((filePath: unknown) => editFile.probe(filePath)));
  ipcMain.handle(IPC_CHANNELS.readEditableFile, fromOwnWindow((filePath: unknown) => editFile.read(filePath)));
  ipcMain.handle(
    IPC_CHANNELS.writeEditedFile,
    fromOwnWindow((filePath: unknown, content: unknown, options: unknown) => editFile.write(filePath, content, options)),
  );

  // specs/edit-in-diff.md FR-559: read-only like the three above, but sender-checked because it reads object-database content on request.
  ipcMain.handle(IPC_CHANNELS.readConflictSides, (evt, filePath: unknown) =>
    toResult(async () => {
      if (mainWindow === null || evt?.sender !== mainWindow.webContents) throw new InvalidArgumentError("Request not accepted.");
      return session.getOpenRepo().readConflictSides(pickEditPath(filePath));
    }),
  );

  // specs/edit-recovery-draft.md FR-554: fail closed (no window or no sender means refuse); validation and the open-repo identity check live in recoveryDraftIpc.ts.
  const fromMainWindow = (evt: { sender?: unknown } | undefined): boolean => mainWindow !== null && evt?.sender === mainWindow.webContents;
  ipcMain.handle(IPC_CHANNELS.writeDraft, (evt, repo: unknown, rel: unknown, draft: unknown) =>
    fromMainWindow(evt) ? recoveryDrafts.write(repo, rel, draft) : draftFailure("invalid-argument"),
  );
  ipcMain.handle(IPC_CHANNELS.readDraft, (evt, repo: unknown, rel: unknown) =>
    fromMainWindow(evt) ? recoveryDrafts.read(repo, rel) : draftFailure("invalid-argument"),
  );
  ipcMain.handle(IPC_CHANNELS.deleteDraft, (evt, repo: unknown, rel: unknown) =>
    fromMainWindow(evt) ? recoveryDrafts.delete(repo, rel) : draftFailure("invalid-argument"),
  );
  ipcMain.handle(IPC_CHANNELS.listDrafts, (evt, repo: unknown) =>
    fromMainWindow(evt) ? recoveryDrafts.list(repo) : draftFailure("invalid-argument"),
  );

  // specs/edit-in-diff.md FR-535: the renderer reports its dirty state and answers close requests; both are validated here.
  ipcMain.handle(IPC_CHANNELS.setEditDirty, (evt, dirty: unknown) =>
    toResult(async () => {
      requireMainWindowSender(evt);
      if (typeof dirty !== "boolean") throw new InvalidArgumentError("dirty must be a boolean.");
      closeGuard.setDirty(dirty);
    }),
  );
  ipcMain.handle(IPC_CHANNELS.confirmClose, (evt, reply: unknown) =>
    toResult(async () => {
      requireMainWindowSender(evt);
      closeGuard.onReply(pickEnum(reply, ["allow", "cancel", "prompting"] as const, "reply"));
    }),
  );

  // Theme for the main-process close prompt (closeDialogWindow.ts); the value is an enum or it is refused.
  ipcMain.handle(IPC_CHANNELS.setThemeHint, (evt, theme: unknown) =>
    toResult(async () => {
      requireMainWindowSender(evt);
      const parsed = parseThemeHint(theme);
      if (!parsed) throw new InvalidArgumentError("theme must be 'light' or 'dark'.");
      if (themeHint === parsed) return;
      themeHint = parsed;
      saveThemeHint(app.getPath("userData"), parsed);
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

  // --- drag-commit contextual action menu (specs/drag-commit-menu.md, FR-295 through FR-319) ---

  ipcMain.handle(IPC_CHANNELS.computeCommitPairRelationship, (_evt, shaA: string, shaB: string) =>
    toResult(async () => session.getOpenRepo().computeCommitPairRelationship(shaA, shaB)),
  );
  ipcMain.handle(IPC_CHANNELS.mergeCommit, (_evt, otherSha: string) =>
    toResult(async () => session.getOpenRepo().mergeCommit(otherSha)),
  );
  ipcMain.handle(IPC_CHANNELS.rebaseCommitOnto, (_evt, newBaseSha: string) =>
    toResult(async () => session.getOpenRepo().rebaseCommitOnto(newBaseSha)),
  );

  // --- fetch (specs/online-sync-fetch.md, FR-320 through FR-328) ---
  //
  // First network-capable IPC surface the app has ever exposed. Mirrors `openRepoCancellable`'s own
  // shape exactly: `instanceof OperationCancelledError` is checked on the LIVE error, before it
  // ever reaches `serializeError`, so a cancellation is always the distinct `{ outcome: "cancelled"
  // }` result — never `{ outcome: "settled", result: { ok: false, ... } }`. Progress is forwarded
  // to the renderer as it arrives (never buffered) via a plain `webContents.send`, tagged with this
  // attempt's own `requestId` so a renderer that started a second attempt (or already cancelled
  // this one) can tell which events are still relevant.
  ipcMain.handle(IPC_CHANNELS.fetchAllRemotes, async (_evt, requestId: string): Promise<FetchOutcome> => {
    const signal = session.registerFetch(requestId);
    try {
      const data: FetchAllRemotesResult = await session.getOpenRepo().fetchAllRemotes({
        signal,
        onProgress: (event) => {
          mainWindow?.webContents.send(IPC_CHANNELS.fetchProgressEvent, requestId, event);
        },
      });
      return { outcome: "settled", result: { ok: true, data } };
    } catch (err) {
      if (err instanceof OperationCancelledError) return { outcome: "cancelled" };
      return { outcome: "settled", result: { ok: false, error: serializeError(err) } };
    } finally {
      session.clearFetch(requestId);
    }
  });

  // Deliberately not wrapped in `toResult`/`IpcResult` — same "best-effort, always-succeeds,
  // idempotent signal" convention as `cancelOpenRepo` (see `GitHydraApi.cancelFetch`'s doc comment).
  ipcMain.handle(IPC_CHANNELS.cancelFetch, (_evt, requestId: string) => {
    session.cancelFetch(requestId);
  });

  // --- pull (specs/online-sync-pull.md, FR-338 through FR-343) ---
  //
  // Mirrors `fetchAllRemotes` above exactly: same `registerFetch`/`clearFetch`/`cancelFetch`
  // bookkeeping on `session` (a plain `requestId`-keyed `AbortController` map with no fetch-
  // specific meaning of its own — reused here rather than duplicated, since `pull()`'s own only
  // cancellable phase IS a `fetchRemote()` call, per `PullOptions.signal`'s own doc comment in
  // `@githydra/git-core`), same `instanceof OperationCancelledError` check on the LIVE error
  // before it ever reaches `serializeError`, same progress-forwarding shape (now tagged with
  // `IPC_CHANNELS.pullProgressEvent` instead of `fetchProgressEvent`). `result.ok === false`
  // covers every other rejection `Repository.pull()` can produce, including a paused merge/
  // rebase conflict — deliberately not special-cased here, so it serializes exactly like a
  // `mergeCommit()`/`rebaseCommitOnto()` conflict already does (FR-338's "zero new conflict-
  // handling code" guarantee); the renderer tells it apart from a genuine refusal by re-reading
  // `getState()` afterward (`usePullAction.ts`).
  ipcMain.handle(
    IPC_CHANNELS.pull,
    async (_evt, requestId: string, options?: { strategy?: PullStrategy }): Promise<PullIpcOutcome> => {
      const signal = session.registerFetch(requestId);
      try {
        const data: PullOutcome = await session.getOpenRepo().pull({
          strategy: options?.strategy,
          signal,
          onProgress: (event) => {
            mainWindow?.webContents.send(IPC_CHANNELS.pullProgressEvent, requestId, event);
          },
        });
        return { outcome: "settled", result: { ok: true, data } };
      } catch (err) {
        if (err instanceof OperationCancelledError) return { outcome: "cancelled" };
        return { outcome: "settled", result: { ok: false, error: serializeError(err) } };
      } finally {
        session.clearFetch(requestId);
      }
    },
  );

  // Deliberately not wrapped in `toResult`/`IpcResult` — same "best-effort, always-succeeds,
  // idempotent signal" convention as `cancelFetch` above.
  ipcMain.handle(IPC_CHANNELS.cancelPull, (_evt, requestId: string) => {
    session.cancelFetch(requestId);
  });

  // --- push (specs/online-sync-push.md, FR-344 through FR-350) ---
  //
  // FR-345: a pure local-config read (`git remote`) — `listConfiguredRemotes()` is exported
  // standalone from `@githydra/git-core` (not a `Repository` method), so this handler just calls
  // it against the active repo's own `.path`.
  ipcMain.handle(IPC_CHANNELS.listConfiguredRemotes, () =>
    toResult(async () => listConfiguredRemotes(session.getOpenRepo().path)),
  );

  // Mirrors `pull` above exactly: same `registerFetch`/`clearFetch`/`cancelFetch` bookkeeping on
  // `session`, same `instanceof OperationCancelledError` check on the LIVE error before it ever
  // reaches `serializeError`, same progress-forwarding shape (tagged with
  // `IPC_CHANNELS.pushProgressEvent`). `result.ok === false` covers every rejection
  // `Repository.push()` can produce, including a non-fast-forward rejection (FR-346) — the
  // renderer classifies `result.error.stderr` (populated by `serializeError` above for any
  // `GitCommandError`) via `classifyGitNetworkError()`, exactly as it already does for a failed
  // fetch.
  ipcMain.handle(
    IPC_CHANNELS.push,
    async (_evt, requestId: string, remoteName: string, localBranchName: string): Promise<PushIpcOutcome> => {
      const signal = session.registerFetch(requestId);
      try {
        const data: PushOutcome = await session.getOpenRepo().push(remoteName, localBranchName, {
          signal,
          onProgress: (event) => {
            mainWindow?.webContents.send(IPC_CHANNELS.pushProgressEvent, requestId, event);
          },
        });
        return { outcome: "settled", result: { ok: true, data } };
      } catch (err) {
        if (err instanceof OperationCancelledError) return { outcome: "cancelled" };
        return { outcome: "settled", result: { ok: false, error: serializeError(err) } };
      } finally {
        session.clearFetch(requestId);
      }
    },
  );

  // Deliberately not wrapped in `toResult`/`IpcResult` — same "best-effort, always-succeeds,
  // idempotent signal" convention as `cancelFetch`/`cancelPull` above.
  ipcMain.handle(IPC_CHANNELS.cancelPush, (_evt, requestId: string) => {
    session.cancelFetch(requestId);
  });

  // --- clone (specs/online-sync-clone.md, FR-351 through FR-358) ---
  //
  // Mirrors `fetchAllRemotes`/`pull`/`push` above exactly: same `registerFetch`/`clearFetch`/
  // `cancelFetch` bookkeeping on `session` (a plain `requestId`-keyed `AbortController` map with no
  // fetch-specific meaning of its own — reused here rather than duplicated, per FR-354's "reuses
  // Phase 1's exact progress/cancel pattern" requirement), same `instanceof OperationCancelledError`
  // check on the LIVE error before it ever reaches `serializeError`, same progress-forwarding shape
  // (tagged with `IPC_CHANNELS.cloneProgressEvent`). Deliberately NOT scoped to
  // `session.getOpenRepo()` — unlike every other handler in this section, `clone()` creates a
  // brand-new repository at an arbitrary destination the caller chose; there is no existing open
  // repo involved, and this handler never touches `session.repo`. Opening `result.data.path` as a
  // new tab and adding it to Recent Repositories (FR-356) is renderer/ui-graphics work, built on top
  // of this handler's return value, not this handler's own responsibility.
  ipcMain.handle(
    IPC_CHANNELS.clone,
    async (_evt, requestId: string, url: string, destination: string): Promise<CloneIpcOutcome> => {
      const signal = session.registerFetch(requestId);
      try {
        const data: CloneResult = await cloneImpl(url, destination, {
          signal,
          onProgress: (event) => {
            mainWindow?.webContents.send(IPC_CHANNELS.cloneProgressEvent, requestId, event);
          },
        });
        return { outcome: "settled", result: { ok: true, data } };
      } catch (err) {
        if (err instanceof OperationCancelledError) return { outcome: "cancelled" };
        return { outcome: "settled", result: { ok: false, error: serializeError(err) } };
      } finally {
        session.clearFetch(requestId);
      }
    },
  );

  // Deliberately not wrapped in `toResult`/`IpcResult` — same "best-effort, always-succeeds,
  // idempotent signal" convention as `cancelFetch`/`cancelPull`/`cancelPush` above.
  ipcMain.handle(IPC_CHANNELS.cancelClone, (_evt, requestId: string) => {
    session.cancelFetch(requestId);
  });

  // --- reset current branch/HEAD to here (specs/reset-to-here.md, FR-359 through FR-377) ---

  ipcMain.handle(IPC_CHANNELS.resetCurrentBranch, (_evt, targetSha: string, mode: ResetMode) =>
    toResult(async () => session.getOpenRepo().resetCurrentBranch(targetSha, mode)),
  );
  ipcMain.handle(IPC_CHANNELS.countCommitsExclusiveToHead, (_evt, targetSha: string, headSha: string) =>
    toResult(async () => session.getOpenRepo().countCommitsExclusiveToHead(targetSha, headSha)),
  );

  // --- git identity & SSH key profiles (specs/git-identity-profiles.md, FR-329 through FR-337) ---

  // security-reviewer finding: `knownApplication` (the renderer's own `useIdentityApplications.ts`
  // localStorage record for the open repo, or `null`) is the ONLY trust source
  // `getIdentityConfigState()`/`removeIdentityProfileApplication()` use to decide whether a config
  // key is GitHydra-managed — never anything read from the repo's own `.git/config`, which this
  // app opens from arbitrary (including untrusted) sources. See `identityProfile.ts`'s module doc
  // comment (git-core) for the full rationale.
  ipcMain.handle(
    IPC_CHANNELS.getIdentityConfigState,
    (_evt, knownApplication: ExpectedIdentityApplication | null) =>
      toResult(async () => session.getOpenRepo().getIdentityConfigState(knownApplication)),
  );
  ipcMain.handle(IPC_CHANNELS.applyIdentityProfile, (_evt, options: ApplyIdentityProfileOptions) =>
    toResult(async () => session.getOpenRepo().applyIdentityProfile(options)),
  );
  ipcMain.handle(
    IPC_CHANNELS.removeIdentityProfileApplication,
    (_evt, knownApplication: ExpectedIdentityApplication | null) =>
      toResult(async () => session.getOpenRepo().removeIdentityProfileApplication(knownApplication)),
  );
  // FR-332: the ONLY way an SSH identity-file path ever enters this app. Not repo-scoped (no
  // `session.getOpenRepo()` call) — building/editing a profile in the library never requires a
  // repo to be open. Defaults into `~/.ssh` when it exists (the overwhelmingly common location for
  // an SSH private key) purely as a starting point — the user can browse anywhere; this never
  // restricts which path can be picked.
  ipcMain.handle(IPC_CHANNELS.pickSshIdentityFile, () =>
    toResult(async () => {
      if (!mainWindow) return null;
      const sshDir = path.join(os.homedir(), ".ssh");
      const defaultPath = fs.existsSync(sshDir) ? sshDir : undefined;
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ["openFile", "showHiddenFiles"],
        title: "Select an SSH private key file",
        defaultPath,
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0] ?? null;
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
  mainWindow.webContents.on("unresponsive", () => closeGuard.rendererUnresponsive());
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    closeGuard.rendererGone();
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
    if (isMainFrame && !isInPlace) {
      session.dispose();
      closeGuard.rendererGone();
    }
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
  mainWindow.on("close", (event: { preventDefault(): void }) => closeGuard.onWindowClose(event));
  // Never veto logoff/shutdown/restart: a veto only produces a "blocked shutdown" screen and the buffer is lost anyway.
  mainWindow.on("query-session-end", () => closeGuard.sessionEnding());
  mainWindow.on("session-end", () => closeGuard.sessionEnding({ final: true }));

  mainWindow.on("closed", () => {
    mainWindow = null;
    closeGuard.dispose();
    session.dispose();
  });
}

app.whenReady().then(() => {
  // specs/keyboard-shortcuts-command-palette.md FR-226/AC7: see `buildApplicationMenu`'s own doc
  // comment — must be set before `createWindow()` so the window never has even a brief window with
  // Electron's own default (Reload-accelerator-carrying) menu active.
  Menu.setApplicationMenu(buildApplicationMenu());
  registerIpcHandlers();
  powerMonitor?.on("shutdown", () => closeGuard.sessionEnding({ final: true }));
  createWindow();
  // specs/edit-recovery-draft.md FR-547: after the window exists, on a later tick; purge is fully async and never rejects.
  setImmediate(() => {
    try {
      void getDraftStore().purge();
    } catch {
      // Quiet by design (FR-548): retried at the next list.
    }
  });
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

app.on("before-quit", () => closeGuard.noteQuitRequested());

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
