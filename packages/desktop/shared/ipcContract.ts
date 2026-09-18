// SPDX-License-Identifier: GPL-3.0-or-later
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
  CloneResult,
  CommitInfo,
  CommitLogFilter,
  CommitLogPage,
  CommitPairRelationship,
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
  FetchAllRemotesResult,
  FetchProgressEvent,
  ApplyIdentityProfileOptions,
  ExpectedIdentityApplication,
  FileDiffResult,
  IdentityConfigState,
  ImageDiffResult,
  LocalBranchInfo,
  PullOutcome,
  PullStrategy,
  PushOutcome,
  RefInfo,
  RemoteBranchInfo,
  RemoveIdentityProfileResult,
  RepositoryState,
  ResetMode,
  ResumeCommitLogFrom,
  StashApplyOutcome,
  StashDiffResult,
  StashInfo,
  SwitchResult,
  WorkingDirectoryChanges,
} from "@githydra/git-core";

export const IPC_CHANNELS = {
  openRepoDialog: "repo:openDialog",
  openRepo: "repo:open",
  // specs/repo-open-feedback.md FR-163/FR-164/FR-165: a cancellable variant of `openRepo`, keyed
  // by a caller-generated `requestId` — see `openRepoCancellable`'s own doc comment below for the
  // full contract. `openRepo` itself is untouched (never cancellable) for every existing caller.
  openRepoCancellable: "repo:openCancellable",
  cancelOpenRepo: "repo:openCancel",
  // specs/repo-open-feedback-fixes.md FR-197/FR-199: the two bookkeeping calls that close out a
  // cancellable open attempt's full lifecycle (see `commitOpenRepo`/`endOpenAttempt`'s own doc
  // comments below) — extending cancellation to the aux-data/log-reader phases requires the
  // renderer to explicitly tell the main process "this attempt is fully done" (one of these two),
  // since that work now spans several separate IPC round trips after `openRepoCancellable` itself.
  commitOpenRepo: "repo:openCommit",
  endOpenAttempt: "repo:openEnd",
  // specs/repo-list.md (revised IA) / security review: an explicit "tear down the live session
  // with no new repo replacing it" round trip — see `closeRepoSession`'s own doc comment on
  // `GitHydraApi` below for why this needed its own channel rather than reusing `openRepo`.
  closeRepoSession: "repo:closeSession",
  getState: "repo:getState",
  getRefs: "repo:getRefs",
  createLogReader: "repo:createLogReader",
  readPage: "repo:readPage",
  closeReader: "repo:closeReader",
  getCommit: "repo:getCommit",
  getChangedFiles: "repo:getChangedFiles",
  // specs/compare-commits.md FR-182/FR-188: the two-arbitrary-commit counterparts of
  // `getChangedFiles`/`getCommitFileDiff` above, both endpoints caller-supplied instead of one
  // being derived from `parents[0]`.
  getChangedFilesBetween: "repo:getChangedFilesBetween",
  getCommitRangeFileDiff: "repo:getCommitRangeFileDiff",
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
  // specs/image-diff-preview.md FR-142/FR-144: image-diff content for each of the same four
  // bases, mirroring the four `*FileDiff` channels above 1:1.
  getUnstagedImageDiff: "repo:getUnstagedImageDiff",
  getStagedImageDiff: "repo:getStagedImageDiff",
  getUntrackedImageDiff: "repo:getUntrackedImageDiff",
  getCommitImageDiff: "repo:getCommitImageDiff",
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
  // specs/amend-last-commit.md FR-154: amend HEAD's commit.
  amendCommit: "repo:amendCommit",
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
  // specs/drag-commit-menu.md, FR-295 through FR-319.
  computeCommitPairRelationship: "repo:computeCommitPairRelationship",
  mergeCommit: "repo:mergeCommit",
  rebaseCommitOnto: "repo:rebaseCommitOnto",
  // specs/online-sync-fetch.md FR-326/FR-327: the first network-capable IPC surface — cancellable
  // (same requestId/AbortController convention `openRepoCancellable`/`cancelOpenRepo` already
  // established) with a main-to-renderer progress event channel alongside it (mirroring
  // `refsChangedEvent`'s existing send-channel pattern).
  fetchAllRemotes: "repo:fetchAllRemotes",
  cancelFetch: "repo:fetchCancel",
  fetchProgressEvent: "repo:fetchProgress",
  // specs/online-sync-pull.md FR-338 through FR-343: same cancellable/progress-event shape as
  // `fetchAllRemotes` above (pull's own only new git call is a plain `--ff-only` merge or the
  // already-shipped `mergeCommit()`/`rebaseCommitOnto()`, none of which stream progress — the one
  // in-flight phase this progress event channel ever carries is pull's own internal fetch).
  pull: "repo:pull",
  cancelPull: "repo:pullCancel",
  pullProgressEvent: "repo:pullProgress",
  // specs/online-sync-push.md FR-344 through FR-350: same cancellable/progress-event shape as
  // `fetchAllRemotes`/`pull` above — push's own one network call reuses `runNetworkGitProcess()`
  // exactly as `pull()`'s fetch phase does (FR-348: no parallel implementation).
  push: "repo:push",
  cancelPush: "repo:pushCancel",
  pushProgressEvent: "repo:pushProgress",
  // specs/online-sync-clone.md FR-351 through FR-358: same cancellable/progress-event shape as
  // `fetchAllRemotes`/`pull`/`push` above — clone's one network call reuses `runNetworkGitProcess()`
  // exactly as those three do (FR-354: no parallel implementation). Deliberately NOT repo-scoped —
  // unlike every channel above it, this creates a brand-new repository at an arbitrary destination;
  // there is no existing open repo involved.
  clone: "repo:clone",
  cancelClone: "repo:cloneCancel",
  cloneProgressEvent: "repo:cloneProgress",
  // FR-345: the remote picker's data source — every remote name `git remote` currently lists (a
  // pure local config read; git-core's own `listConfiguredRemotes()` is exported standalone rather
  // than as a `Repository` method, so this channel just wraps that call against the active repo's
  // path).
  listConfiguredRemotes: "repo:listConfiguredRemotes",
  // specs/reset-to-here.md, FR-359 through FR-377.
  resetCurrentBranch: "repo:resetCurrentBranch",
  countCommitsExclusiveToHead: "repo:countCommitsExclusiveToHead",
  // specs/git-identity-profiles.md, FR-329 through FR-337.
  getIdentityConfigState: "repo:getIdentityConfigState",
  applyIdentityProfile: "repo:applyIdentityProfile",
  removeIdentityProfileApplication: "repo:removeIdentityProfileApplication",
  // FR-332: not repo-scoped (no `session.getOpenRepo()` call in its handler) — the profile library
  // itself doesn't require any repo to be open.
  pickSshIdentityFile: "app:pickSshIdentityFile",
} as const;

