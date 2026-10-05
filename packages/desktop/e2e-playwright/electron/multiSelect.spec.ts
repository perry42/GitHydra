// SPDX-License-Identifier: GPL-3.0-or-later
/** specs/ignore-and-multiselect.md AC9, AC14, AC15 (selection model, bulk bar) in real Chromium. */
import { test, expect, type Page } from "@playwright/test";
import { closeApp, removeUserDataDir, type LaunchedApp } from "../helpers/launchApp";
import { launchApp, openChanges, refresh, rowBtn, rowLi, shot } from "../helpers/changesHelpers";
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

/** 5 untracked files u1..u5 + 3 modified tracked t1..t3. */
async function repo(): Promise<string> {
  const d = await initRepo();
  dirs.push(d);
  for (const n of ["t1", "t2", "t3"]) await writeFile(d, `${n}.txt`, "base\n");
  await commitAll(d, "base");
  for (const n of ["t1", "t2", "t3"]) await writeFile(d, `${n}.txt`, "changed\n");
  for (const n of ["u1", "u2", "u3", "u4", "u5"]) await writeFile(d, `${n}.txt`, "new\n");
  return d;
}
const sel = async (p: Page) =>
  p.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('li[role="row"][aria-selected="true"]')].map(
      (li) => li.querySelector<HTMLElement>("[data-row-key]")!.dataset.rowKey!,
    ),
  );
const st = async (d: string) => (await git(d, ["status", "--porcelain", "-uall"])).stdout;

test("plain click selects exactly one row and opens its diff", async () => {
  const d = await repo();
  await openChanges(h, d);
  await rowBtn(h.window, "untracked", "u1.txt").click();
  expect(await sel(h.window)).toEqual(["untracked:u1.txt"]);
  await expect(h.window.getByText("new").first()).toBeVisible();
  await rowBtn(h.window, "untracked", "u3.txt").click();
  expect(await sel(h.window)).toEqual(["untracked:u3.txt"]);
});

test("Ctrl-click toggles rows", async () => {
  const d = await repo();
  await openChanges(h, d);
  await rowBtn(h.window, "untracked", "u1.txt").click();
  await rowBtn(h.window, "untracked", "u3.txt").click({ modifiers: ["Control"] });
  await rowBtn(h.window, "unstaged", "t2.txt").click({ modifiers: ["Control"] });
  expect((await sel(h.window)).sort()).toEqual(["unstaged:t2.txt", "untracked:u1.txt", "untracked:u3.txt"]);
  await rowBtn(h.window, "untracked", "u3.txt").click({ modifiers: ["Control"] });
  expect((await sel(h.window)).sort()).toEqual(["unstaged:t2.txt", "untracked:u1.txt"]);
});

test("Shift-click selects the anchor-to-target range and does not text-select", async () => {
  const d = await repo();
  await openChanges(h, d);
  await rowBtn(h.window, "untracked", "u1.txt").click();
  await rowBtn(h.window, "untracked", "u4.txt").click({ modifiers: ["Shift"] });
  expect((await sel(h.window)).sort()).toEqual(["untracked:u1.txt", "untracked:u2.txt", "untracked:u3.txt", "untracked:u4.txt"]);
  const textSel = await h.window.evaluate(() => window.getSelection()?.toString() ?? "");
  expect(textSel).toBe("");
});

test("Shift+Arrow extends, Ctrl+A selects the section, Space toggles, Esc clears", async () => {
  const d = await repo();
  await openChanges(h, d);
  await rowBtn(h.window, "untracked", "u1.txt").click();
  await h.window.keyboard.press("Shift+ArrowDown");
  await h.window.keyboard.press("Shift+ArrowDown");
  expect((await sel(h.window)).sort()).toEqual(["untracked:u1.txt", "untracked:u2.txt", "untracked:u3.txt"]);
  await h.window.keyboard.press("Space");
  expect((await sel(h.window)).sort()).toEqual(["untracked:u1.txt", "untracked:u2.txt"]);
  // Space must only toggle selection: nothing staged, nothing activated.
  expect(await st(d)).not.toMatch(/^A /m);
  await h.window.keyboard.press("Control+a");
  expect((await sel(h.window)).length).toBe(5);
  await h.window.keyboard.press("Escape");
  expect(await sel(h.window)).toEqual([]);
});

