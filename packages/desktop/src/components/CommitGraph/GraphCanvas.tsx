// SPDX-License-Identifier: GPL-3.0-or-later
import { useLayoutEffect, useRef } from "react";
import type { GraphDisplayRow } from "../../hooks/useRepositoryGraph";
import { laneColorHex, resolveCssVariable } from "../../lib/cssVars";
import {
  LANE_STROKE_WIDTH,
  MERGE_NODE_RADIUS,
  NODE_RADIUS,
  OCTOPUS_NODE_RADIUS,
  REF_GUTTER_WIDTH,
  ROW_HEIGHT,
  laneX,
} from "./graphGeometry";

export interface GraphCanvasProps {
  rows: GraphDisplayRow[];
  startIndex: number;
  endIndex: number;
  width: number;
  /** Included only so the draw effect re-runs (and re-resolves CSS colors) on theme toggle. */
  theme: "light" | "dark";
  headSha: string | null;
  selectedSha: string | null;
}

function drawCurve(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
) {
  ctx.strokeStyle = color;
  ctx.lineWidth = LANE_STROKE_WIDTH;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  const midY = (y1 + y2) / 2;
  ctx.bezierCurveTo(x1, midY, x2, midY, x2, y2);
  ctx.stroke();
}

function drawStraight(
  ctx: CanvasRenderingContext2D,
  x: number,
  y1: number,
  y2: number,
  color: string,
) {
  ctx.strokeStyle = color;
  ctx.lineWidth = LANE_STROKE_WIDTH;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x, y1);
  ctx.lineTo(x, y2);
  ctx.stroke();
}

/**
 * specs/graph-head-indicator-and-refresh-alerting.md Problem 1: the HEAD/current-position marker
 * must be distinguishable from the selection ring by *shape*, not color/size alone — a same-color
 * concentric ring at a different radius (the previous implementation) reads as "the same thing,
 * slightly bigger" at a glance, especially right after an app-initiated checkout when both rings
 * briefly land on the same node. A small filled flag/pin above the node is an unmistakably
 * different shape from the selection's circular outline, and (unlike a ring at another radius)
 * doesn't need to compete for the same annulus of space around the node.
 */
function drawHeadMarker(ctx: CanvasRenderingContext2D, x: number, y: number, nodeRadius: number, color: string) {
  const gap = 3;
  const halfWidth = 3;
  const height = 4;
  const tipY = y - nodeRadius - gap;
  const baseY = tipY - height;
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, tipY);
  ctx.lineTo(x - halfWidth, baseY);
  ctx.lineTo(x + halfWidth, baseY);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * design-pass "Selection vs. merge-node visual conflation": the selection mark for the currently
 * selected commit, drawn as its own independent overlay layer *after* every node in the visible
 * slice has already been drawn for its type (regular / merge / octopus / history-boundary) — so
 * node geometry (radius, fill-vs-hollow) always finishes encoding commit type alone before
 * selection is ever considered, and a re-selection can never perturb it.
 *
 * Deliberately NOT the same rendering technique the merge node's own ring uses (a single opaque
 * stroked circle) — that similarity was the actual source of the conflation this fixes. A merge
 * commit is already "a ring around a dot"; drawing selection as *another* same-style ring around
 * the same node (the previous implementation) reads as "is this one ring or two, and which one
 * means selected?", worse still on a selected merge commit. Selection instead renders as a soft
 * translucent halo wash (a filled disc at reduced alpha) plus one crisp, full-opacity outer
 * contour line — a halo/glow idiom, not one more hollow interchange ring — so it reads as "this
 * node is selected" regardless of whether the node underneath is a small dot or a large merge
 * ring.
 */
