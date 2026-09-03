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
  /**
   * Bumped at the start of every `open()` call. Guards against two concurrent `open()` calls
   * (the renderer fires a second tab-switch/openRepo before the first one's `Repository.open()`
   * has resolved) racing to decide which repo ends up "the" live `this.repo` — without this, the
   * result that happens to *resolve last* wins regardless of which call the renderer/user
   * consider current, silently pointing every subsequent `getOpenRepo()`-based mutation
   * (stageFile, switchBranch, createCommit, ...) at the wrong repository. See
   * specs/multi-repo-tabs.md's fast-tab-switching bugfix notes.
   */
  private generation = 0;
  /**
   * specs/repo-open-feedback.md FR-163/FR-164: one `AbortController` per currently in-flight
   * `open()` call that was given a `requestId` (i.e. every `openRepoCancellable` attempt),
   * so a later `cancelOpen(requestId)` call can abort that SPECIFIC attempt's underlying
   * `Repository.open()` — and, transitively, every git child process it's waiting on (see
   * git-core's `Repository.open()`/`getRepositoryState()`/`armTimeout()` for how `signal` reaches
   * the actual `child_process.spawn()` calls, and the SIGTERM-then-SIGKILL escalation that
   * guarantees no orphaned process). Always removed once that attempt settles (success, genuine
   * error, or cancellation) — never grows unbounded.
   */
  private openAbortControllers = new Map<string, AbortController>();

  /**
   * `requestId`, when supplied, registers this specific attempt as cancellable via `cancelOpen()`
   * — see `openAbortControllers`'s doc comment. Omitted (default, every pre-existing caller) for
   * the ordinary, non-cancellable `openRepo` IPC channel — behavior for that channel is completely
   * unchanged.
   */
  async open(path: string, requestId?: string): Promise<Repository> {
    const generation = ++this.generation;
    this.closeAllReaders();
    this.watcher?.close();
    this.watcher = null;

    let controller: AbortController | undefined;
    if (requestId !== undefined) {
      controller = new AbortController();
      this.openAbortControllers.set(requestId, controller);
    }
    try {
      const repo = await Repository.open(path, { signal: controller?.signal });
      if (generation !== this.generation) {
        // A newer open() call was issued while this one was still in flight, and has already won
        // (or will win once it resolves) — this result is stale. `Repository` holds no persistent
        // handle of its own to explicitly close (no long-lived process/fd — every method shells
        // out fresh per call, see git-core's index.ts), so simply not assigning it here is
        // sufficient to avoid leaking it into use; let it be garbage-collected.
        return repo;
      }
      this.repo = repo;
      return repo;
    } finally {
      if (requestId !== undefined) this.openAbortControllers.delete(requestId);
    }
  }

  /**
   * specs/repo-open-feedback.md FR-163/FR-164: abort the in-flight `open(path, requestId)` call
   * matching `requestId`, if one is still in flight — a no-op (never throws) if it already
   * settled, was already cancelled, or `requestId` never matched any attempt at all. Idempotent
   * and safe to call speculatively/repeatedly.
   */
  cancelOpen(requestId: string): void {
    this.openAbortControllers.get(requestId)?.abort();
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
    // FR-164: a window closing mid-open (or the app quitting) must not leave a still-running git
    // child process orphaned just because nothing was ever going to call cancelOpen() for it.
    for (const controller of this.openAbortControllers.values()) controller.abort();
    this.openAbortControllers.clear();
  }
}
