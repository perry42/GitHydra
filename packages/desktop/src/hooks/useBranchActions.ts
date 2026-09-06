// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useState } from "react";
import type { RemoteBranchInfo } from "@githydra/git-core";
import type { GitHydraApi } from "../../shared/ipcContract";
import { GitHydraIpcError, unwrap } from "./gitHydraClient";
import type { ExpectedRefOutcome } from "./selfWriteGate";

export interface UseBranchActionsOptions {
  api: GitHydraApi;
  /**
   * Called after any successful switch/checkout/create/delete/force-delete so the caller can
   * refresh whatever shows current-branch/HEAD state and refs (FR-56) — one shared callback used
   * by every mutation this hook exposes, since they all invalidate the same data.
   *
   * specs/self-write-refresh-suppression.md AC5 fix: `switchTo`/`checkoutCommit` — the two
   * `onMutationStart`-gated operations — pass their own known outcome (derived from the mutating
   * call's own return value, never guessed) so the caller can forward it into `refreshRefs` for the
   * gate-closing diff. Every other mutation this hook exposes calls `onChanged()` with no argument,
   * exactly as before — they were never gated by `onMutationStart` and stay out of scope here.
   *
   * specs/graph-head-indicator-and-refresh-alerting.md Problem 1 (AC2/AC3) reuses the same value:
   * `expected.sha` is exactly the resulting HEAD sha, so the caller can also auto-select/scroll to
   * it in the same action that refreshes refs — no separate sha param needed.
   */
  onChanged: (expected?: ExpectedRefOutcome) => void;
  /**
   * specs/self-write-refresh-suppression.md FR-6b: called synchronously right before issuing
   * `switchBranch`/`switchToCommit` — the two call sites FR-6c names (BranchesPanel row checkout,
   * the graph's commit context-menu "Checkout") — so `useRepositoryGraph`'s self-write gate is
   * already open before the mutating git call's own disk write can trip the fs watcher. Optional
   * only so existing/other test harnesses that construct this hook without wiring the full graph
   * (e.g. `BranchesPanel.test.tsx`'s standalone `Harness`) don't need to pass a no-op.
   */
  onMutationStart?: () => void;
  /**
   * specs/self-write-refresh-suppression.md FR-6b: called when a gated mutation (see
   * `onMutationStart`) *fails* — `onChanged` is deliberately not called on failure (nothing to
   * refresh, FR-38/FR-51's existing behavior), but the in-flight gate `onMutationStart` opened
   * still has to close via a real confirming read, or every watcher event is deferred forever
   * after any failed checkout. Not called on success — `onChanged`'s own `refreshRefs()` already
   * closes the gate in that path, and closing it twice per operation would under-count a second,
   * genuinely-overlapping mutation's own gate.
   */
  onMutationSettled?: () => void;
}

export interface UseBranchActionsResult {
  /** FR-38/FR-51: switch HEAD to an existing local branch. */
  switchTo: (branchName: string) => Promise<void>;
  /** FR-39/FR-54: detached-HEAD checkout of an arbitrary commit-ish (the graph's "Checkout"). */
  checkoutCommit: (commitish: string) => Promise<void>;
  /** FR-37/FR-53: checkout a remote-tracking branch by creating a local tracking branch and
   * switching to it in one call, rather than a plain untracked create. */
  checkoutRemote: (remoteBranch: RemoteBranchInfo) => Promise<void>;
  /** Name of the branch a switch/checkout/delete is currently in flight for, or null. Row-level
   * controls use this to disable themselves and show a busy state without a global spinner. */
  busyBranch: string | null;

  /** FR-52: step 1 of delete — opens the (caller-rendered) normal confirmation. */
  requestDelete: (branchName: string) => void;
  pendingDelete: string | null;
  confirmDelete: () => void;
  cancelDelete: () => void;
  /** FR-52: step 2 — only reachable when `deleteBranch` refused with `BranchNotFullyMergedError`.
   * The caller renders a second, more severely-worded confirmation before calling `confirmForceDelete`. */
  pendingForceDelete: string | null;
  confirmForceDelete: () => void;
  cancelForceDelete: () => void;

