// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useRef, useState } from "react";
import type { CommitLogFilter } from "@githydra/git-core";
import { unwrap } from "./gitHydraClient";
import type { UseRepositoryGraphResult } from "./useRepositoryGraph";

/**
 * specs/multi-repo-tabs.md: which of the right-hand rails is showing. Mirrors App.tsx's own
 * `RightPanel` union (kept here, not in App.tsx, so this hook has no dependency on App.tsx and
 * App.tsx imports the type from here instead of re-declaring it — a single source of truth).
 *
 * design-pass "Branches panel relocation": "branches" was removed — the Branches panel is now a
 * persistent left sidebar (`BranchesPanel.tsx`), not one of these mutually-exclusive right-hand
 * rails, so it has no `RightPanel` value of its own and nothing here needs to remember it.
 */
export type RightPanel = "none" | "commit" | "changes" | "stashes";

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

/**
 * specs/repo-list.md AC2/AC4/AC6: the outcome of a recent-repo-list click, distinguishing the
 * four cases a caller (`EmptyState`) needs to react to differently —
 *  - `"opened"`: a fresh tab (or the active tab's repo) now shows this path.
 *  - `"activated-existing"`: AC4's dedup fired — an already-open tab was focused instead.
 *  - `"not-found"`: AC6 — the path failed to open; nothing navigated, show the inline state.
 *  - `"cancelled"`: the in-flight attempt was cancelled (e.g. via the opening spinner's Cancel) or
 *    a second overlapping switch was ignored — treated the same as a dismissed action, no error.
 */
