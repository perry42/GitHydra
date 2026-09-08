// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useRef, useState } from "react";
import type { CommitLogFilter } from "@githydra/git-core";
import { unwrap } from "./gitHydraClient";
import type { UseRepositoryGraphResult } from "./useRepositoryGraph";
import type { DiffableCategory } from "./useChangesPanel";
import { looksLikeSamePath } from "../../shared/pathEquivalence";

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
 * specs/remember-last-selected-file.md FR-215: the last file selected in whichever file-list
 * panel was open — a bare `path` for DetailPanel's commit file list (`kind: "commit"`), or a
 * `{ category, path }` pair for ChangesPanel's working-directory file list (`kind: "changes"`,
 * reusing `useChangesPanel.ts`'s own `SelectedFile` shape verbatim). Tagged with `kind` rather
 * than stored as two separate optional fields so a single value round-trips through
 * `RepoTabRemembered`/persisted storage unambiguously — see that field's own doc comment.
 */
export type RememberedFileSelection =
  | { kind: "commit"; path: string }
  | { kind: "changes"; category: DiffableCategory; path: string };

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
  /**
   * specs/remember-last-selected-file.md FR-215/FR-216: captured at the exact same points
   * `selectedSha`/`filter`/`showAllRefs`/`rightPanel` already are (`snapshotActiveTab` and its
   * equivalents below) — `null` means nothing was selected (or `rightPanel` was `"none"`/
   * `"stashes"`, in which case this is unused but harmlessly carried, AC7). Only ever HANDED to
   * `DetailPanel`/`ChangesPanel` at tab-ACTIVATION time (FR-217/FR-218) — this field itself is
   * NEVER cleared/mutated once set (so it's still there, correct, the next time this tab is
   * genuinely reactivated, including across a relaunch — AC6); `App.tsx`'s
   * `consumedFileRestoreSeqRef`/`onRestoredFileConsumed` is what gates *whether this render's
   * value is actually passed down* to at most once per real activation (keyed off
   * `graph.openSequence`), so a later same-tab panel remount (e.g. toggling the right rail away
   * and back) never gets handed a stale value even though the field underneath is untouched.
   */
  selectedFile: RememberedFileSelection | null;
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
  return { selectedSha: null, filter: {}, showAllRefs: false, rightPanel, selectedFile: null };
}

/**
 * specs/restore-tabs-on-relaunch.md FR-208: tab identity (ordered `repoPath`s + which was active)
 * persisted to `localStorage`, following the exact try/catch-guarded, gracefully-degrading pattern
 * `useTheme.ts`'s `STORAGE_KEY`/`useRecentRepos.ts`'s `RECENT_REPOS_KEY` already use for every other
 * persisted preference in this app.
 */
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

/** specs/remember-last-selected-file.md FR-215: `undefined` (the field didn't exist yet in a
 * session persisted by an older build) is accepted here too — `normalizeRemembered` below is what
 * actually turns that into a real `null`, so old sessions degrade gracefully to "nothing
 * remembered" instead of losing their `selectedSha`/`filter`/`showAllRefs`/`rightPanel` too. */
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

/** Fills in `selectedFile: null` for a pre-FR-215 persisted `remembered` object that passed
 * `isRepoTabRemembered` above (i.e. every OTHER field validated, but `selectedFile` itself was
 * `undefined` because it didn't exist yet) — otherwise a straight pass-through. */
function normalizeRemembered(remembered: RepoTabRemembered): RepoTabRemembered {
  return remembered.selectedFile === undefined ? { ...remembered, selectedFile: null } : remembered;
}

/** FR-208/AC10: never throws — a missing/corrupt/unavailable `localStorage` degrades to "no
 * persisted session" (today's empty-landing-screen behavior), exactly like `useRecentRepos.ts`'s
 * `readStored`/`useTheme.ts`'s `getInitialTheme`. */
