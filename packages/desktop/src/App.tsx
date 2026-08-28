import { useCallback, useEffect, useRef, useState } from "react";
import { BranchesPanel } from "./components/BranchesPanel/BranchesPanel";
import { ChangesPanel } from "./components/ChangesPanel/ChangesPanel";
import { CommitGraph } from "./components/CommitGraph/CommitGraph";
import { ConfirmDialog } from "./components/ConfirmDialog/ConfirmDialog";
import { DetailPanel } from "./components/DetailPanel/DetailPanel";
import { EmptyState } from "./components/EmptyState/EmptyState";
import { FilterBar } from "./components/FilterBar/FilterBar";
import { NewBranchDialog } from "./components/NewBranchDialog/NewBranchDialog";
import { StatusBanner } from "./components/StatusBanner/StatusBanner";
import { Toolbar } from "./components/Toolbar/Toolbar";
import { useBranchActions } from "./hooks/useBranchActions";
import { useRepositoryGraph } from "./hooks/useRepositoryGraph";
import { useTheme } from "./hooks/useTheme";
import "./App.css";

/** Which right-hand rail is showing — mutually exclusive with the commit DetailPanel, the same
 * way selecting a commit and opening the Changes/Branches panel are mutually exclusive user
 * intents. */
type RightPanel = "none" | "commit" | "changes" | "branches";

/** FR-49/FR-54: state for the (single, App-owned) New Branch dialog — non-null means open.
 * `defaultStartPoint` is set when opened from the graph's "Create branch here" action. */
interface NewBranchRequest {
  defaultStartPoint?: { value: string; label: string };
}

export function App() {
  const graph = useRepositoryGraph();
  const [theme, toggleTheme] = useTheme();
  const [rightPanel, setRightPanel] = useState<RightPanel>("none");
  // Must-have #2/#3 (specs/detailpanel-auto-diff.md): bumped when the checkpoint pseudo-node is
  // clicked while the Changes panel is already open, so useChangesPanel can force a fresh reload
  // + re-auto-select without ChangesPanel itself unmounting/remounting.
  const [changesReloadToken, setChangesReloadToken] = useState(0);
  // FR-56: bumped after any branch mutation so the Branches panel's own list hook (which fetches
  // independently of the graph) refetches, even when the mutation was triggered from *outside*
  // the panel (the graph's ref-chip/commit context menus).
  const [branchListReloadToken, setBranchListReloadToken] = useState(0);
  const [newBranchRequest, setNewBranchRequest] = useState<NewBranchRequest | null>(null);

  // FR-56: one refresh path for every successful branch create/switch/delete, regardless of which
  // surface triggered it (Branches panel row, ref-chip menu, or the graph's commit menu) —
  // refreshes the current-branch indicator/ref chips/HEAD decoration everywhere they appear
  // without resetting the already-loaded commit rows/scroll position (see `refreshRefs`'s doc
  // comment), plus the working-dir status (a switch can change it) and the Branches panel list.
  const refreshAfterBranchOp = useCallback(() => {
    void graph.refreshRefs();
    void graph.refreshWorkingDirStatus();
    setBranchListReloadToken((t) => t + 1);
  }, [graph]);

  // FR-51/52/53/54/55: a single shared instance so the Branches panel and the graph's ref-chip
  // context menu can never drift apart (AC15) — both call the exact same functions below.
  const branchActions = useBranchActions({ api: graph.api, onChanged: refreshAfterBranchOp });

  // Bug found via manual acceptance testing (specs/branch-management.md): `branchActions` and the
  // Branches panel's own list both live independently of which repo is currently open, so without
  // this, opening a *different* repository while a stale error banner is showing (e.g. "branch X
  // is checked out elsewhere") left that now-irrelevant error/other-repo's branch list on screen
  // -- confusing at best, actively misleading at worst, since the file paths/branch names named in
  // a leftover error banner belong to a repo that's no longer even open. Reset the branch-actions
  // error/confirmation state and force the (if open) Branches panel to refetch every time the open
  // repository actually changes.
  const previousRepoPathRef = useRef(graph.repoPath);
  useEffect(() => {
    if (graph.repoPath === previousRepoPathRef.current) return;
    previousRepoPathRef.current = graph.repoPath;
    branchActions.dismissError();
    branchActions.cancelDelete();
    branchActions.cancelForceDelete();
    setBranchListReloadToken((t) => t + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph.repoPath]);

  const selectCommit = useCallback(
    (sha: string | null) => {
      graph.selectCommit(sha);
      setRightPanel(sha ? "commit" : "none");
    },
    [graph],
  );

  const toggleChangesPanel = useCallback(() => {
    setRightPanel((current) => (current === "changes" ? "none" : "changes"));
  }, []);

  const toggleBranchesPanel = useCallback(() => {
    setRightPanel((current) => (current === "branches" ? "none" : "branches"));
  }, []);

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
      <Toolbar
        repoPath={graph.repoPath}
        onOpenRepo={() => void graph.openRepoViaDialog()}
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
          filter={graph.filter}
          onApply={graph.applyFilter}
          onClear={graph.clearFilter}
          showAllRefs={graph.showAllRefs}
          onShowAllRefsChange={graph.setShowAllRefs}
        />
      )}

      <div className="gh-app__body">
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
            api={graph.api}
            onClose={() => setRightPanel("none")}
            onWorkingDirChanged={() => void graph.refreshWorkingDirStatus()}
            onCommitCreated={() => void graph.refresh()}
            reloadToken={changesReloadToken}
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
