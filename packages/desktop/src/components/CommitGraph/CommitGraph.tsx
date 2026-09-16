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
import { CommitRow } from "./CommitRow";
import { GraphCanvas } from "./GraphCanvas";
import { ROW_HEIGHT, graphWidth as computeGraphWidth } from "./graphGeometry";
import "./CommitGraph.css";

/** specs/drag-commit-menu.md FR-301: a real pointer move (jitter aside) before a pointerdown on a
 * commit row counts as the start of a drag rather than a plain click — small enough that an
 * intentional drag never feels laggy to start, large enough that an ordinary click's incidental
 * few pixels of mouse movement never gets misread as one. */
const DRAG_THRESHOLD_PX = 6;

/** specs/drag-commit-menu.md Addendum 1 FR-322: fixed offset (both axes) between the raw cursor
 * tip and the drag ghost's rendered position, so the ghost reads as "attached to the cursor"
 * without sitting directly under it (which would obscure the very row hit-testing needs to see). */
const DRAG_GHOST_OFFSET_PX = 16;

export interface CommitGraphProps {
  displayRows: GraphDisplayRow[];
  maxLaneIndexSeen: number;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
  visibleRefNames: ReadonlySet<string>;
  repoState: RepositoryState | null;
  /** specs/online-sync-fetch.md FR-326: local branch names currently diverged (ahead>0 AND
   * behind>0) from their upstream, as of the last fetch — forwarded to each `CommitRow`'s ref
   * chips. Omitted defaults to "none diverged" (pre-existing callers/tests unaffected). */
  divergedBranchNames?: ReadonlySet<string>;
  selectedSha: string | null;
  /**
   * specs/graph-head-indicator-and-refresh-alerting.md Addendum 3: a monotonic counter that changes
   * ONLY when `selectedSha` changed because of a genuine app-initiated HEAD move or explicit user
   * navigation (`useRepositoryGraph.ts`'s `selectCommit()`) — never for a tab-reactivation/relaunch
   * replay of a remembered selection (`restoreSelection()`), and never for this hook's own internal
   * selection resets/restores. The auto-follow-into-view effect below keys off THIS changing, not
   * off `selectedSha` changing, so a replayed selection updates the highlight/DetailPanel content
   * without dragging the graph's scroll position along with it.
   */
  followSignal: number;
  /**
   * test-agent finding (specs/graph-head-indicator-and-refresh-alerting.md Addendum 3's
   * "Verification gap"): the scroll offset this same tab was showing the last time this component
   * was live, or `undefined`/`0` for a tab that's never been scrolled (a brand-new tab, or one
   * whose remembered position was never set). `App.tsx`'s `MainArea` is the one component in this
   * tree that survives the unmount/remount `CommitGraph` itself goes through when a tab's
   * reactivation falls back to a full `openRepo()` reopen (`useRepoTabs.ts`'s `activateTabCore`,
   * `instant-tab-revisit.md` FR-240/AC8's row-count cache cap being the concrete case this addendum
   * found) — `MainArea` remembers each tab's last-reported scroll offset (via
   * `onScrollPositionChange` below) in a ref keyed by tab id that isn't destroyed by that
   * remount, and replays it back in as this prop once the tab is showing again. Applied to
   * `containerRef`'s real native DOM `scrollTop` — deliberately never routed through the
   * `scrollTop` render-state used for virtualization (see that state's own doc comment) — at mount,
   * and re-applied a bounded number of times as more rows land in case a real browser clamped the
   * first attempt short (only the first page is loaded at mount). Once settled, it's never touched
   * again, so it never fights with the `followSignal` effect below (a genuine HEAD move) or
   * ordinary user scrolling afterward.
   */
  initialScrollTop?: number;
  /**
   * Companion to `initialScrollTop` above — fired on every scroll (same event `handleScroll`
   * already handles for virtualization/near-end pagination) so the parent's remembered value for
   * this tab always reflects the current position, not just whatever it was when the tab was last
   * backgrounded. A plain forward, no debouncing needed: `MainArea` only ever reads its ref's
   * current value at the one moment a reopened tab's `CommitGraph` next mounts.
   */
  onScrollPositionChange?: (scrollTop: number) => void;
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
  /** specs/compare-commits.md FR-186/FR-187: the context menu's "Compare 2 commits" action —
   * called with `[baseSha, targetSha]` already sorted into graph order (older-first, the same
   * `sortShasInGraphOrder` helper FR-114 uses for cherry-pick), regardless of click order. */
  onCompare: (baseSha: string, targetSha: string) => void;
  /**
   * specs/compare-commits.md FR-196: the two commits `CompareView` is currently showing, kept
   * dashed-multi-select-highlighted in the graph for as long as the panel stays open — independent
   * of (and layered on top of) this component's own internal `multiSelected` ctrl/shift-click
   * state, since a right-click elsewhere (FR-112's "collapse to that row" convention) or any other
   * selection-mechanics interaction must never make the two actively-compared rows lose this
   * highlight while Compare is still showing them. `null`/`undefined` when Compare is closed.
   */
  compareTarget?: { baseSha: string; targetSha: string } | null;
  /**
   * specs/drag-commit-menu.md FR-303: computes the ancestry relationship for a dropped commit pair
   * — called exactly once, at drop time (never during the drag itself, AC16). Rejects on a genuine
   * transport failure; `CommitGraph` treats that as its own `"error"` menu state (see
   * `lib/dragCommitMenu.ts`'s `computeMergeOrRebaseDisabledReason`), never an uncaught rejection.
   */
  onComputeCommitPairRelationship?: (aSha: string, bSha: string) => Promise<CommitPairRelationship>;
  /** FR-311: FR-309's checkout-if-needed, then the existing single-commit cherry-pick flow with
   * `shas = [aSha]` (`{A}` = dragged, `{B}` = dropped-on). */
  onDragCherryPick?: (aSha: string, bSha: string) => void;
  /** FR-312: FR-309's checkout-if-needed, then `mergeCommit(aSha)`. */
  onDragMerge?: (aSha: string, bSha: string) => void;
  /** FR-313: FR-309's checkout-if-needed, then `rebaseCommitOnto(aSha)`. */
  onDragRebase?: (aSha: string, bSha: string) => void;
  /** specs/drag-commit-menu.md FR-308: true while a checkout-if-needed/merge/rebase this drag menu
   * itself started is in flight — folded into the Merge/Rebase items' disabled state alongside
   * `cherryPickBusy` (already a prop above) for Cherry-pick's own. */
  dragActionBusy?: boolean;
  /** specs/reset-to-here.md FR-367: the commit context menu's "Reset {branch} to here…" action —
   * opens the mode-selection dialog for this target commit. The caller (`App.tsx`) owns the dialog
   * itself and the whole mutating flow (`useResetActions`); this component only supplies the
   * already-loaded target commit's identity, matching `onCreateBranchAt`'s own "just open the
   * dialog" shape. */
  onResetToHere: (target: { sha: string; abbrevSha: string; subject: string }) => void;
  /** FR-366: true while a reset (or its own fresh dirty-check) triggered by this menu is in flight
   * — folded into the item's disabled state alongside the bare-repo/operation-in-progress checks,
   * mirroring `cherryPickBusy`. */
  resetBusy?: boolean;
  /**
   * test-agent finding (keyboard-shortcuts-command-palette.md FR-221's own text, which explicitly
   * names `ContextMenu` alongside the three dialogs as a component the global keybinding layer
   * must defer to): reports whether either of this component's own locally-owned `ContextMenu`
   * instances — the commit-row menu (`contextMenu`) or the ref-chip menu (`refChipMenu`) — is
   * currently open, on every change. `App.tsx` folds this into `anyModalDialogOpen` the same
   * lift-up pattern already used for `ChangesPanel`/`StashPanel`/`StatusBanner`'s own
   * `onDialogOpenChange`, so Ctrl+K doesn't stack the palette on top of a still-open right-click
   * menu. Optional — existing/other callers (e.g. standalone tests) that don't pass this see no
   * behavior change.
   */
  onContextMenuOpenChange?: (open: boolean) => void;
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
  divergedBranchNames,
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
  // test-agent finding (specs/graph-head-indicator-and-refresh-alerting.md Addendum 3's
  // "Verification gap"): deliberately NOT seeded from `initialScrollTop` — this state drives
  // virtualization (which rows actually render, see `computeVisibleRange` below), and a freshly
  // reopened tab only has its first page loaded at mount time. Seeding this with a deep restored
  // offset before enough rows exist would blank the virtualized window entirely (`startIndex` past
  // `displayRows.length`). `initialScrollTop` is instead applied straight to the real DOM node's
  // `scrollTop` (see the mount-effect and the restore-chase effect below), and this state only ever
  // catches up to that via the ordinary `handleScroll` path — exactly the same as any other
  // scrolling, genuine or programmatic.
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; sha: string } | null>(null);
  const [refChipMenu, setRefChipMenu] = useState<{ x: number; y: number; branchName: string } | null>(null);
  // specs/drag-commit-menu.md FR-301/302: `sourceSha` is the commit currently being dragged (once
  // the pointer has moved past `DRAG_THRESHOLD_PX` — see `handleRowDragPointerDown` below);
  // `hoverSha` is whichever commit row the pointer is currently over (`null` off any row). Neither
  // is set until the drag genuinely starts, so an ordinary click never touches this state at all.
  // Addendum 1 (FR-322/325): `pointerX`/`pointerY` are the raw cursor coordinates from that same
  // `pointermove` — reused to position the cursor-following ghost below rather than adding a
  // second independent listener; the ghost's mount/unmount lifecycle is exactly this state's own.
  const [dragState, setDragState] = useState<{
    sourceSha: string;
    hoverSha: string | null;
    pointerX: number;
    pointerY: number;
  } | null>(null);
  // FR-303: the drop menu itself — opened once, on release, over a DISTINCT commit (FR-302 never
  // opens this for a self-drop). `relationship` starts `"computing"` and is replaced once FR-295's
  // ancestry read (kicked off by the effect below) resolves — or `"error"` on a genuine failure.
  const [dropMenu, setDropMenu] = useState<{ x: number; y: number; aSha: string; bSha: string } | null>(null);
  const [dropMenuRelationship, setDropMenuRelationship] = useState<CommitPairRelationship | "computing" | "error">(
    "computing",
  );
  // specs/cherry-pick.md FR-111: the ctrl/shift-click multi-selection, entirely independent of
  // `selectedSha`/`onSelectCommit` (which continues to drive DetailPanel unchanged, per this
  // spec's explicit "must not change existing plain-click behavior" constraint). Row index (not
  // just sha) is tracked as the shift-range anchor since range math is naturally index-based.
  const [multiSelected, setMultiSelected] = useState<Set<string>>(new Set());
  const multiSelectAnchorRef = useRef<number | null>(null);

  // test-agent finding: reports on every change — a plain pass-through, not a duplicated
  // computation — see `onContextMenuOpenChange`'s own doc comment on the props type.
  //
  // specs/drag-commit-menu.md: `dropMenu` is a third `ContextMenu` instance this component owns
  // (alongside `contextMenu`/`refChipMenu` above) — folded into the same boolean for the identical
  // reason FR-221 already established for the other two.
  useEffect(() => {
    onContextMenuOpenChange?.(contextMenu !== null || refChipMenu !== null || dropMenu !== null);
  }, [contextMenu, refChipMenu, dropMenu, onContextMenuOpenChange]);

  // specs/drag-commit-menu.md FR-303: the ancestry read runs exactly once per drop, kicked off the
  // instant `dropMenu` opens on a genuinely new pair — never during the drag itself (AC16) and
  // never re-run for the SAME open menu (this effect's dependency is `dropMenu`'s identity via its
  // two shas, not e.g. `repoState`, which can legitimately change while the menu sits open without
  // re-triggering a second spawn). `cancelled` guards against a superseded/closed menu's late
  // response clobbering a newer one's `dropMenuRelationship`.
  useEffect(() => {
    if (!dropMenu || !onComputeCommitPairRelationship) return;
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

  // test-agent finding (specs/graph-head-indicator-and-refresh-alerting.md Addendum 3's
  // "Verification gap"): `initialScrollTop` is applied straight to the real DOM node's native
  // `scrollTop`, deliberately NEVER routed through `setScrollTop` (the virtualization render-state
  // above) — see that state's own doc comment for why. A genuine browser clamps a `scrollTop`
  // assignment to whatever the element's current `scrollHeight` actually supports, so at mount
  // (only the first page loaded) this typically lands short of the real target; a genuine
  // programmatic `scrollTop` assignment also fires a real "scroll" event afterward, which
  // `handleScroll` below already handles exactly like any user-driven scroll — including its
  // existing near-end `onLoadMore` check — so the ordinary pagination path itself carries the
  // restore closer to the real target as more rows land, with no separate chase logic duplicated
  // here. `pendingScrollRestoreRef` below re-applies the same assignment each time `displayRows`
  // grows, so each new page's newly-taller `scrollHeight` gives the browser another chance to
  // actually honor it, until it does (or there's nothing left to load).
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
    // Stops re-applying once the browser confirms the target was actually reached, or once
    // there's genuinely nothing more to load (`hasMore` false) — bounded the same way this file's
    // other chase mechanism is (`AUTO_FOLLOW_LOAD_CAP` below), just via a natural stop condition
    // instead of an attempt counter, since `onLoadMore` itself is never called directly here — the
    // ordinary near-end pagination this `scrollTop` re-assignment's own real "scroll" event
    // triggers (via `handleScroll`) is what actually requests more rows.
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
  // `followSignal` actually changes value — an app-initiated HEAD move or explicit user navigation
  // that calls `selectCommit(newHeadSha)` from *outside* this component (checkout/branch-switch,
  // "jump to parent," a blame/filter jump, possibly scrolled far out of view) — scroll that row
  // into view and sync keyboard `activeIndex` to it. Guarded on a ref (not just a `[followSignal]`
  // dependency) so this never re-scans `displayRows` (can be 100k+ rows, FR-12) on every unrelated
  // `displayRows` change (e.g. `loadMore` while the selection is unchanged) — only on a real
  // follow-worthy selection change.
  //
  // Addendum 3: gated on `followSignal`, NOT on `selectedSha` itself — `selectedSha` also changes
  // for a tab-reactivation/relaunch replay of a remembered selection
  // (`useRepositoryGraph.ts`'s `restoreSelection()`), which must update the selection
  // highlight/DetailPanel content but must NOT auto-scroll (see that hook's own doc comment on
  // `followSignal`). A plain row click goes through `onSelectCommit`/the same `selectCommit()` path
  // too, but the clicked row is already visible, so this is a harmless no-op scroll in that case,
  // same as before this addendum.
  //
  // Addendum 2/Problem 1b: when the target row isn't in the currently-loaded page (large/
  // paginated repo, e.g. switching to a branch tip deep in history), this no longer silently
  // no-ops — it hands off to `followTarget`/the chase effect below, which drives bounded
  // auto-`loadMore` calls plus an inline affordance so the user gets visible feedback instead of
  // silence.
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

  // Addendum 1 (FR-322): the drag ghost reuses the SAME lane-color token each commit's real node
  // already draws with (`GraphCanvas.tsx`'s `laneColorHex(laid.colorSlot)` for canvas, this DOM
  // element instead uses `laneColorVar` for the equivalent `var(--gh-lane-N)` string) — never a new
  // hardcoded color.
  const colorSlotBySha = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of displayRows) if (row.kind === "commit") map.set(row.laid.commit.sha, row.laid.colorSlot);
    return map;
  }, [displayRows]);

  /**
   * specs/drag-commit-menu.md FR-301/302/303: resolves the row under `(clientX, clientY)` via
   * real hit-testing rather than a second per-row pointer handler — necessary because pointer
   * capture (below) redirects `pointermove`/`pointerup` themselves to the row that started the
   * drag, not to whatever the pointer is physically over. `elementFromPoint` is unimplemented in
   * jsdom (component tests stub it directly — see `CommitGraph.dragCommitMenu.test.tsx`); guarded
   * here so a test/host without it degrades to "no row under the pointer" rather than throwing.
   */
  const resolveHoverSha = useCallback((clientX: number, clientY: number): string | null => {
    if (typeof document.elementFromPoint !== "function") return null;
    const el = document.elementFromPoint(clientX, clientY);
    const hoverEl = el instanceof Element ? el.closest<HTMLElement>("[data-commit-sha]") : null;
    return hoverEl?.dataset.commitSha ?? null;
  }, []);

  // FR-301: press-drag-release starts here. Mirrors `useResizableWidth`'s own
  // pointerdown-captures-then-listens-on-window shape (this codebase's one prior drag gesture) —
  // `window` listeners (not the row itself) are what actually receive `pointermove`/`pointerup`,
  // so this still works correctly even in a test host where `setPointerCapture` is unimplemented
  // (guarded below, never assumed to exist). Below `DRAG_THRESHOLD_PX` of movement, this never
  // calls `setDragState` at all — apart from adding/removing its own listeners, it's invisible,
  // leaving the row's existing native `click` event (and `handleRowClick` above) completely
  // unaffected (FR-319).
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
      };

      function onMove(ev: globalThis.PointerEvent) {
        if (!dragging) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD_PX) return;
          dragging = true;
          if (typeof rowEl.setPointerCapture === "function") rowEl.setPointerCapture(pointerId);
        }
        const hoverSha = resolveHoverSha(ev.clientX, ev.clientY);
        // FR-302: the blocked-cursor half of the self-drop rejection signal — paired with
        // `gh-commit-row--drag-reject`'s non-color `critical`-toned outline below, never
        // color-only.
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
        // FR-302: a self-drop (bSha === sha) or a release outside any commit row (bSha === null)
        // opens no menu and makes no git call — the ONLY two cases that don't.
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

  // FR-305/306: each commit's display label — local branch, else remote-tracking branch, else
  // tag, else abbreviated SHA (`lib/dragCommitMenu.ts`'s `resolveDragCommitLabel`).
  const dropMenuLabels = useMemo(() => {
    if (!dropMenu) return null;
    return {
      aLabel: resolveDragCommitLabel(commitBySha.get(dropMenu.aSha), dropMenu.aSha),
      bLabel: resolveDragCommitLabel(commitBySha.get(dropMenu.bSha), dropMenu.bSha),
    };
  }, [dropMenu, commitBySha]);

  // FR-306/307/308: the drop menu's four fixed-order items. While `dropMenuRelationship` is still
  // `"computing"` (AC1), every item is shown disabled with that as its reason — settling into the
  // FR-307 ancestry table (plus FR-308's bare-repo/in-progress-operation/merge-commit checks) only
  // once the FR-295 read actually resolves (or `"error"` on a genuine failure, `lib/
  // dragCommitMenu.ts`'s own doc comment).
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
        // FR-310: base/target assignment is unchanged — the same graph-order determinism the
        // multi-select + right-click flow already uses, independent of drag direction.
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
        // FR-306: deliberately flipped subject — `{B}` is what moves, not `{A}`.
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

  // specs/reset-to-here.md FR-366: checked client-side, mirroring `cherryPickDisabledReason`
  // above, so the menu item's disabled state can never disagree with `resetCurrentBranch()`'s own
  // server-side refusal.
  const resetDisabledReason = useMemo(
    () => computeResetDisabledReason(repoState, resetBusy),
    [repoState, resetBusy],
  );

  // specs/compare-commits.md FR-186/FR-187: unlike `cherryPickTargets` above, Compare has no
  // single-row fallback — it's only ever enabled at EXACTLY 2 selected, regardless of which row
  // the context menu happens to be open on (AC1/AC2). `multiSelected.size` alone (not
  // `cherryPickTargets.length`) is deliberately read here so this stays correct even on a row
  // whose own sha isn't part of a genuine 2+ selection (that case wants "0 or 1 selected", the
  // same disabled state as truly nothing selected — not a 1-commit fallback).
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

  // FR-54: "Checkout"/"Create branch here" are wired to real git semantics; FR-113 wires up
  // Cherry-pick; specs/reset-to-here.md FR-366 wires up Reset — Revert remains a stub for its own
  // not-yet-built spec.
  const contextMenuItems: ContextMenuItem[] = useMemo(() => {
    const sha = contextMenu?.sha;
    const commit = sha ? displayRows.find((r) => r.kind === "commit" && r.laid.commit.sha === sha) : undefined;
    const abbrev = commit && commit.kind === "commit" ? commit.laid.commit.abbrevSha : sha?.slice(0, 7);
    const subject = commit && commit.kind === "commit" ? commit.laid.commit.subject : "";
    // specs/reset-to-here.md FR-366: matches `cherryPickTargetLabel`'s own derivation convention
    // (`repoState?.currentBranch ?? ...`), but with a different fallback string — AC1 requires the
    // literal "Reset HEAD to here…" for a detached session, not "Reset HEAD (detached) to here…".
    const resetBranchLabel = repoState?.currentBranch ?? "HEAD";
    const resetEnabled = Boolean(sha) && resetDisabledReason === null;
    // FR-321: exactly one local-branch ref pointing at this commit gets its own attached-switch
    // item, above the (unchanged, relabeled) detaching item. Zero or 2+ local branches leave this
    // undefined — ambiguous with 2+, nothing to name with 0 — falling back to today's chip-only
    // path, no new git-core call, all data already loaded on `CommitInfo.refs`.
    const localBranchRefs =
      commit && commit.kind === "commit" ? commit.laid.commit.refs.filter((r) => r.type === "local-branch") : [];
    const soleLocalBranch = localBranchRefs.length === 1 ? localBranchRefs[0] : undefined;
    // FR-112: "Cherry-pick N commits" once 2+ are targeted, otherwise the ordinary singular label.
    // Product-consistency follow-up to specs/drag-commit-menu.md Addendum 1: cherry-pick always
    // targets current HEAD (FR-113/FR-299) but this item never said so, unlike the drag menu's own
    // "Cherry-pick {A} onto {B}" copy — naming the target here makes both entry points read the
    // same way, with no change to which commit is actually targeted.
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
              // FR-321 (AC19): wired to the SAME FR-38 attached-switch handler the ref chip's own
              // "Checkout" item uses (`onSwitchBranch`) — never a new call path.
              label: `Checkout ${soleLocalBranch.name}`,
              onSelect: () => onSwitchBranch(soleLocalBranch.name),
            },
          ]
        : []),
      // FR-320: relabeled from "Checkout commit" so the detaching behavior is disclosed at the
      // point of choice — same handler/sha/behavior as before, unchanged (AC20).
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
      // specs/compare-commits.md FR-186: ALWAYS rendered (never conditionally hidden outside the
      // exactly-2 case) — a deliberate discoverability fix so a user who never learns the
      // multi-select gesture on their own still discovers this feature via the same right-click
      // every user already tries.
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
                divergedBranchNames={divergedBranchNames}
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
                onDragPointerDown={sha ? handleRowDragPointerDown : undefined}
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
      {/* specs/drag-commit-menu.md FR-303/304/305: the drag-drop action menu — same `ContextMenu`
          chrome as the two right-click menus above (FR-304), with its "Dragged {A} onto {B}"
          header (FR-305) and its own four fixed-order items (`dropMenuItems`, built above). */}
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
      {/* specs/drag-commit-menu.md Addendum 1 FR-322/323/324/325: the cursor-following drag ghost.
          Mount/unmount is exactly `dragState`'s own (FR-325) — no independent fade/lingering.
          `pointer-events: none` (CommitGraph.css) guarantees this can never itself be the element
          `resolveHoverSha`'s `elementFromPoint` returns (FR-323), regardless of z-order/overlap.
          Addendum 2 FR-326: the label text reuses `resolveDragCommitLabel` — the same resolution
          the drop menu's own header already applies to this exact commit — so the ghost never
          shows a different identifier for it than the menu that opens a frame after release. */}
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
                // FR-324: self-drop (reject) case recolors to the same `critical` token
                // `.gh-commit-row--drag-reject` uses, instead of the commit's normal lane color —
                // in sync with, never contradicting, that row highlight and the `not-allowed`
                // cursor already set above.
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
