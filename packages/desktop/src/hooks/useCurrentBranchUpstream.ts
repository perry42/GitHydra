// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import type { GitHydraApi } from "../../shared/ipcContract";
import { unwrap } from "./gitHydraClient";

export interface UseCurrentBranchUpstreamOptions {
  api: GitHydraApi;
  /**
   * Only reads while a repo is genuinely, fully open — the same `graph.status === "ready"` gate
   * `useDivergedBranches` already uses, and NOT merely "does `graph.repoState.currentBranch` have
   * a value yet." Those two are deliberately different moments: `repoState` (and therefore
   * `currentBranch`) is already populated as soon as `openRepoCancellable` itself resolves, but
   * the underlying `RepoSession` doesn't promote that repo to "live" (i.e. `session.getOpenRepo()`
   * stops throwing "No repository is open") until the LATER `commitOpenRepo` step of that same
   * open sequence finishes (`repo-open-feedback-fixes.md` FR-197/FR-199's staged-then-committed
   * design). Gating on `currentBranch` alone raced that window in a real app launch: this hook's
   * `listBranches()` call landed inside it, threw, and — because nothing else ever re-triggers the
   * effect once `currentBranch` stops changing — permanently stuck the Pull button on "Checking
   * this branch's upstream configuration…" for the rest of the session. Caught via
   * `App.pull.e2e.test.tsx` (a real `RepoSession`, not a mock, which has no such staged/committed
   * distinction to race).
   */
  enabled: boolean;
  /** The current branch's short name, or `null` for a bare repo/detached HEAD/unborn branch —
   * none of which have anything to look up here (FR-343's Pull disabled-reason logic already
   * covers those cases without needing this hook's result). */
  currentBranch: string | null;
  /** Bumped whenever branch/ref state might have changed (a branch mutation, a fetch completing,
   * an external-change refresh) — the same `reloadToken` convention `useDivergedBranches` already
   * established, so this stays correct without its own bespoke invalidation. */
  reloadToken?: number;
}

/**
 * specs/online-sync-pull.md FR-343: whether the CURRENT branch has a configured upstream, feeding
 * the Pull button's disabled-with-reason state (`lib/pullEligibility.ts`). Its own small,
 * independent `listBranches()` read — same "each consumer fetches what it needs independently"
 * convention `useDivergedBranches`'s own doc comment already established for this codebase — never
 * a live git call of its own; `LocalBranchInfo.upstreamName` already reflects the last fetch's own
 * on-disk remote-tracking ref (FR-33's doc comment), so this is a plain read, not a network call.
 *
 * Resolves to `"loading"` before `enabled` is true, for the initial window before the first read
 * lands, or while `currentBranch` is `null` — see `computePullDisabledReason`'s own doc comment
 * for why that's treated as "disable with a specific reason," not "wrongly enabled."
 */
export function useCurrentBranchUpstream({
  api,
  enabled,
  currentBranch,
  reloadToken,
}: UseCurrentBranchUpstreamOptions): boolean | "loading" {
  const [hasUpstream, setHasUpstream] = useState<boolean | "loading">("loading");
  const generationRef = useRef(0);

  useEffect(() => {
    if (!enabled || !currentBranch) {
      setHasUpstream("loading");
      return;
    }
    const generation = ++generationRef.current;
    setHasUpstream("loading");
    void (async () => {
      try {
        const branches = unwrap(await api.listBranches());
        if (generation !== generationRef.current) return;
        const match = branches.find((b) => b.name === currentBranch);
        setHasUpstream(Boolean(match?.upstreamName));
      } catch {
        // Best-effort only — a failed read here just means Pull stays disabled with the "still
        // loading" reason a moment longer, never a user-visible error of its own (the Branches
        // panel's own independent `listBranches()` call is what surfaces a real failure).
        if (generation === generationRef.current) setHasUpstream("loading");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, enabled, currentBranch, reloadToken]);

  return hasUpstream;
}
