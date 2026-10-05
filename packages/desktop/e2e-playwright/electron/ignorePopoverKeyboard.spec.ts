// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * specs/ignore-and-multiselect.md FR-516, FR-524, AC19, AC27 in the real built app, with REAL keyboard events only (no mouse after the
 * panel opens): the Ignore popover must be fully operable without a pointer.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test, expect } from "@playwright/test";
import { closeApp, removeUserDataDir, type LaunchedApp } from "../helpers/launchApp";
import { ignorePopover, launchApp, openChanges, popoverReady, rowBtn, rowLi } from "../helpers/changesHelpers";
import { cleanup, commitAll, git, initRepo, writeFile } from "../../src/test/gitFixture";

let h: LaunchedApp;
const dirs: string[] = [];
test.beforeEach(async () => {
  h = await launchApp();
});
test.afterEach(async () => {
  await closeApp(h);
  await removeUserDataDir(h.userDataDir);
  while (dirs.length) await cleanup(dirs.pop()!);
});

async function repo(): Promise<string> {
  const d = await initRepo();
  dirs.push(d);
  await writeFile(d, "README.md", "base\n");
  await commitAll(d, "base");
  await writeFile(d, "build/a.log", "x\n");
  await writeFile(d, "build/b.log", "x\n");
  await writeFile(d, "build/c.txt", "x\n");
  return d;
}
const read = async (d: string, p: string) => (await fs.readFile(path.join(d, p))).toString();

for (const key of ["ContextMenu", "Shift+F10"] as const) {
  test(`AC19 keyboard only via ${key}: pick scope with arrows, change Add to, Enter writes, focus lands on a surviving row`, async () => {
    const d = await repo();
    await openChanges(h, d);
    await rowBtn(h.window, "untracked", "build/a.log").focus();
    await h.window.keyboard.press(key);
    await expect(h.window.getByRole("menu")).toBeVisible();
    // The menu focuses its first enabled item; Blame is disabled for an untracked file, so that is Ignore….
    await expect(h.window.getByRole("menuitem", { name: "Ignore…" })).toBeFocused();
    await h.window.keyboard.press("Enter");
    const pop = ignorePopover(h.window);
    await popoverReady(h.window);
    await expect(pop.getByRole("radio", { name: /^This file/ })).toBeFocused();
    await h.window.keyboard.press("ArrowDown");
    await expect(pop.getByRole("radio", { name: /All \*\.log files/ })).toBeChecked();
    await expect(pop.locator("[aria-live=polite]")).toContainText("Hides 2 files. Adds *.log to .gitignore (new file).");
    // Tab to the destination select and change it with the arrow keys.
    await h.window.keyboard.press("Tab");
    await expect(pop.getByRole("combobox", { name: "Add to" })).toBeFocused();
    await h.window.keyboard.press("ArrowDown");
    await expect(pop.getByRole("combobox", { name: "Add to" })).toHaveValue("nearest");
    await h.window.keyboard.press("ArrowUp");
    await popoverReady(h.window);
    // Enter from the select activates the primary.
    await h.window.keyboard.press("Enter");
    await expect(pop).toHaveCount(0);
    expect(await read(d, ".gitignore")).toBe("*.log\n");
    await expect(h.window.getByText(/Added \*\.log to \.gitignore/)).toBeVisible();
    // Focus lands on a surviving row, never on <body>.
    await expect.poll(() => h.window.evaluate(() => document.activeElement?.getAttribute("data-row-key") ?? document.activeElement?.tagName)).toMatch(/^(untracked|unstaged|staged):/);
  });
}

test("AC19 Escape writes nothing and returns focus to the invoking row", async () => {
  const d = await repo();
  await openChanges(h, d);
  const row = rowBtn(h.window, "untracked", "build/c.txt");
  await row.focus();
  await h.window.keyboard.press("ContextMenu");
  await h.window.keyboard.press("Enter");
  await popoverReady(h.window);
  await h.window.keyboard.press("Escape");
  await expect(ignorePopover(h.window)).toHaveCount(0);
  await expect(row).toBeFocused();
  await expect(fs.access(path.join(d, ".gitignore"))).rejects.toBeTruthy();
});

test("FR-524 Tab and Shift+Tab cycle inside the popover (radio, Add to, Cancel, Ignore) and never leave it", async () => {
  const d = await repo();
  await openChanges(h, d);
  await rowBtn(h.window, "untracked", "build/a.log").focus();
  await h.window.keyboard.press("ContextMenu");
  await h.window.keyboard.press("Enter");
  await popoverReady(h.window);
  const pop = ignorePopover(h.window);
  const order = [
    pop.getByRole("radio", { name: /^This file/ }),
    pop.getByRole("combobox", { name: "Add to" }),
    pop.getByRole("button", { name: "Cancel" }),
    pop.getByRole("button", { name: "Ignore", exact: true }),
  ];
  await expect(order[0]!).toBeFocused();
  for (const next of [order[1]!, order[2]!, order[3]!, order[0]!]) {
    await h.window.keyboard.press("Tab");
    await expect(next).toBeFocused();
  }
  await h.window.keyboard.press("Shift+Tab");
  await expect(order[3]!).toBeFocused();
  // Enter on Cancel cancels; Enter elsewhere does not hijack a focused button.
  await h.window.keyboard.press("Shift+Tab");
  await expect(order[2]!).toBeFocused();
  await h.window.keyboard.press("Enter");
  await expect(pop).toHaveCount(0);
});

test("AC19 Command Palette 'Ignore selected file(s)…' opens the popover; focus returns to a row on Escape", async () => {
  const d = await repo();
  await openChanges(h, d);
  const row = rowBtn(h.window, "untracked", "build/a.log");
  await row.click({ position: { x: 8, y: 8 } });
  await h.window.keyboard.press("Control+k");
  await h.window.getByRole("combobox", { name: /command palette/i }).fill("Ignore selected");
  await h.window.keyboard.press("Enter");
  const pop = ignorePopover(h.window);
  await popoverReady(h.window);
  await expect(pop.getByRole("radio", { name: /^This file/ })).toBeFocused();
  await h.window.keyboard.press("Escape");
  await expect(pop).toHaveCount(0);
  await expect(row).toBeFocused();
});

test("AC20 tracked file: Enter from the scope radio runs 'Ignore and stop tracking' (primary); the file list is collapsed by default", async () => {
  const d = await initRepo();
  dirs.push(d);
  await writeFile(d, "t.txt", "a\n");
  await commitAll(d, "t");
  await writeFile(d, "t.txt", "b\n");
  await openChanges(h, d);
  await rowBtn(h.window, "unstaged", "t.txt").focus();
  await h.window.keyboard.press("ContextMenu");
  await h.window.getByRole("menuitem", { name: "Ignore…" }).focus();
  await h.window.keyboard.press("Enter");
  await popoverReady(h.window);
  const pop = ignorePopover(h.window);
  await expect(pop.getByRole("button", { name: "Show 1 file" })).toHaveAttribute("aria-expanded", "false");
  await expect(pop.getByRole("list", { name: "Files that become staged deletions" })).toBeHidden();
  await expect(pop.getByRole("button", { name: "Ignore only" })).toBeVisible();
  await expect(pop.getByRole("radio", { name: /^This file/ })).toBeFocused();
  await h.window.keyboard.press("Enter");
  await expect(pop).toHaveCount(0);
  expect((await git(d, ["status", "--porcelain"])).stdout).toContain("D  t.txt");
  expect(await read(d, "t.txt")).toBe("b\n");
  await expect(rowLi(h.window, "staged", "t.txt")).toHaveCount(1);
});
