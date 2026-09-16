// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * test-agent verification (specs/drag-commit-menu.md Addendum 1, FR-322-325, AC18-22): the ONLY
 * way to actually see the cursor-following drag ghost render real pixels in a real Chromium
 * window — the jsdom `CommitGraph.dragCommitMenu.test.tsx` suite already covers DOM/class/style
 * assertions for this feature, but per this project's test-agent gate, a fully green jsdom suite
 * has never been sufficient signal alone; this drives an actual `pointerdown`/`pointermove`/
 * `pointerup` sequence over the real running app and captures real screenshots for visual
 * confirmation (z-index, off-screen offset, legibility — the class of bug unit tests can't catch).
 *
 * Screenshots are written to the OS temp dir (path logged to the console) purely as this
 * verification pass's own visual evidence — not asserted on pixel content beyond what the DOM/
 * class assertions below already check, so this spec carries no maintenance burden beyond that.
 */
import { test, expect } from "@playwright/test";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import { closeApp, launchGitHydra, removeUserDataDir, stubOpenRepoDialog, type LaunchedApp } from "../helpers/launchApp";
import { cleanup, commitAll, git, initRepo, writeFile } from "../../src/test/gitFixture";

let handle: LaunchedApp;
let repoDir: string;
let shotDir: string;

test.beforeEach(async () => {
  handle = await launchGitHydra();
  shotDir = await fs.mkdtemp(path.join(os.tmpdir(), "githydra-pw-drag-ghost-"));
});

test.afterEach(async () => {
  await closeApp(handle);
  await removeUserDataDir(handle.userDataDir);
  if (repoDir) await cleanup(repoDir);
  // eslint-disable-next-line no-console
  console.log(`drag-ghost screenshots: ${shotDir}`);
});

async function openRepoThroughRealUiExact(h: LaunchedApp, repoPath: string): Promise<void> {
  await stubOpenRepoDialog(h.app, repoPath);
  await h.window.getByRole("button", { name: "Open a repository", exact: true }).click();
  await h.window.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });
}

test("AC18/19: ghost tracks the cursor with a legible SHA, and dropping through it onto another commit still opens the drop menu", async () => {
  repoDir = await initRepo();
  await writeFile(repoDir, "a.txt", "base\n");
  const firstSha = await commitAll(repoDir, "First commit");
  await writeFile(repoDir, "a.txt", "second\n");
  await commitAll(repoDir, "Second commit");

  await openRepoThroughRealUiExact(handle, repoDir);

  const firstRow = handle.window.locator('[role="option"]', { hasText: "First commit" });
  const secondRow = handle.window.locator('[role="option"]', { hasText: "Second commit" });
  await expect(firstRow).toBeVisible();
  await expect(secondRow).toBeVisible();

  const firstBox = await firstRow.boundingBox();
  const secondBox = await secondRow.boundingBox();
  if (!firstBox || !secondBox) throw new Error("expected both rows to have a bounding box");

  const startX = firstBox.x + firstBox.width / 2;
  const startY = firstBox.y + firstBox.height / 2;
  const endX = secondBox.x + secondBox.width / 2;
  const endY = secondBox.y + secondBox.height / 2;

  await handle.window.mouse.move(startX, startY);
  await handle.window.mouse.down();
  // Past DRAG_THRESHOLD_PX (6) in one axis is enough to start the drag.
  await handle.window.mouse.move(startX + 20, startY + 20);
  await handle.window.mouse.move(startX + 20, startY + 25);

  const ghost = handle.window.locator(".gh-drag-ghost");
  await expect(ghost).toBeVisible();
  await expect(ghost).toHaveText(new RegExp(firstSha.slice(0, 7)));
  await expect(ghost).not.toHaveClass(/gh-drag-ghost--reject/);

  // The ghost visibly follows the cursor, not anchored to the source row.
  const ghostBoxAtStart = await ghost.boundingBox();
  await handle.window.screenshot({ path: path.join(shotDir, "01-ghost-near-source.png") });

  // Move the ghost directly over the second row — dropping "through" it must still resolve to the
  // real row underneath (FR-323/AC19), not the ghost itself.
  await handle.window.mouse.move(endX, endY);
  await handle.window.mouse.move(endX + 1, endY + 1);
  const ghostBoxAtEnd = await ghost.boundingBox();
  await handle.window.screenshot({ path: path.join(shotDir, "02-ghost-over-target.png") });
  expect(ghostBoxAtEnd?.y).not.toBeCloseTo(ghostBoxAtStart?.y ?? -9999, 0);

  await handle.window.mouse.up();

  const menu = handle.window.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu).toContainText(/dragged/i);
  await handle.window.screenshot({ path: path.join(shotDir, "03-drop-menu-opened.png") });

  await expect(ghost).toHaveCount(0);
});

