// SPDX-License-Identifier: GPL-3.0-or-later
import { getRepositoryState, readHistoryBoundarySet } from "./repository";
import { listRefs, indexRefsBySha } from "./refs";
import { CommitLogReader, PrefetchedCommitPager, findCommitsBySha, type CommitPager } from "./commitLog";
import { getChangedFiles as getChangedFilesImpl } from "./changedFiles";
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
import { createCommit as createCommitImpl, amendCommit as amendCommitImpl } from "./commitChanges";
import { watchRepositoryRefs, type RepositoryWatcher, type WatchOptions } from "./watcher";
import { InvalidArgumentError } from "./errors";
import {
  listBranches as listBranchesImpl,
  listRemoteBranches as listRemoteBranchesImpl,
  createBranch as createBranchImpl,
  switchBranch as switchBranchImpl,
  switchToCommit as switchToCommitImpl,
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
} from "./errors";
export { DEFAULT_GIT_TIMEOUT_MS, warmUpGitResolution } from "./gitProcess";
export { CommitLogReader, PrefetchedCommitPager, findCommitsBySha, type CommitPager } from "./commitLog";
export { getRepositoryState } from "./repository";
export { listRefs, indexRefsBySha, headDecoration } from "./refs";
export { getChangedFiles } from "./changedFiles";
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
export { createCommit, amendCommit } from "./commitChanges";
export {
  listBranches,
  listRemoteBranches,
  validateBranchName,
  createBranch,
  switchBranch,
  switchToCommit,
  deleteBranch,
  forceDeleteBranch,
} from "./branches";
export { watchRepositoryRefs, type RepositoryWatcher, type WatchOptions } from "./watcher";
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

const HEX_SHA_RE = /^[0-9a-fA-F]{4,40}$/;

/**
 * Main entry point for consumers (the UI layer): open a repository once and get back an
 * object with everything needed to render the commit graph (FR-1 through FR-9), without
 * having to re-derive ref maps / history-boundary sets / repo state on every call.
 *
 * All reads are live (no caching), so "refresh" is simply calling these methods again —
 * see watcher.ts for the FR-6 change-detection caveats.
 */
export class Repository {
  private constructor(
    public readonly path: string,
    private state: RepositoryState,
  ) {}

