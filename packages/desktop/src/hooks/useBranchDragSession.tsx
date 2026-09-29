// SPDX-License-Identifier: GPL-3.0-or-later
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type { CommitPairRelationship, RepositoryState } from "@githydra/git-core";
import { ContextMenu, type ContextMenuItem } from "../components/ContextMenu/ContextMenu";
import { IconBranches } from "../components/Icon/Icon";
import { REF_CHIP_LANE_TINT_PERCENT } from "../components/RefChip/RefChip";
import { computeMergeOrRebaseDisabledReason } from "../lib/dragCommitMenu";
import { laneColorVar } from "../lib/laneAssignment";

/**
 * specs/branch-panel-drag-merge.md FR-418/419: the ONE branch-drag-to-merge session, shared by the
 * graph's local-branch chips and the Branches panel's local cards. Owns the press/threshold/ghost/
 * hover-open "+N"/drop-resolution gesture, the "Dragged A onto B" menu and its single "Merge A into B"
 * item. Drop targets are found by hit-testing `[data-ref-branch]` (+ `data-ref-sha`) — the same two
 * attributes a gutter chip, a "+N" popover row and a Branches panel card all stamp — so a branch's
 * chip and card share one target identity (FR-424).
 *
 * Lives above both surfaces (`App` provides it via `BranchDragContext`) because a panel-to-graph
 * drag crosses components; `CommitGraph` falls back to a private instance when rendered without a
 * provider (standalone tests), so its behavior is identical either way.
 */

/** A real pointer move (jitter aside) before a press counts as a drag rather than a click. */
export const BRANCH_DRAG_THRESHOLD_PX = 6;
/** Fixed cursor-to-ghost offset so the ghost never sits under the pointer it is hit-testing. */
const GHOST_OFFSET_PX = 16;
/** How long the pointer must rest on a row's "+N" before its popover auto-opens (FR-419). */
const MORE_HOVER_OPEN_MS = 400;

export interface BranchDragSource {
  branch: string;
  /** Tip commit sha of the dragged branch. */
  sha: string;
  /** Lane color slot for the ghost tint; omitted (a panel card) renders a neutral surface. */
  laneColorSlot?: number | null;
}

export interface BranchDragState {
  sourceBranch: string;
  sourceSha: string;
  laneColorSlot: number | null;
  /** The branch chip/card currently under the pointer (`null` off any branch target). */
  hoverBranch: string | null;
  hoverSha: string | null;
  pointerX: number;
  pointerY: number;
}

export interface BranchDragSession {
  /** Non-null only once the pointer has passed the threshold. */
  drag: BranchDragState | null;
  /** Start a possible drag from a primary-button pointerdown on a branch chip/card. */
  begin: (event: ReactPointerEvent<HTMLElement>, source: BranchDragSource) => void;
  /** True while the drop menu is open (folded into the global "a menu is open" gate). */
  menuOpen: boolean;
  /** The ghost + drop menu; render once, anywhere. */
  overlay: ReactNode;
}

export interface UseBranchDragSessionOptions {
  repoState: RepositoryState | null;
  /** FR-426: called once at drop time. Omitted leaves the menu on "Computing…" (legacy behavior). */
  computeRelationship?: (aSha: string, bSha: string) => Promise<CommitPairRelationship>;
  /** True while a checkout/merge this menu started is in flight. */
  busy?: boolean;
  /** FR-427: checkout-if-needed for `bBranch`, then `mergeCommit(aSha)`. */
  onMerge?: (aSha: string, bSha: string, targetBranch?: string) => void;
}

interface DropMenuState {
  x: number;
  y: number;
  aBranch: string;
  aSha: string;
  bBranch: string;
  bSha: string;
}

function resolveHoverTarget(clientX: number, clientY: number): { branch: string; sha: string } | null {
  if (typeof document.elementFromPoint !== "function") return null;
  const el = document.elementFromPoint(clientX, clientY);
  const targetEl = el instanceof Element ? el.closest<HTMLElement>("[data-ref-branch]") : null;
  const branch = targetEl?.dataset.refBranch;
  const sha = targetEl?.dataset.refSha;
  return branch && sha ? { branch, sha } : null;
}

