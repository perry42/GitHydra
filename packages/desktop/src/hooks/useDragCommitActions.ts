// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useMemo, useState } from "react";
import type { RepositoryState } from "@githydra/git-core";
import type { GitHydraApi } from "../../shared/ipcContract";
import { localBranchNameOf } from "../lib/dragCommitMenu";
import { sanitizeDisplayText } from "../lib/sanitizeDisplayText";
import { unwrap, withGitLockRetryThrowing } from "./gitHydraClient";
import {
  cancelPrompt,
  createGuardedCheckout,
  HeadChangedDuringGuardError,
  type GuardContext,
  type GuardedCheckout,
  type OrphanGuardAction,
} from "../lib/guardedCheckout";

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
  /** specs/branch-panel-drag-merge.md FR-430: the app-wide orphan guard (see `useBranchActions`'s
   * option of the same name; omitted only by standalone test harnesses). */
  guardedCheckout?: GuardedCheckout;
}

export interface UseDragCommitActionsResult {
  /** FR-312: FR-309's checkout-if-needed, then `mergeCommit(aSha)`. */
  runMerge: (aSha: string, bSha: string, targetBranch?: string) => void;
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

function dragDescription(action: OrphanGuardAction, a: string | undefined, b: string): string {
  // The target label can be a repo-controlled branch name: strip bidi/invisible characters (FR-430).
  b = sanitizeDisplayText(b);
  const src = a ?? "the dragged commit";
  const verb = action === "rebase" ? "Rebasing" : action === "cherry-pick" ? "Cherry-picking" : "Merging";
  const prep = action === "rebase" ? "onto" : action === "cherry-pick" ? "onto" : "into";
  return `${verb} ${src} ${prep} ${b} needs to check out ${b} first.`;
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
  guardedCheckout,
}: UseDragCommitActionsOptions): UseDragCommitActionsResult {
  const fallbackGuard = useMemo(() => createGuardedCheckout({ api, prompt: cancelPrompt }), [api]);
  const guard = guardedCheckout ?? fallbackGuard;
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
    async (bSha: string, targetBranch?: string, action: OrphanGuardAction = "merge", aSha?: string): Promise<boolean> => {
      // An explicit `targetBranch` (a chip-onto-chip drop) is checked against the CURRENT BRANCH,
      // not just the sha — two branches can share a commit, so `headSha === bSha` alone would wrongly
      // skip switching to the branch the user actually dropped on.
      if (targetBranch !== undefined) {
        if (!repoState?.isDetachedHead && repoState?.currentBranch === targetBranch) return true;
      } else if (repoState?.headSha === bSha) return true;
      let gateOpen = false;
      try {
        const commit = targetBranch !== undefined ? null : unwrap(await api.getCommit(bSha));
        const localBranch = targetBranch ?? localBranchNameOf(commit ?? undefined);
        // FR-430: the guard's dialog (drag copy: "Merging A into B needs to check out B first.")
        // may leave a detached HEAD's commits behind; Cancel aborts the whole drag, nothing changed.
        const bLabel = localBranch ?? bSha.slice(0, 7);
        const context: GuardContext = { action, description: dragDescription(action, aSha?.slice(0, 7), bLabel) };
        const guardOptions = {
          context,
          onMutationStart: () => {
            gateOpen = true;
            onMutationStart?.();
          },
          onMutationSettled,
          retryOnLock: true,
        };
        const outcome = localBranch
          ? await guard.switchBranch(localBranch, guardOptions)
          : await guard.switchToCommit(bSha, guardOptions);
        if (outcome.cancelled) return false; // deliberate user abort: no error, no merge/rebase/pick.
        onSettled(); // FR-314: refresh after the checkout half, regardless of what follows it.
        return true;
      } catch (err) {
        setError(messageOf(err));
        if (gateOpen && !(err instanceof HeadChangedDuringGuardError)) onMutationSettled?.();
        return false;
      }
    },
    [api, guard, repoState, onSettled, onMutationStart, onMutationSettled],
  );

  const runMutation = useCallback(
    (
      aSha: string,
      bSha: string,
      kind: "merge" | "rebase",
      mutate: (sha: string) => Promise<void>,
      targetBranch?: string,
    ) => {
      setBusy(true);
      setError(null);
      void (async () => {
        try {
          const ok = await ensureCheckedOut(bSha, targetBranch, kind, aSha);
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
    (aSha: string, bSha: string, targetBranch?: string) =>
      runMutation(
        aSha,
        bSha,
        "merge",
        async (sha) => {
          unwrap(await api.mergeCommit(sha));
        },
        targetBranch,
      ),
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
          ok = await ensureCheckedOut(bSha, undefined, "cherry-pick", aSha);
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
