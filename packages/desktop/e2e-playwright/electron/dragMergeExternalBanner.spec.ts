// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * ROADMAP "still to check" (a): after a drag-triggered checkout+merge, the "History changed outside
 * GitHydra." banner must NOT show (the app caused both the checkout and the merge itself) — and a
 * genuinely external ref change must still show it. Real pointer events on a real BrowserWindow.
 */
import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { closeApp, launchGitHydra, removeUserDataDir, stubOpenRepoDialog, type LaunchedApp } from "../helpers/launchApp";
import { cleanup, commitAll, git, initRepo, writeFile } from "../../src/test/gitFixture";

const SHOT_DIR = path.join(process.cwd(), ".tmp-critique-screenshots", "drag-merge-banner");
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

async function openRepo(): Promise<Page> {
  const w = handle.window;
  await stubOpenRepoDialog(handle.app, repoDir);
  await w.getByRole("button", { name: "Open a repository", exact: true }).click();
  await w.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });
  return w;
}
const card = (w: Page, name: string) => w.locator(`li[data-ref-branch="${name}"]`);
async function dragCard(w: Page, from: string, onto: string) {
  const a = (await card(w, from).boundingBox())!;
  await w.mouse.move(a.x + 6, a.y + 5);
  await w.mouse.down();
  await w.mouse.move(a.x + 18, a.y + 17, { steps: 3 });
  const b = (await card(w, onto).boundingBox())!;
  await w.mouse.move(b.x + 6, b.y + 5, { steps: 8 });
  await w.mouse.up();
}
const banner = (w: Page) => w.getByText("History changed outside GitHydra.");

/** main checked out; `target` and `source` diverge from base so a real merge commit results. */
async function build(): Promise<void> {
  repoDir = await initRepo();
  await writeFile(repoDir, "a.txt", "base\n");
  await commitAll(repoDir, "Base commit");
  await git(repoDir, ["checkout", "-q", "-b", "target"]);
  await writeFile(repoDir, "t.txt", "t\n");
  await commitAll(repoDir, "Target commit");
  await git(repoDir, ["checkout", "-q", "-b", "source", "main"]);
  await writeFile(repoDir, "s.txt", "s\n");
  await commitAll(repoDir, "Source commit");
  await git(repoDir, ["checkout", "-q", "main"]);
}

test("drag-triggered checkout + merge (non-current target) leaves NO 'History changed outside GitHydra.' banner", async () => {
  await build();
  const w = await openRepo();
  await dragCard(w, "source", "target");
  await w.getByRole("menuitem", { name: "Merge source into target" }).click();
  await expect.poll(async () => (await git(repoDir, ["log", "-1", "--format=%s", "target"])).stdout, { timeout: 15_000 }).toMatch(/Merge/);
  expect((await git(repoDir, ["symbolic-ref", "--short", "HEAD"])).stdout.trim()).toBe("target");
  await w.waitForTimeout(4000); // give the watcher + confirming reads time to (wrongly) flag
  await w.screenshot({ path: path.join(SHOT_DIR, "after-drag-merge.png") });
  await expect(banner(w)).toHaveCount(0);
});

test("drag-triggered checkout + merge when the target is already current leaves NO banner", async () => {
  await build();
  await git(repoDir, ["checkout", "-q", "target"]);
  const w = await openRepo();
  await dragCard(w, "source", "target");
  await w.getByRole("menuitem", { name: "Merge source into target" }).click();
  await expect.poll(async () => (await git(repoDir, ["log", "-1", "--format=%s", "target"])).stdout, { timeout: 15_000 }).toMatch(/Merge/);
  await w.waitForTimeout(4000);
  await expect(banner(w)).toHaveCount(0);
});

test("a genuinely external ref change while idle DOES show the banner", async () => {
  await build();
  const w = await openRepo();
  await git(repoDir, ["branch", "external-made", "main"]);
  await git(repoDir, ["commit", "-q", "--allow-empty", "-m", "external commit"]);
  await expect(banner(w)).toBeVisible({ timeout: 15_000 });
  await w.screenshot({ path: path.join(SHOT_DIR, "external-change-banner.png") });
});

test("a genuinely external change made right AFTER a drag-merge still shows the banner", async () => {
  await build();
  const w = await openRepo();
  await dragCard(w, "source", "target");
  await w.getByRole("menuitem", { name: "Merge source into target" }).click();
  await expect.poll(async () => (await git(repoDir, ["log", "-1", "--format=%s", "target"])).stdout, { timeout: 15_000 }).toMatch(/Merge/);
  await w.waitForTimeout(3000);
  await git(repoDir, ["branch", "external-after", "main"]);
  await expect(banner(w)).toBeVisible({ timeout: 15_000 });
});
