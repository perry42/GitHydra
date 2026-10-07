// SPDX-License-Identifier: GPL-3.0-or-later
import { getRepositoryState, readHistoryBoundarySet } from "./repository";
import { listRefs, indexRefsBySha } from "./refs";
import {
  CommitLogReader,
  PrefetchedCommitPager,
  findCommitsBySha,
  fastForwardCommitPager,
  type CommitPager,
} from "./commitLog";
import {
  getChangedFiles as getChangedFilesImpl,
  getChangedFilesBetween as getChangedFilesBetweenImpl,
} from "./changedFiles";
import {
  getWorkingDirectoryStatus as getWorkingDirectoryStatusImpl,
  getWorkingDirectoryChanges as getWorkingDirectoryChangesImpl,
} from "./workingDirStatus";
import { getUpstreamBranch as getUpstreamBranchImpl } from "./upstream";
import { getFileDiff as getFileDiffImpl, type DiffSource } from "./diff";
import { getImageDiff as getImageDiffImpl } from "./imageDiff";
import {
  stageFile as stageFileImpl,
  unstageFile as unstageFileImpl,
  stageAllFiles as stageAllFilesImpl,
  unstageAllFiles as unstageAllFilesImpl,
  discardTrackedFileChanges as discardTrackedFileChangesImpl,
  discardUntrackedFile as discardUntrackedFileImpl,
} from "./staging";
import {
  planIgnore as planIgnoreImpl,
  ignorePaths as ignorePathsImpl,
  ignoreAndStopTracking as ignoreAndStopTrackingImpl,
  type IgnoreRequest,
  type IgnoreReport,
} from "./ignore";
import { stagePaths as stagePathsImpl, unstagePaths as unstagePathsImpl, type BulkRow, type BulkStageResult } from "./bulkStaging";
import {
  bulkDiscard as bulkDiscardImpl,
  getBulkDiscardFingerprints as getBulkDiscardFingerprintsImpl,
  planDiscardAll as planDiscardAllImpl,
  discardAllChanges as discardAllChangesImpl,
  type BulkDiscardRow,
  type BulkDiscardResult,
  type BulkDiscardCandidate,
  type BulkFingerprintResult,
  type DiscardAllPlan,
} from "./bulkDiscard";
import { getDiscardPreview as getDiscardPreviewImpl, type DiscardPreviewRow } from "./discardPreview";
import { getDiscardFingerprint as getDiscardFingerprintImpl, type DiscardKind, type DiscardOptions } from "./discardGuard";
import {
  stageSelection as stageSelectionImpl,
  unstageSelection as unstageSelectionImpl,
  discardSelection as discardSelectionImpl,
  type PartialStagingOptions,
} from "./partialStaging";
import type { HunkSelection } from "./diffPatch";
import {
  getCombinedFileDiff as getCombinedFileDiffImpl,
  toggleCombinedLines as toggleCombinedLinesImpl,
  discardCombinedLines as discardCombinedLinesImpl,
} from "./combinedStaging";
import {
  probeEditableFile as probeEditableFileImpl,
  readEditableFile as readEditableFileImpl,
  writeEditedFile as writeEditedFileImpl,
  type EditProbeResult,
  type EditReadResult,
  type WriteEditedFileOptions,
  type WriteEditedFileResult,
} from "./editFile";
import { createCommit as createCommitImpl, amendCommit as amendCommitImpl } from "./commitChanges";
import { watchRepositoryRefs, type RepositoryWatcher, type WatchOptions } from "./watcher";
import {
  watchWorktree,
  type WorktreeChange,
  type WorktreeWatcher,
  type WorktreeWatchOptions,
} from "./worktreeWatcher";
import { InvalidArgumentError } from "./errors";
import { getOrphanedHeadCommits as getOrphanedHeadCommitsImpl, type OrphanedHeadResult } from "./orphanGuard";
import {
  listBranches as listBranchesImpl,
  listRemoteBranches as listRemoteBranchesImpl,
  createBranch as createBranchImpl,
  switchBranch as switchBranchImpl,
  switchToCommit as switchToCommitImpl,
  createBranchAtCommit as createBranchAtCommitImpl,
  type GuardedSwitchOptions as GuardedSwitchOptionsType,
  deleteBranch as deleteBranchImpl,
  forceDeleteBranch as forceDeleteBranchImpl,
} from "./branches";
import {
  getConflictedFiles as getConflictedFilesImpl,
  getConflictFileDiff as getConflictFileDiffImpl,
  computeConflictSideLabels,
  scanConflictMarkers as scanConflictMarkersImpl,
  acceptConflictSide as acceptConflictSideImpl,
  markConflictResolved as markConflictResolvedImpl,
  abortInProgressOperation as abortInProgressOperationImpl,
  continueInProgressOperation as continueInProgressOperationImpl,
} from "./conflicts";
import {
  listStashes as listStashesImpl,
  getStashDiff as getStashDiffImpl,
  createStash as createStashImpl,
  applyStash as applyStashImpl,
  popStash as popStashImpl,
  dropStash as dropStashImpl,
} from "./stash";
import {
  cherryPick as cherryPickImpl,
  skipCherryPickCommit as skipCherryPickCommitImpl,
  commitEmptyCherryPick as commitEmptyCherryPickImpl,
} from "./cherryPick";
import { getFileBlame as getFileBlameImpl, getFileHistory as getFileHistoryImpl } from "./blame";
import {
  computeCommitPairRelationship as computeCommitPairRelationshipImpl,
  type CommitPairRelationship,
} from "./commitPairs";
import { mergeCommit as mergeCommitImpl } from "./merge";
import { rebaseCommitOnto as rebaseCommitOntoImpl } from "./rebase";
import {
  resetCurrentBranch as resetCurrentBranchImpl,
  countCommitsExclusiveToHead as countCommitsExclusiveToHeadImpl,
  type ResetMode,
} from "./reset";
import {
  fetchRemote as fetchRemoteImpl,
  fetchAllRemotes as fetchAllRemotesImpl,
  type FetchRemoteOptions,
} from "./fetch";
import {
  pull as pullImpl,
  PULL_STRATEGIES,
  type PullOptions,
  type PullOutcome,
  type PullStrategy,
} from "./pull";
import { push as pushImpl, type PushOptions } from "./push";
import { clone as cloneImpl, type CloneOptions, type CloneResult } from "./clone";
import {
  getIdentityConfigState as getIdentityConfigStateImpl,
  applyIdentityProfile as applyIdentityProfileImpl,
  removeIdentityProfileApplication as removeIdentityProfileApplicationImpl,
  type IdentityConfigState,
  type ApplyIdentityProfileOptions,
  type RemoveIdentityProfileResult,
  type ExpectedIdentityApplication,
} from "./identityProfile";
import type {
  CommitInfo,
  CommitLogFilter,
  RefDecoration,
  RefInfo,
  RepositoryState,
  ChangedFile,
  CreateCommitOptions,
  CreateCommitResult,
  CreateBranchOptions,
  CreateBranchResult,
  LocalBranchInfo,
  RemoteBranchInfo,
  SwitchResult,
  DiffOptions,
  FileDiffResult,
  CombinedFileDiffResult,
  CombinedLineRef,
  ImageDiffResult,
  WorkingDirectoryChanges,
  WorkingDirectoryStatus,
  ConflictedFileInfo,
  ConflictFileDiff,
  ConflictMarkerScanResult,
  ConflictSideLabels,
  StashInfo,
  CreateStashOptions,
  CreateStashResult,
  StashApplyOutcome,
  StashDiffFile,
  StashDiffResult,
  BlameResult,
  ResumeCommitLogFrom,
  FetchAllRemotesResult,
  PushOutcome,
} from "./types";

