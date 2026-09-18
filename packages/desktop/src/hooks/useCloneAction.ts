// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useRef, useState } from "react";
import { classifyGitNetworkError, type FetchProgressEvent } from "@githydra/git-core";
import type { GitHydraApi } from "../../shared/ipcContract";

export type ClonePhase = "idle" | "cloning" | "done";

export interface UseCloneActionOptions {
  api: GitHydraApi;
  /**
   * specs/online-sync-clone.md FR-356: called once a `clone()` attempt genuinely succeeds, with the
   * resolved absolute destination path. The caller (`App.tsx`) opens it as a new tab and adds it to
   * Recent Repositories via the app's existing `multi-repo-tabs.md`/`repo-list.md` open-tab flow
   * (`repoTabs.openRecentInNewTab`) — this hook has no opinion on either of those, mirroring
   * `useFetchAction`/`usePushAction`'s own "settle, don't own what happens next" contract. Never
   * called for a cancelled or failed attempt.
   */
  onCloned: (path: string) => void;
}

export interface UseCloneActionResult {
  phase: ClonePhase;
  /** `phase === "cloning"` — convenience for disabling the dialog's form controls. */
  isCloning: boolean;
  /** Bumped on every `runClone()` call, same `resetKey` convention `fetchSequence`/`pushSequence`
   * already establish, so `useElapsedSeconds` restarts at 0 for a fresh attempt. */
  cloneSequence: number;
  /** FR-354: the most recently received progress event for the in-flight attempt — identical
   * shape/semantics to `useFetchAction.latestProgress`/`usePushAction.latestProgress`. */
  latestProgress: FetchProgressEvent | null;
  /**
   * FR-353/FR-357: an already-actionable, already-classified message for a settled failure —
   * `classifyGitNetworkError()`'s own `message` when the underlying error carried real `stderr`
   * (every `GitCommandError`, including FR-353's "destination already exists" refusal — see that
   * function's `"unknown"` fallback, whose `rawStderr` still carries git's exact refusal text
   * verbatim for the `Details` disclosure), or the plain error message verbatim for anything else
   * (e.g. an `InvalidArgumentError` for an empty URL/destination, which never has `stderr`). `null`
   * while cloning, before the first attempt, or after `dismiss()`. Mirrors `usePushAction.error`
   * exactly.
   */
  error: string | null;
  /** FR-357: the classified error's raw (already credential-redacted) stderr, for a collapsible
   * "Details" disclosure — identical shape to `usePushAction.rawStderr`. `null` when there's none
   * to show. */
  rawStderr: string | null;
  /** FR-352: the one entry point a caller ever needs — clones `url` into `destination`. A no-op
   * while already cloning. */
  runClone: (url: string, destination: string) => void;
  /** FR-354: cancels the in-flight attempt, if any — a safe no-op otherwise, mirroring
   * `useFetchAction.cancelFetch`'s/`usePushAction.cancelPush`'s own contract. */
  cancelClone: () => void;
  /** Clears a settled attempt's `error`/`rawStderr`, returning to `"idle"` — dismisses the dialog's
   * inline error without affecting anything already on disk. */
  dismiss: () => void;
}

let requestIdSeq = 0;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * specs/online-sync-clone.md FR-351 through FR-357: owns one `clone()` attempt's full lifecycle,
 * mirroring `usePushAction`'s shape almost exactly (fresh `requestId` per attempt, live progress
 * filtered to the currently-active attempt, the identical cancel/dismiss contract, the identical
 * stderr-classification convention for FR-357's credential failures and FR-353's destination
 * refusal) — no parallel implementation of any of that, per FR-354. The one thing genuinely
 * different from `usePushAction`: `clone()` is never scoped to an already-open repository (it
 * creates a brand-new one at `destination`), so this hook has no `onMutationStart`/
 * `onMutationSettled` self-write-suppression gate to open/close — there is no existing session's
 * refs to protect from a refresh race.
 */
export function useCloneAction({ api, onCloned }: UseCloneActionOptions): UseCloneActionResult {
  const [phase, setPhase] = useState<ClonePhase>("idle");
  const [cloneSequence, setCloneSequence] = useState(0);
  const [latestProgress, setLatestProgress] = useState<FetchProgressEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rawStderr, setRawStderr] = useState<string | null>(null);
  const activeRequestIdRef = useRef<string | null>(null);

  useEffect(() => {
    return api.onCloneProgress((requestId, event) => {
      if (requestId !== activeRequestIdRef.current) return;
      setLatestProgress(event);
    });
  }, [api]);

  const runClone = useCallback(
    (url: string, destination: string) => {
      if (activeRequestIdRef.current) return; // already cloning — the form/Clone button stay disabled too.
      const requestId = `clone-${++requestIdSeq}`;
      activeRequestIdRef.current = requestId;
      setPhase("cloning");
      setCloneSequence((s) => s + 1);
      setLatestProgress(null);
      setError(null);
      setRawStderr(null);

      void (async () => {
        try {
          const attempt = await api.clone(requestId, url, destination);
          if (activeRequestIdRef.current !== requestId) return; // superseded — never overwrite a newer attempt's state.
          activeRequestIdRef.current = null;

          if (attempt.outcome === "cancelled") {
            setPhase("idle");
            return;
          }
          if (attempt.result.ok) {
            setPhase("idle");
            onCloned(attempt.result.data.path);
            return;
          }

          // FR-353/FR-357: classify against the exact stderr text (never the "git <args> exited
          // with code N:"-prefixed `message`) when it's available — mirrors `usePushAction`'s
          // identical branch exactly.
          const ipcError = attempt.result.error;
          if (ipcError.stderr) {
            const classified = classifyGitNetworkError(ipcError.stderr);
            setError(classified.message);
            setRawStderr(classified.rawStderr);
          } else {
            setError(ipcError.message);
          }
          setPhase("done");
        } catch (err) {
          if (activeRequestIdRef.current !== requestId) return;
          activeRequestIdRef.current = null;
          setError(messageOf(err));
          setPhase("done");
        }
      })();
    },
    [api, onCloned],
  );

  const cancelClone = useCallback(() => {
    const requestId = activeRequestIdRef.current;
    if (!requestId) return;
    void api.cancelClone(requestId);
  }, [api]);

  const dismiss = useCallback(() => {
    setPhase("idle");
    setError(null);
    setRawStderr(null);
    setLatestProgress(null);
  }, []);

  return {
    phase,
    isCloning: phase === "cloning",
    cloneSequence,
    latestProgress,
    error,
    rawStderr,
    runClone,
    cancelClone,
    dismiss,
  };
}
