// SPDX-License-Identifier: GPL-3.0-or-later
/** specs/ignore-and-multiselect.md AC11, AC12 in the real built app with real git. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test, expect } from "@playwright/test";
import { closeApp, removeUserDataDir, type LaunchedApp } from "../helpers/launchApp";
import { launchApp, openChanges, rowBtn, shot, openDiscardAll } from "../helpers/changesHelpers";
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
const st = async (d: string) => (await git(d, ["status", "--porcelain", "-uall"])).stdout;
// Normalise CRLF: Windows core.autocrlf checks files out with CRLF.
const rd = async (d: string, p: string) => (await fs.readFile(path.join(d, p), "utf8")).split(String.fromCharCode(13)).join("");

async function repoWith(tracked: number, untracked: number): Promise<string> {
  const d = await initRepo();
  dirs.push(d);
  for (let i = 1; i <= tracked; i++) await writeFile(d, `t${String(i).padStart(2, "0")}.txt`, "base\n");
  await writeFile(d, "keep.txt", "base\n");
  await commitAll(d, "base");
  for (let i = 1; i <= tracked; i++) await writeFile(d, `t${String(i).padStart(2, "0")}.txt`, "changed\n");
  for (let i = 1; i <= untracked; i++) await writeFile(d, `u${i}.txt`, "new\n");
  return d;
}

test("AC11 bulk discard of selected tracked + untracked rows resets/removes exactly those paths", async () => {
  const d = await repoWith(3, 3);
  await openChanges(h, d);
  await rowBtn(h.window, "unstaged", "t01.txt").click();
  await rowBtn(h.window, "unstaged", "t02.txt").click({ modifiers: ["Control"] });
  await rowBtn(h.window, "untracked", "u1.txt").click({ modifiers: ["Control"] });
  const bar = h.window.getByRole("toolbar", { name: /actions for 3/i });
  await bar.getByRole("button", { name: /^discard 3/i }).click();
  const dlg = h.window.getByRole("alertdialog");
  // Untracked rows are an opt-in checkbox (unchecked): the title counts the tracked rows only until it is ticked.
  await expect(dlg).toContainText("Discard changes to 2 files?");
  await expect(dlg.getByRole("button", { name: "Cancel" })).toBeFocused();
  await dlg.getByRole("checkbox", { name: /also delete 1 untracked file/i }).check();
  await expect(dlg).toContainText("Discard changes to 3 files?");
  // Discard is never default focused.
  await shot(h.window, "dialog-bulk-discard-selected");
  await dlg.getByRole("button", { name: /^discard 3 files/i }).click();
  await expect(dlg).toHaveCount(0, { timeout: 15_000 });
  expect(await rd(d, "t01.txt")).toBe("base\n");
  expect(await rd(d, "t02.txt")).toBe("base\n");
  expect(await rd(d, "t03.txt")).toBe("changed\n");
  const s = await st(d);
  expect(s).not.toContain("u1.txt");
  expect(s).toContain("?? u2.txt");
  expect(s).toContain(" M t03.txt");
});

test("AC11 editing a selected file externally after the dialog opened refuses the WHOLE batch naming the path", async () => {
  const d = await repoWith(3, 2);
  await openChanges(h, d);
  await rowBtn(h.window, "unstaged", "t01.txt").click();
  await rowBtn(h.window, "unstaged", "t02.txt").click({ modifiers: ["Control"] });
  await rowBtn(h.window, "untracked", "u1.txt").click({ modifiers: ["Control"] });
  await h.window.getByRole("toolbar", { name: /actions for 3/i }).getByRole("button", { name: /^discard 3/i }).click();
  const dlg = h.window.getByRole("alertdialog");
  await dlg.getByRole("checkbox").check();
  const confirm = dlg.getByRole("button", { name: /^discard 3 files/i });
  await expect(confirm).toBeEnabled();
  await writeFile(d, "t02.txt", "externally edited\n");
  await confirm.click();
  await expect(dlg).toContainText(/changed since you opened this/i, { timeout: 15_000 });
  await expect(dlg).toContainText("t02.txt");
  await shot(h.window, "dialog-bulk-discard-stale");
  expect(await rd(d, "t01.txt")).toBe("changed\n");
  expect(await rd(d, "t02.txt")).toBe("externally edited\n");
  expect(await rd(d, "u1.txt")).toBe("new\n");
});

test("AC11 a stale UNTRACKED file (edited after the dialog opened) also refuses the whole batch", async () => {
  const d = await repoWith(2, 2);
  await openChanges(h, d);
  await rowBtn(h.window, "unstaged", "t01.txt").click();
  await rowBtn(h.window, "untracked", "u1.txt").click({ modifiers: ["Control"] });
  await h.window.getByRole("toolbar", { name: /actions for 2/i }).getByRole("button", { name: /^discard 2/i }).click();
  const dlg = h.window.getByRole("alertdialog");
  await dlg.getByRole("checkbox").check();
  const confirm = dlg.getByRole("button", { name: /^discard 2 files/i });
  await expect(confirm).toBeEnabled();
  await writeFile(d, "u1.txt", "I just typed more\n");
  await confirm.click();
  await expect(dlg).toContainText(/changed since you opened this/i, { timeout: 15_000 });
  expect(await rd(d, "t01.txt")).toBe("changed\n");
  expect(await rd(d, "u1.txt")).toBe("I just typed more\n");
});

test("AC12 Discard all: untracked checkbox is OFF by default; discarding with it off keeps untracked and staged", async () => {
  const d = await repoWith(3, 2);
  await writeFile(d, "keep.txt", "staged edit\n");
  await git(d, ["add", "keep.txt"]);
  await openChanges(h, d);
  await openDiscardAll(h.window);
  const dlg = h.window.getByRole("alertdialog");
  await expect(dlg).toContainText("Discard all changes?");
  const cb = dlg.getByRole("checkbox", { name: /also delete 2 untracked files/i });
  await expect(cb).not.toBeChecked();
  await expect(dlg).toContainText(/staged content is not touched/i);
  await expect(dlg).toContainText(/cannot be undone/i);
  await expect(dlg.getByRole("button", { name: "Cancel" })).toBeFocused();
  await shot(h.window, "dialog-discard-all");
  // Discard all always asks for the count (FR-520); Enter in the field never discards.
  await dlg.getByRole("textbox", { name: /type 3 to confirm/i }).fill("3");
  await h.window.keyboard.press("Enter");
  await expect(dlg).toBeVisible();
  await dlg.getByRole("button", { name: /^discard 3 files/i }).click();
  await expect(dlg).toHaveCount(0, { timeout: 15_000 });
  const s = await st(d);
  expect(s).toContain("?? u1.txt");
  expect(s).toContain("?? u2.txt");
  expect(s).toContain("M  keep.txt");
  expect(s).not.toContain(" M t0");
  expect(await rd(d, "keep.txt")).toBe("staged edit\n");
});

test("AC12 Discard all with the untracked checkbox ON deletes untracked too (only those), never touches staged", async () => {
  const d = await repoWith(3, 2);
  await writeFile(d, "keep.txt", "staged edit\n");
  await git(d, ["add", "keep.txt"]);
  await openChanges(h, d);
  await openDiscardAll(h.window);
  const dlg = h.window.getByRole("alertdialog");
  await dlg.getByRole("checkbox", { name: /also delete/i }).check();
  await dlg.getByRole("textbox", { name: /type 5 to confirm/i }).fill("5");
  await expect(dlg.getByRole("button", { name: /^discard 5 files/i })).toBeEnabled();
  await dlg.getByRole("button", { name: /^discard 5 files/i }).click();
  await expect(dlg).toHaveCount(0, { timeout: 15_000 });
  expect(await st(d)).toBe("M  keep.txt\n");
});

test("AC12 Cancel in Discard all changes nothing", async () => {
  const d = await repoWith(3, 2);
  await openChanges(h, d);
  const before = await st(d);
  await openDiscardAll(h.window);
  await h.window.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
  expect(await st(d)).toBe(before);
});

test("D6 Discard all requires typing the count; wrong text keeps Discard disabled; Cancel keeps the focus", async () => {
  const d = await repoWith(22, 0);
  await openChanges(h, d);
  await openDiscardAll(h.window);
  const dlg = h.window.getByRole("alertdialog");
  const btn = dlg.getByRole("button", { name: /^discard 22 files/i });
  await expect(btn).toBeDisabled();
  const input = dlg.getByRole("textbox", { name: /type 22 to confirm/i });
  await expect(dlg.getByRole("button", { name: "Cancel" })).toBeFocused();
  await input.fill("2");
  await expect(btn).toBeDisabled();
  await input.fill("22");
  await expect(btn).toBeEnabled();
  await expect(dlg).toContainText("t22.txt");
  await shot(h.window, "dialog-discard-all-typed");
  const t0 = Date.now();
  await btn.click();
  await expect(dlg).toHaveCount(0, { timeout: 60_000 });
  console.log("DISCARD-22 ms:", Date.now() - t0);
  expect(await st(d)).toBe("");
});
