import { useCallback, useRef, useState } from "react";
import type { CommitLogFilter } from "@githydra/git-core";
import { unwrap } from "./gitHydraClient";
import type { UseRepositoryGraphResult } from "./useRepositoryGraph";

/**
 * specs/multi-repo-tabs.md: which of the right-hand rails is showing. Mirrors App.tsx's own
 * `RightPanel` union (kept here, not in App.tsx, so this hook has no dependency on App.tsx and
 * App.tsx imports the type from here instead of re-declaring it — a single source of truth).
 */
export type RightPanel = "none" | "commit" | "changes" | "branches";

/**
 * Must-have 3/6: what's actually guaranteed to survive a tab being backgrounded and reactivated
 * — everything else `useRepositoryGraph` tracks (rows, refs, working-dir status, etc.) is cheap
 * to refetch fresh on activation (Must-have 6's "scroll position is not guaranteed") and isn't
 * worth holding onto for a tab nobody is looking at.
 */
export interface RepoTabRemembered {
  selectedSha: string | null;
  filter: CommitLogFilter;
  showAllRefs: boolean;
  rightPanel: RightPanel;
}

export interface RepoTab {
  id: string;
  repoPath: string;
  remembered: RepoTabRemembered;
}

function emptyRemembered(rightPanel: RightPanel): RepoTabRemembered {
  return { selectedSha: null, filter: {}, showAllRefs: false, rightPanel };
}

export interface UseRepoTabsOptions {
  /** The single, App-owned `useRepositoryGraph()` instance — Architecture decision option (B):
   * exactly one tab's data is ever "live" in it at a time, matching the one live Electron-side
   * `RepoSession`. */
  graph: UseRepositoryGraphResult;
  rightPanel: RightPanel;
  /** The *non-persisting* setter (App.tsx's raw `useState` setter, not the one that writes to
   * `githydra:layout:rightPanel`) — switching/creating tabs must never overwrite the user's real
   * global panel preference (Must-have 10's "not independently persisted per tab"), only a real
   * user-driven toggle should. */
  setRightPanel: (value: RightPanel) => void;
  /** Must-have 10: seeds a brand-new tab's `rightPanel` from the persisted global preference. */
  getSeedRightPanel: () => RightPanel;
}

export interface UseRepoTabsResult {
  tabs: RepoTab[];
  activeTabId: string | null;
  /** Must-have 2/AC2: "+ New tab" — opens the repo-picker dialog into a brand-new tab, leaving
   * every other tab untouched. No-ops if the dialog is canceled. */
  openNewTab: () => Promise<void>;
  /** Must-have 2/AC3: `Toolbar`'s existing "Open repository…" control — replaces only the
   * currently active tab's repo (or, if no tab exists yet, bootstraps the first one — there is
   * nothing to "replace" before any tab exists). No-ops if the dialog is canceled. */
  openRepoInActiveTab: () => Promise<void>;
  /** Must-have 4/5/7: switches the one live backend session to a different tab's repo path and
   * replays that tab's remembered selection/filter/panel once it's loaded. */
  activateTab: (id: string) => Promise<void>;
  /** Must-have 8/AC8/AC9: discards a tab's state permanently; activates an adjacent tab if the
   * closed tab was active and others remain, else returns to the idle empty state. */
  closeTab: (id: string) => void;
  /**
   * Defense in depth for the fast-tab-switching race (the authoritative fix is a generation
   * guard in the main process's `RepoSession.open()`): true for the *entire* duration of an
   * `activateTab`/`openNewTab`/`openRepoInActiveTab` call, or a `closeTab`-triggered reactivation
   * — not just while `graph.status === "opening"`, which flips back to `"ready"` before this
   * hook has finished replaying the target tab's remembered `showAllRefs`/`selectedSha`/
   * `rightPanel`. Callers (`TabBar`) should use this to make every other tab's activate/close
   * controls non-interactive while a switch is in flight, so a fast second click/keypress can't
   * queue up a second overlapping switch — and the same flag also blocks it internally even if
   * the UI somehow lets one through.
   */
  switching: boolean;
}

