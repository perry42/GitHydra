import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { GraphCanvas } from "./GraphCanvas";
import { ROW_HEIGHT } from "./graphGeometry";
import { makeCommit, makeDisplayRows } from "../../test/fixtures";

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
