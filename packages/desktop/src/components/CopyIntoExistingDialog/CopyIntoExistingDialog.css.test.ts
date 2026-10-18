// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// jsdom applies no layout, so the pinned rules of specs/worktree-copy-ignored.md AC 24 are checked on the stylesheet text.
const css = readFileSync(join(__dirname, "CopyIntoExistingDialog.css"), "utf8");
const listCss = readFileSync(join(__dirname, "..", "CreateWorktreeDialog", "CopyIgnoredSection.css"), "utf8");

describe("dialog stylesheet (AC 24)", () => {
  it("the list has no overflow of its own (the dialog body is the only scroller)", () => {
    expect(css).not.toMatch(/overflow(-y|-x)?:\s*(auto|scroll)/);
    const rows = listCss.match(/\.gh-copy__rows\s*\{[^}]*\}/)?.[0] ?? "";
    expect(rows).not.toMatch(/overflow(-y)?:\s*(auto|scroll)/);
  });

  it("text is at least 12px", () => {
    const sizes = [...css.matchAll(/font-size:\s*(\d+)px/g)].map((m) => Number(m[1]));
    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(12);
  });

  it("the sentence and the path wrap instead of scrolling sideways", () => {
    expect(css).toMatch(/\.gh-copy-into__sentence[^}]*overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/\.gh-copy-into__path[^}]*overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/\.gh-copy-into__path[^}]*user-select:\s*text/);
  });

  it("the dialog is 540px wide and uses tokens, with no side stripe", () => {
    expect(css).toMatch(/width:\s*min\(540px,\s*90vw\)/);
    expect(css).not.toMatch(/border-(left|right):\s*[2-9]px/);
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
  });

  it("row and link targets are at least 24px high", () => {
    expect(listCss).toMatch(/\.gh-copy__rowlabel[^}]*min-height:\s*24px/s);
    expect(listCss).toMatch(/\.gh-copy__link[\s\S]*min-height:\s*24px/);
  });
});
