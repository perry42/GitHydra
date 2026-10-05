// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Real-Electron smoke: the built renderer must mount (no uncaught error at module evaluation).
 * Regression guard for git-core/src/ignore.ts's top-level `Buffer.from(...)` being bundled into the
 * sandboxed renderer through the value imports of "@githydra/git-core" (classifyGitNetworkError etc.).
 */
import { test, expect } from "@playwright/test";
import { closeApp, launchGitHydra, removeUserDataDir } from "../helpers/launchApp";

test("the built renderer mounts without a page error (no Node globals such as Buffer at load)", async () => {
  const h = await launchGitHydra();
  try {
    const errors: string[] = [];
    h.window.on("pageerror", (e) => errors.push(e.message));
    await h.window.reload();
    await expect(h.window.getByRole("button", { name: "Open a repository", exact: true })).toBeVisible({ timeout: 10_000 });
    expect(errors).toEqual([]);
  } finally {
    await closeApp(h);
    await removeUserDataDir(h.userDataDir);
  }
});
