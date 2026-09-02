import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import type { CommitInfo, RepositoryState } from "@githydra/git-core";
import type { GraphDisplayRow } from "../../hooks/useRepositoryGraph";
import { computeCherryPickDisabledReason } from "../../lib/cherryPickEligibility";
import { sortShasInGraphOrder } from "../../lib/cherryPickOrder";
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
  /** specs/cherry-pick.md FR-113/FR-114: start a cherry-pick for the given SHAs, already sorted
   * into graph order (oldest-first) by this component per FR-114 — the caller issues them
   * verbatim. */
  onCherryPick: (shas: string[]) => void;
  /** FR-115: true while a cherry-pick/skip/commit-empty call is already in flight — folded into
   * the context menu's disabled-with-reason state alongside repo/selection eligibility. */
  cherryPickBusy: boolean;
}

const OVERSCAN = 10;

/**
 * specs/graph-head-indicator-and-refresh-alerting.md Addendum 2/Problem 1b: how many bounded
 * `onLoadMore` calls the auto-follow effect will trigger, chasing a target row that wasn't in the
 * already-loaded page, before giving up and falling back to the inline affordance. Deliberately
 * capped (non-goal: no unbounded auto-load-until-found loop that could force-fetch an entire
 * large history in one action, per commit-graph.md FR-12's pagination-perf goal) — at
 * `PAGE_SIZE` (150, see useRepositoryGraph.ts) commits per page, 4 covers the addendum's own
 * 300-commit/~150-loaded repro scenario in a single extra page.
 */