/** Minimal, structured-clone-safe serialization of git-core's typed Error classes. */
export interface IpcError {
  name: string;
  message: string;
  /**
   * specs/online-sync-push.md FR-346: populated ONLY when the underlying failure was a real
   * `GitCommandError` — the exact `stderr` text (already passed through `redactGitCredentials()`,
   * safe to display/log directly) `classifyGitNetworkError()` needs to tell a non-fast-forward
   * push rejection apart from every other push failure. `message` already contains this same text
   * (appended after the "exited with code N:" prefix `GitCommandError`'s own constructor builds),
   * so this field exists purely so a caller (`usePushAction`, `PushStatusBanner`'s collapsible
   * "Details" disclosure) can classify/show the EXACT stderr git produced, with no extra prefix
   * text glued onto it. Omitted (`undefined`) for every other error kind and for every existing
   * caller that doesn't read it — purely additive, never a breaking change to any other IPC result.
   */
  stderr?: string;
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcError };

export interface OpenRepoResult {
  /**
   * specs/repo-open-feedback-fixes.md FR-202: git's own resolved repository root
   * (`RepositoryState.workdir`) for an ordinary repository — never the raw path the caller
   * supplied when the two differ (e.g. a subfolder of a larger repo's working tree was picked).
   * For a bare repository (no separate working directory to resolve to), this equals
   * `pickedPath` unchanged. This is the value every consumer (Recent Repositories, `RepoTab.
   * repoPath`, the cross-tab dedup check) should key off — not `pickedPath`.
   */
  path: string;
  /**
   * specs/repo-open-feedback-fixes.md FR-202/FR-204: the raw, caller-supplied path this attempt
   * was actually invoked with — kept alongside `path` (rather than discarded) specifically so a
   * UI surface that wants to show "you picked X, which resolved to Y" (e.g. Recent Repositories'
   * secondary context for the subfolder-of-a-larger-repo case) has both values available. Equal
   * to `path` whenever the two don't diverge (the common case).
   */
  pickedPath: string;
  state: RepositoryState;
}

/**
 * specs/repo-open-feedback.md FR-165: `openRepoCancellable`'s return shape — a distinct, THIRD
 * outcome from both success and failure. Deliberately not folded into `IpcResult<OpenRepoResult>`
 * itself (e.g. a synthetic `{ ok: false, error: { name: "OperationCancelledError", ... } }`) so a
 * caller can branch on `outcome === "cancelled"` — a plain property check, never string-parsing an
 * error message, and never even needing to know the cancellation error class's exact `.name`
 * string. `"settled"` carries the exact same `IpcResult<OpenRepoResult>` shape `openRepo` always
 * has, so an `unwrap()`-style helper still works unchanged on `.result`.
 */
