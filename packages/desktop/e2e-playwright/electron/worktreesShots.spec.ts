// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Visual record for specs/worktrees.md slice 2: the Worktrees section (linked, locked, missing, detached, tab flag), the row
 * menus, the Create dialog (plain and with a validation message), the three remove confirms, the clean-up confirm and the
 * post-create banners, each in light and dark at 1400x900 (the dialog also at 1280x800). Files go to $WORKTREE_SHOTS (never
 * the repo). No assertions beyond "the scene reached its state".
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closeApp, launchGitHydra, removeUserDataDir, stubOpenRepoDialog, type LaunchedApp } from "../helpers/launchApp";
import { cleanup, commitAll, git, makeTempDir, writeFile } from "../../src/test/gitFixture";

let handle: LaunchedApp;
let parent: string | undefined;

test.afterEach(async () => {
  await closeApp(handle);
  await removeUserDataDir(handle.userDataDir);
  if (parent) await cleanup(parent);
});

const THEMES = ["light", "dark"] as const;

async function rightClick(w: Page, locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  await w.waitForTimeout(150);
  await locator.click({ button: "right" });
}

test("worktree screenshots", async () => {
  test.setTimeout(300_000);
  const shots = process.env.WORKTREE_SHOTS ?? (await fs.mkdtemp(path.join(os.tmpdir(), "githydra-pw-wtshots-")));
  await fs.mkdir(shots, { recursive: true });

  parent = await makeTempDir("pw-wtshots-");
  const repo = path.join(parent, "acme");
  const container = path.join(parent, "acme.worktrees");
  await fs.mkdir(repo);
  await git(repo, ["init", "-q", "--initial-branch=main"]);
  await writeFile(repo, "package.json", '{ "name": "acme" }\n');
  await writeFile(repo, "package-lock.json", "{}\n");
  await writeFile(repo, ".gitmodules", '[submodule "vendor/lib"]\n\tpath = vendor/lib\n\turl = https://example.com/lib.git\n');
  await writeFile(repo, "a.txt", "base\n");
  await commitAll(repo, "Base commit");
  await git(repo, ["branch", "free"]);
  await git(repo, ["branch", "release/2.4"]);
  await git(repo, ["worktree", "add", "-q", "-b", "feature/search-debounce", path.join(container, "feature-search-debounce")]);
  await git(repo, ["worktree", "add", "-q", "-b", "hotfix", path.join(container, "hotfix")]);
  await git(repo, ["worktree", "lock", "--reason", "on the usb stick", path.join(container, "hotfix")]);
  await git(repo, ["worktree", "add", "-q", "-b", "old-experiment", path.join(container, "old-experiment")]);
  await fs.rm(path.join(container, "old-experiment"), { recursive: true, force: true });
  await git(repo, ["worktree", "add", "-q", "--detach", path.join(container, "review"), "HEAD"]);
  const wip = path.join(container, "wip");
  await git(repo, ["worktree", "add", "-q", "-b", "wip", wip]);
  await writeFile(wip, "n.txt", "work\n");
  await commitAll(wip, "Unmerged work");
  const dirty = path.join(container, "scratch");
  await git(repo, ["worktree", "add", "-q", "-b", "scratch", dirty]);
  for (let i = 0; i < 34; i++) await writeFile(dirty, `tmp/f${i}.txt`, "x\n");
  // A hook that GitHydra must not run (FR-644); it only produces the "not run" banner.
  await fs.writeFile(path.join(repo, ".git", "hooks", "post-checkout"), "#!/bin/sh\necho hook\n", { mode: 0o755 });

  handle = await launchGitHydra();
  const w = handle.window;
  await w.evaluate(() => window.localStorage.setItem("githydra:layout:worktreesCollapsed", "0"));
  await handle.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((b) => b.setSize(1400, 900)));
  await stubOpenRepoDialog(handle.app, repo);
  await w.getByRole("button", { name: "Open a repository", exact: true }).click();
  await w.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });
  await expect(w.getByRole("heading", { name: /^Worktrees \(/ })).toBeVisible();
  // The sidebar is the star of the first shots: widen it a little so paths wrap less.
  const shoot = async (name: string, target?: Locator) => {
    for (const theme of THEMES) {
      await w.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      await w.waitForTimeout(250);
      const file = path.join(shots, `${name}-${theme}.png`);
      if (target) await target.screenshot({ path: file });
      else await w.screenshot({ path: file });
    }
  };

  // 1. The section with every state, a tab opened for one worktree.
  await w.getByRole("listitem", { name: /Worktree feature\/search-debounce, linked/ }).dblclick();
  await expect(w.getByRole("tab")).toHaveCount(2);
  await w.getByRole("tab", { name: /main worktree/ }).click();
  await expect(w.getByRole("tab", { selected: true })).toContainText("main");
  await expect(w.getByRole("button", { name: /current branch main/ })).toBeVisible();
  await w.waitForTimeout(500);
  await shoot("01-window-worktrees-section");

  // 2. Row menus: locked (Remove disabled with its reason) and missing (Open disabled, Forget missing worktree offered).
  await rightClick(w, w.getByRole("listitem", { name: /Worktree hotfix, linked, locked/ }));
  await expect(w.getByRole("menu")).toBeVisible();
  await shoot("02-menu-locked", w.getByRole("menu"));
  await w.keyboard.press("Escape");
  await w.waitForTimeout(200);
  await rightClick(w, w.getByRole("listitem", { name: /Worktree old-experiment, linked, missing/ }));
  await expect(w.getByRole("menu")).toBeVisible();
  await shoot("03-menu-missing", w.getByRole("menu"));
  await w.getByRole("menuitem", { name: "Forget missing worktree" }).click();
  await expect(w.getByRole("alertdialog")).toBeVisible();
  await shoot("04-cleanup-confirm", w.getByRole("alertdialog"));
  await w.getByRole("button", { name: "Cancel" }).click();

  // 3. Branch card menu with exactly one worktree item.
  await rightClick(w, w.getByRole("button", { name: /Jump to free in the commit graph/ }));
  await expect(w.getByRole("menu")).toBeVisible();
  await shoot("05-menu-branch", w.getByRole("menu"));

  // 4. Create dialog: plain, then with a validation message (a folder that is not empty).
  await w.getByRole("menuitem", { name: /Create worktree/ }).click();
  const dialog = w.getByRole("dialog", { name: "Create worktree" });
  await expect(dialog.getByLabel("Folder")).toHaveValue(/acme\.worktrees[\\/]free$/);
  await shoot("06-create-dialog");
  await dialog.getByLabel("Folder").fill(path.join(container, "hotfix"));
  await dialog.getByRole("button", { name: "Create worktree" }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await shoot("07-create-dialog-error");
  await handle.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((b) => b.setSize(1280, 800)));
  await w.waitForTimeout(300);
  await shoot("08-create-dialog-1280x800");
  await handle.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((b) => b.setSize(1400, 900)));
  await dialog.getByLabel("Folder").fill(path.join(container, "free"));
  await dialog.getByRole("button", { name: "Create worktree" }).click();

  // 5. Post-create banners: created, dependency reminder, submodules, hook not run. Opens as a tab; back to main.
  await expect(w.getByText('Created worktree "free".')).toBeVisible();
  await expect(w.getByText(/package\.json found/)).toBeVisible();
  await expect(w.getByText(/post-checkout hook/)).toBeVisible();
  await w.getByRole("tab", { name: /main worktree/ }).click();
  await expect(w.getByRole("tab", { selected: true })).toContainText("main");
  await expect(w.getByText(/Loading (worktrees|branches)/)).toHaveCount(0);
  await expect(w.getByText(/package\.json found/)).toBeVisible();
  await w.waitForTimeout(500);
  await shoot("09-banners-after-create", w.getByRole("complementary", { name: "Branches" }));
  while ((await w.getByRole("button", { name: "Dismiss", exact: true }).count()) > 0) await w.getByRole("button", { name: "Dismiss", exact: true }).first().click();

  // 6. Remove confirms: clean, dirty with the typed count, merged-vs-unmerged downgrade.
  await rightClick(w, w.getByRole("listitem", { name: /Worktree free, linked/ }));
  await w.getByRole("menuitem", { name: "Remove this worktree" }).click();
  const confirm = w.getByRole("alertdialog");
  await expect(confirm.getByRole("button", { name: "Remove worktree" })).toBeEnabled();
  await shoot("10-remove-clean", confirm);
  await confirm.getByRole("button", { name: "Cancel" }).click();

  await rightClick(w, w.getByRole("listitem", { name: /Worktree scratch, linked/ }));
  await w.getByRole("menuitem", { name: "Remove this worktree" }).click();
  await expect(confirm.getByLabel(/Type 34 to confirm/)).toBeVisible();
  await shoot("11-remove-dirty-typed", confirm);
  await confirm.getByRole("button", { name: "Cancel" }).click();

  await rightClick(w, w.getByRole("listitem", { name: /Worktree wip, linked/ }));
  await w.getByRole("menuitem", { name: "Remove worktree and delete branch" }).click();
  await expect(confirm.getByText(/will be kept/)).toBeVisible();
  await shoot("12-remove-unmerged-kept", confirm);
  await confirm.getByRole("button", { name: "Remove worktree" }).click();
  await expect(w.getByText(/was kept because it has commits that are not merged/)).toBeVisible();
  await w.waitForTimeout(400);
  await shoot("13-banner-kept-branch", w.getByRole("complementary", { name: "Branches" }));
});