test("AC20: dragging back over the source commit's own row recolors the ghost to the reject state", async () => {
  repoDir = await initRepo();
  await writeFile(repoDir, "a.txt", "base\n");
  await commitAll(repoDir, "First commit");
  await writeFile(repoDir, "a.txt", "second\n");
  await commitAll(repoDir, "Second commit");

  await openRepoThroughRealUiExact(handle, repoDir);

  const firstRow = handle.window.locator('[role="option"]', { hasText: "First commit" });
  const secondRow = handle.window.locator('[role="option"]', { hasText: "Second commit" });
  const firstBox = await firstRow.boundingBox();
  const secondBox = await secondRow.boundingBox();
  if (!firstBox || !secondBox) throw new Error("expected both rows to have a bounding box");

  const startX = firstBox.x + firstBox.width / 2;
  const startY = firstBox.y + firstBox.height / 2;
  const otherX = secondBox.x + secondBox.width / 2;
  const otherY = secondBox.y + secondBox.height / 2;

  await handle.window.mouse.move(startX, startY);
  await handle.window.mouse.down();
  await handle.window.mouse.move(startX + 20, startY + 20);

  const ghost = handle.window.locator(".gh-drag-ghost");
  await expect(ghost).toBeVisible();
  await expect(ghost).not.toHaveClass(/gh-drag-ghost--reject/);

  // Wander over the other row first (valid-looking), then back over the source row itself.
  await handle.window.mouse.move(otherX, otherY);
  await expect(ghost).not.toHaveClass(/gh-drag-ghost--reject/);

  await handle.window.mouse.move(startX + 2, startY + 2);
  await expect(ghost).toHaveClass(/gh-drag-ghost--reject/);
  await expect(firstRow).toHaveClass(/gh-commit-row--drag-reject/);
  await handle.window.screenshot({ path: path.join(shotDir, "04-ghost-reject-over-source.png") });

  await handle.window.mouse.up();
  await expect(handle.window.getByRole("menu")).toHaveCount(0);
  await expect(ghost).toHaveCount(0);
});

test("real-app sweep: a fast/jittery drag never leaves more than one ghost element mounted, and the ghost stays legible near the window's edge", async () => {
  repoDir = await initRepo();
  await writeFile(repoDir, "a.txt", "base\n");
  await commitAll(repoDir, "First commit");
  await writeFile(repoDir, "a.txt", "second\n");
  await commitAll(repoDir, "Second commit");

  await openRepoThroughRealUiExact(handle, repoDir);

  const firstRow = handle.window.locator('[role="option"]', { hasText: "First commit" });
  const firstBox = await firstRow.boundingBox();
  if (!firstBox) throw new Error("expected the row to have a bounding box");
  const startX = firstBox.x + firstBox.width / 2;
  const startY = firstBox.y + firstBox.height / 2;

  await handle.window.mouse.move(startX, startY);
  await handle.window.mouse.down();
  await handle.window.mouse.move(startX + 20, startY + 20);

  const viewport = await handle.window.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));

  // A rapid, jittery sequence of moves, including out toward the window's far edges — the ghost
  // must still be exactly one element throughout (no duplicate mount from a missed cleanup) and
  // must never throw/detach the window.
  const points: Array<[number, number]> = [
    [startX + 40, startY + 5],
    [startX + 5, startY + 60],
    [viewport.width - 5, startY + 10],
    [viewport.width - 5, viewport.height - 5],
    [startX + 100, viewport.height - 5],
    [startX + 50, startY + 30],
  ];
  for (const [x, y] of points) {
    await handle.window.mouse.move(x, y);
    await expect(handle.window.locator(".gh-drag-ghost")).toHaveCount(1);
  }

  await handle.window.screenshot({ path: path.join(shotDir, "05-ghost-near-edge.png") });
  await handle.window.mouse.up();
  await expect(handle.window.locator(".gh-drag-ghost")).toHaveCount(0);
});
