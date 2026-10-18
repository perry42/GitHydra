// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * specs/worktree-copy-ignored.md section G, AC 23 on the BUILT app with real git: a main checkout with linked worktrees (one locked,
 * one missing). From the Worktrees row menu, the branch menu and the palette the dialog copies ignored files into an existing worktree;
 * `.env` is hand-ticked, an existing file is never overwritten and shows in the partial banner; the memory pre-ticks `.env` next time
 * and never a run-code row; refused destinations show their reasons; zero requests leave the machine. One window at a time, closed in
 * afterEach. Set $INTO_SHOTS to also save light and dark 2x screenshots of each state (never the repo).
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
  handle = undefined;
  parent = undefined;
  userData = undefined;
});

const SHOTS = process.env.INTO_SHOTS;
const sha = async (p: string) => createHash("sha256").update(await fs.readFile(p)).digest("hex");
const exists = (p: string) => fs.stat(p).then(() => true, () => false);

async function openApp(repo: string, foreign: string[]): Promise<Page> {
  // 2x device pixels for the screenshot run only (a real Chromium switch honoured before ready).
  handle = await launchGitHydra(SHOTS ? ["--force-device-scale-factor=2"] : [], userData);
  userData = handle.userDataDir;
  const w = handle.window;
  w.on("request", (r) => {
    if (!/^(file|devtools|data|blob):/.test(r.url())) foreign.push(r.url());
  });
  await handle.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((b) => b.setSize(1400, 900)));
  await stubOpenRepoDialog(handle.app, repo);
  const open = w.getByRole("button", { name: "Open a repository", exact: true });
  const stashes = w.getByRole("button", { name: /^stashes/i });
  await expect(open.or(stashes)).toBeVisible({ timeout: 15_000 });
  if (await open.isVisible()) await open.click();
  await stashes.waitFor({ timeout: 15_000 });
  await expandWorktrees(w);
  return w;
}

async function expandWorktrees(w: Page): Promise<void> {
  const toggle = w.getByRole("button", { name: /^Worktrees/ });
  await expect(async () => {
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true", { timeout: 1000 });
  }).toPass({ timeout: 15_000 });
}

async function shoot(w: Page, name: string, target: Locator): Promise<void> {
  if (!SHOTS) return;
  await fs.mkdir(SHOTS, { recursive: true });
  for (const theme of ["light", "dark"] as const) {
    await w.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await w.waitForTimeout(250);
    await target.screenshot({ path: path.join(SHOTS, `${name}-${theme}.png`) });
  }
  await w.evaluate(() => (document.documentElement.dataset.theme = "light"));
}

const row = (w: Page, name: string) => w.getByRole("listitem", { name: new RegExp(`^Worktree ${name},`) });
const rowMenu = async (w: Page, name: string): Promise<Locator> => {
  const more = row(w, name).getByRole("button", { name: `Actions for worktree ${name}` });
  const menu = w.getByRole("menu", { name: `Actions for worktree ${name}` });
  // A scroll event closes an open menu (FR-316), and a late layout shift of the sidebar can fire one right after the click: retry.
  await expect(async () => {
    await more.scrollIntoViewIfNeeded();
    await w.waitForTimeout(250);
    await more.click();
    await expect(menu.getByRole("menuitem", { name: "Copy path" })).toBeVisible({ timeout: 1500 });
    await w.waitForTimeout(300);
    await expect(menu).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 20_000 });
  return menu;
};
const COPY_HERE = "Copy ignored files here...";

