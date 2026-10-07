// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { runGit, runGitWithInput, withFsmonitorNeutralized } from "./gitProcess";
import { GitCommandError } from "./errors";

/**
 * Working-tree change signal for live refresh (specs/live-refresh.md, FR-458/FR-459). A separate
 * channel from `watchRepositoryRefs`: it says only "something in the work tree changed" (plus a
 * bounded, advisory path list) and never reads file contents. The consumer re-runs its own status.
 */
export interface WorktreeChange {
  /** Forward-slash paths relative to the work tree. Advisory and capped; may be empty when `truncated`. */
  paths: string[];
  /** True when more paths changed than `paths` holds, or an event flood skipped per-path filtering. */
  truncated: boolean;
}

export type WorktreeWatchDegradedReason =
  /** No efficient recursive watch on this platform (Linux); the consumer falls back to focus-regain (FR-458). */
  | "unsupported-platform"
  /** `fs.watch` threw or errored at runtime (ENOSPC, EMFILE, EPERM, root removed, ...). */
  | "watch-failed"
  /** The tree has more entries than `maxWatchedEntries`; the recursive watch is never started (the budget walk runs first). */
  | "too-large";

export interface WorktreeWatchOptions {
  /** Trailing debounce in ms. Default 200. */
  debounceMs?: number;
  /** Upper bound in ms between the first event of a burst and the notification. Default 1000. */
  maxWaitMs?: number;
  /** Cap on `WorktreeChange.paths`. Default 50. */
  maxPaths?: number;
  /** Called at most once if the watch is not running or stops. The watcher stays closeable. */
  onDegraded?: (reason: WorktreeWatchDegradedReason, detail?: string) => void;
  /** Skip the recursive watch above this many top-level-visible entries (shallow sampled count). Default 250_000. */
  maxWatchedEntries?: number;
  /** Test seam. */
  platform?: NodeJS.Platform;
}

export interface WorktreeWatcher {
  close(): void;
  /** "degraded" once `onDegraded` has fired (or is about to). */
  readonly state: "watching" | "degraded";
  readonly degradedReason: WorktreeWatchDegradedReason | null;
  /** Resolves when the initial ignore list is computed. Mainly for tests. */
  ready(): Promise<void>;
}

const DEFAULT_DEBOUNCE_MS = 200;
const DEFAULT_MAX_WAIT_MS = 1000;
const DEFAULT_MAX_PATHS = 50;
// Above these, per-path `check-ignore` costs more than one conservative notification.
const MAX_PENDING_EVENTS = 5000;
const MAX_CHECK_PATHS = 2000;
const IGNORE_CACHE_MAX = 20_000;
// Coalesces `.gitignore` event bursts (a checkout touching thousands of nested files) into one recompute.
const IGNORE_REFRESH_DEBOUNCE_MS = 300;
// Fail-open per-path retry after a batch check-ignore dies; bounded so a hostile tree can't spawn thousands.
const MAX_PER_PATH_RETRIES = 50;
const GIT_CALL_TIMEOUT_MS = 120_000;

// specs/edit-in-diff.md FR-536: editFile.ts's transient save target; its rename onto the real file still reports.
const EDIT_TEMP_FILE = /^\.githydra-edit-[0-9a-f]{16}\.tmp$/;

let ignoreRefreshCount = 0;
/** Test seam: number of ignore-list recomputes started by any watcher. */
export function _getIgnoreRefreshCountForTests(): number {
  return ignoreRefreshCount;
}

