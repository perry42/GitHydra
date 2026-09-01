import { useCallback, useState } from "react";
import type { GitHydraApi } from "../../shared/ipcContract";
import { unwrap } from "./gitHydraClient";

export interface UseStashActionsOptions {
  api: GitHydraApi;
  /** FR-101: called after any successful apply/pop/drop so the caller can run the spec's full
   * refresh contract (Toolbar badge, this panel's own list, ChangesPanel's sections/badges, the
   * graph's uncommitted-changes pseudo-node). */
  onMutated: () => void;
  /**
   * specs/self-write-refresh-suppression.md FR-6b / specs/stash.md FR-92: called synchronously
   * right before issuing the mutating call, so `useRepositoryGraph`'s self-write gate is already
   * open before the write can trip the fs watcher (FR-91 watches `refs/stash`).
   */
  onMutationStart?: () => void;
  /** FR-92: called when a gated mutation fails — `onMutated` is deliberately not called on
   * failure, but the gate `onMutationStart` opened still needs a confirming read to close it. */
  onMutationSettled?: () => void;
  /** FR-98: a conflicting apply/pop — the caller opens ChangesPanel and shows the stash-specific
   * inline notice; `conflictedPaths` is forwarded for callers that want it, though ChangesPanel's
   * own reload already picks up the newly-conflicted files independently. */
  onConflict: (action: "apply" | "pop", conflictedPaths: string[]) => void;
}

export interface UseStashActionsResult {
  /** FR-96: index of the stash a click is currently in flight for, or null — row-level controls
   * use this to disable themselves without a global spinner. */
  busyIndex: number | null;
  applyStash: (index: number) => void;
  popStash: (index: number) => void;
  error: string | null;
  dismissError: () => void;

  /** FR-97: step 1 of drop — opens the caller-rendered ConfirmDialog. */
  requestDrop: (index: number, message: string) => void;
  pendingDrop: { index: number; message: string } | null;
  confirmDrop: () => void;
  cancelDrop: () => void;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * FR-96/FR-97/FR-98: owns every stash-mutating action the Stash panel offers (Apply/Pop/Drop) plus
 * the drop confirmation step. Apply/Pop never route through a confirmation (FR-96 — neither
 * discards anything the user doesn't already have); Drop always does (FR-97).
 */
export function useStashActions({
  api,
  onMutated,
  onMutationStart,
  onMutationSettled,
  onConflict,
}: UseStashActionsOptions): UseStashActionsResult {
  const [busyIndex, setBusyIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingDrop, setPendingDrop] = useState<{ index: number; message: string } | null>(null);

  const runApplyLike = useCallback(
    (index: number, action: "apply" | "pop", call: (i: number) => ReturnType<GitHydraApi["applyStash"]>) => {
      setBusyIndex(index);
      setError(null);
      onMutationStart?.();
      void (async () => {
        try {
          const outcome = unwrap(await call(index));
          onMutated();
          if (outcome.status === "conflict") onConflict(action, outcome.conflictedPaths);
        } catch (err) {
          setError(messageOf(err));
          onMutationSettled?.();
        } finally {
          setBusyIndex(null);
        }
      })();
    },
    [onMutated, onMutationStart, onMutationSettled, onConflict],
  );

  const applyStash = useCallback(
    (index: number) => runApplyLike(index, "apply", (i) => api.applyStash(i)),
    [api, runApplyLike],
  );
  const popStash = useCallback(
    (index: number) => runApplyLike(index, "pop", (i) => api.popStash(i)),
    [api, runApplyLike],
  );

  const requestDrop = useCallback((index: number, message: string) => {
    setError(null);
    setPendingDrop({ index, message });
  }, []);
  const cancelDrop = useCallback(() => setPendingDrop(null), []);

  const confirmDrop = useCallback(() => {
    const pending = pendingDrop;
    if (!pending) return;
    setPendingDrop(null);
    setBusyIndex(pending.index);
    setError(null);
    onMutationStart?.();
    void (async () => {
      try {
        unwrap(await api.dropStash(pending.index));
        onMutated();
      } catch (err) {
        setError(messageOf(err));
        onMutationSettled?.();
      } finally {
        setBusyIndex(null);
      }
    })();
  }, [api, onMutated, onMutationStart, onMutationSettled, pendingDrop]);

  return {
    busyIndex,
    applyStash,
    popStash,
    error,
    dismissError: () => setError(null),
    requestDrop,
    pendingDrop,
    confirmDrop,
    cancelDrop,
  };
}
