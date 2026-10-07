// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * specs/ignore-and-multiselect.md AC10 (500-row bulk stage/unstage, awkward names), AC14 (mixed row semantics),
 * AC16 (Command Palette entries) and the TOO_MANY_FILES (> 3000) message, real built app + real git.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { closeApp, removeUserDataDir, type LaunchedApp } from "../helpers/launchApp";
import { launchApp, openChanges, rowBtn, openDiscardAll } from "../helpers/changesHelpers";
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
const st = async (d: string) => (await git(d, ["status", "--porcelain", "-uall"])).stdout;
const rd = async (d: string, p: string) => (await fs.readFile(path.join(d, p), "utf8")).split(String.fromCharCode(13)).join("");

// ------------------------------------------------------------------ AC10
const AWKWARD = ["a b", "é ü ñ", "[br]", "#h!x", "%p&q", "~t$u", "{c}@+,;=", "it's", "日本"];
const awkwardName = (i: number) =>
  `dir ${i % 5} ${AWKWARD[i % AWKWARD.length]}/${AWKWARD[(i * 3) % AWKWARD.length]} file ${String(i).padStart(3, "0")} ${"x".repeat(50)}.txt`;

async function pathsFrom(d: string, args: string[]): Promise<string[]> {
  const out = (await git(d, [...args, "-z"])).stdout;
  return out.split("\0").filter(Boolean).sort();
}

test("AC10 bulk Stage then Unstage of 500 mixed rows (250 modified tracked + 250 untracked, awkward names, long paths) matches git's own status", async () => {
  test.setTimeout(240_000);
  const d = await repo();
  const tracked: string[] = [];
  const untracked: string[] = [];
  for (let i = 0; i < 250; i++) tracked.push(awkwardName(i));
  for (let i = 250; i < 500; i++) untracked.push(awkwardName(i));
  tracked.push("-rf-lead-dash.txt");
  untracked.push("--help-lead-dash.txt");
  for (const p of tracked) await writeFile(d, p, "base\n");
  await commitAll(d, "tracked base");
  for (const p of tracked) await writeFile(d, p, "changed\n");
  for (const p of untracked) await writeFile(d, p, "new\n");
  const total = tracked.length + untracked.length;
  const argvChars = [...tracked, ...untracked].reduce((n, p) => n + p.length + 3, 0);
  console.log(`AC10 rows=${total}; summed path chars=${argvChars} (Windows CreateProcess limit is 32767)`);
  expect(argvChars).toBeGreaterThan(32_767);

  await openChanges(h, d);
  // spawn instrumentation: how many `add` / `reset` spawns the bulk op needed
  await h.app.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const req = typeof require === "function" ? require : process.mainModule!.require;
    const cp = req("node:child_process");
    const orig = cp.spawn;
    g.__spawnLog = [];
    cp.spawn = function (cmd: string, args: string[], ...rest: unknown[]) {
      g.__spawnLog.push({ t: Date.now(), args: Array.isArray(args) ? args.slice(0, 12) : [] });
      return orig.call(this, cmd, args, ...rest);
    };
  });
  const firstUnstaged = h.window.locator('[data-row-key^="unstaged:"]').first();
  const lastUntracked = h.window.locator('[data-row-key^="untracked:"]').last();
  await firstUnstaged.click();
  // The Changes list is windowed, so the last row is only mounted once the list is scrolled to the bottom.
  await firstUnstaged.evaluate((el) => {
    let p = el.parentElement;
    while (p && p.scrollHeight <= p.clientHeight) p = p.parentElement;
    if (p) p.scrollTop = p.scrollHeight;
  });
  await lastUntracked.click({ modifiers: ["Shift"] });
  const bar = h.window.getByRole("toolbar", { name: new RegExp(`actions for ${total} selected files`, "i") });
  await expect(bar).toBeVisible({ timeout: 15_000 });
  const t0 = Date.now();
  await h.window.getByRole("button", { name: `Stage ${total} selected` }).click();
  await expect(h.window.getByText(new RegExp(`staged ${total} files`, "i"))).toBeVisible({ timeout: 90_000 });
  const stageMs = Date.now() - t0;
  const spawns = (await h.app.evaluate(() => (globalThis as any).__spawnLog)) as { args: string[] }[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  const addSpawns = spawns.filter((e) => e.args.includes("add")).length;
  console.log(`AC10 Stage ${total}: ${stageMs} ms, git add spawns=${addSpawns}`);
  const staged = await pathsFrom(d, ["diff", "--cached", "--name-only"]);
  expect(staged).toEqual([...tracked, ...untracked].sort());
  expect(await pathsFrom(d, ["ls-files", "--others", "--exclude-standard"])).toEqual([]);
  expect(await pathsFrom(d, ["diff", "--name-only"])).toEqual([]);

  // Unstage the same 500 (selection follows the paths into Staged)
  const t1 = Date.now();
  await expect(h.window.getByRole("toolbar", { name: new RegExp(`actions for ${total} selected files`, "i") })).toBeVisible();
  await h.window.getByRole("button", { name: `Unstage ${total} selected` }).click();
  await expect(h.window.getByText(new RegExp(`unstaged ${total} files`, "i"))).toBeVisible({ timeout: 90_000 });
  console.log(`AC10 Unstage ${total}: ${Date.now() - t1} ms`);
  expect(await pathsFrom(d, ["diff", "--cached", "--name-only"])).toEqual([]);
  expect(await pathsFrom(d, ["diff", "--name-only"])).toEqual([...tracked].sort());
  expect(await pathsFrom(d, ["ls-files", "--others", "--exclude-standard"])).toEqual([...untracked].sort());
  // file contents never touched
  expect(await rd(d, tracked[0]!)).toBe("changed\n");
  expect(await rd(d, untracked[0]!)).toBe("new\n");
});

