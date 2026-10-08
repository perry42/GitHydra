// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useRef, useState } from "react";
import type { CommitLogFilter } from "@githydra/git-core";
import { unwrap } from "./gitHydraClient";
import type { TabGraphCache, UseRepositoryGraphResult } from "./useRepositoryGraph";
import type { DiffableCategory } from "./useChangesPanel";
import { looksLikeSamePath } from "../../shared/pathEquivalence";
import type { DirtyLeaveRegistry } from "./useDirtyLeaveGuard";

/**
 * specs/multi-repo-tabs.md: which right-hand rail is showing. Lives here (not App.tsx) so this hook
 * has no dependency on App.tsx. "branches" isn't a value: the Branches panel is a persistent left sidebar.
 */
export type RightPanel = "none" | "commit" | "changes" | "stashes";

/**
 * specs/remember-last-selected-file.md FR-215: last selected file in the open file-list panel — a bare
 * `path` for DetailPanel's commit list, or `{ category, path }` for ChangesPanel. Tagged by `kind` so
 * one value round-trips through persisted storage unambiguously.
 */
export type RememberedFileSelection =
  | { kind: "commit"; path: string }
  | { kind: "changes"; category: DiffableCategory; path: string };

/** Must-have 3/6: what survives a tab being backgrounded; everything else is cheap to refetch on activation. */
export interface RepoTabRemembered {
  selectedSha: string | null;
  filter: CommitLogFilter;
  showAllRefs: boolean;
  rightPanel: RightPanel;
  /**
   * specs/remember-last-selected-file.md FR-215/FR-216: captured wherever `selectedSha` etc. are
   * (`snapshotActiveTab`). Never cleared once set (so it survives relaunch, AC6); `App.tsx`'s
   * `consumedFileRestoreSeqRef`/`onRestoredFileConsumed` hands it to DetailPanel/ChangesPanel once per
   * real activation (FR-217/218), so a later panel remount never sees a stale value.
   */
  selectedFile: RememberedFileSelection | null;
}

export interface RepoTab {
  id: string;
  repoPath: string;
  remembered: RepoTabRemembered;
}

/**
 * specs/repo-list.md AC2/AC4/AC6: outcome of a recent-repo-list click.
 *  - `"opened"`: a fresh tab (or the active tab's repo) now shows this path.
 *  - `"activated-existing"`: AC4's dedup focused an already-open tab.
 *  - `"not-found"`: AC6 — the open failed; nothing navigated.
 *  - `"cancelled"`: cancelled, or a second overlapping switch was ignored; not an error.
 */
export type RecentOpenResult = "opened" | "activated-existing" | "not-found" | "cancelled";

function emptyRemembered(rightPanel: RightPanel): RepoTabRemembered {
  return { selectedSha: null, filter: {}, showAllRefs: false, rightPanel, selectedFile: null };
}

/** specs/restore-tabs-on-relaunch.md FR-208: persisted tab identity; try/catch-guarded like `useTheme.ts`/`useRecentRepos.ts`. */
export const SESSION_TABS_KEY = "githydra:sessionTabs";

interface PersistedSessionTab {
  repoPath: string;
  remembered: RepoTabRemembered;
}

interface PersistedSession {
  tabs: PersistedSessionTab[];
  /** `null` covers both "no tab was active" (AC6: zero tabs) and AC7's "the blank '+ New tab'
   * landing screen was showing, with other real tabs still open in the background." */
  activeRepoPath: string | null;
}

const RIGHT_PANEL_VALUES: readonly RightPanel[] = ["none", "commit", "changes", "stashes"];
const DIFFABLE_CATEGORY_VALUES: readonly DiffableCategory[] = ["staged", "unstaged", "untracked"];

/** FR-215: `undefined` (session persisted before this field existed) is accepted; `normalizeRemembered` turns it into `null`. */
function isValidRememberedFileSelectionValue(value: unknown): value is RememberedFileSelection | null | undefined {
  if (value === undefined || value === null) return true;
  if (typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.kind === "commit") return typeof v.path === "string";
  if (v.kind === "changes") {
    return typeof v.path === "string" && (DIFFABLE_CATEGORY_VALUES as readonly string[]).includes(v.category as string);
  }
  return false;
}