export * from "./types";
export {
  GitCommandError,
  GitNotFoundError,
  NotAGitRepositoryError,
  UnsupportedGitVersionError,
  InvalidArgumentError,
  NothingStagedError,
  MissingCommitIdentityError,
  CommitHookRejectedError,
  InvalidRefNameError,
  BranchSwitchConflictError,
  BranchNotFullyMergedError,
  BranchCheckedOutError,
  ConflictMarkersRemainError,
  ContinueBlockedError,
  NoOperationInProgressError,
  SymlinkEscapesWorkdirError,
  NothingEligibleToStashError,
  StashOnUnbornHeadError,
  PreExistingConflictError,
  OperationAlreadyInProgressError,
  CherryPickNotAtEmptyResultError,
  GitCommandTimeoutError,
  NoCommitToAmendError,
  AmendBlockedByOperationError,
  OperationCancelledError,
  ReaderResumeMismatchError,
  UnmanagedIdentityConfigConflictError,
  NoUpstreamConfiguredError,
  CloneDestinationIsSymlinkError,
  HeadMovedError,
  BranchCreationFailedError,
  StaleDiffError,
  StaleBatchError,
  STALE_BATCH_PATH_LIMIT,
  TooManyFilesError,
  BULK_DISCARD_ROW_LIMIT,
  IGNORE_ROW_LIMIT,
  BULK_STAGE_ROW_LIMIT,
  IgnoreFileChangedError,
  IgnorePlanChangedError,
  IgnoreWriteError,
  IgnoreUntrackError,
  BulkStagingError,
  DiscardFingerprintError,
  DiscardBackupError,
  EditWriteError,
  EditFileAccessError,
  type EditWriteErrorCode,
  PartialStagingIneligibleError,
  LinesNotDiscardableError,
  type IdentityConfigConflictEntry,
} from "./errors";
export { DEFAULT_GIT_TIMEOUT_MS, warmUpGitResolution } from "./gitProcess";
export {
  CommitLogReader,
  PrefetchedCommitPager,
  findCommitsBySha,
  fastForwardCommitPager,
  type CommitPager,
} from "./commitLog";
export { getRepositoryState } from "./repository";
export { listRefs, indexRefsBySha, headDecoration } from "./refs";
export { getChangedFiles, getChangedFilesBetween } from "./changedFiles";
export {
  getWorkingDirectoryStatus,
  parsePorcelainStatus,
  getWorkingDirectoryChanges,
  parsePorcelainV2Changes,
} from "./workingDirStatus";
export { getUpstreamBranch } from "./upstream";
export { getFileDiff, parseUnifiedDiffHunks, type DiffSource } from "./diff";
export {
  getImageDiff,
  isImageEligiblePath,
  IMAGE_EXTENSION_MIME_TYPES,
  MAX_IMAGE_SIDE_BYTES,
} from "./imageDiff";
export {
  stageFile,
  unstageFile,
  stageAllFiles,
  unstageAllFiles,
  discardTrackedFileChanges,
  discardUntrackedFile,
} from "./staging";
export {
  stageSelection,
  unstageSelection,
  discardSelection,
  type PartialStagingOptions,
} from "./partialStaging";
export {
  planIgnore,
  ignorePaths,
  ignoreAndStopTracking,
  escapeIgnorePattern,
  buildIgnoreRule,
  appendIgnoreRules,
  type IgnoreScope,
  type IgnoreTarget,
  type IgnoreRequest,
  type IgnoreReport,
  type IgnoreRowReport,
  type IgnoreFileReport,
  type IgnoreMatch,
  type IgnoreRefusalCode,
  type StopTrackingReport,
} from "./ignore";
export { stagePaths, unstagePaths, type BulkRow, type BulkRowSection, type BulkSkipped, type BulkStageResult } from "./bulkStaging";
export {
  bulkDiscard,
  getBulkDiscardFingerprints,
  planDiscardAll,
  discardAllChanges,
  type BulkDiscardRow,
  type BulkDiscardSection,
  type BulkDiscardResult,
  type BulkDiscardCandidate,
  type BulkFingerprintResult,
  type DiscardAllPlan,
} from "./bulkDiscard";
export { getDiscardPreview, DISCARD_PREVIEW_ROW_LIMIT, type DiscardPreviewRow } from "./discardPreview";
export {
  getDiscardFingerprint,
  DISCARD_HASH_CAP_BYTES,
  DISCARD_BACKUP_CAP_BYTES,
  type DiscardKind,
  type DiscardOptions,
  type DiscardBackupInfo,
  type DiscardBackupSkipReason,
} from "./discardGuard";
export { fingerprintDiffBytes, type HunkSelection } from "./diffPatch";
export { getCombinedFileDiff, toggleCombinedLines, discardCombinedLines } from "./combinedStaging";
export { createCommit, amendCommit } from "./commitChanges";
export {
  probeEditableFile,
  readEditableFile,
  writeEditedFile,
  MAX_EDITABLE_FILE_BYTES,
  invalidPathReason,
  type EditIneligibleReason,
  type EditIneligible,
  type EditProbeEligible,
  type EditProbeResult,
  type EditableFileContent,
  type EditReadResult,
  type LineEnding,
  type WriteEditedFileOptions,
  type WriteEditedFileResult,
} from "./editFile";
export {
  listBranches,
  listRemoteBranches,
  validateBranchName,
  createBranch,
  switchBranch,
  switchToCommit,
  createBranchAtCommit,
  deleteBranch,
  forceDeleteBranch,
  type GuardedSwitchOptions,
} from "./branches";
export {
  getOrphanedHeadCommits,
  sanitizeSubject,
  ORPHAN_COUNT_CAP,
  ORPHAN_SHOWN_MAX,
  ORPHAN_SUBJECT_MAX_LENGTH,
  ORPHAN_QUERY_TIMEOUT_MS,
  type OrphanedCommit,
  type OrphanedHeadResult,
  type OrphanedHeadStatus,
  type OrphanedHeadReason,
} from "./orphanGuard";
export { watchRepositoryRefs, type RepositoryWatcher, type WatchOptions } from "./watcher";
export {
  watchWorktree,
  computeIgnoredTopLevelDirs,
  type WorktreeChange,
  type WorktreeWatcher,
  type WorktreeWatchOptions,
  type WorktreeWatchDegradedReason,
} from "./worktreeWatcher";
export {
  getConflictedFiles,
  getConflictFileDiff,
  computeConflictSideLabels,
  scanConflictMarkers,
  acceptConflictSide,
  markConflictResolved,
  abortInProgressOperation,
  continueInProgressOperation,
  parseUnmergedRecords,
  classifyStageCombination,
  detectRenameConflicts,
} from "./conflicts";
export {
  listStashes,
  getStashDiff,
  createStash,
  applyStash,
  popStash,
  dropStash,
  parseStashSubject,
} from "./stash";
export { cherryPick, skipCherryPickCommit, commitEmptyCherryPick } from "./cherryPick";
export { getFileBlame, getFileHistory, parsePorcelainBlame } from "./blame";
export { computeCommitPairRelationship, type CommitPairRelationship } from "./commitPairs";
export { mergeCommit } from "./merge";
export { rebaseCommitOnto } from "./rebase";
export { resetCurrentBranch, countCommitsExclusiveToHead, RESET_MODES, type ResetMode } from "./reset";
export { redactGitCredentials } from "./credentialRedaction";
export { classifyGitNetworkError } from "./networkErrorClassification";
export {
  fetchRemote,
  fetchAllRemotes,
  listConfiguredRemotes,
  parseFetchProgressLine,
  runNetworkGitProcess,
  type FetchRemoteOptions,
} from "./fetch";
export {
  PULL_STRATEGIES,
  type PullOptions,
  type PullOutcome,
  type PullStrategy,
} from "./pull";
export { push, type PushOptions } from "./push";
export { clone, type CloneOptions, type CloneResult } from "./clone";
export {
  getIdentityConfigState,
  applyIdentityProfile,
  removeIdentityProfileApplication,
  assertValidSshIdentityFile,
  assertSafeSshIdentityPathSyntax,
  assertSshIdentityFileExists,
  buildSshCommandValue,
  findForbiddenSshPathCharacter,
  SSH_PATH_FORBIDDEN_CHARACTERS,
  type IdentityConfigState,
  type LocalIdentityValue,
  type IdentityProfileFields,
  type ApplyIdentityProfileOptions,
  type RemoveIdentityProfileResult,
  type ExpectedIdentityApplication,
} from "./identityProfile";