export function useBranchDragSession({
  repoState,
  computeRelationship,
  busy = false,
  onMerge,
}: UseBranchDragSessionOptions): BranchDragSession {
  const [drag, setDrag] = useState<BranchDragState | null>(null);
  const [dropMenu, setDropMenu] = useState<DropMenuState | null>(null);
  const [relationship, setRelationship] = useState<CommitPairRelationship | "computing" | "error">("computing");

  // FR-426: the ancestry read runs exactly once per drop, never during the drag itself.
  useEffect(() => {
    if (!dropMenu || !computeRelationship) return;
    // Two branches on the very same commit: trivially "already up to date" — no git read needed
    // (git-core also rejects a same-sha pair outright).
    if (dropMenu.aSha === dropMenu.bSha) {
      setRelationship("a-ancestor-of-b");
      return;
    }
    let cancelled = false;
    setRelationship("computing");
    void (async () => {
      try {
        const result = await computeRelationship(dropMenu.aSha, dropMenu.bSha);
        if (!cancelled) setRelationship(result);
      } catch {
        if (!cancelled) setRelationship("error");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dropMenu?.aSha, dropMenu?.bSha, computeRelationship]);

  const begin = useCallback((event: ReactPointerEvent<HTMLElement>, source: BranchDragSource) => {
    if (event.button !== 0) return; // Only the primary button starts a drag.
    const startX = event.clientX;
    const startY = event.clientY;
    const pointerId = event.pointerId;
    const captureEl = event.currentTarget;
    const laneColorSlot = source.laneColorSlot ?? null;
    let dragging = false;
    let hoverMoreEl: HTMLElement | null = null;
    let openedMoreEl: HTMLElement | null = null;
    let moreTimer: number | null = null;

    const setCursor = (value: string) => {
      document.body.style.cursor = value;
      // Never let a drag select text across the app.
      document.body.style.userSelect = value ? "none" : "";
    };

    function onMove(ev: globalThis.PointerEvent) {
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < BRANCH_DRAG_THRESHOLD_PX) return;
        dragging = true;
        if (typeof captureEl.setPointerCapture === "function") captureEl.setPointerCapture(pointerId);
      }
      // Hovering a row's "+N" for MORE_HOVER_OPEN_MS auto-opens its popover so a branch collapsed
      // behind it can be dropped on. Resolved via hit-testing (pointer capture keeps pointer events
      // on the pressed element, so per-element hover handlers never fire).
      const hit =
        typeof document.elementFromPoint === "function" ? document.elementFromPoint(ev.clientX, ev.clientY) : null;
      const moreEl = hit instanceof Element ? hit.closest<HTMLElement>("[data-ref-more]") : null;
      if (moreEl !== hoverMoreEl) {
        if (moreTimer !== null) window.clearTimeout(moreTimer);
        moreTimer = null;
        hoverMoreEl = moreEl;
        if (moreEl && moreEl !== openedMoreEl) {
          moreTimer = window.setTimeout(() => {
            moreTimer = null;
            openedMoreEl = moreEl;
            moreEl.click(); // the button's own onClick anchors + opens the popover.
          }, MORE_HOVER_OPEN_MS);
        }
      }
      const target = resolveHoverTarget(ev.clientX, ev.clientY);
      // Self-drop rejection: blocked cursor here, plus the source's own reject styling.
      setCursor(target?.branch === source.branch ? "not-allowed" : "grabbing");
      setDrag({
        sourceBranch: source.branch,
        sourceSha: source.sha,
        laneColorSlot,
        hoverBranch: target?.branch ?? null,
        hoverSha: target?.sha ?? null,
        pointerX: ev.clientX,
        pointerY: ev.clientY,
      });
    }

    function cleanup() {
      if (moreTimer !== null) window.clearTimeout(moreTimer);
      moreTimer = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKeyDown);
      setCursor("");
    }

    function releaseCapture() {
      if (typeof captureEl.hasPointerCapture === "function" && captureEl.hasPointerCapture(pointerId)) {
        captureEl.releasePointerCapture(pointerId);
      }
    }

    function onUp(ev: globalThis.PointerEvent) {
      cleanup();
      if (!dragging) return; // An ordinary click — never reached the threshold.
      releaseCapture();
      // A real drag ends in a `click` on the captured element — swallow that one click so releasing
      // a drag never also fires whichever control sits under the pointer (a plain press-release
      // without dragging returned above and still clicks normally).
      const swallow = (e: Event) => e.stopPropagation();
      window.addEventListener("click", swallow, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener("click", swallow, true), 0);
      const target = resolveHoverTarget(ev.clientX, ev.clientY);
      setDrag(null);
      // Dropping on itself, or anywhere that isn't another local branch chip/card, does nothing.
      if (target && target.branch !== source.branch) {
        setDropMenu({
          x: ev.clientX,
          y: ev.clientY,
          aBranch: source.branch,
          aSha: source.sha,
          bBranch: target.branch,
          bSha: target.sha,
        });
      }
    }

    function onCancel() {
      cleanup();
      if (dragging) releaseCapture();
      setDrag(null);
    }

    // FR-419: Escape aborts an in-progress drag exactly like `pointercancel`.
    function onKeyDown(ev: KeyboardEvent) {
      if (ev.key === "Escape") onCancel();
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKeyDown);
  }, []);

  const closeMenu = useCallback(() => setDropMenu(null), []);

  // FR-425/426: exactly one item, "Merge A into B", with the shared FR-307/308 disabled reasons.
  const items: ContextMenuItem[] = useMemo(() => {
    if (!dropMenu) return [];
    const reason = computeMergeOrRebaseDisabledReason(repoState, relationship, busy, "merge");
    return [
      {
        label: `Merge ${dropMenu.aBranch} into ${dropMenu.bBranch}`,
        disabled: reason !== null,
        title: reason ?? undefined,
        description: reason ?? undefined,
        onSelect: reason === null ? () => onMerge?.(dropMenu.aSha, dropMenu.bSha, dropMenu.bBranch) : undefined,
      },
    ];
  }, [dropMenu, relationship, repoState, busy, onMerge]);

  const overlay = (
    <>
      {drag && (
        // `pointer-events: none` (CommitGraph.css) guarantees the ghost is never what hit-testing returns.
        <div
          className={`gh-drag-ghost gh-drag-ghost--chip${drag.hoverBranch === drag.sourceBranch ? " gh-drag-ghost--reject" : ""}`}
          style={{
            left: drag.pointerX + GHOST_OFFSET_PX,
            top: drag.pointerY + GHOST_OFFSET_PX,
            background: `color-mix(in srgb, ${
              drag.laneColorSlot != null ? laneColorVar(drag.laneColorSlot) : "var(--gh-ink-muted)"
            } ${REF_CHIP_LANE_TINT_PERCENT}%, var(--gh-surface))`,
          }}
          aria-hidden="true"
        >
          <IconBranches size={14} />
          <span>{drag.sourceBranch}</span>
        </div>
      )}
      {dropMenu && (
        <ContextMenu
          x={dropMenu.x}
          y={dropMenu.y}
          sha={dropMenu.bSha}
          ariaLabel={`Dragged ${dropMenu.aBranch} onto ${dropMenu.bBranch}`}
          header={
            <span>
              Dragged <strong>{dropMenu.aBranch}</strong> onto <strong>{dropMenu.bBranch}</strong>
            </span>
          }
          items={items}
          onClose={closeMenu}
        />
      )}
    </>
  );

  return { drag, begin, menuOpen: dropMenu !== null, overlay };
}

/** Provided by `App` so the Branches panel, the graph and the palette picker share one session. */
export const BranchDragContext = createContext<BranchDragSession | null>(null);

/** `null` outside a provider (standalone component tests) — callers then simply offer no drag. */
export function useBranchDrag(): BranchDragSession | null {
  return useContext(BranchDragContext);
}
