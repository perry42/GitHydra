// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Real-Electron verification of ref-chip drag-to-merge with REAL pointer events (jsdom stubs
 * `elementFromPoint`; this doesn't): a descendant branch chip dropped on a branch chip collapsed
 * behind "+1" (same commit as another branch) opens the popover on hover and offers Merge.
 */
import { test, expect } from "@playwright/test";
import { closeApp, launchGitHydra, removeUserDataDir, stubOpenRepoDialog, type LaunchedApp } from "../helpers/launchApp";
import { cleanup, commitAll, git, initRepo, writeFile } from "../../src/test/gitFixture";

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

test("dragging feat onto main inside the +1 popover offers an enabled fast-forward merge; chore onto main is up to date", async () => {
  repoDir = await initRepo();
  await writeFile(repoDir, "a.txt", "base\n");
  await commitAll(repoDir, "Base commit");
  await git(repoDir, ["branch", "chore"]);
  await git(repoDir, ["checkout", "-b", "feat"]);
  await writeFile(repoDir, "a.txt", "second\n");
  await commitAll(repoDir, "Feature commit");

  await stubOpenRepoDialog(handle.app, repoDir);
  await handle.window.getByRole("button", { name: "Open a repository", exact: true }).click();
  await handle.window.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });
  const w = handle.window;

  const baseRow = w.locator('[role="option"]', { hasText: "Base commit" });
  const more = baseRow.locator(".gh-commit-row__refgutter-more");
  await expect(more).toBeVisible();

  async function dragFrom(branch: string) {
    const chip = w.locator(`.gh-commit-row__refgutter [data-ref-branch="${branch}"]`).first();
    const cb = (await chip.boundingBox())!;
    const mb = (await more.boundingBox())!;
    await w.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
    await w.mouse.down();
    await w.mouse.move(cb.x + cb.width / 2 + 10, cb.y + cb.height / 2 + 10, { steps: 3 });
    await w.mouse.move(mb.x + mb.width / 2, mb.y + mb.height / 2, { steps: 5 });
    // Popover auto-opens after the ~400ms hover.
    const target = w.locator('.gh-context-menu [data-ref-branch="main"]');
    await expect(target).toBeVisible({ timeout: 3000 });
    const tb = (await target.boundingBox())!;
    await w.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2, { steps: 6 });
    await expect(target).toHaveClass(/gh-context-menu__item--drop-active/);
    await w.screenshot({ path: `${process.env.TEMP ?? "."}/chipdrag-${branch}.png` });
    await w.mouse.up();
  }

  await dragFrom("feat");
  const ff = w.getByRole("menuitem", { name: "Merge feat into main" });
  await expect(ff).toBeVisible();
  await expect(ff).toBeEnabled();
  await w.keyboard.press("Escape");

  await dragFrom("chore");
  const same = w.getByRole("menuitem", { name: "Merge chore into main" });
  await expect(same).toBeVisible();
  await expect(same).toBeDisabled();
  await expect(same).toHaveAttribute("title", "Already up to date");
});