// ------------------------------------------------------------------ AC14 mixed rows
const L = (n: number, edits: Record<number, string> = {}) =>
  Array.from({ length: 20 }, (_, i) => edits[i + 1] ?? `line${i + 1}`).join("\n") + "\n";
/**
 * m.txt (20 lines): HEAD v1, index = edit on line 2, worktree = edits on lines 2 and 18. Disjoint hunks keep it ONE
 * mixed row (FR-482). u.txt untracked, s.txt fully staged.
 */
async function mixedRepo(): Promise<string> {
  const d = await repo();
  await writeFile(d, "m.txt", L(20));
  await commitAll(d, "m");
  await writeFile(d, "m.txt", L(20, { 2: "STAGED" }));
  await git(d, ["add", "m.txt"]);
  await writeFile(d, "m.txt", L(20, { 2: "STAGED", 18: "WORKTREE" }));
  await writeFile(d, "u.txt", "u\n");
  await writeFile(d, "s.txt", "s\n");
  await git(d, ["add", "s.txt"]);
  return d;
}
/** Single-line m.txt: overlapping staged/unstaged edits are ineligible for a combined row, so it splits into two rows. */
async function splitRepo(): Promise<string> {
  const d = await repo();
  await writeFile(d, "m.txt", "v1\n");
  await commitAll(d, "m");
  await writeFile(d, "m.txt", "v2\n");
  await git(d, ["add", "m.txt"]);
  await writeFile(d, "m.txt", "v3\n");
  await writeFile(d, "u.txt", "u\n");
  await writeFile(d, "s.txt", "s\n");
  await git(d, ["add", "s.txt"]);
  return d;
}

