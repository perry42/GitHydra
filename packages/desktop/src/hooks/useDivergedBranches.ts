// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import type { GitHydraApi } from "../../shared/ipcContract";
import { unwrap } from "./gitHydraClient";

export interface UseDivergedBranchesOptions {
  api: GitHydraApi;
  /** Only fetches while a repo is genuinely open — mirrors every other "repo open" gate this
   * codebase already uses (e.g. `BranchesPanel`'s own toggle visibility). */
  enabled: boolean;
  /** Bumped whenever branch/ref state might have changed (a branch mutation, a fetch completing,
   * an external-change refresh) — the same `reloadToken` convention `useBranchList` already
   * established, so this hook refetches at exactly the same moments `BranchesPanel`'s own list
   * would. */
  reloadToken?: number;
}

/**
 * specs/ref-chip-synced-upstream-merge.md FR-2: `diverged` (specs/online-sync-fetch.md FR-326) and
 * `syncedUpstream` are both derived from the SAME `listBranches()` read below — no second IPC call.
 * `syncedUpstream` maps a local branch name to its upstream's short name (e.g. `"origin/main"`) for
 * every branch that's "exactly synced": a real, non-gone upstream configured, and
 * `ahead === 0 && behind === 0` (FR-1).
 */
export interface DivergedAndSyncedBranches {
  diverged: ReadonlySet<string>;
  syncedUpstream: ReadonlyMap<string, string>;
}

const EMPTY: DivergedAndSyncedBranches = { diverged: new Set(), syncedUpstream: new Map() };

/**
 * specs/online-sync-fetch.md FR-326: the set of local branch names currently diverged (ahead > 0
 * AND behind > 0) from their configured upstream, as of the last fetch — feeds the commit graph's
 * ref-chip warning glyph (`CommitGraph`'s `divergedBranchNames` prop).
 * specs/ref-chip-synced-upstream-merge.md FR-1/FR-2: also the set of branches EXACTLY synced with a
 * real upstream (`ahead === 0 && behind === 0`, upstream configured and not gone) — feeds the ref-
 * chip local+remote merge. Deliberately its own small, independent `listBranches()` read rather
 * than sharing `useBranchList`'s state/search/pagination machinery: this hook only ever needs these
 * two small derived collections, and this codebase's existing pattern is for each consumer to fetch
 * what it needs independently (`BranchesPanel` already makes its own separate `listBranches()`
 * call) rather than lifting one shared branch-list hook to `App`.
 */
export function useDivergedBranches({
  api,
  enabled,
  reloadToken,
}: UseDivergedBranchesOptions): DivergedAndSyncedBranches {
  const [result, setResult] = useState<DivergedAndSyncedBranches>(() => EMPTY);
  const generationRef = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setResult(EMPTY);
      return;
    }
    const generation = ++generationRef.current;
    void (async () => {
      try {
        const branches = unwrap(await api.listBranches());
        if (generation !== generationRef.current) return;
        const diverged = new Set(
          branches.filter((b) => (b.ahead ?? 0) > 0 && (b.behind ?? 0) > 0).map((b) => b.name),
        );
        const syncedUpstream = new Map(
          branches
            .filter((b) => b.upstreamName != null && !b.upstreamGone && (b.ahead ?? 0) === 0 && (b.behind ?? 0) === 0)
            .map((b) => [b.name, b.upstreamName as string]),
        );
        setResult({ diverged, syncedUpstream });
      } catch {
        // Best-effort decoration only — a failed read here just means no diverged glyphs/merged
        // chips render this pass, never a user-visible error (BranchesPanel's own independent
        // `listBranches()` call is what surfaces a real failure to the user).
        if (generation === generationRef.current) setResult(EMPTY);
      }
    })();
    // Deliberately re-running on `reloadToken` changing, not just `enabled`/`api` — see doc comment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, enabled, reloadToken]);

  return result;
}
