// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Real-Electron check of specs/edit-in-diff.md slice D: the dirty-leave guard on every path (FR-535, ship gate M1), the
 * main-process close interception, the transient drawer widening + file-column rail (FR-532), and the palette and
 * context-menu entries (FR-533/FR-534). Screenshots go to $EDIT_SHOTS (or the OS temp dir).
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
const STORED_KEY = "githydra:layout:changesPanelWidth";

test.beforeEach(async () => {
  handle = await launchGitHydra();
  shotDir = process.env.EDIT_SHOTS ?? (await fs.mkdtemp(path.join(os.tmpdir(), "githydra-pw-guards-")));
  await fs.mkdir(shotDir, { recursive: true });
});
test.afterEach(async () => {
  await closeApp(handle);
  await removeUserDataDir(handle.userDataDir);
  if (repoDir) await cleanup(repoDir);
});

async function makeRepo(): Promise<string> {
  const root = process.env.GH_FIXTURE_ROOT;
  if (!root) return initRepo();
  const dir = await fs.mkdtemp(path.join(root, "guards-"));
  await git(dir, ["init", "-q", "--initial-branch=main"]);
  return dir;
}

const put = (rel: string, data: string) => fs.writeFile(path.join(repoDir, rel), data);
const disk = (rel: string) => fs.readFile(path.join(repoDir, rel), "utf8");
const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line${String(i + 1).padStart(2, "0")}`);

/** Two tracked files, both modified, and a commit with a recognisable subject for the graph. */
async function setupRepo() {
  repoDir = await makeRepo();
  const base = numbered(90);
  await put("a.txt", base.join("\n") + "\n");
  await put("b.txt", "b1\nb2\n");
  await commitAll(repoDir, "initial work");
  const edited = [...base];
  edited[3] = "CHANGED04";
  await put("a.txt", edited.join("\n") + "\n");
  await put("b.txt", "b1\nB2\n");
}

async function resizeWindow(width: number, height: number) {
  await handle.app.evaluate(({ BrowserWindow }, [w, h]) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    if (win.isMaximized()) win.unmaximize();
    win.setContentSize(w!, h!);
  }, [width, height]);
  await handle.window.waitForTimeout(400);
}

async function openRepoInApp(): Promise<Page> {
  const w = handle.window;
  await stubOpenRepoDialog(handle.app, repoDir);
  await w.getByRole("button", { name: "Open a repository", exact: true }).click();
  await w.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });
  await w.getByRole("button", { name: /^changes/i }).click();
  await w.locator(".gh-changes-panel__file").first().waitFor({ timeout: 15_000 });
  return w;
}

async function setTheme(w: Page, theme: "light" | "dark") {
  const current = await w.evaluate(() => document.documentElement.dataset.theme);
  if (current === theme) return;
  await w.getByRole("button", { name: "More actions" }).click();
  await w.getByRole("menuitem", { name: /switch to (light|dark) theme/i }).click();
  await expect.poll(() => w.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
}

const rowLabel = (w: Page, p: string) =>
  w
    .locator("section.gh-changes-panel__section", { has: w.locator("h3", { hasText: /^Unstaged/ }) })
    .locator("li.gh-changes-panel__file", { hasText: p })
    .locator(".gh-changes-panel__file-label");
const editBtn = (w: Page) => w.locator("[data-edit-button]");
const cm = (w: Page) => w.locator(".cm-content");
const dialog = (w: Page) => w.getByRole("alertdialog");

async function selectAndEdit(w: Page, p: string) {
  await rowLabel(w, p).click();
  await expect(editBtn(w)).toBeEnabled();
  await editBtn(w).click();
  await expect(cm(w)).toBeVisible();
  await expect(cm(w)).toBeFocused();
}

async function dirtyEditor(): Promise<Page> {
  await setupRepo();
  const w = await openRepoInApp();
  await selectAndEdit(w, "a.txt");
  await w.keyboard.press("Control+End");
  await w.keyboard.type("UNSAVED");
  await expect(w.locator(".gh-edit__state", { hasText: "Unsaved" })).toBeVisible();
  return w;
}

async function expectStillEditing(w: Page) {
  await expect(dialog(w)).toHaveCount(0);
  await expect(cm(w)).toBeVisible();
  await expect(cm(w)).toContainText("UNSAVED");
  await expect(w.locator(".gh-edit__state", { hasText: "Unsaved" })).toBeVisible();
}

async function cancelPrompt(w: Page) {
  const dlg = dialog(w);
  await expect(dlg).toBeVisible();
  await expect(dlg.getByRole("button", { name: "Save", exact: true })).toBeFocused();
  await dlg.getByRole("button", { name: "Cancel" }).click();
  await expectStillEditing(w);
}

const closeTabBtn = (w: Page) => w.getByRole("button", { name: /^Close .* tab$/ });
const diskUnchanged = async () => expect(await disk("a.txt")).not.toContain("UNSAVED");

test.describe("every path that would drop a dirty buffer asks first (M1)", () => {
  test("closing the repo tab: Cancel keeps tab and buffer, Discard closes it and leaves the file alone", async () => {
    const w = await dirtyEditor();
    await closeTabBtn(w).click();
    await cancelPrompt(w);
    await expect(w.getByRole("tab")).toHaveCount(1);

    await closeTabBtn(w).click();
    await dialog(w).getByRole("button", { name: "Discard" }).click();
    await expect(w.getByRole("tab")).toHaveCount(0);
    await diskUnchanged();
  });

  test("'+ New tab' asks; Cancel keeps everything, Discard lands on the empty state", async () => {
    const w = await dirtyEditor();
    await w.getByRole("button", { name: "Open a repository in a new tab" }).click();
    await cancelPrompt(w);
    await w.getByRole("button", { name: "Open a repository in a new tab" }).click();
    await dialog(w).getByRole("button", { name: "Discard" }).click();
    await expect(w.getByRole("button", { name: "Open a repository", exact: true })).toBeVisible();
    await diskUnchanged();
  });

  test("selecting a commit in the graph asks before the drawer is replaced", async () => {
    const w = await dirtyEditor();
    await w.getByText("initial work", { exact: true }).first().click();
    await cancelPrompt(w);
    await w.getByText("initial work", { exact: true }).first().click();
    await dialog(w).getByRole("button", { name: "Discard" }).click();
    await expect(w.getByRole("complementary", { name: "Commit details" })).toBeVisible();
    await diskUnchanged();
  });

  test("closing the Changes drawer (x and toolbar toggle) asks", async () => {
    const w = await dirtyEditor();
    await w.getByRole("button", { name: "Close changes panel" }).click();
    await cancelPrompt(w);
    await w.getByRole("button", { name: /^changes/i }).click();
    await cancelPrompt(w);
    await w.getByRole("button", { name: /^stashes/i }).click();
    await cancelPrompt(w);
  });

  test("Blame from the row menu, and Ctrl+Tab style tab commands, ask", async () => {
    const w = await dirtyEditor();
    await rowLabel(w, "b.txt").click({ button: "right" });
    await w.getByRole("menuitem", { name: "Blame" }).click();
    await cancelPrompt(w);
    await w.keyboard.press("Control+k");
    await w.getByRole("dialog").getByRole("combobox").fill("Close current tab");
    await w.keyboard.press("Enter");
    await cancelPrompt(w);
  });

  test("Save in the prompt writes the file and then lets the tab close", async () => {
    const w = await dirtyEditor();
    await closeTabBtn(w).click();
    await dialog(w).getByRole("button", { name: "Save", exact: true }).click();
    await expect(w.getByRole("tab")).toHaveCount(0);
    expect(await disk("a.txt")).toContain("UNSAVED");
  });

  test("Stage all / Unstage all with a dirty buffer are allowed and never touch the editor's text", async () => {
    const w = await dirtyEditor();
    // The section buttons live in the rail's expanded overlay: hover (or focus) the rail first, as a user would.
    await w.getByRole("region", { name: "Changed files" }).hover();
    await w.getByRole("button", { name: "Stage all", exact: true }).click();
    await expect.poll(async () => (await git(repoDir, ["status", "--porcelain"])).stdout).toContain("M  a.txt");
    await expectStillEditing(w);
    await w.getByRole("region", { name: "Changed files" }).hover();
    await w.getByRole("button", { name: "Unstage all", exact: true }).click();
    await expect.poll(async () => (await git(repoDir, ["status", "--porcelain"])).stdout).not.toContain("M  a.txt");
    await expectStillEditing(w);
    await diskUnchanged();
  });
});

test.describe("closing the app (main-process interception)", () => {
  const closeWindow = () => handle.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
  const windowCount = () => handle.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

  test("a clean app closes at once", async () => {
    await setupRepo();
    await openRepoInApp();
    const closed = new Promise((r) => handle.app.once("close", r));
    await closeWindow();
    await closed;
  });

  test("dirty: the window stays and shows the prompt; Cancel keeps it open; Discard closes the app", async () => {
    const w = await dirtyEditor();
    await closeWindow();
    await expect(dialog(w)).toBeVisible();
    await expect(dialog(w).getByRole("button", { name: "Save", exact: true })).toBeFocused();
    await dialog(w).getByRole("button", { name: "Cancel" }).click();
    await expectStillEditing(w);
    expect(await windowCount()).toBe(1);
    await w.waitForTimeout(6000);
    expect(await windowCount()).toBe(1);

    const closed = new Promise((r) => handle.app.once("close", r));
    await closeWindow();
    await dialog(w).getByRole("button", { name: "Discard" }).click();
    await closed;
    await diskUnchanged();
  });

  test("dirty: Save in the prompt writes the file, then the app closes", async () => {
    const w = await dirtyEditor();
    const closed = new Promise((r) => handle.app.once("close", r));
    await closeWindow();
    await dialog(w).getByRole("button", { name: "Save", exact: true }).click();
    await closed;
    expect(await disk("a.txt")).toContain("UNSAVED");
  });

  /** The main-process close prompt (closeDialogWindow.ts) is its own window; answer it by button name. */
  const answerPrompt = async (button: "Close anyway" | "Keep open") => {
    let page: Page | undefined;
    await expect
      .poll(() => (page = handle.app.windows().find((p) => /closeDialog\.html/.test(p.url()) && !p.isClosed())) !== undefined, { timeout: 15_000 })
      .toBe(true);
    await page!.waitForTimeout(400); // the page ignores input for 300 ms after it is shown
    await expect(page!.getByRole("button", { name: button })).toBeVisible();
    await page!.getByRole("button", { name: button }).click();
  };
  const hangRenderer = async (w: Page) => {
    void w
      .evaluate(() => {
        const t = Date.now();
        while (Date.now() - t < 120_000) {
          /* hung renderer */
        }
      })
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 700));
  };

  test("a renderer that is already hung cannot make the app unclosable: after 5 s our close prompt decides, never a silent close", async () => {
    const w = await dirtyEditor();
    await hangRenderer(w);
    await closeWindow();
    await answerPrompt("Keep open");
    // "Keep open" was answered: the window is still there, and the user can try again.
    await expect.poll(windowCount).toBe(1);
    const closed = new Promise((r) => handle.app.once("close", r));
    await closeWindow();
    await answerPrompt("Close anyway");
    await closed;
  });

  test("a renderer that hangs after showing the prompt is still escapable: the next close attempt re-arms the 5 s wait", async () => {
    const w = await dirtyEditor();
    await closeWindow();
    await expect(dialog(w)).toBeVisible();
    await hangRenderer(w);
    const closed = new Promise((r) => handle.app.once("close", r));
    await closeWindow();
    // Our prompt appears at once for a second attempt; the app ends only after "Close anyway".
    await answerPrompt("Close anyway");
    await closed;
  });
});

test.describe("layout while editing (FR-532)", () => {
  const panelBox = (w: Page) => w.locator(".gh-changes-panel").boundingBox();
  const storedWidth = (w: Page) => w.evaluate((k) => window.localStorage.getItem(k), STORED_KEY);
  const filesBox = (w: Page) => w.locator(".gh-changes-panel__files").boundingBox();
  const editorBox = (w: Page) => w.locator(".gh-edit").boundingBox();
  const visibleLines = (w: Page) =>
    w.evaluate(() => {
      const sc = document.querySelector<HTMLElement>(".cm-scroller")!;
      const line = document.querySelector<HTMLElement>(".cm-line")!;
      return sc.clientHeight / line.getBoundingClientRect().height;
    });

  for (const [width, height] of [[1400, 900], [900, 700]] as const) {
    test(`${width}x${height}: drawer widens to up to 80vw, the file column is a 44px rail that overlays on hover and focus, and everything is restored afterwards`, async () => {
      await setupRepo();
      await resizeWindow(width, height);
      const w = await openRepoInApp();
      await w.mouse.move(2, 2);
      const before = (await panelBox(w))!.width;
      const storedBefore = await storedWidth(w);
      const filesBefore = (await filesBox(w))!.width;
      await w.locator("#gh-commit-subject").fill("wip: half written");
      await setTheme(w, "dark");
      await w.screenshot({ path: path.join(shotDir, `${width}-dark-before.png`) });

      await selectAndEdit(w, "a.txt");
      await w.mouse.move(2, 2);
      await w.waitForTimeout(500);
      const widened = (await panelBox(w))!.width;
      expect(widened).toBeGreaterThan(before);
      expect(widened).toBeLessThanOrEqual(width * 0.8 + 1);
      expect(await storedWidth(w)).toBe(storedBefore);

      // Rail by width only: mounted, laid out, 44px wide, rows still there.
      const rail = w.getByRole("region", { name: "Changed files" });
      await expect(rail).toBeVisible();
      expect(Math.round((await filesBox(w))!.width)).toBe(44);
      await expect(w.locator(".gh-changes-panel__file")).toHaveCount(2);
      const editorCollapsed = (await editorBox(w))!;
      if (width === 1400) expect(await visibleLines(w)).toBeGreaterThanOrEqual(28);
      await w.screenshot({ path: path.join(shotDir, `${width}-dark-rail.png`) });

      // Hover expands as an overlay: the editor does not move or resize.
      await rail.hover();
      await expect.poll(async () => (await filesBox(w))!.width).toBeGreaterThan(200);
      const editorHover = (await editorBox(w))!;
      expect(editorHover.x).toBe(editorCollapsed.x);
      expect(editorHover.width).toBe(editorCollapsed.width);
      await w.screenshot({ path: path.join(shotDir, `${width}-dark-rail-hover.png`) });

      // Keyboard focus expands it too, and roving arrow focus works inside it.
      await w.mouse.move(2, 2);
      await expect.poll(async () => Math.round((await filesBox(w))!.width)).toBe(44);
      await rowLabel(w, "a.txt").focus();
      await w.keyboard.press("ArrowDown");
      await expect.poll(async () => (await filesBox(w))!.width).toBeGreaterThan(200);
      await expect(rowLabel(w, "b.txt")).toBeFocused();
      expect((await editorBox(w))!.width).toBe(editorCollapsed.width);

      // A mouse click on a row does not pin the overlay open over the editor: leaving with the pointer collapses it again.
      await rowLabel(w, "a.txt").click();
      await w.mouse.move(2, 2);
      await expect.poll(async () => Math.round((await filesBox(w))!.width)).toBe(44);

      // The commit message and the editor survived all of that; the dirty dot is readable on the rail.
      await w.mouse.move(2, 2);
      await cm(w).click();
      await w.keyboard.press("Control+End");
      await w.keyboard.type("dirty");
      await expect(w.locator(".gh-changes-panel__unsaved-dot")).toBeVisible();
      await expect(w.locator("#gh-commit-subject")).toHaveValue("wip: half written");
      await setTheme(w, "light");
      await w.waitForTimeout(300);
      await w.screenshot({ path: path.join(shotDir, `${width}-light-rail-dirty.png`) });
      await rowLabel(w, "a.txt").focus();
      await w.keyboard.press("ArrowDown");
      await w.waitForTimeout(400);
      await w.screenshot({ path: path.join(shotDir, `${width}-light-rail-focus.png`) });
      await cm(w).focus();

      // Leaving restores the previous width and column exactly.
      await w.keyboard.press("Control+s");
      await expect(w.locator(".gh-edit__state--saved")).toBeVisible();
      await w.getByRole("button", { name: "Back to diff", exact: true }).click();
      await expect(cm(w)).toHaveCount(0);
      await w.mouse.move(2, 2);
      await w.waitForTimeout(300);
      expect(Math.round((await panelBox(w))!.width)).toBe(Math.round(before));
      expect(Math.round((await filesBox(w))!.width)).toBe(Math.round(filesBefore));
      expect(await storedWidth(w)).toBe(storedBefore);
      await expect(w.locator("#gh-commit-subject")).toHaveValue("wip: half written");
      await setTheme(w, "dark");
    });
  }

  test("reduced motion: the rail does not animate", async () => {
    await setupRepo();
    await handle.window.emulateMedia({ reducedMotion: "reduce" });
    const w = await openRepoInApp();
    await selectAndEdit(w, "a.txt");
    const transition = await w.locator(".gh-changes-panel__files").evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(transition.split(",").every((t) => parseFloat(t) === 0)).toBe(true);
  });
});

test.describe("palette and context menu (FR-533, FR-534)", () => {
  test("Edit file / Save / Save and stage from the palette, disabled with a reason until they can run", async () => {
    await setupRepo();
    const w = await openRepoInApp();
    await rowLabel(w, "a.txt").click();
    await expect(editBtn(w)).toBeEnabled();

    await w.keyboard.press("Control+k");
    const pal = w.getByRole("dialog");
    await pal.getByRole("combobox").fill("Save");
    await expect(pal.getByRole("option", { name: /^Save and stage/ })).toHaveAttribute("aria-disabled", "true");
    await expect(pal).toContainText("Open a file for editing first.");
    await w.screenshot({ path: path.join(shotDir, "palette-disabled.png") });
    await pal.getByRole("combobox").fill("Edit file");
    await w.keyboard.press("Enter");
    await expect(cm(w)).toBeVisible();
    await w.keyboard.type("P");

    await w.keyboard.press("Control+k");
    await w.getByRole("dialog").getByRole("combobox").fill("Save and stage");
    await w.keyboard.press("Enter");
    await expect.poll(async () => (await git(repoDir, ["status", "--porcelain"])).stdout).toContain("M  a.txt");
    expect(await disk("a.txt")).toContain("P");
  });

  test("the row menu offers Edit file on one row only, with the reason when ineligible", async () => {
    await setupRepo();
    await put("bin.dat", "x\u0000y");
    await git(repoDir, ["add", "-N", "bin.dat"]).catch(() => {});
    const w = await openRepoInApp();
    await rowLabel(w, "a.txt").click({ button: "right" });
    const item = w.getByRole("menuitem", { name: "Edit file" });
    await expect(item).toBeEnabled();
    await w.screenshot({ path: path.join(shotDir, "row-menu.png") });
    await item.click();
    await expect(w.getByRole("textbox", { name: "Editing a.txt" })).toBeVisible();
    // The pointer is still over the rail, whose overlay covers the editor header's left edge until the pointer leaves it.
    await w.mouse.move(2, 450);
    await w.getByRole("button", { name: "Back to diff", exact: true }).click();

    await rowLabel(w, "a.txt").click();
    await rowLabel(w, "b.txt").click({ modifiers: ["Control"] });
    await rowLabel(w, "b.txt").click({ button: "right" });
    await expect(w.getByRole("menuitem", { name: "Edit file" })).toHaveCount(0);
    await w.keyboard.press("Escape");

    const bin = w.locator("li.gh-changes-panel__file", { hasText: "bin.dat" }).locator(".gh-changes-panel__file-label");
    if (await bin.count()) {
      await bin.first().click({ button: "right" });
      const binItem = w.getByRole("menuitem", { name: "Edit file" });
      await expect(binItem).toBeDisabled();
      await expect(binItem).toHaveAttribute("title", /\S/);
    }
  });
});
