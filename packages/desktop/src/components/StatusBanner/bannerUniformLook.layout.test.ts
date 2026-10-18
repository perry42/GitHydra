// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// specs/banner-uniform-look.md FR-645/FR-648, AC3: jsdom can't see a stripe in a computed style, so the banner classes are pinned by stylesheet text.
const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function rules(css: string): Array<{ selector: string; body: string }> {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));
}

// Alert/notice/banner classes; row and line state bars (.gh-changes-panel__file--selected, DiffView, .gh-cf-cus/.gh-cf-stray, gutter bars) are deliberately NOT listed (FR-648).
const BANNER = /\.gh-(status-banner|op-banner|changes-panel__notice|cf-empty|fetch-banner|push-banner|clone-dialog__failure)/;
const sheets = [
  "StatusBanner/StatusBanner.css",
  "ChangesPanel/ChangesPanel.css",
  "CodeEditor/ConflictEditor.css",
  "FetchStatusBanner/FetchStatusBanner.css",
  "PushStatusBanner/PushStatusBanner.css",
  "PullStatusBanner/PullStatusBanner.css",
  "CloneDialog/CloneDialog.css",
];

describe("banners carry no side stripe (FR-645)", () => {
  const banner = sheets.flatMap((s) => rules(read(s)).filter((r) => BANNER.test(r.selector)));

  it("finds the banner rules it is guarding", () => {
    expect(banner.length).toBeGreaterThan(10);
  });

  it("no border-left wider than 1px, no coloured side border, no inset-bar box-shadow", () => {
    for (const { selector, body } of banner) {
      expect(body, selector).not.toMatch(/border-left-width\s*:\s*(?!1px|0)/);
      expect(body, selector).not.toMatch(/border-left-color\s*:/);
      expect(body, selector).not.toMatch(/border-(left|right|inline-start|inline-end)\s*:\s*(?!0|none|1px)/);
      expect(body, selector).not.toMatch(/box-shadow\s*:[^;]*inset\s+-?\d+px\s+0\s+0/);
    }
  });

  it("no pseudo-element stripe on a banner class", () => {
    for (const { selector } of banner) expect(selector, selector).not.toMatch(/::?(before|after)/);
  });

  it("banner text and icons use ink tokens, never a raw status fill (FR-647)", () => {
    for (const { selector, body } of banner) {
      expect(body, selector).not.toMatch(/(?<![-\w])color\s*:\s*var\(--gh-status-/);
      expect(body, selector).not.toMatch(/--gh-(banner|notice)-ink\s*:\s*var\(--gh-status-/);
    }
  });

  it("the warning and success tones use the warning and good ink tokens", () => {
    const css = read("StatusBanner/StatusBanner.css");
    expect(css).toMatch(/\.gh-status-banner--warning \{[^}]*--gh-banner-ink: var\(--gh-warning-ink\)/);
    expect(css).toMatch(/\.gh-status-banner--success \{[^}]*--gh-banner-status: var\(--gh-status-good\);[^}]*--gh-banner-ink: var\(--gh-good-ink\)/);
    const theme = readFileSync(join(root, "..", "theme.css"), "utf8");
    expect(theme.match(/--gh-warning-ink:/g)).toHaveLength(2);
  });

  it("the row/line state bars are still there (FR-648)", () => {
    expect(read("ChangesPanel/ChangesPanel.css")).toMatch(/\.gh-changes-panel__file--selected \{[^}]*box-shadow: inset 3px 0 0/);
  });
});
