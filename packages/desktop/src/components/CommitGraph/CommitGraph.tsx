// SPDX-License-Identifier: GPL-3.0-or-later
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { CommitInfo, CommitPairRelationship, RepositoryState } from "@githydra/git-core";
import type { GraphDisplayRow } from "../../hooks/useRepositoryGraph";
import { computeCherryPickDisabledReason } from "../../lib/cherryPickEligibility";
import { sortShasInGraphOrder } from "../../lib/cherryPickOrder";
import { computeMergeOrRebaseDisabledReason, resolveDragCommitLabel } from "../../lib/dragCommitMenu";
import { laneColorVar } from "../../lib/laneAssignment";
import { computeResetDisabledReason } from "../../lib/resetEligibility";
import { computeVisibleRange, isNearEnd } from "../../lib/virtualization";
import { ContextMenu, type ContextMenuItem } from "../ContextMenu/ContextMenu";
import { RefChip, refChipAccessibleLabel } from "../RefChip/RefChip";
import { useBranchDrag, useBranchDragSession } from "../../hooks/useBranchDragSession";
import type { RefChipSpec } from "../../lib/refChips";
import { CommitRow } from "./CommitRow";
import { GraphCanvas } from "./GraphCanvas";
import { ROW_HEIGHT, graphWidth as computeGraphWidth } from "./graphGeometry";
import "./CommitGraph.css";

/** specs/drag-commit-menu.md FR-301: movement past this distinguishes a drag from a click's incidental jitter. */
const DRAG_THRESHOLD_PX = 6;

/** specs/drag-commit-menu.md FR-322: ghost offset from the cursor so it doesn't obscure the row hit-testing needs to see. */
const DRAG_GHOST_OFFSET_PX = 16;

