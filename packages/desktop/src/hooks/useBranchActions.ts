import { useCallback, useState } from "react";
import type { RemoteBranchInfo } from "@githydra/git-core";
import type { GitHydraApi } from "../../shared/ipcContract";
import { GitHydraIpcError, unwrap } from "./gitHydraClient";

export interface UseBranchActionsOptions {
  api: GitHydraApi;
  /** Called after any successful switch/checkout/create/delete/force-delete so the caller can
   * refresh whatever shows current-branch/HEAD state and refs (FR-56) — one shared callback used
   * by every mutation this hook exposes, since they all invalidate the same data. */
  onChanged: () => void;
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
export function useBranchActions({ api, onChanged }: UseBranchActionsOptions): UseBranchActionsResult {
  const [busyBranch, setBusyBranch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [pendingForceDelete, setPendingForceDelete] = useState<string | null>(null);

  const switchTo = useCallback(
    async (branchName: string) => {
      setBusyBranch(branchName);
      setError(null);
      try {
        unwrap(await api.switchBranch(branchName));
        onChanged();
      } catch (err) {
        // FR-38/FR-51: never force/retry on a BranchSwitchConflictError (uncommitted changes) or
        // any other refusal (mid-rebase, etc.) — surface git's real reason verbatim.
        setError(messageOf(err));
      } finally {
        setBusyBranch(null);
      }
    },
    [api, onChanged],
  );

  const checkoutCommit = useCallback(
    async (commitish: string) => {
      setBusyBranch(commitish);
      setError(null);
      try {
        unwrap(await api.switchToCommit(commitish));
        onChanged();
      } catch (err) {
        setError(messageOf(err));
      } finally {
        setBusyBranch(null);
      }
    },
    [api, onChanged],
  );

  const checkoutRemote = useCallback(
    async (remoteBranch: RemoteBranchInfo) => {
      setBusyBranch(remoteBranch.fullName);
      setError(null);
      try {
        // FR-37/FR-53: route through createBranch with an explicit start point + track:true
        // (rather than a plain switchBranch DWIM) so the new local branch's tracking is always
        // wired, deterministically, regardless of ambient `branch.autoSetupMerge` config.
        unwrap(
          await api.createBranch({
            name: remoteBranch.name,
            startPoint: remoteBranch.fullName,
            switchToIt: true,
            track: true,
          }),
        );
        onChanged();
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
