// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// jsdom has no container queries, so the width steps of specs/edit-in-diff.md FR-579 are pinned by their stylesheet text; real widths are checked in the Electron screenshots.
const css = readFileSync(join(__dirname, "EditorPane.css"), "utf8");

function containerBlock(width: number): string {
  const start = css.indexOf(`@container (max-width: ${width}px) {`);
  if (start < 0) throw new Error(`no @container ${width}px block`);
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(start, i + 1);
  }
  throw new Error("unbalanced");
}

describe("editor column width steps (FR-579)", () => {
  it("the editor column is the query container, not the window", () => {
    expect(css).toMatch(/\.gh-edit \{[^}]*container-type: inline-size/);
    expect(css).not.toMatch(/@media \(max-width/);
  });

  it("<1000: directory goes and Back becomes icon-only", () => {
    const b = containerBlock(1000);
    expect(b).toContain(".gh-edit__dir");
    expect(b).toContain(".gh-edit__lbl-back");
    expect(b).toContain(".gh-edit__btn--back");
  });

  it("<760: tag text icon-only, Undo/Redo into the overflow menu, pill collapses, the Unsaved word is NOT hidden", () => {
    const b = containerBlock(760);
    expect(b).toContain(".gh-edit__tag-text");
    expect(b).toMatch(/\.gh-edit__ur[^{]*\{\s*display: none/);
    expect(b).toMatch(/\.gh-edit__ovf \{\s*display: inline-flex/);
    expect(b).toMatch(/\.gh-pill__long \{\s*display: none/);
    expect(b).toMatch(/\.gh-pill__short \{\s*display: inline/);
    expect(b).not.toMatch(/\.gh-edit__state \{/);
    expect(b).not.toMatch(/\.gh-edit__state[^-_]/);
  });

  it("<560: the bar wraps to two rows", () => {
    const b = containerBlock(560);
    expect(b).toMatch(/\.gh-edit__bar \{[^}]*flex-wrap: wrap/);
    expect(b).toMatch(/\.gh-edit__id \{[^}]*flex-basis: 100%/);
  });

  it("the overflow trigger is hidden by default and the pill is outside the scroller, clear of the 12px scrollbar", () => {
    expect(css).toMatch(/\.gh-edit__ovf \{[^}]*display: none/);
    expect(css).toMatch(/\.gh-edit__float \{[^}]*position: absolute[^}]*right: 20px/s);
  });

  it("the pill is opaque: a solid surface background, no blur, no translucency", () => {
    const m = /\.gh-pill \{([^}]*)\}/.exec(css)![1]!;
    expect(m).toContain("background: var(--gh-surface)");
    expect(m).not.toMatch(/backdrop-filter|opacity/);
  });
});