const HEX_SHA_RE = /^[0-9a-fA-F]{4,40}$/;

/**
 * Main entry point for consumers (the UI layer): open once, then read everything the commit graph
 * needs (FR-1 through FR-9). All reads are live (no caching); "refresh" is calling again. See
 * watcher.ts for FR-6 caveats.
 */
export class Repository {
  private constructor(
    public readonly path: string,
    private state: RepositoryState,
  ) {}

  /**
   * specs/repo-open-feedback.md FR-163: `options.signal` makes the validity check and initial state
   * reads cancellable (see `getRepositoryState()`, `repository.ts`). A cancelled attempt rejects
   * with `OperationCancelledError` (FR-165), which callers must handle distinctly from a genuine
   * open failure.
   */
  static async open(repoPath: string, options?: { signal?: AbortSignal }): Promise<Repository> {
    const state = await getRepositoryState(repoPath, options?.signal);
    return new Repository(repoPath, state);
  }

  /** Re-read repository state (bare/shallow/empty/HEAD/in-progress-operation flags). Cheap. */
  async refreshState(): Promise<RepositoryState> {
    this.state = await getRepositoryState(this.path);
    return this.state;
  }

  getState(): RepositoryState {
    return this.state;
  }

  /** specs/repo-open-feedback-fixes.md FR-197: `signal`, when supplied (from a still-in-flight
   * cancellable `openRepo` attempt's aux-data phase), makes this call abortable. */
  async getRefs(signal?: AbortSignal): Promise<RefInfo[]> {
    return listRefs(this.path, signal);
  }

  private async buildEnrichmentContext(signal?: AbortSignal): Promise<{
    refsBySha: Map<string, RefDecoration[]>;
    headSha: string | null;
    historyBoundary: Set<string>;
  }> {
    const [refs, historyBoundary] = await Promise.all([
      listRefs(this.path, signal),
      readHistoryBoundarySet(this.state.commonGitDir),
    ]);
    return {
      refsBySha: indexRefsBySha(refs),
      headSha: this.state.headSha,
      historyBoundary,
    };
  }

  /**
   * Create a paged commit history reader (FR-1 through FR-3, FR-7, FR-8): fetches
   * ref/HEAD/shallow-boundary context once, then streams commits from one `git log` process. Caller
   * must `.close()` the reader when done.
   *
   * FR-197 (specs/repo-open-feedback-fixes.md): `signal` is threaded into the context fetch and the
   * returned pager (a `CommitLogReader`'s bound signal covers every `readPage()`).
   *
   * FR-245 (specs/instant-tab-revisit.md): `resumeAfter` fast-forwards the new reader past
   * `resumeAfter.skip` cached commits (see `ResumeCommitLogFrom`, types.ts) so its first
   * `readPage()` returns page two. Rejects with `ReaderResumeMismatchError` (reader closed first,
   * never leaked) if the walk doesn't match `resumeAfter.sha`; callers must fall back to a
   * from-scratch reader, not retry.
   */
  async createCommitLogReader(
    filter?: CommitLogFilter,
    signal?: AbortSignal,
    resumeAfter?: ResumeCommitLogFrom,
  ): Promise<CommitPager> {
    if (filter?.sha) {
      // SHA lookups use findCommitsBySha, not the streaming walk; wrapped in the same paged shape.
      const context = await this.buildEnrichmentContext(signal);
      const commits = await findCommitsBySha(this.path, filter.sha, { ...context, signal });
      return this.resumePagerOrClose(new PrefetchedCommitPager(commits), resumeAfter);
    }
    const context = await this.buildEnrichmentContext(signal);
    return this.resumePagerOrClose(new CommitLogReader(this.path, filter, { ...context, signal }), resumeAfter);
  }

  /**
   * FR-245: applies `resumeAfter` (no-op when omitted) and closes `pager`, never leaking it, if the
   * fast-forward throws.
   */
  private async resumePagerOrClose<T extends CommitPager>(pager: T, resumeAfter?: ResumeCommitLogFrom): Promise<T> {
    if (!resumeAfter) return pager;
    try {
      await fastForwardCommitPager(pager, resumeAfter);
    } catch (err) {
      pager.close();
      throw err;
    }
    return pager;
  }

  /** Look up a single commit by full or abbreviated SHA. Returns null if not found. */
  async getCommit(shaOrPrefix: string): Promise<CommitInfo | null> {
    if (!HEX_SHA_RE.test(shaOrPrefix)) {
      throw new InvalidArgumentError(`Not a valid hex SHA/prefix: ${JSON.stringify(shaOrPrefix)}`);
    }
    const context = await this.buildEnrichmentContext();
    const matches = await findCommitsBySha(this.path, shaOrPrefix, context);
    return matches[0] ?? null;
  }

  /** Changed-file list for a commit (data dependency of FR-13). */
  async getChangedFiles(commit: Pick<CommitInfo, "sha" | "parents">): Promise<ChangedFile[]> {
    return getChangedFilesImpl(this.path, commit.sha, commit.parents);
  }

  /**
   * FR-182/FR-184/FR-185 (specs/compare-commits.md): changed files between two arbitrary commits
   * (no ancestry required); works on bare repos.
   */
  async getChangedFilesBetween(baseSha: string, targetSha: string): Promise<ChangedFile[]> {
    return getChangedFilesBetweenImpl(this.path, baseSha, targetSha);
  }

  /**
   * Working-tree status counts (FR-18), from `git status`. `null` for a bare repository (no working
   * directory), not an error.
   */
  async getWorkingDirectoryStatus(): Promise<WorkingDirectoryStatus | null> {
    if (this.state.isBare || !this.state.workdir) return null;
    return getWorkingDirectoryStatusImpl(this.state.workdir);
  }

