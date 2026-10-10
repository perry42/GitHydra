// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Real-Electron check of specs/mid-merge-landing.md (FR-577..FR-583) against real merge and cherry-pick conflicts:
 * auto-open once, banner Resolve button, resolved state, tab badge/title, and the working-directory row never
 * overlapping the lane art. Screenshots go to $MML_SHOTS (or the OS temp dir).
 */
import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closeApp, launchGitHydra, removeUserDataDir, stubOpenRepoDialog, type LaunchedApp } from "../helpers/launchApp";
import { cleanup, commitAll, git, initRepo } from "../../src/test/gitFixture";
import { decodePng, getPixel } from "../helpers/pngPixels";
import { ROW_HEIGHT, laneX } from "../../src/components/CommitGraph/graphGeometry";

let handle: LaunchedApp;
let repoDir: string;
let shotDir: string;

test.beforeEach(async () => {
  handle = await launchGitHydra();
  shotDir = process.env.MML_SHOTS ?? (await fs.mkdtemp(path.join(os.tmpdir(), "githydra-pw-mml-")));
  await fs.mkdir(shotDir, { recursive: true });
});
test.afterEach(async () => {
  await closeApp(handle);
  await removeUserDataDir(handle.userDataDir);
  if (repoDir) await cleanup(repoDir);
});

const put = (rel: string, data: string) => fs.writeFile(path.join(repoDir, rel), data);

async function conflictRepo(kind: "merge" | "cherry-pick"): Promise<void> {
  repoDir = await initRepo();
  await put("a.txt", "one\ntwo\nthree\n");
  await put("b.txt", "one\ntwo\nthree\n");
  await commitAll(repoDir, "base");
  await git(repoDir, ["checkout", "-q", "-b", "feature"]);
  await put("a.txt", "one\nfeature\nthree\n");
  await put("b.txt", "one\nfeature\nthree\n");
  await commitAll(repoDir, "feature change");
  await git(repoDir, ["checkout", "-q", "main"]);
  await put("a.txt", "one\nmain\nthree\n");
  await put("b.txt", "one\nmain\nthree\n");
  await commitAll(repoDir, "main change");
  await put("c.txt", "untracked\n");
  if (kind === "merge") await git(repoDir, ["merge", "feature"]).catch(() => {});
  else await git(repoDir, ["cherry-pick", "feature"]).catch(() => {});
}

async function setTheme(w: Page, theme: "light" | "dark") {
  const current = await w.evaluate(() => document.documentElement.dataset.theme);
  if (current === theme) return;
  await w.getByRole("button", { name: "More actions" }).click();
  await w.getByRole("menuitem", { name: /switch to (light|dark) theme/i }).click();
  await expect.poll(() => w.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
}

async function openRepo(): Promise<Page> {
  const w = handle.window;
  await stubOpenRepoDialog(handle.app, repoDir);
  await w.getByRole("button", { name: "Open a repository", exact: true }).click();
  await w.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });
  return w;
}

const drawer = (w: Page) => w.locator(".gh-changes-panel").first();
const banner = (w: Page) => w.getByRole("region", { name: /in progress$/ });
const wipRow = (w: Page) => w.locator(".gh-commit-row--conflict");

const intersects = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** FR-579: label, counts, icon and the lane art (node ring + dashed connector) occupy disjoint boxes, and the count is never clipped. */
async function expectNoOverlap(w: Page, label: string) {
  const row = wipRow(w);
  await expect(row).toBeVisible();
  await expect(row.locator(".gh-commit-row__conflict-label")).toContainText(label.split(" ")[0]!);
  const canvas = (await w.locator("canvas.gh-graph-canvas").boundingBox())!;
  const icon = (await row.locator(".gh-commit-row__conflict-icon").boundingBox())!;
  const lbl = (await row.locator(".gh-commit-row__conflict-label").boundingBox())!;
  const cnt = (await row.locator(".gh-commit-row__conflict-count").boundingBox())!;
  const rowBox = (await row.boundingBox())!;
  const lane = { x: canvas.x, y: rowBox.y, width: canvas.width, height: rowBox.height };
  expect(intersects(icon, lane), "icon vs lane art").toBe(false);
  expect(intersects(lbl, lane), "label vs lane art / connector").toBe(false);
  expect(intersects(cnt, lane), "count vs lane art / connector").toBe(false);
  expect(intersects(lbl, cnt), "label vs count").toBe(false);
  const others = row.locator(".gh-commit-row__conflict-others");
  if (await others.count()) {
    const o = await others.boundingBox();
    if (o && o.width > 0) {
      expect(intersects(lbl, o), "label vs others").toBe(false);
      expect(intersects(cnt, o), "count vs others").toBe(false);
    }
  }
  const clipped = await row.locator(".gh-commit-row__conflict-count").evaluate((e) => e.scrollWidth > e.clientWidth + 1);
  expect(clipped, "conflict count is never truncated").toBe(false);
  await expect(row).toHaveAttribute("title", /in progress/);
}