test("Space on a row toggles selection and does not click it (no diff change, no stage)", async () => {
  const d = await repo();
  await openChanges(h, d);
  await rowBtn(h.window, "untracked", "u1.txt").focus();
  await h.window.keyboard.press("Space");
  expect(await sel(h.window)).toEqual(["untracked:u1.txt"]);
  await h.window.keyboard.press("Space");
  expect(await sel(h.window)).toEqual([]);
  expect(await st(d)).not.toMatch(/^A /m);
});

test("Arrow keys move focus across the rows and sections, Home/End jump", async () => {
  const d = await repo();
  await openChanges(h, d);
  await rowBtn(h.window, "unstaged", "t1.txt").focus();
  await h.window.keyboard.press("ArrowDown");
  await expect(rowBtn(h.window, "unstaged", "t2.txt")).toBeFocused();
  await h.window.keyboard.press("End");
  await expect(rowBtn(h.window, "untracked", "u5.txt")).toBeFocused();
  await h.window.keyboard.press("Home");
  await expect(rowBtn(h.window, "unstaged", "t1.txt")).toBeFocused();
});

test("Menu key and Shift+F10 on a focused row open the same context menu (FR-503)", async () => {
  const d = await repo();
  await openChanges(h, d);
  await rowBtn(h.window, "untracked", "u1.txt").focus();
  await h.window.keyboard.press("ContextMenu");
  const menuViaKey = await h.window.getByRole("menu").count();
  await h.window.keyboard.press("Escape");
  await rowBtn(h.window, "untracked", "u1.txt").focus();
  await h.window.keyboard.press("Shift+F10");
  const menuViaShiftF10 = await h.window.getByRole("menu").count();
  console.log("MENU KEY menus:", menuViaKey, "SHIFT+F10 menus:", menuViaShiftF10);
  expect(menuViaKey).toBe(1);
  expect(menuViaShiftF10).toBe(1);
});

test("Ignore row button is keyboard reachable and opens the same menu; focus returns to the invoking button on Escape", async () => {
  const d = await repo();
  await openChanges(h, d);
  const btn = h.window.getByRole("button", { name: "Ignore u1.txt…" });
  await btn.focus();
  await h.window.keyboard.press("Enter");
  await expect(h.window.getByRole("menu")).toBeVisible();
  await h.window.keyboard.press("Escape");
  await expect(h.window.getByRole("menu")).toHaveCount(0);
  // specs/ignore-and-multiselect.md FR-513: focus returns to the invoking Ignore button.
  await expect(btn).toBeFocused();
});

test("bulk bar appears at 2+ selected, not at 1; Stage N stages exactly the selected untracked+unstaged", async () => {
  const d = await repo();
  await openChanges(h, d);
  await rowBtn(h.window, "untracked", "u1.txt").click();
  await expect(h.window.getByRole("toolbar", { name: /actions for/i })).toHaveCount(0);
  await rowBtn(h.window, "untracked", "u2.txt").click({ modifiers: ["Control"] });
  await rowBtn(h.window, "unstaged", "t1.txt").click({ modifiers: ["Control"] });
  const bar = h.window.getByRole("toolbar", { name: /actions for 3 selected files/i });
  await expect(bar).toBeVisible();
  await expect(bar.getByRole("button", { name: /^unstage 0/i })).toBeDisabled();
  await bar.getByRole("button", { name: /^stage 3/i }).click();
  await expect(h.window.getByText(/staged 3 files/i)).toBeVisible();
  const s = await st(d);
  expect(s).toContain("A  u1.txt");
  expect(s).toContain("A  u2.txt");
  expect(s).toContain("M  t1.txt");
  expect(s).toContain(" M t2.txt");
  expect(s).toContain("?? u3.txt");
});

test("bulk bar Unstage with mixed selection reports N skipped before running; Unstage touches only staged rows", async () => {
  const d = await repo();
  await git(d, ["add", "u1.txt", "u2.txt"]);
  await openChanges(h, d);
  await rowBtn(h.window, "staged", "u1.txt").click();
  await rowBtn(h.window, "staged", "u2.txt").click({ modifiers: ["Control"] });
  await rowBtn(h.window, "untracked", "u3.txt").click({ modifiers: ["Control"] });
  const bar = h.window.getByRole("toolbar", { name: /actions for/i });
  const unstage = bar.getByRole("button", { name: /^unstage 2/i });
  await expect(unstage).toContainText("1 skipped");
  await unstage.click();
  await expect(h.window.getByText(/unstaged 2 files, 1 skipped/i)).toBeVisible();
  expect(await st(d)).not.toMatch(/^A /m);
});

