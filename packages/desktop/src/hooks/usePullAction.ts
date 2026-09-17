// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useRef, useState } from "react";
import type { FetchProgressEvent, PullOutcome, PullStrategy } from "@githydra/git-core";
import type { GitHydraApi } from "../../shared/ipcContract";
import { unwrap } from "./gitHydraClient";

export type PullPhase = "idle" | "pulling" | "done";

/** FR-339's per-pull override control: `"auto"` (the default — no override, git-core resolves the
 * repo's own `branch.<name>.rebase`/`pull.rebase` config exactly as real `git pull` would) plus the
 * two real strategies a user can explicitly force for that one pull. */
export type PullStrategyChoice = "auto" | PullStrategy;

export interface UsePullActionOptions {
  api: GitHydraApi;
  /**
   * Called once a `pull()` attempt genuinely settles into either a real success (any of the three
   * `PullOutcome` kinds) or a paused merge/rebase conflict (FR-338: routed into the identical
   * existing conflict flow, not a distinct pause state this hook tracks itself) — never for a
   * cancelled attempt or a genuine refusal, matching `useFetchAction`'s own `onSettled` contract.
   * The caller uses this to refresh refs/rows (a pull can move the current branch, create commits,
   * or move `HEAD` into a paused operation) — this hook has no opinion on what a settle should
   * trigger elsewhere in the app.
   */
  onSettled: () => void;
  /** specs/self-write-refresh-suppression.md FR-6b: opened before the one `api.pull()` call this
   * hook ever makes — a pull can move the current branch/HEAD exactly like the drag-menu's own
   * Merge/Rebase actions (`useDragCommitActions.ts`), which already use this same gate, unlike
   * `useFetchAction` (whose own fetch-only mutation never moves a local ref this app treats as
   * "self-caused," so it carries no such gate at all). */
  onMutationStart?: () => void;
  /** Closes the gate `onMutationStart` opened, for every path that ISN'T followed by `onSettled`'s
   * own gate-closing refresh: a cancelled attempt, or a genuine (non-pause) refusal. */
  onMutationSettled?: () => void;
}

export interface UsePullActionResult {
  phase: PullPhase;
  /** `phase === "pulling"` — convenience for disabling the Toolbar button/command. */
  isPulling: boolean;
  /** Bumped on every `runPull()` call, regardless of outcome — same `resetKey` convention
   * `fetchSequence` already established, so `useElapsedSeconds` restarts cleanly for a fresh
   * attempt. */
  pullSequence: number;
  /** FR-339: the most recently received progress event for the in-flight attempt's fetch phase —
   * `null` before any event has arrived, and cleared at the start of every new attempt. Mirrors
   * `useFetchAction.latestProgress` exactly (pull's own only cancellable/progress-reporting phase
   * IS a `fetchRemote()` call). */
  latestProgress: FetchProgressEvent | null;
  /** The most recently SETTLED attempt's real outcome — `null` while pulling, before the first
   * pull, after a conflict pause (routed elsewhere, not tracked as an "outcome" here — matching
   * `PullOutcome`'s own type, which likewise has no "paused" member), or after `dismiss()`. */
  outcome: PullOutcome | null;
  /** A genuine (non-conflict-pause) failure, verbatim — e.g. `NoUpstreamConfiguredError`, or a
   * transport-level fetch failure. */
  error: string | null;
  /** FR-339's per-pull strategy override — defaults to `"auto"` (no override, no config write),
   * matching this feature's "never force a choice the user didn't ask to make" requirement. */
  strategy: PullStrategyChoice;
  setStrategy: (strategy: PullStrategyChoice) => void;
  /** Triggers `pull()` for the active repo's current branch, using the currently-selected
   * `strategy`. A no-op while already pulling. */
  runPull: () => void;
  /** Cancels the in-flight attempt's fetch phase, if any — a safe no-op otherwise. Once the fetch
   * phase has completed, the local fast-forward/merge/rebase step that follows is not itself
   * cancellable (matching git-core's own `PullOptions.signal` doc comment). */
  cancelPull: () => void;
  /** Clears a settled attempt's `outcome`/`error`, returning to `"idle"` — dismisses the status
   * banner without affecting the actual pulled data. */
  dismiss: () => void;
}

