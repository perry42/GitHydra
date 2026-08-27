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
 *  - Does not watch worktree-specific state files (MERGE_HEAD, rebase-merge/, etc.) — a
 *    mid-rebase state change won't trigger an automatic refresh in this version. Manual
 *    refresh always picks it up.
 *  - A more robust cross-platform implementation (e.g. via the `chokidar` package) is a
 *    reasonable follow-up once this module has a real consumer driving requirements; not
 *    added here to keep this package dependency-free.
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
  const watchers: fs.FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const scheduleFire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, debounceMs);
  };

  const tryWatch = (target: string, recursive: boolean) => {
    try {
      if (!fs.existsSync(target)) return;
      const watcher = fs.watch(target, { recursive, persistent: false }, () => scheduleFire());
      watcher.on("error", () => {
        /* best-effort: a watch target disappearing (e.g. packed-refs rewritten) is not fatal */
      });
      watchers.push(watcher);
    } catch {
      // Platform/filesystem doesn't support watching this target — degrade silently;
      // manual refresh remains available regardless.
    }
  };

  // Per-worktree: HEAD changes (checkout, detach, branch switch).
  tryWatch(path.join(gitDir, "HEAD"), false);
  // Shared across worktrees: actual ref storage.
  tryWatch(path.join(commonGitDir, "HEAD"), false);
  tryWatch(path.join(commonGitDir, "packed-refs"), false);
  tryWatch(path.join(commonGitDir, "refs"), true); // recursive: best-effort, see caveats above.

  return {
    close(): void {
      if (timer) clearTimeout(timer);
      for (const w of watchers) w.close();
    },
  };
}
