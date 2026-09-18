// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useRef, useState } from "react";
import { classifyGitNetworkError, type FetchProgressEvent, type PushOutcome } from "@githydra/git-core";
import type { GitHydraApi } from "../../shared/ipcContract";

export type PushPhase = "idle" | "pushing" | "done";

/** specs/online-sync-push.md FR-347: the pre-attempt "you're behind" warning's own pending state —
 * only ever set when `requestPush` is called with a positive `behind` count, mirroring
 * `useResetActions.ts`'s `pendingHardConfirm` two-tier-confirm shape. */
export interface PendingBehindPushConfirm {
  remoteName: string;
  localBranchName: string;
  behind: number;
}

export interface UsePushActionOptions {
  api: GitHydraApi;
  /**
   * Called once a `push()` attempt genuinely settles into a real success (either `PushOutcome`
   * kind) — never for a cancelled attempt or a genuine refusal (including the non-fast-forward
   * case), matching `useFetchAction`/`usePullAction`'s own `onSettled` contract. The caller uses
   * this to refresh refs/rows and branch ahead/behind data.
   */
  onSettled: () => void;
  /** specs/self-write-refresh-suppression.md FR-6b: opened before the one `api.push()` call this
   * hook ever makes — a successful push moves the local remote-tracking ref (and, for a
   * `--set-upstream` publish, writes `branch.<name>.remote`/`.merge`) exactly like Pull's own fetch
   * phase does, so this uses the identical gate `usePullAction` already opens for its own call. */
  onMutationStart?: () => void;
  /** Closes the gate `onMutationStart` opened, for every path that ISN'T followed by `onSettled`'s
   * own gate-closing refresh: a cancelled attempt, or a genuine (including non-fast-forward)
   * refusal. */
  onMutationSettled?: () => void;
}

export interface UsePushActionResult {
  phase: PushPhase;
  /** `phase === "pushing"` — convenience for disabling toolbar controls/the command. */
  isPushing: boolean;
  /** Bumped on every real push attempt (never on a confirm-pending pause alone), same `resetKey`
   * convention `fetchSequence`/`pullSequence` already established. */
  pushSequence: number;
  /** FR-348: the most recently received progress event for the in-flight attempt — mirrors
   * `useFetchAction.latestProgress`/`usePullAction.latestProgress` exactly. */
  latestProgress: FetchProgressEvent | null;
  /** The most recently SETTLED attempt's real outcome — `null` while pushing, before the first
   * push, after a confirm-pending pause, or after `dismiss()`. */
  outcome: PushOutcome | null;
  /**
   * FR-346: an already-actionable, already-classified message for a settled failure —
   * `classifyGitNetworkError()`'s own `message` when the underlying error carried real `stderr`
   * (every network-transport failure, including a non-fast-forward rejection), or the plain error
   * message verbatim for anything else (e.g. an `InvalidArgumentError`, which never has `stderr`).
   * `null` while pushing, before the first push, or after `dismiss()`.
   */
  error: string | null;
  /**
   * FR-346: true exactly when `error` above came from a non-fast-forward rejection — the caller
   * (`PushStatusBanner`) uses this to show the exact "the remote has commits you don't have; pull
   * first" wording and point at the Pull action, NEVER a retry-with-force escalation of any kind
   * (a hard non-goal, not a design choice — specs/online-sync-push.md's Non-goals).
   */
  isNonFastForwardRejection: boolean;
  /** FR-348: the classified error's raw (already credential-redacted) stderr, for a collapsible
   * "Details" disclosure — the identical shape `FetchStatusBanner`'s own `outcome.error.rawStderr`
   * already uses. `null` when there's no raw stderr to show (e.g. a non-`GitCommandError`
   * failure). */
  rawStderr: string | null;
  /** FR-347: non-null exactly when `requestPush` was called with a positive `behind` count — the
   * caller renders a `ConfirmDialog` restating it (non-destructive: git would simply reject the
   * push, nothing local is ever discarded) before `confirmPendingPush`/`cancelPendingPush` decide
   * what happens next. */
  pendingBehindConfirm: PendingBehindPushConfirm | null;
  /**
   * FR-345/FR-347: the one entry point a caller ever needs. `behind` should be the current
   * branch's own `behind` count against `remoteName` SPECIFICALLY — the caller passes `null`
   * unless `remoteName` is the branch's actually-tracked remote, since ahead/behind data is only
   * meaningful for that one remote. Opens `pendingBehindConfirm` (rather than pushing immediately)
   * when `behind` is a positive number; pushes right away otherwise. A no-op while already
   * pushing.
   */
  requestPush: (remoteName: string, localBranchName: string, behind: number | null) => void;
  /** FR-347: proceeds with the pending push — only meaningful once `pendingBehindConfirm` is set. */
  confirmPendingPush: () => void;
  /** FR-347: cancels the pending push — makes no `push()` call, HEAD/refs are left exactly as they
   * were. */
  cancelPendingPush: () => void;
  /** Cancels the in-flight attempt, if any — a safe no-op otherwise, mirroring
   * `useFetchAction.cancelFetch`'s/`usePullAction.cancelPull`'s own contract. */
  cancelPush: () => void;
  /** Clears a settled attempt's `outcome`/`error`, returning to `"idle"` — dismisses the status
   * banner without affecting the actual pushed data. */
  dismiss: () => void;
}

