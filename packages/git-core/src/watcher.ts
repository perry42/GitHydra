import * as fs from "node:fs";
import * as path from "node:path";

/**
 * FR-6 (partial / best-effort — see caveats below): watch the paths whose changes mean "refs
 * moved, re-read the graph" — HEAD, the refs/ tree, and packed-refs — and invoke `onChange`
 * (debounced) when any of them change.
 *
 * A manual refresh is NOT implemented here because it needs no implementation: every read
 * function in this module (getRepositoryState, listRefs, CommitLogReader, ...) always reads
 * live from disk with no caching layer, so "refresh" is simply "call them again." The caller
 * (UI layer) should wire a refresh button directly to that re-fetch, regardless of whether
 * this watcher is enabled.
 *
 * Known limitations of this first pass, deliberately deferred rather than silently pretended
 * to work:
 *  - Uses `fs.watch` with `recursive: true`. This is supported on Windows and macOS but,
 *    as of Node 22, is NOT supported on Linux — on Linux this watcher will only observe the
 *    top-level files it's given (HEAD, packed-refs) and the immediate refs/heads,
 *    refs/remotes, refs/tags directories will need per-subdirectory watches, which this
 *    version does not set up. Effect: on Linux, creating a new ref deep in a nested
 *    refs/remotes/<remote>/<branch-with-slashes> path may be missed; updates to existing,
 *    already-watched files are still caught (HEAD, packed-refs, direct loose refs).
 *  - No debounce coalescing beyond a simple timer — a burst of ref updates (e.g. a large
 *    fetch) may fire `onChange` a few times in quick succession rather than exactly once.
 *  - A more robust cross-platform implementation (e.g. via the `chokidar` package) is a
 *    reasonable follow-up once this module has a real consumer driving requirements; not
 *    added here to keep this package dependency-free.
 *
 * FR-59 (merge-rebase-conflict-resolution.md): operation-state files (`MERGE_HEAD`,
 * `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `rebase-merge/`, `rebase-apply/`) ARE now watched — see the
 * `gitDir`-level watch below. This closes what used to be a documented gap here ("a mid-rebase
 * state change won't trigger an automatic refresh in this version"); starting, continuing, or
 * aborting an operation from a terminal alongside an open GitHydra window now triggers the same
 * debounced `onChange` as any other ref change — including the operation *ending*: `rebase-merge/`
 * being deleted entirely on `rebase --abort` or on a multi-step rebase's final `--continue`. That
 * "ending" half was previously broken specifically on Windows (a stale nested `fs.watch` handle on
 * the just-deleted directory storms spurious events that starve the shared debounce timer forever
 * instead of ever firing `onChange`) — see `tryWatch`'s stale-target self-close guard below and
 * `watcher.test.ts` for the fix and its real-filesystem regression repro.
 */
export interface RepositoryWatcher {
  close(): void;
}

export interface WatchOptions {
  /** Debounce window in ms before firing onChange after the first detected change. Default 150. */
  debounceMs?: number;
}

