// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useRef, useState } from "react";
import { BlamePanel } from "./components/BlamePanel/BlamePanel";
import { BranchesPanel } from "./components/BranchesPanel/BranchesPanel";
import { ChangesPanel } from "./components/ChangesPanel/ChangesPanel";
import { CherryPickEmptyResultNotice } from "./components/CherryPickEmptyResultNotice/CherryPickEmptyResultNotice";
import { CommitGraph } from "./components/CommitGraph/CommitGraph";
import { CompareView } from "./components/CompareView/CompareView";
import { ConfirmDialog } from "./components/ConfirmDialog/ConfirmDialog";
import { CreateStashDialog } from "./components/CreateStashDialog/CreateStashDialog";
import { DetailPanel } from "./components/DetailPanel/DetailPanel";
import { EmptyState } from "./components/EmptyState/EmptyState";
import { FilterBar } from "./components/FilterBar/FilterBar";
import { NewBranchDialog } from "./components/NewBranchDialog/NewBranchDialog";
import { StashPanel } from "./components/StashPanel/StashPanel";
import { StatusBanner } from "./components/StatusBanner/StatusBanner";
import { TabBar } from "./components/TabBar/TabBar";
import { TabNotFoundState } from "./components/TabNotFoundState/TabNotFoundState";
import { Toolbar } from "./components/Toolbar/Toolbar";
import type { BlameTarget } from "./hooks/useBlame";
import { useBranchActions } from "./hooks/useBranchActions";
import type { CompareTarget } from "./hooks/useCompare";
import { useCherryPickActions } from "./hooks/useCherryPickActions";
import { useElapsedSeconds } from "./hooks/useElapsedSeconds";
import {
  getPersistedRightPanel,
  getPersistedSidebarCollapsed,
  persistRightPanel,
  persistSidebarCollapsed,
} from "./hooks/useLayoutPreferences";
import { useRecentOpenRow } from "./hooks/useRecentOpenRow";
import { useRecentRepos } from "./hooks/useRecentRepos";
import { useRepositoryGraph } from "./hooks/useRepositoryGraph";
import { useRepoTabs, type RememberedFileSelection, type RepoTab, type RightPanel } from "./hooks/useRepoTabs";
import type { SelectedFile } from "./hooks/useChangesPanel";
import type { ExpectedRefOutcome } from "./hooks/selfWriteGate";
import { useTheme } from "./hooks/useTheme";
import { computeAmendDisabledReason } from "./lib/amendEligibility";
import { computeCreateStashDisabledReason } from "./lib/stashEligibility";
import "./App.css";

/** specs/stash.md FR-98: which action (apply/pop) most recently left conflicts behind, shown as
 * ChangesPanel's inline notice until the user dismisses it, closes the panel, or a different repo
 * is opened. */
interface StashConflictNotice {
  action: "apply" | "pop";
}

/** FR-49/FR-54: state for the (single, App-owned) New Branch dialog — non-null means open.
 * `defaultStartPoint` is set when opened from the graph's "Create branch here" action. */
interface NewBranchRequest {
  defaultStartPoint?: { value: string; label: string };
}

