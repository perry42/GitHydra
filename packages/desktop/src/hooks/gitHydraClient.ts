import type { GitHydraApi, IpcResult } from "../../shared/ipcContract";

/** Thin, mockable seam over `window.gitHydra` (exposed by preload.ts via contextBridge) — lets
 * component/hook tests inject a fake implementation instead of requiring a real Electron host. */
export function getGitHydraApi(): GitHydraApi {
  if (typeof window === "undefined" || !window.gitHydra) {
    throw new Error(
      "window.gitHydra is not available — this must run inside GitHydra's Electron preload " +
        "bridge (or a test must stub window.gitHydra before rendering).",
    );
  }
  return window.gitHydra;
}

export class GitHydraIpcError extends Error {
  constructor(public readonly errorName: string, message: string) {
    super(message);
    this.name = errorName;
  }
}

export function unwrap<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new GitHydraIpcError(result.error.name, result.error.message);
  return result.data;
}

/**
 * Matches the handful of git stderr shapes a transient Windows lock collision on `.git/index`
 * (or another git lock file) produces when several real `git` child processes touch the same
 * repo within milliseconds of each other — real, momentary file-lock contention, not a logic
 * bug, and it clears on its own almost immediately. Observed directly (2026-09, repeated runs of
 * `App.cherryPick.e2e.test.tsx`'s AC5/AC12) in two distinct shapes from two different call
 * classes:
 *  - a read racing a concurrent write's lock: `.git/index: index file open failed: Permission
 *    denied` (from a `git status` call).
 *  - a write racing another write's lock: `Unable to create '.../.git/index.lock': File exists.
 *    Another git process seems to be running in this repository...` (from a `git add` call, e.g.
 *    triggered by "Mark as resolved").
 * Deliberately narrow (not "retry on any failure") so a genuine, non-transient failure (a real
 * merge-marker error, a real permission problem, "not a git repository", etc.) is never delayed
 * or retried past — see `withGitLockRetry`/`withGitLockRetryThrowing`'s own doc comments for how
 * this is used.
 */
export function isTransientGitLockError(message: string): boolean {
  return /index file open failed|(?:index\.lock|\.lock)['"]?: File exists|Another git process seems to be running/i.test(
    message,
  );
}

/** How long to wait before the one retry `withGitLockRetry`/`withGitLockRetryThrowing` allow —
 * long enough in practice for a colliding concurrent `git` child process to have released the
 * lock (these are all quick, near-instantaneous status/add/checkout calls, never a slow
 * operation like a fetch), short enough not to be user-visibly sluggish for what's meant to be a
 * near-invisible resilience retry. */
const TRANSIENT_GIT_LOCK_RETRY_DELAY_MS = 150;

/**
 * Retries `fn` exactly once, after a short delay, if the first attempt's `IpcResult` failed with
 * a transient git lock collision (`isTransientGitLockError`) — any other failure (including a
 * second attempt's, whether transient-looking or not) is returned as-is, never swallowed a
 * second time. For callers working with a raw `IpcResult` rather than something already
 * `unwrap`-ed; see `withGitLockRetryThrowing` for the throwing-action equivalent.
 */
export async function withGitLockRetry<T>(fn: () => Promise<IpcResult<T>>): Promise<IpcResult<T>> {
  const result = await fn();
  if (result.ok || !isTransientGitLockError(result.error.message)) return result;
  await new Promise((resolve) => setTimeout(resolve, TRANSIENT_GIT_LOCK_RETRY_DELAY_MS));
  return fn();
}

/**
 * Same one-retry contract as `withGitLockRetry`, for a caller already working with a throwing
 * (`unwrap`-style) action instead of a raw `IpcResult` — e.g. a mutating action like
 * `markConflictResolved`/`acceptConflictSide`/`cherryPick`, which throw `GitHydraIpcError` on
 * failure.
 *
 * A security review of this fix pushed back on an earlier, broader version of this comment's
 * claim ("the underlying git process never got far enough to write anything") — that's only
 * exactly true for an action that's a *single* `git` invocation (`cherryPick()`,
 * `skipCherryPickCommit()`): if the one call collided on the lock, it wrote nothing, full stop.
 * `acceptConflictSide()` is two calls (`checkout` then `add`) and stays safe under a whole-action
 * retry only because re-running both with the same target content is idempotent — not because
 * the first write didn't happen. That distinction matters: it's why this helper is deliberately
 * NOT used for `commitEmptyCherryPick()` (see `useCherryPickActions.ts`'s `commitEmpty`, which
 * passes `retryOnLockCollision: false` to its shared `run()` call) — that function can issue a
 * SECOND, non-idempotent mutating call (`cherry-pick --continue`) after its first one already
 * succeeded, and replaying the whole thing from scratch on a collision in the second call would
 * hit its own precondition check and fail differently, stranding already-applied state instead of
 * cleanly retrying. Before wrapping a new mutating action with this helper, confirm it's actually
 * a single git invocation, or that a full retry is genuinely idempotent for it — not just assume
 * either.
 */
export async function withGitLockRetryThrowing<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!isTransientGitLockError(message)) throw err;
    await new Promise((resolve) => setTimeout(resolve, TRANSIENT_GIT_LOCK_RETRY_DELAY_MS));
    return fn();
  }
}
