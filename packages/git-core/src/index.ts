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
import {
  stageFile as stageFileImpl,
  unstageFile as unstageFileImpl,
  stageAllFiles as stageAllFilesImpl,
  unstageAllFiles as unstageAllFilesImpl,
  discardTrackedFileChanges as discardTrackedFileChangesImpl,
  discardUntrackedFile as discardUntrackedFileImpl,
} from "./staging";
import { createCommit as createCommitImpl } from "./commitChanges";
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
  WorkingDirectoryChanges,
  WorkingDirectoryStatus,
  ConflictedFileInfo,
  ConflictFileDiff,
  ConflictMarkerScanResult,
  ConflictSideLabels,
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
} from "./errors";
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
  stageFile,
  unstageFile,
  stageAllFiles,
  unstageAllFiles,
  discardTrackedFileChanges,
  discardUntrackedFile,
} from "./staging";
export { createCommit } from "./commitChanges";
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

  static async open(repoPath: string): Promise<Repository> {
    const state = await getRepositoryState(repoPath);
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
}