export function App() {
  // specs/repo-list.md Must-have 1: the one persisted, session-shared recent-repos list — handed
  // to `useRepositoryGraph` below (recording every successful open) and to the one surface that
  // reads/mutates it, `EmptyState` (the landing screen, per the revised IA — see its own doc
  // comment).
  //
  // specs/repo-open-feedback-fixes.md FR-204: `useRepositoryGraph` invokes `onRepoOpened` with
  // both the resolved `path` and the originally-picked `pickedPath` (see its own doc comment) —
  // this forwards both positionally into `addRecentRepo(path, pickedPath?)`, which is what decides
  // whether they genuinely diverge and persists the secondary-context mapping if so.
  const recentRepos = useRecentRepos();
  const graph = useRepositoryGraph({ onRepoOpened: recentRepos.addRecentRepo });
  const [theme, toggleTheme] = useTheme();
  // Must-have C16/C18: seeded from the persisted "last open panel" preference (defaulting to
  // "none" if nothing was ever persisted) rather than always "none" — but "commit" is never part
  // of that persisted value (see setRightPanel below), so a relaunch never reopens the DetailPanel
  // on its own (selecting a commit is not a "layout" preference, per the spec's Non-goals).
  const [rightPanel, setRightPanelState] = useState<RightPanel>(() => getPersistedRightPanel());
  // Must-have C16/C17: persists every transition into "none"/"changes"/"stashes" (never
  // "commit", which is derived from commit selection, not an independent toggle) — global across
  // repos/tabs, the same scope `useTheme.ts`'s theme preference already has. "branches" was
  // dropped from this set by the design-pass "Branches panel relocation" — see
  // `sidebarCollapsed`/`setSidebarCollapsed` below for its own, separate persisted preference.
  const setRightPanel = useCallback((value: RightPanel) => {
    setRightPanelState(value);
    if (value !== "commit") persistRightPanel(value);
  }, []);
  // design-pass "Branches panel relocation": whether the persistent left Branches sidebar is
  // collapsed to its slim rail — deliberately a separate piece of state from `rightPanel` above,
  // since the sidebar is no longer one of the mutually-exclusive right-hand rails that union
  // tracks (it can be expanded/collapsed independently of whatever's showing on the right).
  const [sidebarCollapsed, setSidebarCollapsedState] = useState<boolean>(() => getPersistedSidebarCollapsed());
  const setSidebarCollapsed = useCallback((value: boolean) => {
    setSidebarCollapsedState(value);
    persistSidebarCollapsed(value);
  }, []);
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed(!sidebarCollapsed);
  }, [sidebarCollapsed, setSidebarCollapsed]);
  // Must-have #2/#3 (specs/detailpanel-auto-diff.md): bumped when the checkpoint pseudo-node is
  // clicked while the Changes panel is already open, so useChangesPanel can force a fresh reload
  // + re-auto-select without ChangesPanel itself unmounting/remounting.
  const [changesReloadToken, setChangesReloadToken] = useState(0);
  // FR-56: bumped after any branch mutation so the Branches panel's own list hook (which fetches
  // independently of the graph) refetches, even when the mutation was triggered from *outside*
  // the panel (the graph's ref-chip/commit context menus).
  const [branchListReloadToken, setBranchListReloadToken] = useState(0);
  const [newBranchRequest, setNewBranchRequest] = useState<NewBranchRequest | null>(null);
  // specs/stash.md FR-101: bumped after any successful stash mutation, or after the ordinary
  // external-change alert is acknowledged, so StashPanel's own list (independent of the graph)
  // refetches — same convention as `branchListReloadToken`.
  const [stashListReloadToken, setStashListReloadToken] = useState(0);
  const [showCreateStashDialog, setShowCreateStashDialog] = useState(false);
  const [stashConflictNotice, setStashConflictNotice] = useState<StashConflictNotice | null>(null);
  // specs/blame.md FR-131/132: which file/revision `BlamePanel` is currently showing — `null`
  // means it's closed. Deliberately NOT folded into `rightPanel`/`RepoTabRemembered` (unlike
  // "commit"/"changes"/"branches"/"stashes"): BlamePanel is opened as an overlay on top of
  // whichever rail panel already had the file row the user right-clicked (ChangesPanel or
  // DetailPanel), and closing it (via its own × or FR-134's jump-to-commit) reveals that same
  // panel again rather than needing its own remembered slot.
  const [blameTarget, setBlameTarget] = useState<BlameTarget | null>(null);
  const openBlame = useCallback((path: string, revision: string | null) => {
    setBlameTarget({ path, revision });
  }, []);

  // specs/compare-commits.md FR-189: which two commits `CompareView` is showing — `null` means
  // it's closed. Follows `blameTarget`'s exact panel-precedence pattern (pre-empts `rightPanel`
  // AND `blameTarget` itself, see the render tree below) but deliberately does NOT copy every one
  // of its behaviors: FR-194/195/196 are explicit, spec'd deviations — see `selectCommit`'s own
  // comment for FR-194, `openCompare` below for FR-195, and `CommitGraph`'s `compareTarget` prop
  // for FR-196. Like `blameTarget`, this is never persisted/restored across a repo reopen
  // (Non-goals) — it always starts `null`.
  const [compareTarget, setCompareTarget] = useState<CompareTarget | null>(null);
  // FR-187/195: called with the graph's own already-sorted [baseSha, targetSha] — invoking this
  // again on a newly-made 2-commit selection while CompareView is already open just overwrites
  // `compareTarget` in place (a plain `setState`), satisfying FR-195 with no special-casing needed.
  const openCompare = useCallback((baseSha: string, targetSha: string) => {
    setCompareTarget({ baseSha, targetSha });
  }, []);
  // FR-193: flips which SHA is currently labeled "base" vs. "target" and reloads — `CompareView`
  // itself has no state of its own to swap, it's purely driven by this prop.
  const swapCompare = useCallback(() => {
    setCompareTarget((t) => (t ? { baseSha: t.targetSha, targetSha: t.baseSha } : t));
  }, []);

  // specs/remember-last-selected-file.md FR-215/FR-216: the App-owned, live "what's currently
  // selected in whichever file-list panel is open" value — kept in sync by DetailPanel's/
  // ChangesPanel's own `onFileSelected` callbacks below, read by `useRepoTabs`' `snapshotActiveTab`
  // (alongside `rightPanel`) and replayed by it at every point `rightPanel` itself is (tab
  // activation, `closeTab`'s adjacent reactivation, the dedup-collapse path, every fresh/blank-tab
  // transition).
  const [selectedFile, setSelectedFile] = useState<RememberedFileSelection | null>(null);

  // specs/multi-repo-tabs.md: tab bookkeeping + orchestration (create/switch/close, replaying a
  // reactivated tab's remembered selection/filter/panel against the one live `graph` instance —
  // Architecture decision option B). `setRightPanelState` (not the persisting `setRightPanel`) is
  // passed through deliberately: switching/creating tabs must never overwrite the user's real
  // global "last used panel" preference (Must-have 10), only an actual user toggle should.
  const repoTabs = useRepoTabs({
    graph,
    rightPanel,
    setRightPanel: setRightPanelState,
    getSeedRightPanel: getPersistedRightPanel,
    selectedFile,
    setSelectedFile,
  });

  // specs/remember-last-selected-file.md FR-217/FR-218/FR-219: the ACTIVE tab's own remembered
  // file, gated to only ever be handed to DetailPanel/ChangesPanel ONCE per real activation.
  //
  // `activeTab.remembered.selectedFile` (read directly from `repoTabs.tabs`, not the live
  // `selectedFile` state above) is deliberately NEVER cleared/mutated by this feature — it stays
  // exactly what `snapshotActiveTab` last captured, so it's still there, correct, the next time
  // this same tab is genuinely reactivated (including across a relaunch, AC6). What changes on
  // each render instead is whether it's actually HANDED to the panel this time: `graph.openSequence`
  // bumps on every real `openRepo`/`closeRepo` call (an ordinary switch, `closeTab`'s adjacent
  // reactivation, or app-relaunch's eager activation — never on a mere same-tab right-rail toggle,
  // which calls neither), so comparing it against the openSequence value `onRestoredFileConsumed`
  // last recorded is exactly "has a real activation happened since a panel last consulted this" —
  // true right after a fresh activation (hand it over), false for every later render this session
  // (including a same-tab panel-toggle remount, which must NOT re-consult it — FR-219).
  const activeTab = repoTabs.tabs.find((t) => t.id === repoTabs.activeTabId) ?? null;
  const consumedFileRestoreSeqRef = useRef<number | null>(null);
  const rememberedFile = graph.openSequence !== consumedFileRestoreSeqRef.current ? (activeTab?.remembered.selectedFile ?? null) : null;
  const onRestoredFileConsumed = () => {
    consumedFileRestoreSeqRef.current = graph.openSequence;
  };

  // specs/restore-tabs-on-relaunch.md FR-212/AC5: only meaningful when it's the CURRENTLY ACTIVE
  // tab that failed to open (see `notFoundTabId`'s own doc comment on `UseRepoTabsResult`) — a
  // defensive `&&` in case a future change ever let the two diverge, not just trusting the id.
  const notFoundTab =
    repoTabs.notFoundTabId && repoTabs.notFoundTabId === repoTabs.activeTabId
      ? (repoTabs.tabs.find((t) => t.id === repoTabs.notFoundTabId) ?? null)
      : null;

  // specs/repo-list.md AC6: the "No repository open" empty state's not-found/busy bookkeeping is
  // owned here (at `App`'s top level), not inside `EmptyState` itself — a recent-entry click drives
  // `graph.status` through `"opening"` and (on failure) briefly `"error"` before settling back to
  // `"idle"`, and `MainArea` only renders `EmptyState` while `status === "idle"`, unmounting it for
  // those transitional renders. State owned inside `EmptyState` would be lost by the time the
  // failure is actually known; `App` never unmounts, so this survives.
  const emptyStateRecentOpen = useRecentOpenRow(repoTabs.openRecentInNewTab);
  const removeEmptyStateRecent = useCallback(
    (path: string) => {
      recentRepos.removeRecentRepo(path);
      emptyStateRecentOpen.clearNotFound(path);
    },
    [recentRepos, emptyStateRecentOpen],
  );

  // FR-56: one refresh path for every successful branch create/switch/delete, regardless of which
  // surface triggered it (Branches panel row, ref-chip menu, or the graph's commit menu) —
  // refreshes the current-branch indicator/ref chips/HEAD decoration everywhere they appear
  // without resetting the already-loaded commit rows/scroll position (see `refreshRefs`'s doc
  // comment), plus the working-dir status (a switch can change it) and the Branches panel list.
  //
  // specs/self-write-refresh-suppression.md AC5 fix: `expected` — when the triggering mutation
  // knows its own outcome (`useBranchActions`' `switchTo`/`checkoutCommit`) — is forwarded into
  // `graph.refreshRefs` so its gate-closing confirming read can diff against exactly what this
  // specific operation was supposed to produce, rather than blindly trusting everything it reads.
  //
  // specs/graph-head-indicator-and-refresh-alerting.md Problem 1 (AC2/AC3/AC6): `expected.sha` —
  // only ever set for the switch/checkout paths that actually moved HEAD, never for delete/force-
  // delete — also auto-selects it in the graph. Deliberately calls `graph.selectCommit` directly
  // rather than the App-level `selectCommit` wrapper below — this is a "the cursor followed HEAD"
  // data-model update, not a user opening the DetailPanel, so it must not force whatever right
  // panel the user currently has open (e.g. Branches, mid-review of the switch they just made) to
  // switch away underneath them. `CommitGraph` reactively scrolls the row into view itself once
  // `selectedSha` changes (see its own doc comment) — no separate scroll call needed here.
  const refreshAfterBranchOp = useCallback(
    (expected?: ExpectedRefOutcome) => {
      void graph.refreshRefs(expected);
      void graph.refreshWorkingDirStatus();
      setBranchListReloadToken((t) => t + 1);
      if (expected?.sha) graph.selectCommit(expected.sha);
    },
    [graph],
  );

  // FR-51/52/53/54/55: a single shared instance so the Branches panel and the graph's ref-chip
  // context menu can never drift apart (AC15) — both call the exact same functions below.
  const branchActions = useBranchActions({
    api: graph.api,
    onChanged: refreshAfterBranchOp,
    // specs/self-write-refresh-suppression.md FR-6b/FR-6c: opens/closes the self-write gate around
    // the two named call sites (BranchesPanel row checkout, the graph's commit context-menu
    // "Checkout") — `onChanged`'s own `graph.refreshRefs()` call is what closes it on success;
    // `onMutationSettled` covers the failure path, which never reaches `onChanged`.
    onMutationStart: graph.beginMutation,
    onMutationSettled: graph.refreshRefs,
  });

  // Bug found via manual acceptance testing (specs/branch-management.md): `branchActions` and the
  // Branches panel's own list both live independently of which repo is currently open, so without
  // this, opening a *different* repository while a stale error banner is showing (e.g. "branch X
  // is checked out elsewhere") left that now-irrelevant error/other-repo's branch list on screen
  // -- confusing at best, actively misleading at worst, since the file paths/branch names named in
  // a leftover error banner belong to a repo that's no longer even open. Reset the branch-actions
  // error/confirmation state and force the (if open) Branches panel to refetch every time the open
  // repository actually changes.
  //
  // specs/multi-repo-tabs.md: keyed on `graph.openSequence` (bumped on every `openRepo`/
  // `closeRepo` call), not `graph.repoPath` — a recent-open that fails and restores the
  // previously-active tab (specs/repo-list.md AC6's `restoreGraphAfterFailedRecentOpen`) still
  // goes through a real close+reopen cycle even though `repoPath` ends up back at the same string
  // value, where a plain `repoPath` comparison would wrongly see "no change" and skip this reset.
  useEffect(() => {
    branchActions.dismissError();
    branchActions.cancelDelete();
    branchActions.cancelForceDelete();
    setBranchListReloadToken((t) => t + 1);
    // A New Branch dialog references the previously-open repo's refs — stale/misleading once the
    // open repository actually changes (new tab, tab switch, or the active tab's repo being
    // replaced), same reasoning as the branch-action reset above.
    setNewBranchRequest(null);
    // specs/stash.md: a stash-apply/pop conflict notice, or an open Create Stash dialog,
    // references the previously-open repo's working directory — stale/misleading once the open
    // repository actually changes, same reasoning as the New Branch dialog reset above.
    setShowCreateStashDialog(false);
    setStashConflictNotice(null);
    setStashListReloadToken((t) => t + 1);
    // specs/blame.md: a `BlamePanel` open on a path from the previously-open repo is stale/
    // misleading once the open repository actually changes, same reasoning as the resets above.
    setBlameTarget(null);
    // specs/compare-commits.md: a `CompareView` open on two commits from the previously-open repo
    // is stale/misleading (and those SHAs may not even exist in the new repo) once the open
    // repository actually changes, same reasoning as the blame/branch/stash resets above.
    setCompareTarget(null);
    // specs/cherry-pick.md: same staleness reasoning as the stash/branch resets above — a
    // leftover cherry-pick error banner would name a commit/reason from the previously-open repo.
    cherryPickActions.dismissError();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph.openSequence]);

  // specs/compare-commits.md FR-194: a plain single click on any commit row while `CompareView` is
  // open must close it and apply normal single-select behavior, rather than being silently
  // swallowed the way `blameTarget` swallows a plain click while it's active — every call site
  // below (a row click, a DetailPanel "jump to parent," `jumpToSha`'s branch/blame-jump paths, and
  // DetailPanel's own close button) represents the user now looking at (or explicitly leaving) one
  // specific commit's detail, which supersedes an active Compare in every one of those cases.
  const selectCommit = useCallback(
    (sha: string | null) => {
      graph.selectCommit(sha);
      setRightPanel(sha ? "commit" : "none");
      setCompareTarget(null);
    },
    [graph],
  );

  // specs/blame.md FR-134, generalized: jumps the graph to an arbitrary commit sha — applies the
  // graph's existing sha filter only if the target isn't already reachable in the currently-
  // loaded page (a real author/message/date/path filter is already active, the one case a commit
  // can be structurally excluded from ever appearing regardless of paging; or there's no more
  // history left to page in — a strong signal the target is unreachable from the current ref set
  // entirely), then selects it. Otherwise, the graph's own existing "jumped outside the loaded
  // range" chase/follow mechanism (CommitGraph.tsx) already resolves a plain selection with no
  // filter change needed. Originally FR-134's own logic, verbatim — extracted so the design-pass
  // "Branches panel relocation" 's "jump to a branch's tip commit" action reuses the exact same
  // mechanism (ROADMAP.md's explicit ask: "reusing the same jump pattern the commit filter
  // already uses") rather than forking a second one.
  const jumpToSha = useCallback(
    (sha: string) => {
      const filterActive = Object.keys(graph.filter).length > 0;
      const alreadyLoaded = graph.displayRows.some((r) => r.kind === "commit" && r.laid.commit.sha === sha);
      if (!alreadyLoaded && (filterActive || !graph.hasMore)) {
        graph.applyFilter({ sha });
      }
      selectCommit(sha);
    },
    [graph, selectCommit],
  );

  // specs/blame.md FR-134: clicking a blamed block's commit metadata — closes BlamePanel, then
  // jumps to it via `jumpToSha` above (which also opens its DetailPanel, via `selectCommit`).
  const jumpToBlameCommit = useCallback(
    (sha: string) => {
      setBlameTarget(null);
      jumpToSha(sha);
    },
    [jumpToSha],
  );

  const toggleChangesPanel = useCallback(() => {
    setRightPanel(rightPanel === "changes" ? "none" : "changes");
  }, [rightPanel, setRightPanel]);

  const toggleStashPanel = useCallback(() => {
    setRightPanel(rightPanel === "stashes" ? "none" : "stashes");
  }, [rightPanel, setRightPanel]);

  // specs/stash.md FR-101/FR-92: the one refresh path for every successful stash create/apply/
  // pop/drop, regardless of which surface triggered it (StashPanel's row buttons, or
  // CreateStashDialog reachable from either StashPanel's header or ChangesPanel's secondary
  // entry point) — refreshes the Toolbar's stash badge, this panel's own list, ChangesPanel's
  // file sections/working-dir-status badges, and the graph's uncommitted-changes pseudo-node.
  // `graph.refreshRefs()` (no expected outcome — stash mutations never move HEAD/branches, so
  // "nothing should have changed" is the correct expectation) also closes the self-write gate
  // `onMutationStart`/`beginMutation` opened for this operation, per FR-92.
  const refreshAfterStashOp = useCallback(() => {
    void graph.refreshRefs();
    void graph.refreshStashList();
    void graph.refreshWorkingDirStatus();
    setStashListReloadToken((t) => t + 1);
    setChangesReloadToken((t) => t + 1);
  }, [graph]);

  // FR-92: closes the self-write gate on a *failed* stash mutation — `refreshAfterStashOp` is
  // deliberately not called then (nothing succeeded to refresh), but the gate still needs a
  // confirming read or every later watcher event is deferred forever.
  const onStashMutationSettled = useCallback(() => {
    void graph.refreshRefs();
  }, [graph]);

  // specs/cherry-pick.md FR-121: the one refresh path for every settled cherry-pick/skip/
  // commit-empty attempt (clean apply or an expected pause alike, see `useCherryPickActions`'s own
  // doc comment) — calls `graph.refreshRefsAndRows()` directly rather than going through
  // `graph.refresh()`: a cherry-pick step can create new commits the already-loaded rows don't
  // have, so a settle callback needs the row-reload `refreshRefsAndRows` does — going through
  // `refresh()` here would work today too (specs/refresh-without-teardown.md made `refresh()` a
  // thin wrapper around this same call), but calling it directly keeps this settle path decoupled
  // from `refresh()`'s own external-change-banner-clearing side effects, which don't belong to a
  // cherry-pick step settling. Same fix applied to StatusBanner's Continue/Abort below, for the
  // same reason.
  const cherryPickActions = useCherryPickActions({
    api: graph.api,
    onSettled: () => void graph.refreshRefsAndRows(),
    // specs/self-write-refresh-suppression.md FR-6b: opens/closes the self-write gate around every
    // cherry-pick/skip/commit-empty call, exactly like `branchActions`/`StashPanel` above —
    // `onSettled`'s own `graph.refreshRefsAndRows()` closes it on both a clean success and an
    // expected pause (it shares `refreshRefs`'s FIFO-gate-close contract); `onMutationSettled`
    // covers the genuine-failure path, which never reaches `onSettled`.
    onMutationStart: graph.beginMutation,
    onMutationSettled: graph.refreshRefs,
  });

  // FR-98: a conflicting apply/pop opens ChangesPanel (superseding whatever right panel was open)
  // and shows the stash-specific inline notice there, pointing at the newly-populated Conflicted
  // section — no operation banner, no Continue/Abort (this is not an in-progress operation).
  const onStashConflict = useCallback(
    (action: "apply" | "pop") => {
      setStashConflictNotice({ action });
      setRightPanel("changes");
    },
    [setRightPanel],
  );

  const isBareRepo = !graph.repoState || graph.repoState.isBare || !graph.repoState.workdir;
  const createStashDisabledReason = computeCreateStashDisabledReason({
    isBare: isBareRepo,
    isUnbornHead: graph.repoState?.isUnbornHead ?? false,
    workingDirStatus: graph.workingDirStatus,
  });
  const stashToggleDisabledReason = isBareRepo
    ? "This is a bare repository — it has no working directory, so there is nothing to stash."
    : null;

  // specs/amend-last-commit.md FR-155: same unborn-HEAD/in-progress-operation signals already
  // read above for the stash-create gate, reused rather than re-derived — a bare repo renders no
  // composer at all (see ChangesPanel's `status === "bare"` branch), so this is never actually
  // consulted in that state.
  const amendDisabledReason = computeAmendDisabledReason({
    isUnbornHead: graph.repoState?.isUnbornHead ?? false,
    inProgressOperation: graph.repoState?.inProgressOperation ?? null,
  });

  // specs/stash.md AC7: a full manual/external-change-alert refresh already re-reads
  // repoState/refs/workingDirChanges/stashCount (via `graph.refresh()`'s `refreshRefsAndRows`
  // round-trip — see that function's own doc comment) — this also bumps StashPanel's own
  // independent list fetch, so a stash created/dropped from a separate terminal becomes visible the
  // moment the user acknowledges that alert, not only when the panel happens to be closed and
  // reopened.
  const refreshEverything = useCallback(() => {
    void graph.refresh();
    setStashListReloadToken((t) => t + 1);
  }, [graph]);

  // Must-have #2: clicking the uncommitted-changes "checkpoint" pseudo-node opens the Changes
  // panel (if not already showing) — never `selectCommit(null)`, which would just close whatever
  // panel is open. Re-clicking it while the Changes panel is already open forces a fresh
  // reload + re-auto-select (Must-have #3) instead of doing nothing: `refreshWorkingDirStatus()`
  // re-fetches the shared data (ROADMAP.md tech-debt fix — `ChangesPanel`'s `changes` prop no
  // longer has its own independent fetch to force), and the token bump clears the current
  // selection so `useChangesPanel`'s auto-select effect re-picks the first diffable file once that
  // fresh data lands.
  const selectCheckpoint = useCallback(() => {
    // specs/compare-commits.md FR-194's reasoning extends here too: activating the checkpoint row
    // is the user choosing a different graph row to look at, which should close an open Compare
    // the same way a plain commit-row click does.
    setCompareTarget(null);
    if (rightPanel === "changes") {
      setChangesReloadToken((t) => t + 1);
      void graph.refreshWorkingDirStatus();
    } else {
      setRightPanel("changes");
    }
  }, [rightPanel, graph]);

  const showChangesToggle = graph.status === "ready";
  const showBranchesToggle = graph.status === "ready";
  const changesCount = graph.workingDirStatus
    ? graph.workingDirStatus.staged +
      graph.workingDirStatus.unstaged +
      graph.workingDirStatus.untracked +
      graph.workingDirStatus.conflicted
    : null;

  // FR-56/edge cases: no branch is "current" for a bare repo (nothing checked out) or a detached
  // HEAD (labeled explicitly, distinct from a real branch name) — Toolbar falls back to a
  // neutral "Branches" label in both cases rather than showing something misleading.
  const currentBranchLabel = !graph.repoState || graph.repoState.isBare
    ? null
    : graph.repoState.isDetachedHead
      ? "Detached HEAD"
      : graph.repoState.currentBranch;

  const hasWorkdir = Boolean(graph.repoState && !graph.repoState.isBare && graph.repoState.workdir);

  return (
    <div className="gh-app">
      <TabBar
        tabs={repoTabs.tabs}
        activeTabId={repoTabs.activeTabId}
        onActivate={(id) => void repoTabs.activateTab(id)}
        onClose={repoTabs.closeTab}
        onNewTab={() => void repoTabs.newTab()}
        switching={repoTabs.switching}
      />
      <Toolbar
        repoPath={graph.repoPath}
        onRefresh={refreshEverything}
        canRefresh={graph.status === "ready"}
        isRefreshing={graph.isRefreshing}
        theme={theme}
        onToggleTheme={toggleTheme}
        showChangesToggle={showChangesToggle}
        changesCount={changesCount}
        changesOpen={rightPanel === "changes"}
        onToggleChanges={toggleChangesPanel}
        showBranchesToggle={showBranchesToggle}
        currentBranchLabel={currentBranchLabel}
        branchesOpen={!sidebarCollapsed}
        onToggleBranches={toggleSidebar}
        showStashToggle={showChangesToggle}
        stashCount={graph.stashCount}
        stashOpen={rightPanel === "stashes"}
        onToggleStash={toggleStashPanel}
        stashDisabledReason={stashToggleDisabledReason}
      />

      {graph.repoState && (
        <StatusBanner
          repoState={graph.repoState}
          hasExternalChanges={graph.hasExternalChanges}
          onRefresh={refreshEverything}
          api={graph.api}
          workingDirStatus={graph.workingDirStatus}
          // FR-68/70: abort/continue can move HEAD and clear the conflict set entirely —
          // `refreshRefsAndRows` picks up the new commit rows, refs, and working-directory status
          // in one go rather than patching each piece individually, same as `onCommitCreated`/
          // manual-refresh's intent, but without `refresh()`'s `openSequence`/`status` side
          // effects — see `cherryPickActions`'s own doc comment above for why those are unsafe to
          // trigger while the user may still be mid-resolution in `ConflictResolutionView`.
          onOperationChanged={() => void graph.refreshRefsAndRows()}
          // specs/self-write-refresh-suppression.md FR-6b: Continue/Abort open/close the same
          // self-write gate every other mutating action in the app already uses, so the watcher
          // can't misfire a spurious operationStateAlert while either is in flight.
          onMutationStart={graph.beginMutation}
          onMutationSettled={graph.refreshRefs}
          operationStateAlert={graph.operationStateAlert}
          isRefreshing={graph.isRefreshing}
        />
      )}

      {/* specs/cherry-pick.md FR-118: the FR-105 empty-result pause's distinct, non-conflict
          notice — derived directly from fresh `RepositoryState` (never a separately-tracked/
          synthesized flag, matching this codebase's "git's on-disk state is the state"
          convention), so it appears/disappears purely from what `graph.refresh()` just read. */}
      {graph.repoState?.inProgressOperationDetail?.kind === "cherry-pick" &&
        graph.repoState.inProgressOperationDetail.isEmptyResult && (
          <CherryPickEmptyResultNotice
            targetSha={graph.repoState.inProgressOperationDetail.targetSha}
            targetSubject={graph.repoState.inProgressOperationDetail.targetSubject}
            onSkip={cherryPickActions.skip}
            onCommitEmpty={cherryPickActions.commitEmpty}
            busy={cherryPickActions.busy}
          />
        )}

      {/* FR-120: any cherry-pick failure that ISN'T an expected pause (see
          `useCherryPickActions`'s doc comment) — a genuine refusal surfaced verbatim. */}
      {cherryPickActions.error && (
        <div className="gh-status-banner-stack">
          <div className="gh-status-banner gh-status-banner--warning" role="alert">
            <span>{cherryPickActions.error}</span>
            <button type="button" className="gh-status-banner__action" onClick={cherryPickActions.dismissError}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* FR-51/54/55: a branch-op failure triggered from the graph (ref-chip menu, commit menu)
          while the Branches sidebar isn't visible (collapsed, or no repo open yet) has nowhere
          else to surface — the sidebar itself shows the same `branchActions.error` whenever it
          *is* visible, so this never double-renders it. design-pass "Branches panel relocation":
          was `rightPanel !== "branches"` before the sidebar became persistent/independent of
          `rightPanel`. */}
      {branchActions.error && (sidebarCollapsed || graph.status !== "ready") && (
        <div className="gh-status-banner-stack">
          <div className="gh-status-banner gh-status-banner--warning" role="alert">
            <span>{branchActions.error}</span>
            <button type="button" className="gh-status-banner__action" onClick={branchActions.dismissError}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {graph.status === "ready" && graph.repoState && !graph.repoState.isEmpty && !graph.repoState.isUnbornHead && (
        <FilterBar
          // specs/multi-repo-tabs.md: no `key` here (deliberately, unlike ChangesPanel below) —
          // FilterBar's field values are already fully prop-driven (`filter`), so it doesn't need
          // a remount to pick up a different tab's values on activation; it only needs its
          // expand/collapse disclosure reset at that same boundary, which `openSequence` drives
          // directly (see FilterBar's own doc comment for why forcing a remount for that instead
          // regressed AC4 — the disclosure re-collapsed a tab's already-applied filter on switch).
          openSequence={graph.openSequence}
          filter={graph.filter}
          onApply={graph.applyFilter}
          onClear={graph.clearFilter}
          showAllRefs={graph.showAllRefs}
          onShowAllRefsChange={graph.setShowAllRefs}
          // design-pass fix #5: derived, not a new hook field — `displayRows` already carries
          // exactly the currently-loaded page (real commits plus, when present, the uncommitted
          // pseudo-row, excluded here since it isn't a loaded history commit).
          loadedCommitCount={graph.displayRows.filter((r) => r.kind === "commit").length}
          hasMoreCommits={graph.hasMore}
        />
      )}

      <div className="gh-app__body" id="gh-app-main">
        {/* design-pass "Branches panel relocation": rendered first in the flex row — a persistent
            left sidebar, independent of `rightPanel` (never gated on it, never one of its mutually
            exclusive values) — visible for the lifetime of an open repo rather than toggled open/
            closed like the right-hand rails below. */}
        {graph.status === "ready" && (
          <BranchesPanel
            api={graph.api}
            repoState={graph.repoState}
            actions={branchActions}
            reloadToken={branchListReloadToken}
            onRequestNewBranch={() => setNewBranchRequest({})}
            collapsed={sidebarCollapsed}
            onToggleCollapsed={toggleSidebar}
            onLocateBranch={jumpToSha}
          />
        )}
        <MainArea
          graph={graph}
          onSelectCommit={selectCommit}
          onSelectCheckpoint={selectCheckpoint}
          onCheckoutCommit={(sha) => void branchActions.checkoutCommit(sha)}
          onCreateBranchAt={(sha, label) => setNewBranchRequest({ defaultStartPoint: { value: sha, label } })}
          onSwitchBranch={(name) => void branchActions.switchTo(name)}
          onDeleteBranch={(name) => branchActions.requestDelete(name)}
          onCherryPick={cherryPickActions.cherryPick}
          cherryPickBusy={cherryPickActions.busy}
          onCompare={openCompare}
          compareTarget={compareTarget}
          recentRepos={recentRepos.recentRepos}
          recentDivergentPickedPaths={recentRepos.divergentPickedPaths}
          recentNotFoundPath={emptyStateRecentOpen.notFoundPath}
          recentBusyPath={emptyStateRecentOpen.busyPath}
          onOpenRecent={emptyStateRecentOpen.openRecent}
          onRemoveRecent={removeEmptyStateRecent}
          onBrowse={() => void repoTabs.openNewTab()}
          browseDisabled={repoTabs.switching}
          notFoundTab={notFoundTab}
          onRetryTab={(id) => void repoTabs.activateTab(id)}
          onRemoveTab={repoTabs.closeTab}
        />
        {/* specs/compare-commits.md FR-189: `CompareView` pre-empts every one of the four
            `rightPanel` states AND `blameTarget` itself, the exact same precedence `blameTarget`
            already has over those four — rendered here, first, ahead of all of them. Closing it
            (its own × ) sets `compareTarget` back to `null`, which reveals whichever of
            `rightPanel`/`blameTarget` was already set underneath, unchanged the entire time
            Compare was open — the same restoration `BlamePanel`'s own close already relies on. */}
        {compareTarget && graph.status === "ready" && (
          <CompareView api={graph.api} target={compareTarget} onClose={() => setCompareTarget(null)} onSwap={swapCompare} />
        )}
        {!compareTarget && !blameTarget && rightPanel === "commit" && graph.status === "ready" && (
          <DetailPanel
            detail={graph.commitDetail}
            isRepoDetachedHead={graph.repoState?.isDetachedHead ?? false}
            api={graph.api}
            onJumpToParent={(sha) => selectCommit(sha)}
            onClose={() => selectCommit(null)}
            onOpenBlame={openBlame}
            // specs/remember-last-selected-file.md FR-217/FR-219/FR-216
            initialFileHint={rememberedFile?.kind === "commit" ? rememberedFile.path : null}
            onRestoredFileConsumed={onRestoredFileConsumed}
            onFileSelected={(path) => setSelectedFile({ kind: "commit", path })}
          />
        )}
        {!compareTarget && !blameTarget && rightPanel === "changes" && graph.status === "ready" && (
          <ChangesPanel
            // specs/multi-repo-tabs.md: `ChangesPanel`'s `changes` prop below is `graph`-owned, but
            // `useChangesPanel`'s own local selection/diff/composer state is not — without a key
            // forcing a real remount on every repo open, switching to a different tab while the
            // Changes panel is open can leave the *previous* repo's selection/diff/composer state
            // on screen — see `openSequence`'s doc comment for why `repoPath` alone isn't a safe
            // key and why this can't be fixed by relying on the `graph.status === "ready"`
            // condition here ever actually toggling false in between
            // (React can coalesce that transition away entirely).
            key={graph.openSequence}
            api={graph.api}
            changes={graph.workingDirChanges}
            onClose={() => setRightPanel("none")}
            onWorkingDirChanged={() => void graph.refreshWorkingDirStatus()}
            onCommitCreated={() => void graph.refresh()}
            reloadToken={changesReloadToken}
            blockConflictActions={graph.operationStateAlert !== null}
            // specs/self-write-refresh-suppression.md FR-6b: opens/closes the self-write gate
            // around Accept Ours/Accept Theirs/Mark as resolved — see `useConflictResolution`'s own
            // doc comment for why a conflict resolved mid a paused operation (e.g. a multi-commit
            // cherry-pick) needs this exactly like `branchActions`/`StashPanel`/`cherryPickActions`.
            onMutationStart={graph.beginMutation}
            onMutationSettled={graph.refreshRefs}
            onRequestNewStash={() => setShowCreateStashDialog(true)}
            createStashDisabledReason={createStashDisabledReason}
            stashConflictNotice={stashConflictNotice}
            onDismissStashConflictNotice={() => setStashConflictNotice(null)}
            onOpenBlame={openBlame}
            headSha={graph.repoState?.headSha ?? null}
            amendDisabledReason={amendDisabledReason}
            // specs/remember-last-selected-file.md FR-218/FR-219/FR-216
            initialSelectedFile={
              rememberedFile?.kind === "changes" ? { category: rememberedFile.category, path: rememberedFile.path } : null
            }
            onRestoredFileConsumed={onRestoredFileConsumed}
            onFileSelected={(file: SelectedFile) => setSelectedFile({ kind: "changes", category: file.category, path: file.path })}
          />
        )}
        {!compareTarget && !blameTarget && rightPanel === "stashes" && graph.status === "ready" && (
          <StashPanel
            // specs/multi-repo-tabs.md: same remount-on-repo-open reasoning as ChangesPanel above
            // — `useStashList` only fetches on mount, so without this key a tab switch could leave
            // the previous repo's stash list on screen.
            key={graph.openSequence}
            api={graph.api}
            repoState={graph.repoState}
            reloadToken={stashListReloadToken}
            onClose={() => setRightPanel("none")}
            onRequestNewStash={() => setShowCreateStashDialog(true)}
            onMutated={refreshAfterStashOp}
            onMutationStart={graph.beginMutation}
            onMutationSettled={onStashMutationSettled}
            onConflict={onStashConflict}
            createDisabledReason={createStashDisabledReason}
          />
        )}
        {!compareTarget && blameTarget && graph.status === "ready" && (
          <BlamePanel
            api={graph.api}
            target={blameTarget}
            onClose={() => setBlameTarget(null)}
            onReblame={(revision) => setBlameTarget((t) => (t ? { ...t, revision } : t))}
            onJumpToCommit={jumpToBlameCommit}
          />
        )}
      </div>

      {newBranchRequest && graph.repoState && (
        <NewBranchDialog
          api={graph.api}
          refs={graph.refs}
          hasWorkdir={hasWorkdir}
          isEmptyRepo={graph.repoState.isEmpty}
          isUnbornHead={graph.repoState.isUnbornHead}
          defaultStartPoint={newBranchRequest.defaultStartPoint}
          onClose={() => setNewBranchRequest(null)}
          onCreated={refreshAfterBranchOp}
        />
      )}

      {showCreateStashDialog && graph.repoState && (
        <CreateStashDialog
          api={graph.api}
          isBare={isBareRepo}
          isUnbornHead={graph.repoState.isUnbornHead}
          onClose={() => setShowCreateStashDialog(false)}
          onCreated={refreshAfterStashOp}
          onMutationStart={graph.beginMutation}
          onMutationSettled={onStashMutationSettled}
        />
      )}

      {branchActions.pendingDelete && (
        <ConfirmDialog
          title="Delete branch?"
          message={`Delete branch "${branchActions.pendingDelete}"? This cannot be undone.`}
          confirmLabel="Delete"
          destructive
          onConfirm={branchActions.confirmDelete}
          onCancel={branchActions.cancelDelete}
        />
      )}
      {branchActions.pendingForceDelete && (
        <ConfirmDialog
          title="Branch has unmerged commits"
          message={`"${branchActions.pendingForceDelete}" has commits that are not merged anywhere else. Force-deleting it may make those commits unreachable and hard to recover. Force-delete anyway?`}
          confirmLabel="Force delete"
          destructive
          onConfirm={branchActions.confirmForceDelete}
          onCancel={branchActions.cancelForceDelete}
        />
      )}
    </div>
  );
}

/**
 * specs/repo-open-feedback.md FR-166: the "Opening repository…" spinner, extended with a
 * running elapsed-time readout. `openSequence` (bumped on every `openRepo` call — see its own doc
 * comment in `useRepositoryGraph.ts`) is passed through as `useElapsedSeconds`'s `resetKey` so a
 * rapid re-open that supersedes an already-in-flight attempt (status staying `"opening"` the whole
 * time, never dropping to `false`) still restarts the clock at 0 for the new attempt.
 *
 * The ticking `"Ns"` readout is deliberately kept *outside* the `role="status"`/`aria-live="polite"`
 * region rather than inside it: a live region announces every text mutation within it, and a
 * once-a-second announcement for the full duration of a slow open would be a screen-reader spam
 * regression, not an accessibility improvement. The static "Opening repository…" label is
 * announced once, when the region first appears; the elapsed readout stays in the accessible tree
 * (an `aria-label` spells it out for anyone who navigates to it) but never forces an interruption.
 *
 * specs/repo-open-feedback.md FR-167/FR-168/FR-170: the Cancel button is present unconditionally,
 * from the very first render of this component — never gated behind `elapsedSeconds` crossing some
 * threshold — and calls the single `onCancel` (`graph.cancelOpen`) every entry point's `openRepo`
 * call funnels through, so there is nothing here to special-case per caller.
 */
function OpeningSpinner({ openSequence, onCancel }: { openSequence: number; onCancel: () => void }) {
  const elapsedSeconds = useElapsedSeconds(true, openSequence);
  return (
    <div className="gh-loading">
      <div className="gh-loading__bar" />
      <div className="gh-loading__label">
        <span role="status" aria-live="polite" aria-busy="true">
          Opening repository…
        </span>
        <span
          className="gh-loading__elapsed"
          aria-label={`Elapsed time: ${elapsedSeconds} second${elapsedSeconds === 1 ? "" : "s"}`}
        >
          {elapsedSeconds}s
        </span>
      </div>
      <button type="button" className="gh-loading__cancel" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

function MainArea({
  graph,
  onSelectCommit,
  onSelectCheckpoint,
  onCheckoutCommit,
  onCreateBranchAt,
  onSwitchBranch,
  onDeleteBranch,
  onCherryPick,
  cherryPickBusy,
  onCompare,
  compareTarget,
  recentRepos,
  recentDivergentPickedPaths,
  recentNotFoundPath,
  recentBusyPath,
  onOpenRecent,
  onRemoveRecent,
  onBrowse,
  browseDisabled,
  notFoundTab,
  onRetryTab,
  onRemoveTab,
}: {
  graph: ReturnType<typeof useRepositoryGraph>;
  onSelectCommit: (sha: string | null) => void;
  onSelectCheckpoint: () => void;
  onCheckoutCommit: (sha: string) => void;
  onCreateBranchAt: (sha: string, label: string) => void;
  onSwitchBranch: (branchName: string) => void;
  onDeleteBranch: (branchName: string) => void;
  onCherryPick: (shas: string[]) => void;
  cherryPickBusy: boolean;
  onCompare: (baseSha: string, targetSha: string) => void;
  compareTarget: CompareTarget | null;
  /** specs/repo-list.md Must-have 2: only ever wired to the "No repository open" idle empty
   * state below — never the "No commits yet"/"No matching commits" ones further down, which
   * aren't "no repository open" at all. */
  recentRepos: string[];
  /** specs/repo-open-feedback-fixes.md FR-204: see `EmptyState`'s own prop doc comment. */
  recentDivergentPickedPaths: Record<string, string>;
  recentNotFoundPath: string | null;
  recentBusyPath: string | null;
  onOpenRecent: (path: string) => void;
  onRemoveRecent: (path: string) => void;
  onBrowse: () => void;
  browseDisabled: boolean;
  /** specs/restore-tabs-on-relaunch.md FR-212/AC5: the currently-active tab, when (and only when)
   * its own most recent activation attempt discovered its `repoPath` no longer resolves to a
   * valid repo — `null` the rest of the time (including whenever `graph.status !== "idle"`, since
   * a genuine not-found always leaves `graph` reset to `"idle"`, see `activateTabCore`'s own doc
   * comment). */
  notFoundTab: RepoTab | null;
  onRetryTab: (id: string) => void;
  onRemoveTab: (id: string) => void;
}) {
  if (graph.status === "idle" && notFoundTab) {
    return (
      <TabNotFoundState
        path={notFoundTab.repoPath}
        busy={browseDisabled}
        onRetry={() => onRetryTab(notFoundTab.id)}
        onRemove={() => onRemoveTab(notFoundTab.id)}
      />
    );
  }

  if (graph.status === "idle") {
    return (
      <EmptyState
        title="No repository open"
        description="Choose a local git repository — including bare repos, shallow clones, and worktrees — to see its commit graph."
        recentRepos={recentRepos}
        divergentPickedPaths={recentDivergentPickedPaths}
        notFoundPath={recentNotFoundPath}
        busyPath={recentBusyPath}
        onOpenRecent={onOpenRecent}
        onRemoveRecent={onRemoveRecent}
        onBrowse={onBrowse}
        disabled={browseDisabled}
      />
    );
  }

  if (graph.status === "opening") {
    return <OpeningSpinner openSequence={graph.openSequence} onCancel={graph.cancelOpen} />;
  }

  if (graph.status === "error") {
    return (
      <div className="gh-error" role="alert">
        <p className="gh-error__title">Could not open this repository</p>
        <p className="gh-error__message">{graph.errorMessage}</p>
      </div>
    );
  }

  // status === "ready"
  if (graph.repoState?.isEmpty || graph.repoState?.isUnbornHead) {
    // AC7: a freshly-initialized, zero-commit repo gets an explicit empty state.
    return (
      <EmptyState
        title="No commits yet"
        description="This repository has no commits. Make the first commit, then refresh to see it here."
      />
    );
  }

  if (graph.displayRows.length === 0) {
    if (graph.isLoadingMore) {
      return (
        <div className="gh-loading" role="status" aria-live="polite" aria-busy="true">
          <div className="gh-loading__bar" />
          <span>Loading commits…</span>
        </div>
      );
    }
    // A filter (FR-14) narrowed results to nothing — distinct from AC7's "truly empty repo"
    // state above, so the user knows to clear the filter rather than wondering if the app hung.
    return (
      <EmptyState
        title="No matching commits"
        description="No commits match the current filter. Clear the filter to see the full graph."
      />
    );
  }

  return (
    <CommitGraph
      displayRows={graph.displayRows}
      maxLaneIndexSeen={graph.maxLaneIndexSeen}
      hasMore={graph.hasMore}
      isLoadingMore={graph.isLoadingMore}
      onLoadMore={graph.loadMore}
      visibleRefNames={graph.visibleRefNames}
      repoState={graph.repoState}
      selectedSha={graph.selectedSha}
      onSelectCommit={onSelectCommit}
      onSelectCheckpoint={onSelectCheckpoint}
      theme={document.documentElement.dataset.theme === "light" ? "light" : "dark"}
      onCheckoutCommit={onCheckoutCommit}
      onCreateBranchAt={onCreateBranchAt}
      onSwitchBranch={onSwitchBranch}
      onDeleteBranch={onDeleteBranch}
      onCherryPick={onCherryPick}
      cherryPickBusy={cherryPickBusy}
      onCompare={onCompare}
      compareTarget={compareTarget}
    />
  );
}