function isRepoTabRemembered(value: unknown): value is RepoTabRemembered {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.selectedSha === null || typeof v.selectedSha === "string") &&
    typeof v.filter === "object" &&
    v.filter !== null &&
    typeof v.showAllRefs === "boolean" &&
    typeof v.rightPanel === "string" &&
    (RIGHT_PANEL_VALUES as readonly string[]).includes(v.rightPanel) &&
    isValidRememberedFileSelectionValue(v.selectedFile)
  );
}

/** Fills in `selectedFile: null` for a pre-FR-215 persisted object; otherwise pass-through. */
function normalizeRemembered(remembered: RepoTabRemembered): RepoTabRemembered {
  return remembered.selectedFile === undefined ? { ...remembered, selectedFile: null } : remembered;
}

/** FR-208/AC10: never throws — missing/corrupt/unavailable `localStorage` degrades to no session. */
function readPersistedSession(): PersistedSession {
  if (typeof window === "undefined") return { tabs: [], activeRepoPath: null };
  try {
    const raw = window.localStorage?.getItem(SESSION_TABS_KEY);
    if (!raw) return { tabs: [], activeRepoPath: null };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { tabs: [], activeRepoPath: null };
    const obj = parsed as Record<string, unknown>;
    const rawTabs = Array.isArray(obj.tabs) ? obj.tabs : [];
    // Defensive de-dup against tampered storage: two tabs never share a `repoPath` live.
    const seen = new Set<string>();
    const tabs: PersistedSessionTab[] = [];
    for (const t of rawTabs) {
      if (typeof t !== "object" || t === null) continue;
      const tt = t as Record<string, unknown>;
      if (typeof tt.repoPath !== "string" || !tt.repoPath || seen.has(tt.repoPath)) continue;
      seen.add(tt.repoPath);
      tabs.push({
        repoPath: tt.repoPath,
        remembered: isRepoTabRemembered(tt.remembered) ? normalizeRemembered(tt.remembered) : emptyRemembered("none"),
      });
    }
    const activeRepoPath = typeof obj.activeRepoPath === "string" ? obj.activeRepoPath : null;
    return { tabs, activeRepoPath };
  } catch {
    return { tabs: [], activeRepoPath: null };
  }
}

function writePersistedSession(session: PersistedSession): void {
  try {
    window.localStorage?.setItem(SESSION_TABS_KEY, JSON.stringify(session));
  } catch {
    // localStorage unavailable — this session just won't persist across restarts (AC10).
  }
}

/**
 * FR-209: real `RepoTab`s from the persisted session, with fresh ids. Runs synchronously on the very
 * first render (AC1), not via an effect.
 */
function buildInitialSession(): { tabs: RepoTab[]; activeTabId: string | null } {
  const persisted = readPersistedSession();
  const tabs: RepoTab[] = persisted.tabs.map((t, i) => ({
    id: `tab-${i + 1}`,
    repoPath: t.repoPath,
    remembered: t.remembered,
  }));
  const activeTab = persisted.activeRepoPath ? tabs.find((t) => t.repoPath === persisted.activeRepoPath) : undefined;
  return { tabs, activeTabId: activeTab ? activeTab.id : null };
}

export interface UseRepoTabsOptions {
  /** The single App-owned `useRepositoryGraph()`; only one tab's data is live in it at a time (one `RepoSession`). */
  graph: UseRepositoryGraphResult;
  rightPanel: RightPanel;
  /** The *non-persisting* setter: tab switches must not overwrite the global panel preference (Must-have 10). */
  setRightPanel: (value: RightPanel) => void;
  /** Must-have 10: seeds a brand-new tab's `rightPanel` from the persisted global preference. */
  getSeedRightPanel: () => RightPanel;
  /**
   * specs/remember-last-selected-file.md FR-216: App-owned live selection in the open file-list panel,
   * read by `snapshotActiveTab`. Optional (default `null`) so hook tests can omit it.
   */
  selectedFile?: RememberedFileSelection | null;
  /** Setter for the same state, replayed wherever `setRightPanel` is so a snapshot never captures the previous tab's value. Optional. */
  setSelectedFile?: (value: RememberedFileSelection | null) => void;
  /**
   * specs/edit-in-diff.md FR-535: asked before the paths this hook starts on its own (a picked or cloned repo opened into a
   * new tab, or an existing tab focused by dedup), where App cannot prompt up front. activate/close/new tab are guarded by App.
   */
  dirtyGuard?: DirtyLeaveRegistry;
}

