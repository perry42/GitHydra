// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Visual + timing checks for the revised checkbox staging: unticked-row legibility in both themes, sticky hunk
 * headers mid-scroll, and a repo with 100 partly staged files (must show ONE row per file immediately, specs/
 * hunk-line-staging.md FR-482). Screenshots go to $HUNK_SHOTS for human review.
 */
import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closeApp, launchGitHydra, removeUserDataDir, stubOpenRepoDialog, type LaunchedApp } from "../helpers/launchApp";
import { cleanup, commitAll, git, initRepo, writeFile } from "../../src/test/gitFixture";

let handle: LaunchedApp;
let repoDir: string;
let shotDir: string;

test.beforeEach(async () => {
  handle = await launchGitHydra();
  shotDir = process.env.HUNK_SHOTS ?? (await fs.mkdtemp(path.join(os.tmpdir(), "githydra-pw-hunk-")));
  await fs.mkdir(shotDir, { recursive: true });
});
test.afterEach(async () => {
  await closeApp(handle);
  await removeUserDataDir(handle.userDataDir);
  if (repoDir) await cleanup(repoDir);
});

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line${String(i + 1).padStart(2, "0")}`);
const join = (ls: string[]) => ls.join("\n") + "\n";

async function openRepoInApp(): Promise<Page> {
  await stubOpenRepoDialog(handle.app, repoDir);
  await handle.window.getByRole("button", { name: "Open a repository", exact: true }).click();
  await handle.window.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });
  await handle.window.getByRole("button", { name: /^changes/i }).click();
  await handle.window.getByRole("button", { name: "Stage all", exact: true }).waitFor();
  return handle.window;
}
async function setTheme(w: Page, theme: "light" | "dark") {
  const current = await w.evaluate(() => document.documentElement.dataset.theme);
  if (current === theme) return;
  await w.getByRole("button", { name: "More actions" }).click();
  await w.getByRole("menuitem", { name: /switch to (light|dark) theme/i }).click();
  await expect.poll(() => w.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
}
const lineBox = (w: Page, label: string) => w.getByRole("checkbox", { name: new RegExp(`^${label}(:|$)`) });

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: unticked vs ticked rows and sticky headers mid-scroll`, async () => {
    repoDir = await initRepo();
    const base = lines(120);
    await writeFile(repoDir, "f.txt", join(base));
    await commitAll(repoDir, "base");
    const edited = [...base];
    for (let i = 5; i <= 9; i++) edited[i - 1] = `CHANGED${i}`;
    for (let i = 40; i <= 70; i++) edited[i - 1] = `CHANGED${i}`;
    edited.splice(100, 1); // a pure deletion hunk
    await writeFile(repoDir, "f.txt", join(edited));
    const w = await openRepoInApp();
    await setTheme(w, theme);
    await w.locator("li.gh-changes-panel__file", { hasText: "f.txt" }).locator(".gh-changes-panel__file-label").click();
    await lineBox(w, "Added line 6").waitFor();
    // tick a few lines so ticked and unticked sit side by side
    await lineBox(w, "Added line 6").locator(".gh-diff-view__gutter--check").click();
    await lineBox(w, "Removed line 7").locator(".gh-diff-view__gutter--check").click();
    await expect(lineBox(w, "Added line 6")).toHaveAttribute("aria-checked", "true");
    await w.screenshot({ path: path.join(shotDir, `${theme}-10-ticked-vs-unticked.png`) });
    // sticky header mid-scroll inside the big hunk
    await lineBox(w, "Added line 55").evaluate((el) => el.scrollIntoView({ block: "center" }));
    await w.waitForTimeout(200);
    await w.screenshot({ path: path.join(shotDir, `${theme}-11-sticky-mid-scroll.png`) });
    // the boundary between two hunks right under a header (previous hunk's last row half clipped)
    const hdr = w.locator('.gh-diff-view__hunk-header[data-hunk-header="2"]');
    await hdr.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await w.evaluate(() => {
      const sc = document.querySelector(".gh-diff-view__hunks") as HTMLElement | null;
      if (sc) sc.scrollTop -= 10;
    });
    await w.waitForTimeout(200);
    await w.screenshot({ path: path.join(shotDir, `${theme}-12-sticky-boundary.png`) });
  });
}

test("100 partly staged files: one row each immediately after open, no double rows, no later reshuffle", async () => {
  test.setTimeout(240_000);
  repoDir = await initRepo();
  for (let i = 0; i < 100; i++) await writeFile(repoDir, `p${String(i).padStart(3, "0")}.txt`, join(lines(20)));
  await commitAll(repoDir, "base");
  for (let i = 0; i < 100; i++) {
    const f = `p${String(i).padStart(3, "0")}.txt`;
    const ls = lines(20);
    ls[2] = "A";
    await writeFile(repoDir, f, join(ls));
  }
  await git(repoDir, ["add", "-A"]);
  for (let i = 0; i < 100; i++) {
    const f = `p${String(i).padStart(3, "0")}.txt`;
    const ls = lines(20);
    ls[2] = "A";
    ls[15] = "B";
    await writeFile(repoDir, f, join(ls));
  }
  await stubOpenRepoDialog(handle.app, repoDir);
  await handle.window.getByRole("button", { name: "Open a repository", exact: true }).click();
  const w = handle.window;
  await w.getByRole("button", { name: /^changes/i }).click();
  const stagedHeading = w.locator("section.gh-changes-panel__section h3", { hasText: /^Staged/ });
  const unstagedHeading = w.locator("section.gh-changes-panel__section h3", { hasText: /^Unstaged/ });
  await expect(unstagedHeading).toContainText("(100)", { timeout: 30_000 });
  const t0 = Date.now();
  // First frame with a list: Staged must already be empty (collapsed), never 100 then shrinking.
  const stagedText = await stagedHeading.innerText();
  console.log("staged heading at first list frame:", JSON.stringify(stagedText), "after", Date.now() - t0, "ms");
  expect(stagedText).toMatch(/\(0\)/);
  const seen = new Set<string>();
  for (let i = 0; i < 20; i++) {
    seen.add(`${await stagedHeading.innerText()}|${await unstagedHeading.innerText()}`);
    await w.waitForTimeout(500);
  }
  console.log("headings observed over 10 s:", JSON.stringify([...seen]));
  expect(seen.size).toBe(1);
  await w.screenshot({ path: path.join(shotDir, "light-20-100-partly-staged.png") });
  await setTheme(w, "dark");
  await w.screenshot({ path: path.join(shotDir, "dark-20-100-partly-staged.png") });
});
