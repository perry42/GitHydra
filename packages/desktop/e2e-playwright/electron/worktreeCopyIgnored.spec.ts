// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * specs/worktree-copy-ignored.md AC 11 and 12 on the BUILT app with real git: tick `.env` (by hand) and `.vscode/`, Create, both
 * are byte-identical in the new worktree; after a relaunch (same userData) both are ticked "remembered for this repo" with the
 * secret line and Enter copies them; "this time only" off copies nothing and leaves the next dialog unchanged; Select none then
 * Create clears the record; a `.worktreeinclude` listing `.env` leaves it unticked with the secret hint while its non-secret
 * entry seeds the ticks without writing a record; zero requests that are not file:. One window at a time, closed in afterEach.
 * Set $COPY_SHOTS to also save light and dark screenshots of each state (never the repo).
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { closeApp, launchGitHydra, removeUserDataDir, stubOpenRepoDialog, type LaunchedApp } from "../helpers/launchApp";
import { cleanup, commitAll, git, makeTempDir, writeFile } from "../../src/test/gitFixture";

let handle: LaunchedApp | undefined;
let parent: string | undefined;
let userData: string | undefined;

test.afterEach(async () => {
  await closeApp(handle);
  if (userData) await removeUserDataDir(userData);
  if (parent) await cleanup(parent);
  parent = undefined;
  userData = undefined;
});

const sha = async (p: string) => createHash("sha256").update(await fs.readFile(p)).digest("hex");
const exists = (p: string) => fs.stat(p).then(() => true, () => false);

async function openApp(repo: string, foreign: string[]): Promise<Page> {
  handle = await launchGitHydra([], userData);
  userData = handle.userDataDir;
  const w = handle.window;
  w.on("request", (r) => {
    if (!/^(file|devtools|data|blob):/.test(r.url())) foreign.push(r.url());
  });
  await handle.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((b) => b.setSize(1400, 900)));
  await stubOpenRepoDialog(handle.app, repo);
  const open = w.getByRole("button", { name: "Open a repository", exact: true });
  const stashes = w.getByRole("button", { name: /^stashes/i });
  // A relaunch may restore the tab; only open the repo when it did not.
  await expect(open.or(stashes)).toBeVisible({ timeout: 15_000 });
  if (await open.isVisible()) await open.click();
  await stashes.waitFor({ timeout: 15_000 });
  const toggle = w.getByRole("button", { name: /^Worktrees/ });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  return w;
}

