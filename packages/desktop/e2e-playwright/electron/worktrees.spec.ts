// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * specs/worktrees.md slice 2 on the BUILT app with real git: create from a branch, list, open as a tab, remove; a dirty
 * remove with the typed count; the "one worktree item" menus; the kept-branch outcome; no request outside file:/devtools:
 * (FR-637). One window per test, closed in afterEach; every fixture lives under one unique parent folder that is removed with
 * the sibling `acme.worktrees` folder the default path creates.
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

async function makeRepo(): Promise<{ repo: string; container: string }> {
  parent = await makeTempDir("pw-wt-");
  const repo = path.join(parent, "acme");
  await fs.mkdir(repo);
  await git(repo, ["init", "-q", "--initial-branch=main"]);
  await writeFile(repo, "a.txt", "base\n");
  await commitAll(repo, "Base commit");
  await git(repo, ["branch", "feature/search"]);
  await git(repo, ["branch", "free"]);
  return { repo, container: path.join(parent, "acme.worktrees") };
}

async function openApp(repo: string): Promise<Page> {
  handle = await launchGitHydra();
  const w = handle.window;
  await stubOpenRepoDialog(handle.app, repo);
  await w.getByRole("button", { name: "Open a repository", exact: true }).click();
  await w.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });
  return w;
}

async function expandWorktrees(w: Page) {
  const toggle = w.getByRole("button", { name: /^Worktrees/ });
  // The section auto-collapses while the list still loads (count <= 1), then auto-expands: a click made in between would collapse
  // it again. Retry until it is really open.
  await expect(async () => {
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true", { timeout: 1000 });
  }).toPass({ timeout: 15_000 });
}


/**
 * A right-click that first needs a scroll would see the scroll event arrive after the menu opened (the menu closes on any
 * scroll, FR-316). A person scrolls first, so scroll into view and let that settle before the click.
 */
async function rightClick(w: Page, locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  await w.waitForTimeout(150);
  await locator.click({ button: "right" });
}

const rowMenu = async (w: Page, name: RegExp, item: string) => {
  await rightClick(w, w.getByRole("listitem", { name }));
  await w.getByRole("menuitem", { name: item }).click();
};

test("create from a branch, it lists and opens as a tab, then a clean remove keeps the branch; no network request", async () => {
  const { repo, container } = await makeRepo();
  const w = await openApp(repo);
  const foreign: string[] = [];
  w.on("request", (r) => {
    if (!/^(file|devtools|data|blob):/.test(r.url())) foreign.push(r.url());
  });
  await expandWorktrees(w);

  await rightClick(w, w.getByRole("button", { name: /Jump to feature\/search in the commit graph/ }));
  await w.getByRole("menuitem", { name: /Create worktree/ }).click();
  const dialog = w.getByRole("dialog", { name: "Create worktree" });
  await expect(dialog).toBeVisible();
  const folder = dialog.getByLabel("Folder");
  await expect(folder).toHaveValue(/acme\.worktrees[\\/]feature-search$/);
  await expect(folder).toBeFocused();
  // The dialog is 440 px wide and lies inside the 800 px window with its footer visible.
  const box = (await dialog.boundingBox())!;
  expect(Math.round(box.width)).toBe(440);
  await dialog.getByRole("button", { name: "Create worktree" }).click();

  await expect(w.getByText('Created worktree "feature/search".')).toBeVisible();
  const target = path.join(container, "feature-search");
  expect(await exists(target)).toBe(true);
  await expect(w.getByRole("tab")).toHaveCount(2);
  await expect(w.getByRole("tab", { selected: true })).toContainText("feature/search");
  await expect(w.getByRole("heading", { name: /^Worktrees \(2\)/ })).toBeVisible();
  await expect(w.getByText(/history changed outside/i)).toHaveCount(0);

  // Remove it from its own tab.
  await rowMenu(w, /Worktree feature\/search, linked/, "Remove this worktree");
  const confirm = w.getByRole("alertdialog");
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await expect(confirm).toContainText("This also deletes ignored files such as node_modules and build output in");
  await confirm.getByRole("button", { name: "Remove worktree" }).click();
  await expect(w.getByText("Worktree removed.")).toBeVisible();
  await expect.poll(() => exists(target)).toBe(false);
  await expect(w.getByRole("tab")).toHaveCount(1);
  expect((await git(repo, ["branch", "--list", "feature/search"])).stdout).toContain("feature/search");
  expect(foreign).toEqual([]);
});

test("a dirty worktree with 21 files needs the typed count; Enter in the field never confirms", async () => {
  const { repo, container } = await makeRepo();
  const wt = path.join(container, "wip");
  await git(repo, ["worktree", "add", "-q", "-b", "wip", wt]);
  for (let i = 0; i < 21; i++) await writeFile(wt, `scratch/f${i}.txt`, "x\n");
  const w = await openApp(repo);
  await expandWorktrees(w);

  await rowMenu(w, /Worktree wip, linked/, "Remove this worktree");
  const confirm = w.getByRole("alertdialog");
  await expect(confirm).toContainText("21 uncommitted files");
  const typed = confirm.getByLabel(/Type 21 to confirm \(more than 20 files\)/);
  const button = confirm.getByRole("button", { name: "Remove worktree" });
  await expect(button).toBeDisabled();
  await typed.fill("21");
  await typed.press("Enter");
  expect(await exists(wt)).toBe(true);
  await expect(button).toBeEnabled();
  await button.click();
  await expect(w.getByText("Worktree removed.")).toBeVisible();
  await expect.poll(() => exists(wt)).toBe(false);
});

