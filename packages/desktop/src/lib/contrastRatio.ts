// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * specs/ref-chip-gutter-redesign.md Addendum (FR-417): a small, self-contained WCAG 2.x contrast
 * utility — no existing helper in this codebase computed real relative luminance/contrast ratios
 * before this (checked: nothing under `src/lib` or `src/components` did), so this is the one
 * implementation, reused by both `RefChip.tsx` (to pick/document the lane-tint opacity) and
 * `refChipLaneTint.contrast.test.ts` (to verify it programmatically, not by eye — AC3a). Every
 * function here is pure and has no DOM/CSS dependency, so it runs identically in a plain Node
 * test as it would if ported to a browser console.
 */

export type RgbTuple = readonly [number, number, number];

/** Parses a `#rrggbb` (or `#rgb`) hex color string into 0-255 RGB channels. */
export function hexToRgb(hex: string): RgbTuple {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (!/^[0-9a-fA-F]{6}$/.test(h)) {
    throw new Error(`hexToRgb: not a valid #rrggbb color: ${JSON.stringify(hex)}`);
  }
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return [r, g, b];
}

/** sRGB electro-optical transfer function (gamma decode) for one 0-255 channel, per the WCAG 2.x
 * relative-luminance definition (https://www.w3.org/TR/WCAG21/#dfn-relative-luminance). */
function srgbChannelToLinear(channel255: number): number {
  const c = channel255 / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance (0 = black, 1 = white) of an sRGB color. */
export function relativeLuminance([r, g, b]: RgbTuple): number {
  const rl = srgbChannelToLinear(r);
  const gl = srgbChannelToLinear(g);
  const bl = srgbChannelToLinear(b);
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}

/** WCAG contrast ratio between two sRGB colors — always >= 1 (identical colors), <= 21 (black vs
 * white), symmetric regardless of argument order (the spec's own (L1+0.05)/(L2+0.05) with L1 the
 * lighter of the two). */
export function contrastRatio(a: RgbTuple, b: RgbTuple): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Reproduces CSS Color 4's `color-mix(in srgb, colorHex pct%, withHex (100-pct)%)` — component-wise
 * linear interpolation directly in (non-linear, gamma-encoded) sRGB space, which is what `in srgb`
 * specifically means (as opposed to `in oklab`/`in lch`, which interpolate elsewhere). This is the
 * exact rule the real `RefChip.css`/inline-style `color-mix()` expression evaluates to in a real
 * browser, so a computation using this function predicts the real rendered pixel color.
 */
export function mixSrgbHex(colorHex: string, withHex: string, colorPercent: number): RgbTuple {
  const c = hexToRgb(colorHex);
  const w = hexToRgb(withHex);
  const p = colorPercent / 100;
  return [0, 1, 2].map((i) => Math.round(p * c[i]! + (1 - p) * w[i]!)) as unknown as RgbTuple;
}
