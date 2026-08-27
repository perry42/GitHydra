import {
  Repository,
  type CommitPager,
  type RepositoryWatcher,
  type WorkingDirectoryStatus,
} from "@githydra/git-core";

/**
 * Holds the single currently-open repository for this window (v1 treats each open worktree/
 * repo as its own window/session per the commit-graph spec's "Worktrees" edge case — no need to
 * juggle multiple repos in one session) plus any live paged commit-log readers, keyed by id so
 * the renderer can hold a page cursor across IPC calls without the main process guessing intent.
 */
export class RepoSession {
  private repo: Repository | null = null;
  private readers = new Map<string, CommitPager>();
  private readerSeq = 0;
  private watcher: RepositoryWatcher | null = null;

  async open(path: string): Promise<Repository> {
    this.closeAllReaders();
    this.watcher?.close();
    this.watcher = null;
    this.repo = await Repository.open(path);
    return this.repo;
  }

  getOpenRepo(): Repository {
    if (!this.repo) throw new Error("No repository is open");
    return this.repo;
  }

  createReader(pager: CommitPager): string {
    const id = `reader-${++this.readerSeq}`;
    this.readers.set(id, pager);
    return id;
  }

  getReader(id: string): CommitPager {
    const reader = this.readers.get(id);
    if (!reader) throw new Error(`Unknown commit log reader: ${id}`);
    return reader;
  }

  closeReader(id: string): void {
    const reader = this.readers.get(id);
    if (reader) {
      reader.close();
      this.readers.delete(id);
    }
  }

  private closeAllReaders(): void {
    for (const reader of this.readers.values()) reader.close();
    this.readers.clear();
  }

  async getWorkingDirectoryStatus(): Promise<WorkingDirectoryStatus | null> {
    // FR-18 / AC5: bare repos have no working tree, so no pseudo-node data to compute —
    // Repository.getWorkingDirectoryStatus() already guards this and returns null.
    return this.getOpenRepo().getWorkingDirectoryStatus();
  }

  async getUpstreamBranch(): Promise<string | null> {
    return this.getOpenRepo().getUpstreamBranch();
  }

  startWatch(onChange: () => void): void {
    this.watcher?.close();
    const repo = this.getOpenRepo();
    const state = repo.getState();
    this.watcher = repo.watchForRefChanges(onChange, undefined) ?? null;
    void state;
  }

  dispose(): void {
    this.closeAllReaders();
    this.watcher?.close();
    this.watcher = null;
    this.repo = null;
  }
}
