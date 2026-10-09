// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useState } from "react";
import type { GitHydraApi } from "../../shared/ipcContract";
import { unwrap } from "./gitHydraClient";

export interface UseContinueOperationOptions {
  api?: GitHydraApi;
  /** An unacknowledged operation-state alert blocks Continue like Abort (specs/graph-head-indicator-and-refresh-alerting.md Problem 2 AC4). */
  blocked: boolean;
  onOperationChanged?: () => void;
  /** specs/self-write-refresh-suppression.md FR-6b: opened right before the mutating call, closed again when it fails. */
  onMutationStart?: () => void;
  onMutationSettled?: () => void;
}

export interface ContinueOperation {
  run: () => void;
  isContinuing: boolean;
  error: string | null;
  clearError: () => void;
}

/**
 * specs/merge-rebase-conflict-resolution.md FR-70/71: the one Continue handler. StatusBanner's button and the conflict
 * editor's "Continue ..." button (specs/edit-in-diff.md FR-569) both call this exact function, so they cannot drift.
 */
export function useContinueOperation({ api, blocked, onOperationChanged, onMutationStart, onMutationSettled }: UseContinueOperationOptions): ContinueOperation {
  const [isContinuing, setIsContinuing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(() => {
    if (!api || blocked) return;
    setIsContinuing(true);
    setError(null);
    onMutationStart?.();
    void (async () => {
      try {
        unwrap(await api.continueInProgressOperation());
        onOperationChanged?.(); // FR-6b: the gate closes via the caller's refresh.
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        onMutationSettled?.();
      } finally {
        setIsContinuing(false);
      }
    })();
  }, [api, blocked, onOperationChanged, onMutationStart, onMutationSettled]);
  const clearError = useCallback(() => setError(null), []);
  return { run, isContinuing, error, clearError };
}
