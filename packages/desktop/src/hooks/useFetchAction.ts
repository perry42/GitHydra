// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useRef, useState } from "react";
import type { FetchProgressEvent, FetchRemoteOutcome } from "@githydra/git-core";
import type { GitHydraApi } from "../../shared/ipcContract";

export type FetchPhase = "idle" | "fetching" | "done";

export interface UseFetchActionOptions {
  api: GitHydraApi;
  /**
   * specs/online-sync-fetch.md FR-326: called once a `fetchAllRemotes` attempt genuinely settles
   * (succeeded or failed at the top level — never for a cancelled attempt, and independent of
   * whether any individual remote failed, FR-321's own per-remote attribution). The caller uses
   * this to refresh ahead/behind data (bump the Branches panel's reload token, refresh the graph's
   * refs) and to record a "last fetched at" timestamp — this hook itself has no opinion on what a
   * settle should trigger elsewhere in the app.
   */
  onSettled: () => void;
}

export interface UseFetchActionResult {
  phase: FetchPhase;
  /** `phase === "fetching"` — convenience for disabling toolbar controls / the command. */
  isFetching: boolean;
  /**
   * Bumped on every `runFetch()` call, regardless of outcome — the same `resetKey` convention
   * `graph.openSequence` already established for `useElapsedSeconds`, so `FetchStatusBanner`'s
   * elapsed-time clock restarts at 0 for a fresh attempt even if `phase` itself never left
   * `"fetching"` (a re-fetch while a previous one is still settling can't happen today — the
   * button/command are disabled while `isFetching` — but this stays correct if that ever changes).
   */
  fetchSequence: number;
  /**
   * specs/online-sync-fetch.md FR-322: the most recently received progress event for the
   * in-flight attempt — never buffered/queued, always just the latest line, matching the "design
   * for the stages that actually arrive" guidance (a percent/stage may be `null`, which is normal,
   * not an error). `null` before any event has arrived, and cleared at the start of every new
   * attempt.
   */
  latestProgress: FetchProgressEvent | null;
  /**
   * FR-321: every remote's own outcome from the most recently SETTLED attempt — `null` while
   * fetching, before the first fetch, or after `dismiss()`. Never collapses a per-remote failure
   * into `topLevelError` below.
   */
  outcomes: FetchRemoteOutcome[] | null;
  /**
   * A genuine top-level (transport-level, not per-remote) failure — e.g. no repository is
   * currently open. Distinct from an individual remote's own classified failure, which lives in
   * `outcomes` instead.
   */
  topLevelError: string | null;
  /** FR-327: triggers `fetchAllRemotes()` for the active repo. A no-op while already fetching. */
  runFetch: () => void;
  /** FR-322: cancels the in-flight attempt, if any — a safe no-op otherwise, mirroring
   * `graph.cancelOpen`'s own contract (`repo-open-feedback.md` FR-167/168/AC9). */
  cancelFetch: () => void;
  /** Clears a settled attempt's `outcomes`/`topLevelError`, returning to `"idle"` — dismisses the
   * status banner without affecting the actual fetched data (a fetch's effects are already
   * committed to disk/ref state the moment it settled; dismissing only hides this UI's own record
   * of the attempt). */
  dismiss: () => void;
}

let requestIdSeq = 0;

/**
 * specs/online-sync-fetch.md FR-322/FR-327: owns one `fetchAllRemotes` attempt's full lifecycle —
 * a fresh `requestId` per `runFetch()` call (the same generated-id/cancel-by-id convention
 * `useRepositoryGraph.ts`'s `openRepo`/`cancelOpen` already established), live progress via
 * `api.onFetchProgress` filtered to the currently-active `requestId` (so a stale/cancelled
 * attempt's trailing progress events are silently ignored, never misapplied to a newer one), and
 * the settled per-remote outcomes for display.
 */
export function useFetchAction({ api, onSettled }: UseFetchActionOptions): UseFetchActionResult {
  const [phase, setPhase] = useState<FetchPhase>("idle");
  const [fetchSequence, setFetchSequence] = useState(0);
  const [latestProgress, setLatestProgress] = useState<FetchProgressEvent | null>(null);
  const [outcomes, setOutcomes] = useState<FetchRemoteOutcome[] | null>(null);
  const [topLevelError, setTopLevelError] = useState<string | null>(null);
  const activeRequestIdRef = useRef<string | null>(null);

  useEffect(() => {
    return api.onFetchProgress((requestId, event) => {
      if (requestId !== activeRequestIdRef.current) return;
      setLatestProgress(event);
    });
  }, [api]);

  const runFetch = useCallback(() => {
    if (activeRequestIdRef.current) return; // already fetching — the button/command stay disabled too.
    const requestId = `fetch-${++requestIdSeq}`;
    activeRequestIdRef.current = requestId;
    setPhase("fetching");
    setFetchSequence((s) => s + 1);
    setLatestProgress(null);
    setOutcomes(null);
    setTopLevelError(null);

    void (async () => {
      try {
        const outcome = await api.fetchAllRemotes(requestId);
        if (activeRequestIdRef.current !== requestId) return; // superseded — shouldn't happen, but never overwrite a newer attempt's state.
        activeRequestIdRef.current = null;
        if (outcome.outcome === "cancelled") {
          setPhase("idle");
          return;
        }
        if (outcome.result.ok) {
          setOutcomes(outcome.result.data.outcomes);
        } else {
          setTopLevelError(outcome.result.error.message);
        }
        setPhase("done");
        onSettled();
      } catch (err) {
        if (activeRequestIdRef.current !== requestId) return;
        activeRequestIdRef.current = null;
        setTopLevelError(err instanceof Error ? err.message : String(err));
        setPhase("done");
      }
    })();
  }, [api, onSettled]);

  const cancelFetch = useCallback(() => {
    const requestId = activeRequestIdRef.current;
    if (!requestId) return;
    void api.cancelFetch(requestId);
  }, [api]);

  const dismiss = useCallback(() => {
    setPhase("idle");
    setOutcomes(null);
    setTopLevelError(null);
    setLatestProgress(null);
  }, []);

  return {
    phase,
    isFetching: phase === "fetching",
    fetchSequence,
    latestProgress,
    outcomes,
    topLevelError,
    runFetch,
    cancelFetch,
    dismiss,
  };
}
