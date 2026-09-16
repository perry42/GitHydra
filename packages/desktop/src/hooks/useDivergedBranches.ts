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
 * specs/online-sync-fetch.md FR-326: the set of local branch names currently diverged (ahead > 0
 * AND behind > 0) from their configured upstream, as of the last fetch — feeds the commit graph's
 * ref-chip warning glyph (`CommitGraph`'s `divergedBranchNames` prop). Deliberately its own small,
 * independent `listBranches()` read rather than sharing `useBranchList`'s state/search/pagination
 * machinery: this hook only ever needs one derived `Set<string>`, and this codebase's existing
 * pattern is for each consumer to fetch what it needs independently (`BranchesPanel` already makes
 * its own separate `listBranches()` call) rather than lifting one shared branch-list hook to `App`.
 */
export function useDivergedBranches({ api, enabled, reloadToken }: UseDivergedBranchesOptions): ReadonlySet<string> {
  const [names, setNames] = useState<ReadonlySet<string>>(() => new Set());
  const generationRef = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setNames(new Set());
      return;
    }
    const generation = ++generationRef.current;
    void (async () => {
      try {
        const branches = unwrap(await api.listBranches());
        if (generation !== generationRef.current) return;
        setNames(new Set(branches.filter((b) => (b.ahead ?? 0) > 0 && (b.behind ?? 0) > 0).map((b) => b.name)));
      } catch {
        // Best-effort decoration only — a failed read here just means no diverged glyphs render
        // this pass, never a user-visible error (BranchesPanel's own independent `listBranches()`
        // call is what surfaces a real failure to the user).
        if (generation === generationRef.current) setNames(new Set());
      }
    })();
    // Deliberately re-running on `reloadToken` changing, not just `enabled`/`api` — see doc comment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, enabled, reloadToken]);

  return names;
}
