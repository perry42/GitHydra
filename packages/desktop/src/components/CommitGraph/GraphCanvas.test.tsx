import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { GraphCanvas } from "./GraphCanvas";
import { MERGE_NODE_RADIUS, ROW_HEIGHT } from "./graphGeometry";
import { makeCommit, makeDisplayRows } from "../../test/fixtures";

interface RecordedPaint {
  method: "fill" | "stroke";
  radius: number;
  fillStyle: string;
  strokeStyle: string;
  globalAlpha: number;
}

/**
 * A canvas 2D context fake that (unlike test/setup.ts's global no-op stand-in) actually records
 * enough state to assert on *what* was painted, not just that some canvas API was called — needed
 * to prove the selection halo is a genuinely distinct paint technique from the merge node's own
 * ring, not merely "a bigger stroke."
 */
function makeRecordingContext() {
  const paints: RecordedPaint[] = [];
  const state = { fillStyle: "", strokeStyle: "", globalAlpha: 1, lastArcRadius: -1 };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx: any = {
    clearRect: () => {},
    beginPath: () => {},
    closePath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    bezierCurveTo: () => {},
    setLineDash: () => {},
    scale: () => {},
    save: () => {},
    restore: () => {},
    arc: (_x: number, _y: number, radius: number) => {
      state.lastArcRadius = radius;
    },
    fill: () => {
      paints.push({
        method: "fill",
        radius: state.lastArcRadius,
        fillStyle: state.fillStyle,
        strokeStyle: state.strokeStyle,
        globalAlpha: state.globalAlpha,
      });
    },
    stroke: () => {
      paints.push({
        method: "stroke",
        radius: state.lastArcRadius,
        fillStyle: state.fillStyle,
        strokeStyle: state.strokeStyle,
        globalAlpha: state.globalAlpha,
      });
    },
  };
  Object.defineProperty(ctx, "fillStyle", {
    get: () => state.fillStyle,
    set: (v: string) => {
      state.fillStyle = v;
    },
  });
  Object.defineProperty(ctx, "strokeStyle", {
    get: () => state.strokeStyle,
    set: (v: string) => {
      state.strokeStyle = v;
    },
  });
  Object.defineProperty(ctx, "globalAlpha", {
    get: () => state.globalAlpha,
    set: (v: number) => {
      state.globalAlpha = v;
    },
  });
  Object.defineProperty(ctx, "lineWidth", { get: () => 0, set: () => {} });
  Object.defineProperty(ctx, "lineCap", { get: () => "", set: () => {} });
  return { ctx, paints };
}

/**
 * Regression test for the Priority-0 correctness bug in ROADMAP.md: the canvas (which draws the
 * selection ring, HEAD marker, node dots, and lane lines) only ever draws the visible row slice
 * `rows[startIndex, endIndex)` using *local* y-offsets starting at 0 — so the canvas *element*
 * itself must be positioned at `startIndex * ROW_HEIGHT` to line up with the DOM rows it overlays
 * (each of which is positioned at `index * ROW_HEIGHT` by CommitGraph, see CommitGraph.tsx). Before
 * the fix, the canvas was CSS-pinned to `top: 0` unconditionally, so everything drawn on it —
 * including the selection ring — was rendered `startIndex * ROW_HEIGHT` pixels away from the
 * correct row whenever the visible window had scrolled past the first screenful (i.e., whenever
 * the selected row wasn't the first one currently visible).
 */
describe("GraphCanvas", () => {
  it("positions the canvas element at startIndex * ROW_HEIGHT so its drawn content lines up with the corresponding DOM rows", () => {
    const rows = makeDisplayRows(
      Array.from({ length: 50 }, (_, i) => makeCommit(`c${i}`, i < 49 ? [`c${i + 1}`] : [], { subject: `Commit ${i}` })),
    );

    const { container, rerender } = render(
      <GraphCanvas
        rows={rows}
        startIndex={0}
        endIndex={20}
        width={200}
        theme="dark"
        headSha={null}
        selectedSha="c0"
      />,
    );
    const canvasAtTop = container.querySelector("canvas");
    expect(canvasAtTop).not.toBeNull();
    expect(canvasAtTop!.style.top).toBe("0px");

    // Scroll so the window (and the selected commit within it) is no longer first-visible.
    rerender(
      <GraphCanvas
        rows={rows}
        startIndex={30}
        endIndex={50}
        width={200}
        theme="dark"
        headSha={null}
        selectedSha="c35"
      />,
    );
    const canvasScrolled = container.querySelector("canvas");
    expect(canvasScrolled!.style.top).toBe(`${30 * ROW_HEIGHT}px`);
  });
});

