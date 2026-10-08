// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Real-Electron check of the main-process close prompt (electron/closeDialogWindow.ts, specs/edit-in-diff.md FR-535): the
 * second window-close with the in-app prompt open, and a hung main renderer, both show OUR window, never the OS message
 * box. Screenshots go to $CLOSE_SHOTS (or the OS temp dir).
 */
import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closeApp, launchGitHydra, removeUserDataDir, stubOpenRepoDialog, type LaunchedApp } from "../helpers/launchApp";
import { cleanup, commitAll, git, initRepo } from "../../src/test/gitFixture";

let handle: LaunchedApp;
let repoDir: string;
let shotDir: string;

test.beforeEach(async () => {
  handle = await launchGitHydra();
  shotDir = process.env.CLOSE_SHOTS ?? (await fs.mkdtemp(path.join(os.tmpdir(), "githydra-pw-closedlg-")));
  await fs.mkdir(shotDir, { recursive: true });
});
test.afterEach(async () => {
  await closeApp(handle);
  await removeUserDataDir(handle.userDataDir);
  if (repoDir) await cleanup(repoDir);
});

async function setupRepo(): Promise<void> {
  const root = process.env.GH_FIXTURE_ROOT;
  if (root) {
    repoDir = await fs.mkdtemp(path.join(root, "closedlg-"));
    await git(repoDir, ["init", "-q", "--initial-branch=main"]);
  } else repoDir = await initRepo();
  await fs.writeFile(path.join(repoDir, "a.txt"), "one\ntwo\nthree\n");
  await commitAll(repoDir, "initial work");
  await fs.writeFile(path.join(repoDir, "a.txt"), "one\nTWO\nthree\n");
}

async function dirtyEditor(): Promise<Page> {
  await setupRepo();
  const w = handle.window;
  await stubOpenRepoDialog(handle.app, repoDir);
  await w.getByRole("button", { name: "Open a repository", exact: true }).click();
  await w.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });
  await w.getByRole("button", { name: /^changes/i }).click();
  await w.locator(".gh-changes-panel__file").first().waitFor({ timeout: 15_000 });
  await w.locator("section.gh-changes-panel__section li.gh-changes-panel__file", { hasText: "a.txt" }).locator(".gh-changes-panel__file-label").click();
  await w.locator("[data-edit-button]").click();
  await expect(w.locator(".cm-content")).toBeFocused();
  await w.keyboard.press("Control+End");
  await w.keyboard.type("UNSAVED");
  await expect(w.locator(".gh-edit__state", { hasText: "Unsaved" })).toBeVisible();
  return w;
}

/** Same call the OS makes for the title-bar X: the main window (the one with no parent), never the prompt. */
const pressX = () =>
  handle.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((win) => !win.getParentWindow())!.close());
const windowCount = () => handle.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
const stubNativeBox = () =>
  handle.app.evaluate(({ dialog: d }) => {
    const g = globalThis as unknown as { __boxes: number };
    g.__boxes = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (d as any).showMessageBox = async () => {
      g.__boxes += 1;
      return { response: 1, checkboxChecked: false };
    };
  });
const nativeBoxes = () => handle.app.evaluate(() => (globalThis as unknown as { __boxes: number }).__boxes);

async function promptPage(): Promise<Page> {
  let found: Page | undefined;
  await expect
    .poll(
      async () => {
        found = handle.app.windows().find((p) => /closeDialog\.html/.test(p.url()) && !p.isClosed());
        if (!found) return "";
        const title = await found.title().catch(() => "");
        return title === "GitHydra" ? "" : title;
      },
      { timeout: 15_000 },
    )
    .not.toBe("");
  const p = found!;
  await p.waitForTimeout(400); // the page ignores input for 300 ms after it is shown
  await expect(p.getByRole("button", { name: "Keep open" })).toBeFocused();
  return p;
}

