// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { InProgressOperation, RepositoryState } from "@githydra/git-core";
import type { GitHydraApi, WorkingDirectoryStatus } from "../../../shared/ipcContract";
import type { OperationStateAlert } from "../../hooks/useRepositoryGraph";
import { useConflictProgress } from "../../hooks/useConflictProgress";
import { unwrap } from "../../hooks/gitHydraClient";
import { describeInProgressOperation, describeOperationStateAlert } from "../../lib/operationBanner";
import { ConfirmDialog } from "../ConfirmDialog/ConfirmDialog";
import "./StatusBanner.css";

export interface StatusBannerProps {
  repoState: RepositoryState;
  hasExternalChanges: boolean;
  onRefresh: () => void;
  /**
   * specs/refresh-without-teardown.md: true while the manual refresh `onRefresh` triggers is
   * in-flight — disables both of this banner's own Refresh buttons (the operation-state-alert one
   * and the ordinary "History changed outside GitHydra" one) and marks them `aria-busy` for the
   * duration, so a slow refresh doesn't invite a pile of overlapping clicks. Optional/defaults to
   * `false` so existing callers/tests that don't pass it keep working unchanged.
   */
  isRefreshing?: boolean;
  /**
   * specs/graph-head-indicator-and-refresh-alerting.md Problem 2: non-null while an
   * externally-detected in-progress-operation change is unacknowledged. Renders a distinct,
   * same-or-higher-prominence banner (from the ordinary `hasExternalChanges` one) naming the
   * operation, and disables Continue/Abort below until the user clicks its own Refresh button.
   */
  operationStateAlert?: OperationStateAlert | null;
  /** specs/merge-rebase-conflict-resolution.md FR-68/69/70/71: the same `window.gitHydra` bridge
   * instance the rest of the app shares, used for Abort/Continue. Optional so every existing
   * `StatusBanner` caller (and every existing unit test) keeps working unchanged when there's
   * genuinely nothing mid-operation to abort/continue. */
  api?: GitHydraApi;
  /** FR-67/FR-71: live conflict count, used to gate Continue and drive the "N of M resolved"
   * progress readout — never a separately-tracked resolved flag. */
  workingDirStatus?: WorkingDirectoryStatus | null;
  /** FR-68/70: called after a successful abort or continue so the caller can refresh everything
   * (repo state, refs, working-directory status, the commit graph — abort/continue can move
   * HEAD and clear the conflict set entirely). */
  onOperationChanged?: () => void;
  /**
   * specs/self-write-refresh-suppression.md FR-6b: called synchronously right before issuing
   * `continueInProgressOperation`/`abortInProgressOperation` — the same pattern every other
   * mutating hook (`useBranchActions`/`useCherryPickActions`/`useStashActions`) already uses
   * around their own mutating calls — so `useRepositoryGraph`'s self-write gate is already open
   * before that call's disk write can trip the fs watcher. Optional only so existing test
   * harnesses don't need to pass a no-op.
   */
  onMutationStart?: () => void;
  /**
   * specs/self-write-refresh-suppression.md FR-6b: called when Continue/Abort genuinely fails —
   * `onOperationChanged` is deliberately not called then (nothing succeeded to refresh), but the
   * gate `onMutationStart` opened still needs a confirming read to close it, exactly like every
   * other mutating hook's own `onMutationSettled`.
   */
  onMutationSettled?: () => void;
}

const OPERATION_LABEL: Record<Exclude<InProgressOperation, null>, string> = {
  merge: "Merge in progress",
  rebase: "Rebase in progress",
  am: "Applying patches (am) in progress",
  "cherry-pick": "Cherry-pick in progress",
  revert: "Revert in progress",
  bisect: "Bisect in progress",
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * FR-5/FR-60/FR-73: the graph must label an in-progress operation rather than silently rendering
 * HEAD as if nothing were happening — extended by specs/merge-rebase-conflict-resolution.md with
 * FR-58's rich per-operation-type copy (falling back to the generic label when no detail is
 * available yet), FR-67's live "N of M conflicts resolved" readout, and FR-68/69/70/71's
 * Abort/Continue controls. Also surfaces detached HEAD / bare / shallow context (edge cases) and
 * the FR-6 "history changed externally" manual-refresh prompt. Persistent and non-dismissible —
 * the operation banner disappears only when `repoState.inProgressOperation` itself clears (a
 * fresh read from disk), never a client-side dismiss.
 */
