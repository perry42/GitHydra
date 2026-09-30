// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * specs/auto-dismiss-status-messages.md: real-Electron check that a plain Fetch success banner
 * (a) is held by pointer hover past the 6s delay, and (b) disappears ~6s after the pointer leaves.
 * jsdom/fake timers can't prove the real window-focus/hover plumbing.
 */
import { test, expect } from "@playwright/test";
import { closeApp, launchGitHydra, openRepoThroughRealUi, removeUserDataDir, type LaunchedApp } from "../helpers/launchApp";
import { cleanup, commitAll, git, initRepo, writeFile } from "../../src/test/gitFixture";

let handle: LaunchedApp;
let localDir: string;
let bareDir: string;

test.afterEach(async () => {
  await closeApp(handle);
  await removeUserDataDir(handle.userDataDir);
  if (localDir) await cleanup(localDir);
  if (bareDir) await cleanup(bareDir);
});

test("fetch success banner: hover holds it past 6s; after leaving it disappears on its own", async () => {
  test.setTimeout(60_000);
  bareDir = await initRepo({ bare: true });
  localDir = await initRepo();
  await writeFile(localDir, "a.txt", "base\n");
  await commitAll(localDir, "base commit");
  await git(localDir, ["remote", "add", "origin", bareDir]);
  await git(localDir, ["push", "-q", "-u", "origin", "main"]);

  handle = await launchGitHydra();
  await openRepoThroughRealUi(handle, localDir);
  const w = handle.window;

  await w.getByRole("button", { name: /^fetch all remotes$/i }).click();
  const banner = w.locator(".gh-status-banner", { hasText: /origin: fetched successfully/i });
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await expect(banner).toHaveAttribute("role", "status");

  // Hover: still present well past the 6s delay.
  await banner.hover();
  await w.waitForTimeout(7500);
  await expect(banner).toBeVisible();
  await w.screenshot({ path: `${process.env.TEMP ?? "."}/autodismiss-hover.png` });

  // Leave: a full new delay, then it is removed without any user action.
  await w.mouse.move(5, 5);
  await w.waitForTimeout(4000);
  await expect(banner).toBeVisible();
  await expect(banner).toBeHidden({ timeout: 5000 });
});