  /**
   * Current branch's configured upstream (e.g. "origin/main") for FR-15's default-selection
   * heuristic; `null` when detached, unborn, or no upstream (normal outcomes). FR-197: `signal`,
   * when supplied, makes this call abortable.
   */
  async getUpstreamBranch(signal?: AbortSignal): Promise<string | null> {
    if (this.state.isDetachedHead || !this.state.currentBranch) return null;
    // Works on a bare repo's path too; prefer workdir, else the path opened with.
    return getUpstreamBranchImpl(this.state.workdir ?? this.path, signal);
  }

  /** Best-effort FR-6 auto-refresh signal. See watcher.ts for documented caveats. */
  watchForRefChanges(onChange: () => void, options?: WatchOptions): RepositoryWatcher {
    return watchRepositoryRefs(this.state.gitDir, this.state.commonGitDir, onChange, options);
  }

  /**
   * Work-tree change signal (specs/live-refresh.md, FR-458). Separate from `watchForRefChanges`; `null`
   * for a bare repo. Check `state`/`onDegraded` for the no-watch fallback (focus regain only).
   */
  watchForWorktreeChanges(
    onChange: (change: WorktreeChange) => void,
    options?: WorktreeWatchOptions,
  ): WorktreeWatcher | null {
    if (this.state.isBare || !this.state.workdir) return null;
    return watchWorktree(this.state.workdir, onChange, options);
  }

  /** Throws a clear, typed error for any action that requires a working directory, on a bare repo. */
  private requireWorkdir(action: string): string {
    if (this.state.isBare || !this.state.workdir) {
      throw new InvalidArgumentError(`Cannot ${action} in a bare repository (no working directory).`);
    }
    return this.state.workdir;
  }

  /**
   * Per-file working-directory changes (FR-19); a path can be in both `staged` and `unstaged`.
   * `null` for a bare repository. FR-197: `signal`, when supplied, makes this call abortable.
   */
  async getWorkingDirectoryChanges(signal?: AbortSignal): Promise<WorkingDirectoryChanges | null> {
    if (this.state.isBare || !this.state.workdir) return null;
    return getWorkingDirectoryChangesImpl(this.state.workdir, signal);
  }

  /** FR-20(a)/FR-21/FR-22: unstaged (worktree vs index) diff for a single file. */
  async getUnstagedFileDiff(filePath: string, options?: DiffOptions): Promise<FileDiffResult> {
    const workdir = this.requireWorkdir("view an unstaged file diff");
    return getFileDiffImpl(workdir, { kind: "unstaged", path: filePath }, options);
  }

  /** FR-20(b)/FR-21/FR-22: staged (index vs HEAD) diff for a single file. */
  async getStagedFileDiff(filePath: string, options?: DiffOptions): Promise<FileDiffResult> {
    const workdir = this.requireWorkdir("view a staged file diff");
    return getFileDiffImpl(workdir, { kind: "staged", path: filePath }, options);
  }

  /** FR-20(c)/FR-21/FR-22: untracked file diff, shown as all-addition against empty. */
  async getUntrackedFileDiff(filePath: string, options?: DiffOptions): Promise<FileDiffResult> {
    const workdir = this.requireWorkdir("view an untracked file diff");
    return getFileDiffImpl(workdir, { kind: "untracked", path: filePath }, options);
  }

  /**
   * FR-20(d)/FR-21/FR-22: a historical commit's file diff. Pass the matching `ChangedFile` (for
   * `oldPath`) so a rename isn't shown as a pure add. Works on bare repos.
   */
  async getCommitFileDiff(
    commit: Pick<CommitInfo, "sha" | "parents">,
    file: Pick<ChangedFile, "path" | "oldPath">,
    options?: DiffOptions,
  ): Promise<FileDiffResult> {
    const source: DiffSource = {
      kind: "commit",
      sha: commit.sha,
      parents: commit.parents,
      path: file.path,
      oldPath: file.oldPath,
    };
    return getFileDiffImpl(this.path, source, options);
  }

  /**
   * FR-181: file diff between two arbitrary commits, same pipeline as `getCommitFileDiff()`. Pass
   * the matching `ChangedFile` for renames. Works on bare repos (FR-185).
   */
  async getCommitRangeFileDiff(
    baseSha: string,
    targetSha: string,
    file: Pick<ChangedFile, "path" | "oldPath">,
    options?: DiffOptions,
  ): Promise<FileDiffResult> {
    const source: DiffSource = {
      kind: "commit-range",
      baseSha,
      targetSha,
      path: file.path,
      oldPath: file.oldPath,
    };
    return getFileDiffImpl(this.path, source, options);
  }

  /** FR-140/FR-142: unstaged image-diff content, mirroring `getUnstagedFileDiff()`. */
  async getUnstagedImageDiff(filePath: string): Promise<ImageDiffResult> {
    const workdir = this.requireWorkdir("view an unstaged image diff");
    return getImageDiffImpl(workdir, { kind: "unstaged", path: filePath });
  }

  /** FR-140/FR-142: staged image-diff content, mirroring `getStagedFileDiff()`. */
  async getStagedImageDiff(filePath: string): Promise<ImageDiffResult> {
    const workdir = this.requireWorkdir("view a staged image diff");
    return getImageDiffImpl(workdir, { kind: "staged", path: filePath });
  }

  /**
   * FR-140/FR-142: untracked image-eligible file shown as "Added" with no old side, mirroring
   * `getUntrackedFileDiff()`.
   */
  async getUntrackedImageDiff(filePath: string): Promise<ImageDiffResult> {
    const workdir = this.requireWorkdir("view an untracked image diff");
    return getImageDiffImpl(workdir, { kind: "untracked", path: filePath });
  }

  /**
   * FR-140/FR-142: a historical commit's image diff, mirroring `getCommitFileDiff()` (incl.
   * `file.oldPath`). Works on bare repos.
   */
  async getCommitImageDiff(
    commit: Pick<CommitInfo, "sha" | "parents">,
    file: Pick<ChangedFile, "path" | "oldPath">,
  ): Promise<ImageDiffResult> {
    const source: DiffSource = {
      kind: "commit",
      sha: commit.sha,
      parents: commit.parents,
      path: file.path,
      oldPath: file.oldPath,
    };
    return getImageDiffImpl(this.path, source);
  }

  /** FR-23: stage a single file (`git add --`). */
  async stageFile(filePath: string): Promise<void> {
    const workdir = this.requireWorkdir("stage a file");
    return stageFileImpl(workdir, filePath);
  }

  /** FR-23: unstage a single file (`git restore --staged --`); the working-tree file is untouched. */
  async unstageFile(filePath: string): Promise<void> {
    const workdir = this.requireWorkdir("unstage a file");
    return unstageFileImpl(workdir, filePath);
  }

  /** FR-23: stage every eligible (non-conflicted) unstaged/untracked file in one action. */
  async stageAllFiles(): Promise<void> {
    const workdir = this.requireWorkdir("stage all files");
    return stageAllFilesImpl(workdir);
  }

  /** FR-23: unstage every currently-staged (non-conflicted) file in one action. */
  async unstageAllFiles(): Promise<void> {
    const workdir = this.requireWorkdir("unstage all files");
    return unstageAllFilesImpl(workdir);
  }