const AUTO_FOLLOW_LOAD_CAP = 4;

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
  onCherryPick,
  cherryPickBusy,
}: CommitGraphProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; sha: string } | null>(null);
  const [refChipMenu, setRefChipMenu] = useState<{ x: number; y: number; branchName: string } | null>(null);
  // specs/cherry-pick.md FR-111: the ctrl/shift-click multi-selection, entirely independent of
  // `selectedSha`/`onSelectCommit` (which continues to drive DetailPanel unchanged, per this
  // spec's explicit "must not change existing plain-click behavior" constraint). Row index (not
  // just sha) is tracked as the shift-range anchor since range math is naturally index-based.
  const [multiSelected, setMultiSelected] = useState<Set<string>>(new Set());
  const multiSelectAnchorRef = useRef<number | null>(null);

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

  /** Shared by keyboard nav and the auto-follow effect below — only moves `scrollTop` when
   * `nextIndex`'s row isn't already fully visible, aligning to whichever edge it's off of. */
  const scrollIndexIntoView = useCallback((nextIndex: number) => {
    const el = containerRef.current;
    if (!el) return;
    const rowTop = nextIndex * ROW_HEIGHT;
    const rowBottom = rowTop + ROW_HEIGHT;
    if (rowTop < el.scrollTop) el.scrollTop = rowTop;
    else if (rowBottom > el.scrollTop + el.clientHeight) el.scrollTop = rowBottom - el.clientHeight;
  }, []);

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
      scrollIndexIntoView(nextIndex);
    },
    [activeIndex, scrollIndexIntoView, selectableIndexes],
  );

  // specs/graph-head-indicator-and-refresh-alerting.md Problem 1 (AC2/AC3/AC6): whenever
  // `selectedSha` actually changes value — whether from a row click (already visible, so this is
  // a no-op) or an app-initiated HEAD move that calls `selectCommit(newHeadSha)` from *outside*
  // this component (checkout/branch-switch, possibly scrolled far out of view) — scroll that row
  // into view and sync keyboard `activeIndex` to it. Guarded on a ref (not just a `[selectedSha]`
  // dependency) so this never re-scans `displayRows` (can be 100k+ rows, FR-12) on every
  // unrelated `displayRows` change (e.g. `loadMore` while the selection is unchanged) — only on a
  // real selection change.
  //
  // Addendum 2/Problem 1b: when the target row isn't in the currently-loaded page (large/
  // paginated repo, e.g. switching to a branch tip deep in history), this no longer silently
  // no-ops — it hands off to `followTarget`/the chase effect below, which drives bounded
  // auto-`loadMore` calls plus an inline affordance so the user gets visible feedback instead of
  // silence.
  const lastFollowedShaRef = useRef<string | null>(null);
  const [followTarget, setFollowTarget] = useState<{ sha: string; attempts: number } | null>(null);
  useEffect(() => {
    if (selectedSha === lastFollowedShaRef.current) return;
    lastFollowedShaRef.current = selectedSha;
    if (!selectedSha) {
      setFollowTarget(null);
      return;
    }
    const index = displayRows.findIndex((r) => r.kind === "commit" && r.laid.commit.sha === selectedSha);
    if (index === -1) {
      setFollowTarget({ sha: selectedSha, attempts: 0 });
      return;
    }
    setFollowTarget(null);
    setActiveIndex(index);
    scrollIndexIntoView(index);
  }, [selectedSha, displayRows, scrollIndexIntoView]);

  // Addendum 2/Problem 1b: chases `followTarget` with bounded `onLoadMore` calls as more pages
  // land (each `displayRows` change re-checks), up to `AUTO_FOLLOW_LOAD_CAP` — beyond the cap (or
  // once there's genuinely no more history to load) it stops and leaves the inline affordance
  // below for the user to continue with one click, rather than looping forever (FR-12).
  useEffect(() => {
    if (!followTarget) return;
    const index = displayRows.findIndex((r) => r.kind === "commit" && r.laid.commit.sha === followTarget.sha);
    if (index !== -1) {
      setFollowTarget(null);
      setActiveIndex(index);
      scrollIndexIntoView(index);
      return;
    }
    if (isLoadingMore) return; // a page is already in flight — wait for it to land.
    if (!hasMore || followTarget.attempts >= AUTO_FOLLOW_LOAD_CAP) return; // stalled; affordance takes over.
    onLoadMore();
    setFollowTarget((prev) => (prev ? { sha: prev.sha, attempts: prev.attempts + 1 } : prev));
  }, [followTarget, displayRows, hasMore, isLoadingMore, onLoadMore, scrollIndexIntoView]);

  // True once the bounded auto-chase above has given up (cap hit, or nothing left to load) and
  // isn't currently waiting on an in-flight page — drives the inline affordance's "stalled" copy
  // (a button to keep loading) vs. its transient "still looking" copy.
  const followStalled =
    followTarget != null && !isLoadingMore && (!hasMore || followTarget.attempts >= AUTO_FOLLOW_LOAD_CAP);

  const handleLoadFollowTarget = useCallback(() => {
    if (!followTarget) return;
    onLoadMore();
    setFollowTarget((prev) => (prev ? { sha: prev.sha, attempts: prev.attempts + 1 } : prev));
  }, [followTarget, onLoadMore]);

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

  // specs/cherry-pick.md FR-111: a plain click's existing behavior (single-select, opens
  // DetailPanel, clears any multi-selection — AC17) is preserved verbatim below; ctrl/cmd-click
  // toggles this row into/out of `multiSelected` without ever calling `onSelectCommit`, and
  // shift-click selects the contiguous range between the last-clicked row (the anchor, which only
  // a plain/ctrl click ever moves) and this one, in current graph order.
  const handleRowClick = useCallback(
    (index: number, sha: string, event: ReactMouseEvent<HTMLDivElement>) => {
      setActiveIndex(index);
      if (event.shiftKey) {
        const anchor = multiSelectAnchorRef.current ?? index;
        const [start, end] = anchor <= index ? [anchor, index] : [index, anchor];
        const rangeShas = new Set<string>();
        for (let i = start; i <= end; i++) {
          const row = displayRows[i];
          if (row?.kind === "commit") rangeShas.add(row.laid.commit.sha);
        }
        setMultiSelected(rangeShas);
        return;
      }
      if (event.ctrlKey || event.metaKey) {
        multiSelectAnchorRef.current = index;
        setMultiSelected((prev) => {
          const next = new Set(prev);
          if (next.has(sha)) next.delete(sha);
          else next.add(sha);
          return next;
        });
        return;
      }
      multiSelectAnchorRef.current = index;
      setMultiSelected(new Set());
      onSelectCommit(sha);
    },
    [displayRows, onSelectCommit],
  );

  // FR-112: right-click on a row outside the current 2+ multi-selection collapses selection down
  // to just that row first (standard list-widget convention); right-click on a row that IS part of
  // an existing 2+ multi-selection leaves it intact so the menu can offer the "N commits" action.
  const handleRowContextMenu = useCallback((event: ReactMouseEvent, sha: string, index: number) => {
    setActiveIndex(index);
    setMultiSelected((prev) => (prev.has(sha) && prev.size >= 2 ? prev : new Set()));
    setContextMenu({ x: event.clientX, y: event.clientY, sha });
  }, []);

  const commitBySha = useMemo(() => {
    const map = new Map<string, CommitInfo>();
    for (const row of displayRows) if (row.kind === "commit") map.set(row.laid.commit.sha, row.laid.commit);
    return map;
  }, [displayRows]);

  // FR-112/FR-114: the effective cherry-pick target set for whichever row the context menu is
  // currently open on — the full (graph-order-sorted, FR-114) multi-selection when the menu was
  // opened on a row that's part of a genuine 2+ selection, otherwise just that single row.
  const cherryPickTargets = useMemo(() => {
    const sha = contextMenu?.sha;
    if (!sha) return [] as string[];
    if (multiSelected.has(sha) && multiSelected.size >= 2) {
      return sortShasInGraphOrder([...multiSelected], displayRows);
    }
    return [sha];
  }, [contextMenu, multiSelected, displayRows]);

  // FR-115: checked client-side so the menu item's disabled state and `cherryPick()`'s own
  // server-side pre-flight refusal never disagree (AC3).
  const cherryPickDisabledReason = useMemo(() => {
    const commits = cherryPickTargets
      .map((sha) => commitBySha.get(sha))
      .filter((c): c is CommitInfo => Boolean(c));
    return computeCherryPickDisabledReason(repoState, commits, cherryPickBusy);
  }, [cherryPickTargets, commitBySha, repoState, cherryPickBusy]);

  // FR-54: "Checkout"/"Create branch here" are wired to real git semantics; FR-113 wires up
  // Cherry-pick (this spec) — revert/reset remain stubs for their own not-yet-built specs.
  const contextMenuItems: ContextMenuItem[] = useMemo(() => {
    const sha = contextMenu?.sha;
    const commit = sha ? displayRows.find((r) => r.kind === "commit" && r.laid.commit.sha === sha) : undefined;
    const abbrev = commit && commit.kind === "commit" ? commit.laid.commit.abbrevSha : sha?.slice(0, 7);
    // FR-112: "Cherry-pick N commits" once 2+ are targeted, otherwise the ordinary singular label.
    const cherryPickLabel =
      cherryPickTargets.length >= 2 ? `Cherry-pick ${cherryPickTargets.length} commits` : "Cherry-pick";
    const cherryPickEnabled = cherryPickTargets.length > 0 && cherryPickDisabledReason === null;
    return [
      { label: "Checkout commit", onSelect: sha ? () => onCheckoutCommit(sha) : undefined, disabled: !sha },
      {
        label: "Create branch here…",
        onSelect: sha ? () => onCreateBranchAt(sha, `Commit ${abbrev}`) : undefined,
        disabled: !sha,
      },
      {
        label: cherryPickLabel,
        onSelect: cherryPickEnabled ? () => onCherryPick(cherryPickTargets) : undefined,
        disabled: !cherryPickEnabled,
        title: cherryPickDisabledReason ?? undefined,
      },
      { label: "Revert", disabled: true },
      { label: "Reset current branch to here…", disabled: true },
    ];
  }, [
    contextMenu,
    displayRows,
    onCheckoutCommit,
    onCreateBranchAt,
    cherryPickTargets,
    cherryPickDisabledReason,
    onCherryPick,
  ]);

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
      {followTarget && (
        // Addendum 2/Problem 1b, AC1/AC2: visible acknowledgment that HEAD moved to a row outside
        // the currently-loaded page, instead of a silent no-op — resolves itself (and unmounts)
        // the moment the chase effect above finds and scrolls to the row, so this is only ever
        // seen while genuinely still looking or genuinely stalled, never left behind stale.
        <div className="gh-commit-graph__follow-banner" role="status" aria-live="polite">
          {followStalled ? (
            <>
              <span>Jumped to a commit outside the loaded range.</span>
              {hasMore ? (
                <button type="button" className="gh-commit-graph__follow-banner-action" onClick={handleLoadFollowTarget}>
                  Click to load it
                </button>
              ) : (
                <span>It isn&rsquo;t in the currently loaded history.</span>
              )}
            </>
          ) : (
            <span>Jumped to a commit outside the loaded range — loading…</span>
          )}
        </div>
      )}
      <div
        ref={containerRef}
        className="gh-commit-graph__scroll"
        onScroll={handleScroll}
        role="listbox"
        aria-label="Commit graph"
        aria-multiselectable="true"
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
                isCurrent={sha != null && sha === (repoState?.headSha ?? null)}
                isMultiSelected={sha != null && multiSelected.has(sha)}
                isActive={index === activeIndex}
                style={{ position: "absolute", top: index * ROW_HEIGHT, left: 0, right: 0 }}
                onSelect={(s, e) => handleRowClick(index, s, e)}
                onSelectCheckpoint={() => {
                  setActiveIndex(index);
                  onSelectCheckpoint();
                }}
                onContextMenu={(e, s) => {
                  e.preventDefault();
                  handleRowContextMenu(e, s, index);
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