/** A per-call signal that aborts on the watcher's close or a timeout (a supplied signal disables runGit's own timeout). */
function boundedSignal(parent?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const c = new AbortController();
  const onAbort = (): void => c.abort();
  if (parent?.aborted) c.abort();
  else parent?.addEventListener("abort", onAbort, { once: true });
  const t = setTimeout(onAbort, GIT_CALL_TIMEOUT_MS);
  t.unref?.();
  return {
    signal: c.signal,
    dispose: () => {
      clearTimeout(t);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

export function watchWorktree(
  workdir: string,
  onChange: (change: WorktreeChange) => void,
  options: WorktreeWatchOptions = {},
): WorktreeWatcher {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const maxPaths = options.maxPaths ?? DEFAULT_MAX_PATHS;
  const platform = options.platform ?? process.platform;

  let closed = false;
  const closeController = new AbortController();
  // Windows/macOS file systems are case-insensitive by default. 8.3 short names (GIT~1) can't be matched by name; not handled.
  const caseInsensitive = platform === "win32" || platform === "darwin";
  let ignoreTimer: ReturnType<typeof setTimeout> | null = null;
  let ignoreRunning = false;
  let ignoreTrailing = false;
  let state: "watching" | "degraded" = "watching";
  let degradedReason: WorktreeWatchDegradedReason | null = null;
  let watcher: fs.FSWatcher | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  let pending = new Set<string>();
  let overflowed = false;
  let flushing = false;
  let flushAgain = false;
  let ignoredTopLevel = new Set<string>();
  const ignoreCache = new Map<string, boolean>();
  let ignoreGeneration = 0;

  const isDead = (): boolean => closed || state === "degraded";

  const degrade = (reason: WorktreeWatchDegradedReason, detail?: string): void => {
    if (state === "degraded") return;
    state = "degraded";
    degradedReason = reason;
    stopWatching();
    // Deferred so a caller can finish wiring before the first signal arrives.
    queueMicrotask(() => {
      if (!closed) options.onDegraded?.(reason, detail);
    });
  };

  const stopWatching = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (maxWaitTimer) clearTimeout(maxWaitTimer);
    if (ignoreTimer) clearTimeout(ignoreTimer);
    debounceTimer = maxWaitTimer = ignoreTimer = null;
    pending.clear();
    const w = watcher;
    watcher = null;
    try {
      w?.close();
    } catch {
      /* already closed */
    }
  };

  // One run in flight plus one trailing; the cache is cleared once per run, not per event.
  const runIgnoreRefresh = async (): Promise<void> => {
    if (closed) return;
    if (ignoreRunning) {
      ignoreTrailing = true;
      return;
    }
    ignoreRunning = true;
    try {
      do {
        ignoreTrailing = false;
        ignoreRefreshCount++;
        const generation = ++ignoreGeneration;
        ignoreCache.clear();
        const next = await computeIgnoredTopLevelDirs(workdir, closeController.signal).catch(() => new Set<string>());
        if (closed) return;
        if (generation === ignoreGeneration) ignoredTopLevel = next;
      } while (ignoreTrailing && !closed);
    } finally {
      ignoreRunning = false;
    }
  };

  const scheduleIgnoreRefresh = (): void => {
    if (isDead()) return;
    if (ignoreTimer) clearTimeout(ignoreTimer);
    ignoreTimer = setTimeout(() => {
      ignoreTimer = null;
      void runIgnoreRefresh();
    }, IGNORE_REFRESH_DEBOUNCE_MS);
  };

  const flush = async (): Promise<void> => {
    if (flushing) {
      flushAgain = true;
      return;
    }
    flushing = true;
    try {
      flushAgain = false;
      await readyPromise;
      if (isDead()) return;
      const batch = pending;
      const wasOverflow = overflowed;
      pending = new Set();
      overflowed = false;
      if (batch.size > 0 || wasOverflow) {
        const result = await filterIgnored(batch, wasOverflow);
        if (isDead()) return;
        if (result) onChange(result);
      }
    } finally {
      flushing = false;
    }
    // Re-arm through the debounce instead of looping, so a steady stream is paced by maxWaitMs, not spawn latency.
    if (!isDead() && (flushAgain || pending.size > 0 || overflowed)) scheduleFlush();
  };

  const filterIgnored = async (batch: Set<string>, wasOverflow: boolean): Promise<WorktreeChange | null> => {
    if (wasOverflow || batch.size > MAX_CHECK_PATHS) {
      return { paths: [...batch].slice(0, maxPaths), truncated: true };
    }
    const unknown: string[] = [];
    const kept: string[] = [];
    for (const p of batch) {
      const cached = ignoreCache.get(p);
      if (cached === undefined) unknown.push(p);
      else if (!cached) kept.push(p);
    }
    if (unknown.length > 0) {
      const generation = ignoreGeneration;
      const { ignored, complete } = await checkIgnored(workdir, unknown, closeController.signal);
      // Conservative on git failure: report instead of dropping a real change; incomplete verdicts aren't cached.
      for (const p of unknown) {
        const isIgnored = ignored.has(p);
        if (generation === ignoreGeneration && complete) {
          if (ignoreCache.size >= IGNORE_CACHE_MAX) ignoreCache.clear();
          ignoreCache.set(p, isIgnored);
        }
        if (!isIgnored) kept.push(p);
      }
    }
    if (kept.length === 0) return null;
    return { paths: kept.slice(0, maxPaths), truncated: kept.length > maxPaths };
  };

  const scheduleFlush = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(fire, debounceMs);
    // Max wait: a continuous stream (a build writing outside ignored dirs) must not starve the signal.
    if (!maxWaitTimer) maxWaitTimer = setTimeout(fire, maxWaitMs);
  };

  const fire = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (maxWaitTimer) clearTimeout(maxWaitTimer);
    debounceTimer = maxWaitTimer = null;
    if (closed || state === "degraded") return;
    void flush().catch(() => {
      /* flush has no failure it can usefully surface; the next event retries */
    });
  };

  const onEvent = (filename: string | Buffer | null): void => {
    if (isDead()) return;
    if (filename === null || filename === undefined) {
      overflowed = true;
      scheduleFlush();
      return;
    }
    const rel = filename.toString().split(path.sep).join("/");
    // Root-directory timestamp events (empty name) fire during ignored-tree bursts; real file changes always carry a name.
    if (rel === "") return;
    const segments = rel.split("/");
    // `.git` at any depth also excludes submodule/nested-repo internals and our own index.lock writes.
    const norm = (x: string): string => (caseInsensitive ? x.toLowerCase() : x);
    if (segments.some((x) => norm(x) === ".git")) return;
    const base = segments[segments.length - 1]!;
    if (norm(base) === "index.lock") return;
    if (EDIT_TEMP_FILE.test(norm(base))) return;
    if (segments.length > 0 && ignoredTopLevel.has(segments[0]!) && segments.length > 1) return;
    if (segments.length === 1 && ignoredTopLevel.has(segments[0]!)) return;
    if (base === ".gitignore") {
      // Ignore rules changed: the old verdicts and top-level list are stale, and the status changed too.
      scheduleIgnoreRefresh();
    }
    if (pending.size >= MAX_PENDING_EVENTS) overflowed = true;
    else pending.add(rel);
    scheduleFlush();
  };

  let readyPromise: Promise<void> = Promise.resolve();

  if (platform === "linux") {
    // FR-458/Non-goals: no Linux recursive-watch parity (Node's Linux implementation holds one inotify watch per directory, ignored trees included).
    degrade("unsupported-platform");
  } else {
    readyPromise = (async () => {
      const limit = options.maxWatchedEntries ?? 250_000;
      try {
        if (await exceedsEntryBudget(workdir, limit, () => closed)) {
          if (!closed) degrade("too-large", `more than ${limit} entries`);
          return;
        }
      } catch {
        /* unreadable root: let fs.watch report it */
      }
      if (isDead()) return;
      // Started only after the budget passes, so a too-large tree never holds an OS watch; changes in the walk's window are covered by the consumer's fresh status on open.
      try {
        watcher = fs.watch(workdir, { recursive: true, persistent: false }, (_t, f) => onEvent(f));
        watcher.on("error", (err: NodeJS.ErrnoException) => degrade("watch-failed", err.code ?? err.message));
      } catch (err) {
        degrade("watch-failed", (err as NodeJS.ErrnoException).code ?? (err as Error).message);
        return;
      }
      await runIgnoreRefresh();
    })();
  }

  return {
    close(): void {
      closed = true;
      closeController.abort();
      stopWatching();
    },
    get state() {
      return state;
    },
    get degradedReason() {
      return degradedReason;
    },
    ready: () => readyPromise,
  };
}