export type OpenRepoOutcome =
  | { outcome: "settled"; result: IpcResult<OpenRepoResult> }
  | { outcome: "cancelled" };

/**
 * specs/online-sync-fetch.md FR-322/FR-327: `fetchAllRemotes`'s return shape — the exact same
 * distinct-third-outcome convention as `OpenRepoOutcome` above (`"cancelled"` is never folded into
 * `IpcResult`'s `{ ok: false, ... }` shape), for the identical reason: a caller should branch on
 * `outcome` with a plain property check, never by inspecting an error's `.name` string.
 */
export type FetchOutcome =
  | { outcome: "settled"; result: IpcResult<FetchAllRemotesResult> }
  | { outcome: "cancelled" };

/**
 * specs/online-sync-pull.md FR-338/FR-343: `pull`'s return shape — the identical distinct-third-
 * outcome convention `FetchOutcome`/`OpenRepoOutcome` already establish. `result.ok === false`
 * covers every rejection `Repository.pull()` can produce, INCLUDING a paused conflict (a
 * `GitCommandError` from the underlying `git merge`/`git rebase`, exactly like `mergeCommit()`/
 * `rebaseCommitOnto()`'s own existing IPC shape at `Promise<IpcResult<void>>`) — this is
 * deliberate, not a gap: FR-338 requires a pull-triggered conflict to be indistinguishable, from
 * the caller's side, from a conflict reached through the existing drag-menu Merge/Rebase actions,
 * which also surface a conflict as an `IpcResult` failure the caller tells apart from a genuine
 * refusal by re-reading `getState()` afterward (see `usePullAction.ts`'s own doc comment).
 */
export type PullIpcOutcome =
  | { outcome: "settled"; result: IpcResult<PullOutcome> }
  | { outcome: "cancelled" };

/**
 * specs/online-sync-push.md FR-344/FR-348: `push`'s return shape — the identical distinct-third-
 * outcome convention `FetchOutcome`/`PullIpcOutcome` already establish. `result.ok === false`
 * covers every rejection `Repository.push()` can produce, including a non-fast-forward rejection
 * (FR-346) — that specific case is told apart from any other failure by classifying `result.error
 * .stderr` (when present) with `classifyGitNetworkError()`, exactly as already done for a failed
 * fetch/pull.
 */
export type PushIpcOutcome =
  | { outcome: "settled"; result: IpcResult<PushOutcome> }
  | { outcome: "cancelled" };

/**
 * specs/online-sync-clone.md FR-352/FR-354: `clone`'s return shape — the identical distinct-third-
 * outcome convention `FetchOutcome`/`PullIpcOutcome`/`PushIpcOutcome` already establish.
 * `result.ok === false` covers every rejection `clone()` can produce, including FR-353's real
 * "destination not empty" refusal (surfaced verbatim via `IpcError.stderr`, same as a push
 * rejection) and FR-357's credential-failure classification (`result.error.stderr`, classified with
 * `classifyGitNetworkError()` exactly as an equivalent fetch/push failure already is).
 */
