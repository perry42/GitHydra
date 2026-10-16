// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * specs/worktrees.md FR-644, AC 21 on the BUILT app with real git: a planted executable post-checkout hook that appends to a
 * sentinel file. Skip leaves no sentinel, Run creates it exactly once, a remembered Run skips the dialog next time, editing the
 * hook asks again, Cancel creates nothing, and a repo without a hook shows no dialog. The trust record is a main-process file
 * under userData, never renderer storage. One window per test.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { closeApp, launchGitHydra, removeUserDataDir, stubOpenRepoDialog, type LaunchedApp } from "../helpers/launchApp";
import { cleanup, commitAll, git, makeTempDir, writeFile } from "../../src/test/gitFixture";

let handle: LaunchedApp;
let parent: string | undefined;

test.afterEach(async () => {
  await closeApp(handle);
  await removeUserDataDir(handle.userDataDir);
  if (parent) await cleanup(parent);
  parent = undefined;
});

const exists = (p: string) => fs.stat(p).then(() => true, () => false);

async function makeRepo(withHook: boolean): Promise<{ repo: string; container: string; sentinel: string; hook: string }> {
  parent = await makeTempDir("pw-hook-");
  const repo = path.join(parent, "acme");
  await fs.mkdir(repo);
  await git(repo, ["init", "-q", "--initial-branch=main"]);
  await writeFile(repo, "a.txt", "base\n");
  await commitAll(repo, "Base commit");
  for (const b of ["skipme", "runme", "again", "edited", "plain"]) await git(repo, ["branch", b]);
  const sentinel = path.join(parent, "sentinel.txt");
  const hook = path.join(repo, ".git", "hooks", "post-checkout");
  if (withHook) await fs.writeFile(hook, `#!/bin/sh\nprintf 'x\\n' >> '${sentinel.replace(/\\/g, "/")}'\n`, { mode: 0o755 });
  return { repo, container: path.join(parent, "acme.worktrees"), sentinel, hook };
}

async function openApp(repo: string): Promise<Page> {
  handle = await launchGitHydra();
  const w = handle.window;
  await stubOpenRepoDialog(handle.app, repo);
  await w.getByRole("button", { name: "Open a repository", exact: true }).click();
  await w.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });
  const toggle = w.getByRole("button", { name: /^Worktrees/ });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  return w;
}

async function rightClick(w: Page, locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  await w.waitForTimeout(150);
  await locator.click({ button: "right" });
}

/** Branch menu -> Create worktree... -> Create worktree. Stays on the main tab ("Open after create" off). */
async function createFor(w: Page, branch: string): Promise<void> {
  await rightClick(w, w.getByRole("button", { name: new RegExp(`Jump to ${branch} in the commit graph`) }));
  await w.getByRole("menuitem", { name: /Create worktree/ }).click();
  const dialog = w.getByRole("dialog", { name: "Create worktree" });
  await expect(dialog.getByLabel("Folder")).toHaveValue(new RegExp(`acme\\.worktrees[\\\\/]${branch}$`));
  await dialog.getByLabel("Open after create").uncheck();
  await dialog.getByRole("button", { name: "Create worktree" }).click();
}

const hookDialog = (w: Page) => w.getByRole("alertdialog", { name: "Run the post-checkout hook?" });
const sentinelLines = async (p: string) => ((await fs.readFile(p, "utf8").catch(() => "")).match(/x/g) ?? []).length;

test("hook consent: Skip leaves no sentinel, Run runs it once, a remembered Run skips the dialog, an edit asks again, Cancel creates nothing", async () => {
  test.setTimeout(240_000);
  const { repo, container, sentinel, hook } = await makeRepo(true);
  const w = await openApp(repo);
  const foreign: string[] = [];
  w.on("request", (r) => {
    if (!/^(file|devtools|data|blob):/.test(r.url())) foreign.push(r.url());
  });

  // 1. Skip hook: the dialog explains, Cancel has the focus, nothing runs.
  await createFor(w, "skipme");
  const d1 = hookDialog(w);
  await expect(d1).toBeVisible();
  await expect(d1.getByRole("button", { name: "Cancel" })).toBeFocused();
  await expect(d1).toContainText("a program stored in the repository that git runs automatically after a checkout");
  await expect(d1).toContainText(hook);
  await expect(d1.getByLabel("Hook contents, read only")).toContainText("printf");
  await expect(d1.getByLabel("Remember my choice for this repository")).not.toBeChecked();
  await d1.getByRole("button", { name: "Skip hook" }).click();
  await expect(w.getByText('Created worktree "skipme".')).toBeVisible();
  await expect(w.getByText("The post-checkout hook was skipped.")).toBeVisible();
  expect(await exists(path.join(container, "skipme"))).toBe(true);
  expect(await exists(sentinel)).toBe(false);

  // 2. Run hook + Remember: the hook ran exactly once.
  await createFor(w, "runme");
  const d2 = hookDialog(w);
  await expect(d2).toBeVisible();
  await d2.getByLabel("Remember my choice for this repository").check();
  await d2.getByRole("button", { name: "Run hook" }).click();
  await expect(w.getByText('Created worktree "runme".')).toBeVisible();
  await expect(w.getByText("The post-checkout hook was run.")).toBeVisible();
  expect(await sentinelLines(sentinel)).toBe(1);
  // The choice is a main-process file under userData, bound to a fingerprint, with no global switch.
  const trust = JSON.parse(await fs.readFile(path.join(handle.userDataDir, "worktree-hook-trust.json"), "utf8")) as { repos: Record<string, { choice: string }> };
  expect(Object.values(trust.repos).map((r) => r.choice)).toEqual(["run"]);
  expect(await w.evaluate(() => JSON.stringify({ ...window.localStorage }))).not.toMatch(/hook.*trust|trust.*hook/i);

  // 3. The remembered Run: no dialog, the hook runs again (one more line).
  await createFor(w, "again");
  await expect(w.getByText('Created worktree "again".')).toBeVisible();
  await expect(hookDialog(w)).toHaveCount(0);
  expect(await sentinelLines(sentinel)).toBe(2);

  // 4. Editing the hook asks again; Cancel creates nothing and runs nothing.
  await fs.appendFile(hook, "# edited after the choice\n");
  await createFor(w, "edited");
  const d4 = hookDialog(w);
  await expect(d4).toBeVisible();
  await expect(d4.getByLabel("Hook contents, read only")).toContainText("edited after the choice");
  await d4.getByRole("button", { name: "Cancel" }).click();
  await expect(d4).toHaveCount(0);
  expect(await exists(path.join(container, "edited"))).toBe(false);
  expect((await git(repo, ["worktree", "list", "--porcelain"])).stdout).not.toContain("edited");
  expect(await sentinelLines(sentinel)).toBe(2);
  // The Create dialog is still there to adjust or cancel; Esc closes it.
  await expect(w.getByRole("dialog", { name: "Create worktree" })).toBeVisible();
  await w.keyboard.press("Escape");
  await expect(w.getByRole("dialog", { name: "Create worktree" })).toHaveCount(0);
  expect(foreign).toEqual([]);
});

test("a repository without a post-checkout hook shows no dialog and no hook line", async () => {
  const { repo, container } = await makeRepo(false);
  const w = await openApp(repo);
  await createFor(w, "plain");
  await expect(w.getByText('Created worktree "plain".')).toBeVisible();
  expect(await exists(path.join(container, "plain"))).toBe(true);
  await expect(hookDialog(w)).toHaveCount(0);
  await expect(w.getByText(/post-checkout hook/)).toHaveCount(0);
});