test("every branch and commit menu has exactly one worktree item", async () => {
  const { repo, container } = await makeRepo();
  await git(repo, ["worktree", "add", "-q", "-b", "other", path.join(container, "other")]);
  const w = await openApp(repo);
  await expandWorktrees(w);

  const count = async () => {
    await expect(w.getByRole("menu")).toBeVisible();
    return w.getByRole("menu").getByRole("menuitem", { name: /worktree/i }).count();
  };
  const closeMenu = async () => {
    await w.keyboard.press("Escape");
    await expect(w.getByRole("menu")).toHaveCount(0);
    // Focus returns to the card that opened the menu (FR-635); let that settle before the next right-click.
    await w.waitForTimeout(200);
  };

  await rightClick(w, w.getByRole("button", { name: /Jump to free in the commit graph/ }));
  expect(await count()).toBe(1);
  await expect(w.getByRole("menuitem", { name: /Create worktree/ })).toBeVisible();
  await closeMenu();

  await rightClick(w, w.getByRole("button", { name: /Jump to other in the commit graph/ }));
  expect(await count()).toBe(1);
  await expect(w.getByRole("menuitem", { name: "Open worktree" })).toBeVisible();
  await expect(w.getByRole("menu")).toContainText("Checked out at");
  await closeMenu();

  await rightClick(w, w.getByRole("button", { name: /Jump to main in the commit graph/ }));
  expect(await count()).toBe(1);
  await expect(w.getByRole("menuitem", { name: "Open worktree" })).toBeVisible();
  await closeMenu();

  // The commit row: Base commit has worktrees at it (main HEAD), so it offers Open, never Create.
  await rightClick(w, w.locator('[role="option"]', { hasText: "Base commit" }).first());
  expect(await count()).toBe(1);
  await expect(w.getByRole("menuitem", { name: "Open worktree" })).toBeVisible();
});

test("removing a worktree and deleting an unmerged branch keeps the branch and says so, with Open Branches", async () => {
  const { repo, container } = await makeRepo();
  const wt = path.join(container, "wip");
  await git(repo, ["worktree", "add", "-q", "-b", "wip", wt]);
  await writeFile(wt, "n.txt", "work\n");
  await commitAll(wt, "Unmerged work");
  const w = await openApp(repo);
  await expandWorktrees(w);

  await rowMenu(w, /Worktree wip, linked/, "Remove worktree and delete branch");
  const confirm = w.getByRole("alertdialog");
  await expect(confirm.getByRole("heading", { name: "Remove worktree?" })).toBeVisible();
  await expect(confirm).toContainText("Branch wip has 1 commit that is not merged into main or its upstream, so it will be kept.");
  await confirm.getByRole("button", { name: "Remove worktree" }).click();

  const banner = w.getByRole("alert").filter({ hasText: "The branch wip was kept because it has commits that are not merged into main or its upstream." });
  await expect(banner).toBeVisible();
  await expect(banner.getByRole("button", { name: "Open Branches" })).toBeVisible();
  // Persistent: still there after a pause, and focus went to the Worktrees heading.
  await w.waitForTimeout(1500);
  await expect(banner).toBeVisible();
  expect((await git(repo, ["branch", "--list", "wip"])).stdout).toContain("wip");
  await expect.poll(() => exists(wt)).toBe(false);
  await banner.getByRole("button", { name: "Dismiss" }).click();
  await expect(banner).toHaveCount(0);
});

test("a worktree added in a terminal shows up after the window regains focus", async () => {
  const { repo, container } = await makeRepo();
  const w = await openApp(repo);
  await expandWorktrees(w);
  await expect(w.getByRole("heading", { name: /^Worktrees \(1\)/ })).toBeVisible();
  await git(repo, ["worktree", "add", "-q", "-b", "terminal", path.join(container, "terminal")]);
  await w.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(w.getByRole("listitem", { name: /Worktree terminal, linked/ })).toBeVisible({ timeout: 10_000 });
});

test("long branch names are cut in the middle by JS and never ellipsized by CSS at the real tab width (FR-612)", async () => {
  const { repo, container } = await makeRepo();
  const a = "feature/PROJ-1234567-fix-search-debounce-v2";
  const b = "feature/PROJ-1234567-fix-search-debounce-v3";
  await git(repo, ["worktree", "add", "-q", "-b", a, path.join(container, "a")]);
  await git(repo, ["worktree", "add", "-q", "-b", b, path.join(container, "b")]);
  const w = await openApp(repo);
  await expandWorktrees(w);
  let opened = 1;
  for (const name of [a, b]) {
    // Each open switches the live repo; wait for it to settle (and the list to reload) before the next double-click.
    await expect(w.getByText(/Loading (worktrees|branches)/)).toHaveCount(0);
    await expandWorktrees(w);
    await w.getByRole("listitem", { name: new RegExp(`Worktree ${name.replace(/[/-]/g, "\$&")}, linked`) }).dblclick();
    opened++;
    await expect(w.getByRole("tab")).toHaveCount(opened);
  }
  await expect(w.getByRole("tab")).toHaveCount(3);
  const labels = await w.locator(".gh-tab-bar__label--branch").allTextContents();
  const long = labels.filter((l) => l.includes("..."));
  expect(long).toHaveLength(2);
  expect(new Set(long).size).toBe(2);
  for (const l of long) expect(Array.from(l)).toHaveLength(24);
  // The button is as wide as its content: nothing is clipped by CSS.
  const clipped = await w.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".gh-tab-bar__tab--worktree .gh-tab-bar__tab-button")].map((b) => b.scrollWidth > b.clientWidth + 1),
  );
  expect(clipped.every((c) => !c)).toBe(true);
});