function drawSelectionHalo(ctx: CanvasRenderingContext2D, x: number, y: number, nodeRadius: number, color: string) {
  const haloRadius = nodeRadius + 7;
  ctx.save();
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, haloRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(x, y, haloRadius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/**
 * The WIP row is always display index 0 but its connector reaches HEAD's row arbitrarily far below, so it is
 * clipped from absolute row coordinates to the slice instead of being drawn per row (FR-12, and the canvas
 * top-offset pitfall in CLAUDE.md). With HEAD not loaded it runs off the bottom of the loaded rows.
 */
function drawWipConnector(ctx: CanvasRenderingContext2D, rows: GraphDisplayRow[], startIndex: number, height: number) {
  const wip = rows[0];
  if (!wip || wip.kind !== "uncommitted" || rows.length < 2) return;
  const absTop = ROW_HEIGHT / 2 + NODE_RADIUS + 1.5;
  const absBottom = wip.headRowIndex === null ? rows.length * ROW_HEIGHT : wip.headRowIndex * ROW_HEIGHT + ROW_HEIGHT / 2;
  const offset = startIndex * ROW_HEIGHT;
  const y1 = Math.max(absTop - offset, 0);
  const y2 = Math.min(absBottom - offset, height);
  if (y2 <= y1) return;
  ctx.save();
  ctx.setLineDash([2, 2]);
  ctx.strokeStyle = laneColorHex(wip.colorSlot);
  ctx.lineWidth = LANE_STROKE_WIDTH;
  ctx.beginPath();
  ctx.moveTo(laneX(wip.lane), y1);
  ctx.lineTo(laneX(wip.lane), y2);
  ctx.stroke();
  ctx.restore();
}

/**
 * Draws the transit-map lane art (FR-10) for the currently visible row slice only — the parent
 * CommitGraph hands us exactly `rows[startIndex, endIndex)`; nothing outside that window is ever
 * touched, so scrolling a 100k+ commit history never re-does full-history work (FR-12).
 */
export function GraphCanvas({ rows, startIndex, endIndex, width, theme, headSha, selectedSha }: GraphCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Layout effect: the bitmap must land in the same paint as the new `top`, or one frame shows stale art out of step with the rows.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const height = (endIndex - startIndex) * ROW_HEIGHT;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const accent = resolveCssVariable("--gh-accent");
    // The one selected node's position/radius in this visible slice, if any — captured while
    // drawing node art below (never used to influence it) and painted as the independent halo
    // overlay pass only once every node in the slice has finished being drawn for its type.
    let selectedNode: { x: number; y: number; radius: number } | null = null;

    drawWipConnector(ctx, rows, startIndex, height);

    for (let i = startIndex; i < endIndex; i++) {
      const row = rows[i];
      if (!row) continue;
      const localY = (i - startIndex) * ROW_HEIGHT;
      const centerY = localY + ROW_HEIGHT / 2;

      if (row.kind === "uncommitted") {
        const x = laneX(row.lane);
        const color = laneColorHex(row.colorSlot);
        ctx.save();
        ctx.setLineDash([2, 2]);
        ctx.strokeStyle = color;
        ctx.lineWidth = LANE_STROKE_WIDTH;
        ctx.beginPath();
        ctx.arc(x, centerY, NODE_RADIUS + 1.5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        continue;
      }

      const laid = row.laid;
      const nodeX = laneX(laid.lane);

      for (const segment of laid.lanes) {
        const x = laneX(segment.lane);
        const color = laneColorHex(segment.colorSlot);
        if (segment.lane === laid.lane) {
          if (segment.above) drawStraight(ctx, x, localY, centerY, color);
          if (segment.below) drawStraight(ctx, x, centerY, localY + ROW_HEIGHT, color);
        } else if (segment.above && segment.below) {
          drawStraight(ctx, x, localY, localY + ROW_HEIGHT, color);
        } else if (segment.above && !segment.below) {
          drawCurve(ctx, x, localY, nodeX, centerY, color);
        } else if (!segment.above && segment.below) {
          drawCurve(ctx, nodeX, centerY, x, localY + ROW_HEIGHT, color);
        }
      }

      const nodeColor = laneColorHex(laid.colorSlot);
      const isCurrent = laid.commit.sha === headSha;
      const isSelected = laid.commit.sha === selectedSha;

      if (laid.commit.isHistoryBoundary) {
        // Shallow-clone / graft truncation boundary (AC8): hollow ring, never a solid node, plus
        // a short dashed stub trailing off — "history unavailable beyond this point". A text
        // equivalent is rendered in the accessible DOM row (CommitRow), not just this canvas.
        ctx.save();
        ctx.strokeStyle = nodeColor;
        ctx.lineWidth = LANE_STROKE_WIDTH;
        ctx.beginPath();
        ctx.arc(nodeX, centerY, NODE_RADIUS, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(nodeX, centerY + NODE_RADIUS);
        ctx.lineTo(nodeX, localY + ROW_HEIGHT);
        ctx.stroke();
        ctx.restore();
      } else if (laid.isMerge) {
        const radius = laid.isOctopus ? OCTOPUS_NODE_RADIUS : MERGE_NODE_RADIUS;
        ctx.fillStyle = nodeColor;
        ctx.beginPath();
        ctx.arc(nodeX, centerY, radius * 0.55, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = nodeColor;
        ctx.lineWidth = LANE_STROKE_WIDTH;
        ctx.beginPath();
        ctx.arc(nodeX, centerY, radius, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.fillStyle = nodeColor;
        ctx.beginPath();
        ctx.arc(nodeX, centerY, NODE_RADIUS, 0, Math.PI * 2);
        ctx.fill();
      }

      if (isCurrent) {
        // Distinct shape from the selection halo drawn after this loop (AC1) — see
        // drawHeadMarker's doc comment.
        drawHeadMarker(ctx, nodeX, centerY, laid.isMerge ? MERGE_NODE_RADIUS : NODE_RADIUS, accent);
      }
      if (isSelected) {
        // Recorded, not drawn here — see drawSelectionHalo's doc comment for why selection is
        // deferred to its own overlay pass rather than drawn inline with node-type art.
        selectedNode = { x: nodeX, y: centerY, radius: laid.isMerge ? MERGE_NODE_RADIUS : NODE_RADIUS };
      }
    }

    // Independent overlay layer, painted last so it never mixes with — and can never be mistaken
    // for — the node-type art (merge ring, boundary ring, HEAD flag) drawn above.
    if (selectedNode) {
      drawSelectionHalo(ctx, selectedNode.x, selectedNode.y, selectedNode.radius, accent);
    }

  }, [rows, startIndex, endIndex, width, theme, headSha, selectedSha]);

  return (
    <canvas
      ref={canvasRef}
      className="gh-graph-canvas"
      // The canvas draws the slice at local y=0, so it must sit at `startIndex * ROW_HEIGHT` like
      // each CommitRow's `top` (CLAUDE.md pitfall: canvas must track scroll).
      //
      // `left` is likewise driven from `REF_GUTTER_WIDTH` (DESIGN.md "Ref chip" gutter revision)
      // rather than the CSS default of 0, so the lane art starts exactly where the persistent
      // ref-chip gutter column (`.gh-commit-row__refgutter`, same constant) ends.
      style={{ top: startIndex * ROW_HEIGHT, left: REF_GUTTER_WIDTH }}
      role="presentation"
      aria-hidden="true"
    />
  );
}
