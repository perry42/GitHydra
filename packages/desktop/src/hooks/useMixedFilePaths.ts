// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkingDirectoryChanges } from "@githydra/git-core";
import type { GitHydraApi } from "../../shared/ipcContract";
import { fileStagingSummary } from "../lib/combinedDiff";

/**
 * specs/hunk-line-staging.md FR-482 / changes-panel-layout.md FR-488: which partly staged files are
 * ELIGIBLE for line-level staging and so collapse to a single "Partly staged" row in Unstaged.
 *
 * Eligibility is only knowable from git-core's combined diff, which costs several git spawns per file, so
 * it is learned lazily and narrowly: only a path that appears in BOTH Staged and Unstaged as "modified" can
 * be mixed at all (a path in one list is wholly staged or wholly unstaged), so only those are queried.
 * Typically that is a handful of files, not hundreds; the queries run 4 at a time, at most
 * MAX_CANDIDATES per pass, and a path with no verdict yet simply stays in both sections exactly as today.
 * Verdicts are cached per path and only replaced when a newer answer arrives (no flicker between refreshes).
 * The currently open file's verdict comes free from the diff already on screen (`known`), which also
 * avoids a one-frame "appears in Staged" flash right after a toggle.
 */
const CONCURRENCY = 4;
export const MAX_MIXED_CANDIDATES = 100;

export interface KnownMixedVerdict {
  path: string;
  mixed: boolean;
}

export function mixedCandidatePaths(changes: WorkingDirectoryChanges | null): string[] {
  if (!changes || changes.staged.length === 0 || changes.unstaged.length === 0) return [];
  const unstaged = new Set(changes.unstaged.filter((e) => e.status === "modified").map((e) => e.path));
  return changes.staged
    .filter((e) => e.status === "modified" && unstaged.has(e.path))
    .map((e) => e.path)
    .slice(0, MAX_MIXED_CANDIDATES);
}

export function useMixedFilePaths(
  api: GitHydraApi,
  changes: WorkingDirectoryChanges | null,
  known: KnownMixedVerdict | null,
): ReadonlySet<string> {
  const [verdicts, setVerdicts] = useState<ReadonlyMap<string, boolean>>(new Map());
  const seqRef = useRef(new Map<string, number>());

  const candidates = useMemo(() => mixedCandidatePaths(changes), [changes]);
  const candidatesKey = candidates.join("\u0000");

  useEffect(() => {
    let cancelled = false;
    const live = new Set(candidates);
    setVerdicts((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const path of prev.keys()) {
        if (!live.has(path)) {
          next.delete(path);
          changed = true;
        }
      }
      return changed ? next : prev;
    });

    const queue = candidates.filter((p) => p !== known?.path);
    const worker = async () => {
      for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
        const seq = (seqRef.current.get(path) ?? 0) + 1;
        seqRef.current.set(path, seq);
        let mixed = false;
        try {
          const res = await api.getCombinedFileDiff(path);
          if (res.ok && res.data.mode === "combined") {
            const s = fileStagingSummary(res.data.hunks);
            mixed = s.anyStaged && s.anyUnstaged;
          }
        } catch {
          mixed = false; // any failure: leave the file in both sections, as before
        }
        if (cancelled || seqRef.current.get(path) !== seq) continue;
        setVerdicts((prev) => (prev.get(path) === mixed ? prev : new Map(prev).set(path, mixed)));
      }
    };
    for (let i = 0; i < Math.min(CONCURRENCY, queue.length); i++) void worker();
    return () => {
      cancelled = true;
    };
    // `changes` identity (via candidates) re-queries after every refresh; `known` is deliberately not a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, changes, candidatesKey]);

  return useMemo(() => {
    const out = new Set<string>();
    for (const path of candidates) {
      const mixed = known && known.path === path ? known.mixed : verdicts.get(path) === true;
      if (mixed) out.add(path);
    }
    return out;
  }, [candidates, verdicts, known]);
}
