// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { contrastRatio, hexToRgb, mixSrgbHex, relativeLuminance } from "./contrastRatio";

describe("contrastRatio utility (specs/ref-chip-gutter-redesign.md Addendum, FR-417/AC3a)", () => {
  it("hexToRgb parses 6-digit and 3-digit hex", () => {
    expect(hexToRgb("#ffffff")).toEqual([255, 255, 255]);
    expect(hexToRgb("#000000")).toEqual([0, 0, 0]);
    expect(hexToRgb("#fff")).toEqual([255, 255, 255]);
    expect(hexToRgb("2a78d6")).toEqual([0x2a, 0x78, 0xd6]);
  });

  it("relativeLuminance: white is 1, black is 0 (the WCAG-defined endpoints)", () => {
    expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1, 5);
    expect(relativeLuminance([0, 0, 0])).toBeCloseTo(0, 5);
  });

  it("contrastRatio: black-on-white is the well-known 21:1 maximum", () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 1);
  });

  it("contrastRatio: identical colors are 1:1 (the minimum)", () => {
    expect(contrastRatio([100, 120, 140], [100, 120, 140])).toBeCloseTo(1, 5);
  });

  it("contrastRatio is symmetric regardless of argument order", () => {
    const a: [number, number, number] = [10, 200, 50];
    const b: [number, number, number] = [230, 30, 90];
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 10);
  });

  it("contrastRatio matches a known WCAG reference pair (#767676 on #ffffff is exactly the 4.5:1 AA text floor)", () => {
    // This is the standard textbook example used across WCAG tooling/documentation for the AA
    // "normal text" 4.5:1 floor — a real cross-check against a value not derived from this file's
    // own math, catching a sign/formula error the round-trip tests above couldn't.
    expect(contrastRatio(hexToRgb("#767676"), hexToRgb("#ffffff"))).toBeCloseTo(4.5, 1);
  });

  it("mixSrgbHex: 0% is the 'with' color, 100% is the 'color' color, 50% is the exact midpoint", () => {
    expect(mixSrgbHex("#2a78d6", "#ffffff", 0)).toEqual([255, 255, 255]);
    expect(mixSrgbHex("#2a78d6", "#ffffff", 100)).toEqual(hexToRgb("#2a78d6"));
    // #000000 mixed 50% with #ffffff is #808080 (128,128,128) — an exact, easy-to-hand-check case.
    expect(mixSrgbHex("#000000", "#ffffff", 50)).toEqual([128, 128, 128]);
  });

  it("sanity/monotonicity: mixing MORE of a color darker than the surface into a white surface only ever lowers contrast against black text", () => {
    const black: [number, number, number] = [0, 0, 0];
    const contrastAt10Pct = contrastRatio(black, mixSrgbHex("#4a3aa7", "#ffffff", 10));
    const contrastAt90Pct = contrastRatio(black, mixSrgbHex("#4a3aa7", "#ffffff", 90));
    // At 10%, the background stays close to white (high luminance) -> high contrast against black
    // text. At 90%, the background is close to the violet lane color's own (lower) luminance ->
    // both foreground and background are dark -> lower contrast. This is the same direction of
    // effect RefChip.tsx's own chosen opacity relies on: a real error in mixSrgbHex's direction
    // (e.g. swapped color/with arguments) would silently flip this and this test would catch it.
    expect(contrastAt10Pct).toBeGreaterThan(contrastAt90Pct);
  });
});