export type RecentOpenResult = "opened" | "activated-existing" | "not-found" | "cancelled";

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
  /**
   * specs/repo-list.md Must-have 2/3 (revised IA): `TabBar`'s plain "+ New tab" button — does
   * *not* open any dialog itself. It snapshots the currently active tab's remembered state (if
   * any), deactivates it (`activeTabId` becomes `null`), and tears down the one live backend
   * session — landing on the idle "No repository open" screen, exactly like the very first launch,
   * so that screen (not a caret/popover) is the single place a path actually gets opened from (see
   * `openNewTab`/`openRecentInNewTab` below, both reachable from `EmptyState`). A no-op if already
   * showing that landing screen (nothing to deactivate).
   */
  newTab: () => Promise<void>;
  /**
   * specs/repo-list.md Must-have 2/3/4, AC2/AC5 (revised IA): `EmptyState`'s "Open a repository"
   * action — the landing screen's only entry point for a manually-browsed path (reachable both as
   * the very first tab, and from the blank tab `newTab` above creates). Opens the native dialog;
   * if the resolved path is already open in any existing tab this session, focuses that tab instead
   * of creating a duplicate (AC5's global dedup), otherwise opens it into a brand-new tab. No-ops
   * if the dialog is canceled.
   */
  openNewTab: () => Promise<void>;
  /** Must-have 4/5/7: switches the one live backend session to a different tab's repo path and
   * replays that tab's remembered selection/filter/panel once it's loaded. */
  activateTab: (id: string) => Promise<void>;
  /** Must-have 8/AC8/AC9: discards a tab's state permanently; activates an adjacent tab if the
   * closed tab was active and others remain, else returns to the idle empty state. */
  closeTab: (id: string) => void;
  /** specs/repo-list.md Must-have 3/AC2/AC4: `EmptyState`'s "Recent repositories" click — opens
   * `path` into a new tab, unless it's already open in an existing tab this session (AC4), in
   * which case that tab is focused instead. */
  openRecentInNewTab: (path: string) => Promise<RecentOpenResult>;
  /**
   * Defense in depth for the fast-tab-switching race (the authoritative fix is a generation
   * guard in the main process's `RepoSession.open()`): true for the *entire* duration of a
   * `newTab`/`activateTab`/`openNewTab` call, or a `closeTab`-triggered reactivation — not just
   * while `graph.status === "opening"`, which flips back to `"ready"` before this hook has finished
   * replaying the target tab's remembered `showAllRefs`/`selectedSha`/`rightPanel`. Callers
   * (`TabBar`, `EmptyState`) should use this to make every other control non-interactive while a
   * switch is in flight, so a fast second click/keypress can't queue up a second overlapping switch
   * — and the same flag also blocks it internally even if the UI somehow lets one through.
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

  const activateTab = useCallback(
    async (id: string) => {
      if (id === activeTabIdRef.current) return;
      if (!beginSwitch()) return;
      // specs/repo-open-feedback.md FR-168: same reasoning as `openNewTab`'s rollback — `setActive`
      // below is this function's own optimistic bookkeeping, outside anything `graph.openRepo`
      // itself can restore on a cancel.
      const previousActiveId = activeTabIdRef.current;
      try {
        const target = tabsRef.current.find((t) => t.id === id);
        if (!target) return;
        snapshotActiveTab();
        setActive(id);
        const cancelled = await graph.openRepo(target.repoPath, target.remembered.filter);
        if (cancelled) {
          setActive(previousActiveId);
          return;
        }
        graph.setShowAllRefs(target.remembered.showAllRefs);
        if (target.remembered.selectedSha) graph.selectCommit(target.remembered.selectedSha);
        setRightPanel(target.remembered.rightPanel);
      } finally {
        endSwitch();
      }
    },
    [graph, snapshotActiveTab, setActive, setRightPanel, beginSwitch, endSwitch],
  );

  /**
   * specs/repo-list.md Must-have 2/3 (revised IA): `TabBar`'s plain "+ New tab" button — see this
   * function's doc comment on `UseRepoTabsResult`. No dialog, no tab creation here; just hands
   * control back to the (always-rendered) idle landing screen.
   */
  const newTab = useCallback(async () => {
    if (activeTabIdRef.current === null) return; // already showing the landing screen
    if (!beginSwitch()) return;
    try {
      snapshotActiveTab();
      setActive(null);
      setRightPanel("none");
      await graph.closeRepo();
    } finally {
      endSwitch();
    }
  }, [graph, snapshotActiveTab, setActive, setRightPanel, beginSwitch, endSwitch]);

  const openNewTab = useCallback(async () => {
    // See `switching`'s doc comment: ignore (don't queue) a second overlapping switch/open —
    // `EmptyState` disabling itself during a switch is the primary defense, this is the fallback.
    if (!beginSwitch()) return;
    // specs/repo-open-feedback.md FR-168: captured before any of this call's own optimistic
    // bookkeeping below, so a canceled attempt can roll every bit of it back — `graph.openRepo`
    // only restores its own internal state (see `useRepositoryGraph`'s `OpenAttemptSnapshot`), it
    // has no visibility into this hook's tab array/active-tab-id/right-panel state.
    const previousActiveId = activeTabIdRef.current;
    const previousRightPanel = rightPanel;
    try {
      const path = unwrap(await graph.api.openRepoDialog());
      if (!path) return;
      // specs/repo-list.md Must-have 4/AC5 (revised IA — dedup is now global, not recent-list-only):
      // a manually-browsed path already open in any existing tab focuses that tab instead of
      // creating a duplicate — the one gap the recent-list click handlers below didn't have.
      const existing = tabsRef.current.find((t) => t.repoPath === path);
      if (existing) {
        if (existing.id === activeTabIdRef.current) return;
        // Release our own guard before delegating to `activateTab`'s own — see
        // `openRecentInNewTab`'s identical dedup branch below for why this is safe (no yielding
        // point between the two calls, so no actual race window).
        endSwitch();
        await activateTab(existing.id);
        return;
      }
      snapshotActiveTab();
      const seeded = getSeedRightPanel();
      const tab: RepoTab = { id: `tab-${++idSeqRef.current}`, repoPath: path, remembered: emptyRemembered(seeded) };
      setTabs((prev) => [...prev, tab]);
      setActive(tab.id);
      setRightPanel(seeded);
      const cancelled = await graph.openRepo(path);
      if (cancelled) {
        // Undo the optimistic tab creation/activation above — without this, a canceled "Open a
        // repository" attempt leaves a stray tab in the bar (labeled with the never-actually-opened
        // path) that `activateTab` can't even reactivate (it no-ops when `id === activeTabIdRef.current`,
        // which this tab already is).
        setTabs((prev) => prev.filter((t) => t.id !== tab.id));
        setActive(previousActiveId);
        setRightPanel(previousRightPanel);
      }
    } finally {
      endSwitch();
    }
  }, [
    graph,
    snapshotActiveTab,
    getSeedRightPanel,
    setActive,
    setRightPanel,
    rightPanel,
    beginSwitch,
    endSwitch,
    activateTab,
  ]);

  // --- specs/repo-list.md: recent-repo-list-triggered opens (Must-have 3/4, AC2/AC4/AC6) ---

  /**
   * AC6: `graph.openRepo`'s failure path always tears down the previously-live reader before
   * discovering the failure (see its own implementation) and leaves `status: "error"` up — correct
   * for a manual Browse-to-a-bad-path (today's behavior, unchanged, Non-goal), but wrong for a
   * recent-list click: the spec requires the app to stay exactly where it was, with the failure
   * surfaced *inline* on that one list entry, never as the app-wide error screen. Undoing this
   * hook's own tab bookkeeping (done at each call site) isn't enough on its own — the live `graph`
   * itself also needs telling what to actually show again. Mirrors `closeTab`'s own "reactivate the
   * adjacent tab for real, or return to idle if none" pattern for the same reason: the old reader
   * is already gone by this point, so "restore" here means a genuine re-open, not replaying a
   * snapshot (unlike the cancellation path, which `graph.openRepo` itself fully reverses).
   */
  const restoreGraphAfterFailedRecentOpen = useCallback(
    async (previousTab: RepoTab | null) => {
      if (!previousTab) {
        await graph.closeRepo();
        return;
      }
      await graph.openRepo(previousTab.repoPath, previousTab.remembered.filter);
      graph.setShowAllRefs(previousTab.remembered.showAllRefs);
      if (previousTab.remembered.selectedSha) graph.selectCommit(previousTab.remembered.selectedSha);
    },
    [graph],
  );

  const openRecentInNewTab = useCallback(
    async (path: string): Promise<RecentOpenResult> => {
      // AC4 (now global per the repo-list.md IA revision, see `openNewTab`'s identical check): if
      // `path` is already open in *any* tab this session, focus that tab instead of creating a
      // duplicate.
      const existing = tabsRef.current.find((t) => t.repoPath === path);
      if (existing) {
        // security review: a switch already in flight would make `activateTab` itself a silent
        // no-op (its own `beginSwitch()` guard) — checked here first so this call reports
        // "cancelled" (nothing happened) rather than an unconditional "activated-existing" that
        // would make `useRecentOpenRow` treat a swallowed click as a successful one.
        if (switchingRef.current) return "cancelled";
        await activateTab(existing.id);
        return "activated-existing";
      }
      if (!beginSwitch()) return "cancelled";
      // specs/repo-open-feedback.md FR-168-style rollback, extended to also cover a genuine open
      // failure (AC6) — never leave a stray tab in the bar for a path that never actually opened.
      const previousActiveId = activeTabIdRef.current;
      const previousTab = tabsRef.current.find((t) => t.id === previousActiveId) ?? null;
      const previousRightPanel = rightPanel;
      try {
        snapshotActiveTab();
        const seeded = getSeedRightPanel();
        const tab: RepoTab = { id: `tab-${++idSeqRef.current}`, repoPath: path, remembered: emptyRemembered(seeded) };
        setTabs((prev) => [...prev, tab]);
        setActive(tab.id);
        setRightPanel(seeded);
        let failed = false;
        const cancelled = await graph.openRepo(path, {}, (outcome) => {
          if (outcome === "error") failed = true;
        });
        if (cancelled || failed) {
          setTabs((prev) => prev.filter((t) => t.id !== tab.id));
          setActive(previousActiveId);
          setRightPanel(previousRightPanel);
          if (failed) await restoreGraphAfterFailedRecentOpen(previousTab);
          return cancelled ? "cancelled" : "not-found";
        }
        return "opened";
      } finally {
        endSwitch();
      }
    },
    [
      graph,
      snapshotActiveTab,
      getSeedRightPanel,
      setActive,
      setRightPanel,
      rightPanel,
      beginSwitch,
      endSwitch,
      activateTab,
      restoreGraphAfterFailedRecentOpen,
    ],
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
        // specs/repo-open-feedback.md FR-167/168: deliberately NOT wired to roll back on a
        // canceled attempt here, unlike `openNewTab`/`activateTab` above — there is no
        // well-defined "previous tab" to restore to (the tab that was showing before
        // this reactivation is the one the user just deliberately closed). What a cancel here
        // should do instead (reopen the closed tab? fall back to idle? something else?) is a real
        // product decision, not an engineering one — flagged rather than guessed at.
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

  return {
    tabs,
    activeTabId,
    newTab,
    openNewTab,
    activateTab,
    closeTab,
    openRecentInNewTab,
    switching,
  };
}