/**
 * Top-level directories git ignores and that hold no tracked files (a tracked file inside an
 * ignored dir, e.g. force-added vendor code, must still produce events).
 */
export async function computeIgnoredTopLevelDirs(workdir: string, parentSignal?: AbortSignal): Promise<Set<string>> {
  const entries = await fsp.readdir(workdir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory() && e.name !== ".git").map((e) => e.name);
  if (dirs.length === 0) return new Set();
  // A partial result is safe: a smaller ignored set only means more directories are watched.
  const { ignored } = await checkIgnoredRaw(
    workdir,
    dirs.map((d) => `${d}/`),
    parentSignal,
  );
  const candidates = [...ignored].map((p) => p.replace(/\/$/, ""));
  if (candidates.length === 0) return new Set();
  let tracked = "";
  const bound = boundedSignal(parentSignal);
  try {
    // GIT_LITERAL_PATHSPECS is set by runGit's env, so bracket names stay literal.
    tracked = (
      await runGit(withFsmonitorNeutralized(["ls-files", "-z", "--", ...candidates]), {
        cwd: workdir,
        signal: bound.signal,
      })
    ).stdout;
  } catch {
    return new Set(); // can't prove none are tracked: watch them all
  } finally {
    bound.dispose();
  }
  const withTracked = new Set(tracked.split("\0").filter(Boolean).map((p) => p.split("/")[0]!));
  return new Set(candidates.filter((c) => !withTracked.has(c)));
}