test("AC14 a partly staged file shows in BOTH sections (marked) and bulk Stage on its Unstaged row stages its remaining worktree edit", async () => {
  const d = await mixedRepo();
  await openChanges(h, d);
  await expect(rowBtn(h.window, "unstaged", "m.txt")).toBeVisible();
  await expect(rowBtn(h.window, "staged", "m.txt")).toBeVisible();
  await expect(rowBtn(h.window, "unstaged", "m.txt").getByRole("img", { name: "Partly staged: unstaged part", exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(rowBtn(h.window, "staged", "m.txt").getByRole("img", { name: "Partly staged: staged part", exact: true })).toBeVisible();
  await rowBtn(h.window, "unstaged", "m.txt").click({ position: { x: 8, y: 8 } });
  await rowBtn(h.window, "untracked", "u.txt").click({ modifiers: ["Control"] });
  await h.window.getByRole("button", { name: "Stage 2 selected" }).click();
  await expect(h.window.getByText(/staged 2 files/i)).toBeVisible();
  const s = await st(d);
  expect(s).toContain("M  m.txt");
  expect(s).toContain("A  u.txt");
  expect((await git(d, ["show", ":m.txt"])).stdout.replace(/\r/g, "")).toBe(L(20, { 2: "STAGED", 18: "WORKTREE" }));
});

test("AC14 bulk Unstage of a partly staged file's Staged row unstages its staged part (index back to HEAD), worktree edits kept; other staged file too", async () => {
  const d = await mixedRepo();
  await openChanges(h, d);
  await expect(rowBtn(h.window, "staged", "m.txt")).toBeVisible();
  await rowBtn(h.window, "staged", "m.txt").click({ position: { x: 8, y: 8 } });
  await rowBtn(h.window, "staged", "s.txt").click({ modifiers: ["Control"] });
  await h.window.getByRole("button", { name: "Unstage 2 selected" }).click();
  await expect(h.window.getByText(/unstaged 2 files/i)).toBeVisible();
  const s = await st(d);
  expect(s).toContain(" M m.txt");
  expect(s).not.toMatch(/^[MA] /m);
  expect(await rd(d, "m.txt")).toBe(L(20, { 2: "STAGED", 18: "WORKTREE" }));
});

test("AC14 bulk Discard of a mixed row discards the UNSTAGED part only (line 18 reverts, staged line 2 kept in index and worktree)", async () => {
  const d = await mixedRepo();
  await openChanges(h, d);
  await h.window.waitForTimeout(1500);
  await rowBtn(h.window, "unstaged", "m.txt").click({ position: { x: 8, y: 8 } });
  await rowBtn(h.window, "untracked", "u.txt").click({ modifiers: ["Control"] });
  await h.window.getByRole("toolbar", { name: /actions for 2/i }).getByRole("button", { name: /^discard 2/i }).click();
  const dlg = h.window.getByRole("alertdialog");
  await dlg.getByRole("checkbox").check();
  await dlg.getByRole("button", { name: /^discard 2 files/i }).click();
  await expect(dlg).toHaveCount(0, { timeout: 15_000 });
  expect(await rd(d, "m.txt")).toBe(L(20, { 2: "STAGED" }));
  const s = await st(d);
  expect(s).toContain("M  m.txt");
  expect(s).not.toContain("u.txt");
  expect(s).toContain("A  s.txt");
});

test("AC14 ineligible partly staged file shows two rows; bulk Unstage on the STAGED row never touches the worktree side", async () => {
  const d = await splitRepo();
  await openChanges(h, d);
  await expect(rowBtn(h.window, "staged", "m.txt")).toBeVisible({ timeout: 10_000 });
  await expect(rowBtn(h.window, "unstaged", "m.txt")).toBeVisible();
  await rowBtn(h.window, "staged", "m.txt").click();
  await rowBtn(h.window, "staged", "s.txt").click({ modifiers: ["Control"] });
  await h.window.getByRole("button", { name: "Unstage 2 selected" }).click();
  await expect(h.window.getByText(/unstaged 2 files/i)).toBeVisible();
  expect(await rd(d, "m.txt")).toBe("v3\n");
  expect(await st(d)).toContain(" M m.txt");
});

test("AC14 ineligible partly staged file: bulk Discard on the UNSTAGED row leaves the staged side (index v2) intact", async () => {
  const d = await splitRepo();
  await openChanges(h, d);
  await expect(rowBtn(h.window, "staged", "m.txt")).toBeVisible({ timeout: 10_000 });
  await rowBtn(h.window, "unstaged", "m.txt").click({ position: { x: 8, y: 8 } });
  await rowBtn(h.window, "untracked", "u.txt").click({ modifiers: ["Control"] });
  await h.window.getByRole("toolbar", { name: /actions for 2/i }).getByRole("button", { name: /^discard 2/i }).click();
  const dlg = h.window.getByRole("alertdialog");
  await dlg.getByRole("checkbox").check();
  await dlg.getByRole("button", { name: /^discard 2 files/i }).click();
  await expect(dlg).toHaveCount(0, { timeout: 15_000 });
  expect(await rd(d, "m.txt")).toBe("v2\n");
  expect(await st(d)).toContain("M  m.txt");
});

test("AC14 a fully staged row is skipped by bulk Discard with a stated count; the other side is never touched", async () => {
  const d = await mixedRepo();
  await openChanges(h, d);
  await rowBtn(h.window, "staged", "s.txt").click();
  await rowBtn(h.window, "untracked", "u.txt").click({ modifiers: ["Control"] });
  const bar = h.window.getByRole("toolbar", { name: /actions for 2/i });
  await expect(bar.getByRole("button", { name: /^discard 1/i })).toHaveAttribute("aria-description", /1 skipped/);
  await bar.getByRole("button", { name: /^discard 1/i }).click();
  const dlg = h.window.getByRole("alertdialog");
  await dlg.getByRole("button", { name: /^discard 1 file/i }).click();
  await expect(dlg).toHaveCount(0, { timeout: 15_000 });
  const s = await st(d);
  expect(s).toContain("A  s.txt");
  expect(s).not.toContain("u.txt");
  expect(s).toContain("MM m.txt");
});

// ------------------------------------------------------------------ AC16 Command Palette
async function openPalette(page: Page) {
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: /command palette/i })).toBeVisible();
}
const IDS: Record<string, string> = { "Select all in section": "select-all-in-section", "Stage selected": "stage-selected", "Unstage selected": "unstage-selected", "Discard selected…": "discard-selected", "Discard all changes…": "discard-all-changes", "Ignore selected file(s)…": "ignore-selected" };
const item = (page: Page, label: string) => page.locator(`li[role="option"][id$="-${IDS[label]}"]`);
async function filter(page: Page, q: string) {
  await page.getByRole("combobox", { name: /command palette/i }).fill(q);
}

