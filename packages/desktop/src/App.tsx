import { useCallback, useState } from "react";
import { ChangesPanel } from "./components/ChangesPanel/ChangesPanel";
import { CommitGraph } from "./components/CommitGraph/CommitGraph";
import { DetailPanel } from "./components/DetailPanel/DetailPanel";
import { EmptyState } from "./components/EmptyState/EmptyState";
import { FilterBar } from "./components/FilterBar/FilterBar";
import { StatusBanner } from "./components/StatusBanner/StatusBanner";
import { Toolbar } from "./components/Toolbar/Toolbar";
import { useRepositoryGraph } from "./hooks/useRepositoryGraph";
import { useTheme } from "./hooks/useTheme";
import "./App.css";

/** Which right-hand rail is showing — mutually exclusive with the commit DetailPanel, the same
 * way selecting a commit and opening the Changes panel are mutually exclusive user intents. */
type RightPanel = "none" | "commit" | "changes";

export function App() {
  const graph = useRepositoryGraph();
  const [theme, toggleTheme] = useTheme();
  const [rightPanel, setRightPanel] = useState<RightPanel>("none");
  // Must-have #2/#3 (specs/detailpanel-auto-diff.md): bumped when the checkpoint pseudo-node is
  // clicked while the Changes panel is already open, so useChangesPanel can force a fresh reload
  // + re-auto-select without ChangesPanel itself unmounting/remounting.
  const [changesReloadToken, setChangesReloadToken] = useState(0);

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
  const changesCount = graph.workingDirStatus
    ? graph.workingDirStatus.staged +
      graph.workingDirStatus.unstaged +
      graph.workingDirStatus.untracked +
      graph.workingDirStatus.conflicted
    : null;

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
      />

      {graph.repoState && (
        <StatusBanner
          repoState={graph.repoState}
          hasExternalChanges={graph.hasExternalChanges}
          onRefresh={() => void graph.refresh()}
        />
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
        <MainArea graph={graph} onSelectCommit={selectCommit} onSelectCheckpoint={selectCheckpoint} />
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
      </div>
    </div>
  );
}

function MainArea({
  graph,
  onSelectCommit,
  onSelectCheckpoint,
}: {
  graph: ReturnType<typeof useRepositoryGraph>;
  onSelectCommit: (sha: string | null) => void;
  onSelectCheckpoint: () => void;
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
    />
  );
}