function readPersistedSession(): PersistedSession {
  if (typeof window === "undefined") return { tabs: [], activeRepoPath: null };
  try {
    const raw = window.localStorage?.getItem(SESSION_TABS_KEY);
    if (!raw) return { tabs: [], activeRepoPath: null };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { tabs: [], activeRepoPath: null };
    const obj = parsed as Record<string, unknown>;
    const rawTabs = Array.isArray(obj.tabs) ? obj.tabs : [];
    // Defensive de-dup against hand-tampered/corrupted storage, mirroring
    // `useRecentRepos.ts`'s `uniqueInOrder` — two tabs can never share a `repoPath` live (every
    // open entry point already dedups), so a read shouldn't manufacture that either.
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
 * FR-209: turns whatever `readPersistedSession()` returns into real `RepoTab`s with freshly
 * assigned ids (a previous session's ids are meaningless here — nothing on this side survived the
 * relaunch to reuse them) — computed exactly once, synchronously, at the top of the very first
 * render (see this hook's own `useRef`-guarded call site below), so the tab bar is rebuilt "on the
 * very first render after launch" (AC1) rather than one tick later via an effect.
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
  /**
   * specs/remember-last-selected-file.md FR-216: the App-owned, live "what's currently selected
   * in whichever file-list panel is open" value — kept up to date by `DetailPanel`/`ChangesPanel`'s
   * own `onFileSelected` callbacks (App.tsx), exactly the same live-value-read pattern `rightPanel`
   * above already has for its own field. Read by `snapshotActiveTab` alongside `selectedSha`/
   * `filter`/`showAllRefs`/`rightPanel`. Optional — defaults to always-`null`/no-op so hook-level
   * test harnesses that don't exercise this feature don't need to pass it.
   */
  selectedFile?: RememberedFileSelection | null;
  /**
   * The setter for the same App state above — replayed at every point `setRightPanel` is (tab
   * activation, `closeTab`'s adjacent reactivation, the dedup-collapse path, and every "now showing
   * a fresh/blank tab" transition), so a later `snapshotActiveTab` call never captures a value
   * leaked from whichever tab was active before this one. Optional, matching `selectedFile` above.
   */
  setSelectedFile?: (value: RememberedFileSelection | null) => void;
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
   * True for the *entire* duration of a `newTab`/`activateTab`/`openNewTab` call, or a
   * `closeTab`-triggered reactivation — not just while `graph.status === "opening"`, which flips
   * back to `"ready"` before this hook has finished replaying the target tab's remembered
   * `showAllRefs`/`selectedSha`/`rightPanel`. Callers (`TabBar`, `EmptyState`) should use this to
   * make every other control non-interactive while a switch is in flight, so a fast second
   * click/keypress can't queue up a second overlapping switch — and the same flag also blocks it
   * internally even if the UI somehow lets one through.
   *
   * specs/repo-open-feedback-fixes.md FR-206/FR-207: this lock's scope was investigated and kept
   * exactly as broad as it is — NOT "defense in depth" behind an "authoritative" fix elsewhere, as
   * an earlier version of this comment framed it. The main process holds exactly ONE live
   * `RepoSession` (one `Repository`, one reader map, one file watcher) shared by every tab (see
   * `RepoSession`'s own doc comment, `electron/repoSession.ts`) — `RepoSession.open()`'s
   * `generation` counter only decides which of two concurrent `open()` calls' RESULTS wins the
   * shared `this.repo`/`pendingRepos` entry; it does nothing to protect a still-in-flight tab's own
   * `refreshAuxData`/`startReader` reads from a SECOND, concurrently-started tab's `open()` call,
   * which (for the non-cancellable path) unconditionally tears down every live reader and the
   * watcher before any `await`, or (for the cancellable path this spec extended) can still commit
   * a completely different repo into the shared session mid-read via `commitOpenRepo`. Loosening
   * this lock to "only block the same tab" would let two different tabs' opens genuinely
   * interleave against that one shared session — a real correctness hazard (a reader torn out from
   * under an in-flight read, `this.repo` reassigned mid-read, an aux-data read resolving against a
   * repo that's no longer the one its own tab thinks is open) — independent of, and not fixed by,
   * the generation counter or this spec's own pending/commit deferral. This is not scoped down as
   * part of any fix; revisit only if the main process is re-architected to hold one independent
   * session per tab (a materially larger, separate change) — see `RepoSession`'s own "v1 treats
   * each open worktree/repo as its own window/session" doc comment for why that's not today's
   * design.
   */
  switching: boolean;
  /**
   * specs/restore-tabs-on-relaunch.md FR-212/AC5: the id of the tab whose most recent activation
   * attempt discovered its `repoPath` no longer resolves to a valid repo (moved/deleted/`.git`
   * removed) — `null` otherwise. Only ever set for the tab that IS `activeTabId` at the time (the
   * tab stays selected/focused in the bar; only its content area shows the inline "not found"
   * state, matching AC5's "not a crash, and not an app-wide error screen that swallows the rest of
   * the restored session"). Reachable via any tab's activation, not only a restored one — a live
   * session's own tab can just as easily go stale mid-session (deleted from another window/tool)
   * — but a restored tab (never validated this session) is the case this feature actually
   * introduces the realistic possibility of. Cleared on activating a different tab, or on
   * successfully retrying this same one.
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
}: UseRepoTabsOptions): UseRepoTabsResult {
  // specs/restore-tabs-on-relaunch.md FR-209: computed exactly once (a guarded lazy-ref
  // initialization, evaluated during this very first render, before any of the `useState` calls
  // below need it) rather than a plain `buildInitialSession()` call in the component body, which
  // would re-read/re-parse `localStorage` on every single render for no reason — only the very
  // first render's result is ever used, since `useState`'s own initializer function form already
  // only runs once.
  const initialSessionRef = useRef<{ tabs: RepoTab[]; activeTabId: string | null } | null>(null);
  if (initialSessionRef.current === null) initialSessionRef.current = buildInitialSession();
  const initialSession = initialSessionRef.current;

  const [tabs, setTabs] = useState<RepoTab[]>(() => initialSession.tabs);
  const [activeTabId, setActiveTabId] = useState<string | null>(() => initialSession.activeTabId);
  const idSeqRef = useRef(initialSession.tabs.length);
  const tabsRef = useRef<RepoTab[]>(initialSession.tabs);
  tabsRef.current = tabs;
  // Kept in sync with `activeTabId` synchronously (not via useEffect, which only flushes after a
  // render) so a second call arriving before React has re-rendered (e.g. a fast double-click on
  // two different tabs) still sees the just-updated "current" id rather than a stale one.
  const activeTabIdRef = useRef<string | null>(initialSession.activeTabId);
  // specs/restore-tabs-on-relaunch.md FR-212/AC5: see `notFoundTabId`'s own doc comment on
  // `UseRepoTabsResult`.
  const [notFoundTabId, setNotFoundTabId] = useState<string | null>(null);
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
                selectedFile,
              },
            }
          : t,
      ),
    );
  }, [graph.selectedSha, graph.filter, graph.showAllRefs, rightPanel, selectedFile]);

  const setActive = useCallback((id: string | null) => {
    activeTabIdRef.current = id;
    setActiveTabId(id);
  }, []);

  /**
   * specs/repo-open-feedback-fixes.md FR-202/FR-203: a tab's `repoPath` is set optimistically (to
   * the raw, caller-supplied path) before `graph.openRepo()` is even awaited — this corrects it to
   * git's own resolved value once that attempt actually succeeds, via `graph.openRepo`'s
   * `onSettled` third parameter (the only point that has both this specific attempt's real outcome
   * and its resolved path, without racing `graph.repoPath`'s own React state). A no-op when the
   * resolved path matches what the tab already has (the common case — most opens are the repo
   * root already) or when the tab has since been closed. This is what makes AC8's dedup actually
   * work for the subfolder-of-an-already-open-repo case: the existing-tab check every open entry
   * point below runs (`tabsRef.current.find((t) => t.repoPath === path)`) only ever sees resolved
   * paths once every tab that opened has gone through this correction.
   */
  const updateTabRepoPath = useCallback((tabId: string, resolvedPath: string) => {
    setTabs((prev) => prev.map((t) => (t.id === tabId && t.repoPath !== resolvedPath ? { ...t, repoPath: resolvedPath } : t)));
  }, []);

  /**
   * specs/repo-open-feedback-fixes.md FR-203/AC8: called once a just-CREATED tab's own open
   * attempt resolves to `resolvedPath` (`openNewTab`/`openRecentInNewTab`'s own `onSettled`) — if
   * ANOTHER already-existing tab's `repoPath` is already that exact resolved path (the
   * subfolder-of-an-already-open-repo case: the earlier tab opened the parent directly, this one
   * was just opened via a subfolder of it), collapses the two into one rather than leaving two
   * tabs pointed at the same physical repo. Uses `looksLikeSamePath` (not exact string equality)
   * since two independent opens' own resolved paths can still differ in trivial spelling (e.g.
   * git's always-forward-slash output vs. a path this hook itself preserved verbatim per AC7) while
   * still being the exact same directory — see that function's own doc comment. The graph itself
   * is already showing the correct, freshly-opened repo (no second `openRepo` round trip needed) —
   * this only discards the redundant new tab, focuses the pre-existing one, and replays ITS
   * remembered selection/filter/panel onto the graph, mirroring `activateTab`'s own tail. Returns
   * `true` if a collapse happened (the caller must treat the just-created tab as gone, not the
   * winning one).
   */
  const reconcileDuplicateTab = useCallback(
    (newTabId: string, resolvedPath: string): boolean => {
      const existing = tabsRef.current.find((t) => t.id !== newTabId && looksLikeSamePath(t.repoPath, resolvedPath));
      if (!existing) return false;
      setTabs((prev) => prev.filter((t) => t.id !== newTabId));
      setActive(existing.id);
      graph.setShowAllRefs(existing.remembered.showAllRefs);
      if (existing.remembered.selectedSha) graph.selectCommit(existing.remembered.selectedSha);
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
   * specs/restore-tabs-on-relaunch.md FR-210/FR-212: the actual `graph.openRepo` call + outcome
   * handling shared by `activateTab` below (an ordinary in-memory tab switch, `id` already made
   * active by its caller) AND the mount-time restore effect further down (the previously-active
   * tab, `id` already active from `buildInitialSession`'s hydration, no separate "switch into it"
   * step needed). Extracted so FR-210's "no new fetch path... restoration just re-enters the
   * existing lazy-activation behavior" is true at the CODE level too, not just behaviorally: the
   * exact same not-found/cancel/success handling runs whether `target` came from a live click or a
   * relaunch.
   */
  const activateTabCore = useCallback(
    async (target: RepoTab, previousActiveId: string | null): Promise<void> => {
      setNotFoundTabId(null);
      let failed = false;
      const cancelled = await graph.openRepo(target.repoPath, target.remembered.filter, (outcome, resolvedPath) => {
        if (outcome === "opened" && resolvedPath) updateTabRepoPath(target.id, resolvedPath);
        if (outcome === "error") failed = true;
      });
      if (cancelled) {
        setActive(previousActiveId);
        return;
      }
      if (failed) {
        // FR-212/AC5: never the app-wide error screen, never abort the rest of the session — the
        // tab stays right where it is (still selected/focused), `graph` is reset back to `"idle"`
        // (not left on `"error"`, which `MainArea` would otherwise render as the full-page "Could
        // not open this repository" screen) so the inline not-found treatment can render in its
        // place instead. `closeRepo()` mirrors `restoreGraphAfterFailedRecentOpen`'s no-previous-tab
        // branch — there is no "previous tab" to fall back to showing here; this IS the tab meant
        // to be showing, it just failed to load.
        setNotFoundTabId(target.id);
        await graph.closeRepo();
        return;
      }
      graph.setShowAllRefs(target.remembered.showAllRefs);
      if (target.remembered.selectedSha) graph.selectCommit(target.remembered.selectedSha);
      setRightPanel(target.remembered.rightPanel);
      // specs/remember-last-selected-file.md FR-217/FR-218: replayed alongside `rightPanel` above
      // — `DetailPanel`/`ChangesPanel` (whichever `target.remembered.rightPanel` mounts) reads this
      // back via `App.tsx` to make its own one-shot restore attempt.
      setSelectedFile(target.remembered.selectedFile);
    },
    [graph, setActive, setRightPanel, setSelectedFile, updateTabRepoPath],
  );

  const activateTab = useCallback(
    async (id: string) => {
      // FR-212/AC5: "Try again"/re-clicking the still-active not-found tab must actually retry —
      // the ordinary `id === activeTabIdRef.current` short-circuit below would otherwise always
      // no-op it, since a not-found tab stays active/selected the whole time it's showing that
      // state.
      const isNotFoundRetry = notFoundTabId === id;
      if (id === activeTabIdRef.current && !isNotFoundRetry) return;
      if (!beginSwitch()) return;
      // specs/repo-open-feedback.md FR-168: same reasoning as `openNewTab`'s rollback — `setActive`
      // below is this function's own optimistic bookkeeping, outside anything `graph.openRepo`
      // itself can restore on a cancel.
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
   * specs/restore-tabs-on-relaunch.md FR-209/FR-210/AC2/AC7: runs exactly once, right after the
   * very first render — `buildInitialSession()` has already hydrated `tabs`/`activeTabId` (and
   * `activeTabIdRef`) synchronously before this effect ever runs, so the tab bar itself is already
   * showing every restored tab (FR-209's "no git calls for any tab — pure local state hydration")
   * by the time this fires. This is the ONE eager `graph.openRepo` call FR-210 allows: only when a
   * tab was actually active at quit time (`activeTabIdRef.current` non-null — AC7's "quit on the
   * blank landing screen" case leaves it `null`, correctly making this a no-op and leaving every
   * restored tab idle). Reuses `activateTabCore` verbatim — see its own doc comment.
   */
  useEffect(() => {
    const id = activeTabIdRef.current;
    const target = id ? tabsRef.current.find((t) => t.id === id) : undefined;
    if (!target) return;
    if (!beginSwitch()) return;
    void (async () => {
      try {
        // No well-defined "previous tab" pre-launch to roll back to on a cancel — falling back to
        // the idle landing screen (`null`) is the same choice `openNewTab`'s own cancel-rollback
        // reasoning would make for "nothing was showing before this attempt started."
        await activateTabCore(target, null);
      } finally {
        endSwitch();
      }
    })();
    // Deliberately run-once-on-mount: this restores whatever `buildInitialSession()` already
    // hydrated into `activeTabIdRef`/`tabsRef` at that same first render, not "whenever these
    // values later change" (ordinary tab switches already go through `activateTab` above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // specs/restore-tabs-on-relaunch.md FR-208: persists on every change to the tab list OR which
  // tab is active — covers a tab being opened/closed (FR-208's named triggers) as well as an
  // ordinary switch (AC2) and deactivating to the blank "+ New tab" landing screen (AC7), since all
  // of those change `tabs` and/or `activeTabId`. Serializes straight from `tabs`' own `remembered`
  // field (whatever `snapshotActiveTab` last captured for a backgrounded tab) rather than reaching
  // into live `graph` state for whichever tab is currently active — this is deliberately the exact
  // same fidelity `RepoTabRemembered` already has for an ordinary backgrounded tab mid-session
  // (Non-goals: "everything else is cheap to refetch on activation"), not a new, richer live-sync.
  useEffect(() => {
    const activeTab = tabs.find((t) => t.id === activeTabId);
    writePersistedSession({
      tabs: tabs.map((t) => ({ repoPath: t.repoPath, remembered: t.remembered })),
      activeRepoPath: activeTab ? activeTab.repoPath : null,
    });
  }, [tabs, activeTabId]);

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
      setSelectedFile(null);
      await graph.closeRepo();
    } finally {
      endSwitch();
    }
  }, [graph, snapshotActiveTab, setActive, setRightPanel, setSelectedFile, beginSwitch, endSwitch]);

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
    const previousSelectedFile = selectedFile;
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
      // specs/remember-last-selected-file.md FR-216: a brand-new tab has no prior selection —
      // reset the live value so a subsequent snapshot of THIS tab never leaks the previous tab's.
      setSelectedFile(null);
      const cancelled = await graph.openRepo(path, {}, (outcome, resolvedPath) => {
        if (outcome !== "opened" || !resolvedPath) return;
        // FR-202/FR-203: correct the optimistic tab's path to the resolved one, then (AC8) check
        // whether that resolved path collapses this brand-new tab into an already-open one.
        updateTabRepoPath(tab.id, resolvedPath);
        reconcileDuplicateTab(tab.id, resolvedPath);
      });
      if (cancelled) {
        // Undo the optimistic tab creation/activation above — without this, a canceled "Open a
        // repository" attempt leaves a stray tab in the bar (labeled with the never-actually-opened
        // path) that `activateTab` can't even reactivate (it no-ops when `id === activeTabIdRef.current`,
        // which this tab already is).
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
      const previousSelectedFile = selectedFile;
      try {
        snapshotActiveTab();
        const seeded = getSeedRightPanel();
        const tab: RepoTab = { id: `tab-${++idSeqRef.current}`, repoPath: path, remembered: emptyRemembered(seeded) };
        setTabs((prev) => [...prev, tab]);
        setActive(tab.id);
        setRightPanel(seeded);
        // specs/remember-last-selected-file.md FR-216: see `openNewTab`'s identical reset — a
        // brand-new tab starts with nothing selected.
        setSelectedFile(null);
        let failed = false;
        let collapsedIntoExisting = false;
        const cancelled = await graph.openRepo(path, {}, (outcome, resolvedPath) => {
          if (outcome === "error") {
            failed = true;
            return;
          }
          if (outcome === "opened" && resolvedPath) {
            // FR-202/FR-203: correct the optimistic tab's path, then (AC8) collapse into an
            // already-open tab if this resolved path turns out to match one.
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
      // FR-212/AC5: "Remove from list" on a not-found tab's inline state — this tab is gone, so
      // its not-found flag would otherwise linger and (harmlessly, but incorrectly) point at an id
      // no tab has anymore.
      setNotFoundTabId((prevNotFound) => (prevNotFound === id ? null : prevNotFound));

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
            await graph.openRepo(next.repoPath, next.remembered.filter, (outcome, resolvedPath) => {
              // FR-202/FR-203: keep this tab's own repoPath current too — no dedup reconciliation
              // needed here (unlike a freshly-created tab), since this is the SAME pre-existing tab
              // simply reopening its own already-known path.
              if (outcome === "opened" && resolvedPath) updateTabRepoPath(next.id, resolvedPath);
            });
            graph.setShowAllRefs(next.remembered.showAllRefs);
            if (next.remembered.selectedSha) graph.selectCommit(next.remembered.selectedSha);
            setRightPanel(next.remembered.rightPanel);
            // specs/remember-last-selected-file.md FR-217/FR-218: AC5 — the adjacent tab's OWN
            // remembered file replays here, never the just-closed tab's (which was simply
            // discarded above, never snapshotted).
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
