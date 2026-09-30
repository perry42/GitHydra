// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * ROADMAP "still to check" (b): the drag drop menu, opened from a card near the window's bottom
 * edge, must stay fully inside the viewport in both themes. Real pointer events, real window;
 * screenshots under `.tmp-critique-screenshots/drag-menu-edge/`.
 */
import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { closeApp, launchGitHydra, removeUserDataDir, stubOpenRepoDialog, type LaunchedApp } from "../helpers/launchApp";
import { cleanup, commitAll, git, initRepo, writeFile } from "../../src/test/gitFixture";

const SHOT_DIR = path.join(process.cwd(), ".tmp-critique-screenshots", "drag-menu-edge");
let handle: LaunchedApp;
let repoDir = "";

test.beforeEach(async () => {
  await fs.mkdir(SHOT_DIR, { recursive: true });
  handle = await launchGitHydra();
  repoDir = "";
});
test.afterEach(async () => {
  await closeApp(handle);
  await removeUserDataDir(handle.userDataDir);
  if (repoDir) await cleanup(repoDir);
});

for (const theme of ["dark", "light"] as const) {
  for (const [w, h] of [[1280, 800], [880, 600]] as const) {
    test(`[${theme} ${w}x${h}] drop menu opened from the lowest visible branch card stays fully inside the viewport`, async () => {
      repoDir = await initRepo();
      await writeFile(repoDir, "a.txt", "base\n");
      await commitAll(repoDir, "Base commit");
      for (let i = 1; i <= 12; i++) {
        await git(repoDir, ["checkout", "-q", "-b", `feature-${String(i).padStart(2, "0")}`, "main"]);
        await writeFile(repoDir, `f${i}.txt`, `${i}\n`);
        await commitAll(repoDir, `Commit on feature-${i}`);
      }
      await git(repoDir, ["checkout", "-q", "main"]);

      const win: Page = handle.window;
      await win.evaluate((t) => window.localStorage.setItem("githydra:theme", t), theme);
      await win.reload();
      await win.waitForLoadState("domcontentloaded");
      await handle.app.evaluate(({ BrowserWindow }, [ww, hh]) => BrowserWindow.getAllWindows()[0]!.setSize(ww!, hh!), [w, h]);
      await stubOpenRepoDialog(handle.app, repoDir);
      await win.getByRole("button", { name: "Open a repository", exact: true }).click();
      await win.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });
      await expect(win.locator("html")).toHaveAttribute("data-theme", theme);

      // The lowest card that is fully visible in the viewport.
      const cards = win.locator("li[data-ref-branch]");
      await cards.first().waitFor({ timeout: 15_000 });
      const n = await cards.count();
      const vh = await win.evaluate(() => window.innerHeight);
      let lowest = -1;
      let lowestBox: { x: number; y: number; width: number; height: number } | null = null;
      for (let i = 0; i < n; i++) {
        const b = (await cards.nth(i).boundingBox())!;
        if (b.y + b.height <= vh - 2) { lowest = i; lowestBox = b; }
      }
      expect(lowest).toBeGreaterThanOrEqual(1);
      const targetName = (await cards.nth(lowest).getAttribute("data-ref-branch"))!;
      const sourceName = (await cards.nth(0).getAttribute("data-ref-branch"))!;

      const a = (await win.locator(`li[data-ref-branch="${sourceName}"]`).boundingBox())!;
      await win.mouse.move(a.x + 6, a.y + 5);
      await win.mouse.down();
      await win.mouse.move(a.x + 18, a.y + 17, { steps: 3 });
      // Drop at the very bottom of the lowest visible card (worst case for the menu's placement).
      await win.mouse.move(lowestBox!.x + 6, lowestBox!.y + lowestBox!.height - 4, { steps: 8 });
      await win.mouse.up();
      const menu = win.getByRole("menu");
      await expect(menu).toBeVisible();
      // The menu grows once the relationship computation resolves; measure the settled size.
      await expect(menu.getByText(/Computing/)).toHaveCount(0, { timeout: 15_000 });
      await win.waitForTimeout(300);
      await win.screenshot({ path: path.join(SHOT_DIR, `${theme}-${w}x${h}-menu.png`) });

      const r = await menu.evaluate((el) => {
        const b = el.getBoundingClientRect();
        return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, vw: window.innerWidth, vh: window.innerHeight, target: "" };
      });
      // eslint-disable-next-line no-console
      console.log(`MENU ${theme} ${w}x${h} drop=${sourceName}->${targetName} ` + JSON.stringify(r));
      expect(r.left).toBeGreaterThanOrEqual(0);
      expect(r.top).toBeGreaterThanOrEqual(0);
      expect(r.right).toBeLessThanOrEqual(r.vw);
      expect(r.bottom).toBeLessThanOrEqual(r.vh);
    });
  }
}