export function useRepoTabs({
  graph,
  rightPanel,
  setRightPanel,
  getSeedRightPanel,
}: UseRepoTabsOptions): UseRepoTabsResult {
  const [tabs, setTabs] = useState<RepoTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const idSeqRef = useRef(0);
  const tabsRef = useRef<RepoTab[]>([]);
  tabsRef.current = tabs;
  // Kept in sync with `activeTabId` synchronously (not via useEffect, which only flushes after a
  // render) so a second call arriving before React has re-rendered (e.g. a fast double-click on
  // two different tabs) still sees the just-updated "current" id rather than a stale one.
  const activeTabIdRef = useRef<string | null>(null);
  // Fast-tab-switching race defense in depth (see `switching`'s doc comment on the result type):
  // a ref (checked/set synchronously, before any await, same reasoning as `activeTabIdRef` above)
  // so a second call arriving in the same tick — before React has re-rendered `switching` — is
  // still blocked. `switching` (state) exists purely so `TabBar` can render the disabled look.
  const switchingRef = useRef(false);
  const [switching, setSwitching] = useState(false);
  const beginSwitch = useCallback(() => {
    if (switchingRef.current) return false;
    switchingRef.current = true;
    setSwitching(true);
    return true;
  }, []);
  const endSwitch = useCallback(() => {
    switchingRef.current = false;
    setSwitching(false);
  }, []);

  const snapshotActiveTab = useCallback(() => {
    const id = activeTabIdRef.current;
    if (!id) return;
    setTabs((prev) =>
      prev.map((t) =>
        t.id === id
          ? {
              ...t,
              remembered: {
                selectedSha: graph.selectedSha,
                filter: graph.filter,
                showAllRefs: graph.showAllRefs,
                rightPanel,
              },
            }
          : t,
      ),
    );
  }, [graph.selectedSha, graph.filter, graph.showAllRefs, rightPanel]);

  const setActive = useCallback((id: string | null) => {
    activeTabIdRef.current = id;
    setActiveTabId(id);
  }, []);

  const openNewTab = useCallback(async () => {
    // See `switching`'s doc comment: ignore (don't queue) a second overlapping switch/open —
    // `TabBar` disabling itself during a switch is the primary defense, this is the fallback.
    if (!beginSwitch()) return;
    try {
      const path = unwrap(await graph.api.openRepoDialog());
      if (!path) return;
      snapshotActiveTab();
      const seeded = getSeedRightPanel();
      const tab: RepoTab = { id: `tab-${++idSeqRef.current}`, repoPath: path, remembered: emptyRemembered(seeded) };
      setTabs((prev) => [...prev, tab]);
      setActive(tab.id);
      setRightPanel(seeded);
      await graph.openRepo(path);
    } finally {
      endSwitch();
    }
  }, [graph, snapshotActiveTab, getSeedRightPanel, setActive, setRightPanel, beginSwitch, endSwitch]);

  const openRepoInActiveTab = useCallback(async () => {
    if (!beginSwitch()) return;
    try {
      const path = unwrap(await graph.api.openRepoDialog());
      if (!path) return;
      const id = activeTabIdRef.current;
      if (!id) {
        // Bootstrap: no tab exists yet, so there is nothing to "replace" — this is functionally a
        // new tab (Must-have 2's replace behavior only makes sense once a tab already exists).
        const seeded = getSeedRightPanel();
        const tab: RepoTab = { id: `tab-${++idSeqRef.current}`, repoPath: path, remembered: emptyRemembered(seeded) };
        setTabs((prev) => [...prev, tab]);
        setActive(tab.id);
        setRightPanel(seeded);
        await graph.openRepo(path);
        return;
      }
      // AC3: replace only the active tab's repo — its remembered selection/filter reset the same
      // way opening any different repo already resets them today; `rightPanel` itself is left as-is
      // live (matching today's single-repo behavior — opening a new repo never used to force-close
      // panels), and the tab's remembered copy is kept in sync with that current live value so a
      // later switch away-and-back doesn't resurrect a stale panel choice from before the replace.
      setTabs((prev) =>
        prev.map((t) => (t.id === id ? { ...t, repoPath: path, remembered: emptyRemembered(rightPanel) } : t)),
      );
      await graph.openRepo(path);
    } finally {
      endSwitch();
    }
  }, [graph, getSeedRightPanel, setActive, setRightPanel, rightPanel, beginSwitch, endSwitch]);

  const activateTab = useCallback(
    async (id: string) => {
      if (id === activeTabIdRef.current) return;
      if (!beginSwitch()) return;
      try {
        const target = tabsRef.current.find((t) => t.id === id);
        if (!target) return;
        snapshotActiveTab();
        setActive(id);
        await graph.openRepo(target.repoPath, target.remembered.filter);
        graph.setShowAllRefs(target.remembered.showAllRefs);
        if (target.remembered.selectedSha) graph.selectCommit(target.remembered.selectedSha);
        setRightPanel(target.remembered.rightPanel);
      } finally {
        endSwitch();
      }
    },
    [graph, snapshotActiveTab, setActive, setRightPanel, beginSwitch, endSwitch],
  );

  const closeTab = useCallback(
    (id: string) => {
      // A switch already in flight owns the live session right now — ignore a close arriving
      // mid-switch rather than let its reactivation (below) race the in-flight one. `TabBar`
      // disables close controls during a switch too; this is the fallback for anything that gets
      // through anyway (e.g. the Delete/Backspace keyboard path).
      if (switchingRef.current) return;
      const current = tabsRef.current;
      const idx = current.findIndex((t) => t.id === id);
      if (idx === -1) return;
      const wasActive = id === activeTabIdRef.current;
      const remaining = current.filter((t) => t.id !== id);
      setTabs(remaining);

      if (!wasActive) return;

      // Must-have 8: activate an adjacent tab if one exists — prefer the tab that slid into this
      // index (i.e. what was "the next tab"), else the one before it.
      const next = remaining[idx] ?? remaining[idx - 1] ?? null;
      if (next) {
        // Always succeeds here — the top-of-function check above already guarantees no switch is
        // in flight, and nothing else can start one between that check and here (synchronous).
        beginSwitch();
        setActive(next.id);
        void (async () => {
          try {
            await graph.openRepo(next.repoPath, next.remembered.filter);
            graph.setShowAllRefs(next.remembered.showAllRefs);
            if (next.remembered.selectedSha) graph.selectCommit(next.remembered.selectedSha);
            setRightPanel(next.remembered.rightPanel);
          } finally {
            endSwitch();
          }
        })();
      } else {
        // AC9: no tabs left — back to the existing idle empty state, window stays open.
        setActive(null);
        setRightPanel("none");
        void graph.closeRepo();
      }
    },
    [graph, setActive, setRightPanel, beginSwitch, endSwitch],
  );

  return { tabs, activeTabId, openNewTab, openRepoInActiveTab, activateTab, closeTab, switching };
}
