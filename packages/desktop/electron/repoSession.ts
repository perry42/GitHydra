// SPDX-License-Identifier: GPL-3.0-or-later
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
   * cancellable `open()` call (i.e. every `openRepoCancellable` attempt), keyed by `requestId`, so
   * a later `cancelOpen(requestId)` call can abort that SPECIFIC attempt's underlying
   * `Repository.open()` — and, transitively, every git child process it's waiting on (see
   * git-core's `Repository.open()`/`getRepositoryState()`/`armTimeout()` for how `signal` reaches
   * the actual `child_process.spawn()` calls, and the SIGTERM-then-SIGKILL escalation that
   * guarantees no orphaned process).
   *
   * specs/repo-open-feedback-fixes.md FR-197: unlike the original (phase-one-only) implementation,
   * this entry's lifetime now spans the WHOLE cancellable open sequence — `Repository.open()`
   * itself, plus every aux-data read (`getRefs`/`getUpstreamBranch`/`getWorkingDirectoryChanges`/
   * `listStashes`) and the log-reader creation/first-page-fetch the renderer issues afterward for
   * the SAME `requestId` (see `getOpenSignal`). It is no longer deleted the moment
   * `Repository.open()` resolves — only `endOpenAttempt(requestId)` (called by the renderer once
   * the ENTIRE attempt has genuinely settled, success/error/cancelled, via a `finally`) removes it,
   * so it never grows unbounded despite living across several separate IPC round trips.
   */
  private openAbortControllers = new Map<string, AbortController>();
  /**
   * specs/repo-open-feedback-fixes.md FR-197/FR-199: the not-yet-committed `Repository` for a
   * still-in-flight cancellable open attempt, keyed by `requestId` — populated once
   * `Repository.open()` itself succeeds, but deliberately BEFORE this becomes the live
   * `this.repo`/before the previous session's readers+watcher are torn down. Every read issued as
   * part of the SAME open attempt (`getRefs`/`getUpstreamBranch`/`getWorkingDirectoryChanges`/
   * `listStashes`/`createLogReader`, each passed this attempt's `requestId`) resolves against this
   * pending repo instead of the live `this.repo` (see `getOpenRepoFor`) — so the PREVIOUS repo
   * stays exactly as live/usable (its own readers/watcher untouched) for as long as this attempt
   * might still be cancelled. `commitOpen(requestId)` promotes it to `this.repo` — and only THEN
   * tears down the previous readers/watcher — once the caller (`main.ts`) has confirmed the whole
   * sequence, not just `Repository.open()`, succeeded; `endOpenAttempt(requestId)` discards it
   * uncommitted for a cancelled/failed/superseded attempt, leaving the previous session untouched.
   */
  private pendingRepos = new Map<string, Repository>();
  /**
   * specs/repo-open-feedback-fixes.md FR-197/FR-199: reader ids created via `createReader(pager,
   * requestId)` while `requestId`'s repo is still pending (not yet committed) — see `createReader`.
   * `commitOpen` keeps exactly these readers (closing every other, now-superseded one);
   * `endOpenAttempt` closes exactly these readers (a cancelled/failed attempt's own, now-discarded
   * reader(s)) and leaves every other reader untouched. Without this bookkeeping, a reader created
   * mid-attempt would either leak (never closed) on cancellation, or `commitOpen` would have no way
   * to tell "the new reader to keep" apart from "the old reader(s) to close" — both real correctness
   * bugs (FR-199's "no orphaned reader, no repo/reader mismatch"), not just tidiness.
   */
  private pendingReaderIds = new Map<string, Set<string>>();

  /**
   * `requestId`, when supplied, registers this specific attempt as cancellable via `cancelOpen()`
   * — see `openAbortControllers`'s doc comment. Omitted (default, every pre-existing caller) for
   * the ordinary, non-cancellable `openRepo` IPC channel — behavior for that channel is completely
   * unchanged: it commits `this.repo` (and tears down whatever was live before) the moment
   * `Repository.open()` itself resolves, exactly as it always has.
   *
   * specs/repo-open-feedback-fixes.md FR-197/FR-199: for a cancellable attempt (`requestId`
   * supplied), this method deliberately does NOT commit the newly-opened `Repository` to
   * `this.repo`, and does NOT tear down the previous session's readers/watcher — it only stages
   * the result in `pendingRepos` (see that field's doc comment). The caller must follow up with
   * exactly one of `commitOpen(requestId)` (the whole sequence succeeded) or `endOpenAttempt
   * (requestId)` (cancelled, a genuine error anywhere in the sequence, or superseded) — never
   * neither, or this leaks.
   */
  async open(path: string, requestId?: string): Promise<Repository> {
    const generation = ++this.generation;

    let controller: AbortController | undefined;
    if (requestId !== undefined) {
      controller = new AbortController();
      this.openAbortControllers.set(requestId, controller);
    }
    const repo = await Repository.open(path, { signal: controller?.signal });
    if (generation !== this.generation) {
      // A newer open() call was issued while this one was still in flight, and has already won
      // (or will win once it resolves) — this result is stale, and must never become pending OR
      // live. `Repository` holds no persistent handle of its own to explicitly close (no long-lived
      // process/fd — every method shells out fresh per call, see git-core's index.ts), so simply
      // not assigning it anywhere here is sufficient to avoid leaking it into use; let it be
      // garbage-collected. (The caller's own `endOpenAttempt(requestId)` still cleans up the now-
      // pointless `openAbortControllers` entry.)
      return repo;
    }
    if (requestId !== undefined) {
      // FR-197/FR-199: staged, not committed — see `pendingRepos`' doc comment.
      this.pendingRepos.set(requestId, repo);
      return repo;
    }
    // Non-cancellable path (the plain `openRepo` IPC channel) — unchanged, immediate commit.
    this.closeAllReaders();
    this.watcher?.close();
    this.watcher = null;
    this.repo = repo;
    return repo;
  }

  /**
   * specs/repo-open-feedback-fixes.md FR-197/FR-199: promotes `requestId`'s staged, already-open
   * `Repository` to the live session — tearing down whatever was live before ONLY NOW, once the
   * caller has confirmed the ENTIRE open sequence (not just `Repository.open()`) succeeded. Returns
   * `false` (a safe no-op — never throws) if `requestId` has no pending repo (already committed,
   * already discarded via `endOpenAttempt`, or `open()` never actually staged one for it, e.g. a
   * superseded/cancelled attempt) — the caller must treat that as "nothing to commit", never assume
   * success. Every reader created under `requestId` (see `createReader`) is kept as the new live
   * reader set; every OTHER currently-open reader (belonging to whatever was live before) is closed
   * here, exactly mirroring what the non-cancellable `open()` path already does synchronously.
   */
  commitOpen(requestId: string): boolean {
    const repo = this.pendingRepos.get(requestId);
    if (!repo) return false;
    this.pendingRepos.delete(requestId);
    const keep = this.pendingReaderIds.get(requestId) ?? new Set<string>();
    this.pendingReaderIds.delete(requestId);
    for (const [id, reader] of this.readers) {
      if (!keep.has(id)) {
        reader.close();
        this.readers.delete(id);
      }
    }
    this.watcher?.close();
    this.watcher = null;
    this.repo = repo;
    return true;
  }

  /**
   * specs/repo-open-feedback-fixes.md FR-197/FR-199: releases every piece of `requestId`'s
   * bookkeeping (its abort controller, any staged-but-uncommitted pending repo, and any reader(s)
   * created while that repo was still pending) once the caller has determined the ENTIRE open
   * attempt has settled for any non-success reason — genuine error, cancellation, or superseded
   * before even finishing `open()`. Idempotent and safe to call more than once, or for an unknown/
   * already-committed `requestId` (a no-op in that case — `commitOpen` already cleared its own
   * entries). Every cancellable attempt must eventually call exactly one of `commitOpen` then
   * `endOpenAttempt`, or just `endOpenAttempt` alone (any non-success outcome) — never neither, or
   * `openAbortControllers`/`pendingRepos` leak entries for the app's remaining lifetime.
   */
  endOpenAttempt(requestId: string): void {
    this.openAbortControllers.delete(requestId);
    this.pendingRepos.delete(requestId);
    const created = this.pendingReaderIds.get(requestId);
    if (created) {
      for (const id of created) {
        this.readers.get(id)?.close();
        this.readers.delete(id);
      }
      this.pendingReaderIds.delete(requestId);
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

  /**
   * specs/repo-open-feedback-fixes.md FR-197: the signal for `requestId`'s still-registered
   * cancellable attempt (whether or not its repo has been staged as pending yet), or `undefined` if
   * `requestId` was never registered, has already settled, or is `undefined` itself. Every aux-data/
   * reader-creation IPC handler issued as part of an open attempt passes this through to the
   * underlying git-core call so it's abortable for the attempt's entire duration, not just
   * `Repository.open()`'s own phase.
   */
  getOpenSignal(requestId?: string): AbortSignal | undefined {
    if (requestId === undefined) return undefined;
    return this.openAbortControllers.get(requestId)?.signal;
  }

  getOpenRepo(): Repository {
    if (!this.repo) throw new Error("No repository is open");
    return this.repo;
  }

  /**
   * specs/repo-open-feedback-fixes.md FR-197/FR-199: resolves to `requestId`'s still-pending
   * (already-open, not-yet-committed) `Repository` when one is registered, else falls back to the
   * ordinary live session repo (`getOpenRepo()`) — used by every aux-data/reader-creation IPC
   * handler so a call issued mid-open-attempt operates against the CORRECT repo (the one this
   * specific attempt just opened) rather than whatever was live before it, without the live
   * session having been mutated yet. Every call site that isn't part of an open attempt simply
   * omits `requestId` and gets today's exact `getOpenRepo()` behavior.
   */
  getOpenRepoFor(requestId?: string): Repository {
    if (requestId !== undefined) {
      const pending = this.pendingRepos.get(requestId);
      if (pending) return pending;
    }
    return this.getOpenRepo();
  }

  /**
   * `requestId`, when supplied, records this reader as belonging to that still-in-flight open
   * attempt (see `pendingReaderIds`'s doc comment) so `commitOpen`/`endOpenAttempt` know whether to
   * keep or close it. Omitted for every ordinary (non-open-sequence) reader creation — unchanged
   * behavior, the reader is simply a normal entry in `this.readers` with nothing else tracking it.
   */
  createReader(pager: CommitPager, requestId?: string): string {
    const id = `reader-${++this.readerSeq}`;
    this.readers.set(id, pager);
    if (requestId !== undefined) {
      const set = this.pendingReaderIds.get(requestId);
      if (set) set.add(id);
      else this.pendingReaderIds.set(requestId, new Set([id]));
    }
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

  /**
   * specs/repo-list.md (revised IA) / security review: closes every reader, the ref-change
   * watcher, and clears the live repo — the same full teardown `open()`'s own top-of-function
   * reset performs, just callable on its own (via the `closeRepoSession` IPC channel) for "no new
   * repo is replacing this one" cases (window/app close via this same method already; "+ New tab"
   * and closing the last tab via that channel). `generation` is bumped too, exactly like `open()`
   * bumps it on every call — without this, an `open()` attempt already in flight when this runs
   * could still resolve afterward and see `generation === this.generation` (nothing else having
   * bumped it since), wrongly assigning its now-orphaned result to `this.repo` as if this dispose
   * had never happened. Aborting every in-flight open's signal (below) makes that resolve-after-
   * dispose case unlikely in practice, but costs nothing to guard against directly too.
   */
  dispose(): void {
    this.generation += 1;
    this.closeAllReaders();
    this.watcher?.close();
    this.watcher = null;
    this.repo = null;
    // FR-164: a window closing mid-open (or the app quitting) must not leave a still-running git
    // child process orphaned just because nothing was ever going to call cancelOpen() for it.
    for (const controller of this.openAbortControllers.values()) controller.abort();
    this.openAbortControllers.clear();
    this.pendingRepos.clear();
    this.pendingReaderIds.clear();
  }
}