export function StatusBanner({
  repoState,
  hasExternalChanges,
  onRefresh,
  api,
  workingDirStatus,
  onOperationChanged,
  onMutationStart,
  onMutationSettled,
  operationStateAlert = null,
  isRefreshing = false,
}: StatusBannerProps) {
  const [pendingAbort, setPendingAbort] = useState(false);
  const [isAborting, setIsAborting] = useState(false);
  const [isContinuing, setIsContinuing] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);

  const conflictedCount = workingDirStatus?.conflicted ?? 0;
  const operationActive = repoState.inProgressOperation !== null;
  // Gated on `operationActive` alone (not also `conflictedCount > 0`) so the ceiling captured
  // once conflicts first appear survives down to "M of M resolved" as the last one is cleared —
  // resetting on `conflictedCount` hitting zero would erase the readout right at the moment it's
  // most useful (confirming everything really is resolved, just before Continue).
  const progress = useConflictProgress(conflictedCount, operationActive);
  // specs/graph-head-indicator-and-refresh-alerting.md Problem 2 AC4: Continue/Abort are blocked
  // for the entire lifetime of an unacknowledged operation-state alert, regardless of the
  // conflicted-file count — the danger being guarded against is acting on a repo-state snapshot
  // this window knows is already stale, which `canContinue`'s own conflict-count check can't see.
  const blockedByOperationAlert = operationStateAlert !== null;

  // Defense in depth: if an operation-state alert arrives while the Abort confirmation is already
  // open (a narrow race — the watcher fired between opening the dialog and clicking Confirm),
  // close it rather than leaving a confirm button whose click would now silently no-op against
  // `runAbort`'s own `blockedByOperationAlert` guard.
  useEffect(() => {
    if (blockedByOperationAlert) setPendingAbort(false);
  }, [blockedByOperationAlert]);

  const runAbort = useCallback(() => {
    if (!api || blockedByOperationAlert) return;
    setIsAborting(true);
    setOperationError(null);
    // FR-6b: open the self-write gate before the mutating call, not after — the disk write (and
    // therefore the fs watcher's earliest possible fire) happens during
    // `api.abortInProgressOperation()`, not once its promise resolves. Runs synchronously (no
    // `await` before it), matching `useBranchActions`/`useCherryPickActions`/`useStashActions`.
    onMutationStart?.();
    void (async () => {
      try {
        unwrap(await api.abortInProgressOperation());
        setPendingAbort(false);
        onOperationChanged?.(); // FR-6b: gate closes via onOperationChanged's own refresh call.
      } catch (err) {
        setOperationError(errorMessage(err));
        onMutationSettled?.(); // FR-6b: still close the gate `onMutationStart` opened above.
      } finally {
        setIsAborting(false);
      }
    })();
  }, [api, blockedByOperationAlert, onOperationChanged, onMutationStart, onMutationSettled]);

  const runContinue = useCallback(() => {
    if (!api || blockedByOperationAlert) return;
    setIsContinuing(true);
    setOperationError(null);
    // FR-6b: open the self-write gate before the mutating call, not after — see `runAbort`'s
    // comment above.
    onMutationStart?.();
    void (async () => {
      try {
        unwrap(await api.continueInProgressOperation());
        // specs/graph-head-indicator-and-refresh-alerting.md Problem 1 (not built on this
        // branch): this is the identified seam a future auto-select-and-scroll-to-new-HEAD fix
        // hooks into once merged — Continue's success path here is the one place that both knows
        // the operation just succeeded and already triggers a full refresh, so adding
        // `selectCommit(newHeadSha)` alongside `onOperationChanged?.()` will be a local change,
        // not new plumbing.
        onOperationChanged?.(); // FR-6b: gate closes via onOperationChanged's own refresh call.
      } catch (err) {
        setOperationError(errorMessage(err));
        onMutationSettled?.(); // FR-6b: still close the gate `onMutationStart` opened above.
      } finally {
        setIsContinuing(false);
      }
    })();
  }, [api, blockedByOperationAlert, onOperationChanged, onMutationStart, onMutationSettled]);

  const banners: ReactNode[] = [];

  if (repoState.inProgressOperation) {
    const segments = describeInProgressOperation(repoState.inProgressOperationDetail, repoState.currentBranch);
    const canContinue = conflictedCount === 0;
    banners.push(
      <div key="op" className="gh-status-banner gh-status-banner--serious gh-status-banner--operation" role="status">
        <span className="gh-status-banner__operation-text">
          {segments.length > 0
            ? segments.map((seg, i) => (
                <span key={i} className={seg.mono ? "gh-mono" : undefined}>
                  {seg.text}
                </span>
              ))
            : OPERATION_LABEL[repoState.inProgressOperation]}
          {progress.total > 0 && (
            <span className="gh-status-banner__progress gh-tabular">
              {" "}
              — {progress.resolved} of {progress.total} conflict{progress.total === 1 ? "" : "s"} resolved
            </span>
          )}
        </span>
        {api && (
          <span className="gh-status-banner__op-actions">
            <button
              type="button"
              className="gh-status-banner__action"
              onClick={runContinue}
              disabled={!canContinue || isContinuing || isAborting || blockedByOperationAlert}
              title={
                blockedByOperationAlert
                  ? "This operation changed outside GitHydra — click Refresh above before continuing."
                  : canContinue
                    ? undefined
                    : `Continue is blocked: ${conflictedCount} conflicted file${conflictedCount === 1 ? "" : "s"} remain unresolved.`
              }
            >
              {isContinuing ? "Continuing…" : "Continue"}
            </button>
            <button
              type="button"
              className="gh-status-banner__action gh-status-banner__action--destructive"
              onClick={() => setPendingAbort(true)}
              disabled={isAborting || isContinuing || blockedByOperationAlert}
              title={
                blockedByOperationAlert
                  ? "This operation changed outside GitHydra — click Refresh above before aborting."
                  : undefined
              }
            >
              Abort
            </button>
          </span>
        )}
      </div>,
    );
  }
  if (operationStateAlert) {
    banners.push(
      <div key="op-alert" className="gh-status-banner gh-status-banner--critical" role="alert">
        <span>{describeOperationStateAlert(operationStateAlert.operation)}</span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={isRefreshing}
          aria-busy={isRefreshing}
          className="gh-status-banner__action"
        >
          {isRefreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>,
    );
  }
  if (operationError) {
    banners.push(
      <div key="op-error" className="gh-status-banner gh-status-banner--warning" role="alert">
        <span>{operationError}</span>
        <button type="button" className="gh-status-banner__action" onClick={() => setOperationError(null)}>
          Dismiss
        </button>
      </div>,
    );
  }
  if (repoState.isDetachedHead) {
    banners.push(
      <div key="detached" className="gh-status-banner gh-status-banner--serious" role="status">
        Detached HEAD — not on a branch tip
      </div>,
    );
  }
  if (repoState.isBare) {
    banners.push(
      <div key="bare" className="gh-status-banner gh-status-banner--neutral" role="status">
        Bare repository — no working directory
      </div>,
    );
  }
  if (repoState.isShallow) {
    banners.push(
      <div key="shallow" className="gh-status-banner gh-status-banner--neutral" role="status">
        Shallow clone — history is truncated (see boundary markers below)
      </div>,
    );
  }
  if (hasExternalChanges) {
    banners.push(
      <div key="external" className="gh-status-banner gh-status-banner--warning" role="alert">
        <span>History changed outside GitHydra.</span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={isRefreshing}
          aria-busy={isRefreshing}
          className="gh-status-banner__action"
        >
          {isRefreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>,
    );
  }

  return (
    <>
      {banners.length > 0 && <div className="gh-status-banner-stack">{banners}</div>}
      {pendingAbort && (
        <ConfirmDialog
          title="Abort this operation?"
          message="This restores the pre-operation branch tip, index, and working tree. Any conflict resolution progress on this operation is discarded."
          confirmLabel="Abort"
          destructive
          onConfirm={runAbort}
          onCancel={() => setPendingAbort(false)}
        />
      )}
    </>
  );
}