  /**
   * FR-24: discard a tracked file's working-tree changes. Destructive and unrecoverable;
   * deliberately separate from `unstageFile`.
   */
  async discardTrackedFileChanges(filePath: string, options: DiscardOptions): Promise<void> {
    const workdir = this.requireWorkdir("discard file changes");
    return discardTrackedFileChangesImpl(workdir, filePath, options);
  }

  /** specs/ignore-and-multiselect.md FR-494..FR-500: preview (counts, rules, refusals) without writing. */
  async planIgnore(req: IgnoreRequest): Promise<IgnoreReport> {
    return planIgnoreImpl(this.requireWorkdir("ignore files"), req);
  }

  /** FR-494..FR-502: write ignore rules (one read-modify-write per target file); `req.stopTracking` also untracks (FR-500). */
  async ignorePaths(req: IgnoreRequest): Promise<IgnoreReport> {
    return ignorePathsImpl(this.requireWorkdir("ignore files"), req);
  }

  /** FR-500: `ignorePaths` with stop-tracking forced on. */
  async ignoreAndStopTracking(req: Omit<IgnoreRequest, "stopTracking">): Promise<IgnoreReport> {
    return ignoreAndStopTrackingImpl(this.requireWorkdir("ignore files"), req);
  }

  /** FR-507: bulk stage in one queued operation. */
  async stagePaths(rows: readonly BulkRow[]): Promise<BulkStageResult> {
    return stagePathsImpl(this.requireWorkdir("stage files"), rows);
  }

  /** FR-507: bulk unstage in one queued operation. */
  async unstagePaths(rows: readonly BulkRow[]): Promise<BulkStageResult> {
    return unstagePathsImpl(this.requireWorkdir("unstage files"), rows);
  }

  /** FR-508: fingerprints for a bulk discard confirmation. Read-only. */
  async getBulkDiscardFingerprints(rows: readonly BulkDiscardCandidate[]): Promise<BulkFingerprintResult[]> {
    return getBulkDiscardFingerprintsImpl(this.requireWorkdir("fingerprint files before discarding"), rows);
  }

  /** FR-521: +/- line counts for a discard confirmation (at most `DISCARD_PREVIEW_ROW_LIMIT` paths). Read-only. */
  async getDiscardPreview(paths: readonly string[]): Promise<DiscardPreviewRow[]> {
    return getDiscardPreviewImpl(this.requireWorkdir("preview a discard"), paths);
  }

  /** FR-508: guarded bulk discard; every row needs its fingerprint, a mismatch refuses the whole batch (`StaleBatchError`). */
  async bulkDiscard(rows: readonly BulkDiscardRow[]): Promise<BulkDiscardResult> {
    return bulkDiscardImpl(this.requireWorkdir("discard files"), rows);
  }

  /** FR-509: snapshot (rows + fingerprints + counts) for "Discard all changes". Read-only. */
  async planDiscardAll(): Promise<DiscardAllPlan> {
    return planDiscardAllImpl(this.requireWorkdir("discard all changes"));
  }

  /** FR-509: run the confirmed snapshot through the guarded flow; untracked rows only with `includeUntracked`. */
  async discardAllChanges(options: { rows: readonly BulkDiscardRow[]; includeUntracked: boolean }): Promise<BulkDiscardResult> {
    return discardAllChangesImpl(this.requireWorkdir("discard all changes"), options);
  }

  /** Fingerprint to pass as `expectedFingerprint` to a whole-file discard; see `getDiscardFingerprint`. Read-only. */
  async getDiscardFingerprint(filePath: string, kind: DiscardKind): Promise<string> {
    const workdir = this.requireWorkdir("fingerprint a file before discarding it");
    return getDiscardFingerprintImpl(workdir, filePath, kind);
  }

  /**
   * specs/hunk-line-staging.md FR-448: stage selected hunks/lines of a modified tracked text file. `fingerprint`
   * is the `fingerprint` of the unstaged diff the caller displayed (FR-449); throws `StaleDiffError` on
   * mismatch and `PartialStagingIneligibleError` for files FR-452 excludes.
   */
  async stageSelection(
    filePath: string,
    fingerprint: string,
    selection: readonly HunkSelection[],
    options?: PartialStagingOptions,
  ): Promise<void> {
    const workdir = this.requireWorkdir("stage part of a file");
    return stageSelectionImpl(workdir, filePath, fingerprint, selection, options);
  }

  /** FR-448: unstage selected hunks/lines; `fingerprint` comes from the staged diff. Index only. */
  async unstageSelection(
    filePath: string,
    fingerprint: string,
    selection: readonly HunkSelection[],
    options?: PartialStagingOptions,
  ): Promise<void> {
    const workdir = this.requireWorkdir("unstage part of a file");
    return unstageSelectionImpl(workdir, filePath, fingerprint, selection, options);
  }

  /** FR-448: discard selected hunks/lines from the working tree only; `fingerprint` comes from the unstaged diff. Destructive. */
  async discardSelection(
    filePath: string,
    fingerprint: string,
    selection: readonly HunkSelection[],
    options?: PartialStagingOptions,
  ): Promise<void> {
    const workdir = this.requireWorkdir("discard part of a file");
    return discardSelectionImpl(workdir, filePath, fingerprint, selection, options);
  }

  /**
   * specs/hunk-line-staging.md FR-479: HEAD-vs-worktree diff with per-line `staged`/`discardable`, or
   * `{ mode: "separate", reason }` (FR-481) when the file is ineligible or the mapping is ambiguous.
   */
  async getCombinedFileDiff(filePath: string, options?: PartialStagingOptions): Promise<CombinedFileDiffResult> {
    const workdir = this.requireWorkdir("view a combined file diff");
    return getCombinedFileDiffImpl(workdir, filePath, options);
  }

  /**
   * FR-480: stage or unstage combined-diff lines (a hunk = all its changed lines) as one atomic apply.
   * `fingerprint` is the combined diff's; throws `StaleDiffError` on mismatch and
   * `PartialStagingIneligibleError` when the file is (now) ineligible or ambiguous.
   */
  async toggleCombinedLines(
    filePath: string,
    fingerprint: string,
    lines: readonly CombinedLineRef[],
    target: "stage" | "unstage",
    options?: PartialStagingOptions,
  ): Promise<void> {
    const workdir = this.requireWorkdir("stage part of a file");
    return toggleCombinedLinesImpl(workdir, filePath, fingerprint, lines, target, options);
  }

  /** FR-478: discard unstaged combined-diff lines from the worktree only; throws `LinesNotDiscardableError` for staged/re-edited lines. */
  async discardCombinedLines(
    filePath: string,
    fingerprint: string,
    lines: readonly CombinedLineRef[],
    options?: PartialStagingOptions,
  ): Promise<void> {
    const workdir = this.requireWorkdir("discard part of a file");
    return discardCombinedLinesImpl(workdir, filePath, fingerprint, lines, options);
  }

  /** specs/edit-in-diff.md FR-468: can this working file be edited here? Read-only; ineligible is a result, not an error. */
  async probeEditableFile(filePath: string): Promise<EditProbeResult> {
    return probeEditableFileImpl(this.requireWorkdir("edit a file"), filePath);
  }

