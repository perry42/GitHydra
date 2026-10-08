// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// jsdom has no layout, so the real overflow/overlap check lives in e2e-playwright/electron/editRail.spec.ts; this only pins the rules it relies on.
const css = readFileSync(join(__dirname, "ChangesPanel.css"), "utf8");
const COLLAPSED = ".gh-changes-panel--editing .gh-changes-panel__files:not(:hover):not(:has(:focus-visible))";

function rule(selectorTail: string): string {
  const i = css.indexOf(`${COLLAPSED} ${selectorTail} {`);
  expect(i, selectorTail).toBeGreaterThan(-1);
  return css.slice(i, css.indexOf("}", i));
}

describe("collapsed rail CSS (specs/edit-in-diff.md FR-532)", () => {
  it("clips the row actions out of the layout and hit-testing without removing them from the accessibility tree", () => {
    const r = rule(".gh-changes-panel__file-actions");
    expect(r).toContain("pointer-events: none");
    expect(r).toContain("clip-path: inset(50%)");
    expect(r).not.toContain("display: none");
  });

  it("collapses section heads to a slim divider", () => {
    expect(rule(".gh-changes-panel__section-head")).toContain("min-height: 10px");
  });

  it("keeps the unsaved dot in the row's flow, not absolutely positioned over the icon", () => {
    expect(css).not.toMatch(/gh-changes-panel__unsaved \{\s*position: absolute/);
  });
});