test("AC16 with the Changes panel closed all six entries are listed disabled with the 'Open the Changes panel first.' reason", async () => {
  const d = await repo();
  await writeFile(d, "u.txt", "u\n");
  const { openRepoThroughRealUi } = await import("../helpers/launchApp");
  await openRepoThroughRealUi(h, d);
  await openPalette(h.window);
  for (const label of ["Select all in section", "Stage selected", "Unstage selected", "Discard selected…", "Discard all changes…", "Ignore selected file(s)…"]) {
    await filter(h.window, label);
    const it = item(h.window, label);
    await expect(it).toHaveCount(1);
    await expect(it).toHaveAttribute("aria-disabled", "true");
    await expect(it).toContainText(/open the changes panel first/i);
  }
});

test("AC16 panel open, nothing selected: per-selection entries disabled with 'Select files…' reason; Select all and Discard all enabled", async () => {
  const d = await repo();
  await writeFile(d, "u1.txt", "u\n");
  await writeFile(d, "u2.txt", "u\n");
  await openChanges(h, d);
  await openPalette(h.window);
  for (const label of ["Stage selected", "Unstage selected", "Discard selected…", "Ignore selected file(s)…"]) {
    await filter(h.window, label);
    await expect(item(h.window, label)).toHaveAttribute("aria-disabled", "true");
    await expect(item(h.window, label)).toContainText(/select files in the changes list first/i);
  }
  for (const label of ["Select all in section", "Discard all changes…"]) {
    await filter(h.window, label);
    await expect(item(h.window, label)).not.toHaveAttribute("aria-disabled", "true");
  }
});

test("AC16 clicking a disabled entry does nothing (palette stays, nothing staged/discarded)", async () => {
  const d = await repo();
  await writeFile(d, "u1.txt", "u\n");
  await openChanges(h, d);
  await openPalette(h.window);
  await filter(h.window, "Discard selected");
  await item(h.window, "Discard selected…").click({ force: true });
  await expect(h.window.getByRole("alertdialog")).toHaveCount(0);
  await expect(h.window.getByRole("dialog", { name: /command palette/i })).toBeVisible();
  expect(await st(d)).toContain("?? u1.txt");
});

test("AC16 a selection of only untracked rows: Unstage selected is disabled 'Not staged.'; Stage selected runs and matches the bulk bar", async () => {
  const d = await repo();
  await writeFile(d, "u1.txt", "u\n");
  await writeFile(d, "u2.txt", "u\n");
  await openChanges(h, d);
  await rowBtn(h.window, "untracked", "u1.txt").click();
  await rowBtn(h.window, "untracked", "u2.txt").click({ modifiers: ["Control"] });
  await openPalette(h.window);
  await filter(h.window, "Unstage selected");
  await expect(item(h.window, "Unstage selected")).toHaveAttribute("aria-disabled", "true");
  await expect(item(h.window, "Unstage selected")).toContainText(/not staged/i);
  await filter(h.window, "Stage selected");
  await item(h.window, "Stage selected").first().click();
  await expect(h.window.getByText(/staged 2 files/i)).toBeVisible();
  const s = await st(d);
  expect(s).toContain("A  u1.txt");
  expect(s).toContain("A  u2.txt");
});

