// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * test-agent verification (fix/clone-mkdir-versioncheck-fsmonitor-audit): the ONE thing the
 * builder's own unit tests (packages/git-core/tests/clone.test.ts) structurally can't prove —
 * that cloning into a destination whose parent folders don't exist yet actually works end-to-end
 * through the REAL running app (real contextBridge/ipcMain transport, a real BrowserWindow, real
 * `git clone` child process), not just through git-core's own `clone()` called directly in a unit
 * test. Mirrors `ipcTransport.spec.ts`'s own launch/teardown convention exactly.
 *
 * Exercises the exact bug scenario from the fix's own commit message: a destination like
 * `<tempdir>/does-not-exist-yet/nested/my-clone` where NEITHER intermediate folder exists yet.
 */
import { test, expect } from "@playwright/test";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { closeApp, launchGitHydra, removeUserDataDir, type LaunchedApp } from "../helpers/launchApp";
import { cleanup, commitAll, git, initRepo, makeTempDir, writeFile } from "../../src/test/gitFixture";

let handle: LaunchedApp;
const dirs: string[] = [];

test.beforeEach(async () => {
  handle = await launchGitHydra();
});

test.afterEach(async () => {
  await closeApp(handle);
  await removeUserDataDir(handle.userDataDir);
  while (dirs.length) {
    const dir = dirs.pop()!;
    await cleanup(dir).catch(() => {});
  }
});

/** A real local bare "remote" seeded with one commit, mirroring `App.clone.e2e.test.tsx`'s own
 * `setupRemote()` (jsdom suite) — this spec needs the identical fixture shape against the REAL
 * Electron transport instead. */
async function setupRemote(): Promise<{ remoteDir: string; headSha: string }> {
  const remoteDir = await initRepo({ bare: true });
  dirs.push(remoteDir);
  const seedDir = await initRepo();
  dirs.push(seedDir);
  await writeFile(seedDir, "a.txt", "line1\nline2\nline3\n");
  const headSha = await commitAll(seedDir, "base commit");
  await git(seedDir, ["remote", "add", "origin", remoteDir]);
  await git(seedDir, ["push", "-q", "origin", "main"]);
  return { remoteDir, headSha };
}

test(
  "clones into a destination with several missing intermediate parent folders through the real UI, succeeding and opening a new tab (real Electron transport)",
  async () => {
    const { remoteDir, headSha } = await setupRemote();
    const parentDir = await makeTempDir();
    dirs.push(parentDir);
    // The exact bug scenario: neither "does-not-exist-yet" nor "nested" exist yet.
    const destination = path.join(parentDir, "does-not-exist-yet", "nested", "my-clone");
    await expect(fs.access(path.join(parentDir, "does-not-exist-yet"))).rejects.toThrow();

    await handle.window.getByRole("button", { name: "Clone a repository" }).click();
    const dialog = handle.window.getByRole("dialog", { name: /clone a repository/i });
    await expect(dialog).toBeVisible();

    await dialog.getByLabel(/repository url/i).fill(remoteDir);
    await dialog.getByLabel(/destination folder/i).fill(destination);
    await dialog.getByRole("button", { name: /^clone$/i }).click();

    // The dialog closes and the real cloned repo opens as a new tab — same "ready" signal
    // `openRepoThroughRealUi` uses elsewhere in this suite.
    await handle.window.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 20_000 });
    await expect(dialog).not.toBeVisible();

    // A real working-tree checkout genuinely exists on disk, through every created intermediate
    // level, proving `{recursive: true}` really did create the whole missing subtree and `git
    // clone` really did run against it.
    const { stdout } = await git(destination, ["rev-parse", "HEAD"]);
    expect(stdout.trim()).toBe(headSha);
    const checkedOutFile = (await fs.readFile(path.join(destination, "a.txt"), "utf8")).replace(/\r\n/g, "\n");
    expect(checkedOutFile).toBe("line1\nline2\nline3\n");
  },
  60_000,
);