export function watchRepositoryRefs(
  gitDir: string,
  commonGitDir: string,
  onChange: () => void,
  options: WatchOptions = {},
): RepositoryWatcher {
  const debounceMs = options.debounceMs ?? 150;
  const watchers = new Map<string, fs.FSWatcher>(); // keyed by absolute target path — lets the
  // FR-59 self-healing logic below check "am I already watching this?" without a second Set.
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const scheduleFire = () => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, debounceMs);
  };

  const tryWatch = (target: string, recursive: boolean, onEvent?: () => void): boolean => {
    const key = path.resolve(target);
    if (watchers.has(key)) return true;
    try {
      if (!fs.existsSync(target)) return false;
      // Guards re-entrancy within a single stale-target removal (see below) — `fs.watch`'s
      // callback can still be invoked synchronously/re-entrantly for events already queued
      // before `watcher.close()` below takes effect.
      let removedSelf = false;
      const watcher = fs.watch(target, { recursive, persistent: false }, () => {
        if (removedSelf) return;
        // Windows-specific bug this guards against (confirmed by direct repro against real
        // `git rebase --abort` / a completing multi-step `git rebase --continue`, both of which
        // delete `target` outright — see watcher.test.ts): once a directory `fs.watch` is
        // watching gets deleted out from under it, Node/libuv on Windows does not reliably
        // deliver a clean "the directory is gone" signal. Instead the underlying
        // ReadDirectoryChangesW handle goes stale and the watcher can emit an effectively
        // unbounded stream of spurious "rename" events referencing the now-invalid path — never
        // an "error" event, and never stopping on its own. Left unhandled, every one of those
        // events calls `scheduleFire()` below, which resets the *shared* debounce timer every
        // single time — so as long as the storm continues, `onChange` is not just delayed, it is
        // starved out entirely (observed: hundreds of thousands of events with no gap ever
        // reaching the debounce window, in well under a second of wall-clock time).
        //
        // Fix: on every event, check whether `target` itself still exists. If it doesn't, this
        // watcher instance is stale — close and drop it immediately (before scheduling), which
        // stops the storm at its source, then fire exactly one change notification for the
        // removal itself. `watchers.delete(key)` also re-enables `tryWatch(target, ...)` to
        // succeed again later (mirrors the existing "error" handler below), so the self-healing
        // re-watch logic in the FR-59 block further down still picks a *new* rebase-merge/
        // rebase-apply directory back up correctly if another operation starts afterward.
        if (!fs.existsSync(target)) {
          removedSelf = true;
          watchers.delete(key);
          try {
            watcher.close();
          } catch {
            /* already closing/closed */
          }
          scheduleFire();
          onEvent?.();
          return;
        }
        scheduleFire();
        onEvent?.();
      });
      watcher.on("error", () => {
        /* best-effort: a watch target disappearing (e.g. packed-refs rewritten) is not fatal */
        watchers.delete(key);
      });
      watchers.set(key, watcher);
      return true;
    } catch {
      // Platform/filesystem doesn't support watching this target — degrade silently;
      // manual refresh remains available regardless.
      return false;
    }
  };

  // Per-worktree: HEAD changes (checkout, detach, branch switch).
  tryWatch(path.join(gitDir, "HEAD"), false);
  // Shared across worktrees: actual ref storage.
  tryWatch(path.join(commonGitDir, "HEAD"), false);
  tryWatch(path.join(commonGitDir, "packed-refs"), false);
  tryWatch(path.join(commonGitDir, "refs"), true); // recursive: best-effort, see caveats above.

  // FR-59: operation-state files/dirs are per-worktree (gitDir, not commonGitDir — same
  // worktree-scoping `detectInProgressOperation` already gets right, FR-76). `fs.watch` can only
  // watch a target that already exists, and MERGE_HEAD/CHERRY_PICK_HEAD/REVERT_HEAD/rebase-merge/
  // rebase-apply don't exist most of the time — so a plain per-file watch set up once at startup
  // would never catch one of these being CREATED later (e.g. a merge started from a terminal
  // after GitHydra already opened the repo). Watching `gitDir` itself, non-recursively, catches
  // that creation (and deletion, on `--abort`/`--continue` finishing) as a top-level directory-
  // entry change, at the cost of also firing for ordinary per-commit/per-stage noise (HEAD/index/
  // COMMIT_EDITMSG rewrites) — an acceptable trade for a debounced "just re-fetch, reads are
  // always live" watcher, and necessary since there is no cheaper way to observe a not-yet-
  // existing file's creation with `fs.watch`.
  const rebaseMergeDir = path.join(gitDir, "rebase-merge");
  const rebaseApplyDir = path.join(gitDir, "rebase-apply");
  // Self-healing: once rebase-merge/rebase-apply exists, also watch INSIDE it (msgnum/next
  // incrementing as a multi-step rebase progresses via `--continue`, run from a terminal while
  // GitHydra stays open — acceptance criterion #11) — best-effort, same recursive caveat as
  // `refs/` above, but these directories are small/shallow so the Linux gap matters far less here.
  const ensureNestedRebaseWatches = () => {
    if (closed) return;
    tryWatch(rebaseMergeDir, true);
    tryWatch(rebaseApplyDir, true);
  };
  tryWatch(gitDir, false, ensureNestedRebaseWatches);
  ensureNestedRebaseWatches(); // also try immediately, in case a rebase is already in progress when the watcher is created.

  return {
    close(): void {
      closed = true;
      if (timer) clearTimeout(timer);
      for (const w of watchers.values()) w.close();
      watchers.clear();
    },
  };
}
