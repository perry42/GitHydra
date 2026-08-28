import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { RepositoryState } from "@githydra/git-core";
import type { GraphDisplayRow } from "../../hooks/useRepositoryGraph";
import { computeVisibleRange, isNearEnd } from "../../lib/virtualization";
import { ContextMenu, type ContextMenuItem } from "../ContextMenu/ContextMenu";
import { CommitRow } from "./CommitRow";
import { GraphCanvas } from "./GraphCanvas";
import { ROW_HEIGHT, graphWidth as computeGraphWidth } from "./graphGeometry";
import "./CommitGraph.css";

export interface CommitGraphProps {
  displayRows: GraphDisplayRow[];
  maxLaneIndexSeen: number;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
  visibleRefNames: ReadonlySet<string>;
  repoState: RepositoryState | null;
  selectedSha: string | null;
  onSelectCommit: (sha: string | null) => void;
  /** Must-have #2 (specs/detailpanel-auto-diff.md): activating the uncommitted-changes
   * "checkpoint" pseudo-row opens the Changes panel and auto-selects its first diffable file. */
  onSelectCheckpoint: () => void;
  theme: "light" | "dark";
  /** FR-39/FR-54: the commit context menu's "Checkout commit" action (detached HEAD). */
  onCheckoutCommit: (sha: string) => void;
  /** FR-54: the commit context menu's "Create branch here…" action — opens the New Branch dialog
   * pre-filled with this commit as the start point. */
  onCreateBranchAt: (sha: string, label: string) => void;
  /** FR-55: a local-branch ref chip's right-click menu — Checkout routes to the same `switchTo`
   * the Branches panel uses (AC15). */
  onSwitchBranch: (branchName: string) => void;
  /** FR-55: a local-branch ref chip's right-click menu — Delete opens the same confirm/escalate
   * flow the Branches panel uses (AC15). */
  onDeleteBranch: (branchName: string) => void;
}

const OVERSCAN = 10;