export interface UseRepoTabsResult {
  tabs: RepoTab[];
  activeTabId: string | null;
  /**
   * specs/repo-list.md Must-have 2/3: "+ New tab" — opens no dialog. Snapshots the active tab,
   * deactivates it (`activeTabId` becomes `null`) and tears down the live session, landing on the idle
   * screen where paths are opened (`openNewTab`/`openRecentInNewTab`). No-op if already there.
   */
  newTab: () => Promise<void>;
  /**
   * specs/repo-list.md Must-have 2/3/4, AC2/AC5: `EmptyState`'s "Open a repository". Opens the native
   * dialog; a path already open in any tab focuses it (AC5 global dedup), else opens a new tab. No-op
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
   * True for the entire duration of a `newTab`/`activateTab`/`openNewTab` call or a `closeTab`
   * reactivation (not just `graph.status === "opening"`, which flips to `"ready"` before remembered
   * state is replayed). Callers disable other controls on it; it also blocks overlapping switches
   * internally.
   *
   * specs/repo-open-feedback-fixes.md FR-206/FR-207: the lock is deliberately this broad. The main
   * process has ONE live `RepoSession` (`electron/repoSession.ts`) shared by every tab, and its
   * `generation` counter only picks which concurrent `open()` result wins — it doesn't protect another
   * tab's in-flight `refreshAuxData`/`startReader` reads from being torn down or reassigned mid-read.
   * Loosening to "same tab only" would allow that. Revisit only with one session per tab.
   */
  switching: boolean;
  /**
   * specs/restore-tabs-on-relaunch.md FR-212/AC5: id of the active tab whose last activation found its
   * `repoPath` no longer a valid repo, else `null`. The tab stays selected; only its content area shows
   * the inline "not found" state (not an app-wide error). Cleared on activating another tab or a
   * successful retry.
   */
  notFoundTabId: string | null;
}

const noopSetSelectedFile = () => {};