export interface CommitGraphProps {
  displayRows: GraphDisplayRow[];
  maxLaneIndexSeen: number;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
  visibleRefNames: ReadonlySet<string>;
  repoState: RepositoryState | null;
  /** specs/online-sync-fetch.md FR-326: local branches diverged (ahead>0 AND behind>0) from upstream.
   * Omitted = none diverged. */
  divergedBranchNames?: ReadonlySet<string>;
  /** specs/ref-chip-synced-upstream-merge.md FR-2/FR-3: local branch -> upstream short name, for
   * branches exactly synced with a live upstream, so a local+remote chip pair can merge.
   * Omitted = none synced. */
  syncedUpstreamByBranch?: ReadonlyMap<string, string>;
  selectedSha: string | null;
  /**
   * specs/graph-head-indicator-and-refresh-alerting.md Addendum 3: monotonic counter that changes
   * only on an app-initiated HEAD move or explicit user navigation (`selectCommit()`), never on a
   * tab-reactivation replay of a remembered selection. The auto-follow effect keys off this, not
   * `selectedSha`, so a replay updates the highlight without scrolling the graph.
   */
  followSignal: number;
  /**
   * specs/graph-head-indicator-and-refresh-alerting.md Addendum 3: scroll offset this tab last
   * showed (`undefined`/`0` = never scrolled). `CommitGraph` can be remounted by a full reopen on
   * tab reactivation, so `App.tsx`'s `MainArea` remembers it per tab and replays it here. Applied to
   * the real DOM `scrollTop` (never the virtualization `scrollTop` state) at mount and re-applied
   * as more rows land, in case the browser clamped the first attempt; never touched once settled.
   */
  initialScrollTop?: number;
  /** Fired on every scroll so the parent's remembered offset (see `initialScrollTop`) stays current. */
  onScrollPositionChange?: (scrollTop: number) => void;
  onSelectCommit: (sha: string | null) => void;
  /** specs/detailpanel-auto-diff.md: activating the uncommitted-changes pseudo-row opens the
   * Changes panel and auto-selects its first diffable file. */
  onSelectCheckpoint: () => void;
  theme: "light" | "dark";
  /** FR-39/FR-54: context menu "Checkout commit" (detached HEAD). */
  onCheckoutCommit: (sha: string) => void;
  /** FR-54: context menu "Create branch here…" — opens the New Branch dialog with this commit as start point. */
  onCreateBranchAt: (sha: string, label: string) => void;
  /** FR-55: ref chip menu Checkout — same `switchTo` the Branches panel uses (AC15). */
  onSwitchBranch: (branchName: string) => void;
  /** FR-55: ref chip menu Delete — same confirm/escalate flow as the Branches panel (AC15). */
  onDeleteBranch: (branchName: string) => void;
  /** specs/cherry-pick.md FR-113/FR-114: SHAs arrive already sorted oldest-first in graph order;
   * the caller issues them verbatim. */
  onCherryPick: (shas: string[]) => void;
  /** FR-115: true while a cherry-pick/skip/commit-empty call is in flight; disables the menu item. */
  cherryPickBusy: boolean;
  /** specs/compare-commits.md FR-186/FR-187: called with `[baseSha, targetSha]` sorted older-first
   * via `sortShasInGraphOrder`, regardless of click order. */
  onCompare: (baseSha: string, targetSha: string) => void;
  /**
   * specs/compare-commits.md FR-196: the two commits `CompareView` is showing, kept highlighted
   * while the panel is open — layered on top of `multiSelected` so a right-click collapse (FR-112)
   * never drops it. `null`/`undefined` when Compare is closed.
   */
  compareTarget?: { baseSha: string; targetSha: string } | null;
  /**
   * specs/drag-commit-menu.md FR-303: ancestry relationship for a dropped pair — called once, at
   * drop time (never during the drag, AC16). A rejection becomes the menu's `"error"` state, never
   * an uncaught rejection.
   */
  onComputeCommitPairRelationship?: (aSha: string, bSha: string) => Promise<CommitPairRelationship>;
  /** FR-311: checkout-if-needed (FR-309), then single-commit cherry-pick of `aSha` (`A` dragged, `B` dropped-on). */
  onDragCherryPick?: (aSha: string, bSha: string) => void;
  /** FR-312: checkout-if-needed (FR-309), then `mergeCommit(aSha)`. */
  onDragMerge?: (aSha: string, bSha: string, targetBranch?: string) => void;
  /** FR-313: checkout-if-needed (FR-309), then `rebaseCommitOnto(aSha)`. */
  onDragRebase?: (aSha: string, bSha: string) => void;
  /** specs/drag-commit-menu.md FR-308: true while a drag-menu-started checkout/merge/rebase is in
   * flight; disables Merge/Rebase (Cherry-pick uses `cherryPickBusy`). */
  dragActionBusy?: boolean;
  /** specs/reset-to-here.md FR-367: context menu "Reset {branch} to here…" — opens the mode dialog.
   * `App.tsx` owns the dialog and the mutating flow; this only supplies the target's identity. */
  onResetToHere: (target: { sha: string; abbrevSha: string; subject: string }) => void;
  /** FR-366: true while a reset is in flight; disables the item like `cherryPickBusy`. */
  resetBusy?: boolean;
  /**
   * keyboard-shortcuts-command-palette.md FR-221: reports whether any locally-owned `ContextMenu`
   * is open, so `App.tsx` can fold it into `anyModalDialogOpen` and Ctrl+K doesn't stack the
   * palette over an open right-click menu. Optional.
   */
  onContextMenuOpenChange?: (open: boolean) => void;
}

const OVERSCAN = 10;

