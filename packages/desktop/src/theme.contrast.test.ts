// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { contrastRatio, hexToRgb } from "./lib/contrastRatio";

const css = fs.readFileSync(path.join(__dirname, "theme.css"), "utf8");

/** The value of `--name` inside the first block that mentions the given theme selector (light is the :root block). */
function token(theme: "light" | "dark", name: string): string {
  const blocks = css.split("}");
  const block = blocks.find((b) => b.includes(`[data-theme="${theme}"]`) && b.includes(`${name}:`));
  const m = block && new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block);
  if (!m) throw new Error(`${name} not found for ${theme}`);
  return m[1]!;
}

describe("--gh-ink-muted-text (specs/worktrees.md Open question 6)", () => {
  for (const theme of ["light", "dark"] as const) {
    it(`meets 4.5:1 on the page and the surface in the ${theme} theme`, () => {
      const ink = hexToRgb(token(theme, "--gh-ink-muted-text"));
      for (const plane of ["--gh-page", "--gh-surface"]) {
        expect(contrastRatio(ink, hexToRgb(token(theme, plane))), `${theme} ${plane}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it("is used for the text that carries disabled reasons", () => {
    const read = (rel: string) => fs.readFileSync(path.join(__dirname, rel), "utf8");
    expect(read("components/ContextMenu/ContextMenu.css")).toMatch(/__item-description \{[^}]*--gh-ink-muted-text/s);
    expect(read("components/CommandPalette/CommandPalette.css")).toMatch(/__reason \{[^}]*--gh-ink-muted-text/s);
  });
});
