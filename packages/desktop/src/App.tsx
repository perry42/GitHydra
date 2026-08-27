import { CommitGraph } from "./components/CommitGraph/CommitGraph";
import { DetailPanel } from "./components/DetailPanel/DetailPanel";
import { EmptyState } from "./components/EmptyState/EmptyState";
import { FilterBar } from "./components/FilterBar/FilterBar";
import { StatusBanner } from "./components/StatusBanner/StatusBanner";
import { Toolbar } from "./components/Toolbar/Toolbar";
import { useRepositoryGraph } from "./hooks/useRepositoryGraph";
import { useTheme } from "./hooks/useTheme";
import "./App.css";

export function App() {
  const graph = useRepositoryGraph();
  const [theme, toggleTheme] = useTheme();

  return (
    <div className="gh-app">
      <Toolbar
        repoPath={graph.repoPath}
        onOpenRepo={() => void graph.openRepoViaDialog()}
        onRefresh={() => void graph.refresh()}
        canRefresh={graph.status === "ready"}
        theme={theme}
        onToggleTheme={toggleTheme}
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
        <MainArea graph={graph} />
        {graph.status === "ready" && (
          <DetailPanel
            detail={graph.commitDetail}
            isRepoDetachedHead={graph.repoState?.isDetachedHead ?? false}
            onJumpToParent={(sha) => graph.selectCommit(sha)}
            onClose={() => graph.selectCommit(null)}
          />
        )}
      </div>
    </div>
  );
}

function MainArea({ graph }: { graph: ReturnType<typeof useRepositoryGraph> }) {
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
      onSelectCommit={graph.selectCommit}
      theme={document.documentElement.dataset.theme === "light" ? "light" : "dark"}
    />
  );
}
