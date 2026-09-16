// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useState } from "react";
import type { IdentityConfigState, IdentityProfileFields } from "@githydra/git-core";
import type { GitHydraApi } from "../../shared/ipcContract";
import { GitHydraIpcError, unwrap } from "./gitHydraClient";
import type { IdentityProfile } from "./useIdentityProfiles";
import type { UseIdentityApplicationsResult } from "./useIdentityApplications";

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type IdentityConfigStatus = "idle" | "loading" | "ready" | "error";

export interface UseIdentityProfileApplicationOptions {
  api: GitHydraApi;
  /** `null` means no repo is open — every fetch/mutation below is a no-op while this is `null`
   * (mirrors this codebase's other per-repo action hooks refusing to act with nothing open). */
  repoPath: string | null;
  /** `useIdentityApplications()`'s own instance (App-owned, per its own doc comment) — this hook
   * records/clears that store's per-repo entry on a successful apply/remove, alongside the actual
   * IPC calls. */
  applications: UseIdentityApplicationsResult;
  /**
   * specs/self-write-refresh-suppression.md FR-6b, extended to this feature: applying/removing
   * writes to the repo's `.git/config`, which the fs watcher's top-level `gitDir` watch also
   * observes (see `watcher.ts`'s own doc comment — it watches `gitDir` non-recursively specifically
   * to catch operation-state files, at the documented cost of also firing for "ordinary per-commit/
   * per-stage noise," which a `config` rewrite falls under) — so this needs the exact same
   * self-write gate every other mutating action in this codebase already opens/closes, or a
   * successful apply/remove would spuriously flip `hasExternalChanges`/`operationStateAlert`.
   * Called synchronously right before the mutating IPC call, matching `useBranchActions`'s own
   * `onMutationStart` doc comment.
   */
  onMutationStart?: () => void;
  /**
   * Called exactly once after EITHER outcome of a mutating call settles (success, a genuine
   * failure, or the FR-334 conflict pause) — unlike `useBranchActions`' split `onChanged`/
   * `onMutationSettled` (which only needs the gate-closing call on the FAILURE path, since success
   * routes through a separate `onChanged` that itself calls `refreshRefs`), nothing else in this
   * feature needs refreshing on success (identity mutations never move HEAD/refs/commits), so one
   * callback covers every settled outcome — always `graph.refreshRefs` in practice, the same
   * function every other hook in this codebase passes for this exact purpose.
   */
  onSettled?: () => void;
}

export interface PendingIdentityConflict {
  fields: IdentityProfileFields;
  profile: IdentityProfile;
  /** `UnmanagedIdentityConfigConflictError`'s own already-descriptive message (git-core's
   * `errors.ts`) — names every conflicting key/value verbatim, shown to the user as-is rather than
   * re-derived. */
  message: string;
}

export interface UseIdentityProfileApplicationResult {
  status: IdentityConfigStatus;
  state: IdentityConfigState | null;
  errorMessage: string | null;
  reload: () => void;
  busy: boolean;
  error: string | null;
  dismissError: () => void;
  /** FR-330/FR-331: first attempt, never forced — pauses as `pendingConflict` instead of writing
   * anything if this would overwrite a value GitHydra didn't itself set (FR-334). */
  applyProfile: (profile: IdentityProfile) => void;
  pendingConflict: PendingIdentityConflict | null;
  /** FR-334: only reachable after the user has seen `pendingConflict.message` and explicitly
   * confirmed — re-calls `applyIdentityProfile` with `force: true`, never automatic. */
  confirmApplyWithForce: () => void;
  cancelApplyConflict: () => void;
  /** FR-336. */
  removeApplication: () => void;
}

/**
 * Owns the per-repo half of specs/git-identity-profiles.md: reading FR-335's status display,
 * applying a profile (with FR-334's confirm-then-force escalation, mirroring
 * `useBranchActions`' `pendingDelete`/`pendingForceDelete` two-tier shape), and removing an
 * application (FR-336). Never touches the profile *library* itself (`useIdentityProfiles`, a
 * separate concern per FR-329's own module boundary).
 */