/**
 * Regression coverage for the design-pass fix to "Selection vs. merge-node visual conflation"
 * (ROADMAP.md): a selected merge commit must render its merge-ring geometry identically to an
 * unselected one (selection never changes node-type art), and the selection mark itself must use
 * a genuinely different paint technique (a translucent halo fill + separate full-opacity outer
 * stroke) from the merge ring's own plain opaque stroke — not just a bigger version of the same
 * ring, which is what made the two conflate before this fix.
 */
describe("GraphCanvas — selection halo vs. merge-node conflation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderWithRecording(selectedSha: string | null) {
    const { ctx, paints } = makeRecordingContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx);
    const rows = makeDisplayRows([
      makeCommit("merge1", ["p1", "p2"], { subject: "Merge branch" }),
      makeCommit("p1", [], { subject: "Parent 1" }),
    ]);
    render(
      <GraphCanvas
        rows={rows}
        startIndex={0}
        endIndex={rows.length}
        width={200}
        theme="dark"
        headSha={null}
        selectedSha={selectedSha}
      />,
    );
    return paints;
  }

  it("draws the merge node's own ring at the same radius whether or not it is selected", () => {
    const unselectedPaints = renderWithRecording(null);
    const selectedPaints = renderWithRecording("merge1");

    const mergeRingStroke = (paints: RecordedPaint[]) =>
      paints.find((p) => p.method === "stroke" && p.radius === MERGE_NODE_RADIUS && p.globalAlpha === 1);

    const unselectedRing = mergeRingStroke(unselectedPaints);
    const selectedRing = mergeRingStroke(selectedPaints);
    expect(unselectedRing).toBeDefined();
    expect(selectedRing).toBeDefined();
    expect(selectedRing!.radius).toBe(unselectedRing!.radius);
  });

  it("draws selection as a distinct translucent halo (fill + separate outer stroke) at a larger radius than the merge ring, never a plain full-opacity ring like the merge node uses", () => {
    const paints = renderWithRecording("merge1");
    const haloRadius = MERGE_NODE_RADIUS + 7;

    const haloWash = paints.find((p) => p.method === "fill" && p.radius === haloRadius);
    expect(haloWash).toBeDefined();
    // The wash is translucent — the one property that makes it read as a glow, not a hard ring.
    expect(haloWash!.globalAlpha).toBeLessThan(1);
    expect(haloWash!.globalAlpha).toBeGreaterThan(0);

    const haloOutline = paints.find((p) => p.method === "stroke" && p.radius === haloRadius);
    expect(haloOutline).toBeDefined();
    expect(haloOutline!.globalAlpha).toBe(1);

    // No merge-style node exists at the halo's radius — it never masquerades as "a bigger merge
    // ring," it is provably a different layer at a different radius using a different technique.
    expect(haloRadius).not.toBe(MERGE_NODE_RADIUS);
  });

  it("paints the selection halo strictly after all node-type art, as an independent final overlay layer", () => {
    const paints = renderWithRecording("merge1");
    const haloRadius = MERGE_NODE_RADIUS + 7;

    const lastNodeArtIndex = paints.reduce(
      (last, p, i) => (p.radius !== haloRadius ? i : last),
      -1,
    );
    const firstHaloIndex = paints.findIndex((p) => p.radius === haloRadius);

    expect(firstHaloIndex).toBeGreaterThan(-1);
    expect(firstHaloIndex).toBeGreaterThan(lastNodeArtIndex);
  });

  it("draws no halo paint at all when nothing is selected", () => {
    const paints = renderWithRecording(null);
    const haloRadius = MERGE_NODE_RADIUS + 7;
    expect(paints.some((p) => p.radius === haloRadius)).toBe(false);
  });
});