export type CloneIpcOutcome =
  | { outcome: "settled"; result: IpcResult<CloneResult> }
  | { outcome: "cancelled" };

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
  /**
   * specs/repo-open-feedback.md FR-163/FR-164/FR-165: cancellable variant of `openRepo`, for the
   * UI's Cancel affordance (FR-167/FR-168) to build on. `requestId` is a caller-generated,
   * caller-unique-per-in-flight-attempt string (e.g. a UUID or an incrementing counter stringified)
   * — it has no meaning beyond correlating this call with a later `cancelOpenRepo(requestId)`
   * call for the SAME attempt, and is never persisted or reused across attempts.
   *
   * Resolves `{ outcome: "cancelled" }` (FR-165: a distinct, third outcome — never a rejected
   * promise, never an `IpcResult` carrying `GitCommandError`/`GitCommandTimeoutError`) if
   * `cancelOpenRepo(requestId)` won the race against this call settling; otherwise resolves
   * `{ outcome: "settled", result }` where `result` is the exact same `IpcResult<OpenRepoResult>`
   * shape `openRepo` itself always returns (success or a genuine error) — so a caller only needs
   * to branch once, on `outcome`, before falling back to `openRepo`'s existing success/error
   * handling unchanged.
   *
   * `openRepo` above is left completely untouched (no `requestId`, never cancellable via this
   * mechanism) for every other existing caller/test — this is a strictly additive surface.
   */
  openRepoCancellable(path: string, requestId: string): Promise<OpenRepoOutcome>;
  /**
   * specs/repo-open-feedback.md FR-163/FR-164: aborts the specific in-flight
   * `openRepoCancellable(path, requestId)` attempt matching `requestId`, terminating its
   * underlying git child process via the same SIGTERM-then-grace-then-SIGKILL escalation used
   * for a timeout (git-core's `armTimeout()`) — never leaves an orphaned OS process behind.
   * Resolves successfully as a no-op if `requestId` doesn't match any currently in-flight attempt
   * (already settled, already cancelled, or never existed) — cancelling is idempotent and safe to
   * call speculatively, no confirmation/preconditions required (FR-9 in the spec's acceptance
   * criteria: no confirmation step).
   */
  cancelOpenRepo(requestId: string): Promise<void>;
  /**
   * specs/repo-open-feedback-fixes.md FR-197/FR-199: promotes `requestId`'s already-opened
   * repository (from a prior `openRepoCancellable(path, requestId)` call) to the actually-live
   * session — tearing down whatever repo/readers/watcher were live before ONLY NOW — and starts
   * its ref-change watcher. Call this once every later phase of the SAME open attempt
   * (`getRefs`/`getUpstreamBranch`/`getWorkingDirectoryChanges`/`listStashes`/`createLogReader`/
   * `readPage`, each passed the same `requestId`) has also succeeded — never right after
   * `openRepoCancellable` itself resolves. A safe no-op if `requestId` has nothing staged (e.g.
   * this attempt was cancelled, errored, or was superseded before reaching this point) — always
   * resolves `{ ok: true }` either way, since there is nothing about this call that can
   * meaningfully fail. Must always be followed by `endOpenAttempt(requestId)` (directly, or
   * implicitly since a caller's own cleanup should call it unconditionally).
   */
  commitOpenRepo(requestId: string): Promise<IpcResult<void>>;
  /**
   * specs/repo-open-feedback-fixes.md FR-197: releases every piece of `requestId`'s bookkeeping
   * (its cancellation signal, and any not-yet-committed pending repo/reader from this same
   * attempt) once the caller's own `openRepo()` sequence has genuinely settled for ANY reason —
   * success (after `commitOpenRepo`, as a harmless no-op there), a genuine error at any phase, a
   * cancellation at any phase, or an attempt superseded by a newer one before it even finished the
   * repo-validity check. Every cancellable open attempt must call this exactly once, unconditionally
   * (e.g. from a `finally`), or `requestId`'s bookkeeping leaks for the app's remaining lifetime.
   * Idempotent and safe to call more than once, or for an unknown `requestId` — same "always-
   * succeeds, no meaningful failure mode" convention as `cancelOpenRepo`.
   */
  endOpenAttempt(requestId: string): Promise<void>;
  /**
   * specs/repo-list.md (revised IA) / security review: tears down the ONE live main-process
   * session — closes every open commit-log/file-history reader, closes the ref-change file
   * watcher, and clears the live `Repository` — with no new repo replacing it. Every other way
   * a repo stops being "the live one" (`openRepo`/`openRepoCancellable` opening a different path)
   * already tears down the previous session as a side effect of `RepoSession.open()`'s own
   * teardown-then-reopen sequence; this channel exists for the one case that ISN'T immediately
   * followed by a new open — "+ New tab" (deactivates to the idle landing screen) and closing the
   * last remaining tab (`useRepositoryGraph`'s `closeRepo()`, this channel's one caller). Without
   * it, that previous repo's `fs.watch` handle stayed alive for as long as the app sat on the idle
   * screen afterward, firing `refsChangedEvent` into the main process for no live UI to act on.
   * Always resolves `{ ok: true, data: undefined }` — there is nothing about disposing a session
   * that can meaningfully fail; a no-op (no session was open) is not an error.
   */
  closeRepoSession(): Promise<IpcResult<void>>;
  getState(): Promise<IpcResult<RepositoryState>>;
  /**
   * specs/repo-open-feedback-fixes.md FR-197: `requestId`, when supplied, is ALWAYS the caller's
   * own still-in-flight cancellable `openRepo` attempt's id — it makes this call resolve against
   * that attempt's own (possibly still-pending) repo and makes it abortable via the attempt's own
   * signal, for as long as `commitOpenRepo`/`endOpenAttempt` hasn't released it yet. Every other
   * (non-open-sequence) caller omits it and gets today's exact behavior, unchanged.
   */
  getRefs(requestId?: string): Promise<IpcResult<RefInfo[]>>;
  /**
   * specs/instant-tab-revisit.md FR-245: `resumeAfter`, when supplied, is git-core's
   * `Repository.createCommitLogReader()`'s own `resumeAfter` option threaded straight through —
   * it silently fast-forwards the newly-created reader past `resumeAfter.skip` already-cached
   * commits (verified against `resumeAfter.sha`, the last of those cached commits) before this
   * resolves, so the reader's very first `readPage()` call transparently returns what would
   * otherwise have been its page TWO. Intended caller: `loadMore()` on a tab that just
   * fast-path-reactivated (FR-242) with cached rows but no live `readerId` yet — it creates a
   * reader here with `resumeAfter` set to `{ skip: cachedRows.length, sha: cachedRows.at(-1).sha
   * }` instead of the ordinary no-`resumeAfter` call every other `createLogReader` caller makes.
   * Rejects with an error named `"ReaderResumeMismatchError"` (never resolves with any commit
   * data) if the fast-forwarded position doesn't actually match `resumeAfter.sha` — expected to
   * be unreachable given FR-241/242's fresh-comparison gate, but callers must treat it as "fall
   * back to a full reload" (mirroring FR-243's existing fallback), never retry blindly or surface
   * it as a generic error toast.
   */
  createLogReader(
    filter: CommitLogFilter | undefined,
    requestId?: string,
    resumeAfter?: ResumeCommitLogFrom,
  ): Promise<IpcResult<string>>;
  readPage(readerId: string, count: number): Promise<IpcResult<CommitLogPage>>;
  closeReader(readerId: string): Promise<IpcResult<void>>;
  getCommit(shaOrPrefix: string): Promise<IpcResult<CommitInfo | null>>;
  getChangedFiles(commit: ChangedFilesRequest): Promise<IpcResult<ChangedFile[]>>;
  /**
   * specs/compare-commits.md FR-182: files that differ between two arbitrary, caller-supplied
   * commits — no ancestry relationship required (FR-184). Works against a bare repository (FR-185).
   */
  getChangedFilesBetween(baseSha: string, targetSha: string): Promise<IpcResult<ChangedFile[]>>;
  getWorkingDirStatus(): Promise<IpcResult<WorkingDirectoryStatus | null>>;
  /** Short name of the current branch's upstream (e.g. "origin/main"), or null if none/detached.
   * specs/repo-open-feedback-fixes.md FR-197: same optional open-attempt `requestId` convention
   * as `getRefs`. */
  getUpstreamBranch(requestId?: string): Promise<IpcResult<string | null>>;
  /** Subscribe to best-effort FR-6 ref-change notifications. Returns an unsubscribe function. */
  onRefsChanged(listener: () => void): () => void;

  /** FR-19/FR-28: per-file working-directory change list. `null` for a bare repo.
   * specs/repo-open-feedback-fixes.md FR-197: same optional open-attempt `requestId` convention
   * as `getRefs`. */
  getWorkingDirectoryChanges(requestId?: string): Promise<IpcResult<WorkingDirectoryChanges | null>>;
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
  /**
   * specs/compare-commits.md FR-181/FR-188: an arbitrary two-commit file diff, extending
   * `getChangedFilesBetween()`'s name-status-only comparison to full patch content — the same
   * binary/too-large/patch pipeline `getCommitFileDiff` uses. Works against a bare repository
   * (FR-185).
   */
  getCommitRangeFileDiff(
    baseSha: string,
    targetSha: string,
    file: FileRefRequest,
    options?: DiffOptions,
  ): Promise<IpcResult<FileDiffResult>>;

  // --- image diff preview (specs/image-diff-preview.md FR-142/FR-144) ---
  // Same four bases as the `*FileDiff` methods above, mirrored 1:1 — see `ImageDiffResult`'s own
  // doc comment (git-core) for the "ok"/"too-large" shape. No `DiffOptions`: image content has no
  // hunk-context/changed-line-count guard to configure, only FR-141's fixed 25MB-per-side cap.
  /** FR-142: unstaged (worktree vs index) image-diff content for a single image-eligible file. */
  getUnstagedImageDiff(path: string): Promise<IpcResult<ImageDiffResult>>;
  /** FR-142: staged (index vs HEAD) image-diff content for a single image-eligible file. */
  getStagedImageDiff(path: string): Promise<IpcResult<ImageDiffResult>>;
  /** FR-142: untracked image-eligible file content, shown as an "Added" image with no old side. */
  getUntrackedImageDiff(path: string): Promise<IpcResult<ImageDiffResult>>;
  /** FR-142: a historical commit's image-diff content, mirroring `getCommitFileDiff`'s rename
   * handling via `file.oldPath`. */
  getCommitImageDiff(commit: ChangedFilesRequest, file: FileRefRequest): Promise<IpcResult<ImageDiffResult>>;

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

  /** specs/amend-last-commit.md FR-154: amend HEAD's commit — same `CreateCommitOptions` shape as
   * `createCommit`, folding whatever is currently staged (if anything) into the amended commit. */
  amendCommit(options: CreateCommitOptions): Promise<IpcResult<CreateCommitResult>>;

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
  /** specs/repo-open-feedback-fixes.md FR-197: same optional open-attempt `requestId` convention
   * as `getRefs`. */
  listStashes(requestId?: string): Promise<IpcResult<StashInfo[] | null>>;
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

  // --- drag-commit contextual action menu (specs/drag-commit-menu.md, FR-295 through FR-319) ---

  /** FR-295/303: the drag-drop menu's ancestry classification for a distinct commit pair —
   * called exactly once, at drop time (never during the drag itself, never on hover). Works
   * against a bare repository (no `requireWorkdir` call in git-core — matches FR-17's "Compare
   * remains fully usable on a bare repo" requirement). */
  computeCommitPairRelationship(shaA: string, shaB: string): Promise<IpcResult<CommitPairRelationship>>;
  /** FR-297/FR-312: `git merge <otherSha>` against current HEAD. A clean fast-forward/merge
   * commit and a paused conflict are indistinguishable from this call's own settlement alone —
   * the caller re-reads `getState()` afterward, exactly like `cherryPick()`. */
  mergeCommit(otherSha: string): Promise<IpcResult<void>>;
  /** FR-298/FR-313: `git rebase <newBaseSha>` against current HEAD, git's plain non-interactive
   * form. Same "re-read state afterward" contract as `mergeCommit`. */
  rebaseCommitOnto(newBaseSha: string): Promise<IpcResult<void>>;

  // --- fetch (specs/online-sync-fetch.md, FR-320 through FR-328) ---

  /**
   * FR-321/FR-327: `git-core`'s `fetchAllRemotes()` against the active tab's repository —
   * git-core's own FR-321 doc comment covers the sequential-per-remote/never-`--all` semantics;
   * this is purely the IPC wrapper. `requestId` is a caller-generated, caller-unique-per-in-flight-
   * attempt string, the exact same convention `openRepoCancellable`'s own doc comment documents —
   * it correlates this call with a later `cancelFetch(requestId)` call and with this same attempt's
   * `onFetchProgress` events, and has no meaning beyond that (never persisted/reused across
   * attempts). Resolves `{ outcome: "cancelled" }` if `cancelFetch(requestId)` won the race;
   * otherwise `{ outcome: "settled", result }` where `result` is a normal `IpcResult` — `ok: false`
   * only for a genuine transport-level failure (e.g. no repository open), never for an individual
   * remote's own fetch failure, which is instead one entry in `result.data.outcomes` (FR-321's own
   * per-remote attribution — never collapsed into a single opaque error).
   */
  fetchAllRemotes(requestId: string): Promise<FetchOutcome>;
  /**
   * FR-322: aborts the specific in-flight `fetchAllRemotes(requestId)` attempt matching
   * `requestId`, terminating whichever remote's `git fetch` child process is currently running via
   * the same SIGTERM-then-grace-then-SIGKILL escalation `cancelOpenRepo` already uses. A safe no-op
   * (never throws) if `requestId` doesn't match any currently in-flight attempt — cancelling is
   * idempotent, same convention as `cancelOpenRepo`. Per FR-321's own doc comment, any remote
   * fetched successfully before the cancellation took effect keeps its already-updated
   * tracking refs; only the in-flight/not-yet-started remotes are affected.
   */
  cancelFetch(requestId: string): Promise<void>;
  /**
   * FR-322: subscribe to incremental progress for every in-flight `fetchAllRemotes` attempt. Every
   * event carries the `requestId` of the attempt it belongs to (mirroring `FetchProgressEvent`'s
   * own `remoteName` tagging one level up) so a listener can ignore progress from an attempt it no
   * longer cares about (e.g. one it just cancelled). Returns an unsubscribe function, matching
   * `onRefsChanged`'s convention.
   */
  onFetchProgress(listener: (requestId: string, event: FetchProgressEvent) => void): () => void;

  // --- pull (specs/online-sync-pull.md, FR-338 through FR-343) ---

  /**
   * FR-338/FR-339: `git-core`'s `pull()` against the active tab's repository — fetches the
   * current branch's configured upstream, then integrates via fast-forward or the resolved/
   * overridden merge-vs-rebase strategy. `options.strategy` is FR-339's explicit per-pull
   * override; omitted (or `undefined`) lets git-core resolve the repo's own
   * `branch.<name>.rebase`/`pull.rebase` config, exactly as real `git pull` would — this call
   * never writes either key itself, and neither does git-core underneath it.
   *
   * Same cancellable/`requestId` convention as `fetchAllRemotes` (only the fetch phase is
   * cancellable — see `PullOptions.signal`'s own doc comment in `@githydra/git-core`). Resolves
   * `{ outcome: "cancelled" }` if `cancelPull(requestId)` won the race; otherwise
   * `{ outcome: "settled", result }`. `result.ok === false` covers every rejection, including a
   * paused merge/rebase conflict — the caller re-reads `getState()` afterward to tell a genuine
   * refusal apart from the expected pause, the exact same way the drag-menu's Merge/Rebase actions
   * already do for `mergeCommit()`/`rebaseCommitOnto()` (FR-338's "zero new conflict-handling
   * code" guarantee).
   */
  pull(requestId: string, options?: { strategy?: PullStrategy }): Promise<PullIpcOutcome>;
  /**
   * FR-339: aborts the specific in-flight `pull(requestId)` attempt's fetch phase, matching
   * `cancelFetch`'s own idempotent, safe-no-op-on-unknown-`requestId` contract. Once the fetch
   * phase has completed, the local fast-forward/merge/rebase step that follows is not itself
   * cancellable (matching `PullOptions.signal`'s own doc comment) — a cancel call arriving after
   * that point is a no-op, exactly like calling `cancelFetch` after a fetch already settled.
   */
  cancelPull(requestId: string): Promise<void>;
  /**
   * FR-339: subscribe to incremental progress for every in-flight `pull` attempt's fetch phase —
   * identical shape/semantics to `onFetchProgress` (events tagged with the owning `requestId`, so
   * a listener can ignore a superseded/cancelled attempt's trailing events).
   */
  onPullProgress(listener: (requestId: string, event: FetchProgressEvent) => void): () => void;

  // --- push (specs/online-sync-push.md, FR-344 through FR-350) ---

  /**
   * FR-345: every remote name `git remote` currently lists, in git's own order — the sole data
   * source the remote picker needs (shown only when more than one remote exists; a single-remote
   * repo pushes to it with zero extra click). A pure local-config read, never a network call.
   */
  listConfiguredRemotes(): Promise<IpcResult<string[]>>;
  /**
   * FR-344/FR-345: `git-core`'s `push(remoteName, localBranchName)` against the active repo —
   * pushes to `localBranchName`'s already-configured upstream on `remoteName` when one exists
   * there (an explicit `<local>:<upstream>` refspec), else publishes it via `--set-upstream`. Same
   * cancellable/`requestId`/progress convention as `fetchAllRemotes`/`pull` — this reuses the exact
   * same `runNetworkGitProcess()` harness (FR-348: no parallel implementation). `result.ok ===
   * false` covers every rejection, including a non-fast-forward rejection (FR-346) — classify
   * `result.error.stderr` (populated whenever the underlying failure was a `GitCommandError`) with
   * `classifyGitNetworkError()`, the identical technique already used for a failed fetch, to get
   * the "pull first" message.
   *
   * This method's signature is deliberately closed — exactly `(requestId, remoteName,
   * localBranchName)`, nothing else — so no force/delete/tags/all/mirror option can ever be
   * threaded through it (specs/online-sync-push.md's Non-goals are a hard requirement, not a
   * default to weigh against convenience; see `noForcePush.test.ts`'s black-box proof).
   */
  push(requestId: string, remoteName: string, localBranchName: string): Promise<PushIpcOutcome>;
  /**
   * FR-348: aborts the specific in-flight `push(requestId)` attempt, matching `cancelFetch`'s own
   * idempotent, safe-no-op-on-unknown-`requestId` contract.
   */
  cancelPush(requestId: string): Promise<void>;
  /**
   * FR-348: subscribe to incremental progress for every in-flight `push` attempt — identical
   * shape/semantics to `onFetchProgress`/`onPullProgress`.
   */
  onPushProgress(listener: (requestId: string, event: FetchProgressEvent) => void): () => void;

  // --- clone (specs/online-sync-clone.md, FR-351 through FR-358) ---

  /**
   * FR-352: `git-core`'s `clone(url, destination)` — plain, two positional args only (see the
   * spec's own Non-goals: no `--depth`/`--recurse-submodules`/`--mirror`/`--bare`, ever). Same
   * cancellable/`requestId`/progress convention as `fetchAllRemotes`/`pull`/`push` — this reuses the
   * exact same `runNetworkGitProcess()` harness (FR-354: no parallel implementation). Deliberately
   * NOT scoped to any already-open repository: this creates a brand-new one at `destination`.
   *
   * FR-353: `result.ok === false` covers every rejection, including git's own real refusal when
   * `destination` already contains files — surfaced verbatim via `result.error.stderr`/`.message`,
   * never silently merged into or overwritten. FR-355: cancelling deletes `destination` if and only
   * if this call itself created it (tracked internally by `git-core`'s `clone()`, never inferred
   * from the directory merely being empty) — a pre-existing directory the caller pointed at is
   * never touched either way. FR-357: a credential failure classifies via `classifyGitNetworkError()`
   * exactly as an equivalent fetch/push failure already does (`result.error.stderr`).
   *
   * On success, `result.data.path` is the resolved absolute destination path — the caller opens
   * this as a new tab and adds it to Recent Repositories (FR-356), which is this app's own
   * `multi-repo-tabs.md`/`repo-list.md` flow, not this method's concern.
   */
  clone(requestId: string, url: string, destination: string): Promise<CloneIpcOutcome>;
  /**
   * FR-354: aborts the specific in-flight `clone(requestId)` attempt, matching `cancelFetch`'s own
   * idempotent, safe-no-op-on-unknown-`requestId` contract.
   */
  cancelClone(requestId: string): Promise<void>;
  /**
   * FR-354: subscribe to incremental progress for every in-flight `clone` attempt — identical
   * shape/semantics to `onFetchProgress`/`onPullProgress`/`onPushProgress`.
   */
  onCloneProgress(listener: (requestId: string, event: FetchProgressEvent) => void): () => void;

  // --- reset current branch/HEAD to here (specs/reset-to-here.md, FR-359 through FR-377) ---

  /**
   * FR-359: move current `HEAD` (attached branch or detached) directly to `targetSha` via exactly
   * one of `git reset --soft/--mixed/--hard <targetSha>` — `mode` is always passed explicitly.
   * Always acts on whatever `HEAD` already is; no target-branch parameter. Throws
   * `InvalidArgumentError` for a malformed `targetSha` (FR-361) and
   * `OperationAlreadyInProgressError` (no git call made) when a merge/rebase/cherry-pick/revert/
   * am/bisect is already in progress (FR-360). Deliberately adds no bare-repository/unborn-HEAD
   * check of its own — the UI layer (FR-366) is the gate that keeps this call from ever being
   * reachable in either state.
   */
  resetCurrentBranch(targetSha: string, mode: ResetMode): Promise<IpcResult<void>>;
  /**
   * FR-364: `git rev-list --count <targetSha>..<headSha>` — a pure read previewing a prospective
   * reset's impact (FR-368) before the user confirms. Never rejects for an ordinary failure (a
   * malformed/unresolvable SHA, a shallow-clone boundary, ...) — resolves `{ ok: true, data: null }`
   * ("count unknown") instead, so the dialog can fall back to non-numeric wording rather than being
   * blocked.
   */
  countCommitsExclusiveToHead(targetSha: string, headSha: string): Promise<IpcResult<number | null>>;

  // --- git identity & SSH key profiles (specs/git-identity-profiles.md, FR-329 through FR-337) ---

  /**
   * FR-335: the active repo's current local/global/GitHydra-managed state for `user.name`,
   * `user.email`, and `core.sshCommand`, read fresh from disk on every call — the data dependency
   * the repo-identity status section reads.
   *
   * security-reviewer finding: `knownApplication` (the renderer's own
   * `useIdentityApplications.ts` localStorage record for this repo, or `null` if it has none) is
   * the ONLY trust source for "GitHydra-managed" — never anything read from the repo's own
   * `.git/config`, which this app opens from arbitrary (including untrusted) sources, e.g. a zip.
   * A hand-planted config marker can never substitute for the caller's own record.
   */
  getIdentityConfigState(
    knownApplication: ExpectedIdentityApplication | null,
  ): Promise<IpcResult<IdentityConfigState>>;
  /**
   * FR-330/FR-331/FR-333: apply a profile's fields to the active repo's LOCAL git config only.
   * Throws `InvalidArgumentError` (naming the specific offending character, AC3) when
   * `sshIdentityFilePath` fails FR-333's validation — no git config write is ever made in that
   * case, including when the path is a Windows UNC (network) path. Throws
   * `UnmanagedIdentityConfigConflictError` (also before any write) when applying would overwrite a
   * value `options.knownApplication` doesn't account for and `options.force` isn't `true`
   * (FR-334) — the caller must show the user that error's own already-descriptive `.message`
   * (naming every conflicting key/value) and only re-call with `force: true` after explicit
   * confirmation, never automatically.
   */
  applyIdentityProfile(options: ApplyIdentityProfileOptions): Promise<IpcResult<void>>;
  /**
   * FR-336: unsets exactly the local config keys `knownApplication` accounts for — never a key the
   * user or another tool configured, never global config, and never decided by anything read from
   * the repo's own `.git/config` (see `getIdentityConfigState`'s own doc comment above). A no-op
   * (empty `removedKeys`), not an error, when `knownApplication` is `null` or matches nothing
   * currently set locally.
   */
  removeIdentityProfileApplication(
    knownApplication: ExpectedIdentityApplication | null,
  ): Promise<IpcResult<RemoveIdentityProfileResult>>;
  /** FR-332: the ONLY way an SSH identity-file path ever enters this app — a native OS "open file"
   * dialog, never a free-text field. Resolves `null` if the user cancels. Not repo-scoped: usable
   * while building/editing a profile in the library regardless of whether any repo is open. */
  pickSshIdentityFile(): Promise<IpcResult<string | null>>;
}