export function useIdentityProfileApplication({
  api,
  repoPath,
  applications,
  onMutationStart,
  onSettled,
}: UseIdentityProfileApplicationOptions): UseIdentityProfileApplicationResult {
  const [status, setStatus] = useState<IdentityConfigStatus>("idle");
  const [state, setState] = useState<IdentityConfigState | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingConflict, setPendingConflict] = useState<PendingIdentityConflict | null>(null);

  const reload = useCallback(() => {
    if (!repoPath) {
      setState(null);
      setStatus("idle");
      return;
    }
    setStatus("loading");
    setErrorMessage(null);
    void (async () => {
      try {
        const result = unwrap(await api.getIdentityConfigState());
        setState(result);
        setStatus("ready");
      } catch (err) {
        setErrorMessage(messageOf(err));
        setStatus("error");
      }
    })();
  }, [api, repoPath]);

  // Refetches whenever the open repo actually changes (including "no repo open") — mirrors every
  // other per-repo panel's own remount-or-refetch-on-repo-change convention in this codebase.
  useEffect(() => {
    reload();
    setPendingConflict(null);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoPath]);

  const performApply = useCallback(
    (profile: IdentityProfile, force: boolean) => {
      if (!repoPath) return;
      const fields: IdentityProfileFields = {
        userName: profile.userName,
        userEmail: profile.userEmail,
        sshIdentityFilePath: profile.sshIdentityFilePath,
      };
      setBusy(true);
      setError(null);
      onMutationStart?.(); // FR-6b — see this hook's own `onMutationStart` doc comment.
      void (async () => {
        try {
          unwrap(await api.applyIdentityProfile({ ...fields, force }));
          setPendingConflict(null);
          applications.recordApplication(repoPath, {
            profileId: profile.id,
            profileDisplayName: profile.displayName,
            userName: profile.userName,
            userEmail: profile.userEmail,
            sshCommand: profile.sshIdentityFilePath ? `ssh -i '${profile.sshIdentityFilePath}' -o IdentitiesOnly=yes` : null,
            appliedAt: new Date().toISOString(),
          });
          onSettled?.();
          reload();
        } catch (err) {
          // FR-334: never auto-force — pause and let the caller show `err.message` (already names
          // every conflicting key/value) as an explicit confirmation.
          if (err instanceof GitHydraIpcError && err.name === "UnmanagedIdentityConfigConflictError") {
            setPendingConflict({ fields, profile, message: err.message });
          } else {
            setError(messageOf(err));
          }
          onSettled?.(); // FR-6b: still close the gate even though nothing was written.
        } finally {
          setBusy(false);
        }
      })();
    },
    [api, applications, onMutationStart, onSettled, reload, repoPath],
  );

  const applyProfile = useCallback(
    (profile: IdentityProfile) => {
      setPendingConflict(null);
      performApply(profile, false);
    },
    [performApply],
  );

  const confirmApplyWithForce = useCallback(() => {
    if (!pendingConflict) return;
    const { profile } = pendingConflict;
    setPendingConflict(null);
    performApply(profile, true);
  }, [pendingConflict, performApply]);

  const cancelApplyConflict = useCallback(() => setPendingConflict(null), []);

  const removeApplication = useCallback(() => {
    if (!repoPath) return;
    setBusy(true);
    setError(null);
    onMutationStart?.();
    void (async () => {
      try {
        unwrap(await api.removeIdentityProfileApplication());
        applications.clearApplication(repoPath);
        onSettled?.();
        reload();
      } catch (err) {
        setError(messageOf(err));
        onSettled?.();
      } finally {
        setBusy(false);
      }
    })();
  }, [api, applications, onMutationStart, onSettled, reload, repoPath]);

  return {
    status,
    state,
    errorMessage,
    reload,
    busy,
    error,
    dismissError: () => setError(null),
    applyProfile,
    pendingConflict,
    confirmApplyWithForce,
    cancelApplyConflict,
    removeApplication,
  };
}