/** Mid-merge the WIP node also connects to MERGE_HEAD: dashed stroke on the feature lane (1) between HEAD's row and the tip (row 2). */
async function expectSecondConnector(w: Page, shot: string) {
  const box = (await w.locator("canvas.gh-graph-canvas").boundingBox())!;
  const img = decodePng(shot);
  const dpr = img.width / (await w.evaluate(() => window.innerWidth));
  const x = Math.round((box.x + laneX(1)) * dpr);
  const bg = getPixel(img, Math.round((box.x + laneX(1) + 7) * dpr), Math.round((box.y + 1.8 * ROW_HEIGHT) * dpr));
  let diff = 0;
  for (let y = Math.round((box.y + 1.55 * ROW_HEIGHT) * dpr); y < Math.round((box.y + 2.2 * ROW_HEIGHT) * dpr); y++) {
    const p = getPixel(img, x, y);
    if (Math.abs(p.r - bg.r) + Math.abs(p.g - bg.g) + Math.abs(p.b - bg.b) > 60) diff++;
  }
  expect(diff, "dashed connector from the WIP node to the incoming branch tip").toBeGreaterThan(3);
}

for (const kind of ["merge", "cherry-pick"] as const) {
  test(`${kind}: auto-opens once, banner Resolve reopens, row/tab/title signal, no overlap in both themes and widths`, async () => {
    await conflictRepo(kind);
    const w = await openRepo();
    const label = kind === "merge" ? "Merge in progress" : "Cherry-pick in progress";

    // FR-580: landing opens Changes on the first conflict without any click.
    await expect(drawer(w)).toBeVisible({ timeout: 15_000 });
    await expect(banner(w)).toContainText(label);
    await expect(banner(w)).toContainText("2 files have conflicts");
    await expect(banner(w).getByRole("button", { name: /^continue$/i })).toBeDisabled();
    // FR-582
    await expect(w.getByRole("tab", { name: /2 conflicts to resolve/ })).toBeVisible();
    await expect.poll(() => w.title()).toMatch(/— (Merging|Cherry-picking) \(2 conflicts\)$/);

    // Closing the drawer sticks: a refresh (new open sequence, same operation) must not reopen it.
    await w.getByRole("button", { name: /^changes/i }).click();
    await expect(drawer(w)).toHaveCount(0);
    await w.getByRole("button", { name: "Refresh" }).first().click();
    await w.waitForTimeout(1200);
    await expect(drawer(w)).toHaveCount(0);

    for (const theme of ["dark", "light"] as const) {
      await setTheme(w, theme);
      for (const [width, name] of [[1400, "default"], [900, "narrow"]] as const) {
        await handle.app.evaluate(({ BrowserWindow }, ww) => BrowserWindow.getAllWindows()[0]!.setSize(ww, 800), width);
        await w.waitForTimeout(500);
        await expectNoOverlap(w, label);
        const shotPath = path.join(shotDir, `${kind}-${theme}-${name}.png`);
        await w.mouse.move(2, 2);
        await w.screenshot({ path: shotPath });
        if (kind === "merge" && name === "default") await expectSecondConnector(w, shotPath);
      }
    }
    await handle.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1400, 800));

    // FR-577: the banner's primary button reopens Changes (on the first conflicted file).
    await banner(w).getByRole("button", { name: "Resolve conflicts (2)" }).click();
    await expect(drawer(w)).toBeVisible();
    await expect(drawer(w)).toContainText("a.txt");

    // FR-578: resolve both files in the real UI-independent way, then the banner turns calm and green.
    await put("a.txt", "one\nresolved\nthree\n");
    await put("b.txt", "one\nresolved\nthree\n");
    await git(repoDir, ["add", "a.txt", "b.txt"]);
    await w.getByRole("button", { name: "Refresh" }).first().click();
    await expect(banner(w)).toContainText("All conflicts resolved", { timeout: 15_000 });
    await expect(banner(w).getByRole("button", { name: `Continue ${kind}` })).toBeEnabled();
    await expect(w.getByRole("tab", { name: /conflicts? to resolve/ })).toHaveCount(0);
    await expect.poll(() => w.title()).toBe("GitHydra");
    for (const theme of ["dark", "light"] as const) {
      await setTheme(w, theme);
      await w.waitForTimeout(300);
      await w.screenshot({ path: path.join(shotDir, `${kind}-${theme}-resolved.png`) });
    }
  });
}
