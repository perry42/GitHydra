// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useState } from "react";
import type { RepositoryState } from "@githydra/git-core";
import type { GitHydraApi } from "../../shared/ipcContract";
import { localBranchNameOf } from "../lib/dragCommitMenu";
import { unwrap, withGitLockRetryThrowing } from "./gitHydraClient";

export interface UseDragCommitActionsOptions {
  api: GitHydraApi;
  repoState: RepositoryState | null;
  /**
   * specs/drag-commit-menu.md FR-311: the existing single-commit cherry-pick flow's own
   * `cherryPick` (i.e. `useCherryPickActions`' `cherryPick`, the SAME live instance the graph's
   * right-click menu already uses) — called with `[aSha]` only after FR-309's checkout-if-needed
   * step (if any) succeeds. Reusing that hook instance, rather than a second independent
   * `api.cherryPick` call, keeps busy/error/conflict-pause handling (and the FR-118 empty-result
   * notice) identical to every other cherry-pick entry point — FR-311's "not a new code path."
   */
  cherryPick: (shas: readonly string[]) => void;
  /**
   * FR-314: called after (a) a checkout-if-needed step that itself moved HEAD, regardless of what
   * follows it, and (b) every settled (clean or paused-on-conflict) Merge/Rebase this hook
   * initiates. `runCherryPick` deliberately does NOT call this a second time for the cherry-pick
   * half itself — the `cherryPick` callback above already carries its own `onSettled` wired up by
   * the caller (`useCherryPickActions`), so this hook only owns the checkout half's refresh.
   */
  onSettled: () => void;
  /** specs/self-write-refresh-suppression.md FR-6b: same open-before-mutating-call convention
   * every other mutating hook in this codebase already uses. */
  onMutationStart?: () => void;
  /** FR-6b: closes the gate `onMutationStart` opened when a mutation genuinely fails (never
   * called on the expected-pause path, which `onSettled` already covers). */
  onMutationSettled?: () => void;
}

export interface UseDragCommitActionsResult {
  /** FR-312: FR-309's checkout-if-needed, then `mergeCommit(aSha)`. */
  runMerge: (aSha: string, bSha: string) => void;
  /** FR-313: FR-309's checkout-if-needed, then `rebaseCommitOnto(aSha)`. */
  runRebase: (aSha: string, bSha: string) => void;
  /** FR-311: FR-309's checkout-if-needed, then the caller-supplied `cherryPick([aSha])`. */
  runCherryPick: (aSha: string, bSha: string) => void;
  /** True while this hook's own checkout-if-needed or merge/rebase call is in flight — does NOT
   * cover a cherry-pick already in flight via the shared `cherryPick` callback; callers that need
   * that should also check their own `cherryPickBusy` (exactly as the existing right-click menu
   * already does). */
  busy: boolean;
  /** FR-9: the most recent genuine (non-pause) checkout/merge/rebase refusal, verbatim. */
  error: string | null;
  dismissError: () => void;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * specs/drag-commit-menu.md FR-309/312/313: owns the drag menu's three mutating flows (Merge,
 * Rebase, and the checkout half of Cherry-pick) — Cherry-pick's own mutating call is deliberately
 * NOT reimplemented here (see `cherryPick`'s doc comment above); this hook only adds the two new
 * git-core calls (`mergeCommit`/`rebaseCommitOnto`) plus the one shared checkout-if-needed
 * precondition (FR-309) none of the three existing action hooks had a reason to own before now.
 */
export function useDragCommitActions({
  api,
  repoState,
  cherryPick,
  onSettled,
  onMutationStart,
  onMutationSettled,
}: UseDragCommitActionsOptions): UseDragCommitActionsResult {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * FR-309: switches HEAD to `bSha` first when it isn't already HEAD — `git switch <name>`
   * (branch-management FR-38) when `bSha` is a local branch tip, `git switch --detach <bSha>`
   * (FR-39) otherwise, reusing those exact IPC calls verbatim (no new checkout variant). Resolves
   * `true` when it's safe for the caller to proceed with the action that follows (already HEAD, or
   * the switch itself succeeded); `false` on a genuine refusal, which this function has already
   * surfaced via `error` — the caller must not proceed (FR-9: no merge/cherry-pick/rebase call is
   * attempted after a refused checkout).
   */
  const ensureCheckedOut = useCallback(
    async (bSha: string): Promise<boolean> => {
      if (repoState?.headSha === bSha) return true;
      onMutationStart?.();
      try {
        const commit = unwrap(await api.getCommit(bSha));
        const localBranch = localBranchNameOf(commit ?? undefined);
        if (localBranch) {
          await withGitLockRetryThrowing(async () => unwrap(await api.switchBranch(localBranch)));
        } else {
          await withGitLockRetryThrowing(async () => unwrap(await api.switchToCommit(bSha)));
        }
        onSettled(); // FR-314: refresh after the checkout half, regardless of what follows it.
        return true;
      } catch (err) {
        setError(messageOf(err));
        onMutationSettled?.();
        return false;
      }
    },
    [api, repoState, onSettled, onMutationStart, onMutationSettled],
  );

  const runMutation = useCallback(
    (aSha: string, bSha: string, kind: "merge" | "rebase", mutate: (sha: string) => Promise<void>) => {
      setBusy(true);
      setError(null);
      void (async () => {
        try {
          const ok = await ensureCheckedOut(bSha);
          if (!ok) return; // FR-9: refusal already surfaced; stop here.
          onMutationStart?.();
          await withGitLockRetryThrowing(() => mutate(aSha));
          onSettled();
        } catch (err) {
          // FR-297/298: a conflicting merge/rebase rejects exactly like a genuine failure — tell
          // the two apart the same way `useCherryPickActions` already does, by re-reading fresh
          // `RepositoryState` and checking whether the operation this call itself started is now
          // genuinely in progress.
          let isExpectedPause = false;
          try {
            const state = unwrap(await api.getState());
            isExpectedPause = state.inProgressOperation === kind;
          } catch {
            // Repo state became unreadable — fall through and surface the original error below.
          }
          if (isExpectedPause) {
            onSettled(); // FR-315: StatusBanner/ConflictResolutionView pick this up from fresh state.
          } else {
            setError(messageOf(err));
            onMutationSettled?.();
          }
        } finally {
          setBusy(false);
        }
      })();
    },
    [api, ensureCheckedOut, onSettled, onMutationStart, onMutationSettled],
  );

  const runMerge = useCallback(
    (aSha: string, bSha: string) =>
      runMutation(aSha, bSha, "merge", async (sha) => {
        unwrap(await api.mergeCommit(sha));
      }),
    [api, runMutation],
  );

  const runRebase = useCallback(
    (aSha: string, bSha: string) =>
      runMutation(aSha, bSha, "rebase", async (sha) => {
        unwrap(await api.rebaseCommitOnto(sha));
      }),
    [api, runMutation],
  );

  const runCherryPick = useCallback(
    (aSha: string, bSha: string) => {
      setBusy(true);
      setError(null);
      void (async () => {
        let ok = false;
        try {
          ok = await ensureCheckedOut(bSha);
        } finally {
          setBusy(false);
        }
        if (!ok) return; // FR-9: refusal already surfaced; no cherry-pick attempted.
        cherryPick([aSha]); // FR-311: delegates to the live `useCherryPickActions` instance.
      })();
    },
    [ensureCheckedOut, cherryPick],
  );

  return {
    runMerge,
    runRebase,
    runCherryPick,
    busy,
    error,
    dismissError: () => setError(null),
  };
}
