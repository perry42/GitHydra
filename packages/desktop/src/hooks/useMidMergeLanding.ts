// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef } from "react";
import type { RepositoryState } from "@githydra/git-core";
import { decideLanding, operationKey } from "../lib/midMergeLanding";

export interface UseMidMergeLandingOptions {
  tabId: string | null;
  repoState: RepositoryState | null;
  /** null until the working-directory status for this open has loaded. */
  conflicted: number | null;
  /** Repo ready and no tab switch in flight, so the restored right panel is already in place. */
  settled: boolean;
  openSequence: number;
  changesOpen: boolean;
  editorDirty: () => boolean;
  /** Must itself route through dirtyGuard.guard (specs/edit-in-diff.md FR-535). */
  openChanges: () => void;
}

/** specs/mid-merge-landing.md FR-580: open Changes on the first conflict when a repo opens or a tab activates mid-operation. */
export function useMidMergeLanding(o: UseMidMergeLandingOptions): void {
  const handledByTab = useRef(new Map<string, Set<string>>());
  const evaluatedSeq = useRef<number | null>(null);
  const latest = useRef(o);
  latest.current = o;

  useEffect(() => {
    if (!o.settled || o.conflicted === null || !o.tabId || !o.repoState) return;
    if (evaluatedSeq.current === o.openSequence) return;
    evaluatedSeq.current = o.openSequence;
    const key = operationKey(o.repoState);
    const handled = handledByTab.current.get(o.tabId);
    const d = decideLanding({
      handled,
      key,
      conflicted: o.conflicted,
      changesOpen: o.changesOpen,
      editorDirty: o.editorDirty(),
    });
    if (d.markHandled && key) {
      const set = handled ?? new Set<string>();
      set.add(key);
      handledByTab.current.set(o.tabId, set);
    }
    if (d.open) latest.current.openChanges();
    // Evaluated once per open/activation (openSequence), not on every conflict-count change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.settled, o.conflicted, o.tabId, o.openSequence, o.repoState]);
}
