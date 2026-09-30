// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GitHydraApi } from "../../shared/ipcContract";
import {
  createGuardedCheckout,
  type GuardedCheckout,
  type LeftBehindInfo,
  type OrphanPromptDecision,
  type OrphanPromptRequest,
} from "../lib/guardedCheckout";

export interface PendingOrphanPrompt {
  request: OrphanPromptRequest;
  /** "confirm": the OrphanedCommitsDialog; "naming": the name-entry dialog opened by "Create branch here...". */
  phase: "confirm" | "naming";
}

export interface UseOrphanGuardOptions {
  api: GitHydraApi;
  /** Refresh whatever shows HEAD/refs after a HeadMovedError. */
  onHeadMoved?: () => void;
}

export interface UseOrphanGuardResult {
  /** Stable for a given `api`; hand this to every hook/component that checks out. */
  guardedCheckout: GuardedCheckout;
  pending: PendingOrphanPrompt | null;
  /** True while any guard dialog (confirm or naming) is up - folds into `anyModalDialogOpen`. */
  dialogOpen: boolean;
  chooseCreate: () => void;
  chooseLeave: () => void;
  chooseCancel: () => void;
  /** Name-entry dialog saved the commits on a branch: resolves "created" so the guard re-queries. */
  namingCreated: () => void;
  /** Name-entry dialog dismissed: back to the confirm dialog (nothing decided). */
  namingCancelled: () => void;
  /** Present after a confirmed "Leave commits behind" checkout succeeded. */
  leftBehind: LeftBehindInfo | null;
  dismissLeftBehind: () => void;
  /** Cancels any pending prompt and clears the banner (repo/tab switch). */
  reset: () => void;
}

/**
 * Owns the React state behind `createGuardedCheckout`'s `prompt` (which dialog is up, the pending
 * promise's resolver) and the post-leave banner state. One instance lives in `App`.
 */
export function useOrphanGuard({ api, onHeadMoved }: UseOrphanGuardOptions): UseOrphanGuardResult {
  const [pending, setPending] = useState<PendingOrphanPrompt | null>(null);
  const [leftBehind, setLeftBehind] = useState<LeftBehindInfo | null>(null);
  const resolverRef = useRef<((d: OrphanPromptDecision) => void) | null>(null);
  const onHeadMovedRef = useRef(onHeadMoved);
  onHeadMovedRef.current = onHeadMoved;

  const settle = useCallback((decision: OrphanPromptDecision) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setPending(null);
    resolve?.(decision);
  }, []);

  const prompt = useCallback((request: OrphanPromptRequest) => {
    if (resolverRef.current) return Promise.resolve<OrphanPromptDecision>("cancel"); // one dialog at a time.
    return new Promise<OrphanPromptDecision>((resolve) => {
      resolverRef.current = resolve;
      setPending({ request, phase: "confirm" });
    });
  }, []);

  const guardedCheckout = useMemo(
    () =>
      createGuardedCheckout({
        api,
        prompt,
        onLeftBehind: setLeftBehind,
        onHeadMoved: () => onHeadMovedRef.current?.(),
      }),
    [api, prompt],
  );

  useEffect(() => () => settle("cancel"), [settle]);

  return {
    guardedCheckout,
    pending,
    dialogOpen: pending !== null,
    chooseCreate: () => setPending((p) => (p ? { ...p, phase: "naming" } : p)),
    chooseLeave: () => settle("leave"),
    chooseCancel: () => settle("cancel"),
    namingCreated: () => settle("created"),
    namingCancelled: () => setPending((p) => (p ? { ...p, phase: "confirm" } : p)),
    leftBehind,
    dismissLeftBehind: () => setLeftBehind(null),
    reset: () => {
      settle("cancel");
      setLeftBehind(null);
    },
  };
}
