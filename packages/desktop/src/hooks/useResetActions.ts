// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useRef, useState } from "react";
import type { RepositoryState, ResetMode } from "@githydra/git-core";
import type { GitHydraApi } from "../../shared/ipcContract";
import { unwrap, withGitLockRetryThrowing } from "./gitHydraClient";

/** specs/reset-to-here.md FR-374: everything the success banner needs, captured *before* the
 * mutating call from already-loaded state — no new git read. */
export interface ResetAttemptMeta {
  targetSha: string;
  mode: ResetMode;
  /** The commit-graph "Reset {branch} to here…" convention's own label — the branch name when
   * attached, or the literal string "HEAD" when detached (never "HEAD (detached)" — see
   * `CommitGraph.tsx`'s own doc comment on this exact wording, matching FR-366/AC1). */
  branchLabel: string;
  previousSha: string | null;
  /** The pre-reset HEAD commit's subject, if it's currently loaded in the graph's own page —
   * `null` otherwise (FR-374: never a new git read to fetch it). */
  previousSubject: string | null;
}

/** specs/reset-to-here.md FR-369/371: the second-tier destructive confirmation's own state — only
 * ever set when Hard is chosen against a dirty working tree, per a FRESH read taken at the moment
 * of the primary action click (see `requestReset`'s own doc comment for why this isn't the
 * possibly-stale `workingDirStatus` the caller already has loaded). */
export interface PendingHardResetConfirm {
  meta: ResetAttemptMeta;
  staged: number;
  unstaged: number;
  conflicted: number;
  /** FR-375/376(b): true when this escalation came from the Undo button, not a fresh reset — so
   * confirming it still clears (never replaces) the undo banner, exactly like the direct,
   * no-escalation Undo leg does. */
  isUndo: boolean;
}

/** specs/reset-to-here.md FR-374/375/376: the success banner's own state — rendered by
 * `StatusBanner` (see its `resetUndoBanner` prop) alongside its existing `operationError` entry. */
export interface ResetUndoBannerState {
  mode: ResetMode;
  /** The SHA this reset actually produced (== the attempt's `targetSha`) — FR-376(c)'s own
   * staleness check clears this banner once `repoState.headSha` no longer matches it. */
  producedSha: string;
  previousSha: string;
  previousAbbrevSha: string;
  previousSubject: string | null;
  branchLabel: string;
}

export interface UseResetActionsOptions {
  api: GitHydraApi;
  repoState: RepositoryState | null;
  /** FR-374: resolves the pre-reset HEAD commit's subject from already-loaded graph state (the
   * commit-graph's own currently-loaded page) — `null` when it isn't loaded. Never triggers a new
   * git read. */
  getLoadedCommitSubject: (sha: string) => string | null;
  /** FR-372: called after every settled reset (a plain success, since Soft/Mixed/a-clean-Hard never
   * pause on anything the way a cherry-pick step can) — the caller runs the same full refresh
   * contract (commit graph, HEAD/branch decoration, ChangesPanel, Toolbar, operation banner) every
   * other mutating hook in this codebase already uses. */
  onSettled: () => void;
  /** specs/self-write-refresh-suppression.md FR-6b: called synchronously right before issuing
   * `resetCurrentBranch` — the same pattern every other mutating hook in this codebase already uses
   * around its own mutating call. */
  onMutationStart?: () => void;
  /** FR-6b: called when the mutating call genuinely fails — `onSettled` is deliberately not called
   * then (nothing succeeded to refresh), but the gate `onMutationStart` opened still needs a
   * confirming read to close it. */
  onMutationSettled?: () => void;
}

