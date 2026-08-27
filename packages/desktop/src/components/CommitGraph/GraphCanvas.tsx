import { useEffect, useRef } from "react";
import type { GraphDisplayRow } from "../../hooks/useRepositoryGraph";
import { laneColorHex, resolveCssVariable } from "../../lib/cssVars";
import {
  LANE_STROKE_WIDTH,
  MERGE_NODE_RADIUS,
  NODE_RADIUS,
  OCTOPUS_NODE_RADIUS,
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
 * Draws the transit-map lane art (FR-10) for the currently visible row slice only — the parent
 * CommitGraph hands us exactly `rows[startIndex, endIndex)`; nothing outside that window is ever
 * touched, so scrolling a 100k+ commit history never re-does full-history work (FR-12).
 */
export function GraphCanvas({ rows, startIndex, endIndex, width, theme, headSha, selectedSha }: GraphCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
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
        if (row.connectsDown) {
          ctx.beginPath();
          ctx.moveTo(x, centerY + NODE_RADIUS + 1.5);
          ctx.lineTo(x, localY + ROW_HEIGHT);
          ctx.stroke();
        }
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
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(nodeX, centerY, (laid.isMerge ? MERGE_NODE_RADIUS : NODE_RADIUS) + 3, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (isSelected) {
        ctx.strokeStyle = accent;
        ctx.lineWidth = 2;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(nodeX, centerY, (laid.isMerge ? MERGE_NODE_RADIUS : NODE_RADIUS) + 5.5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

  }, [rows, startIndex, endIndex, width, theme, headSha, selectedSha]);

  return (
    <canvas
      ref={canvasRef}
      className="gh-graph-canvas"
      role="presentation"
      aria-hidden="true"
    />
  );
}