let requestIdSeq = 0;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * specs/online-sync-pull.md FR-338/FR-339/FR-342: owns one `pull()` attempt's full lifecycle —
 * fresh `requestId` per attempt (`useFetchAction`'s own convention), live fetch-phase progress
 * filtered to the currently-active attempt, and — the one thing genuinely new relative to
 * `useFetchAction` — telling a paused merge/rebase conflict apart from a genuine refusal by
 * re-reading fresh `RepositoryState` afterward, the EXACT same technique
 * `useDragCommitActions.runMutation`/`useCherryPickActions` already use for `mergeCommit()`/
 * `rebaseCommitOnto()`/`cherryPick()`. This is what makes FR-338's "zero new conflict-handling
 * code" guarantee hold at the UI layer too: a pull-triggered pause is discovered, and routed into
 * `StatusBanner`/`ChangesPanel`'s `ConflictResolutionView`, by the exact same
 * re-read-state-after-rejection pattern every other conflict-capable mutation in this app already
 * uses — never a new conflict-detection code path.
 */
export function usePullAction({
  api,
  onSettled,
  onMutationStart,
  onMutationSettled,
}: UsePullActionOptions): UsePullActionResult {
  const [phase, setPhase] = useState<PullPhase>("idle");
  const [pullSequence, setPullSequence] = useState(0);
  const [latestProgress, setLatestProgress] = useState<FetchProgressEvent | null>(null);
  const [outcome, setOutcome] = useState<PullOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [strategy, setStrategy] = useState<PullStrategyChoice>("auto");
  const activeRequestIdRef = useRef<string | null>(null);

  useEffect(() => {
    return api.onPullProgress((requestId, event) => {
      if (requestId !== activeRequestIdRef.current) return;
      setLatestProgress(event);
    });
  }, [api]);

  const runPull = useCallback(() => {
    if (activeRequestIdRef.current) return; // already pulling — the button/command stay disabled too.
    const requestId = `pull-${++requestIdSeq}`;
    activeRequestIdRef.current = requestId;
    setPhase("pulling");
    setPullSequence((s) => s + 1);
    setLatestProgress(null);
    setOutcome(null);
    setError(null);
    onMutationStart?.();

    void (async () => {
      try {
        const attempt = await api.pull(requestId, strategy === "auto" ? {} : { strategy });
        if (activeRequestIdRef.current !== requestId) return; // superseded — never overwrite a newer attempt's state.
        activeRequestIdRef.current = null;

        if (attempt.outcome === "cancelled") {
          setPhase("idle");
          onMutationSettled?.();
          return;
        }
        if (attempt.result.ok) {
          setOutcome(attempt.result.data);
          setPhase("done");
          onSettled();
          return;
        }

        // FR-338: a paused merge/rebase conflict rejects exactly like a genuine failure — tell the
        // two apart by re-reading fresh state, same as `useDragCommitActions`/`useCherryPickActions`.
        let isExpectedPause = false;
        try {
          const state = unwrap(await api.getState());
          isExpectedPause = state.inProgressOperation === "merge" || state.inProgressOperation === "rebase";
        } catch {
          // Repo state became unreadable — fall through and surface the original error below.
        }
        if (isExpectedPause) {
          setPhase("idle");
          onSettled(); // StatusBanner/ChangesPanel's ConflictResolutionView pick this up from fresh state.
        } else {
          setError(attempt.result.error.message);
          setPhase("done");
          onMutationSettled?.();
        }
      } catch (err) {
        if (activeRequestIdRef.current !== requestId) return;
        activeRequestIdRef.current = null;
        setError(messageOf(err));
        setPhase("done");
        onMutationSettled?.();
      }
    })();
  }, [api, strategy, onSettled, onMutationStart, onMutationSettled]);

  const cancelPull = useCallback(() => {
    const requestId = activeRequestIdRef.current;
    if (!requestId) return;
    void api.cancelPull(requestId);
  }, [api]);

  const dismiss = useCallback(() => {
    setPhase("idle");
    setOutcome(null);
    setError(null);
    setLatestProgress(null);
  }, []);

  return {
    phase,
    isPulling: phase === "pulling",
    pullSequence,
    latestProgress,
    outcome,
    error,
    strategy,
    setStrategy,
    runPull,
    cancelPull,
    dismiss,
  };
}
