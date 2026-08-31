import { useCallback, useEffect, useState } from "react";
import { BranchesPanel } from "./components/BranchesPanel/BranchesPanel";
import { ChangesPanel } from "./components/ChangesPanel/ChangesPanel";
import { CommitGraph } from "./components/CommitGraph/CommitGraph";
import { ConfirmDialog } from "./components/ConfirmDialog/ConfirmDialog";
import { DetailPanel } from "./components/DetailPanel/DetailPanel";
import { EmptyState } from "./components/EmptyState/EmptyState";
import { FilterBar } from "./components/FilterBar/FilterBar";
import { NewBranchDialog } from "./components/NewBranchDialog/NewBranchDialog";
import { StatusBanner } from "./components/StatusBanner/StatusBanner";
import { TabBar } from "./components/TabBar/TabBar";
import { Toolbar } from "./components/Toolbar/Toolbar";
import { useBranchActions } from "./hooks/useBranchActions";
import { getPersistedRightPanel, persistRightPanel } from "./hooks/useLayoutPreferences";
import { useRepositoryGraph } from "./hooks/useRepositoryGraph";
import { useRepoTabs, type RightPanel } from "./hooks/useRepoTabs";
import type { ExpectedRefOutcome } from "./hooks/selfWriteGate";
import { useTheme } from "./hooks/useTheme";
import "./App.css";

/** FR-49/FR-54: state for the (single, App-owned) New Branch dialog — non-null means open.
 * `defaultStartPoint` is set when opened from the graph's "Create branch here" action. */
interface NewBranchRequest {
  defaultStartPoint?: { value: string; label: string };
}