test("AC16 'Ignore selected file(s)…' from the palette opens the same scope menu; 'Select all in section' selects the focused section; 'Discard all changes…' opens the D6 dialog", async () => {
  const d = await repo();
  await writeFile(d, "u1.txt", "u\n");
  await writeFile(d, "u2.txt", "u\n");
  await openChanges(h, d);
  await rowBtn(h.window, "untracked", "u1.txt").click();
  await openPalette(h.window);
  await filter(h.window, "Ignore selected");
  await item(h.window, "Ignore selected file(s)…").click();
  await expect(h.window.getByRole("dialog", { name: /^Ignore u1\.txt/ })).toBeVisible({ timeout: 5000 });
  await h.window.keyboard.press("Escape");
  await rowBtn(h.window, "untracked", "u1.txt").click();
  await openPalette(h.window);
  await filter(h.window, "Select all in section");
  await item(h.window, "Select all in section").click();
  await expect(h.window.getByRole("toolbar", { name: /actions for 2 selected files/i })).toBeVisible();
  await openPalette(h.window);
  await filter(h.window, "Discard all changes");
  await item(h.window, "Discard all changes…").click();
  await expect(h.window.getByRole("alertdialog")).toContainText(/discard all changes/i);
});

test("AC16 clean repo: 'Discard all changes…' and 'Select all in section' are disabled with their reasons", async () => {
  const d = await repo();
  await openChanges(h, d);
  await openPalette(h.window);
  await filter(h.window, "Discard all changes");
  await expect(item(h.window, "Discard all changes…")).toHaveAttribute("aria-disabled", "true");
  await expect(item(h.window, "Discard all changes…")).toContainText(/no unstaged or untracked changes/i);
  await filter(h.window, "Select all in section");
  await expect(item(h.window, "Select all in section")).toContainText(/no changed files/i);
});

// ------------------------------------------------------------------ TOO_MANY_FILES
async function manyModified(n: number): Promise<string> {
  const d = await initRepo();
  dirs.push(d);
  const names = Array.from({ length: n }, (_, i) => `bulk/f${String(i).padStart(4, "0")}.txt`);
  await fs.mkdir(path.join(d, "bulk"), { recursive: true });
  for (const p of names) await fs.writeFile(path.join(d, p), "base\n");
  await git(d, ["add", "-A"]);
  await git(d, ["commit", "-qm", "many"]);
  for (const p of names) await fs.writeFile(path.join(d, p), "changed\n");
  return d;
}

test("TOO_MANY_FILES: Discard all with 3001 modified files shows the 'Too many files' message and discards nothing", async () => {
  test.setTimeout(300_000);
  const d = await manyModified(3001);
  await openChanges(h, d);
  await expect(h.window.getByText(/3001|3,001/).first()).toBeVisible({ timeout: 120_000 });
  await openDiscardAll(h.window);
  const dlg = h.window.getByRole("alertdialog");
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText(/too many files/i, { timeout: 120_000 });
  console.log("TOO_MANY dialog:", (await dlg.innerText()).replace(/\s+/g, " ").slice(0, 400));
  await expect(dlg.getByRole("button", { name: /^discard \d/i })).toHaveCount(0);
  expect(await rd(d, "bulk/f0000.txt")).toBe("changed\n");
  expect(await rd(d, "bulk/f3000.txt")).toBe("changed\n");
  expect((await git(d, ["diff", "--name-only"])).stdout.trim().split("\n").length).toBe(3001);
});

test("TOO_MANY_FILES: bulk-bar Discard of 3001 selected rows shows the same message and discards nothing", async () => {
  test.setTimeout(300_000);
  const d = await manyModified(3001);
  await openChanges(h, d);
  await rowBtn(h.window, "unstaged", "bulk/f0000.txt").click({ timeout: 120_000 });
  await h.window.keyboard.press("Control+a");
  const bar = h.window.getByRole("toolbar", { name: /actions for 3001 selected files/i });
  await expect(bar).toBeVisible({ timeout: 30_000 });
  await bar.getByRole("button", { name: /^discard 3001/i }).click();
  const dlg = h.window.getByRole("alertdialog");
  await expect(dlg).toContainText(/too many files/i, { timeout: 120_000 });
  expect(await rd(d, "bulk/f0000.txt")).toBe("changed\n");
  expect((await git(d, ["diff", "--name-only"])).stdout.trim().split("\n").length).toBe(3001);
});
