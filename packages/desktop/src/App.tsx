// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CommitPairRelationship } from "@githydra/git-core";
import { BlamePanel } from "./components/BlamePanel/BlamePanel";
import { BranchesPanel } from "./components/BranchesPanel/BranchesPanel";
import { ChangesPanel, type ChangesPanelHandle } from "./components/ChangesPanel/ChangesPanel";
import { LeftBehindBanner } from "./components/LeftBehindBanner/LeftBehindBanner";
import { OrphanedCommitsDialog } from "./components/OrphanedCommitsDialog/OrphanedCommitsDialog";
import { CherryPickEmptyResultNotice } from "./components/CherryPickEmptyResultNotice/CherryPickEmptyResultNotice";
import { CloneDialog } from "./components/CloneDialog/CloneDialog";
import { CommandPalette } from "./components/CommandPalette/CommandPalette";
import { MergeBranchPicker } from "./components/MergeBranchPicker/MergeBranchPicker";
import { CommitGraph } from "./components/CommitGraph/CommitGraph";
import { CompareView } from "./components/CompareView/CompareView";
import { ConfirmDialog } from "./components/ConfirmDialog/ConfirmDialog";
import { CreateStashDialog } from "./components/CreateStashDialog/CreateStashDialog";
import { DetailPanel } from "./components/DetailPanel/DetailPanel";
import { EmptyState } from "./components/EmptyState/EmptyState";
import { FetchStatusBanner } from "./components/FetchStatusBanner/FetchStatusBanner";
import { FindCommitsOverlay, isFilterActiveOf } from "./components/FindCommitsOverlay/FindCommitsOverlay";
import { IdentityProfilesDialog } from "./components/IdentityProfilesDialog/IdentityProfilesDialog";
import { KeyboardShortcutsScreen } from "./components/KeyboardShortcutsScreen/KeyboardShortcutsScreen";
import { NewBranchDialog } from "./components/NewBranchDialog/NewBranchDialog";
import { PullStatusBanner } from "./components/PullStatusBanner/PullStatusBanner";
import { PushStatusBanner } from "./components/PushStatusBanner/PushStatusBanner";
import { ResetBranchDialog, type ResetBranchDialogTarget } from "./components/ResetBranchDialog/ResetBranchDialog";
import { StashPanel } from "./components/StashPanel/StashPanel";
import { StatusBanner } from "./components/StatusBanner/StatusBanner";
import { TabBar } from "./components/TabBar/TabBar";
import { TabNotFoundState } from "./components/TabNotFoundState/TabNotFoundState";
import { Toolbar } from "./components/Toolbar/Toolbar";
import type { BlameTarget } from "./hooks/useBlame";
import { useBranchActions } from "./hooks/useBranchActions";
import type { CompareTarget } from "./hooks/useCompare";
import { useCherryPickActions } from "./hooks/useCherryPickActions";
import { useCurrentBranchUpstream } from "./hooks/useCurrentBranchUpstream";
import { useDivergedBranches } from "./hooks/useDivergedBranches";
import { useDragCommitActions } from "./hooks/useDragCommitActions";
import { useOrphanGuard } from "./hooks/useOrphanGuard";
import { BranchDragContext, useBranchDragSession } from "./hooks/useBranchDragSession";
import { useElapsedSeconds } from "./hooks/useElapsedSeconds";
import { useFetchAction } from "./hooks/useFetchAction";
import { usePullAction } from "./hooks/usePullAction";
import { usePushAction } from "./hooks/usePushAction";
import { usePushTarget } from "./hooks/usePushTarget";
import { unwrap } from "./hooks/gitHydraClient";
import { useGlobalKeybindings } from "./hooks/useGlobalKeybindings";
import {
  getPersistedRightPanel,
  getPersistedSidebarCollapsed,
  persistRightPanel,
  persistSidebarCollapsed,
} from "./hooks/useLayoutPreferences";
import { useIdentityApplications } from "./hooks/useIdentityApplications";
import { useIdentityProfiles } from "./hooks/useIdentityProfiles";
import { useKeybindingOverrides } from "./hooks/useKeybindingOverrides";
import { useRecentOpenRow } from "./hooks/useRecentOpenRow";
import { useRecentRepos } from "./hooks/useRecentRepos";
import { useRepositoryGraph } from "./hooks/useRepositoryGraph";
import { useResetActions } from "./hooks/useResetActions";
import { useRepoTabs, type RememberedFileSelection, type RepoTab, type RightPanel } from "./hooks/useRepoTabs";
import type { SelectedFile } from "./hooks/useChangesPanel";
import type { ExpectedRefOutcome } from "./hooks/selfWriteGate";
import { useTheme } from "./hooks/useTheme";
import { computeAmendDisabledReason } from "./lib/amendEligibility";
import { getCommands, type CommandContext } from "./lib/commands";
import { applyKeybindingOverrides } from "./lib/keybindingOverrides";
import { keyComboLabel } from "./lib/platform";
import { formatLastFetchedLabel } from "./lib/format";
import { computeIdentityNetworkOpDisabledReason } from "./lib/identityNotices";
import { computePullDisabledReason } from "./lib/pullEligibility";
import { computePushDisabledReason } from "./lib/pushEligibility";
import { describeResetHardDangerCounts } from "./lib/resetImpact";
import { computeCreateStashDisabledReason } from "./lib/stashEligibility";
import "./App.css";

/** specs/stash.md FR-98: which action left conflicts behind; drives ChangesPanel's inline notice. */
interface StashConflictNotice {
  action: "apply" | "pop";
}

/** FR-49/FR-54: New Branch dialog request (non-null = open); defaultStartPoint is set from the graph's "Create branch here". */
interface NewBranchRequest {
  defaultStartPoint?: { value: string; label: string };
}