interface IgnoreVerdicts {
  ignored: Set<string>;
  /** False when some paths could not be checked (treated as not ignored, never cached). */
  complete: boolean;
}

async function runCheckIgnore(workdir: string, paths: string[], parentSignal?: AbortSignal): Promise<Set<string> | null> {
  if (parentSignal?.aborted) return null;
  const bound = boundedSignal(parentSignal);
  try {
    const { stdout } = await runGitWithInput(
      withFsmonitorNeutralized(["check-ignore", "--stdin", "-z"]),
      // check-ignore rejects the app-wide GIT_LITERAL_PATHSPECS=1 ("pathspec magic not supported").
      { cwd: workdir, extraEnv: { GIT_LITERAL_PATHSPECS: "0" }, signal: bound.signal },
      paths.join("\0") + "\0",
    );
    return new Set(stdout.split("\0").filter(Boolean));
  } catch (err) {
    // Exit 1 means "none of the paths are ignored", not a failure.
    if (err instanceof GitCommandError && err.exitCode === 1) return new Set();
    return null;
  } finally {
    bound.dispose();
  }
}

/**
 * Batched check-ignore that survives one bad name: with GIT_LITERAL_PATHSPECS=0 a name starting with ':'
 * (pathspec magic) or one behind a symlink makes the whole batch exit 128, so those are pre-dropped / retried
 * per path. Anything unverifiable counts as not ignored (fail open: never drop a real change).
 */
async function checkIgnoredRaw(workdir: string, paths: string[], parentSignal?: AbortSignal): Promise<IgnoreVerdicts> {
  const checkable = paths.filter((p) => !p.startsWith(":"));
  let complete = checkable.length === paths.length;
  if (checkable.length === 0) return { ignored: new Set(), complete };
  const batch = await runCheckIgnore(workdir, checkable, parentSignal);
  if (batch) return { ignored: batch, complete };
  complete = false;
  const ignored = new Set<string>();
  for (const p of checkable.slice(0, MAX_PER_PATH_RETRIES)) {
    if (parentSignal?.aborted) break;
    const one = await runCheckIgnore(workdir, [p], parentSignal);
    if (one) for (const x of one) ignored.add(x);
  }
  return { ignored, complete };
}

/**
 * Paths to drop: ignored ones, plus existing directories (git tracks files only; a directory event
 * is a timestamp bump from child changes, which carry their own events).
 */
async function checkIgnored(workdir: string, rels: string[], parentSignal?: AbortSignal): Promise<IgnoreVerdicts> {
  const isDir = await Promise.all(
    rels.map(async (rel) => {
      try {
        return (await fsp.lstat(path.join(workdir, rel))).isDirectory();
      } catch {
        return false; // deleted: the file form still matches parent-directory ignore rules
      }
    }),
  );
  const files = rels.filter((_, i) => !isDir[i]);
  const result =
    files.length > 0 ? await checkIgnoredRaw(workdir, files, parentSignal) : { ignored: new Set<string>(), complete: true };
  return { ignored: new Set(rels.filter((rel, i) => isDir[i] || result.ignored.has(rel))), complete: result.complete };
}

/** Test seam. */
export const _checkIgnoredForTests = checkIgnored;

/** Bounded breadth-first count, skipping `.git`; stops as soon as `limit` is passed. */
async function exceedsEntryBudget(workdir: string, limit: number, isClosed: () => boolean): Promise<boolean> {
  // Ignored trees (node_modules) are excluded from the walk's cost by the later ignore filter, but not
  // from the OS watch; the budget therefore counts them too, which is the honest memory/CPU driver.
  let count = 0;
  const queue = [workdir];
  while (queue.length > 0) {
    if (isClosed()) return false;
    const dir = queue.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name === ".git") continue;
      count++;
      if (count > limit) return true;
      if (e.isDirectory()) queue.push(path.join(dir, e.name));
    }
  }
  return false;
}