async function setTheme(w: Page, theme: "light" | "dark") {
  const current = await w.evaluate(() => document.documentElement.dataset.theme);
  if (current === theme) return;
  await w.getByRole("button", { name: "More actions" }).click();
  await w.getByRole("menuitem", { name: /switch to (light|dark) theme/i }).click();
  await expect.poll(() => w.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
}

const promptGone = async () => {
  await expect.poll(() => handle.app.windows().filter((p) => /closeDialog\.html/.test(p.url()) && !p.isClosed()).length).toBe(0);
  expect(await windowCount()).toBe(1);
};

test("second close with the in-app prompt open shows our own window (dark and light), keyboard-complete", async () => {
  const w = await dirtyEditor();
  await setTheme(w, "dark");
  await stubNativeBox();

  await pressX();
  await expect(w.getByRole("alertdialog")).toBeVisible();
  await w.screenshot({ path: path.join(shotDir, "in-app-prompt-dark.png") });
  await pressX();
  const p = await promptPage();
  expect(await p.title()).toBe("Close GitHydra?");
  expect(await windowCount()).toBe(2);

  const dlg = p.getByRole("alertdialog");
  await expect(dlg).toHaveAccessibleName("Close GitHydra?");
  await expect(dlg).toHaveAccessibleDescription(/already open in the window/);
  await p.screenshot({ path: path.join(shotDir, "close-dialog-dark.png") });
  // The three-line message must not clip or overflow the card.
  expect(await p.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);

  // Only two tabbable controls, cycling both ways.
  await p.keyboard.press("Tab");
  await expect(p.getByRole("button", { name: "Close anyway" })).toBeFocused();
  await p.keyboard.press("Tab");
  await expect(p.getByRole("button", { name: "Keep open" })).toBeFocused();
  await p.keyboard.press("Shift+Tab");
  await expect(p.getByRole("button", { name: "Close anyway" })).toBeFocused();
  await p.screenshot({ path: path.join(shotDir, "close-dialog-dark-focus-close.png") });

  // Esc = Keep open: dialog gone, app alive, the in-app prompt (and the buffer) still there.
  await p.keyboard.press("Escape").catch(() => {}); // the window is destroyed while the key is acknowledged
  await promptGone();
  await expect(w.getByRole("alertdialog")).toBeVisible();
  expect(await nativeBoxes()).toBe(0);

  // Light theme, then Enter on the default button = Keep open.
  await w.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
  await setTheme(w, "light");
  await expect(w.locator(".cm-content")).toContainText("UNSAVED");
  await pressX();
  await expect(w.getByRole("alertdialog")).toBeVisible();
  await w.screenshot({ path: path.join(shotDir, "in-app-prompt-light.png") });
  await pressX();
  const p2 = await promptPage();
  await p2.screenshot({ path: path.join(shotDir, "close-dialog-light.png") });
  await p2.keyboard.press("Enter").catch(() => {});
  await promptGone();
  expect(await nativeBoxes()).toBe(0);

  // Close anyway quits at once.
  await pressX();
  await expect(w.getByRole("alertdialog")).toBeVisible();
  const closed = new Promise((r) => handle.app.once("close", r));
  await pressX();
  const p3 = await promptPage();
  await p3.getByRole("button", { name: "Close anyway" }).click();
  await closed;
});

test("a hung main renderer still gets our window ('not responding' wording), and Close anyway works", async () => {
  const w = await dirtyEditor();
  await setTheme(w, "dark");
  await stubNativeBox();
  // Not awaited: the renderer never acknowledges the close request.
  void w.evaluate(() => {
    const t = Date.now();
    while (Date.now() - t < 120_000) {
      /* hung renderer */
    }
  }).catch(() => {});
  await new Promise((r) => setTimeout(r, 700));

  await pressX();
  const p = await promptPage();
  expect(await p.title()).toBe("GitHydra is not responding");
  await expect(p.getByRole("alertdialog")).toHaveAccessibleName("GitHydra is not responding");
  await p.screenshot({ path: path.join(shotDir, "close-dialog-unresponsive-dark.png") });
  expect(await nativeBoxes()).toBe(0);

  await p.getByRole("button", { name: "Keep open" }).click();
  await promptGone();

  const closed = new Promise((r) => handle.app.once("close", r));
  await pressX();
  const again = await promptPage();
  await again.getByRole("button", { name: "Close anyway" }).click();
  await closed;
});