export function App() {
  const graph = useRepositoryGraph();
  const [theme, toggleTheme] = useTheme();
  // Must-have C16/C18: seeded from the persisted "last open panel" preference (defaulting to
  // "none" if nothing was ever persisted) rather than always "none" — but "commit" is never part
  // of that persisted value (see setRightPanel below), so a relaunch never reopens the DetailPanel
  // on its own (selecting a commit is not a "layout" preference, per the spec's Non-goals).
  const [rightPanel, setRightPanelState] = useState<RightPanel>(() => getPersistedRightPanel());
  // Must-have C16/C17: persists every transition into "none"/"changes"/"branches" (never
  // "commit", which is derived from commit selection, not an independent toggle) — global across
  // repos/tabs, the same scope `useTheme.ts`'s theme preference already has.
  const setRightPanel = useCallback((value: RightPanel) => {
    setRightPanelState(value);
    if (value !== "commit") persistRightPanel(value);
  }, []);
  // Must-have #2/#3 (specs/detailpanel-auto-diff.md): bumped when the checkpoint pseudo-node is
  // clicked while the Changes panel is already open, so useChangesPanel can force a fresh reload
  // + re-auto-select without ChangesPanel itself unmounting/remounting.
  const [changesReloadToken, setChangesReloadToken] = useState(0);
  // FR-56: bumped after any branch mutation so the Branches panel's own list hook (which fetches
  // independently of the graph) refetches, even when the mutation was triggered from *outside*
  // the panel (the graph's ref-chip/commit context menus).
  const [branchListReloadToken, setBranchListReloadToken] = useState(0);
  const [newBranchRequest, setNewBranchRequest] = useState<NewBranchRequest | null>(null);

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
  });

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
  // `closeRepo` call), not `graph.repoPath` — two tabs can share the exact same path (Must-have
  // 9/AC10, duplicate paths allowed), where a plain `repoPath` comparison would wrongly see "no
  // change" and skip this reset when switching between them.
  useEffect(() => {
    branchActions.dismissError();
    branchActions.cancelDelete();
    branchActions.cancelForceDelete();
    setBranchListReloadToken((t) => t + 1);
    // A New Branch dialog references the previously-open repo's refs — stale/misleading once the
    // open repository actually changes (new tab, tab switch, or the active tab's repo being
    // replaced), same reasoning as the branch-action reset above.
    setNewBranchRequest(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph.openSequence]);

  const selectCommit = useCallback(
    (sha: string | null) => {
      graph.selectCommit(sha);
      setRightPanel(sha ? "commit" : "none");
    },
    [graph],
  );

  const toggleChangesPanel = useCallback(() => {
    setRightPanel(rightPanel === "changes" ? "none" : "changes");
  }, [rightPanel, setRightPanel]);

  const toggleBranchesPanel = useCallback(() => {
    setRightPanel(rightPanel === "branches" ? "none" : "branches");
  }, [rightPanel, setRightPanel]);

  // Must-have #2: clicking the uncommitted-changes "checkpoint" pseudo-node opens the Changes
  // panel (if not already showing) — never `selectCommit(null)`, which would just close whatever
  // panel is open. Re-clicking it while the Changes panel is already open forces a fresh
  // reload + re-auto-select (Must-have #3) instead of doing nothing.
  const selectCheckpoint = useCallback(() => {
    if (rightPanel === "changes") {
      setChangesReloadToken((t) => t + 1);
    } else {
      setRightPanel("changes");
    }
  }, [rightPanel]);

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
        onNewTab={() => void repoTabs.openNewTab()}
        switching={repoTabs.switching}
      />
      <Toolbar
        repoPath={graph.repoPath}
        onOpenRepo={() => void repoTabs.openRepoInActiveTab()}
        onRefresh={() => void graph.refresh()}
        canRefresh={graph.status === "ready"}
        theme={theme}
        onToggleTheme={toggleTheme}
        showChangesToggle={showChangesToggle}
        changesCount={changesCount}
        changesOpen={rightPanel === "changes"}
        onToggleChanges={toggleChangesPanel}
        showBranchesToggle={showBranchesToggle}
        currentBranchLabel={currentBranchLabel}
        branchesOpen={rightPanel === "branches"}
        onToggleBranches={toggleBranchesPanel}
      />

      {graph.repoState && (
        <StatusBanner
          repoState={graph.repoState}
          hasExternalChanges={graph.hasExternalChanges}
          onRefresh={() => void graph.refresh()}
          api={graph.api}
          workingDirStatus={graph.workingDirStatus}
          // FR-68/70: abort/continue can move HEAD and clear the conflict set entirely — a full
          // refresh (same path onCommitCreated/manual-refresh already use) picks up the new
          // commit rows, refs, and working-directory status in one go rather than patching each
          // piece individually.
          onOperationChanged={() => void graph.refresh()}
          operationStateAlert={graph.operationStateAlert}
        />
      )}

      {/* FR-51/54/55: a branch-op failure triggered from the graph (ref-chip menu, commit menu)
          while the Branches panel isn't open has nowhere else to surface — the panel itself shows
          the same `branchActions.error` when it *is* open, so this never double-renders it. */}
      {branchActions.error && rightPanel !== "branches" && (
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
        />
      )}

      <div className="gh-app__body" id="gh-app-main">
        <MainArea
          graph={graph}
          onSelectCommit={selectCommit}
          onSelectCheckpoint={selectCheckpoint}
          onCheckoutCommit={(sha) => void branchActions.checkoutCommit(sha)}
          onCreateBranchAt={(sha, label) => setNewBranchRequest({ defaultStartPoint: { value: sha, label } })}
          onSwitchBranch={(name) => void branchActions.switchTo(name)}
          onDeleteBranch={(name) => branchActions.requestDelete(name)}
        />
        {rightPanel === "commit" && graph.status === "ready" && (
          <DetailPanel
            detail={graph.commitDetail}
            isRepoDetachedHead={graph.repoState?.isDetachedHead ?? false}
            api={graph.api}
            onJumpToParent={(sha) => selectCommit(sha)}
            onClose={() => selectCommit(null)}
          />
        )}
        {rightPanel === "changes" && graph.status === "ready" && (
          <ChangesPanel
            // specs/multi-repo-tabs.md: `useChangesPanel` only fetches on mount (no dependency on
            // `repoPath`), so without a key forcing a real remount on every repo open, switching
            // to a different tab while the Changes panel is open can leave the *previous* repo's
            // file list on screen — see `openSequence`'s doc comment for why `repoPath` alone
            // isn't a safe key (two tabs can share a path, AC10) and why this can't be fixed by
            // relying on the `graph.status === "ready"` condition here ever actually toggling
            // false in between (React can coalesce that transition away entirely).
            key={graph.openSequence}
            api={graph.api}
            onClose={() => setRightPanel("none")}
            onWorkingDirChanged={() => void graph.refreshWorkingDirStatus()}
            onCommitCreated={() => void graph.refresh()}
            reloadToken={changesReloadToken}
            blockConflictActions={graph.operationStateAlert !== null}
          />
        )}
        {rightPanel === "branches" && graph.status === "ready" && (
          <BranchesPanel
            api={graph.api}
            repoState={graph.repoState}
            actions={branchActions}
            reloadToken={branchListReloadToken}
            onClose={() => setRightPanel("none")}
            onRequestNewBranch={() => setNewBranchRequest({})}
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

function MainArea({
  graph,
  onSelectCommit,
  onSelectCheckpoint,
  onCheckoutCommit,
  onCreateBranchAt,
  onSwitchBranch,
  onDeleteBranch,
}: {
  graph: ReturnType<typeof useRepositoryGraph>;
  onSelectCommit: (sha: string | null) => void;
  onSelectCheckpoint: () => void;
  onCheckoutCommit: (sha: string) => void;
  onCreateBranchAt: (sha: string, label: string) => void;
  onSwitchBranch: (branchName: string) => void;
  onDeleteBranch: (branchName: string) => void;
}) {
  if (graph.status === "idle") {
    return (
      <EmptyState
        title="No repository open"
        description="Choose a local git repository — including bare repos, shallow clones, and worktrees — to see its commit graph."
      />
    );
  }

  if (graph.status === "opening") {
    return (
      <div className="gh-loading" role="status" aria-live="polite" aria-busy="true">
        <div className="gh-loading__bar" />
        <span>Opening repository…</span>
      </div>
    );
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
    />
  );
}