export interface UseResetActionsResult {
  /** FR-367/FR-371: the dialog's primary action. Soft/Mixed (any target) and a clean-working-tree
   * Hard call `resetCurrentBranch` immediately; a dirty-working-tree Hard opens
   * `pendingHardConfirm` instead (see its own doc comment) rather than resetting yet. */
  requestReset: (targetSha: string, mode: ResetMode, branchLabel: string) => void;
  /** True while a fresh dirty-check read or the mutating `resetCurrentBranch` call itself is in
   * flight. */
  busy: boolean;
  /** FR-371: non-null exactly when Hard was requested against a dirty working tree — the caller
   * renders the shared `ConfirmDialog` (`destructive: true`) restating these exact counts. */
  pendingHardConfirm: PendingHardResetConfirm | null;
  /** FR-371: confirms the pending Hard reset — only reachable after that second dialog. */
  confirmHardReset: () => void;
  /** FR-371: cancels the pending Hard reset — makes no git call, leaves HEAD/index/working tree
   * unchanged. */
  cancelHardReset: () => void;
  /** The most recent genuine reset failure, verbatim. */
  error: string | null;
  dismissError: () => void;
  /** FR-374: non-null after a successful reset, until dismissed/undone/superseded (FR-376). */
  undoBanner: ResetUndoBannerState | null;
  /** FR-375: re-invokes the exact same gated flow `requestReset` does — mode fixed to the original
   * reset's mode, target fixed to the captured previous SHA — never an unconditional/unconfirmed
   * hard reset, even though the working tree may have become dirty again since. */
  undo: () => void;
  /** FR-376(a): explicit dismiss. */
  dismissUndoBanner: () => void;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * specs/reset-to-here.md FR-373: owns the whole Reset-to-here mutating flow — opening/closing the
 * FR-371 second-tier confirmation, the `resetCurrentBranch` call itself, and FR-374's undo-banner
 * state — matching this codebase's one-hook-per-mutating-feature convention
 * (`useBranchActions`/`useCherryPickActions`/`useStashActions`). Does NOT own whether the
 * mode-selection dialog itself is open — that's presentation state the caller (`App.tsx`) owns
 * directly, the same split `NewBranchDialog`'s own `newBranchRequest` state already establishes.
 */
export function useResetActions({
  api,
  repoState,
  getLoadedCommitSubject,
  onSettled,
  onMutationStart,
  onMutationSettled,
}: UseResetActionsOptions): UseResetActionsResult {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingHardConfirm, setPendingHardConfirm] = useState<PendingHardResetConfirm | null>(null);
  const [undoBanner, setUndoBanner] = useState<ResetUndoBannerState | null>(null);

  // FR-376(c): the undo banner clears once `HEAD` moves away from the exact SHA this reset
  // produced, for ANY reason (a new commit, a branch switch, another reset, ...) — not just a click
  // on Undo itself (see `executeReset`'s own explicit clear on a successful Undo, below, for that
  // more immediate case). `repoState` is App-owned and only catches up to the new `headSha`
  // asynchronously, once `onSettled`'s own graph refresh actually lands — a naive "differs from
  // producedSha" check would misfire the INSTANT the banner is created (repoState is still showing
  // the PRE-reset headSha for that whole in-between window) and clear it before the user ever sees
  // it. `confirmedProducedShaRef` tracks whether `repoState.headSha` has already been OBSERVED to
  // equal this exact banner's `producedSha` at least once; only after that confirmation does a
  // later mismatch count as "HEAD moved away," never the pre-refresh lag itself.
  const confirmedProducedShaRef = useRef<string | null>(null);
  useEffect(() => {
    if (!undoBanner) {
      confirmedProducedShaRef.current = null;
      return;
    }
    if (!repoState) return;
    if (repoState.headSha === undoBanner.producedSha) {
      confirmedProducedShaRef.current = undoBanner.producedSha;
      return;
    }
    if (confirmedProducedShaRef.current === undoBanner.producedSha) {
      setUndoBanner(null);
    }
  }, [repoState, undoBanner]);