  /**
   * specs/repo-open-feedback.md FR-163: `options.signal` — when supplied — makes the underlying
   * repo-validity check and initial state reads cancellable (see `getRepositoryState()`'s own doc
   * comment, `repository.ts`, for exactly which reads that covers). A cancelled attempt rejects
   * with `OperationCancelledError` (FR-165) rather than `NotAGitRepositoryError`/
   * `UnsupportedGitVersionError`/`GitCommandError` — callers (the desktop IPC layer) must branch on
   * that distinctly rather than treating it as a genuine open failure.
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

  async getRefs(): Promise<RefInfo[]> {
    return listRefs(this.path);
  }

  private async buildEnrichmentContext(): Promise<{
    refsBySha: Map<string, RefDecoration[]>;
    headSha: string | null;
    historyBoundary: Set<string>;
  }> {
    const [refs, historyBoundary] = await Promise.all([
      listRefs(this.path),
      readHistoryBoundarySet(this.state.commonGitDir),
    ]);
    return {
      refsBySha: indexRefsBySha(refs),
      headSha: this.state.headSha,
      historyBoundary,
    };
  }

  /**
   * Create a paged commit history reader (FR-1 through FR-3, FR-7, FR-8). Fetches ref/HEAD/
   * shallow-boundary context once up front, then streams commits from a single `git log`
   * process as pages are requested. Caller must call `.close()` on the returned reader when
   * done (e.g. when the user navigates away or the filter changes).
   */
  async createCommitLogReader(filter?: CommitLogFilter): Promise<CommitPager> {
    if (filter?.sha) {
      // SHA lookups are handled by findCommitsBySha, not the streaming log walk — see its
      // doc comment. Expose it through the same paged shape for a uniform caller API.
      const context = await this.buildEnrichmentContext();
      const commits = await findCommitsBySha(this.path, filter.sha, context);
      return new PrefetchedCommitPager(commits);
    }
    const context = await this.buildEnrichmentContext();
    return new CommitLogReader(this.path, filter, context);
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
   * Working-tree status counts (FR-18's uncommitted-changes pseudo-node): staged/unstaged/
   * untracked/conflicted path counts, derived from `git status`. Returns `null` for a bare
   * repository or any other state with no working directory to compute status against —
   * there is nothing meaningful to report in that case, not an error.
   */
  async getWorkingDirectoryStatus(): Promise<WorkingDirectoryStatus | null> {
    if (this.state.isBare || !this.state.workdir) return null;
    return getWorkingDirectoryStatusImpl(this.state.workdir);
  }

  /**
   * Current branch's configured upstream (e.g. "origin/main"), for FR-15's default-selection
   * heuristic. `null` when HEAD is detached, unborn, or the current branch has no upstream
   * configured — all normal outcomes, not errors.
   */
  async getUpstreamBranch(): Promise<string | null> {
    if (this.state.isDetachedHead || !this.state.currentBranch) return null;
    // Works against a bare repo's path too (git resolves branch tracking config from cwd
    // regardless of a working tree existing) — prefer workdir when there is one, else the
    // path the repository was opened with.
    return getUpstreamBranchImpl(this.state.workdir ?? this.path);
  }

  /** Best-effort FR-6 auto-refresh signal. See watcher.ts for documented caveats. */
  watchForRefChanges(onChange: () => void, options?: WatchOptions): RepositoryWatcher {
    return watchRepositoryRefs(this.state.gitDir, this.state.commonGitDir, onChange, options);
  }

  /** Throws a clear, typed error for any action that requires a working directory, on a bare repo. */
  private requireWorkdir(action: string): string {
    if (this.state.isBare || !this.state.workdir) {
      throw new InvalidArgumentError(`Cannot ${action} in a bare repository (no working directory).`);
    }
    return this.state.workdir;
  }

  /**
   * Per-file working-directory change list (FR-19): staged/unstaged/untracked/conflicted, one
   * entry per path (a path can appear in both `staged` and `unstaged` — staged one edit, then
   * edited again). `null` for a bare repository — same convention as `getWorkingDirectoryStatus()`.
   */
  async getWorkingDirectoryChanges(): Promise<WorkingDirectoryChanges | null> {
    if (this.state.isBare || !this.state.workdir) return null;
    return getWorkingDirectoryChangesImpl(this.state.workdir);
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
   * FR-20(d)/FR-21/FR-22: a historical commit's file diff, extending `getChangedFiles()`'s
   * first-parent/empty-tree base selection from name-status-only to full patch content. Pass
   * the matching `ChangedFile` entry (for its `oldPath`, when the file was renamed/copied)
   * alongside the commit so a rename is diffed correctly instead of showing as a pure add.
   * Works against a bare repository too (same as `getChangedFiles`) — no working directory
   * is required to diff two existing commits.
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

  /** FR-140/FR-142: unstaged (worktree vs index) image-diff content for a single image-eligible
   * file, mirroring `getUnstagedFileDiff()`'s base selection exactly. */
  async getUnstagedImageDiff(filePath: string): Promise<ImageDiffResult> {
    const workdir = this.requireWorkdir("view an unstaged image diff");
    return getImageDiffImpl(workdir, { kind: "unstaged", path: filePath });
  }

  /** FR-140/FR-142: staged (index vs HEAD) image-diff content for a single image-eligible file,
   * mirroring `getStagedFileDiff()`'s base selection exactly. */
  async getStagedImageDiff(filePath: string): Promise<ImageDiffResult> {
    const workdir = this.requireWorkdir("view a staged image diff");
    return getImageDiffImpl(workdir, { kind: "staged", path: filePath });
  }

  /** FR-140/FR-142: untracked image-eligible file content, shown as an "Added" image with no old
   * side, mirroring `getUntrackedFileDiff()`'s base selection exactly. */
  async getUntrackedImageDiff(filePath: string): Promise<ImageDiffResult> {
    const workdir = this.requireWorkdir("view an untracked image diff");
    return getImageDiffImpl(workdir, { kind: "untracked", path: filePath });
  }

  /**
   * FR-140/FR-142: a historical commit's image-diff content, mirroring `getCommitFileDiff()`'s
   * base selection exactly (including its rename handling via `file.oldPath`). Works against a
   * bare repository too, same as `getCommitFileDiff()` — no working directory is required to
   * diff two existing commits' tree objects.
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
   * FR-24: discard a tracked file's working-tree changes. Destructive and unrecoverable via
   * git. A distinct, explicitly-named method — not reachable via `unstageFile`.
   */
  async discardTrackedFileChanges(filePath: string): Promise<void> {
    const workdir = this.requireWorkdir("discard file changes");
    return discardTrackedFileChangesImpl(workdir, filePath);
  }

  /**
   * FR-24: delete a single untracked file from disk. Destructive and unrecoverable. Scoped to
   * exactly one path — never a bare `git clean -fd` sweep of the whole tree.
   */
  async discardUntrackedFile(filePath: string): Promise<void> {
    const workdir = this.requireWorkdir("discard an untracked file");
    return discardUntrackedFileImpl(workdir, filePath);
  }

  /**
   * FR-25: create a commit from currently-staged content. See `createCommit`'s doc comment
   * (`commitChanges.ts`) for the typed errors this can throw (nothing staged, missing
   * user.name/user.email, hook rejection).
   */
  async createCommit(options: CreateCommitOptions): Promise<CreateCommitResult> {
    const workdir = this.requireWorkdir("create a commit");
    return createCommitImpl(workdir, options);
  }

  /**
   * FR-148: amend the current HEAD commit. See `amendCommit`'s doc comment (`commitChanges.ts`)
   * for the typed errors this can throw (an operation already in progress, unborn HEAD, missing
   * user.name/user.email, hook rejection).
   */
  async amendCommit(options: CreateCommitOptions): Promise<CreateCommitResult> {
    const workdir = this.requireWorkdir("amend a commit");
    return amendCommitImpl(workdir, options);
  }

  /**
   * FR-33: local branches (name, tip metadata, current/checked-out-elsewhere flags, upstream +
   * ahead/behind). Works on a bare repository (no working directory required).
   */
  async listBranches(): Promise<LocalBranchInfo[]> {
    return listBranchesImpl(this.path);
  }

  /** FR-34: remote-tracking branches, for use as create/checkout start points. */
  async listRemoteBranches(): Promise<RemoteBranchInfo[]> {
    return listRemoteBranchesImpl(this.path);
  }

  /**
   * FR-35/36/37: create a local branch, optionally switching to it immediately
   * (`options.switchToIt`, FR-36 — requires a working directory) or from a remote-tracking
   * start point with tracking wired up (FR-37). See `createBranch`'s doc comment
   * (`branches.ts`) for the typed errors this can throw.
   */
  async createBranch(options: CreateBranchOptions): Promise<CreateBranchResult> {
    const cwd = options.switchToIt ? this.requireWorkdir("switch to a new branch") : this.path;
    return createBranchImpl(cwd, options);
  }

  /**
   * FR-38: switch the working tree's HEAD to an existing local branch (`git switch`). Throws
   * `BranchSwitchConflictError` if uncommitted changes would be overwritten — never auto-stashes
   * or forces.
   */
  async switchBranch(branchName: string): Promise<SwitchResult> {
    const workdir = this.requireWorkdir("switch branches");
    return switchBranchImpl(workdir, branchName);
  }

  /** FR-39: detached-HEAD checkout of an arbitrary commit-ish. */
  async switchToCommit(commitish: string): Promise<SwitchResult> {
    const workdir = this.requireWorkdir("check out a commit");
    return switchToCommitImpl(workdir, commitish);
  }

  /**
   * FR-40: safe-delete a local branch (`git branch -d`). Throws `BranchNotFullyMergedError` or
   * `BranchCheckedOutError` (FR-42) as typed, specific errors rather than raw stderr. Works on a
   * bare repository — branch delete doesn't touch a working directory.
   */
  async deleteBranch(branchName: string): Promise<void> {
    return deleteBranchImpl(this.path, branchName);
  }

  /**
   * FR-41: force-delete a local branch (`git branch -D`), discarding unmerged commits.
   * Deliberately a separate, explicitly-named method from `deleteBranch` — never reachable via
   * the same call.
   */
  async forceDeleteBranch(branchName: string): Promise<void> {
    return forceDeleteBranchImpl(this.path, branchName);
  }

  // --- merge/rebase conflict resolution (specs/merge-rebase-conflict-resolution.md, FR-58 through FR-80) ---

  /**
   * FR-62/FR-63: every conflicted path's classification (both-modified/added-by-us.../rename/
   * submodule/binary) and stage content, read fresh from the index on every call — never cached
   * (FR-74). `null` for a bare repository (same convention as `getWorkingDirectoryChanges()`):
   * there is no working tree for a merge/rebase to have paused in.
   */
  async getConflictedFiles(): Promise<ConflictedFileInfo[] | null> {
    if (this.state.isBare || !this.state.workdir) return null;
    return getConflictedFilesImpl(this.path, this.state.workdir, this.state);
  }

  /**
   * FR-64/FR-77/FR-78/FR-80: three-way (base->ours, base->theirs) plus a direct ours->theirs
   * comparison for one already-classified conflicted file (from `getConflictedFiles()`). Reuses
   * `FileDiffResult`'s existing binary/too-large/ok shape. All three fields are null for a
   * submodule gitlink conflict (FR-77) — no attempted text diff.
   */
  async getConflictFileDiff(
    file: Pick<ConflictedFileInfo, "base" | "ours" | "theirs" | "isSubmodule">,
    options?: DiffOptions,
  ): Promise<ConflictFileDiff> {
    return getConflictFileDiffImpl(this.path, file, options);
  }

  /**
   * FR-61: concrete "your branch"/"incoming" (or "onto"/"your branch" for a rebase — see
   * `computeConflictSideLabels`'s doc comment for the inversion) labels for the CURRENT
   * in-progress operation, computed once and reused across every conflicted file. `null` when
   * there's no in-progress operation, or for `"am"`/`"bisect"`.
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
   * FR-65/FR-66/FR-78: whole-file "Accept Ours" (`side: "ours"`) or "Accept Theirs"
   * (`side: "theirs"`). `side` is git's own literal stage 2/3 mapping — pair it with
   * `getConflictSideLabels()`'s concrete label for display, never the bare words "ours"/
   * "theirs". Throws `ConflictMarkersRemainError` (FR-66) if, after checkout, marker text is
   * still present — should not normally happen (content comes straight from git's index) but is
   * checked anyway as a single safe code path shared with `markConflictResolved`. When the
   * chosen side has no content (e.g. accept-ours on a deleted-by-us file), stages the deletion
   * instead of failing (FR-78's "Delete file" outcome).
   */
  async acceptConflictSide(filePath: string, side: "ours" | "theirs"): Promise<void> {
    const workdir = this.requireWorkdir("accept a conflict side");
    return acceptConflictSideImpl(workdir, filePath, side);
  }

  /**
   * FR-65/FR-66: "Mark as resolved" for a file the user edited by hand. Throws
   * `ConflictMarkersRemainError` (making no `git add` call) if `<<<<<<<`/`=======`/`>>>>>>>`
   * marker lines remain — git itself does not check this, so this is the safety behavior that
   * closes that gap. Stages a deletion instead of failing when the user resolved by deleting the
   * file themselves.
   */
  async markConflictResolved(filePath: string): Promise<void> {
    const workdir = this.requireWorkdir("mark a conflict as resolved");
    return markConflictResolvedImpl(workdir, filePath);
  }

  /**
   * FR-68/FR-69: abort the current merge/rebase/cherry-pick/revert (`--abort`), restoring the
   * pre-operation branch tip, index, and working tree. `git rebase --quit` is never exposed
   * (FR-69). Throws `NoOperationInProgressError` if nothing is in progress, or for `"bisect"`
   * (no abort/continue affordance this pass). Any other failure — including git refusing the
   * abort — surfaces as `GitCommandError` with git's stderr verbatim, never swallowed or retried.
   */
  async abortInProgressOperation(): Promise<void> {
    this.requireWorkdir("abort the in-progress operation");
    return abortInProgressOperationImpl(this.path, this.state.inProgressOperation);
  }

  /**
   * FR-70/FR-71: continue the current operation (`--continue`), never spawning an interactive
   * external editor (`GIT_EDITOR=true`/`GIT_SEQUENCE_EDITOR=true` — Electron's `child_process`
   * has no TTY to host one). Client-side blocked — throws `ContinueBlockedError` naming every
   * blocking path, makes no `--continue` call — unless `WorkingDirectoryChanges.conflicted` is
   * empty AND FR-66's marker scan finds nothing in any currently-staged path (defense in depth
   * beyond git's own `--continue` refusal, which only catches the first condition). Throws
   * `NoOperationInProgressError` if nothing is in progress, or for `"bisect"`.
   */
  async continueInProgressOperation(): Promise<void> {
    const workdir = this.requireWorkdir("continue the in-progress operation");
    return continueInProgressOperationImpl(this.path, workdir, this.state.inProgressOperation);
  }

  // --- stash (specs/stash.md, FR-81 through FR-90) ---

  /**
   * FR-81/FR-82: every entry from `git stash list`, read fresh from disk on every call. `null`
   * for a bare repository (no working tree — same convention as `getWorkingDirectoryChanges()`),
   * matching the spec's edge-case handling: a bare repo can never have a stash created against it
   * in the first place. Visible identically from every linked worktree of this repository
   * (FR-82) — see stash.ts's module doc comment for why no extra common-git-dir plumbing is
   * needed here beyond shelling out to `git stash list` itself.
   */
  async listStashes(): Promise<StashInfo[] | null> {
    if (this.state.isBare || !this.state.workdir) return null;
    return listStashesImpl(this.path);
  }

  /**
   * FR-83: the full set of files one stash would change if applied — including any captured
   * untracked files — with diff content per file computed up front. Read-only: never touches the
   * working tree or index. `null` for a bare repository, matching `listStashes()`.
   */
  async getStashDiff(index: number, options?: DiffOptions): Promise<StashDiffResult | null> {
    if (this.state.isBare || !this.state.workdir) return null;
    return getStashDiffImpl(this.path, index, options);
  }

  /**
   * FR-84: `git stash push`. Throws `StashOnUnbornHeadError` on a zero-commit repository, or
   * `NothingEligibleToStashError` when there is nothing eligible (clean working tree, or every
   * changed/requested path is conflicted). See `createStash`'s doc comment (`stash.ts`) for the
   * exact eligibility/exclusion rules.
   */
  async createStash(options?: CreateStashOptions): Promise<CreateStashResult> {
    const workdir = this.requireWorkdir("create a stash");
    return createStashImpl(workdir, options);
  }

  /**
   * FR-85/FR-86: `git stash apply stash@{N}` — leaves the stash entry in `git stash list` either
   * way (clean apply or conflict). A conflict outcome populates
   * `getWorkingDirectoryChanges().conflicted` exactly like a merge conflict does — resolve it with
   * this same `Repository`'s existing `acceptConflictSide()`/`markConflictResolved()` methods, no
   * new conflict-resolution surface. Never synthesizes an in-progress-operation state (see
   * stash.ts's module doc comment) — `getState().inProgressOperation` stays `null` throughout.
   * Throws `PreExistingConflictError` up front (no `git stash apply` call made at all) if the
   * repository already has an unrelated conflict or in-progress operation before this call.
   */
  async applyStash(index: number): Promise<StashApplyOutcome> {
    const workdir = this.requireWorkdir("apply a stash");
    return applyStashImpl(workdir, index);
  }

  /**
   * FR-85/FR-87: `git stash pop stash@{N}` — removes the stash entry ONLY on a clean apply
   * (git's own native behavior). On conflict, behaves identically to `applyStash()`: the entry
   * remains in `git stash list`, and the conflicted files are left for the user to resolve. There
   * is no `git stash pop --abort` and this method never fabricates one. Throws
   * `PreExistingConflictError` up front (no `git stash pop` call made at all) if the repository
   * already has an unrelated conflict or in-progress operation before this call.
   */
  async popStash(index: number): Promise<StashApplyOutcome> {
    const workdir = this.requireWorkdir("pop a stash");
    return popStashImpl(workdir, index);
  }

  /**
   * FR-88: `git stash drop stash@{N}` — a separately-named, explicit destructive method, never
   * reachable via `applyStash()`/`popStash()`. Ref-only; works on a bare repository (though one
   * could never realistically have a stash to drop).
   */
  async dropStash(index: number): Promise<void> {
    return dropStashImpl(this.path, index);
  }

  // --- cherry-pick (specs/cherry-pick.md, FR-103 through FR-110) ---

  /**
   * FR-103: `git cherry-pick <sha1> ... <shaN>`, a single native call in exactly the order
   * given (ordering is the CALLER's contract — see `cherryPick.ts`'s doc comment / FR-114,
   * which is ui-graphics's responsibility, not this method's). Throws `InvalidArgumentError` for
   * an empty `shas` array, or `OperationAlreadyInProgressError` (no git call made) when a
   * merge/rebase/cherry-pick/revert/am/bisect is already in progress. Returns once git exits 0
   * (`HEAD` advanced by exactly `shas.length` new commits) — a paused outcome (conflict, or the
   * FR-105 empty-result case) is discovered afterward via `refreshState()`/
   * `getWorkingDirectoryChanges()`, never returned out of band here (FR-104).
   */
  async cherryPick(shas: readonly string[]): Promise<void> {
    const workdir = this.requireWorkdir("cherry-pick");
    return cherryPickImpl(workdir, shas);
  }

  /**
   * FR-106: `git cherry-pick --skip` for the FR-105 empty-result pause — advances past the
   * current step with no commit created for it. Throws `CherryPickNotAtEmptyResultError` (no
   * git call made) unless a cherry-pick is genuinely paused on an empty result, re-verified
   * fresh from disk. Git's own sequencer auto-advances (or ends the operation) afterward.
   */
  async skipCherryPickCommit(): Promise<void> {
    const workdir = this.requireWorkdir("skip a cherry-pick commit");
    return skipCherryPickCommitImpl(workdir);
  }

  /**
   * FR-106: `git commit --allow-empty` for the FR-105 empty-result pause, reusing the paused
   * commit's original message verbatim (read from the commit object itself, piped via stdin —
   * never an interactive editor, same technique `createCommit()` uses). Throws
   * `CherryPickNotAtEmptyResultError` (no git call made) unless a cherry-pick is genuinely
   * paused on an empty result. Git's own sequencer auto-advances (or ends the operation)
   * afterward.
   */
  async commitEmptyCherryPick(): Promise<void> {
    const workdir = this.requireWorkdir("commit an empty cherry-pick result");
    return commitEmptyCherryPickImpl(workdir);
  }

  // --- blame & file history (specs/blame.md, FR-123 through FR-130) ---

  /**
   * FR-123/124/125/126/127/128: blame `filePath`, either the current working-tree content
   * (`revision: null` — includes uncommitted edits, FR-126) or as of a historical commit
   * (`revision: <sha>`). Guards binary/oversized content before ever running a full `git blame`
   * (FR-125). Works against a bare repository for a historical-revision blame (same as
   * `getCommitFileDiff()`); `revision: null` requires a working directory (there is nothing to
   * blame in the working tree of a bare repo).
   */
  async getFileBlame(filePath: string, revision: string | null): Promise<BlameResult> {
    const cwd = revision === null ? this.requireWorkdir("blame a working-tree file") : this.path;
    return getFileBlameImpl(cwd, filePath, revision);
  }

  /**
   * FR-129: a paged reader over `filePath`'s history starting from `revision` (`--follow`,
   * pre-rename history included by default). Same `readPage(count)`/`close()` contract as
   * `createCommitLogReader()`'s result — caller must call `.close()` when done. Works against a
   * bare repository (a pure `git log` read, no working directory required).
   */
  async getFileHistory(revision: string, filePath: string): Promise<CommitPager> {
    return getFileHistoryImpl(this.path, revision, filePath);
  }
}