export function CommitGraph({
  displayRows,
  maxLaneIndexSeen,
  hasMore,
  isLoadingMore,
  onLoadMore,
  visibleRefNames,
  repoState,
  selectedSha,
  onSelectCommit,
  onSelectCheckpoint,
  theme,
  onCheckoutCommit,
  onCreateBranchAt,
  onSwitchBranch,
  onDeleteBranch,
}: CommitGraphProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; sha: string } | null>(null);
  const [refChipMenu, setRefChipMenu] = useState<{ x: number; y: number; branchName: string } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setContainerHeight(entry.contentRect.height);
    });
    observer.observe(el);
    setContainerHeight(el.clientHeight);
    return () => observer.disconnect();
  }, []);

  const width = computeGraphWidth(maxLaneIndexSeen);
  const { startIndex, endIndex } = computeVisibleRange(
    scrollTop,
    containerHeight,
    ROW_HEIGHT,
    displayRows.length,
    OVERSCAN,
  );

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    if (hasMore && !isLoadingMore && isNearEnd(el.scrollTop, el.clientHeight, ROW_HEIGHT, displayRows.length)) {
      onLoadMore();
    }
  }, [displayRows.length, hasMore, isLoadingMore, onLoadMore]);

  // Both real commits and the uncommitted-changes checkpoint pseudo-row are keyboard-navigable
  // and activatable (Enter/Space) — the checkpoint row opens the Changes panel rather than
  // commit details, but it's still a legitimate option, not a dead stop in arrow-key navigation.
  const selectableIndexes = useMemo(
    () => displayRows.map((r, i) => (r.kind === "commit" || r.kind === "uncommitted" ? i : -1)).filter((i) => i >= 0),
    [displayRows],
  );

  const moveActive = useCallback(
    (direction: 1 | -1) => {
      if (selectableIndexes.length === 0) return;
      const currentPos = selectableIndexes.indexOf(activeIndex);
      const nextPos =
        currentPos === -1
          ? 0
          : Math.min(Math.max(currentPos + direction, 0), selectableIndexes.length - 1);
      const nextIndex = selectableIndexes[nextPos]!;
      setActiveIndex(nextIndex);
      const el = containerRef.current;
      if (el) {
        const rowTop = nextIndex * ROW_HEIGHT;
        const rowBottom = rowTop + ROW_HEIGHT;
        if (rowTop < el.scrollTop) el.scrollTop = rowTop;
        else if (rowBottom > el.scrollTop + el.clientHeight) el.scrollTop = rowBottom - el.clientHeight;
      }
    },
    [activeIndex, selectableIndexes],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        moveActive(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        moveActive(-1);
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        const row = displayRows[activeIndex];
        if (row?.kind === "commit") onSelectCommit(row.laid.commit.sha);
        else if (row?.kind === "uncommitted") onSelectCheckpoint();
      } else if (e.key === "Home") {
        e.preventDefault();
        if (selectableIndexes.length > 0) setActiveIndex(selectableIndexes[0]!);
      }
    },
    [activeIndex, displayRows, moveActive, onSelectCheckpoint, onSelectCommit, selectableIndexes],
  );

  const rowId = (i: number) => `gh-commit-row-${i}`;

  // FR-54: "Checkout"/"Create branch here" are now wired to real git semantics; cherry-pick/
  // revert/reset remain stubs for their own not-yet-built specs.
  const contextMenuItems: ContextMenuItem[] = useMemo(() => {
    const sha = contextMenu?.sha;
    const commit = sha ? displayRows.find((r) => r.kind === "commit" && r.laid.commit.sha === sha) : undefined;
    const abbrev = commit && commit.kind === "commit" ? commit.laid.commit.abbrevSha : sha?.slice(0, 7);
    return [
      { label: "Checkout commit", onSelect: sha ? () => onCheckoutCommit(sha) : undefined, disabled: !sha },
      {
        label: "Create branch here…",
        onSelect: sha ? () => onCreateBranchAt(sha, `Commit ${abbrev}`) : undefined,
        disabled: !sha,
      },
      { label: "Cherry-pick", disabled: true },
      { label: "Revert", disabled: true },
      { label: "Reset current branch to here…", disabled: true },
    ];
  }, [contextMenu, displayRows, onCheckoutCommit, onCreateBranchAt]);

  const refChipMenuItems: ContextMenuItem[] = useMemo(() => {
    const branchName = refChipMenu?.branchName;
    return [
      { label: "Checkout", onSelect: branchName ? () => onSwitchBranch(branchName) : undefined, disabled: !branchName },
      { label: "Delete…", onSelect: branchName ? () => onDeleteBranch(branchName) : undefined, disabled: !branchName },
    ];
  }, [refChipMenu, onSwitchBranch, onDeleteBranch]);

  if (displayRows.length === 0) return null;

  return (
    <div className="gh-commit-graph">
      <div
        ref={containerRef}
        className="gh-commit-graph__scroll"
        onScroll={handleScroll}
        role="listbox"
        aria-label="Commit graph"
        aria-activedescendant={rowId(activeIndex)}
        tabIndex={0}
        onKeyDown={handleKeyDown}
      >
        <div className="gh-commit-graph__spacer" style={{ height: displayRows.length * ROW_HEIGHT }}>
          <GraphCanvas
            rows={displayRows}
            startIndex={startIndex}
            endIndex={endIndex}
            width={width}
            theme={theme}
            headSha={repoState?.headSha ?? null}
            selectedSha={selectedSha}
          />
          {displayRows.slice(startIndex, endIndex).map((row, i) => {
            const index = startIndex + i;
            const sha = row.kind === "commit" ? row.laid.commit.sha : null;
            return (
              <CommitRow
                key={sha ?? "uncommitted"}
                id={rowId(index)}
                row={row}
                graphWidth={width}
                visibleRefNames={visibleRefNames}
                repoState={repoState}
                isSelected={sha != null && sha === selectedSha}
                isActive={index === activeIndex}
                style={{ position: "absolute", top: index * ROW_HEIGHT, left: 0, right: 0 }}
                onSelect={(s) => {
                  setActiveIndex(index);
                  onSelectCommit(s);
                }}
                onSelectCheckpoint={() => {
                  setActiveIndex(index);
                  onSelectCheckpoint();
                }}
                onContextMenu={(e, s) => {
                  e.preventDefault();
                  setActiveIndex(index);
                  setContextMenu({ x: e.clientX, y: e.clientY, sha: s });
                }}
                onRefChipContextMenu={(e, branchName) => {
                  setActiveIndex(index);
                  setRefChipMenu({ x: e.clientX, y: e.clientY, branchName });
                }}
              />
            );
          })}
        </div>
      </div>
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          sha={contextMenu.sha}
          items={contextMenuItems}
          onClose={() => setContextMenu(null)}
        />
      )}
      {refChipMenu && (
        <ContextMenu
          x={refChipMenu.x}
          y={refChipMenu.y}
          sha={refChipMenu.branchName}
          ariaLabel={`Actions for branch ${refChipMenu.branchName}`}
          items={refChipMenuItems}
          onClose={() => setRefChipMenu(null)}
        />
      )}
    </div>
  );
}
