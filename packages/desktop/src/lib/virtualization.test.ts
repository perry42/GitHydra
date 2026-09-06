// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { computeVisibleRange, isNearEnd } from "./virtualization";

describe("computeVisibleRange", () => {
  it("only includes rows near the viewport for a huge history (FR-12)", () => {
    const range = computeVisibleRange(0, 600, 28, 200_000, 8);
    expect(range.startIndex).toBe(0);
    // ~22 rows fit in 600px at 28px each, plus overscan — nowhere near 200,000.
    expect(range.endIndex).toBeLessThan(60);
  });

  it("shifts the window as scrollTop increases, independent of total item count", () => {
    const range = computeVisibleRange(28_000, 600, 28, 200_000, 8);
    expect(range.startIndex).toBeGreaterThan(900);
    expect(range.endIndex).toBeLessThan(1100);
  });

  it("clamps to the available item count near the end of a short list", () => {
    const range = computeVisibleRange(0, 600, 28, 5, 8);
    expect(range.endIndex).toBe(5);
  });

  it("returns an empty range for a zero-commit / not-yet-measured container", () => {
    expect(computeVisibleRange(0, 0, 28, 0)).toEqual({ startIndex: 0, endIndex: 0 });
  });
});

describe("isNearEnd", () => {
  it("is false when far from the bottom of loaded rows", () => {
    expect(isNearEnd(0, 600, 28, 10_000)).toBe(false);
  });

  it("is true once scrolled within the threshold of the bottom", () => {
    const itemCount = 100;
    const scrollTop = itemCount * 28 - 600; // scrolled to the very bottom
    expect(isNearEnd(scrollTop, 600, 28, itemCount)).toBe(true);
  });
});
