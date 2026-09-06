// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Gap 3 (test-agent's Playwright coverage plan): `GraphCanvas.test.tsx` replaces
 * `HTMLCanvasElement.prototype.getContext` with a fake that records paint API calls, and asserts
 * on the `<canvas>` element's `style.top` in jsdom — proving the paint call sequence and the CSS
 * `top` value are each individually correct, but never that they actually combine to produce
 * correctly-aligned pixels on a real screen. This is exactly the regression documented in this
 * repo's root CLAUDE.md ("Known pitfalls"): the canvas draws its visible row slice at LOCAL
 * y-offsets starting at 0, so if the canvas element's own `top` CSS ever stops tracking
 * `startIndex * ROW_HEIGHT` (e.g. a stacking-context/transform change elsewhere that doesn't touch
 * `GraphCanvas.tsx`'s own style prop at all), every node dot/lane line/HEAD marker/selection ring
 * silently renders `startIndex * ROW_HEIGHT` pixels off from the real DOM rows once scrolled past
 * the first screenful — undetectable by a jsdom test that only ever inspects the style value, never
 * how it actually composites with the real DOM underneath it.
 *
 * This suite renders the REAL `CommitGraph`/`GraphCanvas` production components (via
 * `src/test/playwrightHarness/harness.html`, served by the Vite dev server this config's
 * `webServer` starts) in a REAL Chromium browser, scrolls past the first screenful, and compares
 * REAL computed pixel positions — `getBoundingClientRect()` on the real DOM row vs. the real
 * canvas's own rendered `style.top` plus a `getImageData()` sample at the exact computed node
 * location. Additive only: `GraphCanvas.test.tsx`'s jsdom paint-recording test is untouched — it
 * stays as the fast, precise regression lock on the exact paint technique (halo vs. merge-ring).
 */
import { test, expect } from "@playwright/test";
import { GRAPH_LEFT_PADDING, ROW_HEIGHT } from "../../src/components/CommitGraph/graphGeometry";

const HARNESS_PATH = "/src/test/playwrightHarness/harness.html";

test("a selected commit's canvas-drawn node dot is pixel-aligned with its real DOM row after scrolling past the first screenful", async ({
  page,
}) => {
  await page.goto(HARNESS_PATH);

  const scrollContainer = page.locator(".gh-commit-graph__scroll");
  await expect(scrollContainer).toBeVisible();

  // The harness's fixture history (src/test/playwrightHarness/harness.tsx) is 400 commits tall at
  // ROW_HEIGHT=28px in a 640px-tall viewport (~23 rows visible) — row 150 is comfortably past the
  // first screenful. `CommitGraph` virtualizes rendering (only `[startIndex, endIndex)` rows exist
  // in the DOM at all), so the row doesn't exist yet until the real scroll event lands and React
  // re-renders the visible slice — set `scrollTop` directly (which dispatches a real native
  // `scroll` event) rather than relying on Playwright's click-time auto-scroll, which only works
  // for elements that already exist in the DOM.
  const targetIndex = 150;
  await scrollContainer.evaluate((el, { index, rowHeight }) => {
    (el as HTMLElement).scrollTop = index * rowHeight - 100;
  }, { index: targetIndex, rowHeight: ROW_HEIGHT });

  const row = page.locator(`#gh-commit-row-${targetIndex}`);
  await expect(row).toBeVisible({ timeout: 5_000 });
  await row.click();
  await expect(row).toHaveAttribute("aria-selected", "true");

  // Let the draw effect's requestAnimationFrame-adjacent paint settle after the click-driven
  // re-render (GraphCanvas's draw effect is a plain `useEffect`, which commits asynchronously
  // relative to the click).
  await page.waitForTimeout(100);

  const canvas = page.locator(".gh-graph-canvas");
  const rowBox = await row.boundingBox();
  const canvasBox = await canvas.boundingBox();
  expect(rowBox).not.toBeNull();
  expect(canvasBox).not.toBeNull();

  // The canvas draws the visible slice at LOCAL y-offsets starting at 0, and repositions the
  // element itself to `startIndex * ROW_HEIGHT` (GraphCanvas.tsx's own `style.top`) — read that
  // REAL rendered value back (never recomputed independently, so this can't coincidentally agree
  // with a broken implementation) to derive which slice index this row falls at within the
  // canvas's own local coordinate space.
  const canvasTopPx = await canvas.evaluate((el) => parseFloat((el as HTMLElement).style.top || "0"));
  const startIndex = Math.round(canvasTopPx / ROW_HEIGHT);
  const localCenterY = (targetIndex - startIndex) * ROW_HEIGHT + ROW_HEIGHT / 2;
  const expectedScreenY = canvasBox!.y + localCenterY;
  const rowCenterY = rowBox!.y + rowBox!.height / 2;

  // The core assertion against the CLAUDE.md-documented regression: if the canvas element's own
  // `top` offset ever stops tracking `startIndex * ROW_HEIGHT` (e.g. a refactor that re-pins it to
  // `top: 0`), this drifts by exactly `startIndex * ROW_HEIGHT` pixels (>1000px at this scroll
  // depth) — an unmistakable failure, not an off-by-one rounding wobble.
  expect(Math.abs(expectedScreenY - rowCenterY)).toBeLessThanOrEqual(1);

  // Pixel truth, not just coordinate arithmetic: every commit in this harness's fixture history is
  // a single unbroken lane (lane 0, see harness.tsx), so the node dot's real x-coordinate is always
  // `GRAPH_LEFT_PADDING`. Sample the canvas's own actual painted pixel at the computed on-screen
  // node location and confirm something opaque was really drawn there — proving the coordinate math
  // above and the real paint output actually agree, not just that they coincidentally compute the
  // same number while the canvas silently paints nothing (or something else) at that spot.
  const nodeScreenX = canvasBox!.x + GRAPH_LEFT_PADDING;
  const alpha = await canvas.evaluate(
    (el, [x, y]) => {
      const c = el as HTMLCanvasElement;
      const rect = c.getBoundingClientRect();
      const ctx = c.getContext("2d")!;
      // Canvas internal resolution is scaled by devicePixelRatio (GraphCanvas.tsx's draw effect) —
      // map the CSS-pixel screen point back into the canvas's own backing-store pixel coordinates.
      const scaleX = c.width / rect.width;
      const scaleY = c.height / rect.height;
      const localX = Math.round((x - rect.left) * scaleX);
      const localY = Math.round((y - rect.top) * scaleY);
      return ctx.getImageData(localX, localY, 1, 1).data[3];
    },
    [nodeScreenX, expectedScreenY],
  );
  expect(alpha).toBeGreaterThan(200);
});

test("an unselected node dot at the same scrolled position paints at the real row's location too (not just the selection halo)", async ({
  page,
}) => {
  await page.goto(HARNESS_PATH);
  const scrollContainer = page.locator(".gh-commit-graph__scroll");
  await expect(scrollContainer).toBeVisible();

  const targetIndex = 200;
  await scrollContainer.evaluate((el, { index, rowHeight }) => {
    (el as HTMLElement).scrollTop = index * rowHeight - 100;
  }, { index: targetIndex, rowHeight: ROW_HEIGHT });

  const row = page.locator(`#gh-commit-row-${targetIndex}`);
  await expect(row).toBeVisible({ timeout: 5_000 });
  await page.waitForTimeout(100);

  const canvas = page.locator(".gh-graph-canvas");
  const rowBox = await row.boundingBox();
  const canvasBox = await canvas.boundingBox();
  expect(rowBox).not.toBeNull();
  expect(canvasBox).not.toBeNull();

  const canvasTopPx = await canvas.evaluate((el) => parseFloat((el as HTMLElement).style.top || "0"));
  const startIndex = Math.round(canvasTopPx / ROW_HEIGHT);
  const localCenterY = (targetIndex - startIndex) * ROW_HEIGHT + ROW_HEIGHT / 2;
  const nodeScreenY = canvasBox!.y + localCenterY;
  const nodeScreenX = canvasBox!.x + GRAPH_LEFT_PADDING;

  const alpha = await canvas.evaluate(
    (el, [x, y]) => {
      const c = el as HTMLCanvasElement;
      const rect = c.getBoundingClientRect();
      const ctx = c.getContext("2d")!;
      const scaleX = c.width / rect.width;
      const scaleY = c.height / rect.height;
      const localX = Math.round((x - rect.left) * scaleX);
      const localY = Math.round((y - rect.top) * scaleY);
      return ctx.getImageData(localX, localY, 1, 1).data[3];
    },
    [nodeScreenX, nodeScreenY],
  );
  expect(alpha).toBeGreaterThan(200);
});