async function openCreate(w: Page, branch: string): Promise<Locator> {
  const button = w.getByRole("button", { name: new RegExp(`Jump to ${branch} in the commit graph`) });
  await button.scrollIntoViewIfNeeded();
  await w.waitForTimeout(150);
  await button.click({ button: "right" });
  await w.getByRole("menuitem", { name: /Create worktree/ }).click();
  const dialog = w.getByRole("dialog", { name: "Create worktree" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Folder")).toHaveValue(new RegExp(`acme\\.worktrees[\\\\/]${branch}$`));
  // Never let the new tab become the source of the next dialog: the copy source is the ACTIVE worktree.
  await dialog.getByLabel("Open after create").uncheck();
  await expect(dialog.locator('[role="group"][aria-label="Ignored files"]')).not.toHaveAttribute("aria-busy", "true");
  return dialog;
}

const group = (dialog: Locator) => dialog.locator('[role="group"][aria-label="Ignored files"]');

async function shoot(w: Page, name: string, target: Locator): Promise<void> {
  const dir = process.env.COPY_SHOTS;
  if (!dir) return;
  await fs.mkdir(dir, { recursive: true });
  for (const theme of ["light", "dark"] as const) {
    await w.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await w.waitForTimeout(250);
    await target.screenshot({ path: path.join(dir, `${name}-${theme}.png`) });
  }
  await w.evaluate(() => (document.documentElement.dataset.theme = "light"));
}

const banner = (w: Page) => w.getByRole("region", { name: "Worktree notices" });
const record = (w: Page) => w.evaluate(() => Object.entries(window.localStorage).filter(([k]) => k.startsWith("githydra:worktreeCopy:")));

test("copy ignored files: tick, create, remember, this time only, Select none, .worktreeinclude (AC 11, 12)", async () => {
  test.setTimeout(300_000);
  parent = await makeTempDir("pw-copy-");
  const repo = path.join(parent, "acme");
  const container = path.join(parent, "acme.worktrees");
  await fs.mkdir(repo);
  await git(repo, ["init", "-q", "--initial-branch=main"]);
  await writeFile(repo, ".gitignore", ".env\n.vscode/\nlocal.cfg\n");
  await writeFile(repo, "a.txt", "base\n");
  await commitAll(repo, "Base commit");
  for (const b of ["first", "second", "third", "fourth", "fifth", "sixth"]) await git(repo, ["branch", b]);
  // A branch that TRACKS local.cfg (force-added): the ignored copy in main must never overwrite it (AC 9 at the UI level).
  await git(repo, ["checkout", "-q", "-b", "seventh"]);
  await writeFile(repo, "local.cfg", "tracked-version\n");
  await git(repo, ["add", "-f", "local.cfg"]);
  await git(repo, ["commit", "-q", "-m", "Track local.cfg on seventh"]);
  await git(repo, ["checkout", "-q", "main"]);
  await writeFile(repo, ".env", "API_KEY=very-secret-value\n");
  await writeFile(repo, ".vscode/settings.json", '{ "editor.tabSize": 2 }\n');
  await writeFile(repo, ".vscode/extensions.json", '{ "recommendations": [] }\n');
  await writeFile(repo, "local.cfg", "mode=dev\n");
  const foreign: string[] = [];

  // --- 1. tick by hand, Create ---
  let w = await openApp(repo, foreign);
  let dialog = await openCreate(w, "first");
  await expect(dialog.getByRole("button", { name: "Advanced" })).toHaveAttribute("aria-expanded", "false");
  await dialog.getByRole("button", { name: "Advanced" }).click();
  await expect(dialog.getByText("No ignored files will be copied.")).toBeVisible();
  await shoot(w, "line-none-ticked", dialog);
  await dialog.getByRole("button", { name: "Choose files" }).click();
  await expect(dialog.getByRole("button", { name: "Review" })).toHaveAttribute("aria-expanded", "true");
  await expect(dialog.getByRole("checkbox", { name: /^\.env/ })).toBeFocused();
  await shoot(w, "review-open-nothing-ticked", dialog);
  await dialog.getByRole("checkbox", { name: /^\.env/ }).check();
  await dialog.getByRole("checkbox", { name: /^\.vscode\// }).check();
  await expect(dialog.getByText("1 secret file: .env")).toBeVisible();
  await expect(dialog.getByText(/^Copy 2 files · \d+ B$/)).toBeVisible();
  await expect(dialog.getByRole("status")).toHaveText(/^2 files selected, \d+ B$/);
  await shoot(w, "review-secret-ticked", dialog);

  // AC 5/12: no horizontal scroll at the longest state, only the body scrolls, targets and text sizes.
  const sizes = await dialog.evaluate((el) => {
    const body = el.querySelector(".gh-create-worktree__body") as HTMLElement;
    const small: string[] = [];
    for (const n of el.querySelectorAll<HTMLElement>(".gh-copy *")) {
      if (n.closest("[hidden]") || n.closest(".gh-visually-hidden")) continue;
      if (n.childNodes.length && Array.from(n.childNodes).some((c) => c.nodeType === 3 && c.textContent?.trim())) {
        if (parseFloat(getComputedStyle(n).fontSize) < 12) small.push(`font:${n.className}`);
      }
    }
    const targets = Array.from(el.querySelectorAll<HTMLElement>(".gh-copy__rowlabel, .gh-copy__link, .gh-copy__review, .gh-copy__check")).filter((n) => n.offsetParent !== null);
    for (const t of targets) if (t.getBoundingClientRect().height < 23.5) small.push(`target:${t.className}`);
    const list = el.querySelector(".gh-copy__rows") as HTMLElement;
    return { scrollW: body.scrollWidth, clientW: body.clientWidth, dialogH: (el as HTMLElement).getBoundingClientRect().height, small, listOverflow: getComputedStyle(list).overflow, panelOverflow: getComputedStyle(list.parentElement!).overflow, width: Math.round(el.getBoundingClientRect().width) };
  });
  expect(sizes.small).toEqual([]);
  expect(sizes.scrollW).toBeLessThanOrEqual(sizes.clientW);
  expect(sizes.listOverflow).toBe("visible");
  expect(sizes.panelOverflow).toBe("visible");
  expect(sizes.dialogH).toBeLessThanOrEqual(900);
  expect(sizes.width).toBe(440);

  await dialog.getByRole("button", { name: "Create worktree" }).click();
  await expect(banner(w).getByText(/^Created worktree "first"\. Copied 3 files \(\d+ B\) from acme\.$/)).toBeVisible();
  await expect(banner(w)).not.toContainText(/remember/i);
  await shoot(w, "banner-copied", banner(w));
  const first = path.join(container, "first");
  expect(await sha(path.join(first, ".env"))).toBe(await sha(path.join(repo, ".env")));
  expect(await sha(path.join(first, ".vscode", "settings.json"))).toBe(await sha(path.join(repo, ".vscode", "settings.json")));
  expect(await sha(path.join(first, ".vscode", "extensions.json"))).toBe(await sha(path.join(repo, ".vscode", "extensions.json")));
  expect(await exists(path.join(first, "local.cfg"))).toBe(false);
  expect((await record(w)).length).toBe(1);
  // Nothing GitHydra wrote lives in the repo: the source's status shows only what the fixture made.
  expect((await git(repo, ["status", "--porcelain"])).stdout.trim()).toBe("");

  // --- 2. relaunch on the SAME userData: both ticked "remembered", Enter copies them ---
  await closeApp(handle);
  w = await openApp(repo, foreign);
  dialog = await openCreate(w, "second");
  await expect(dialog.getByRole("button", { name: "Advanced" })).toHaveAttribute("aria-expanded", "true");
  await expect(dialog.getByText(/^Copy 2 files · \d+ B$/)).toBeVisible();
  await expect(dialog.getByText("remembered for this repo", { exact: true })).toBeVisible();
  await expect(dialog.getByText("1 secret file: .env")).toBeVisible();
  await expect(dialog.getByText(".env, .vscode/")).toBeVisible();
  await shoot(w, "line-from-memory-secret", dialog);
  await dialog.getByRole("button", { name: "Review" }).click();
  await shoot(w, "review-from-memory", dialog);
  await dialog.getByLabel("Folder").press("Enter");
  await expect(banner(w).getByText(/Created worktree "second"\. Copied 3 files/)).toBeVisible();
  expect(await sha(path.join(container, "second", ".env"))).toBe(await sha(path.join(repo, ".env")));
  await w.keyboard.press("Escape");

  // --- 3. "this time only" off: copies nothing, the next dialog is unchanged ---
  dialog = await openCreate(w, "third");
  await dialog.getByRole("checkbox", { name: /^Copy 2 files/ }).uncheck();
  await expect(dialog.getByText("skipped this time")).toBeVisible();
  await dialog.getByRole("button", { name: "Review" }).click();
  await expect(dialog.getByRole("checkbox", { name: /^\.env/ })).toBeDisabled();
  await shoot(w, "line-skipped-this-time", dialog);
  await dialog.getByRole("button", { name: "Create worktree" }).click();
  await expect(banner(w).getByText('Created worktree "third".', { exact: true })).toBeVisible();
  expect(await exists(path.join(container, "third", ".env"))).toBe(false);
  expect(await exists(path.join(container, "third"))).toBe(true);
  dialog = await openCreate(w, "fourth");
  await expect(dialog.getByText(/^Copy 2 files · \d+ B$/)).toBeVisible();
  await expect(dialog.getByText("remembered for this repo", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("checkbox", { name: /^Copy 2 files/ })).toBeChecked();

  // --- 4. Select none then Create clears the record ---
  await dialog.getByRole("button", { name: "Review" }).click();
  await dialog.getByRole("button", { name: "Select none" }).click();
  await dialog.getByRole("button", { name: "Create worktree" }).click();
  await expect(banner(w).getByText('Created worktree "fourth".', { exact: true })).toBeVisible();
  expect(await exists(path.join(container, "fourth", ".env"))).toBe(false);
  expect(await record(w)).toEqual([]);
  dialog = await openCreate(w, "fifth");
  await dialog.getByRole("button", { name: "Advanced" }).click();
  await expect(dialog.getByText("No ignored files will be copied.")).toBeVisible();
  await w.keyboard.press("Escape");

  // --- 5. .worktreeinclude: the secret stays unticked with the hint; the non-secret entry seeds the ticks ---
  await fs.writeFile(path.join(repo, ".worktreeinclude"), ".env\nlocal.cfg\n");
  dialog = await openCreate(w, "fifth");
  await expect(dialog.getByRole("button", { name: "Advanced" })).toHaveAttribute("aria-expanded", "true");
  await expect(dialog.getByText(".env is listed in .worktreeinclude but looks like a secret, so it is not ticked.")).toBeVisible();
  await expect(dialog.getByText("Copy 1 file · 9 B from .worktreeinclude")).toBeVisible();
  await dialog.getByRole("button", { name: "Review" }).click();
  await expect(dialog.getByRole("checkbox", { name: /^\.env/ })).not.toBeChecked();
  await expect(dialog.getByRole("checkbox", { name: /^local\.cfg/ })).toBeChecked();
  await shoot(w, "line-from-include-secret-hint", dialog);
  await dialog.getByRole("button", { name: "Create worktree" }).click();
  await expect(banner(w).getByText(/Created worktree "fifth"\. Copied 1 file \(9 B\) from acme\./)).toBeVisible();
  expect(await exists(path.join(container, "fifth", ".env"))).toBe(false);
  expect(await sha(path.join(container, "fifth", "local.cfg"))).toBe(await sha(path.join(repo, "local.cfg")));
  // A seed from the file stays live until the user changes something: nothing was written.
  expect(await record(w)).toEqual([]);

  // --- 6. a planted run-code file inside a ticked directory after review is NOT copied (FR-643) ---
  dialog = await openCreate(w, "sixth");
  await dialog.getByRole("button", { name: "Review" }).click();
  await dialog.getByRole("checkbox", { name: /^\.vscode\// }).check();
  await fs.writeFile(path.join(repo, ".vscode", "tasks.json"), '{ "tasks": [] }\n');
  await dialog.getByRole("button", { name: "Create worktree" }).click();
  await expect(banner(w).getByText(/Created worktree "sixth"\. Copied/)).toBeVisible();
  expect(await exists(path.join(container, "sixth", ".vscode", "settings.json"))).toBe(true);
  expect(await exists(path.join(container, "sixth", ".vscode", "tasks.json"))).toBe(false);

  // --- 7. a tracked file in the new worktree is never overwritten; the banner says what was not copied ---
  dialog = await openCreate(w, "seventh");
  await expect(dialog.getByText(/^Copy 2 files · \d+ B$/)).toBeVisible();
  await dialog.getByRole("button", { name: "Create worktree" }).click();
  await expect(banner(w).getByText(/Created worktree "seventh"\. Copied 3 of 4 files\. Not copied: local\.cfg \(tracked in the new worktree\)\./)).toBeVisible();
  await expect(banner(w)).not.toContainText(/remember/i);
  await shoot(w, "banner-partial", banner(w).locator(".gh-status-banner").last());
  // autocrlf may have written CRLF; what matters is that the ignored copy did not replace the tracked content.
  expect((await fs.readFile(path.join(container, "seventh", "local.cfg"), "utf8")).replace(/\r\n/g, "\n")).toBe("tracked-version\n");
  expect(await exists(path.join(container, "seventh", ".vscode", "tasks.json"))).toBe(true);

  expect(foreign).toEqual([]);
});
