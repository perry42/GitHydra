// SPDX-License-Identifier: GPL-3.0-or-later
/** Known pre-existing bug confirmation: unstaging in a repo with an unborn HEAD (no commits yet). Left red until fixed. */
import { test, expect } from "@playwright/test";
import { closeApp, removeUserDataDir, type LaunchedApp } from "../helpers/launchApp";
import { launchApp, openChanges, rowBtn } from "../helpers/changesHelpers";
import { cleanup, git, initRepo, writeFile } from "../../src/test/gitFixture";

let h: LaunchedApp;
const dirs: string[] = [];
test.beforeEach(async () => {
  h = await launchApp();
});
test.afterEach(async () => {
  await closeApp(h);
  await removeUserDataDir(h.userDataDir);
  while (dirs.length) await cleanup(dirs.pop()!);
});

async function unbornRepo(): Promise<string> {
  const d = await initRepo();
  dirs.push(d);
  await writeFile(d, "a.txt", "a\n");
  await writeFile(d, "b.txt", "b\n");
  await git(d, ["add", "a.txt", "b.txt"]);
  return d;
}

test("unborn HEAD: single-row Unstage returns the file to Untracked", async () => {
  const d = await unbornRepo();
  await openChanges(h, d);
  await rowBtn(h.window, "staged", "a.txt").locator("xpath=ancestor::li[1]").hover();
  await rowBtn(h.window, "staged", "a.txt").locator("xpath=ancestor::li[1]").getByRole("button", { name: "Unstage" }).click();
  await expect.poll(async () => (await git(d, ["status", "--porcelain"])).stdout, { timeout: 10_000 }).toContain("?? a.txt");
});

test("unborn HEAD: bulk Unstage returns both files to Untracked", async () => {
  const d = await unbornRepo();
  await openChanges(h, d);
  await rowBtn(h.window, "staged", "a.txt").click();
  await rowBtn(h.window, "staged", "b.txt").click({ modifiers: ["Control"] });
  // Stage/Unstage live in the section header, not the bulk bar (specs/ignore-and-multiselect.md FR-518).
  await h.window.getByRole("button", { name: /^unstage 2 selected/i }).click();
  await expect.poll(async () => (await git(d, ["status", "--porcelain"])).stdout, { timeout: 10_000 }).toBe("?? a.txt\n?? b.txt\n");
});