  /** FR-468/FR-469: exact working-copy text plus eol/BOM/final-newline state and the sha256 `contentHash` the save guard needs. */
  async readEditableFile(filePath: string): Promise<EditReadResult> {
    return readEditableFileImpl(this.requireWorkdir("edit a file"), filePath);
  }

  /** FR-471/FR-474/FR-528: atomic, hash-guarded save of the working copy only; never touches the index. See `writeEditedFile`. */
  async writeEditedFile(filePath: string, content: string, options: WriteEditedFileOptions): Promise<WriteEditedFileResult> {
    return writeEditedFileImpl(this.requireWorkdir("edit a file"), filePath, content, options);
  }

  /** FR-24: delete one untracked file. Destructive and unrecoverable; never a whole-tree `git clean -fd`. */
  async discardUntrackedFile(filePath: string, options: DiscardOptions): Promise<void> {
    const workdir = this.requireWorkdir("discard an untracked file");
    return discardUntrackedFileImpl(workdir, filePath, options);
  }

  /**
   * FR-25: create a commit from staged content; typed errors are listed on `createCommit`
   * (`commitChanges.ts`).
   */
  async createCommit(options: CreateCommitOptions): Promise<CreateCommitResult> {
    const workdir = this.requireWorkdir("create a commit");
    return createCommitImpl(workdir, options);
  }

  /** FR-148: amend HEAD; typed errors are listed on `amendCommit` (`commitChanges.ts`). */
  async amendCommit(options: CreateCommitOptions): Promise<CreateCommitResult> {
    const workdir = this.requireWorkdir("amend a commit");
    return amendCommitImpl(workdir, options);
  }

  /** FR-33: local branches with tip metadata, flags, upstream and ahead/behind. Works on bare repos. */
  async listBranches(): Promise<LocalBranchInfo[]> {
    return listBranchesImpl(this.path);
  }

  /** FR-34: remote-tracking branches, for use as create/checkout start points. */
  async listRemoteBranches(): Promise<RemoteBranchInfo[]> {
    return listRemoteBranchesImpl(this.path);
  }

  /**
   * FR-35/36/37: create a local branch, optionally switching (FR-36, needs a workdir) or tracking a
   * remote start point (FR-37). Typed errors: see `createBranch` (`branches.ts`).
   */
  async createBranch(options: CreateBranchOptions): Promise<CreateBranchResult> {
    const cwd = options.switchToIt ? this.requireWorkdir("switch to a new branch") : this.path;
    return createBranchImpl(cwd, options);
  }

  /**
   * FR-38: `git switch` to a local branch. Throws `BranchSwitchConflictError` if uncommitted
   * changes would be overwritten; never auto-stashes or forces.
   */
  async switchBranch(branchName: string, options?: GuardedSwitchOptionsType): Promise<SwitchResult> {
    const workdir = this.requireWorkdir("switch branches");
    return switchBranchImpl(workdir, branchName, options);
  }

  /** FR-39: detached-HEAD checkout of an arbitrary commit-ish. */
  async switchToCommit(commitish: string, options?: GuardedSwitchOptionsType): Promise<SwitchResult> {
    const workdir = this.requireWorkdir("check out a commit");
    return switchToCommitImpl(workdir, commitish, options);
  }

  /**
   * FR-430: what commits would be left behind if the current detached HEAD were left now? Read-only,
   * never throws for git failures - see `getOrphanedHeadCommits` (`orphanGuard.ts`); a
   * `status: "unknown"` result must be treated as "ask the user".
   */
  async getOrphanedHeadCommits(): Promise<OrphanedHeadResult> {
    return getOrphanedHeadCommitsImpl(this.path);
  }

  /** FR-430: create local branch `name` at full commit id `sha` without switching (see `createBranchAtCommit`). */
  async createBranchAtCommit(name: string, sha: string): Promise<CreateBranchResult> {
    return createBranchAtCommitImpl(this.path, name, sha);
  }

  /**
   * FR-40: `git branch -d`; throws typed `BranchNotFullyMergedError`/`BranchCheckedOutError`
   * (FR-42). Works on bare repos.
   */
  async deleteBranch(branchName: string): Promise<void> {
    return deleteBranchImpl(this.path, branchName);
  }

  /**
   * FR-41: `git branch -D`, discarding unmerged commits; deliberately a separate method from
   * `deleteBranch`.
   */
  async forceDeleteBranch(branchName: string): Promise<void> {
    return forceDeleteBranchImpl(this.path, branchName);
  }

  // --- merge/rebase conflict resolution (specs/merge-rebase-conflict-resolution.md, FR-58 through FR-80) ---

  /**
   * FR-62/FR-63: every conflicted path's classification and stage content, read fresh from the
   * index (FR-74). `null` for a bare repository.
   */
  async getConflictedFiles(): Promise<ConflictedFileInfo[] | null> {
    if (this.state.isBare || !this.state.workdir) return null;
    return getConflictedFilesImpl(this.path, this.state.workdir, this.state);
  }

  /**
   * FR-64/FR-77/FR-78/FR-80: base->ours, base->theirs and ours->theirs comparison for one
   * classified conflicted file. All fields are null for a submodule conflict (FR-77).
   */
  async getConflictFileDiff(
    file: Pick<ConflictedFileInfo, "base" | "ours" | "theirs" | "isSubmodule">,
    options?: DiffOptions,
  ): Promise<ConflictFileDiff> {
    return getConflictFileDiffImpl(this.path, file, options);
  }

  /**
   * FR-61: concrete labels for the current operation (inverted for rebase; see
   * `computeConflictSideLabels`), computed once for all files. `null` when nothing is in progress,
   * or for "am"/"bisect".
   */
  getConflictSideLabels(): ConflictSideLabels | null {
    return computeConflictSideLabels(this.state);
  }

  /** FR-66: scan a working-tree file for literal, unresolved conflict marker lines — the check every "resolve" action below runs before staging anything. */
  async scanConflictMarkers(filePath: string): Promise<ConflictMarkerScanResult> {
    const workdir = this.requireWorkdir("scan a file for conflict markers");
    return scanConflictMarkersImpl(workdir, filePath);
  }

  /**
   * FR-65/FR-66/FR-78: whole-file Accept Ours/Theirs. `side` is git's literal stage 2/3; pair it
   * with `getConflictSideLabels()` for display, never bare "ours"/"theirs". Throws
   * `ConflictMarkersRemainError` (FR-66) if marker text remains after checkout (shared safety path
   * with `markConflictResolved`). When the chosen side has no content (e.g. ours on deleted-by-us),
   * stages the deletion (FR-78).
   */
  async acceptConflictSide(filePath: string, side: "ours" | "theirs"): Promise<void> {
    const workdir = this.requireWorkdir("accept a conflict side");
    return acceptConflictSideImpl(workdir, filePath, side);
  }

  /**
   * FR-65/FR-66: "Mark as resolved" for a hand-edited file. Throws `ConflictMarkersRemainError` (no
   * `git add`) if marker lines remain, which git itself doesn't check. Stages a deletion if the
   * user deleted the file.
   */
  async markConflictResolved(filePath: string): Promise<void> {
    const workdir = this.requireWorkdir("mark a conflict as resolved");
    return markConflictResolvedImpl(workdir, filePath);
  }