test("AC15 conflicted rows are skipped from bulk actions with a count shown before the action", async () => {
  const d = await initRepo();
  dirs.push(d);
  await writeFile(d, "c.txt", "base\n");
  await commitAll(d, "base");
  await git(d, ["checkout", "-qb", "other"]);
  await writeFile(d, "c.txt", "other\n");
  await commitAll(d, "other");
  await git(d, ["checkout", "-q", "main"]);
  await writeFile(d, "c.txt", "main\n");
  await commitAll(d, "main");
  await git(d, ["merge", "other"]).catch(() => {});
  await writeFile(d, "n1.txt", "x\n");
  await writeFile(d, "n2.txt", "x\n");
  await openChanges(h, d);
  await rowBtn(h.window, "conflicted", "c.txt").click();
  await rowBtn(h.window, "untracked", "n1.txt").click({ modifiers: ["Control"] });
  await rowBtn(h.window, "untracked", "n2.txt").click({ modifiers: ["Control"] });
  const bar = h.window.getByRole("toolbar", { name: /actions for 3 selected files/i });
  for (const a of [/^stage 2/i, /^discard 2/i, /^ignore 2/i]) {
    await expect(bar.getByRole("button", { name: a })).toContainText("1 skipped");
  }
  await expect(bar.getByRole("button", { name: /^unstage 0/i })).toBeDisabled();
  await shot(h.window, "bulk-bar-conflicted-skipped");
});

test("AC13 selection survives live refresh: externally staged file stays selected in Staged; vanished file drops", async () => {
  const d = await repo();
  await openChanges(h, d);
  await rowBtn(h.window, "untracked", "u1.txt").click();
  await rowBtn(h.window, "untracked", "u2.txt").click({ modifiers: ["Control"] });
  await rowBtn(h.window, "untracked", "u3.txt").click({ modifiers: ["Control"] });
  await git(d, ["add", "u1.txt"]);
  await (await import("node:fs/promises")).rm(`${d}/u2.txt`);
  await refresh(h.window);
  await expect(rowBtn(h.window, "staged", "u1.txt")).toBeVisible({ timeout: 10_000 });
  await expect(rowBtn(h.window, "untracked", "u2.txt")).toHaveCount(0);
  expect((await sel(h.window)).sort()).toEqual(["staged:u1.txt", "untracked:u3.txt"]);
  await expect(rowLi(h.window, "staged", "u1.txt")).toHaveAttribute("aria-selected", "true");
  await expect(h.window.getByRole("toolbar", { name: /actions for 2 selected files/i })).toBeVisible();
});

test("right-click on an UNSELECTED row while other rows are selected opens the menu for that row alone", async () => {
  const d = await repo();
  await openChanges(h, d);
  await rowBtn(h.window, "untracked", "u1.txt").click({ position: { x: 8, y: 8 } });
  await rowBtn(h.window, "untracked", "u2.txt").click({ modifiers: ["Control"], position: { x: 8, y: 8 } });
  await rowBtn(h.window, "untracked", "u4.txt").click({ button: "right", position: { x: 8, y: 8 } });
  await expect(h.window.getByRole("menu")).toBeVisible();
  expect(await sel(h.window)).toEqual(["untracked:u4.txt"]);
});

test("right-click on a selected row of a multi-selection opens the bulk menu for the whole selection", async () => {
  const d = await repo();
  await openChanges(h, d);
  await rowBtn(h.window, "untracked", "u1.txt").click({ position: { x: 8, y: 8 } });
  await rowBtn(h.window, "untracked", "u2.txt").click({ modifiers: ["Control"], position: { x: 8, y: 8 } });
  await rowBtn(h.window, "untracked", "u2.txt").click({ button: "right", position: { x: 8, y: 8 } });
  await expect(h.window.getByRole("menuitem", { name: /^stage 2 files/i })).toBeVisible();
});

test("right-click on an unselected row when only ONE row is selected (no bulk bar) opens the menu", async () => {
  const d = await repo();
  await openChanges(h, d);
  await rowBtn(h.window, "untracked", "u1.txt").click({ position: { x: 8, y: 8 } });
  await rowBtn(h.window, "untracked", "u4.txt").click({ button: "right", position: { x: 8, y: 8 } });
  await expect(h.window.getByRole("menu")).toBeVisible();
});