export function useRepoTabs({
  graph,
  rightPanel,
  setRightPanel,
  getSeedRightPanel,
  selectedFile = null,
  setSelectedFile = noopSetSelectedFile,
  dirtyGuard,
}: UseRepoTabsOptions): UseRepoTabsResult {
  // `await` only when dirty: a clean leave must not add a tick to the open paths below.
  const stayBecauseDirty = async (): Promise<boolean> => !(await dirtyGuard!.confirmLeave());
  // FR-209: lazy-ref init so `localStorage` is parsed once, not on every render.
  const initialSessionRef = useRef<{ tabs: RepoTab[]; activeTabId: string | null } | null>(null);
  if (initialSessionRef.current === null) initialSessionRef.current = buildInitialSession();
  const initialSession = initialSessionRef.current;

  const [tabs, setTabs] = useState<RepoTab[]>(() => initialSession.tabs);
  const [activeTabId, setActiveTabId] = useState<string | null>(() => initialSession.activeTabId);
  const idSeqRef = useRef(initialSession.tabs.length);
  const tabsRef = useRef<RepoTab[]>(initialSession.tabs);
  tabsRef.current = tabs;
  // Synced synchronously (not via useEffect) so a second call before re-render sees the current id.
  const activeTabIdRef = useRef<string | null>(initialSession.activeTabId);
  // specs/restore-tabs-on-relaunch.md FR-212/AC5: see `notFoundTabId`'s own doc comment on
  // `UseRepoTabsResult`.
  const [notFoundTabId, setNotFoundTabId] = useState<string | null>(null);
  // Ref (set synchronously before any await) so a second call in the same tick is still blocked;
  // `switching` state only drives the disabled look.
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

  /**
   * specs/instant-tab-revisit.md FR-239: in-memory per-tab cache of the last-confirmed log/aux snapshot,
   * captured when a tab is backgrounded. Not `localStorage`; `closeTab` deletes the entry.
   */
  const tabCacheRef = useRef<Map<string, TabGraphCache>>(new Map());

  const snapshotActiveTab = useCallback(() => {
    const id = activeTabIdRef.current;
    if (!id) return;
    // FR-239/FR-240: re-captured (or invalidated if ineligible) on every backgrounding so reactivation never reads a stale snapshot.
    const cache = graph.captureTabCache();
    if (cache) tabCacheRef.current.set(id, cache);
    else tabCacheRef.current.delete(id);
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
                selectedFile,
              },
            }
          : t,
      ),
    );
  }, [graph.captureTabCache, graph.selectedSha, graph.filter, graph.showAllRefs, rightPanel, selectedFile]);

  const setActive = useCallback((id: string | null) => {
    activeTabIdRef.current = id;
    setActiveTabId(id);
  }, []);

  /**
   * specs/repo-open-feedback-fixes.md FR-202/FR-203: a tab's `repoPath` is set optimistically to the raw
   * path; this corrects it to git's resolved path once the open succeeds (via `graph.openRepo`'s
   * `onSettled`). Makes AC8 dedup work for subfolder picks. No-op if unchanged or the tab is closed.
   */
  const updateTabRepoPath = useCallback((tabId: string, resolvedPath: string) => {
    setTabs((prev) => prev.map((t) => (t.id === tabId && t.repoPath !== resolvedPath ? { ...t, repoPath: resolvedPath } : t)));
  }, []);

  /**
   * specs/repo-open-feedback-fixes.md FR-203/AC8: after a just-created tab resolves to `resolvedPath`,
   * if ANOTHER tab already has that path (e.g. this one was opened via a subfolder), collapse them:
   * discard the new tab, focus the existing one and replay its remembered state (like `activateTab`'s
   * tail). `looksLikeSamePath`, not `===`, since resolved paths can differ in trivial spelling. The
   * graph already shows the right repo, so no second open. Returns `true` if collapsed.
   */
  const reconcileDuplicateTab = useCallback(
    (newTabId: string, resolvedPath: string): boolean => {
      const existing = tabsRef.current.find((t) => t.id !== newTabId && looksLikeSamePath(t.repoPath, resolvedPath));
      if (!existing) return false;
      setTabs((prev) => prev.filter((t) => t.id !== newTabId));
      setActive(existing.id);
      graph.setShowAllRefs(existing.remembered.showAllRefs);
      // specs/graph-head-indicator-and-refresh-alerting.md Addendum 3: `restoreSelection` (not
      // `selectCommit`) so replay doesn't trigger auto-follow scroll.
      if (existing.remembered.selectedSha) graph.restoreSelection(existing.remembered.selectedSha);
      if (Object.values(existing.remembered.filter).some((v) => (Array.isArray(v) ? v.length > 0 : Boolean(v)))) {
        graph.applyFilter(existing.remembered.filter);
      }
      setRightPanel(existing.remembered.rightPanel);
      setSelectedFile(existing.remembered.selectedFile);
      return true;
    },
    [graph, setActive, setRightPanel, setSelectedFile],
  );

  /**
   * specs/restore-tabs-on-relaunch.md FR-210/FR-212: the `graph.reactivateTab` call + outcome handling
   * shared by `activateTab` and the mount-time restore effect, so relaunch restoration reuses the
   * exact same not-found/cancel/success handling (no new fetch path).
   *
   * specs/instant-tab-revisit.md FR-241/FR-242/FR-243: goes through `reactivateTab()` so a valid cache
   * entry gets the fast no-spinner path; it falls back to a full reopen on no cache (AC13) or a change.
   */
  const activateTabCore = useCallback(
    async (target: RepoTab, previousActiveId: string | null): Promise<void> => {
      setNotFoundTabId(null);
      let failed = false;
      const cache = tabCacheRef.current.get(target.id) ?? null;
      const { cancelled, selectionRestored } = await graph.reactivateTab(
        target.repoPath,
        { filter: target.remembered.filter, selectedSha: target.remembered.selectedSha },
        cache,
        (outcome, resolvedPath) => {
          if (outcome === "opened" && resolvedPath) updateTabRepoPath(target.id, resolvedPath);
          if (outcome === "error") failed = true;
        },
      );
      if (cancelled) {
        setActive(previousActiveId);
        return;
      }
      if (failed) {
        // FR-212/AC5: not the app-wide error screen — reset `graph` to "idle" (not "error", which
        // `MainArea` would render full-page) so the inline not-found state shows. No previous tab to fall back to.
        setNotFoundTabId(target.id);
        await graph.closeRepo();
        return;
      }
      graph.setShowAllRefs(target.remembered.showAllRefs);
      // specs/instant-tab-revisit.md FR-240/FR-242: `reactivateTab()` already restored the cached
      // `commitDetail` on a fast-path hit; only fetch otherwise.
      // specs/graph-head-indicator-and-refresh-alerting.md Addendum 3: `restoreSelection` (not
      // `selectCommit`) so replay doesn't trigger auto-follow scroll (AC1-3).
      if (target.remembered.selectedSha && !selectionRestored) graph.restoreSelection(target.remembered.selectedSha);
      setRightPanel(target.remembered.rightPanel);
      // specs/remember-last-selected-file.md FR-217/FR-218: replayed with `rightPanel`; the panel's
      // one-shot restore reads it via `App.tsx`.
      setSelectedFile(target.remembered.selectedFile);
    },
    [graph, setActive, setRightPanel, setSelectedFile, updateTabRepoPath],
  );

  const activateTab = useCallback(
    async (id: string) => {
      // FR-212/AC5: re-clicking the still-active not-found tab must retry, not hit the same-id no-op below.
      const isNotFoundRetry = notFoundTabId === id;
      if (id === activeTabIdRef.current && !isNotFoundRetry) return;
      if (!beginSwitch()) return;
      // specs/repo-open-feedback.md FR-168: for rollback on cancel; `setActive` below is outside what
      // `graph.openRepo` can restore.
      const previousActiveId = activeTabIdRef.current;
      try {
        const target = tabsRef.current.find((t) => t.id === id);
        if (!target) return;
        if (!isNotFoundRetry) {
          snapshotActiveTab();
          setActive(id);
        }
        await activateTabCore(target, previousActiveId);
      } finally {
        endSwitch();
      }
    },
    [snapshotActiveTab, setActive, beginSwitch, endSwitch, notFoundTabId, activateTabCore],
  );

  /**
  /**
   * specs/restore-tabs-on-relaunch.md FR-209/FR-210/AC2/AC7: runs once after first render. The tab bar is
   * already hydrated by `buildInitialSession()` (no git calls, FR-209); this is the ONE eager
   * `graph.openRepo` FR-210 allows, only if a tab was active at quit (null after quitting on the blank
   * landing screen, AC7). Reuses `activateTabCore`.
   */
  useEffect(() => {
    const id = activeTabIdRef.current;
    const target = id ? tabsRef.current.find((t) => t.id === id) : undefined;
    if (!target) return;
    if (!beginSwitch()) return;
    void (async () => {
      try {
        // No previous tab pre-launch; on cancel fall back to the idle landing screen (`null`).
        await activateTabCore(target, null);
      } finally {
        endSwitch();
      }
    })();
    // Run-once-on-mount by design; later tab switches go through `activateTab`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // specs/restore-tabs-on-relaunch.md FR-208: persists on every change to `tabs`/`activeTabId` (open,
  // close, switch, blank landing). Serializes each tab's `remembered` as last snapshotted — same
  // fidelity as any backgrounded tab, no live sync.
  useEffect(() => {
    const activeTab = tabs.find((t) => t.id === activeTabId);
    writePersistedSession({
      tabs: tabs.map((t) => ({ repoPath: t.repoPath, remembered: t.remembered })),
      activeRepoPath: activeTab ? activeTab.repoPath : null,
    });
  }, [tabs, activeTabId]);

  /** specs/repo-list.md Must-have 2/3: "+ New tab" — see `UseRepoTabsResult.newTab`. No dialog or tab creation. */
  const newTab = useCallback(async () => {
    if (activeTabIdRef.current === null) return; // already showing the landing screen
    if (!beginSwitch()) return;
    try {
      snapshotActiveTab();
      setActive(null);
      setRightPanel("none");
      setSelectedFile(null);
      await graph.closeRepo();
    } finally {
      endSwitch();
    }
  }, [graph, snapshotActiveTab, setActive, setRightPanel, setSelectedFile, beginSwitch, endSwitch]);

  const openNewTab = useCallback(async () => {
    // Ignore (don't queue) an overlapping switch; `EmptyState` disabling itself is the primary defense.
    if (!beginSwitch()) return;
    // specs/repo-open-feedback.md FR-168: captured before optimistic bookkeeping so a cancel can roll it
    // back; `graph.openRepo` can't see this hook's tab/panel state.
    const previousActiveId = activeTabIdRef.current;
    const previousRightPanel = rightPanel;
    const previousSelectedFile = selectedFile;
    try {
      const path = unwrap(await graph.api.openRepoDialog());
      if (!path) return;
      // specs/repo-list.md Must-have 4/AC5: a path already open in any tab focuses it. `looksLikeSamePath`,
      // not `===`: an existing tab's git-resolved path may be forward-slash while an OS-dialog pick isn't.
      // A symlink/junction pick still needs `reconcileDuplicateTab`'s async leg (git hasn't resolved it yet).
      const existing = tabsRef.current.find((t) => looksLikeSamePath(t.repoPath, path));
      if (existing && existing.id === activeTabIdRef.current) return;
      if (dirtyGuard?.isDirty() && (await stayBecauseDirty())) return;
      if (existing) {
        // Release our guard before `activateTab`'s own; safe since nothing yields between the calls.
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
      // FR-216: a new tab has no prior selection; reset so a snapshot of THIS tab never leaks the previous tab's.
      setSelectedFile(null);
      const cancelled = await graph.openRepo(path, {}, (outcome, resolvedPath) => {
        if (outcome !== "opened" || !resolvedPath) return;
        // FR-202/FR-203: correct the optimistic path, then (AC8) collapse into an already-open tab if it matches.
        updateTabRepoPath(tab.id, resolvedPath);
        reconcileDuplicateTab(tab.id, resolvedPath);
      });
      if (cancelled) {
        // Undo the optimistic tab: otherwise a cancelled open leaves a stray tab that `activateTab` can't reactivate (it's already active).
        setTabs((prev) => prev.filter((t) => t.id !== tab.id));
        setActive(previousActiveId);
        setRightPanel(previousRightPanel);
        setSelectedFile(previousSelectedFile);
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
    setSelectedFile,
    rightPanel,
    selectedFile,
    beginSwitch,
    endSwitch,
    activateTab,
    updateTabRepoPath,
    reconcileDuplicateTab,
  ]);

  // --- specs/repo-list.md: recent-repo-list-triggered opens (Must-have 3/4, AC2/AC4/AC6) ---

  /**
   * AC6: a failed recent-list open must leave the app where it was with the failure shown inline, not the
   * app-wide error screen. `graph.openRepo` tears down the previous reader before failing, so this
   * genuinely reopens the previous tab (or goes idle), like `closeTab`'s reactivation; it isn't a snapshot replay.
   */
  const restoreGraphAfterFailedRecentOpen = useCallback(
    async (previousTab: RepoTab | null) => {
      if (!previousTab) {
        await graph.closeRepo();
        return;
      }
      await graph.openRepo(previousTab.repoPath, previousTab.remembered.filter);
      graph.setShowAllRefs(previousTab.remembered.showAllRefs);
      // specs/graph-head-indicator-and-refresh-alerting.md Addendum 3: `restoreSelection` (not
      // `selectCommit`) so replay doesn't trigger auto-follow scroll.
      if (previousTab.remembered.selectedSha) graph.restoreSelection(previousTab.remembered.selectedSha);
    },
    [graph],
  );

  const openRecentInNewTab = useCallback(
    async (path: string): Promise<RecentOpenResult> => {
      // AC4 (global dedup, like `openNewTab`): focus an already-open tab. `looksLikeSamePath`, not `===`
      // (ROADMAP.md "repo-open dedup uses exact string equality").
      const existing = tabsRef.current.find((t) => looksLikeSamePath(t.repoPath, path));
      if (existing) {
        // security review: `activateTab` would silently no-op mid-switch; report "cancelled" so
        // `useRecentOpenRow` doesn't treat a swallowed click as success.
        if (switchingRef.current) return "cancelled";
        if (existing.id !== activeTabIdRef.current && dirtyGuard?.isDirty() && (await stayBecauseDirty())) return "cancelled";
        await activateTab(existing.id);
        return "activated-existing";
      }
      if (!beginSwitch()) return "cancelled";
      if (dirtyGuard?.isDirty() && (await stayBecauseDirty())) {
        endSwitch();
        return "cancelled";
      }
      // specs/repo-open-feedback.md FR-168-style rollback, also covering a genuine failure (AC6): no stray tab.
      const previousActiveId = activeTabIdRef.current;
      const previousTab = tabsRef.current.find((t) => t.id === previousActiveId) ?? null;
      const previousRightPanel = rightPanel;
      const previousSelectedFile = selectedFile;
      try {
        snapshotActiveTab();
        const seeded = getSeedRightPanel();
        const tab: RepoTab = { id: `tab-${++idSeqRef.current}`, repoPath: path, remembered: emptyRemembered(seeded) };
        setTabs((prev) => [...prev, tab]);
        setActive(tab.id);
        setRightPanel(seeded);
        // FR-216: see `openNewTab` — a new tab starts with nothing selected.
        setSelectedFile(null);
        let failed = false;
        let collapsedIntoExisting = false;
        const cancelled = await graph.openRepo(path, {}, (outcome, resolvedPath) => {
          if (outcome === "error") {
            failed = true;
            return;
          }
          if (outcome === "opened" && resolvedPath) {
            // FR-202/FR-203 + AC8: correct the path, then collapse if it matches an already-open tab.
            updateTabRepoPath(tab.id, resolvedPath);
            collapsedIntoExisting = reconcileDuplicateTab(tab.id, resolvedPath);
          }
        });
        if (cancelled || failed) {
          setTabs((prev) => prev.filter((t) => t.id !== tab.id));
          setActive(previousActiveId);
          setRightPanel(previousRightPanel);
          setSelectedFile(previousSelectedFile);
          if (failed) await restoreGraphAfterFailedRecentOpen(previousTab);
          return cancelled ? "cancelled" : "not-found";
        }
        return collapsedIntoExisting ? "activated-existing" : "opened";
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
      setSelectedFile,
      rightPanel,
      selectedFile,
      beginSwitch,
      endSwitch,
      activateTab,
      restoreGraphAfterFailedRecentOpen,
      updateTabRepoPath,
      reconcileDuplicateTab,
    ],
  );

  const closeTab = useCallback(
    (id: string) => {
      // A switch in flight owns the live session; ignore a close mid-switch rather than race its
      // reactivation (TabBar disables close too; this catches e.g. the Delete/Backspace path).
      if (switchingRef.current) return;
      const current = tabsRef.current;
      const idx = current.findIndex((t) => t.id === id);
      if (idx === -1) return;
      const wasActive = id === activeTabIdRef.current;
      const remaining = current.filter((t) => t.id !== id);
      setTabs(remaining);
      // specs/instant-tab-revisit.md FR-239: discard the tab's cache so a later tab reopening the same path never inherits it.
      tabCacheRef.current.delete(id);
      // FR-212/AC5: clear a removed not-found tab's flag so it doesn't point at a nonexistent id.
      setNotFoundTabId((prevNotFound) => (prevNotFound === id ? null : prevNotFound));

      if (!wasActive) return;

      // Must-have 8: prefer the tab that slid into this index, else the one before it.
      const next = remaining[idx] ?? remaining[idx - 1] ?? null;
      if (next) {
        // Always succeeds: no switch is in flight (checked above) and nothing can start one synchronously.
        beginSwitch();
        setActive(next.id);
        // specs/repo-open-feedback.md FR-167/168: deliberately no cancel rollback here (unlike
        // `openNewTab`/`activateTab`): the previous tab was just closed. What a cancel should do is a
        // product decision, flagged not guessed.
        void (async () => {
          try {
            // specs/instant-tab-revisit.md FR-239/FR-241: same fast-path treatment as `activateTab`.
            const cache = tabCacheRef.current.get(next.id) ?? null;
            const { selectionRestored } = await graph.reactivateTab(
              next.repoPath,
              { filter: next.remembered.filter, selectedSha: next.remembered.selectedSha },
              cache,
              (outcome, resolvedPath) => {
                // FR-202/FR-203: keep repoPath current; no dedup needed, this is the same pre-existing tab.
                if (outcome === "opened" && resolvedPath) updateTabRepoPath(next.id, resolvedPath);
              },
            );
            graph.setShowAllRefs(next.remembered.showAllRefs);
            // specs/graph-head-indicator-and-refresh-alerting.md Addendum 3: `restoreSelection` (not
            // `selectCommit`) so replay doesn't trigger auto-follow scroll.
            if (next.remembered.selectedSha && !selectionRestored) graph.restoreSelection(next.remembered.selectedSha);
            setRightPanel(next.remembered.rightPanel);
            // FR-217/FR-218 AC5: replay the adjacent tab's own file, never the closed tab's.
            setSelectedFile(next.remembered.selectedFile);
          } finally {
            endSwitch();
          }
        })();
      } else {
        // AC9: no tabs left — back to the existing idle empty state, window stays open.
        setActive(null);
        setRightPanel("none");
        setSelectedFile(null);
        void graph.closeRepo();
      }
    },
    [graph, setActive, setRightPanel, setSelectedFile, beginSwitch, endSwitch, updateTabRepoPath],
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
    notFoundTabId,
  };
}