  const executeReset = useCallback(
    (meta: ResetAttemptMeta, opts?: { isUndo?: boolean }) => {
      setBusy(true);
      setError(null);
      // FR-6b: open the self-write gate before the mutating call, not after — matches every other
      // mutating hook in this codebase.
      onMutationStart?.();
      void (async () => {
        try {
          await withGitLockRetryThrowing(async () => {
            unwrap(await api.resetCurrentBranch(meta.targetSha, meta.mode));
          });
          if (opts?.isUndo) {
            // FR-376(b): a successful Undo clears the banner rather than replacing it with a fresh
            // one for the reverse operation — Undo is a one-shot recovery step, not a chain.
            setUndoBanner(null);
          } else if (meta.previousSha) {
            setUndoBanner({
              mode: meta.mode,
              producedSha: meta.targetSha,
              previousSha: meta.previousSha,
              previousAbbrevSha: meta.previousSha.slice(0, 7),
              previousSubject: meta.previousSubject,
              branchLabel: meta.branchLabel,
            });
          }
          onSettled();
        } catch (err) {
          setError(messageOf(err));
          onMutationSettled?.(); // FR-6b: still close the gate `onMutationStart` opened above.
        } finally {
          setBusy(false);
        }
      })();
    },
    [api, onSettled, onMutationStart, onMutationSettled],
  );

  const buildMeta = useCallback(
    (targetSha: string, mode: ResetMode, branchLabel: string): ResetAttemptMeta | null => {
      if (!repoState) return null;
      return {
        targetSha,
        mode,
        branchLabel,
        previousSha: repoState.headSha,
        previousSubject: repoState.headSha ? getLoadedCommitSubject(repoState.headSha) : null,
      };
    },
    [repoState, getLoadedCommitSubject],
  );

  /**
   * specs/reset-to-here.md FR-369/FR-371, security review: the dirty-working-tree check that gates
   * Hard's second confirmation is evaluated against a FRESH `getWorkingDirStatus()` read taken right
   * here, at the moment of the primary-action click — never against whatever `workingDirStatus` the
   * caller's own graph state already had loaded (which can be stale by the time the user actually
   * clicks: the dialog can sit open for a while, and a stale "clean" snapshot would let a genuinely
   * dirty Hard reset skip the second confirmation entirely — exactly the race this spec's Security
   * review section calls out by name). `isUndo` threads through unchanged to `executeReset` so a
   * successful Undo clears (never replaces) the banner, per FR-376(b).
   */
  const requestResetInternal = useCallback(
    (targetSha: string, mode: ResetMode, branchLabel: string, isUndo: boolean) => {
      const meta = buildMeta(targetSha, mode, branchLabel);
      if (!meta) return;
      if (mode !== "hard") {
        executeReset(meta, { isUndo });
        return;
      }
      setBusy(true);
      setError(null);
      void (async () => {
        try {
          const status = unwrap(await api.getWorkingDirStatus());
          const staged = status?.staged ?? 0;
          const unstaged = status?.unstaged ?? 0;
          const conflicted = status?.conflicted ?? 0;
          setBusy(false);
          if (staged + unstaged + conflicted > 0) {
            setPendingHardConfirm({ meta: { ...meta, mode }, staged, unstaged, conflicted, isUndo });
          } else {
            executeReset(meta, { isUndo });
          }
        } catch (err) {
          setBusy(false);
          setError(messageOf(err));
        }
      })();
    },
    [api, buildMeta, executeReset],
  );

  const requestReset = useCallback(
    (targetSha: string, mode: ResetMode, branchLabel: string) =>
      requestResetInternal(targetSha, mode, branchLabel, false),
    [requestResetInternal],
  );

  const confirmHardReset = useCallback(() => {
    const pending = pendingHardConfirm;
    if (!pending) return;
    setPendingHardConfirm(null);
    executeReset(pending.meta, { isUndo: pending.isUndo });
  }, [pendingHardConfirm, executeReset]);

  const cancelHardReset = useCallback(() => setPendingHardConfirm(null), []);

  const undo = useCallback(() => {
    if (!undoBanner) return;
    requestResetInternal(undoBanner.previousSha, undoBanner.mode, undoBanner.branchLabel, true);
  }, [undoBanner, requestResetInternal]);

  return {
    requestReset,
    busy,
    pendingHardConfirm,
    confirmHardReset,
    cancelHardReset,
    error,
    dismissError: () => setError(null),
    undoBanner,
    undo,
    dismissUndoBanner: () => setUndoBanner(null),
  };
}