  /**
   * FR-68/FR-69: `--abort` for the current merge/rebase/cherry-pick/revert, restoring pre-operation
   * state; `rebase --quit` is never exposed (FR-69). Throws `NoOperationInProgressError` if nothing
   * is in progress or for "bisect". Other failures surface as `GitCommandError` with git's stderr,
   * never swallowed or retried.
   */
  async abortInProgressOperation(): Promise<void> {
    this.requireWorkdir("abort the in-progress operation");
    return abortInProgressOperationImpl(this.path, this.state.inProgressOperation);
  }

  /**
   * FR-70/FR-71: `--continue` without ever spawning an editor (`GIT_EDITOR=true`; no TTY).
   * Client-side blocked (`ContinueBlockedError` naming every blocking path, no git call) unless
   * `conflicted` is empty AND FR-66's marker scan finds nothing in staged paths (beyond git's own
   * refusal, which only checks the first). Throws `NoOperationInProgressError` if nothing is in
   * progress or for "bisect".
   */
  async continueInProgressOperation(): Promise<void> {
    const workdir = this.requireWorkdir("continue the in-progress operation");
    return continueInProgressOperationImpl(this.path, workdir, this.state.inProgressOperation);
  }

  // --- stash (specs/stash.md, FR-81 through FR-90) ---

  /**
   * FR-81/FR-82: `git stash list`, read fresh. `null` for a bare repository (no stash can exist);
   * visible identically from every linked worktree (FR-82; see stash.ts's module doc). FR-197:
   * `signal`, when supplied, makes this call abortable.
   */
  async listStashes(signal?: AbortSignal): Promise<StashInfo[] | null> {
    if (this.state.isBare || !this.state.workdir) return null;
    return listStashesImpl(this.path, signal);
  }

  /**
   * FR-83: every file one stash would change (incl. untracked captures) with diff content.
   * Read-only. `null` for a bare repository.
   */
  async getStashDiff(index: number, options?: DiffOptions): Promise<StashDiffResult | null> {
    if (this.state.isBare || !this.state.workdir) return null;
    return getStashDiffImpl(this.path, index, options);
  }

  /**
   * FR-84: `git stash push`. Throws `StashOnUnbornHeadError` on a zero-commit repo,
   * `NothingEligibleToStashError` when nothing is eligible; see `createStash` (`stash.ts`) for the
   * rules.
   */
  async createStash(options?: CreateStashOptions): Promise<CreateStashResult> {
    const workdir = this.requireWorkdir("create a stash");
    return createStashImpl(workdir, options);
  }

  /**
   * FR-85/FR-86: `git stash apply stash@{N}`; the entry stays in the list on success or conflict. A
   * conflict populates `getWorkingDirectoryChanges().conflicted` (resolve via
   * `acceptConflictSide()`/`markConflictResolved()`) and never sets an in-progress operation (see
   * stash.ts's module doc). Throws `PreExistingConflictError` (no git call) if an unrelated
   * conflict/operation already exists.
   */
  async applyStash(index: number): Promise<StashApplyOutcome> {
    const workdir = this.requireWorkdir("apply a stash");
    return applyStashImpl(workdir, index);
  }

  /**
   * FR-85/FR-87: `git stash pop stash@{N}`; removes the entry only on a clean apply (git's
   * behavior). On conflict it behaves like `applyStash()`; there is no `pop --abort`. Throws
   * `PreExistingConflictError` (no git call) if an unrelated conflict/operation already exists.
   */
  async popStash(index: number): Promise<StashApplyOutcome> {
    const workdir = this.requireWorkdir("pop a stash");
    return popStashImpl(workdir, index);
  }

  /**
   * FR-88: `git stash drop`; a separate explicit destructive method, never reachable via apply/pop.
   * Ref-only; works on bare repos.
   */
  async dropStash(index: number): Promise<void> {
    return dropStashImpl(this.path, index);
  }

  // --- cherry-pick (specs/cherry-pick.md, FR-103 through FR-110) ---

  /**
   * FR-103: `git cherry-pick <sha1> ... <shaN>` as one native call in the given order (ordering is
   * the caller's contract, FR-114; see `cherryPick.ts`). Throws `InvalidArgumentError` for empty
   * `shas`, or `OperationAlreadyInProgressError` (no git call) if any operation is in progress.
   * Returns when git exits 0; a paused outcome (conflict or FR-105 empty result) is discovered
   * afterward via `refreshState()`/`getWorkingDirectoryChanges()` (FR-104).
   */
  async cherryPick(shas: readonly string[]): Promise<void> {
    const workdir = this.requireWorkdir("cherry-pick");
    return cherryPickImpl(workdir, shas);
  }

  /**
   * FR-106: `git cherry-pick --skip` for the FR-105 empty-result pause. Throws
   * `CherryPickNotAtEmptyResultError` (no git call) unless genuinely paused on an empty result,
   * re-verified from disk.
   */
  async skipCherryPickCommit(): Promise<void> {
    const workdir = this.requireWorkdir("skip a cherry-pick commit");
    return skipCherryPickCommitImpl(workdir);
  }

  /**
   * FR-106: `git commit --allow-empty` for the FR-105 empty-result pause, reusing the paused
   * commit's message via stdin (never an editor). Throws `CherryPickNotAtEmptyResultError` (no git
   * call) unless paused on an empty result.
   */
  async commitEmptyCherryPick(): Promise<void> {
    const workdir = this.requireWorkdir("commit an empty cherry-pick result");
    return commitEmptyCherryPickImpl(workdir);
  }

  // --- drag-commit contextual menu (specs/drag-commit-menu.md, FR-295 through FR-300) ---

  /**
   * FR-295/296: classify the ancestry relationship between two distinct commits in one round trip
   * (three parallel reads). Throws `InvalidArgumentError` for a malformed SHA or `shaA === shaB`.
   * Pure read; works on bare repos.
   */
  async computeCommitPairRelationship(shaA: string, shaB: string): Promise<CommitPairRelationship> {
    return computeCommitPairRelationshipImpl(this.path, shaA, shaB);
  }

  /**
   * FR-297: `git merge <otherSha>` into current HEAD. Throws `OperationAlreadyInProgressError` (no
   * git call) if any operation is in progress. FR-299: no target-branch parameter; getting HEAD
   * onto the intended commit first (FR-309) is the caller's job. A fast-forward, a merge commit,
   * and a paused conflict look identical in the return value; re-read
   * `getState()`/`inProgressOperationDetail`.
   */
  async mergeCommit(otherSha: string): Promise<void> {
    const workdir = this.requireWorkdir("merge");
    return mergeCommitImpl(workdir, otherSha);
  }

  /**
   * FR-298: plain non-interactive `git rebase <newBaseSha>` of current HEAD (no `--onto`). Throws
   * `OperationAlreadyInProgressError` (no git call) if any operation is in progress. FR-299: no
   * target-branch parameter. Outcomes are indistinguishable in the return value; re-read
   * `getState()`/`inProgressOperationDetail`.
   */
  async rebaseCommitOnto(newBaseSha: string): Promise<void> {
    const workdir = this.requireWorkdir("rebase");
    return rebaseCommitOntoImpl(workdir, newBaseSha);
  }

  // --- reset current branch/HEAD to here (specs/reset-to-here.md, FR-359 through FR-365) ---

