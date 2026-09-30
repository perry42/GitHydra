// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * At the app's minimum window width (880) with the Branches sidebar AND a 560px right panel (Changes)
 * open, the layout must fit the viewport: the sum of sidebar (340) + graph `min-width` (280) + panel
 * (560) is 1180px, which overflows an ~868px viewport. Two visible consequences, both PRE-EXISTING
 * on main (verified 2026-09-30 in a scratch worktree of `main`), neither introduced by
 * 01a0c46/bc9e121:
 *   1. the Changes panel's right edge (and its file-row Discard button) is clipped off-screen;
 *   2. focusing/using the "Resize file list" separator makes an overflow:hidden DIV scroll
 *      horizontally by the overflow amount (312px), shoving the toolbar's left side (Branches chip,
 *      brand) out of view.
 * Expected to FAIL (red) until the layout is fixed by ui-graphics.
 */
import { test, expect } from "@playwright/test";
import { closeApp, launchGitHydra, removeUserDataDir, stubOpenRepoDialog, type LaunchedApp } from "../helpers/launchApp";
import { cleanup, commitAll, initRepo, writeFile } from "../../src/test/gitFixture";

let handle: LaunchedApp;
let repoDir = "";

test.beforeEach(async () => {
  handle = await launchGitHydra();
});
test.afterEach(async () => {
  await closeApp(handle);
  await removeUserDataDir(handle.userDataDir);
  if (repoDir) await cleanup(repoDir);
});

async function openAtMinWidthWithBothPanels() {
  repoDir = await initRepo();
  await writeFile(repoDir, "a.txt", "base\n");
  await commitAll(repoDir, "base");
  await writeFile(repoDir, "a.txt", "changed\n");
  const w = handle.window;
  await handle.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(880, 700));
  await stubOpenRepoDialog(handle.app, repoDir);
  await w.getByRole("button", { name: "Open a repository", exact: true }).click();
  await w.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });
  await w.getByRole("button", { name: /^changes/i }).first().click();
  await w.getByRole("button", { name: "Stage all", exact: true }).waitFor();
  return w;
}

test("880px wide, Branches sidebar + Changes panel open: the Changes panel fits inside the viewport", async () => {
  const w = await openAtMinWidthWithBothPanels();
  const { right, vw } = await w.evaluate(() => ({
    right: document.querySelector(".gh-changes-panel")!.getBoundingClientRect().right,
    vw: window.innerWidth,
  }));
  // 0.5px tolerance: layout reports subpixel floats (868.00003 vs 868) for an exactly-fitting edge.
  expect(right).toBeLessThanOrEqual(vw + 0.5);
});

test("880px wide, both panels open: using the file-list resize separator never scrolls the app shell horizontally", async () => {
  const w = await openAtMinWidthWithBothPanels();
  const sep = w.getByRole("separator", { name: "Resize file list" });
  await sep.focus();
  for (let i = 0; i < 60; i++) await w.keyboard.press("ArrowLeft");
  const scrolled = await w.evaluate(() =>
    [...document.querySelectorAll("*")].filter((e) => e.scrollLeft > 0).map((e) => `${e.className || e.tagName}:${e.scrollLeft}`),
  );
  expect(scrolled).toEqual([]);
  const toolbarLeft = await w.evaluate(() => document.querySelector(".gh-toolbar")!.getBoundingClientRect().left);
  expect(toolbarLeft).toBeGreaterThanOrEqual(0);
});