  /** The actual git-provided reason for the most recent failure (FR-51/FR-7/FR-10) — every typed
   * error's `.message` already carries the specific detail (file list, worktree path, etc.), so
   * this is shown verbatim rather than replaced with a generic string. */
  error: string | null;
  dismissError: () => void;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Owns every branch-mutating action the UI can trigger (Branches panel rows, the graph's ref-chip
 * context menu, and the commit context menu's "Checkout") plus the delete-escalation state
 * machine (FR-52) — a single implementation so every call site behaves identically (AC15), rather
 * than each surface re-implementing its own confirm/escalate logic.
 */
export function useBranchActions({
  api,
  onChanged,
  onMutationStart,
  onMutationSettled,
}: UseBranchActionsOptions): UseBranchActionsResult {
  const [busyBranch, setBusyBranch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [pendingForceDelete, setPendingForceDelete] = useState<string | null>(null);

  const switchTo = useCallback(
    async (branchName: string) => {
      setBusyBranch(branchName);
      setError(null);
      // FR-6b: open the self-write gate before the mutating call, not after — the disk write (and
      // therefore the fs watcher's earliest possible fire) happens during `api.switchBranch`, not
      // once its promise resolves.
      onMutationStart?.();
      try {
        const result = unwrap(await api.switchBranch(branchName));
        // AC5 fix: the *actual* outcome of this specific operation (its own returned sha, plus the
        // branch name we ourselves targeted — never guessed) — see `refreshRefs`'s `expected` param.
        // `expected.sha` also drives Problem 1's auto-select/scroll (see `onChanged`'s doc comment).
        onChanged({ sha: result.sha, currentBranch: branchName });
      } catch (err) {
        // FR-38/FR-51: never force/retry on a BranchSwitchConflictError (uncommitted changes) or
        // any other refusal (mid-rebase, etc.) — surface git's real reason verbatim.
        setError(messageOf(err));
        onMutationSettled?.(); // FR-6b: still close the gate `onMutationStart` opened above.
      } finally {
        setBusyBranch(null);
      }
    },
    [api, onChanged, onMutationStart, onMutationSettled],
  );

  const checkoutCommit = useCallback(
    async (commitish: string) => {
      setBusyBranch(commitish);
      setError(null);
      onMutationStart?.(); // FR-6b — see `switchTo`'s comment.
      try {
        const result = unwrap(await api.switchToCommit(commitish));
        // AC5 fix: a detached-HEAD checkout always lands with `currentBranch: null` — see `switchTo`'s comment.
        onChanged({ sha: result.sha, currentBranch: null });
      } catch (err) {
        setError(messageOf(err));
        onMutationSettled?.(); // FR-6b — see `switchTo`'s comment.
      } finally {
        setBusyBranch(null);
      }
    },
    [api, onChanged, onMutationStart, onMutationSettled],
  );

  const checkoutRemote = useCallback(
    async (remoteBranch: RemoteBranchInfo) => {
      setBusyBranch(remoteBranch.fullName);
      setError(null);
      try {
        // FR-37/FR-53: route through createBranch with an explicit start point + track:true
        // (rather than a plain switchBranch DWIM) so the new local branch's tracking is always
        // wired, deterministically, regardless of ambient `branch.autoSetupMerge` config.
        const result = unwrap(
          await api.createBranch({
            name: remoteBranch.name,
            startPoint: remoteBranch.fullName,
            switchToIt: true,
            track: true,
          }),
        );
        // `switched` is always true here (switchToIt: true above never gets refused silently —
        // a refusal throws instead), but check anyway rather than assume, matching NewBranchDialog.
        // Not one of FR-6c's gated call sites (no `onMutationStart`/`onMutationSettled` here), so
        // this value is only ever consumed for Problem 1's auto-select, never the AC5 gate's diff.
        onChanged(result.switched ? { sha: result.sha, currentBranch: remoteBranch.name } : undefined);
      } catch (err) {
        setError(messageOf(err));
      } finally {
        setBusyBranch(null);
      }
    },
    [api, onChanged],
  );

  const requestDelete = useCallback((branchName: string) => {
    setError(null);
    setPendingDelete(branchName);
  }, []);
  const cancelDelete = useCallback(() => setPendingDelete(null), []);

  const confirmDelete = useCallback(() => {
    const branchName = pendingDelete;
    if (!branchName) return;
    setPendingDelete(null);
    setBusyBranch(branchName);
    setError(null);
    void (async () => {
      try {
        unwrap(await api.deleteBranch(branchName));
        onChanged();
      } catch (err) {
        // FR-40/FR-52: a "not fully merged" refusal escalates to the second, more severe
        // confirmation instead of surfacing as a plain error — every other refusal (checked out
        // here/elsewhere, doesn't exist, etc.) surfaces as a normal error message.
        if (err instanceof GitHydraIpcError && err.name === "BranchNotFullyMergedError") {
          setPendingForceDelete(branchName);
        } else {
          setError(messageOf(err));
        }
      } finally {
        setBusyBranch(null);
      }
    })();
  }, [api, onChanged, pendingDelete]);

  const cancelForceDelete = useCallback(() => setPendingForceDelete(null), []);

  const confirmForceDelete = useCallback(() => {
    const branchName = pendingForceDelete;
    if (!branchName) return;
    setPendingForceDelete(null);
    setBusyBranch(branchName);
    setError(null);
    void (async () => {
      try {
        // FR-41: only reachable after the second confirmation above — never a single click.
        unwrap(await api.forceDeleteBranch(branchName));
        onChanged();
      } catch (err) {
        setError(messageOf(err));
      } finally {
        setBusyBranch(null);
      }
    })();
  }, [api, onChanged, pendingForceDelete]);

  return {
    switchTo,
    checkoutCommit,
    checkoutRemote,
    busyBranch,
    requestDelete,
    pendingDelete,
    confirmDelete,
    cancelDelete,
    pendingForceDelete,
    confirmForceDelete,
    cancelForceDelete,
    error,
    dismissError: () => setError(null),
  };
}