async function openDialogFromRow(w: Page, name: string): Promise<Locator> {
  const menu = await rowMenu(w, name);
  await menu.getByRole("menuitem", { name: COPY_HERE }).click();
  const dialog = w.getByRole("dialog", { name: "Copy ignored files" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Checking for ignored files...")).toHaveCount(0, { timeout: 15_000 });
  return dialog;
}

const checkbox = (dialog: Locator, name: string | RegExp) => dialog.getByRole("checkbox", { name });
const record = (w: Page) =>
  w.evaluate(() => Object.entries(window.localStorage).filter(([k]) => k.startsWith("githydra:worktreeCopy:")).map(([, v]) => (JSON.parse(v) as { paths: string[] }).paths));

async function makeRepo(): Promise<{ repo: string; wt: (n: string) => string }> {
  parent = await makeTempDir("pw-into-");
  const repo = path.join(parent, "acme");
  const container = path.join(parent, "acme.worktrees");
  await fs.mkdir(repo);
  await git(repo, ["init", "-q", "--initial-branch=main"]);
  await writeFile(repo, ".gitignore", ".env\n.vscode/\nconfig/\nnotes.local\n");
  await writeFile(repo, "a.txt", "base\n");
  await commitAll(repo, "Base commit");
  await fs.mkdir(container, { recursive: true });
  for (const b of ["tour-login", "second-wt", "locked-wt", "gone-wt"]) await git(repo, ["worktree", "add", "-q", "-b", b, path.join(container, b)]);
  await git(repo, ["worktree", "lock", "--reason", "on a usb stick", path.join(container, "locked-wt")]);
  await fs.rm(path.join(container, "gone-wt"), { recursive: true, force: true });
  await writeFile(repo, ".env", "API_KEY=very-secret-value\n");
  await writeFile(repo, ".vscode/settings.json", '{ "editor.tabSize": 2 }\n');
  await writeFile(repo, "config/local.json", "main-version\n");
  await writeFile(repo, "config/extra.json", "extra\n");
  await writeFile(repo, "notes.local", "main-notes\n");
  // The destination already has two of them, with its own content.
  await writeFile(path.join(container, "tour-login"), "config/local.json", "dest-version\n");
  await writeFile(path.join(container, "tour-login"), "notes.local", "dest-notes\n");
  return { repo, wt: (n) => path.join(container, n) };
}

test("copy into an existing worktree: row menu, hand-ticked secret, partial banner, memory, refusals, branch menu, palette (AC 23)", async () => {
  test.setTimeout(300_000);
  const { repo, wt } = await makeRepo();
  const foreign: string[] = [];
  const w = await openApp(repo, foreign);
  await expect(row(w, "tour-login")).toBeVisible();

  // --- the menu with the item, in the FR-649 order ---
  const menu = await rowMenu(w, "tour-login");
  const labels = await menu.locator(":scope > *").evaluateAll((els) => els.map((e) => (e.getAttribute("role") === "separator" ? "---" : (e.getAttribute("aria-label") ?? e.textContent ?? ""))));
  expect(labels[0]).toMatch(/^Open worktree/); // the accordion row carries its hint text too
  expect(labels.slice(1, 5)).toEqual(["Copy path", "---", COPY_HERE, "---"]);
  expect(labels[5]).toMatch(/^Remove this worktree/);
  await shoot(w, "menu-row", menu);
  await menu.getByRole("menuitem", { name: COPY_HERE }).click();

  // --- the dialog, default state ---
  const dialog = w.getByRole("dialog", { name: "Copy ignored files" });
  await expect(dialog).toBeVisible();
  await expect(checkbox(dialog, /^\.env/)).toBeFocused({ timeout: 15_000 });
  await expect(dialog.locator(".gh-copy-into__sentence")).toHaveText("From acme into tour-login.");
  await expect(dialog.locator(".gh-copy-into__path")).toHaveText(wt("tour-login"));
  await expect(dialog.getByText("Tick the ignored files you want copied. Files that already exist in tour-login are never overwritten.")).toBeVisible();
  await expect(checkbox(dialog, /^\.env/)).not.toBeChecked();
  await expect(dialog.getByText("secret", { exact: true })).toBeVisible();
  await expect(dialog.getByText("runs code when opened")).toBeVisible();
  await expect(dialog.getByText("1 of 2 already exist")).toBeVisible();
  await expect(checkbox(dialog, /^notes\.local/)).toBeDisabled();
  await expect(dialog.getByText("already exists", { exact: true })).toBeVisible();
  await expect(dialog.getByText("No ignored files will be copied.")).toBeVisible();
  await shoot(w, "dialog-default", dialog);

  // AC 24: nothing scrolls sideways, targets and text sizes, one scroller.
  const geometry = await dialog.evaluate((el) => {
    const body = el.querySelector(".gh-create-worktree__body") as HTMLElement;
    const sentence = el.querySelector(".gh-copy-into__sentence") as HTMLElement;
    const path = el.querySelector(".gh-copy-into__path") as HTMLElement;
    const small: string[] = [];
    for (const n of el.querySelectorAll<HTMLElement>("*")) {
      if (n.closest(".gh-visually-hidden")) continue;
      const own = Array.from(n.childNodes).some((c) => c.nodeType === 3 && c.textContent?.trim());
      if (own && parseFloat(getComputedStyle(n).fontSize) < 12) small.push(`${n.className}:${getComputedStyle(n).fontSize}`);
    }
    const tiny = Array.from(el.querySelectorAll<HTMLElement>("button, label")).filter((n) => {
      const r = n.getBoundingClientRect();
      return r.width > 0 && r.height < 24;
    }).map((n) => `${n.tagName}:${n.textContent?.trim().slice(0, 20)}:${n.getBoundingClientRect().height}`);
    const list = el.querySelector(".gh-copy-into__rows") as HTMLElement;
    return {
      body: body.scrollWidth <= body.clientWidth,
      sentence: sentence.scrollWidth <= sentence.clientWidth,
      path: path.scrollWidth <= path.clientWidth,
      width: Math.round(el.getBoundingClientRect().width),
      listOverflow: getComputedStyle(list).overflowY,
      small,
      tiny,
    };
  });
  expect(geometry).toMatchObject({ body: true, sentence: true, path: true, width: 540, listOverflow: "visible", small: [] });
  expect(geometry.tiny).toEqual([]);

  // --- keyboard: Enter with nothing ticked does nothing; Space ticks; a ticked secret is not copied by Enter elsewhere ---
  await w.waitForTimeout(450);
  await w.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await w.keyboard.press("Space");
  await expect(checkbox(dialog, /^\.env/)).toBeChecked();
  await expect(dialog.getByText("1 secret file: .env")).toBeVisible();
  await expect(dialog.getByRole("status").filter({ hasText: "file selected" })).toHaveText(/^1 file selected, \d+ B$/);
  await shoot(w, "dialog-secret-ticked", dialog);
  await w.keyboard.press("Enter");
  await w.waitForTimeout(300);
  await expect(dialog).toBeVisible();
  expect(await exists(path.join(wt("tour-login"), ".env"))).toBe(false);

  await checkbox(dialog, /^\.vscode\//).check();
  await checkbox(dialog, /^config\//).check();
  const copy = dialog.getByRole("button", { name: "Copy", exact: true });
  await copy.focus();
  await w.keyboard.press("Enter");

  // --- result: byte-identical, the existing file untouched, the partial banner in the Branches panel ---
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  const notices = w.getByRole("region", { name: "Worktree notices" });
  const banner = notices.getByRole("alert");
  await expect(banner).toContainText(/^Copied 3 files \(\d+ B\) from acme into tour-login\. Not copied: config\/local\.json \(already exists\)\.Dismiss$/);
  await expect(banner.locator("code")).toHaveText("config/local.json");
  await expect(banner.getByRole("button")).toHaveText(["Dismiss"]);
  await expect(banner).not.toContainText(/remember/i);
  expect(await banner.evaluate((el) => getComputedStyle(el).borderLeftWidth === getComputedStyle(el).borderRightWidth)).toBe(true);
  expect(await sha(path.join(wt("tour-login"), ".env"))).toBe(await sha(path.join(repo, ".env")));
  expect(await sha(path.join(wt("tour-login"), ".vscode", "settings.json"))).toBe(await sha(path.join(repo, ".vscode", "settings.json")));
  expect(await sha(path.join(wt("tour-login"), "config", "extra.json"))).toBe(await sha(path.join(repo, "config", "extra.json")));
  expect(await fs.readFile(path.join(wt("tour-login"), "config", "local.json"), "utf8")).toBe("dest-version\n");
  expect(await fs.readFile(path.join(wt("tour-login"), "notes.local"), "utf8")).toBe("dest-notes\n");
  expect(await fs.readFile(path.join(repo, "config", "local.json"), "utf8")).toBe("main-version\n");
  await shoot(w, "banner-partial", notices);
  expect((await record(w)).flat().sort()).toEqual([".env", ".vscode/", "config/"]);
  await banner.getByRole("button", { name: "Dismiss" }).click();
  await expect(banner).toHaveCount(0);

  // --- memory: a second destination pre-ticks .env (remembered, hand-ticked once), never the run-code row ---
  const again = await openDialogFromRow(w, "second-wt");
  await expect(checkbox(again, /^\.env/)).toBeChecked();
  await expect(checkbox(again, /^\.vscode\//)).not.toBeChecked();
  await expect(checkbox(again, /^config\//)).toBeChecked();
  await expect(again.getByText("remembered", { exact: true })).toHaveCount(3);
  await expect(again.getByText("1 secret file: .env")).toBeVisible();
  // Nothing was written by merely looking: Esc closes without copying.
  await w.waitForTimeout(450);
  await w.keyboard.press("Escape");
  await expect(again).toBeHidden();
  expect(await exists(path.join(wt("second-wt"), ".env"))).toBe(false);
  // Focus returns to where the dialog was opened from.
  await expect(row(w, "second-wt").getByRole("button", { name: "Actions for worktree second-wt" })).toBeFocused();

  // --- success banner: a clean copy of one file into second-wt ---
  const clean = await openDialogFromRow(w, "second-wt");
  await clean.getByRole("button", { name: "Select none" }).click();
  await checkbox(clean, /^config\//).check();
  await clean.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(clean).toBeHidden({ timeout: 15_000 });
  const ok = w.getByRole("region", { name: "Worktree notices" }).getByRole("status");
  await expect(ok).toHaveText(/^Copied 2 files \(\d+ B\) from acme into second-wt\.Dismiss$/);
  await shoot(w, "banner-success", w.getByRole("region", { name: "Worktree notices" }));
  await ok.getByRole("button", { name: "Dismiss" }).click();

  // --- refused rows from the main tab: locked, missing ---
  for (const [name, reason] of [
    ["locked-wt", "Locked: unlock it first"],
    ["gone-wt", "The folder is missing"],
  ] as const) {
    const m = await rowMenu(w, name);
    const item = m.getByRole("menuitem", { name: COPY_HERE });
    await expect(item).toHaveAttribute("aria-disabled", "true");
    await expect(item).toHaveAccessibleDescription(reason);
    await item.focus();
    await expect(item).toBeFocused();
    if (name === "locked-wt") await shoot(w, "menu-refused", m);
    await item.click({ force: true }); // does nothing; the menu stays open
    await expect(m).toBeVisible();
    await w.keyboard.press("Escape");
    await expect(m).toBeHidden();
  }

  // --- the branch menu: after Open worktree, only for a branch with a worktree ---
  const card = (b: string) => w.getByRole("button", { name: new RegExp(`Jump to ${b} in the commit graph`) });
  await card("second-wt").scrollIntoViewIfNeeded();
  await w.waitForTimeout(200);
  await card("second-wt").click({ button: "right" });
  const bmenu = w.getByRole("menu", { name: /Actions for branch second-wt/ });
  const blabels = await bmenu.getByRole("menuitem").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? e.textContent ?? ""));
  expect(blabels[blabels.indexOf("Open worktree") + 1]).toBe(COPY_HERE);
  await bmenu.getByRole("menuitem", { name: COPY_HERE }).click();
  await expect(w.getByRole("dialog", { name: "Copy ignored files" }).locator(".gh-copy-into__sentence")).toHaveText("From acme into second-wt.");
  await w.waitForTimeout(450);
  await w.keyboard.press("Escape");
  await expect(w.getByRole("dialog", { name: "Copy ignored files" })).toBeHidden();

  // --- the palette: several worktrees open the picker, a refused one stays listed and cannot be chosen ---
  await w.keyboard.press("Control+k");
  await w.getByRole("combobox").fill("Copy ignored");
  await w.keyboard.press("Enter");
  const picker = w.getByRole("dialog", { name: "Copy ignored files into worktree..." });
  await expect(picker.getByText("Copy ignored files from acme into which worktree?")).toBeVisible();
  const list = picker.getByRole("listbox", { name: "Worktrees" });
  await expect(list.getByRole("option")).toHaveCount(4);
  await expect(list.getByRole("option", { name: /acme\s/ })).toHaveCount(0); // the source is left out
  await expect(list.getByRole("option", { name: /locked-wt/ })).toHaveAttribute("aria-disabled", "true");
  await expect(list.getByRole("option", { name: /locked-wt/ })).toContainText("Locked: unlock it first");
  await expect(list.getByRole("option", { name: /gone-wt/ })).toContainText("The folder is missing");
  await shoot(w, "palette-picker", picker);
  await picker.getByRole("combobox").fill("locked");
  await w.keyboard.press("Enter");
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("combobox")).toBeFocused();
  await w.keyboard.press("Escape"); // back to the command list
  await expect(w.getByRole("dialog", { name: "Command Palette" })).toBeVisible();
  await w.keyboard.press("Escape");
  await expect(w.getByRole("dialog", { name: "Command Palette" })).toBeHidden();
  await w.keyboard.press("Control+k");
  await w.getByRole("combobox").fill("Copy ignored");
  await w.keyboard.press("Enter");
  await w.getByRole("dialog", { name: "Copy ignored files into worktree..." }).getByRole("combobox").fill("second");
  await w.keyboard.press("Enter");
  await expect(w.getByRole("dialog", { name: "Copy ignored files" }).locator(".gh-copy-into__sentence")).toHaveText("From acme into second-wt.");
  await w.waitForTimeout(450);
  await w.keyboard.press("Escape");

  // --- from a linked worktree tab: the main worktree is a valid destination and the source row is disabled ---
  await row(w, "tour-login").dblclick();
  await expect(w.getByRole("tab", { name: /tour-login/ })).toHaveAttribute("aria-selected", "true", { timeout: 15_000 });
  await expandWorktrees(w);
  const fromLinked = await rowMenu(w, "main");
  await expect(fromLinked.getByRole("menuitem", { name: COPY_HERE })).not.toHaveAttribute("aria-disabled", "true");
  await w.keyboard.press("Escape");
  const sourceMenu = await rowMenu(w, "tour-login");
  const sourceItem = sourceMenu.getByRole("menuitem", { name: COPY_HERE });
  await expect(sourceItem).toHaveAttribute("aria-disabled", "true");
  await expect(sourceItem).toHaveAccessibleDescription("This is the source worktree");
  await w.keyboard.press("Escape");

  expect(foreign).toEqual([]);
});

test("a repository with no ignored files keeps the item enabled; the dialog says so and has a single Close", async () => {
  test.setTimeout(120_000);
  parent = await makeTempDir("pw-into-zero-");
  const repo = path.join(parent, "acme");
  await fs.mkdir(repo);
  await git(repo, ["init", "-q", "--initial-branch=main"]);
  await writeFile(repo, "a.txt", "base\n");
  await commitAll(repo, "Base commit");
  await git(repo, ["worktree", "add", "-q", "-b", "other", path.join(parent, "acme.worktrees", "other")]);
  const foreign: string[] = [];
  const w = await openApp(repo, foreign);
  const menu = await rowMenu(w, "other");
  const item = menu.getByRole("menuitem", { name: COPY_HERE });
  await expect(item).not.toHaveAttribute("aria-disabled", "true");
  await item.click();
  const dialog = w.getByRole("dialog", { name: "Copy ignored files" });
  await expect(dialog.getByText("No ignored files to copy in this repository.")).toBeVisible({ timeout: 15_000 });
  await expect(dialog.getByRole("button")).toHaveText(["Close"]);
  await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
  await shoot(w, "dialog-zero", dialog);
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
  expect(foreign).toEqual([]);
});

test("a bare repository shows the item disabled with its reason on every row", async () => {
  test.setTimeout(120_000);
  parent = await makeTempDir("pw-into-bare-");
  const seed = path.join(parent, "seed");
  await fs.mkdir(seed);
  await git(seed, ["init", "-q", "--initial-branch=main"]);
  await writeFile(seed, "a.txt", "base\n");
  await commitAll(seed, "Base commit");
  const bare = path.join(parent, "acme.git");
  await git(parent, ["clone", "-q", "--bare", seed, bare]);
  await git(bare, ["worktree", "add", "-q", "-b", "other", path.join(parent, "other-wt")]);
  const w = await openApp(bare, []);
  const menu = await rowMenu(w, "other");
  const item = menu.getByRole("menuitem", { name: COPY_HERE });
  await expect(item).toHaveAttribute("aria-disabled", "true");
  await expect(item).toHaveAccessibleDescription("This is a bare repository: there is nothing to copy.");
});

test("progress after 2 s, Cancel, and a destination that changed after the listing (typed refusal with Try again)", async () => {
  test.setTimeout(300_000);
  parent = await makeTempDir("pw-into-progress-");
  const repo = path.join(parent, "acme");
  const container = path.join(parent, "acme.worktrees");
  await fs.mkdir(repo);
  await git(repo, ["init", "-q", "--initial-branch=main"]);
  await writeFile(repo, ".gitignore", "big/\nsmall.cfg\n");
  await writeFile(repo, "a.txt", "base\n");
  await commitAll(repo, "Base commit");
  await fs.mkdir(container, { recursive: true });
  for (const b of ["big-wt", "err-wt"]) await git(repo, ["worktree", "add", "-q", "-b", b, path.join(container, b)]);
  // 4,500 files of 24 KB (about 105 MB): well inside the 5,000 files / 200 MB limits, slow enough to pass the 2 s mark.
  const chunk = Buffer.alloc(24 * 1024, 7);
  await fs.mkdir(path.join(repo, "big"), { recursive: true });
  for (let i = 0; i < 4500; i += 100) {
    await Promise.all(Array.from({ length: 100 }, (_, j) => fs.writeFile(path.join(repo, "big", `f${String(i + j).padStart(5, "0")}.bin`), chunk)));
  }
  await writeFile(repo, "small.cfg", "x\n");
  const w = await openApp(repo, []);

  // --- progress ---
  const dialog = await openDialogFromRow(w, "big-wt");
  await checkbox(dialog, /^big\//).check();
  await expect(dialog.getByText(/^4500 files selected, /)).toBeVisible();
  const copy = dialog.getByRole("button", { name: "Copy", exact: true });
  await copy.click();
  await expect(dialog.getByRole("button", { name: "Copying..." })).toHaveAttribute("aria-disabled", "true");
  const readout = dialog.getByText(/^Copying \d+ of 4500 files\.\.\.$/);
  await expect(readout).toBeVisible({ timeout: 30_000 });
  const bar = dialog.getByRole("progressbar");
  await expect(bar).toBeVisible();
  await shoot(w, "dialog-progress", dialog);
  await w.keyboard.press("Escape"); // ignored while copying
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  const notices = w.getByRole("region", { name: "Worktree notices" });
  await expect(notices).toContainText(/^Copy cancelled\. (Copied \d+ files? \(.+\) from acme into big-wt before it stopped\.|Nothing was copied\.)Dismiss$/);
  await shoot(w, "banner-cancelled", notices);
  await notices.getByRole("button", { name: "Dismiss" }).click();

  // --- a destination that changed after the listing: a typed refusal stays in the dialog ---
  const dlg = await openDialogFromRow(w, "err-wt");
  await checkbox(dlg, /^small\.cfg/).check();
  await git(repo, ["worktree", "lock", path.join(container, "err-wt")]);
  await dlg.getByRole("button", { name: "Copy", exact: true }).click();
  const alert = dlg.getByRole("alert");
  await expect(alert).toContainText(/^Could not copy: /, { timeout: 15_000 });
  await expect(dlg.getByRole("button", { name: "Try again" })).toBeVisible();
  expect(await exists(path.join(container, "err-wt", "small.cfg"))).toBe(false);
  await shoot(w, "dialog-error", dlg);
  await dlg.getByRole("button", { name: "Try again" }).click();
  await expect(dlg.getByRole("alert")).toHaveCount(0); // the new listing replaced the refusal (here: the worktree is locked now)
  await w.waitForTimeout(450);
  await w.keyboard.press("Escape");
});