/**
 * specs/graph-head-indicator-and-refresh-alerting.md Addendum 2/Problem 1b: cap on auto-follow
 * `onLoadMore` calls chasing a target row outside the loaded page, before falling back to the
 * inline affordance — no unbounded load-until-found loop (commit-graph.md FR-12).
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
  divergedBranchNames,
  syncedUpstreamByBranch,
  selectedSha,
  followSignal,
  initialScrollTop,
  onScrollPositionChange,
  onSelectCommit,
  onSelectCheckpoint,
  theme,
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
  dragActionBusy = false,
  onContextMenuOpenChange,
  onResetToHere,
  resetBusy = false,
}: CommitGraphProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Deliberately NOT seeded from `initialScrollTop`: a deep offset before enough rows are loaded
  // would push `startIndex` past `displayRows.length` and blank the virtualized window. This catches
  // up via `handleScroll` after the DOM `scrollTop` is set (see the restore effects below).
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; sha: string } | null>(null);
  const [refChipMenu, setRefChipMenu] = useState<{ x: number; y: number; branchName: string } | null>(null);
  // specs/ref-chip-gutter-legibility.md FR-410/411: the "+N" collapse affix's menu; `chips` are the collapsed chips in order.
  const [refCollapseMenu, setRefCollapseMenu] = useState<{
    x: number;
    y: number;
    chips: RefChipSpec[];
    /** The row's commit — popover chip rows are chip-drag drop targets carrying this sha. */
    sha: string | null;
  } | null>(null);
  const closeRefCollapseMenu = useCallback(() => setRefCollapseMenu(null), []);
  // specs/drag-commit-menu.md FR-301/302: null until the pointer passes `DRAG_THRESHOLD_PX`, so a
  // plain click never touches it. `pointerX/Y` (FR-322/325) position the ghost, whose lifecycle is this state's.
  const [dragState, setDragState] = useState<{
    sourceSha: string;
    hoverSha: string | null;
    pointerX: number;
    pointerY: number;
  } | null>(null);
  // FR-303: opened on release over a DISTINCT commit (FR-302). Relationship is "computing" until the ancestry read resolves.
  const [dropMenu, setDropMenu] = useState<{
    x: number;
    y: number;
    aSha: string;
    bSha: string;
  } | null>(null);
  const [dropMenuRelationship, setDropMenuRelationship] = useState<CommitPairRelationship | "computing" | "error">(
    "computing",
  );
  // specs/branch-panel-drag-merge.md FR-418: `App` shares one session via context so Branches-panel
  // cards can drag onto these chips; standalone, a private instance is used.
  const sharedSession = useBranchDrag();
  const localSession = useBranchDragSession({
    repoState,
    computeRelationship: onComputeCommitPairRelationship,
    busy: dragActionBusy,
    onMerge: onDragMerge,
  });
  const session = sharedSession ?? localSession;

  // FR-419: a "+N" popover the drag auto-opened never outlives the drag.
  const wasChipDraggingRef = useRef(false);
  useEffect(() => {
    const dragging = session.drag !== null;
    if (wasChipDraggingRef.current && !dragging) setRefCollapseMenu(null);
    wasChipDraggingRef.current = dragging;
  }, [session.drag]);

  // specs/cherry-pick.md FR-111: ctrl/shift multi-selection, independent of `selectedSha` (plain-click
  // behavior must not change). The shift-range anchor is a row index since range math is index-based.
  const [multiSelected, setMultiSelected] = useState<Set<string>>(new Set());
  const multiSelectAnchorRef = useRef<number | null>(null);

  // FR-221: every ContextMenu this component owns (incl. drop menu and "+N" popover) counts as open.
  useEffect(() => {
    onContextMenuOpenChange?.(
      contextMenu !== null ||
        refChipMenu !== null ||
        dropMenu !== null ||
        refCollapseMenu !== null ||
        session.menuOpen,
    );
  }, [contextMenu, refChipMenu, dropMenu, refCollapseMenu, session.menuOpen, onContextMenuOpenChange]);

  // specs/drag-commit-menu.md FR-303: one ancestry read per drop (AC16). Keyed on the two shas, not
  // `repoState`, so a repo change while the menu is open doesn't respawn it; `cancelled` drops a
  // superseded menu's late response.
  useEffect(() => {
    if (!dropMenu || !onComputeCommitPairRelationship) return;
    // Same commit on both sides: trivially up to date, no git read.
    if (dropMenu.aSha === dropMenu.bSha) {
      setDropMenuRelationship("a-ancestor-of-b");
      return;
    }
    let cancelled = false;
    setDropMenuRelationship("computing");
    void (async () => {
      try {
        const result = await onComputeCommitPairRelationship(dropMenu.aSha, dropMenu.bSha);
        if (!cancelled) setDropMenuRelationship(result);
      } catch {
        if (!cancelled) setDropMenuRelationship("error");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dropMenu?.aSha, dropMenu?.bSha, onComputeCommitPairRelationship]);

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

  // Addendum 3: `initialScrollTop` goes to the DOM `scrollTop`, never `setScrollTop` (see above). The
  // browser clamps it to the current `scrollHeight`, so it lands short at mount; the resulting scroll
  // event drives `handleScroll`'s near-end pagination, and each row growth re-applies it until honored.
  const pendingScrollRestoreRef = useRef<number | null>(
    initialScrollTop && initialScrollTop > 0 ? initialScrollTop : null,
  );
  useLayoutEffect(() => {
    const el = containerRef.current;
    const target = pendingScrollRestoreRef.current;
    if (el && target) el.scrollTop = target;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const target = pendingScrollRestoreRef.current;
    if (target === null) return;
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = target;
    // Stop once reached or nothing is left to load; more rows are requested via `handleScroll`, not here.
    if (el.scrollTop >= target || !hasMore) pendingScrollRestoreRef.current = null;
  }, [displayRows.length, hasMore]);

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
    onScrollPositionChange?.(el.scrollTop);
    if (hasMore && !isLoadingMore && isNearEnd(el.scrollTop, el.clientHeight, ROW_HEIGHT, displayRows.length)) {
      onLoadMore();
    }
  }, [displayRows.length, hasMore, isLoadingMore, onLoadMore, onScrollPositionChange]);

  // The checkpoint pseudo-row is keyboard-navigable too, so arrow keys don't dead-stop on it.
  const selectableIndexes = useMemo(
    () => displayRows.map((r, i) => (r.kind === "commit" || r.kind === "uncommitted" ? i : -1)).filter((i) => i >= 0),
    [displayRows],
  );

  /** Scrolls only if the row isn't fully visible, aligning to the nearest edge. */
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

  // specs/graph-head-indicator-and-refresh-alerting.md Problem 1 (AC2/AC3/AC6): scroll the row into
  // view and sync `activeIndex` when `followSignal` changes. The ref guard avoids re-scanning
  // `displayRows` (100k+, FR-12) on unrelated changes like `loadMore`.
  // Addendum 3: gated on `followSignal`, not `selectedSha`, so a restored selection never auto-scrolls.
  // Addendum 2/1b: a row outside the loaded page hands off to `followTarget`/the chase effect below.
  const lastFollowedGenerationRef = useRef<number>(followSignal);
  const [followTarget, setFollowTarget] = useState<{ sha: string; attempts: number } | null>(null);
  useEffect(() => {
    if (followSignal === lastFollowedGenerationRef.current) return;
    lastFollowedGenerationRef.current = followSignal;
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
  }, [followSignal, selectedSha, displayRows, scrollIndexIntoView]);

  // Addendum 2/1b: chase `followTarget` with up to `AUTO_FOLLOW_LOAD_CAP` `onLoadMore` calls, then
  // leave the inline affordance below rather than looping forever (FR-12).
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

  // True once the auto-chase gave up and no page is in flight; selects the banner's "stalled" copy.
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

  // specs/cherry-pick.md FR-111: plain click single-selects and clears multi-selection (AC17);
  // ctrl/cmd toggles without `onSelectCommit`; shift selects the range from the anchor (moved only
  // by plain/ctrl click).
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

  // FR-112: right-click outside a 2+ multi-selection collapses it to that row; inside keeps it for the "N commits" action.
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

  // FR-322: the drag ghost reuses each commit's lane color token (`laneColorVar`), never a new color.
  const colorSlotBySha = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of displayRows) if (row.kind === "commit") map.set(row.laid.commit.sha, row.laid.colorSlot);
    return map;
  }, [displayRows]);

  /**
   * specs/drag-commit-menu.md FR-301/302/303: hit-tests the row under the pointer, since pointer
   * capture redirects move/up events to the drag's source row. Guarded because jsdom lacks
   * `elementFromPoint`.
   */
  const resolveHoverSha = useCallback((clientX: number, clientY: number): string | null => {
    if (typeof document.elementFromPoint !== "function") return null;
    const el = document.elementFromPoint(clientX, clientY);
    const hoverEl = el instanceof Element ? el.closest<HTMLElement>("[data-commit-sha]") : null;
    return hoverEl?.dataset.commitSha ?? null;
  }, []);

  // FR-301: like `useResizableWidth`, listens on `window` so it works where `setPointerCapture` is
  // unimplemented. Below `DRAG_THRESHOLD_PX` it never sets drag state, leaving the native click
  // and `handleRowClick` unaffected (FR-319). Chip drags use `useBranchDragSession` (FR-418).
  const handleRowDragPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, sha: string) => {
      if (event.button !== 0) return; // Only the primary button starts a drag (matches ResizeHandle).
      const startX = event.clientX;
      const startY = event.clientY;
      const pointerId = event.pointerId;
      const rowEl = event.currentTarget;
      let dragging = false;

      const setCursor = (value: string) => {
        document.body.style.cursor = value;
        document.body.style.userSelect = value ? "none" : "";
      };

      function onMove(ev: globalThis.PointerEvent) {
        if (!dragging) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD_PX) return;
          dragging = true;
          if (typeof rowEl.setPointerCapture === "function") rowEl.setPointerCapture(pointerId);
        }
        const hoverSha = resolveHoverSha(ev.clientX, ev.clientY);
        // FR-302: blocked cursor, paired with `gh-commit-row--drag-reject`'s outline so it's never color-only.
        setCursor(hoverSha === sha ? "not-allowed" : "grabbing");
        setDragState({ sourceSha: sha, hoverSha, pointerX: ev.clientX, pointerY: ev.clientY });
      }

      function cleanup() {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        setCursor("");
      }

      function onUp(ev: globalThis.PointerEvent) {
        cleanup();
        if (!dragging) {
          setDragState(null);
          return; // An ordinary click — never reached `DRAG_THRESHOLD_PX` (FR-319).
        }
        if (typeof rowEl.hasPointerCapture === "function" && rowEl.hasPointerCapture(pointerId)) {
          rowEl.releasePointerCapture(pointerId);
        }
        const bSha = resolveHoverSha(ev.clientX, ev.clientY);
        setDragState(null);
        // FR-302: self-drop or release outside any row opens no menu and makes no git call.
        if (bSha && bSha !== sha) {
          setDropMenu({ x: ev.clientX, y: ev.clientY, aSha: sha, bSha });
        }
      }

      function onCancel() {
        cleanup();
        setDragState(null);
      }

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
    },
    [resolveHoverSha],
  );

  // Ref-chip drag: delegates to the shared session (FR-418), tinting the ghost with the commit's lane color.
  const handleChipDragPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>, branchName: string, sha: string) =>
      session.begin(event, { branch: branchName, sha, laneColorSlot: colorSlotBySha.get(sha) ?? null }),
    [session, colorSlotBySha],
  );

  // FR-305/306: labels per `resolveDragCommitLabel`.
  const dropMenuLabels = useMemo(() => {
    if (!dropMenu) return null;
    return {
      aLabel: resolveDragCommitLabel(commitBySha.get(dropMenu.aSha), dropMenu.aSha),
      bLabel: resolveDragCommitLabel(commitBySha.get(dropMenu.bSha), dropMenu.bSha),
    };
  }, [dropMenu, commitBySha]);

  // FR-306/307/308: four fixed-order items, all disabled while the relationship is "computing" (AC1).
  const dropMenuItems: ContextMenuItem[] = useMemo(() => {
    if (!dropMenu || !dropMenuLabels) return [];
    const { aSha, bSha } = dropMenu;
    const { aLabel, bLabel } = dropMenuLabels;
    const computing = dropMenuRelationship === "computing";
    const commitA = commitBySha.get(aSha);

    const cherryPickReason = computing
      ? "Computing…"
      : computeCherryPickDisabledReason(repoState, commitA ? [commitA] : [], cherryPickBusy || dragActionBusy);
    const mergeReason = computeMergeOrRebaseDisabledReason(repoState, dropMenuRelationship, dragActionBusy, "merge");
    const rebaseReason = computeMergeOrRebaseDisabledReason(repoState, dropMenuRelationship, dragActionBusy, "rebase");

    return [
      {
        // FR-310: base/target by graph order, independent of drag direction.
        label: `Compare ${aLabel} with ${bLabel}`,
        onSelect: () => {
          const [baseSha, targetSha] = sortShasInGraphOrder([aSha, bSha], displayRows);
          if (baseSha && targetSha) onCompare(baseSha, targetSha);
        },
      },
      {
        label: `Cherry-pick ${aLabel} onto ${bLabel}`,
        disabled: cherryPickReason !== null,
        title: cherryPickReason ?? undefined,
        onSelect: cherryPickReason === null ? () => onDragCherryPick?.(aSha, bSha) : undefined,
      },
      {
        label: `Merge ${aLabel} into ${bLabel}`,
        disabled: mergeReason !== null,
        title: mergeReason ?? undefined,
        onSelect: mergeReason === null ? () => onDragMerge?.(aSha, bSha) : undefined,
      },
      {
        // FR-306: flipped subject — `{B}` moves, not `{A}`.
        label: `Rebase ${bLabel} onto ${aLabel}`,
        disabled: rebaseReason !== null,
        title: rebaseReason ?? undefined,
        onSelect: rebaseReason === null ? () => onDragRebase?.(aSha, bSha) : undefined,
      },
    ];
  }, [
    dropMenu,
    dropMenuLabels,
    dropMenuRelationship,
    commitBySha,
    repoState,
    cherryPickBusy,
    dragActionBusy,
    displayRows,
    onCompare,
    onDragCherryPick,
    onDragMerge,
    onDragRebase,
  ]);

  // FR-112/FR-114: the graph-ordered 2+ multi-selection if the menu's row is in it, else just that row.
  const cherryPickTargets = useMemo(() => {
    const sha = contextMenu?.sha;
    if (!sha) return [] as string[];
    if (multiSelected.has(sha) && multiSelected.size >= 2) {
      return sortShasInGraphOrder([...multiSelected], displayRows);
    }
    return [sha];
  }, [contextMenu, multiSelected, displayRows]);

  // FR-115: client-side check so it never disagrees with `cherryPick()`'s own pre-flight refusal (AC3).
  const cherryPickDisabledReason = useMemo(() => {
    const commits = cherryPickTargets
      .map((sha) => commitBySha.get(sha))
      .filter((c): c is CommitInfo => Boolean(c));
    return computeCherryPickDisabledReason(repoState, commits, cherryPickBusy);
  }, [cherryPickTargets, commitBySha, repoState, cherryPickBusy]);

  // specs/reset-to-here.md FR-366: client-side check so it never disagrees with `resetCurrentBranch()`'s refusal.
  const resetDisabledReason = useMemo(
    () => computeResetDisabledReason(repoState, resetBusy),
    [repoState, resetBusy],
  );

  // specs/compare-commits.md FR-186/FR-187: enabled only at EXACTLY 2 selected, no single-row
  // fallback (AC1/AC2), so read `multiSelected.size`, not `cherryPickTargets.length`.
  const compareSelectionSize = multiSelected.size;
  const compareDisabledReason = useMemo(() => {
    if (compareSelectionSize === 2) return null;
    if (compareSelectionSize <= 1) return "Ctrl/Cmd-click another commit, then right-click to compare";
    return `Select exactly 2 commits to compare (${compareSelectionSize} selected)`;
  }, [compareSelectionSize]);
  const compareShas = useMemo(() => {
    if (multiSelected.size !== 2) return null;
    const [baseSha, targetSha] = sortShasInGraphOrder([...multiSelected], displayRows);
    return baseSha && targetSha ? { baseSha, targetSha } : null;
  }, [multiSelected, displayRows]);

  // FR-54, FR-113, specs/reset-to-here.md FR-366; Revert is still a stub.
  const contextMenuItems: ContextMenuItem[] = useMemo(() => {
    const sha = contextMenu?.sha;
    const commit = sha ? displayRows.find((r) => r.kind === "commit" && r.laid.commit.sha === sha) : undefined;
    const abbrev = commit && commit.kind === "commit" ? commit.laid.commit.abbrevSha : sha?.slice(0, 7);
    const subject = commit && commit.kind === "commit" ? commit.laid.commit.subject : "";
    // specs/reset-to-here.md FR-366 AC1: detached label is literally "Reset HEAD to here…".
    const resetBranchLabel = repoState?.currentBranch ?? "HEAD";
    const resetEnabled = Boolean(sha) && resetDisabledReason === null;
    // FR-321: exactly one local branch on this commit gets an attached-switch item; 0 or 2+ is
    // ambiguous/unnamed, so none. Uses already-loaded `CommitInfo.refs`.
    const localBranchRefs =
      commit && commit.kind === "commit" ? commit.laid.commit.refs.filter((r) => r.type === "local-branch") : [];
    const soleLocalBranch = localBranchRefs.length === 1 ? localBranchRefs[0] : undefined;
    // FR-112: plural label at 2+. Names HEAD as the target (FR-113/FR-299) to match the drag menu's copy.
    const cherryPickTargetLabel = repoState?.currentBranch ?? "HEAD (detached)";
    const cherryPickLabel =
      cherryPickTargets.length >= 2
        ? `Cherry-pick ${cherryPickTargets.length} commits onto ${cherryPickTargetLabel}`
        : `Cherry-pick onto ${cherryPickTargetLabel}`;
    const cherryPickEnabled = cherryPickTargets.length > 0 && cherryPickDisabledReason === null;
    return [
      ...(soleLocalBranch
        ? [
            {
              // FR-321 (AC19): same FR-38 handler as the ref chip's "Checkout".
              label: `Checkout ${soleLocalBranch.name}`,
              onSelect: () => onSwitchBranch(soleLocalBranch.name),
            },
          ]
        : []),
      // FR-320: label discloses the detach at the point of choice (AC20).
      { label: "Checkout commit (detached)", onSelect: sha ? () => onCheckoutCommit(sha) : undefined, disabled: !sha },
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
      // specs/compare-commits.md FR-186: always rendered (disabled outside 2) for discoverability.
      {
        label: "Compare 2 commits",
        onSelect: compareShas ? () => onCompare(compareShas.baseSha, compareShas.targetSha) : undefined,
        disabled: compareDisabledReason !== null,
        title: compareDisabledReason ?? undefined,
      },
      { label: "Revert", disabled: true },
      {
        // FR-366: "Reset {branch} to here…" attached, "Reset HEAD to here…" detached (AC1).
        label: `Reset ${resetBranchLabel} to here…`,
        onSelect:
          resetEnabled && sha ? () => onResetToHere({ sha, abbrevSha: abbrev ?? sha.slice(0, 7), subject }) : undefined,
        disabled: !resetEnabled,
        title: resetDisabledReason ?? undefined,
      },
    ];
  }, [
    contextMenu,
    displayRows,
    onCheckoutCommit,
    onSwitchBranch,
    onCreateBranchAt,
    cherryPickTargets,
    cherryPickDisabledReason,
    onCherryPick,
    compareShas,
    compareDisabledReason,
    onCompare,
    repoState,
    resetDisabledReason,
    onResetToHere,
  ]);

  const refChipMenuItems: ContextMenuItem[] = useMemo(() => {
    const branchName = refChipMenu?.branchName;
    return [
      { label: "Checkout", onSelect: branchName ? () => onSwitchBranch(branchName) : undefined, disabled: !branchName },
      { label: "Delete…", onSelect: branchName ? () => onDeleteBranch(branchName) : undefined, disabled: !branchName },
    ];
  }, [refChipMenu, onSwitchBranch, onDeleteBranch]);

  // specs/ref-chip-gutter-legibility.md FR-411: one informational row per collapsed chip, reusing RefChip's accessible label.
  const refCollapseMenuItems: ContextMenuItem[] = useMemo(() => {
    if (!refCollapseMenu) return [];
    const { sha } = refCollapseMenu;
    const laneSlot = sha ? colorSlotBySha.get(sha) : undefined;
    return refCollapseMenu.chips.map((chip) => {
      const label = refChipAccessibleLabel(chip.decoration, chip.detached, chip.diverged, chip.syncedRemote?.name);
      const isLocal = chip.decoration.type === "local-branch";
      return {
        label,
        disabled: true,
        informational: true,
        dropTarget: isLocal && sha != null ? { branch: chip.decoration.name, sha } : undefined,
        dropActive: isLocal && session.drag != null && session.drag.hoverBranch === chip.decoration.name,
        // Rows render as real RefChips; local ones are chip-drag drop targets, remote/tag stay informational.
        content: (
          <RefChip
            decoration={chip.decoration}
            filled={chip.filled}
            detached={chip.detached}
            diverged={chip.diverged}
            syncedRemote={chip.syncedRemote}
            laneColorSlot={laneSlot}
          />
        ),
      };
    });
  }, [refCollapseMenu, colorSlotBySha, session.drag]);

  if (displayRows.length === 0) return null;

  return (
    <div className="gh-commit-graph">
      {followTarget && (
        // Addendum 2/1b, AC1/AC2: feedback that HEAD moved outside the loaded page; unmounts once the chase finds the row.
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
                divergedBranchNames={divergedBranchNames}
                syncedUpstreamByBranch={syncedUpstreamByBranch}
                isSelected={sha != null && sha === selectedSha}
                isCurrent={sha != null && sha === (repoState?.headSha ?? null)}
                isMultiSelected={
                  sha != null &&
                  (multiSelected.has(sha) ||
                    (compareTarget != null && (sha === compareTarget.baseSha || sha === compareTarget.targetSha)))
                }
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
                onRefChipsMoreClick={(x, y, collapsedChips) => {
                  setActiveIndex(index);
                  setRefCollapseMenu({ x, y, chips: collapsedChips, sha });
                }}
                onDragPointerDown={sha ? handleRowDragPointerDown : undefined}
                onChipDragPointerDown={sha ? handleChipDragPointerDown : undefined}
                chipDrag={
                  session.drag
                    ? { sourceBranch: session.drag.sourceBranch, hoverBranch: session.drag.hoverBranch }
                    : null
                }
                isDragSource={sha != null && dragState?.sourceSha === sha}
                dragHoverState={
                  sha == null || dragState == null || dragState.hoverSha !== sha
                    ? "none"
                    : sha === dragState.sourceSha
                      ? "reject"
                      : "valid"
                }
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
      {/* specs/ref-chip-gutter-legibility.md FR-411: "+N" affix popover, anchored at its bottom-left corner. */}
      {refCollapseMenu && (
        <ContextMenu
          x={refCollapseMenu.x}
          y={refCollapseMenu.y}
          ariaLabel="More refs on this commit"
          items={refCollapseMenuItems}
          onClose={closeRefCollapseMenu}
        />
      )}
      {/* specs/drag-commit-menu.md FR-303/304/305: drag-drop action menu with "Dragged {A} onto {B}" header. */}
      {dropMenu && dropMenuLabels && (
        <ContextMenu
          x={dropMenu.x}
          y={dropMenu.y}
          sha={dropMenu.bSha}
          ariaLabel={`Dragged ${dropMenuLabels.aLabel} onto ${dropMenuLabels.bLabel}`}
          header={
            <span>
              Dragged <strong>{dropMenuLabels.aLabel}</strong> onto <strong>{dropMenuLabels.bLabel}</strong>
            </span>
          }
          items={dropMenuItems}
          onClose={() => setDropMenu(null)}
        />
      )}
      {/* specs/drag-commit-menu.md FR-322/323/325: cursor-following ghost, mounted exactly with `dragState`.
          `pointer-events: none` keeps it out of `resolveHoverSha`'s hit-test (FR-323). Its label reuses
          `resolveDragCommitLabel` so it matches the drop menu header. */}
      {/* Shared branch-drag overlay: rendered here only standalone; otherwise `App` renders it once. */}
      {!sharedSession && localSession.overlay}
      {dragState && (
        <div
          className={`gh-drag-ghost${dragState.hoverSha === dragState.sourceSha ? " gh-drag-ghost--reject" : ""}`}
          style={{ left: dragState.pointerX + DRAG_GHOST_OFFSET_PX, top: dragState.pointerY + DRAG_GHOST_OFFSET_PX }}
          aria-hidden="true"
        >
          <span
            className="gh-drag-ghost__dot"
            style={{
              background:
                // FR-324: self-drop uses the same `critical` token as `.gh-commit-row--drag-reject`.
                dragState.hoverSha === dragState.sourceSha
                  ? "var(--gh-status-critical)"
                  : laneColorVar(colorSlotBySha.get(dragState.sourceSha) ?? 0),
            }}
          />
          <span className="gh-mono">
            {resolveDragCommitLabel(commitBySha.get(dragState.sourceSha), dragState.sourceSha)}
          </span>
        </div>
      )}
    </div>
  );
}
