// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Canvas 2D's color parser does not resolve `var(--custom-property)` the way a DOM element's
 * `style` would (there's no cascade context for a canvas draw call), so lane/status colors have
 * to be read from computed style up front and handed to the canvas as resolved color strings.
 */
export function resolveCssVariable(name: string, fallback = "#888888"): string {
  if (typeof document === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

const PALETTE_SIZE = 8;

export function laneColorHex(colorSlot: number): string {
  const slot = ((colorSlot % PALETTE_SIZE) + PALETTE_SIZE) % PALETTE_SIZE;
  return resolveCssVariable(`--gh-lane-${slot + 1}`);
}

export type StatusRole = "good" | "warning" | "serious" | "critical";

export function statusColorHex(role: StatusRole): string {
  return resolveCssVariable(`--gh-status-${role}`);
}
