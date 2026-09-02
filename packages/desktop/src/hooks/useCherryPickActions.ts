import { useCallback, useState } from "react";
import type { GitHydraApi } from "../../shared/ipcContract";
import { unwrap, withGitLockRetryThrowing } from "./gitHydraClient";

export interface UseCherryPickActionsOptions {
  api: GitHydraApi;
  /**
   * specs/cherry-pick.md FR-121: called after every settled attempt that actually left the
   * repository changed — a clean cherry-pick, a paused one (a real conflict, or the FR-105/FR-118
   * empty-result case), a successful Skip, or a successful Commit-empty — so the caller can run
   * the same full refresh contract (commit graph, ChangesPanel, Toolbar badges, operation banner)
   * `StatusBanner`'s Abort/Continue already use for this same family of operations. Never called
   * for a genuine refusal that made no git call / left nothing to refresh (FR-120's inline
   * `error` covers that case instead).
   */
  onSettled: () => void;
  /**
   * specs/self-write-refresh-suppression.md FR-6b: called synchronously right before issuing
   * `cherryPick`/`skipCherryPickCommit`/`commitEmptyCherryPick` — the same pattern
   * `useBranchActions`/`useStashActions` already use around their own mutating calls — so
   * `useRepositoryGraph`'s self-write gate is already open before that call's disk write can trip
   * the fs watcher. Without this, a multi-commit cherry-pick that pauses on a real conflict races
   * the watcher: resolving the conflict can misfire a spurious "changed outside GitHydra" alert
   * that then blocks further conflict-resolution actions until a manual Refresh. Optional only so
   * existing/other test harnesses constructing this hook without wiring the full graph don't need
   * to pass a no-op.
   */
  onMutationStart?: () => void;
  /**
   * specs/self-write-refresh-suppression.md FR-6b: called when a mutating call genuinely fails
   * (not the expected-pause case, which already closes the gate via `onSettled`'s own refresh) —
   * `onSettled` is deliberately not called then (nothing succeeded to refresh), but the gate
   * `onMutationStart` opened still needs a confirming read to close it, exactly like
   * `useBranchActions`/`useStashActions`'s own `onMutationSettled`.
   */
  onMutationSettled?: () => void;
}

export interface UseCherryPickActionsResult {
  /** FR-113/FR-114: start a cherry-pick for the given SHAs — already sorted into graph order by
   * the caller (this hook trusts the order it's given; see `lib/cherryPickOrder.ts`). */
  cherryPick: (shas: readonly string[]) => void;
  /** True while a cherry-pick/skip/commit-empty call from this hook is in flight — callers use
   * this to disable the relevant context-menu items / empty-result notice buttons without a
   * global spinner. */
  busy: boolean;
  /** FR-106/FR-118: resolve the empty-result pause by skipping the paused commit. */
  skip: () => void;
  /** FR-106/FR-118: resolve the empty-result pause by committing an empty commit. */
  commitEmpty: () => void;
  /** FR-120: the most recent genuine (non-pause) failure's message, verbatim. */
  error: string | null;
  dismissError: () => void;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Owns every cherry-pick-mutating action the UI can trigger (the graph's context menu, and the
 * FR-118 empty-result notice's Skip/Commit-empty buttons).
 *
 * FR-104's "never distinguished in the return value" convention means `api.cherryPick()` (and, for
 * the same reason — see `cherryPick.ts`'s `commitEmptyCherryPick()` doc comment — `skip`/
 * `commitEmpty` too, when advancing the sequencer runs into a further conflict) REJECTS on both a
 * genuine failure and an expected pause (a real conflict, or the FR-105 empty-result case) — the
 * two are indistinguishable from the rejection alone. This hook tells them apart the only reliable
 * way available (mirroring `evaluateWatcherEvent`'s own "always a fresh disk read" discipline,
 * never a synthesized/remembered outcome): after a rejection, it re-reads `RepositoryState`
 * directly and checks whether a cherry-pick is now genuinely in progress.
 *  - If so, the rejection was an expected pause — `onSettled()` still runs (so the operation
 *    banner / `ConflictResolutionView` / the FR-118 empty-result notice can pick it up from fresh
 *    disk state), but `error` is NOT set: those surfaces already cover it (FR-117/FR-118), and a
 *    second, redundant inline error would just be a confusing double signal.
 *  - Otherwise it's a genuine failure (FR-120): surfaced verbatim via `error`; `onSettled()` is
 *    not called (nothing succeeded to refresh).
 */
export function useCherryPickActions({
  api,
  onSettled,
  onMutationStart,
  onMutationSettled,
}: UseCherryPickActionsOptions): UseCherryPickActionsResult {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    // `retryOnLockCollision` defaults on (see `cherryPick`/`skip` below): each issues exactly one
    // `git` mutation, so a transient-lock failure means nothing was written and retrying the whole
    // `call` once is safe (`withGitLockRetryThrowing`'s doc comment in `gitHydraClient.ts`). A
    // security review of this fix found `commitEmpty` doesn't share that property —
    // `commitEmptyCherryPick()` (git-core/src/cherryPick.ts) is a `commit --allow-empty` that,
    // when more commits are queued, itself issues a SECOND mutating `cherry-pick --continue`
    // afterward. If that second call is what collides, the first has already succeeded and
    // cleared `CHERRY_PICK_HEAD` — replaying the whole function from scratch would fail its own
    // `assertPausedOnEmptyResult` precondition (`CherryPickNotAtEmptyResultError`) instead of
    // resuming the `--continue`, silently stranding the remaining queued commits with no
    // in-progress-operation signal left anywhere. `commitEmpty` below passes `false` to opt out of
    // this call-level retry entirely rather than risk that — a properly-scoped fix (retrying just
    // the internal `--continue`, or re-deriving from sequencer state) belongs in git-core, not here.
    (call: () => Promise<unknown>, retryOnLockCollision: boolean = true) => {
      setBusy(true);
      setError(null);
      // FR-6b: open the self-write gate before the mutating call, not after — the disk write (and
      // therefore the fs watcher's earliest possible fire) happens during `call()`, not once its
      // promise resolves. Runs synchronously (no `await` before it), matching `useBranchActions`.
      onMutationStart?.();
      void (async () => {
        try {
          await (retryOnLockCollision ? withGitLockRetryThrowing(call) : call());
          onSettled();
        } catch (err) {
          let isExpectedPause = false;
          try {
            const state = unwrap(await api.getState());
            isExpectedPause = state.inProgressOperation === "cherry-pick";
          } catch {
            // Repo state became unreadable — fall through and surface the original error below.
          }
          if (isExpectedPause) {
            onSettled();
          } else {
            setError(messageOf(err));
            onMutationSettled?.(); // FR-6b: still close the gate `onMutationStart` opened above.
          }
        } finally {
          setBusy(false);
        }
      })();
    },
    [api, onSettled, onMutationStart, onMutationSettled],
  );

  const cherryPick = useCallback(
    (shas: readonly string[]) => {
      run(async () => {
        unwrap(await api.cherryPick(shas));
      });
    },
    [api, run],
  );

  const skip = useCallback(() => {
    run(async () => {
      unwrap(await api.skipCherryPickCommit());
    });
  }, [api, run]);

  const commitEmpty = useCallback(() => {
    run(async () => {
      unwrap(await api.commitEmptyCherryPick());
    }, false);
  }, [api, run]);

  return {
    cherryPick,
    busy,
    skip,
    commitEmpty,
    error,
    dismissError: () => setError(null),
  };
}