  /**
   * FR-359: move current `HEAD` to `targetSha` via one of `git reset --soft/--mixed/--hard` (`mode`
   * always an explicit flag); no target-branch parameter.
   *
   * Throws `InvalidArgumentError` for a malformed `targetSha` (FR-361) and
   * `OperationAlreadyInProgressError` (no git call) if an operation is in progress (FR-360). Uses
   * `this.path`, not `requireWorkdir()`: bare-repo gating is the UI layer's job (FR-366), so
   * `mixed`/`hard` on a bare repo fails as a plain `GitCommandError` from git.
   */
  async resetCurrentBranch(targetSha: string, mode: ResetMode): Promise<void> {
    return resetCurrentBranchImpl(this.path, targetSha, mode);
  }

  /**
   * FR-364: `git rev-list --count <targetSha>..<headSha>`, previewing a reset's impact. Never
   * throws for ordinary failures (bad SHA, shallow boundary); returns `null` ("unknown", FR-368)
   * instead. Works on bare repos.
   */
  async countCommitsExclusiveToHead(targetSha: string, headSha: string): Promise<number | null> {
    return countCommitsExclusiveToHeadImpl(this.path, targetSha, headSha);
  }

  // --- blame & file history (specs/blame.md, FR-123 through FR-130) ---

  /**
   * FR-123/124/125/126/127/128: blame `filePath` for the working tree (`revision: null`, includes
   * uncommitted edits, FR-126, needs a workdir) or a historical commit. Guards binary/oversized
   * content before running a full `git blame` (FR-125). Works on bare repos for a historical
   * revision.
   */
  async getFileBlame(filePath: string, revision: string | null): Promise<BlameResult> {
    const cwd = revision === null ? this.requireWorkdir("blame a working-tree file") : this.path;
    return getFileBlameImpl(cwd, filePath, revision);
  }

  /**
   * FR-129: paged reader over `filePath`'s history from `revision` (`--follow`). Same contract as
   * `createCommitLogReader()`; caller must `.close()`. Works on bare repos.
   */
  async getFileHistory(revision: string, filePath: string): Promise<CommitPager> {
    return getFileHistoryImpl(this.path, revision, filePath);
  }

  // --- fetch (specs/online-sync-fetch.md, FR-320 through FR-322) ---

  /**
   * FR-320: `git fetch <remoteName>` for one remote, the only network call this package makes
   * (FR-328; see `fetch.ts`). Works on bare repos. Typed errors (incl. `OperationCancelledError`,
   * FR-322, and `InvalidArgumentError` for an empty name): see `fetchRemote` (`fetch.ts`).
   */
  async fetchRemote(remoteName: string, options?: FetchRemoteOptions): Promise<void> {
    return fetchRemoteImpl(this.state.workdir ?? this.path, remoteName, options);
  }

  /**
   * FR-321: fetch every listed remote sequentially; failures stay attributable per remote and zero
   * remotes yields an empty result, not an error (see `fetchAllRemotes`, `fetch.ts`).
   */
  async fetchAllRemotes(options?: FetchRemoteOptions): Promise<FetchAllRemotesResult> {
    return fetchAllRemotesImpl(this.state.workdir ?? this.path, options);
  }

  // --- pull (specs/online-sync-pull.md, FR-338 through FR-343) ---

  /**
   * FR-338: fetch the current branch's upstream, then integrate: fast-forward when possible
   * (FR-340), else `mergeCommit()`/`rebaseCommitOnto()` per strategy (FR-339); never a literal `git
   * pull`. A paused conflict rejects like those primitives do (re-read
   * `getState()`/`inProgressOperationDetail`); see `pull()` (`pull.ts`) for the full contract.
   *
   * Requires a working directory (bare-repo `InvalidArgumentError`, FR-343). FR-341's
   * current-branch-only rule and the no-upstream / operation-in-progress cases are enforced in
   * `pull()` via `NoUpstreamConfiguredError`/`OperationAlreadyInProgressError`. Unborn `HEAD` is
   * deliberately not rejected here: a fetched commit fast-forwards onto an unborn branch (verified
   * against real git); FR-343's unborn gating is a UI-layer call, as with `resetCurrentBranch()`.
   */
  async pull(options?: PullOptions): Promise<PullOutcome> {
    const workdir = this.requireWorkdir("pull");
    return pullImpl(workdir, options);
  }

  // --- push (specs/online-sync-push.md, FR-344 through FR-350) ---

  /**
   * FR-344/FR-345: push `localBranchName` to `remoteName` via an explicit `<local>:<upstream>`
   * refspec for a tracked branch, or `--set-upstream` when none exists for this remote. A
   * non-fast-forward rejection (FR-346) surfaces as a plain `GitCommandError`; classify its
   * redacted `stderr` with `classifyGitNetworkError()` (FR-348). See `push()` (`push.ts`).
   *
   * Uses `this.path`, not `requireWorkdir()`: push needs no working directory and works on bare
   * repos. FR-349's bare/detached/unborn/in-progress gating is the UI layer's job, as with
   * `pull()`.
   */
  async push(remoteName: string, localBranchName: string, options?: PushOptions): Promise<PushOutcome> {
    return pushImpl(this.path, remoteName, localBranchName, options);
  }

  // --- git identity & SSH key profiles (specs/git-identity-profiles.md, FR-329 through FR-337) ---

  /**
   * FR-335: this repo's local/global/GitHydra-managed state for
   * `user.name`/`user.email`/`core.sshCommand`. Pure read; works on bare, empty and detached repos.
   *
   * Security: `managedByGitHydra` compares the LIVE config against the caller's own app-storage
   * record `knownApplication` (or `null`), never anything inside the repo's `.git/config`, which
   * comes from arbitrary sources and is forgeable. See `getIdentityConfigState`
   * (`identityProfile.ts`).
   */
  async getIdentityConfigState(
    knownApplication: ExpectedIdentityApplication | null,
  ): Promise<IdentityConfigState> {
    return getIdentityConfigStateImpl(this.path, knownApplication);
  }

  /**
   * FR-330/FR-331: write `user.name`/`user.email` (and `core.sshCommand` if
   * `options.sshIdentityFilePath` is given) to THIS repo's local config only. Throws
   * `InvalidArgumentError` for an empty name/email or invalid SSH identity file (FR-332/333, incl.
   * UNC paths), and `UnmanagedIdentityConfigConflictError` (FR-334) unless `options.force` when it
   * would overwrite a local value `options.knownApplication` doesn't account for. All checks run
   * before any config read/write; see `applyIdentityProfile` (`identityProfile.ts`) for write
   * ordering and the managed-`core.sshCommand` exception.
   */
  async applyIdentityProfile(options: ApplyIdentityProfileOptions): Promise<void> {
    return applyIdentityProfileImpl(this.path, options);
  }

  /**
   * FR-336: unset exactly the local keys `knownApplication` (caller's app-storage record, or
   * `null`) accounts for; never user/tool-set values, global config, or anything decided by the
   * repo's `.git/config`. `null` or non-matching is a no-op (empty `removedKeys`), not an error.
   */
  async removeIdentityProfileApplication(
    knownApplication: ExpectedIdentityApplication | null,
  ): Promise<RemoveIdentityProfileResult> {
    return removeIdentityProfileApplicationImpl(this.path, knownApplication);
  }
}
