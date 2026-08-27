import { getRepositoryState, readHistoryBoundarySet } from "./repository";
import { listRefs, indexRefsBySha } from "./refs";
import { CommitLogReader, PrefetchedCommitPager, findCommitsBySha, type CommitPager } from "./commitLog";
import { getChangedFiles as getChangedFilesImpl } from "./changedFiles";
import { getWorkingDirectoryStatus as getWorkingDirectoryStatusImpl } from "./workingDirStatus";
import { getUpstreamBranch as getUpstreamBranchImpl } from "./upstream";
import { watchRepositoryRefs, type RepositoryWatcher, type WatchOptions } from "./watcher";
import { InvalidArgumentError } from "./errors";
import type {
  CommitInfo,
  CommitLogFilter,
  RefDecoration,
  RefInfo,
  RepositoryState,
  ChangedFile,
  WorkingDirectoryStatus,
} from "./types";

export * from "./types";
export {
  GitCommandError,
  GitNotFoundError,
  NotAGitRepositoryError,
  UnsupportedGitVersionError,
  InvalidArgumentError,
} from "./errors";
export { CommitLogReader, PrefetchedCommitPager, findCommitsBySha, type CommitPager } from "./commitLog";
export { getRepositoryState } from "./repository";
export { listRefs, indexRefsBySha, headDecoration } from "./refs";
export { getChangedFiles } from "./changedFiles";
export { getWorkingDirectoryStatus, parsePorcelainStatus } from "./workingDirStatus";
export { getUpstreamBranch } from "./upstream";
export { watchRepositoryRefs, type RepositoryWatcher, type WatchOptions } from "./watcher";

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
}
