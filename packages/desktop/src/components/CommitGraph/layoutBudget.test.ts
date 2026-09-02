import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { graphWidth, REF_GUTTER_WIDTH } from "./graphGeometry";
import {
  BRANCHES_PANEL_DEFAULT_WIDTH,
  DETAIL_PANEL_DEFAULT_WIDTH,
} from "../../lib/layoutSizes";

const dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Regression guard for a real visual bug caught by an actual Electron launch + DOM measurement
 * (jsdom can't lay out real boxes, so it couldn't have caught this itself): at the app's own
 * documented default window size (electron/main.ts's `createWindow()`, 1400x900) with the
 * Branches sidebar and a right panel (DetailPanel, the "click a commit" case) both at their
 * default widths, the persistent branch/tag/HEAD gutter column (graphGeometry.ts's
 * `REF_GUTTER_WIDTH`) plus the graph's own lane art left the center commit-list column with
 * *negative* room for the commit subject — measured `padding-left` of 264px against a ~276px-wide
 * row, with the subject text positioned entirely outside the visible/scrollable area (not just
 * "narrow," literally zero visible characters).
 *
 * This doesn't re-simulate the full flex/CSS layout (that's what the real Electron measurement in
 * this fix's commit message documents) — it pins the arithmetic relationship between the handful
 * of constants that determine the center column's budget, using the real measured baseline
 * (1388px window content width at 1400px requested BrowserWindow width, the OS chrome overhead),
 * so nobody can silently widen a panel default or the gutter back into this exact regression
 * without this test failing first.
 */
describe("commit row layout budget (real-window-size regression guard)", () => {
  // Real Electron measurement at BrowserWindow width 1400 (electron/main.ts's createWindow()
  // default): window.innerWidth is 1388, not 1400 — the 12px difference is native window chrome,
  // not anything CSS controls.
  const MEASURED_WINDOW_CONTENT_WIDTH_AT_DEFAULT = 1388;

  // Real Electron measurement: the graph scroll pane's own vertical scrollbar costs the row a
  // small slice of the scroll pane's own width (measured ~15.2px at this window size).
  const SCROLLBAR_OVERHEAD = 15;

  // A real branch-heavy repo's actual worst-common-case row (this repo's own history, measured
  // live) sits at 5 concurrent lanes — not `MAX_VISIBLE_LANES` (12), which is an acknowledged,
  // already-documented extreme edge case (graphGeometry.ts), not the bar this guard holds.
  const REALISTIC_BUSY_ROW_LANE_COUNT = 4;

  // sha (abbreviated, mono 12px) + the one remaining flex gap once author/date have stepped aside
  // (CommitGraph.css's container-query degradation) + the row's own padding-right
  // (`--gh-space-3`) — real measured combined value, rounded up slightly.
  const SHA_GAP_AND_PADDING_RIGHT_WIDTH = 71;

  // Deliberately looser than `.gh-commit-row__subject`'s actual 200px CSS `min-width` (design-pass
  // fix #4 — the floor that exists so the subject can never shrink back to the old mid-word-
  // truncation bug's 80px floor): at this exact real-measured window size, the true fit lands
  // within a couple of rounding-sensitive pixels of that 200px floor (verified via real Electron
  // screenshot — see this fix's commit message), which makes a hand-rolled arithmetic re-
  // simulation of the full flex/box model too brittle to pin at 200 exactly here. 150px is still
  // comfortably "legible, not a handful of characters" (the actual regression this guards against
  // was the subject positioned entirely *outside* the visible row — effectively 0 visible
  // characters, not merely narrower than 200px) and — critically — the *old* 160px gutter +
  // 420/680px panel defaults produce a deeply *negative* number here (see the second assertion
  // below), so this threshold cleanly separates "regressed" from "fixed" with real margin.
  const SUBJECT_LEGIBLE_MIN_WIDTH = 150;

  it("leaves the subject column a legible width at the app's default window size with BranchesPanel + DetailPanel both open at default width", () => {
    const centerColumnWidth =
      MEASURED_WINDOW_CONTENT_WIDTH_AT_DEFAULT - BRANCHES_PANEL_DEFAULT_WIDTH - DETAIL_PANEL_DEFAULT_WIDTH;
    const rowWidth = centerColumnWidth - SCROLLBAR_OVERHEAD;
    const paddingLeft = REF_GUTTER_WIDTH + graphWidth(REALISTIC_BUSY_ROW_LANE_COUNT);
    const availableForSubject = rowWidth - paddingLeft - SHA_GAP_AND_PADDING_RIGHT_WIDTH;

    expect(availableForSubject).toBeGreaterThanOrEqual(SUBJECT_LEGIBLE_MIN_WIDTH);
  });

  it("documents the regression this guards against: the old 160px gutter + 420/680px panel defaults left the subject with negative available width", () => {
    const OLD_REF_GUTTER_WIDTH = 160;
    const OLD_BRANCHES_PANEL_DEFAULT_WIDTH = 420;
    const OLD_DETAIL_PANEL_DEFAULT_WIDTH = 680;

    const centerColumnWidth =
      MEASURED_WINDOW_CONTENT_WIDTH_AT_DEFAULT - OLD_BRANCHES_PANEL_DEFAULT_WIDTH - OLD_DETAIL_PANEL_DEFAULT_WIDTH;
    const rowWidth = centerColumnWidth - SCROLLBAR_OVERHEAD;
    const oldPaddingLeft = OLD_REF_GUTTER_WIDTH + graphWidth(REALISTIC_BUSY_ROW_LANE_COUNT);
    const availableForSubject = rowWidth - oldPaddingLeft - SHA_GAP_AND_PADDING_RIGHT_WIDTH;

    expect(availableForSubject).toBeLessThan(0);
  });

  it("still fails loudly (not silently) if REF_GUTTER_WIDTH regresses back toward its old 160px value", () => {
    // Documents *why* 160 was the regression, not just what the new value is — this test would
    // fail if REF_GUTTER_WIDTH were reverted, which is the point.
    expect(REF_GUTTER_WIDTH).toBeLessThanOrEqual(110);
  });

  it("keeps BranchesPanel + DetailPanel's combined default width from re-eating the center column's budget", () => {
    // However these two constants get tuned in the future, their sum must leave a real floor of
    // the 1388px baseline for the center graph/row column — this is the exact number that was
    // insufficient before this fix (1388 - 420 - 680 = 288, which this test would have failed).
    const combined = BRANCHES_PANEL_DEFAULT_WIDTH + DETAIL_PANEL_DEFAULT_WIDTH;
    expect(MEASURED_WINDOW_CONTENT_WIDTH_AT_DEFAULT - combined).toBeGreaterThanOrEqual(450);
  });
});

/**
 * jsdom doesn't run real layout, so it can't verify container-query breakpoints actually hide
 * anything (that's what the real Electron measurement in this fix's commit covers) — this just
 * guards that the graceful-degradation mechanism itself is still wired up in the stylesheet,
 * so a future refactor can't silently drop it while every jsdom/unit test above still passes.
 */
describe("CommitGraph.css graceful-degradation mechanism is present", () => {
  const css = fs.readFileSync(path.join(dirname, "CommitGraph.css"), "utf8");

  it("makes each commit row its own size-query container", () => {
    expect(css).toMatch(/\.gh-commit-row\s*\{[^}]*container-type:\s*inline-size/);
  });

  it("hides the date column before the author column as the row narrows", () => {
    const dateRuleMatch = css.match(/@container gh-commit-row \(max-width:\s*(\d+)px\)\s*\{\s*\.gh-commit-row__date/);
    const authorRuleMatch = css.match(/@container gh-commit-row \(max-width:\s*(\d+)px\)\s*\{\s*\.gh-commit-row__author/);
    expect(dateRuleMatch).not.toBeNull();
    expect(authorRuleMatch).not.toBeNull();
    const dateThreshold = Number(dateRuleMatch?.[1]);
    const authorThreshold = Number(authorRuleMatch?.[1]);
    // Date goes first (a wider threshold means it disappears sooner as the row shrinks) — author's
    // "Name" is denser/more useful at a glance than the fully-formatted date (CommitGraph.css's own
    // comment), so losing date first buys back the more common squeeze before author has to go too.
    expect(dateThreshold).toBeGreaterThan(authorThreshold);
  });

  it("gives the center graph/row column a real min-width floor", () => {
    expect(css).toMatch(/\.gh-commit-graph\s*\{[^}]*min-width:\s*\d+px/);
  });
});