export function App() {
  // specs/repo-list.md Must-have 1: the one session-shared recent-repos list.
  // specs/repo-open-feedback-fixes.md FR-204: onRepoOpened forwards (path, pickedPath) so addRecentRepo can persist divergent picks.
  const recentRepos = useRecentRepos();
  const graph = useRepositoryGraph({ onRepoOpened: recentRepos.addRecentRepo });
  const [theme, toggleTheme] = useTheme();
  // specs/keyboard-shortcut-rebinding.md FR-394/FR-405: global override layer over commands.ts defaults.
  const keybindingOverrides = useKeybindingOverrides();
  // Must-have C16/C18: seeded from the persisted panel; "commit" is never persisted so a relaunch doesn't reopen DetailPanel.
  const [rightPanel, setRightPanelState] = useState<RightPanel>(() => getPersistedRightPanel());
  // Must-have C16/C17: persist only none/changes/stashes ("commit" derives from selection; the Branches sidebar has its own preference).
  const setRightPanel = useCallback((value: RightPanel) => {
    setRightPanelState(value);
    if (value !== "commit") persistRightPanel(value);
  }, []);
  // Branches sidebar collapse state: separate from rightPanel because the sidebar is independent of the right-hand rails.
  const [sidebarCollapsed, setSidebarCollapsedState] = useState<boolean>(() => getPersistedSidebarCollapsed());
  const setSidebarCollapsed = useCallback((value: boolean) => {
    setSidebarCollapsedState(value);
    persistSidebarCollapsed(value);
  }, []);
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed(!sidebarCollapsed);
  }, [sidebarCollapsed, setSidebarCollapsed]);
  // specs/detailpanel-auto-diff.md Must-have #2/#3: bumped on checkpoint re-click so useChangesPanel reloads without a remount.
  const [changesReloadToken, setChangesReloadToken] = useState(0);
  // FR-56: bumped after any branch mutation so BranchesPanel's independent list refetches, including mutations from graph menus.
  const [branchListReloadToken, setBranchListReloadToken] = useState(0);
  // specs/branch-panel-drag-merge.md FR-437: the "Merge branch into current branch..." picker.
  const [mergeBranchPickerOpen, setMergeBranchPickerOpen] = useState(false);
  // specs/online-sync-fetch.md FR-326: session-only, keyed by repo path so a tab never shows another repo's fetch time.
  const [lastFetchedAtByPath, setLastFetchedAtByPath] = useState<Record<string, Date>>({});
  const [newBranchRequest, setNewBranchRequest] = useState<NewBranchRequest | null>(null);
  // specs/stash.md FR-101: bumped after stash mutations or an acknowledged external change so StashPanel refetches.
  const [stashListReloadToken, setStashListReloadToken] = useState(0);
  const [showCreateStashDialog, setShowCreateStashDialog] = useState(false);
  const [stashConflictNotice, setStashConflictNotice] = useState<StashConflictNotice | null>(null);
  // specs/keyboard-shortcuts-reference.md FR-231/FR-237: shortcuts overlay toggle; folded into anyModalDialogOpen.
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // specs/find-commits-overlay.md FR-259: overlay toggle; folded into anyModalDialogOpen (FR-266).
  const [findCommitsOpen, setFindCommitsOpen] = useState(false);
  // specs/git-identity-profiles.md: dialog toggle plus its two app-storage stores (profile library FR-329; per-repo
  // applications, kept out of .git/config because it is attacker-writable — see useIdentityApplications.ts).
  const [identityProfilesOpen, setIdentityProfilesOpen] = useState(false);
  const identityProfiles = useIdentityProfiles();
  const identityApplications = useIdentityApplications();
  // specs/online-sync-clone.md FR-351: deliberately NOT reset on repo change (unlike other dialogs) — it shows no
  // repo-scoped data and is reachable with no repo open.
  const [cloneDialogOpen, setCloneDialogOpen] = useState(false);
  // FR-267: bumped to focus the Branches search box (BranchesPanel focusSearchToken).
  const [focusSearchToken, setFocusSearchToken] = useState(0);
  // specs/keyboard-shortcuts-command-palette.md FR-224/FR-230: handle onto ChangesPanel for the "Commit staged changes"
  // command; canCommit mirrors the composer's eligibility via onCommitAvailabilityChange.
  const changesPanelRef = useRef<ChangesPanelHandle>(null);
  const [changesPanelCanCommit, setChangesPanelCanCommit] = useState(false);
  // specs/hunk-line-staging.md FR-483: whether an eligible checkbox diff has a hunk under the cursor (ChangesPanel reports it).
  const [hunkCommands, setHunkCommands] = useState({ toggle: false, discard: false });
  // FR-221/AC10 (security-reviewer finding): panel-local ConfirmDialogs (ChangesPanel discard/amend, StashPanel drop,
  // StatusBanner abort) lift their open state here so global keybindings suspend; otherwise Ctrl/Cmd+Enter re-invoked
  // submitCommit() under the amend warning.
  const [changesPanelDialogOpen, setChangesPanelDialogOpen] = useState(false);
  const [stashPanelDialogOpen, setStashPanelDialogOpen] = useState(false);
  const [statusBannerDialogOpen, setStatusBannerDialogOpen] = useState(false);
  // FR-221: CommitGraph's commit-row and ref-chip ContextMenus fold into this one boolean (ChangesPanel's file-row menu
  // reuses its onDialogOpenChange).
  const [commitGraphContextMenuOpen, setCommitGraphContextMenuOpen] = useState(false);
  // FR-221: DetailPanel's own file-row ContextMenu, a separate call site.
  const [detailPanelContextMenuOpen, setDetailPanelContextMenuOpen] = useState(false);
  // specs/blame.md FR-131/132: null = closed. Not part of rightPanel: BlamePanel overlays the rail panel it was opened
  // from, and closing it reveals that panel again.
  const [blameTarget, setBlameTarget] = useState<BlameTarget | null>(null);
  const openBlame = useCallback((path: string, revision: string | null) => {
    setBlameTarget({ path, revision });
  }, []);

  // specs/reset-to-here.md FR-367: commit the mode dialog is open for (null = closed); the mutating flow lives in useResetActions.
  const [resetTarget, setResetTarget] = useState<ResetBranchDialogTarget | null>(null);

  // specs/compare-commits.md FR-189: commits CompareView shows (null = closed); pre-empts rightPanel and blameTarget.
  // Deliberate deviations from blame: FR-194 (selectCommit), FR-195 (openCompare), FR-196 (CommitGraph compareTarget). Never persisted.
  const [compareTarget, setCompareTarget] = useState<CompareTarget | null>(null);
  // FR-187/195: re-invoking while open just overwrites the target.
  const openCompare = useCallback((baseSha: string, targetSha: string) => {
    setCompareTarget({ baseSha, targetSha });
  }, []);
  // FR-193: swap base/target.
  const swapCompare = useCallback(() => {
    setCompareTarget((t) => (t ? { baseSha: t.targetSha, targetSha: t.baseSha } : t));
  }, []);

  // specs/remember-last-selected-file.md FR-215/FR-216: live selection from DetailPanel/ChangesPanel, snapshotted by useRepoTabs alongside rightPanel.
  const [selectedFile, setSelectedFile] = useState<RememberedFileSelection | null>(null);

  // specs/multi-repo-tabs.md: tab orchestration over the one live graph (option B). Gets setRightPanelState, not the
  // persisting setter, so tab switches never overwrite the user's panel preference (Must-have 10).
  const repoTabs = useRepoTabs({
    graph,
    rightPanel,
    setRightPanel: setRightPanelState,
    getSeedRightPanel: getPersistedRightPanel,
    selectedFile,
    setSelectedFile,
  });
  // specs/find-commits-overlay.md FR-265/AC9: guardedTabAction defers the tab switch to a later render and must call the
  // freshest repoTabs closures (which see the just-cleared graph.filter), not ones captured at click time. Plain
  // assignment so it is current when the deferred effect runs.
  const repoTabsRef = useRef(repoTabs);
  repoTabsRef.current = repoTabs;

  // specs/remember-last-selected-file.md FR-217/218/219: the active tab's remembered file is handed to a panel once per real
  // activation (graph.openSequence vs. the "spent" seq); a same-tab panel toggle must not re-consult it. Never mutated, so
  // it survives reactivation and relaunch (AC6).
  const activeTab = repoTabs.tabs.find((t) => t.id === repoTabs.activeTabId) ?? null;
  const consumedFileRestoreSeqRef = useRef<number | null>(null);
  const rememberedFile = graph.openSequence !== consumedFileRestoreSeqRef.current ? (activeTab?.remembered.selectedFile ?? null) : null;
  // Panels call this once they consult rememberedFile for their own kind.
  const onRestoredFileConsumed = () => {
    consumedFileRestoreSeqRef.current = graph.openSequence;
  };
  // Race (security-reviewer): if rememberedFile.kind doesn't match the panel the snapshot had open (e.g. tab switched
  // before a commit detail fetch updated selectedFile), no panel ever spends it and it leaks into a later-opened panel.
  // Compare against activeTab.remembered.rightPanel, not the live rightPanel or the first openSequence render:
  // activateTabCore sets rightPanel only after openRepo resolves, so transient renders disagree and eager spending stole
  // legitimate restores (AC1/AC2/AC5/AC6). The snapshot is immutable, so both sides are consistent immediately.
  // Mismatch means no panel can consult it, so spend now; a match is spent by the panel once its data is ready.
  const rememberedFileCannotBeConsultedThisActivation =
    rememberedFile !== null && activeTab !== null && rememberedFile.kind !== activeTab.remembered.rightPanel;
  useLayoutEffect(() => {
    if (rememberedFileCannotBeConsultedThisActivation) {
      consumedFileRestoreSeqRef.current = graph.openSequence;
    }
  }, [rememberedFileCannotBeConsultedThisActivation, graph.openSequence]);

  // specs/restore-tabs-on-relaunch.md FR-212/AC5: only when the ACTIVE tab failed to open; the && guards against the ids diverging.
  const notFoundTab =
    repoTabs.notFoundTabId && repoTabs.notFoundTabId === repoTabs.activeTabId
      ? (repoTabs.tabs.find((t) => t.id === repoTabs.notFoundTabId) ?? null)
      : null;

  // specs/repo-list.md AC6: owned here, not in EmptyState — MainArea unmounts EmptyState while status is "opening"/"error",
  // which would lose the not-found/busy state.
  const emptyStateRecentOpen = useRecentOpenRow(repoTabs.openRecentInNewTab);
  const removeEmptyStateRecent = useCallback(
    (path: string) => {
      recentRepos.removeRecentRepo(path);
      emptyStateRecentOpen.clearNotFound(path);
    },
    [recentRepos, emptyStateRecentOpen],
  );

  // FR-56: one refresh path for every branch create/switch/delete from any surface; refreshes refs without resetting
  // loaded rows/scroll, plus working-dir status and the Branches list.
  // specs/self-write-refresh-suppression.md AC5: expected lets the gate-closing read diff against this operation's intended outcome.
  // specs/graph-head-indicator-and-refresh-alerting.md Problem 1 (AC2/AC3/AC6): expected.sha auto-selects via
  // graph.selectCommit (not the App wrapper) so the user's open right panel isn't switched away; CommitGraph scrolls it into view itself.
  const refreshAfterBranchOp = useCallback(
    (expected?: ExpectedRefOutcome) => {
      void graph.refreshRefs(expected);
      void graph.refreshWorkingDirStatusInBackground();
      setBranchListReloadToken((t) => t + 1);
      if (expected?.sha) graph.selectCommit(expected.sha);
    },
    [graph],
  );

  // FR-51/52/53/54/55: one shared instance so the Branches panel and ref-chip menu never drift (AC15).
  // specs/branch-panel-drag-merge.md FR-430: the ONE detached-HEAD orphan guard; guardedCheckout goes to every checkout-capable hook/dialog.
  const orphanGuard = useOrphanGuard({ api: graph.api, onHeadMoved: () => refreshAfterBranchOp() });
  // FR-430: "Create branch at <sha>" from the post-leave banner or the palette (no checkout involved).
  const [createAtHead, setCreateAtHead] = useState<{ sha: string } | null>(null);

  // FR-430: clear the post-leave banner once a refresh shows its commit is saved on a ref (any
  // branch/tag/remote now points at it) or no longer exists. Never persisted across restarts.
  const leftBehindSha = orphanGuard.leftBehind?.headSha ?? null;
  const dismissLeftBehind = orphanGuard.dismissLeftBehind;
  useEffect(() => {
    if (!leftBehindSha) return;
    if (graph.refs.some((r) => r.targetCommitSha === leftBehindSha)) {
      dismissLeftBehind();
      return;
    }
    let cancelled = false;
    void graph.api
      .getCommit(leftBehindSha)
      .then((res) => {
        if (!cancelled && !res.ok) dismissLeftBehind();
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [leftBehindSha, graph.refs, graph.api, dismissLeftBehind]);

  const branchActions = useBranchActions({
    api: graph.api,
    guardedCheckout: orphanGuard.guardedCheckout,
    onChanged: refreshAfterBranchOp,
    // specs/self-write-refresh-suppression.md FR-6b: the gate opens here; onChanged's refreshRefs closes it on success,
    // onMutationSettled on failure.
    onMutationStart: graph.beginMutation,
    onMutationSettled: graph.refreshRefs,
  });

  // specs/branch-management.md: reset branch-action errors and refetch the Branches list on repo change so a stale error/list from another repo doesn't linger.
  // specs/multi-repo-tabs.md: keyed on openSequence, not repoPath — a failed recent-open that restores the previous tab
  // (specs/repo-list.md AC6) re-opens with the same repoPath.
  useEffect(() => {
    branchActions.dismissError();
    branchActions.cancelDelete();
    branchActions.cancelForceDelete();
    setBranchListReloadToken((t) => t + 1);
    // Dialogs/banners below name the previous repo's refs, commits or files and are stale once the repo changes.
    setNewBranchRequest(null);
    // specs/branch-panel-drag-merge.md FR-430: orphan dialog, post-leave banner and create-at-HEAD dialog.
    orphanGuard.reset();
    setCreateAtHead(null);
    // specs/stash.md: stash conflict notice and Create Stash dialog.
    setShowCreateStashDialog(false);
    setStashConflictNotice(null);
    setStashListReloadToken((t) => t + 1);
    // specs/keyboard-shortcuts-reference.md: App-owned and unkeyed, and a stale true would keep global keybindings suspended.
    setShortcutsOpen(false);
    // specs/find-commits-overlay.md FR-265: redundant with the overlay's own openSequence effect. Deliberately no
    // clearFilter() here (see closeFindCommits/guardedTabAction, AC9).
    setFindCommitsOpen(false);
    // specs/git-identity-profiles.md: would show the old repo's identity status.
    setIdentityProfilesOpen(false);
    // Reset for consistency; ChangesPanel already remounts via key={graph.openSequence}.
    setChangesPanelCanCommit(false);
    // A stale true would keep global keybindings suspended. StatusBanner isn't keyed/remounted, so this is its only reset path.
    setChangesPanelDialogOpen(false);
    setStashPanelDialogOpen(false);
    setStatusBannerDialogOpen(false);
    // CommitGraph and DetailPanel are unkeyed persistent components, so a stale true would survive.
    setCommitGraphContextMenuOpen(false);
    setDetailPanelContextMenuOpen(false);
    // specs/blame.md: BlamePanel path belongs to the old repo.
    setBlameTarget(null);
    // specs/compare-commits.md: the SHAs may not exist in the new repo.
    setCompareTarget(null);
    // specs/cherry-pick.md: error banner would name the old repo's commit.
    cherryPickActions.dismissError();
    // specs/drag-commit-menu.md: same.
    dragCommitActions.dismissError();
    // specs/reset-to-here.md: the SHA-bearing dialog/escalation/undo banner is meaningless in the new repo.
    setResetTarget(null);
    resetActions.dismissError();
    resetActions.cancelHardReset();
    resetActions.dismissUndoBanner();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph.openSequence]);

  // specs/compare-commits.md FR-194: a plain row click (also jump-to-parent, jumpToSha, DetailPanel close) closes
  // CompareView and single-selects, unlike blameTarget, which swallows it.
  const selectCommit = useCallback(
    (sha: string | null) => {
      graph.selectCommit(sha);
      setRightPanel(sha ? "commit" : "none");
      setCompareTarget(null);
    },
    [graph],
  );

  // specs/blame.md FR-134, generalized: apply the sha filter only if the target isn't in the loaded page AND can't be
  // paged in (filter active, or no more history); otherwise CommitGraph's chase/follow handles selection. Shared with
  // the Branches panel's "jump to tip" (ROADMAP.md design pass).
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

  // specs/find-commits-overlay.md FR-263 (revised): discard close — hide and clear the filter. Used for Esc, the
  // re-trigger combo and the toolbar re-click; click-outside uses dismissFindCommits.
  const closeFindCommits = useCallback(() => {
    setFindCommitsOpen(false);
    graph.clearFilter();
  }, [graph]);
  // FR-263 revision: click-outside only hides; the filter survives (clicking a result is a follow-up, not a discard),
  // so findCommitsActive drives a toolbar dot and a hidden filter is never invisible.
  const dismissFindCommits = useCallback(() => {
    setFindCommitsOpen(false);
  }, []);
  // FR-259/FR-263: toolbar click opens, or (when open) discards like closeFindCommits.
  const onFindCommitsToolbarClick = useCallback(() => {
    if (findCommitsOpen) {
      closeFindCommits();
    } else {
      setFindCommitsOpen(true);
    }
  }, [findCommitsOpen, closeFindCommits]);

  // FR-267: expand and bump in the same batch so the search input is already rendered when BranchesPanel's effect reacts.
  const focusBranchesSearch = useCallback(() => {
    setSidebarCollapsed(false);
    setFocusSearchToken((t) => t + 1);
  }, [setSidebarCollapsed]);

  // specs/find-commits-overlay.md FR-265/AC9: tab clicks aren't suspended by anyModalDialogOpen, so switching tabs
  // while the overlay is open must clear the OUTGOING tab's filter. useRepoTabs.snapshotActiveTab reads graph.filter
  // synchronously and clearFilter() only schedules state, so the real switch is deferred to the render after the clear lands.
  // Keyed on isFilterActiveOf(graph.filter), not findCommitsOpen: the overlay's click-outside fires on mousedown, before
  // click, so findCommitsOpen may already be false while a filter is live. setFindCommitsOpen(false) is idempotent.
  const pendingTabActionRef = useRef<(() => void) | null>(null);
  const guardedTabAction = useCallback(
    (action: () => void) => {
      setFindCommitsOpen(false);
      if (isFilterActiveOf(graph.filter)) {
        pendingTabActionRef.current = action;
        graph.clearFilter();
        return;
      }
      action();
    },
    [graph],
  );
  useEffect(() => {
    if (isFilterActiveOf(graph.filter)) return;
    const pending = pendingTabActionRef.current;
    if (!pending) return;
    pendingTabActionRef.current = null;
    pending();
    // Fire once, right after the clear landed, with this render's tab-action closures; not on unrelated re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph.filter]);

  // specs/stash.md FR-101/FR-92: one refresh path for every successful stash mutation from any surface.
  // refreshRefs() without expected (stash never moves HEAD) also closes the self-write gate beginMutation opened (FR-92).
  const refreshAfterStashOp = useCallback(() => {
    void graph.refreshRefs();
    void graph.refreshStashList();
    void graph.refreshWorkingDirStatusInBackground();
    setStashListReloadToken((t) => t + 1);
    setChangesReloadToken((t) => t + 1);
  }, [graph]);

  // FR-92: a failed stash mutation still needs a confirming read to close the self-write gate, or later watcher events defer forever.
  const onStashMutationSettled = useCallback(() => {
    void graph.refreshRefs();
  }, [graph]);

  // specs/cherry-pick.md FR-121: one refresh path for settled cherry-pick/skip/commit-empty. Calls refreshRefsAndRows
  // directly, not refresh(), to stay decoupled from refresh()'s external-change-banner side effects (same for StatusBanner
  // Continue/Abort below).
  const cherryPickActions = useCherryPickActions({
    api: graph.api,
    // Fire-and-forget: must be refreshRefsAndRowsInBackground (CLAUDE.md Known pitfalls) since the repo can close mid-flight.
    onSettled: () => void graph.refreshRefsAndRowsInBackground(),
    // specs/self-write-refresh-suppression.md FR-6b: onSettled's refresh closes the gate on success or expected pause;
    // onMutationSettled covers failure.
    onMutationStart: graph.beginMutation,
    onMutationSettled: graph.refreshRefs,
  });

  // specs/drag-commit-menu.md FR-309/312/313/314: checkout-if-needed, Merge, Rebase. cherryPick is the SAME instance as
  // above so busy/error/pause handling never diverges from the right-click entry point.
  const dragCommitActions = useDragCommitActions({
    api: graph.api,
    guardedCheckout: orphanGuard.guardedCheckout,
    repoState: graph.repoState,
    cherryPick: cherryPickActions.cherryPick,
    onSettled: (expected) => {
      // specs/branch-panel-drag-merge.md FR-428: drag-merge/checkout moves tips and the Current badge, so the Branches list refetches too.
      setBranchListReloadToken((t) => t + 1);
      // Returned (never rejects) so the drag hook's checkout half can await the confirming read
      // before the merge/rebase opens its own gate; other settles just ignore the promise.
      const seq = graph.getOpenSequence();
      return graph.refreshRefsAndRowsInBackground(expected).then(() => graph.getOpenSequence() === seq);
    },
    onMutationStart: graph.beginMutation,
    onMutationSettled: graph.refreshRefs,
  });

  // specs/drag-commit-menu.md FR-303: IpcResult-unwrapping wrapper; called once per drop (AC16), never during the drag.
  const computeCommitPairRelationship = useCallback(
    async (aSha: string, bSha: string) => unwrap(await graph.api.computeCommitPairRelationship(aSha, bSha)),
    [graph.api],
  );

  // specs/branch-panel-drag-merge.md FR-418: the ONE branch-drag session (graph chips + Branches
  // panel cards), provided below via `BranchDragContext`; its ghost/menu render once at the app root.
  const branchDrag = useBranchDragSession({
    repoState: graph.repoState,
    computeRelationship: computeCommitPairRelationship,
    busy: dragCommitActions.busy,
    onMerge: dragCommitActions.runMerge,
  });

  // specs/reset-to-here.md FR-374: resolves a SHA's subject from the graph's own currently-loaded
  // page — never a new git read, per that FR's own "no new git read" requirement.
  const getLoadedCommitSubject = useCallback(
    (sha: string) => {
      const row = graph.displayRows.find((r) => r.kind === "commit" && r.laid.commit.sha === sha);
      return row && row.kind === "commit" ? row.laid.commit.subject : null;
    },
    [graph.displayRows],
  );

  // specs/reset-to-here.md FR-373: owns the whole Reset-to-here flow (FR-369/371 escalation, FR-374/375/376 undo banner).
  const resetActions = useResetActions({
    api: graph.api,
    repoState: graph.repoState,
    getLoadedCommitSubject,
    // FR-372: a reset can orphan commits, so it needs row-reloading refreshRefsAndRows; fire-and-forget, hence the
    // InBackground variant (CLAUDE.md pitfall).
    onSettled: () => void graph.refreshRefsAndRowsInBackground(),
    onMutationStart: graph.beginMutation,
    onMutationSettled: graph.refreshRefs,
  });

  // FR-98: a conflicting apply/pop opens ChangesPanel with the stash-specific notice (not an in-progress operation: no Continue/Abort).
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

  // specs/amend-last-commit.md FR-155: reuses the unborn-HEAD/in-progress signals from the stash gate.
  const amendDisabledReason = computeAmendDisabledReason({
    isUnbornHead: graph.repoState?.isUnbornHead ?? false,
    inProgressOperation: graph.repoState?.inProgressOperation ?? null,
  });

  // specs/stash.md AC7: acknowledging the external-change alert also bumps the StashPanel and BranchesPanel list tokens.
  // Their hooks refetch only on a token bump or mount, so without this a stash/branch changed in a terminal leaves the
  // panel disagreeing with the graph's HEAD decoration.
  const refreshEverything = useCallback(() => {
    void graph.refresh();
    setStashListReloadToken((t) => t + 1);
    setBranchListReloadToken((t) => t + 1);
  }, [graph]);

  // specs/online-sync-fetch.md FR-320-FR-328: FR-327 (explicit user action only) holds because this is the ONE place
  // runFetch is invoked — nothing calls it from open/tab-switch/timer/focus. On settling (not cancellation): refresh
  // refs/rows, bump branchListReloadToken (FR-326: ahead/behind and diverged set update immediately), record last-fetched-at.
  const fetchAction = useFetchAction({
    api: graph.api,
    onSettled: () => {
      void graph.refreshRefsAndRowsInBackground();
      setBranchListReloadToken((t) => t + 1);
      const path = graph.repoPath;
      if (path) {
        const fetchedAt = new Date();
        setLastFetchedAtByPath((m) => ({ ...m, [path]: fetchedAt }));
      }
    },
  });
  const lastFetchedAt = graph.repoPath ? (lastFetchedAtByPath[graph.repoPath] ?? null) : null;

  // specs/online-sync-fetch.md FR-326: diverged local branches for the ref-chip glyph; refetches on branchListReloadToken.
  // specs/ref-chip-synced-upstream-merge.md FR-2: syncedUpstream comes from the same call.
  const { diverged: divergedBranchNames, syncedUpstream: syncedUpstreamByBranch } = useDivergedBranches({
    api: graph.api,
    enabled: graph.status === "ready",
    reloadToken: branchListReloadToken,
  });

  // specs/online-sync-pull.md FR-338-FR-343: a pull runs its own fetch, so success refreshes and records last-fetched like
  // Fetch. A conflict pause reaches onSettled too; the refresh is what surfaces the paused merge/rebase in
  // StatusBanner/ConflictResolutionView.
  const pullAction = usePullAction({
    api: graph.api,
    onSettled: () => {
      void graph.refreshRefsAndRowsInBackground();
      setBranchListReloadToken((t) => t + 1);
      const path = graph.repoPath;
      if (path) {
        const fetchedAt = new Date();
        setLastFetchedAtByPath((m) => ({ ...m, [path]: fetchedAt }));
      }
    },
    // specs/self-write-refresh-suppression.md FR-6b: a pull can move HEAD like drag Merge/Rebase — same gate.
    onMutationStart: graph.beginMutation,
    onMutationSettled: graph.refreshRefs,
  });

  // specs/online-sync-pull.md FR-343: whether the current branch has an upstream — the one Pull gate git-core doesn't cover (see pullEligibility.ts).
  const currentBranchUpstream = useCurrentBranchUpstream({
    api: graph.api,
    enabled: graph.status === "ready",
    currentBranch: graph.repoState?.currentBranch ?? null,
    reloadToken: branchListReloadToken,
  });
  const pullDisabledReason = computePullDisabledReason(
    graph.repoState,
    currentBranchUpstream,
    pullAction.isPulling,
  );

  // specs/online-sync-push.md FR-344-FR-350: the one primitive that mutates the remote; reuses Fetch/Pull's harness (FR-348) and gates client-side (FR-349).
  const pushTarget = usePushTarget({
    api: graph.api,
    enabled: graph.status === "ready",
    currentBranch: graph.repoState?.currentBranch ?? null,
    reloadToken: branchListReloadToken,
  });
  const pushAction = usePushAction({
    api: graph.api,
    onSettled: () => {
      void graph.refreshRefsAndRowsInBackground();
      setBranchListReloadToken((t) => t + 1);
      const path = graph.repoPath;
      if (path) {
        const fetchedAt = new Date();
        setLastFetchedAtByPath((m) => ({ ...m, [path]: fetchedAt }));
      }
    },
    // specs/self-write-refresh-suppression.md FR-6b: push moves the remote-tracking ref (and --set-upstream writes
    // branch config) — same gate.
    onMutationStart: graph.beginMutation,
    onMutationSettled: graph.refreshRefs,
  });
  const pushDisabledReason = computePushDisabledReason(graph.repoState, pushTarget.remotes, pushAction.isPushing);
  // specs/identity-profile-network-interlock.md FR-383: derived from the Toolbar's existing single-instance flags; no per-tab tracking (FR-380).
  const identityNetworkOpDisabledReason = computeIdentityNetworkOpDisabledReason(
    fetchAction.isFetching,
    pullAction.isPulling,
    pushAction.isPushing,
  );
  // FR-345/FR-347: `behind` is only meaningful for a push to the branch's ACTUALLY-tracked remote
  // — pushing to a different remote isn't known to be behind anything from this data.
  const runPush = () => {
    if (!pushTarget.selectedRemote || !graph.repoState?.currentBranch) return;
    const behind = pushTarget.selectedRemote === pushTarget.trackedRemoteName ? pushTarget.behind : null;
    pushAction.requestPush(pushTarget.selectedRemote, graph.repoState.currentBranch, behind);
  };

  // Must-have #2: the checkpoint node opens Changes (never selectCommit(null), which would close the panel). Re-click
  // while open (#3) reloads: refresh shared data and bump the token so useChangesPanel re-auto-selects.
  const selectCheckpoint = useCallback(() => {
    // specs/compare-commits.md FR-194 extends here: the checkpoint row closes Compare like a commit-row click.
    setCompareTarget(null);
    if (rightPanel === "changes") {
      setChangesReloadToken((t) => t + 1);
      void graph.refreshWorkingDirStatusInBackground();
    } else {
      setRightPanel("changes");
    }
  }, [rightPanel, graph]);

  const showChangesToggle = graph.status === "ready";
  const showBranchesToggle = graph.status === "ready";
  // specs/find-commits-overlay.md FR-258: the retired FilterBar's gate — repo ready with real history.
  const showFindCommitsToggle = Boolean(
    graph.status === "ready" && graph.repoState && !graph.repoState.isEmpty && !graph.repoState.isUnbornHead,
  );
  // FR-263 revision: a filter can outlive the hidden overlay, so the toolbar needs its own signal.
  const findCommitsActive = isFilterActiveOf(graph.filter);
  const changesCount = graph.workingDirStatus
    ? graph.workingDirStatus.staged +
      graph.workingDirStatus.unstaged +
      graph.workingDirStatus.untracked +
      graph.workingDirStatus.conflicted
    : null;

  // FR-56: a bare repo has no current branch (Toolbar falls back to "Branches"); detached HEAD is labeled explicitly.
  const currentBranchLabel = !graph.repoState || graph.repoState.isBare
    ? null
    : graph.repoState.isDetachedHead
      ? "Detached HEAD"
      : graph.repoState.currentBranch;

  const hasWorkdir = Boolean(graph.repoState && !graph.repoState.isBare && graph.repoState.workdir);

  // specs/keyboard-shortcuts-command-palette.md FR-223/FR-224: snapshot rebuilt each render so keybindings and palette read the same live values as the buttons.
  // each reads from the exact same live values a click on the corresponding button would.
  const commandContext: CommandContext = {
    tabs: repoTabs.tabs,
    activeTabId: repoTabs.activeTabId,
    openNewTab: () => void repoTabs.openNewTab(),
    closeActiveTab: () => {
      const id = repoTabs.activeTabId;
      if (id) guardedTabAction(() => repoTabsRef.current.closeTab(id));
    },
    activateTab: (id) => guardedTabAction(() => void repoTabsRef.current.activateTab(id)),
    repoOpen: graph.status === "ready",
    canRefresh: graph.status === "ready",
    isRefreshing: graph.isRefreshing,
    refreshEverything,
    toggleTheme,
    showBranchesToggle,
    toggleBranchesSidebar: toggleSidebar,
    showChangesToggle,
    changesPanelOpen: rightPanel === "changes",
    toggleChangesPanel,
    showStashToggle: showChangesToggle,
    stashDisabledReason: stashToggleDisabledReason,
    toggleStashPanel,
    openNewBranchDialog: () => setNewBranchRequest({}),
    openNewStashDialog: () => setShowCreateStashDialog(true),
    canCommit: changesPanelCanCommit,
    commitStagedChanges: () => changesPanelRef.current?.requestCommit(),
    canToggleCurrentHunk: hunkCommands.toggle,
    toggleCurrentHunk: () => changesPanelRef.current?.toggleCurrentHunk(),
    canDiscardCurrentHunk: hunkCommands.discard,
    discardCurrentHunk: () => changesPanelRef.current?.discardCurrentHunk(),
    openKeyboardShortcuts: () => setShortcutsOpen(true),
    showFindCommitsToggle,
    openFindCommits: () => setFindCommitsOpen(true),
    focusBranchesSearch,
    showFetchToggle: graph.status === "ready",
    isFetching: fetchAction.isFetching,
    runFetch: fetchAction.runFetch,
    pullDisabledReason,
    runPull: pullAction.runPull,
    pushDisabledReason,
    runPush,
    openIdentityProfiles: () => setIdentityProfilesOpen(true),
    openCloneDialog: () => setCloneDialogOpen(true),
    openMergeBranchPicker: () => setMergeBranchPickerOpen(true),
    isDetachedHead: Boolean(graph.repoState?.isDetachedHead && graph.repoState.headSha),
    openCreateBranchAtHead: () => {
      const sha = graph.repoState?.headSha;
      if (sha) setCreateAtHead({ sha });
    },
  };

  // FR-221/AC10: gate suspending global keybindings while any modal is open. Panel-local ConfirmDialogs and ContextMenus
  // are lifted in via their onDialogOpenChange callbacks (see above).
  // specs/keyboard-shortcuts-reference.md FR-237, specs/find-commits-overlay.md FR-266: every new overlay must be folded
  // in here — this gap shipped twice before.
  const anyModalDialogOpen =
    showCreateStashDialog ||
    newBranchRequest !== null ||
    branchActions.pendingDelete !== null ||
    branchActions.pendingForceDelete !== null ||
    // specs/reset-to-here.md: the mode-selection dialog and its own second-tier escalation.
    resetTarget !== null ||
    resetActions.pendingHardConfirm !== null ||
    // specs/online-sync-push.md FR-347: the pre-attempt "you're behind" warning dialog.
    pushAction.pendingBehindConfirm !== null ||
    changesPanelDialogOpen ||
    stashPanelDialogOpen ||
    statusBannerDialogOpen ||
    commitGraphContextMenuOpen ||
    detailPanelContextMenuOpen ||
    shortcutsOpen ||
    findCommitsOpen ||
    identityProfilesOpen ||
    cloneDialogOpen ||
    mergeBranchPickerOpen ||
    // specs/branch-panel-drag-merge.md FR-430 / FR-221: the orphan dialog (and its name-entry step)
    // and the create-at-HEAD dialog suspend the global keybindings like every other modal.
    orphanGuard.dialogOpen ||
    createAtHead !== null;

  const { paletteOpen, closePalette } = useGlobalKeybindings({
    ctx: commandContext,
    dialogOpen: anyModalDialogOpen,
    overrides: keybindingOverrides.overrides,
  });

  const effectiveCommands = applyKeybindingOverrides(getCommands(commandContext), keybindingOverrides.overrides);
  const hintFor = (id: string): string | null => {
    const combo = effectiveCommands.find((c) => c.id === id)?.keybindings?.[0];
    return combo ? keyComboLabel(combo) : null;
  };
  const shortcutHints = {
    changes: hintFor("toggle-changes-panel"),
    stashes: hintFor("toggle-stashes-panel"),
    newStash: hintFor("new-stash"),
  };

  return (
    <BranchDragContext.Provider value={branchDrag}>
    <div className="gh-app">
      <TabBar
        tabs={repoTabs.tabs}
        activeTabId={repoTabs.activeTabId}
        onActivate={(id) => guardedTabAction(() => void repoTabsRef.current.activateTab(id))}
        onClose={(id) => guardedTabAction(() => repoTabsRef.current.closeTab(id))}
        onNewTab={() => guardedTabAction(() => void repoTabsRef.current.newTab())}
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
        lastFetchedLabel={showBranchesToggle ? formatLastFetchedLabel(lastFetchedAt) : null}
        branchesOpen={!sidebarCollapsed}
        onToggleBranches={toggleSidebar}
        showStashToggle={showChangesToggle}
        stashCount={graph.stashCount}
        stashOpen={rightPanel === "stashes"}
        onToggleStash={toggleStashPanel}
        stashDisabledReason={stashToggleDisabledReason}
        onNewStash={() => setShowCreateStashDialog(true)}
        newStashDisabledReason={createStashDisabledReason}
        shortcutHints={shortcutHints}
        showFindCommitsButton={showFindCommitsToggle}
        onFindCommits={onFindCommitsToolbarClick}
        findCommitsActive={findCommitsActive}
        showFetchButton={graph.status === "ready"}
        onFetch={fetchAction.runFetch}
        isFetching={fetchAction.isFetching}
        showPullButton={graph.status === "ready"}
        pullDisabledReason={pullDisabledReason}
        onPull={pullAction.runPull}
        isPulling={pullAction.isPulling}
        pullStrategy={pullAction.strategy}
        onPullStrategyChange={pullAction.setStrategy}
        showPushButton={graph.status === "ready"}
        pushDisabledReason={pushDisabledReason}
        onPush={runPush}
        isPushing={pushAction.isPushing}
        showPushRemotePicker={pushTarget.showRemotePicker}
        pushRemotes={pushTarget.remotes === "loading" ? [] : pushTarget.remotes}
        pushRemote={pushTarget.selectedRemote}
        onPushRemoteChange={pushTarget.setSelectedRemote}
        // toolbar-action-row redesign: same usePushTarget data as FR-347's pre-push confirmation; drives the ahead/behind pills.
        behind={pushTarget.behind}
        ahead={pushTarget.ahead}
        onOpenIdentityProfiles={() => setIdentityProfilesOpen(true)}
        onOpenKeyboardShortcuts={() => setShortcutsOpen(true)}
      />

      <FetchStatusBanner
        phase={fetchAction.phase}
        fetchSequence={fetchAction.fetchSequence}
        latestProgress={fetchAction.latestProgress}
        outcomes={fetchAction.outcomes}
        topLevelError={fetchAction.topLevelError}
        onCancel={fetchAction.cancelFetch}
        onDismiss={fetchAction.dismiss}
      />

      <PullStatusBanner
        phase={pullAction.phase}
        pullSequence={pullAction.pullSequence}
        latestProgress={pullAction.latestProgress}
        outcome={pullAction.outcome}
        error={pullAction.error}
        onCancel={pullAction.cancelPull}
        onDismiss={pullAction.dismiss}
      />

      <PushStatusBanner
        phase={pushAction.phase}
        pushSequence={pushAction.pushSequence}
        latestProgress={pushAction.latestProgress}
        outcome={pushAction.outcome}
        error={pushAction.error}
        isNonFastForwardRejection={pushAction.isNonFastForwardRejection}
        rawStderr={pushAction.rawStderr}
        onCancel={pushAction.cancelPush}
        onDismiss={pushAction.dismiss}
      />

      {graph.repoState && (
        <StatusBanner
          repoState={graph.repoState}
          hasExternalChanges={graph.hasExternalChanges}
          onRefresh={refreshEverything}
          api={graph.api}
          workingDirStatus={graph.workingDirStatus}
          // FR-68/70: abort/continue can move HEAD and clear conflicts, so reload rows/refs/status together — not refresh(),
          // whose openSequence/status side effects are unsafe mid-resolution in ConflictResolutionView (see cherryPickActions).
          // Fire-and-forget: InBackground variant since the repo can close mid-flight (CLAUDE.md pitfall).
          onOperationChanged={() => void graph.refreshRefsAndRowsInBackground()}
          // specs/self-write-refresh-suppression.md FR-6b: Continue/Abort use the self-write gate so the watcher can't misfire operationStateAlert.
          onMutationStart={graph.beginMutation}
          onMutationSettled={graph.refreshRefs}
          operationStateAlert={graph.operationStateAlert}
          isRefreshing={graph.isRefreshing}
          onDialogOpenChange={setStatusBannerDialogOpen}
          // specs/reset-to-here.md FR-374/375/376.
          resetUndoBanner={resetActions.undoBanner}
          onUndoReset={resetActions.undo}
          onDismissResetUndoBanner={resetActions.dismissUndoBanner}
        />
      )}

      {/* specs/branch-panel-drag-merge.md FR-430: session-only banner after "Leave commits behind". */}
      {orphanGuard.leftBehind && (
        <LeftBehindBanner
          info={orphanGuard.leftBehind}
          onCreateBranch={() => orphanGuard.leftBehind && setCreateAtHead({ sha: orphanGuard.leftBehind.headSha })}
          onDismiss={orphanGuard.dismissLeftBehind}
        />
      )}

      {/* specs/cherry-pick.md FR-118: FR-105 empty-result notice, derived from fresh RepositoryState (git's on-disk state is the state). */}
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

      {/* FR-120: cherry-pick failures that aren't expected pauses, surfaced verbatim. */}
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

      {/* specs/drag-commit-menu.md FR-9: drag-menu refusal, verbatim (genuine pauses are covered by onSettled's refresh + StatusBanner). */}
      {dragCommitActions.error && (
        <div className="gh-status-banner-stack">
          <div className="gh-status-banner gh-status-banner--warning" role="alert">
            <span>{dragCommitActions.error}</span>
            <button type="button" className="gh-status-banner__action" onClick={dragCommitActions.dismissError}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* specs/reset-to-here.md: reset failure, surfaced verbatim. */}
      {resetActions.error && (
        <div className="gh-status-banner-stack">
          <div className="gh-status-banner gh-status-banner--warning" role="alert">
            <span>{resetActions.error}</span>
            <button type="button" className="gh-status-banner__action" onClick={resetActions.dismissError}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* FR-51/54/55: graph-triggered branch-op failures need a home when the sidebar is hidden; the sidebar shows the
          same error when visible, so never both. */}
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

      <div className="gh-app__body" id="gh-app-main">
        {/* design-pass "Branches panel relocation": persistent left sidebar, independent of rightPanel. */}
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
            focusSearchToken={focusSearchToken}
            lastFetchedAt={lastFetchedAt}
          />
        )}
        <MainArea
          graph={graph}
          divergedBranchNames={divergedBranchNames}
          syncedUpstreamByBranch={syncedUpstreamByBranch}
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
          onComputeCommitPairRelationship={computeCommitPairRelationship}
          onDragCherryPick={dragCommitActions.runCherryPick}
          onDragMerge={dragCommitActions.runMerge}
          onDragRebase={dragCommitActions.runRebase}
          dragActionBusy={dragCommitActions.busy}
          onContextMenuOpenChange={setCommitGraphContextMenuOpen}
          onResetToHere={setResetTarget}
          resetBusy={resetActions.busy}
          recentRepos={recentRepos.recentRepos}
          recentDivergentPickedPaths={recentRepos.divergentPickedPaths}
          recentNotFoundPath={emptyStateRecentOpen.notFoundPath}
          recentBusyPath={emptyStateRecentOpen.busyPath}
          onOpenRecent={emptyStateRecentOpen.openRecent}
          onRemoveRecent={removeEmptyStateRecent}
          onBrowse={() => void repoTabs.openNewTab()}
          onClone={() => setCloneDialogOpen(true)}
          browseDisabled={repoTabs.switching}
          notFoundTab={notFoundTab}
          onRetryTab={(id) => void repoTabs.activateTab(id)}
          onRemoveTab={repoTabs.closeTab}
          activeTabId={repoTabs.activeTabId}
        />
        {/* specs/compare-commits.md FR-189: pre-empts all rightPanel states and blameTarget; closing reveals whatever was set underneath, unchanged. */}
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
            onDialogOpenChange={setDetailPanelContextMenuOpen}
          />
        )}
        {!compareTarget && !blameTarget && rightPanel === "changes" && graph.status === "ready" && (
          <ChangesPanel
            // specs/multi-repo-tabs.md: remount on every repo open so the previous repo's selection/diff/composer state can't
            // linger; openSequence, not repoPath (see its doc comment), and the ready-status toggle can be coalesced away.
            key={graph.openSequence}
            ref={changesPanelRef}
            api={graph.api}
            changes={graph.workingDirChanges}
            onClose={() => setRightPanel("none")}
            onWorkingDirChanged={() => void graph.refreshWorkingDirStatusInBackground()}
            onCommitCreated={() => void graph.refresh()}
            reloadToken={changesReloadToken}
            blockConflictActions={graph.operationStateAlert !== null}
            // specs/self-write-refresh-suppression.md FR-6b: gate around Accept Ours/Theirs/Mark resolved (see useConflictResolution).
            onMutationStart={graph.beginMutation}
            onMutationSettled={graph.refreshRefs}
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
            onCommitAvailabilityChange={setChangesPanelCanCommit}
            onHunkCommandsChange={setHunkCommands}
            onDialogOpenChange={setChangesPanelDialogOpen}
          />
        )}
        {!compareTarget && !blameTarget && rightPanel === "stashes" && graph.status === "ready" && (
          <StashPanel
            // specs/multi-repo-tabs.md: remount on repo open — useStashList only fetches on mount.
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
            onDialogOpenChange={setStashPanelDialogOpen}
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
          guardedCheckout={orphanGuard.guardedCheckout}
        />
      )}

      {/* FR-430: "Create branch at <sha>" (banner / palette): saves the commit, never switches. */}
      {createAtHead && graph.repoState && (
        <NewBranchDialog
          api={graph.api}
          refs={graph.refs}
          hasWorkdir={hasWorkdir}
          isEmptyRepo={false}
          isUnbornHead={false}
          createAtCommit={createAtHead}
          onClose={() => setCreateAtHead(null)}
          onCreated={() => {
            refreshAfterBranchOp();
            orphanGuard.dismissLeftBehind();
          }}
          guardedCheckout={orphanGuard.guardedCheckout}
        />
      )}

      {/* FR-430: the pre-checkout orphan dialog, and (after "Create branch here...") its name-entry
          step, which commits via createBranchAtCommit and then lets the guard re-query. */}
      {orphanGuard.pending?.phase === "confirm" && (
        <OrphanedCommitsDialog
          result={orphanGuard.pending.request.result}
          description={orphanGuard.pending.request.context.description}
          headMoved={orphanGuard.pending.request.headMoved}
          onCreateBranch={orphanGuard.chooseCreate}
          onLeave={orphanGuard.chooseLeave}
          onCancel={orphanGuard.chooseCancel}
        />
      )}
      {orphanGuard.pending?.phase === "naming" && orphanGuard.pending.request.result.headSha && graph.repoState && (
        <NewBranchDialog
          api={graph.api}
          refs={graph.refs}
          hasWorkdir={hasWorkdir}
          isEmptyRepo={false}
          isUnbornHead={false}
          createAtCommit={{ sha: orphanGuard.pending.request.result.headSha }}
          onClose={orphanGuard.namingCancelled}
          onCreated={() => {
            refreshAfterBranchOp();
            orphanGuard.namingCreated();
          }}
          guardedCheckout={orphanGuard.guardedCheckout}
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

      {/* specs/reset-to-here.md FR-367: branch label recomputed from live repoState; "HEAD" never "HEAD (detached)" (see CommitGraph.tsx). */}
      {resetTarget && graph.repoState && (
        <ResetBranchDialog
          api={graph.api}
          target={resetTarget}
          branchLabel={graph.repoState.currentBranch ?? "HEAD"}
          headSha={graph.repoState.headSha}
          workingDirStatus={graph.workingDirStatus}
          busy={resetActions.busy}
          onClose={() => setResetTarget(null)}
          onConfirm={(mode) => {
            // FR-371: closes immediately on confirm; useResetActions.requestReset owns what follows, including the second-tier escalation.
            const branchLabel = graph.repoState?.currentBranch ?? "HEAD";
            setResetTarget(null);
            resetActions.requestReset(resetTarget.sha, mode, branchLabel);
          }}
        />
      )}

      {/* specs/reset-to-here.md FR-369/371: second-tier escalation, only for Hard on a dirty working tree. */}
      {resetActions.pendingHardConfirm && (
        <ConfirmDialog
          title="Discard uncommitted changes?"
          message={`${describeResetHardDangerCounts(
            resetActions.pendingHardConfirm.staged,
            resetActions.pendingHardConfirm.unstaged,
            resetActions.pendingHardConfirm.conflicted,
          )} Untracked files are not affected. This cannot be undone from GitHydra.`}
          confirmLabel="Discard changes and reset"
          destructive
          onConfirm={resetActions.confirmHardReset}
          onCancel={resetActions.cancelHardReset}
        />
      )}

      {/* specs/online-sync-push.md FR-347: pre-attempt "behind" warning; non-destructive, so no destructive styling. */}
      {pushAction.pendingBehindConfirm && (
        <ConfirmDialog
          title="Your branch is behind"
          message={`"${pushAction.pendingBehindConfirm.localBranchName}" is ${pushAction.pendingBehindConfirm.behind} commit${
            pushAction.pendingBehindConfirm.behind === 1 ? "" : "s"
          } behind ${pushAction.pendingBehindConfirm.remoteName}/${pushAction.pendingBehindConfirm.localBranchName}. Pushing now will likely be rejected — pull first to bring in those commits, or push anyway if you're sure.`}
          confirmLabel="Push anyway"
          onConfirm={pushAction.confirmPendingPush}
          onCancel={pushAction.cancelPendingPush}
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

      {/* specs/keyboard-shortcuts-command-palette.md FR-222/AC10: anyModalDialogOpen already prevents opening over another modal (FR-221). */}
      {paletteOpen && (
        <CommandPalette ctx={commandContext} onClose={closePalette} overrides={keybindingOverrides.overrides} />
      )}

      {/* specs/keyboard-shortcuts-reference.md FR-231/232/237: same convention as CommandPalette. */}
      {shortcutsOpen && (
        <KeyboardShortcutsScreen
          ctx={commandContext}
          onClose={() => setShortcutsOpen(false)}
          overrides={keybindingOverrides.overrides}
          onSetOverride={keybindingOverrides.setOverride}
          onResetOverride={keybindingOverrides.resetOverride}
          onResetAll={keybindingOverrides.resetAll}
        />
      )}

      {/* specs/find-commits-overlay.md FR-257/259: conditionally mounted so no vertical space is reserved while closed; folded into anyModalDialogOpen (FR-266). */}
      {findCommitsOpen && graph.status === "ready" && (
        <FindCommitsOverlay
          openSequence={graph.openSequence}
          filter={graph.filter}
          onApply={graph.applyFilter}
          onClear={graph.clearFilter}
          showAllRefs={graph.showAllRefs}
          onShowAllRefsChange={graph.setShowAllRefs}
          // design-pass fix #5 / FR-264: loaded history commits only (excludes the uncommitted pseudo-row).
          loadedCommitCount={graph.displayRows.filter((r) => r.kind === "commit").length}
          hasMoreCommits={graph.hasMore}
          onClose={closeFindCommits}
          onDismiss={dismissFindCommits}
        />
      )}

      {/* specs/git-identity-profiles.md: same convention as above; renders without a repo (FR-329 library) — repoPath null
          makes "This repository" show an open-a-repository message. */}
      {identityProfilesOpen && (
        <IdentityProfilesDialog
          api={graph.api}
          repoPath={graph.status === "ready" ? graph.repoPath : null}
          profiles={identityProfiles}
          applications={identityApplications}
          networkOpDisabledReason={identityNetworkOpDisabledReason}
          onClose={() => setIdentityProfilesOpen(false)}
          onMutationStart={graph.beginMutation}
          onMutationSettled={graph.refreshRefs}
        />
      )}

      {/* specs/online-sync-clone.md FR-351/354/356/357: renders without a repo. onCloned (FR-356) reuses
          openRecentInNewTab, the app's one open-tab flow, so recents update with no parallel path. */}
      {cloneDialogOpen && (
        <CloneDialog
          api={graph.api}
          onClose={() => setCloneDialogOpen(false)}
          onCloned={(path) => {
            setCloneDialogOpen(false);
            void repoTabs.openRecentInNewTab(path);
          }}
        />
      )}
      {branchDrag.overlay}
      {mergeBranchPickerOpen && (
        <MergeBranchPicker
          api={graph.api}
          repoState={graph.repoState}
          busy={dragCommitActions.busy}
          onMerge={dragCommitActions.runMerge}
          onClose={() => setMergeBranchPickerOpen(false)}
        />
      )}
    </div>
    </BranchDragContext.Provider>
  );
}

/**
 * specs/repo-open-feedback.md FR-166: opening spinner with elapsed readout; openSequence resets the clock when a re-open
 * supersedes an in-flight attempt. The ticking readout sits outside the aria-live region so it doesn't announce every
 * second; its aria-label keeps it reachable.
 * FR-167/168/170: Cancel is always present (never gated on elapsed time) and calls the single onCancel (graph.cancelOpen).
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
  onComputeCommitPairRelationship,
  onDragCherryPick,
  onDragMerge,
  onDragRebase,
  dragActionBusy,
  onContextMenuOpenChange,
  onResetToHere,
  resetBusy,
  recentRepos,
  recentDivergentPickedPaths,
  recentNotFoundPath,
  recentBusyPath,
  onOpenRecent,
  onRemoveRecent,
  onBrowse,
  onClone,
  browseDisabled,
  notFoundTab,
  onRetryTab,
  onRemoveTab,
  activeTabId,
  divergedBranchNames,
  syncedUpstreamByBranch,
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
  /** specs/drag-commit-menu.md — forwarded to CommitGraph's props of the same names. */
  onComputeCommitPairRelationship: (aSha: string, bSha: string) => Promise<CommitPairRelationship>;
  onDragCherryPick: (aSha: string, bSha: string) => void;
  onDragMerge: (aSha: string, bSha: string, targetBranch?: string) => void;
  onDragRebase: (aSha: string, bSha: string) => void;
  dragActionBusy: boolean;
  /** Forwarded to CommitGraph. */
  onContextMenuOpenChange: (open: boolean) => void;
  /** specs/reset-to-here.md — forwarded to CommitGraph. */
  onResetToHere: (target: { sha: string; abbrevSha: string; subject: string }) => void;
  resetBusy: boolean;
  /** specs/repo-list.md Must-have 2: wired only to the "No repository open" empty state. */
  recentRepos: string[];
  /** specs/repo-open-feedback-fixes.md FR-204: see `EmptyState`'s own prop doc comment. */
  recentDivergentPickedPaths: Record<string, string>;
  recentNotFoundPath: string | null;
  recentBusyPath: string | null;
  onOpenRecent: (path: string) => void;
  onRemoveRecent: (path: string) => void;
  onBrowse: () => void;
  /** specs/online-sync-clone.md FR-351: opens CloneDialog (forwarded to EmptyState). */
  onClone: () => void;
  browseDisabled: boolean;
  /** specs/restore-tabs-on-relaunch.md FR-212/AC5: active tab whose repoPath no longer resolves; null otherwise. */
  notFoundTab: RepoTab | null;
  onRetryTab: (id: string) => void;
  onRemoveTab: (id: string) => void;
  /** Keys scrollPositionsRef; null when nothing is open (specs/graph-head-indicator-and-refresh-alerting.md Addendum 3). */
  activeTabId: string | null;
  /** specs/online-sync-fetch.md FR-326: forwarded to CommitGraph. */
  divergedBranchNames: ReadonlySet<string>;
  /** specs/ref-chip-synced-upstream-merge.md FR-2: forwarded to CommitGraph. */
  syncedUpstreamByBranch: ReadonlyMap<string, string>;
}) {
  // Survives CommitGraph's unmount/remount when a reactivated tab falls back to a full openRepo() (specs/instant-tab-revisit.md
  // FR-240/AC8); per-tab so new tabs start at the top. Unused on the cached fast path, where CommitGraph never unmounts.
  const scrollPositionsRef = useRef<Map<string, number>>(new Map());

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
        onClone={onClone}
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
      divergedBranchNames={divergedBranchNames}
      syncedUpstreamByBranch={syncedUpstreamByBranch}
      selectedSha={graph.selectedSha}
      followSignal={graph.followSignal}
      initialScrollTop={activeTabId ? scrollPositionsRef.current.get(activeTabId) : undefined}
      onScrollPositionChange={(top) => {
        if (activeTabId) scrollPositionsRef.current.set(activeTabId, top);
      }}
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
      onComputeCommitPairRelationship={onComputeCommitPairRelationship}
      onDragCherryPick={onDragCherryPick}
      onDragMerge={onDragMerge}
      onDragRebase={onDragRebase}
      dragActionBusy={dragActionBusy}
      onContextMenuOpenChange={onContextMenuOpenChange}
      onResetToHere={onResetToHere}
      resetBusy={resetBusy}
    />
  );
}