let requestIdSeq = 0;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * specs/online-sync-push.md FR-344 through FR-348: owns one `push()` attempt's full lifecycle,
 * mirroring `usePullAction`'s shape almost exactly (fresh `requestId` per attempt, live progress
 * filtered to the currently-active attempt, the identical cancel/dismiss contract) — the one thing
 * genuinely new here is FR-347's pre-attempt "behind" confirmation and FR-346's non-fast-forward
 * classification, both handled entirely client-side (git-core's own `push()` deliberately does
 * neither — see its doc comment).
 *
 * This hook's own surface never accepts anything force/delete/tags/all/mirror-shaped: `requestPush`
 * takes exactly a remote name, a local branch name, and a `behind` count — nothing else is ever
 * threaded through to `api.push()` (see `noForcePush.test.ts`'s black-box proof).
 */
export function usePushAction({
  api,
  onSettled,
  onMutationStart,
  onMutationSettled,
}: UsePushActionOptions): UsePushActionResult {
  const [phase, setPhase] = useState<PushPhase>("idle");
  const [pushSequence, setPushSequence] = useState(0);
  const [latestProgress, setLatestProgress] = useState<FetchProgressEvent | null>(null);
  const [outcome, setOutcome] = useState<PushOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isNonFastForwardRejection, setIsNonFastForwardRejection] = useState(false);
  const [rawStderr, setRawStderr] = useState<string | null>(null);
  const [pendingBehindConfirm, setPendingBehindConfirm] = useState<PendingBehindPushConfirm | null>(null);
  const activeRequestIdRef = useRef<string | null>(null);

  useEffect(() => {
    return api.onPushProgress((requestId, event) => {
      if (requestId !== activeRequestIdRef.current) return;
      setLatestProgress(event);
    });
  }, [api]);

  const executePush = useCallback(
    (remoteName: string, localBranchName: string) => {
      if (activeRequestIdRef.current) return; // already pushing — the button/command stay disabled too.
      const requestId = `push-${++requestIdSeq}`;
      activeRequestIdRef.current = requestId;
      setPhase("pushing");
      setPushSequence((s) => s + 1);
      setLatestProgress(null);
      setOutcome(null);
      setError(null);
      setIsNonFastForwardRejection(false);
      setRawStderr(null);
      onMutationStart?.();

      void (async () => {
        try {
          const attempt = await api.push(requestId, remoteName, localBranchName);
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

          // FR-346: classify against the exact stderr text (never the "git <args> exited with
          // code N:"-prefixed `message`) when it's available — only a real `GitCommandError`
          // carries one (see `IpcError.stderr`'s own doc comment); anything else (e.g. an
          // `InvalidArgumentError`) shows its own already-actionable `message` verbatim.
          const ipcError = attempt.result.error;
          if (ipcError.stderr) {
            const classified = classifyGitNetworkError(ipcError.stderr);
            setError(classified.message);
            setIsNonFastForwardRejection(classified.kind === "push-rejected-non-fast-forward");
            setRawStderr(classified.rawStderr);
          } else {
            setError(ipcError.message);
          }
          setPhase("done");
          onMutationSettled?.();
        } catch (err) {
          if (activeRequestIdRef.current !== requestId) return;
          activeRequestIdRef.current = null;
          setError(messageOf(err));
          setPhase("done");
          onMutationSettled?.();
        }
      })();
    },
    [api, onSettled, onMutationStart, onMutationSettled],
  );

  const requestPush = useCallback(
    (remoteName: string, localBranchName: string, behind: number | null) => {
      if (activeRequestIdRef.current) return; // already pushing.
      if (behind !== null && behind > 0) {
        setPendingBehindConfirm({ remoteName, localBranchName, behind });
        return;
      }
      executePush(remoteName, localBranchName);
    },
    [executePush],
  );

  const confirmPendingPush = useCallback(() => {
    const pending = pendingBehindConfirm;
    if (!pending) return;
    setPendingBehindConfirm(null);
    executePush(pending.remoteName, pending.localBranchName);
  }, [pendingBehindConfirm, executePush]);

  const cancelPendingPush = useCallback(() => setPendingBehindConfirm(null), []);

  const cancelPush = useCallback(() => {
    const requestId = activeRequestIdRef.current;
    if (!requestId) return;
    void api.cancelPush(requestId);
  }, [api]);

  const dismiss = useCallback(() => {
    setPhase("idle");
    setOutcome(null);
    setError(null);
    setIsNonFastForwardRejection(false);
    setRawStderr(null);
    setLatestProgress(null);
  }, []);

  return {
    phase,
    isPushing: phase === "pushing",
    pushSequence,
    latestProgress,
    outcome,
    error,
    isNonFastForwardRejection,
    rawStderr,
    pendingBehindConfirm,
    requestPush,
    confirmPendingPush,
    cancelPendingPush,
    cancelPush,
    dismiss,
  };
}
