// SPDX-License-Identifier: GPL-3.0-or-later
/** specs/ignore-and-multiselect.md AC1/AC2/AC6 in the real built app against real repos. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { closeApp, removeUserDataDir, type LaunchedApp } from "../helpers/launchApp";
import { applyIgnorePopover, launchApp, ignoreViaMenu, openChanges, refresh, rowBtn, shot } from "../helpers/changesHelpers";
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
  return d;
}
const readStr = async (d: string, p: string) => (await fs.readFile(path.join(d, p))).toString();
const status = async (d: string) => (await git(d, ["status", "--porcelain", "-uall"])).stdout;

const pickTargetAndAdd = applyIgnorePopover;

const cases = [
  { scope: /^this file/i, file: "sub/dir/out.log", rule: "/sub/dir/out.log\n" },
  { scope: /all \*\.log files/i, file: "sub/dir/out.log", rule: "*.log\n" },
  { scope: /all files in sub\/dir\//i, file: "sub/dir/out.log", rule: "/sub/dir/\n" },
];
for (const c of cases) {
  test(`AC1 root .gitignore: ${c.scope} writes exactly ${JSON.stringify(c.rule)}; file leaves list; notice shown`, async () => {
    const d = await repo();
    await writeFile(d, c.file, "x\n");
    await openChanges(h, d);
    await expect(rowBtn(h.window, "untracked", c.file)).toBeVisible();
    await ignoreViaMenu(h.window, "untracked", c.file, c.scope);
    await shot(h.window, "dialog-add-to-" + c.rule.replace(/\W/g, "_"));
    await pickTargetAndAdd(h.window, /root \.gitignore/i);
    expect(await readStr(d, ".gitignore")).toBe(c.rule);
    await expect(rowBtn(h.window, "untracked", c.file)).toHaveCount(0, { timeout: 10_000 });
    await expect(h.window.getByText(/added .* to \.gitignore/i)).toBeVisible();
    const st = await status(d);
    expect(st).toBe("?? .gitignore\n");
  });
}

test("AC2 nearest .gitignore writes into a/b/.gitignore with rule relative to a/b", async () => {
  const d = await repo();
  await writeFile(d, "a/b/.gitignore", "keep\n");
  await commitAll(d, "nested");
  await writeFile(d, "a/b/c/gen.tmp", "x\n");
  await openChanges(h, d);
  await ignoreViaMenu(h.window, "untracked", "a/b/c/gen.tmp", /^this file/i);
  await pickTargetAndAdd(h.window, /nearest/i);
  expect(await readStr(d, "a/b/.gitignore")).toBe("keep\n/c/gen.tmp\n");
  await expect(h.window.getByText(/added \/c\/gen\.tmp to a\/b\/\.gitignore/i)).toBeVisible();
});

test("AC2 nearest with none present creates the root .gitignore", async () => {
  const d = await repo();
  await writeFile(d, "a/gen.tmp", "x\n");
  await openChanges(h, d);
  await ignoreViaMenu(h.window, "untracked", "a/gen.tmp", /^this file/i);
  await pickTargetAndAdd(h.window, /nearest/i);
  expect(await readStr(d, ".gitignore")).toBe("/a/gen.tmp\n");
  await expect(fs.access(path.join(d, "a/.gitignore"))).rejects.toBeTruthy();
});

test("AC2 private writes .git/info/exclude, leaves .gitignore absent, nothing new in status", async () => {
  const d = await repo();
  await writeFile(d, "secret.env", "x\n");
  await openChanges(h, d);
  await ignoreViaMenu(h.window, "untracked", "secret.env", /^this file/i);
  await pickTargetAndAdd(h.window, /private/i);
  expect(await readStr(d, ".git/info/exclude")).toMatch(/\n\/secret\.env\n$/);
  await expect(fs.access(path.join(d, ".gitignore"))).rejects.toBeTruthy();
  await expect(rowBtn(h.window, "untracked", "secret.env")).toHaveCount(0, { timeout: 10_000 });
  expect(await status(d)).toBe("");
  await expect(h.window.getByText(/info\/exclude/).first()).toBeVisible();
});

test("AC2 linked worktree: private target says it is shared and writes the shared file", async () => {
  const d = await repo();
  const wt = path.join(path.dirname(d), path.basename(d) + "-wt");
  dirs.push(wt);
  await git(d, ["worktree", "add", "-q", "-b", "wtb", wt]);
  await writeFile(wt, "w.tmp", "x\n");
  await openChanges(h, wt);
  await ignoreViaMenu(h.window, "untracked", "w.tmp", /^this file/i);
  const dlg = h.window.getByRole("dialog", { name: /^Ignore/ });
  await dlg.getByRole("combobox", { name: "Add to" }).selectOption("exclude");
  await expect(dlg).toContainText(/shared with the main checkout/i);
  await dlg.getByRole("button", { name: "Ignore", exact: true }).click();
  await expect(dlg).toHaveCount(0);
  expect(await readStr(d, ".git/info/exclude")).toContain("/w.tmp\n");
});

test("AC3 repeat of an existing rule reports already in and leaves bytes unchanged", async () => {
  const d = await repo();
  await writeFile(d, ".gitignore", "/x.txt\n");
  await commitAll(d, "ign");
  await writeFile(d, "x.txt", "1\n");
  await git(d, ["add", "-f", "x.txt"]);
  await git(d, ["commit", "-qm", "force x"]);
  await writeFile(d, "x.txt", "2\n");
  await openChanges(h, d);
  await ignoreViaMenu(h.window, "unstaged", "x.txt", /^this file/i);
  const dlg = h.window.getByRole("dialog", { name: /^Ignore/ });
  await expect(dlg.locator("[aria-live=polite]")).not.toHaveText("Checking…");
  await shot(h.window, "dialog-already");
  const text = await dlg.locator("[aria-live=polite]").innerText();
  console.log("ALREADY PREVIEW:", text);
  expect(await readStr(d, ".gitignore")).toBe("/x.txt\n");
});

test("AC6 tracked: Ignore only keeps tracking and stays listed", async () => {
  const d = await repo();
  await writeFile(d, "t.txt", "a\n");
  await commitAll(d, "t");
  await writeFile(d, "t.txt", "b\n");
  await openChanges(h, d);
  await ignoreViaMenu(h.window, "unstaged", "t.txt", /^this file/i);
  const dlg = h.window.getByRole("dialog", { name: /^Ignore/ });
  await expect(dlg.getByRole("button", { name: "Ignore and stop tracking" })).toBeEnabled();
  await expect(dlg).toContainText(/does not make git forget a tracked file/i);
  await shot(h.window, "dialog-tracked");
  await dlg.getByRole("button", { name: "Ignore only" }).click();
  await expect(dlg).toHaveCount(0);
  expect(await readStr(d, ".gitignore")).toBe("/t.txt\n");
  expect(await status(d)).toContain(" M t.txt");
  await expect(rowBtn(h.window, "unstaged", "t.txt")).toBeVisible();
  await expect(h.window.getByText(/added \/t\.txt/i)).toBeVisible();
});

test("AC6 tracked: Ignore and stop tracking stages deletion; file stays on disk", async () => {
  const d = await repo();
  await writeFile(d, "t.txt", "a\n");
  await commitAll(d, "t");
  await openChanges(h, d);
  await writeFile(d, "t.txt", "b\n");
  await refresh(h.window);
  await ignoreViaMenu(h.window, "unstaged", "t.txt", /^this file/i);
  const dlg = h.window.getByRole("dialog", { name: /^Ignore/ });
  await expect(dlg.getByRole("button", { name: "Ignore and stop tracking" })).toBeEnabled();
  await expect(dlg).toContainText(/stay on disk/i);
  await expect(dlg).toContainText(/staged changes/i);
  await dlg.getByRole("button", { name: "Ignore and stop tracking" }).click();
  await expect(dlg).toHaveCount(0);
  expect(await readStr(d, "t.txt")).toBe("b\n");
  expect(await status(d)).toContain("D  t.txt");
  await expect(h.window.getByText(/stopped tracking 1 file/i)).toBeVisible();
});

test("AC6 extension scope untracks only the selected file and states how many other matches stay tracked", async () => {
  const d = await repo();
  await writeFile(d, "build/a.o", "1\n");
  await writeFile(d, "build/sub/b.o", "1\n");
  await writeFile(d, "other/c.o", "1\n");
  await commitAll(d, "o");
  await writeFile(d, "build/a.o", "2\n");
  await openChanges(h, d);
  await ignoreViaMenu(h.window, "unstaged", "build/a.o", /all \*\.o files/i);
  const dlg = h.window.getByRole("dialog", { name: /^Ignore/ });
  await expect(dlg.getByRole("button", { name: "Ignore and stop tracking" })).toBeEnabled();
  await expect(dlg).toContainText(/2 other tracked files matching this rule stay tracked/i);
  await dlg.getByRole("button", { name: "Ignore and stop tracking" }).click();
  await expect(dlg).toHaveCount(0);
  const st = await status(d);
  expect(st).toContain("D  build/a.o");
  expect(st).not.toContain("b.o");
  expect(st).not.toContain("c.o");
});
