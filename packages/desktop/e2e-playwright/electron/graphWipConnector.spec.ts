// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Regression: the dashed Uncommitted-changes node used to connect to HEAD only when HEAD was the first commit
 * row. Here main's merge commit (and newer main commits) sit above the checked-out feature tip, so the dashed
 * connector must run through every row in between. Screenshots go to $WIP_SHOTS.
 */
import { test, expect } from "@playwright/test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closeApp, launchGitHydra, removeUserDataDir, stubOpenRepoDialog, type LaunchedApp } from "../helpers/launchApp";
import { cleanup, commitAll, git, initRepo, writeFile } from "../../src/test/gitFixture";
import { decodePng, getPixel } from "../helpers/pngPixels";
import { ROW_HEIGHT, laneX } from "../../src/components/CommitGraph/graphGeometry";

let handle: LaunchedApp;
let repoDir: string;

test.beforeEach(async () => {
  handle = await launchGitHydra();
});
test.afterEach(async () => {
  await closeApp(handle);
  await removeUserDataDir(handle.userDataDir);
  if (repoDir) await cleanup(repoDir);
});

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: WIP node is connected to HEAD below a merge commit on main`, async () => {
    const shotDir = process.env.WIP_SHOTS ?? (await fs.mkdtemp(path.join(os.tmpdir(), "githydra-pw-wip-")));
    await fs.mkdir(shotDir, { recursive: true });
    repoDir = await initRepo();
    await writeFile(repoDir, "a.txt", "a\n");
    await commitAll(repoDir, "A base");
    const main = (await git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    await git(repoDir, ["checkout", "-b", "feat/hunk-line-staging"]);
    await writeFile(repoDir, "f.txt", "f\n");
    await commitAll(repoDir, "F feature tip");
    await git(repoDir, ["checkout", main]);
    for (const n of [1, 2, 3]) {
      await writeFile(repoDir, `b${n}.txt`, "b\n");
      await commitAll(repoDir, `B${n} main work`);
    }
    await git(repoDir, ["merge", "--no-ff", "-m", "M merge feature", "feat/hunk-line-staging"]);
    await git(repoDir, ["checkout", "feat/hunk-line-staging"]);
    await writeFile(repoDir, "f.txt", "f changed\n");

    await stubOpenRepoDialog(handle.app, repoDir);
    const w = handle.window;
    await w.getByRole("button", { name: "Open a repository", exact: true }).click();
    await w.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });
    const current = await w.evaluate(() => document.documentElement.dataset.theme);
    if (current !== theme) {
      await w.getByRole("button", { name: "More actions" }).click();
      await w.getByRole("menuitem", { name: /switch to (light|dark) theme/i }).click();
    }
    const canvas = w.locator("canvas.gh-graph-canvas");
    await canvas.waitFor();
    await w.waitForTimeout(500);
    await w.mouse.move(2, 2);
    const shot = path.join(shotDir, `${theme}-wip-above-merge.png`);
    await w.screenshot({ path: shot });

    // Rows: 0 WIP, 1 M, 2 F (HEAD; log order puts F right under M), ... Pixel-scan the feature lane (lane 1) in the
    // only row strictly between WIP and HEAD (M; F's own lane below HEAD is solid, so lower rows prove nothing): the dashed stroke must leave colored pixels in each of them.
    const box = (await canvas.boundingBox())!;
    const img = decodePng(shot);
    const dpr = img.width / (await w.evaluate(() => window.innerWidth));
    const x = Math.round((box.x + laneX(1)) * dpr);
    const bg = getPixel(img, Math.round((box.x + laneX(1) + 7) * dpr), Math.round((box.y + 3.5 * ROW_HEIGHT) * dpr));
    for (const row of [1]) {
      let diff = 0;
      for (let dy = 0; dy < ROW_HEIGHT * dpr; dy++) {
        const p = getPixel(img, x, Math.round((box.y + row * ROW_HEIGHT) * dpr) + dy);
        if (Math.abs(p.r - bg.r) + Math.abs(p.g - bg.g) + Math.abs(p.b - bg.b) > 60) diff++;
      }
      expect(diff, `row ${row} has dashed connector pixels on lane 1`).toBeGreaterThan(4);
    }
  });
}
