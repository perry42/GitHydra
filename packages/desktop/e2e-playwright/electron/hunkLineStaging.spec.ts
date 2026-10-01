// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Real-Electron verification of specs/hunk-line-staging.md's checkbox model (real clicks, Shift-click, hover,
 * keyboard, real layout) plus the file-list mixed row (specs/changes-panel-layout.md FR-488). Every test builds
 * its own temp repo; nothing depends on another test. Screenshots go to $HUNK_SHOTS (or the OS temp dir) for
 * human review.
 */
import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { closeApp, launchGitHydra, removeUserDataDir, stubOpenRepoDialog, type LaunchedApp } from "../helpers/launchApp";
import { cleanup, commitAll, git, initRepo, writeFile } from "../../src/test/gitFixture";

let handle: LaunchedApp;
let repoDir: string;
let shotDir: string;

test.beforeEach(async () => {
  handle = await launchGitHydra();
  shotDir = process.env.HUNK_SHOTS ?? (await fs.mkdtemp(path.join(os.tmpdir(), "githydra-pw-hunk-")));
  await fs.mkdir(shotDir, { recursive: true });
});
test.afterEach(async () => {
  await closeApp(handle);
  await removeUserDataDir(handle.userDataDir);
  if (repoDir) await cleanup(repoDir);
});

const lines = (n: number, f: (i: number) => string = (i) => `line${String(i).padStart(2, "0")}`) =>
  Array.from({ length: n }, (_, i) => f(i + 1));
const join = (ls: string[], eol = "\n") => ls.join(eol) + eol;

/** base 90 lines; edits: hunk1 = line 5, hunk2 = lines 30..34, hunk3 = lines 60..74 (big). */
function threeHunkFile(edited: boolean): string {
  const ls = lines(90);
  if (edited) {
    ls[4] = "CHANGED05";
    for (let i = 30; i <= 34; i++) ls[i - 1] = `CHANGED${i}`;
    for (let i = 60; i <= 74; i++) ls[i - 1] = `CHANGED${i}`;
  }
  return join(ls);
}

function gitBytes(args: string[]): Buffer {
  return execFileSync("git", args, { cwd: repoDir, maxBuffer: 1 << 26 });
}

async function openRepoInApp(): Promise<Page> {
  await stubOpenRepoDialog(handle.app, repoDir);
  await handle.window.getByRole("button", { name: "Open a repository", exact: true }).click();
  await handle.window.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });
  await handle.window.getByRole("button", { name: /^changes/i }).click();
  await handle.window.getByRole("button", { name: "Stage all", exact: true }).waitFor();
  return handle.window;
}

function fileRow(w: Page, section: "Staged" | "Unstaged" | "Untracked", p: string) {
  return w
    .locator("section.gh-changes-panel__section", { has: w.locator("h3", { hasText: new RegExp(`^${section}`) }) })
    .locator("li.gh-changes-panel__file", { hasText: p });
}
async function selectFile(w: Page, section: "Staged" | "Unstaged" | "Untracked", p: string) {
  await fileRow(w, section, p).locator(".gh-changes-panel__file-label").click();
}

async function setTheme(w: Page, theme: "light" | "dark") {
  const current = await w.evaluate(() => document.documentElement.dataset.theme);
  if (current === theme) return;
  await w.getByRole("button", { name: "More actions" }).click();
  await w.getByRole("menuitem", { name: /switch to (light|dark) theme/i }).click();
  await expect.poll(() => w.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
}

async function setupThreeHunks() {
  repoDir = await initRepo();
  await writeFile(repoDir, "f.txt", threeHunkFile(false));
  await commitAll(repoDir, "base");
  await writeFile(repoDir, "f.txt", threeHunkFile(true));
}

// Line checkboxes are labelled "Added line 30: CHANGED30"; match by prefix.
const lineBox = (w: Page, label: string) => w.getByRole("checkbox", { name: new RegExp(`^${label}(:|$)`) });
const hunkBox = (w: Page, n: number, of = 3) => w.getByRole("checkbox", { name: `Hunk ${n} of ${of}` });
const diffGroup = (w: Page) => w.getByRole("group", { name: "Changed lines" });
const hunkHeader = (w: Page, n: number) => w.locator(`.gh-diff-view__hunk-header[data-hunk-header="${n - 1}"]`);

/** The clickable checkbox column of a row, scrolled clear of the sticky hunk header first. */
async function tick(w: Page, label: string, modifiers: ("Shift")[] = []) {
  const row = lineBox(w, label);
  await row.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await row.locator(".gh-diff-view__gutter--check").click({ modifiers });
}

const cachedHunks = async () => (await git(repoDir, ["diff", "--cached", "-U0"])).stdout.match(/^@@/gm)?.length ?? 0;

test("AC1 hunk checkbox on hunk 2: index has exactly hunk 2, worktree byte-identical, file shown ONCE as partly staged", async () => {
  await setupThreeHunks();
  const before = await fs.readFile(path.join(repoDir, "f.txt"));
  const w = await openRepoInApp();
  await selectFile(w, "Unstaged", "f.txt");
  await expect(hunkBox(w, 2)).toHaveAttribute("aria-checked", "false");
  await hunkBox(w, 2).click();
  await expect(hunkBox(w, 2)).toHaveAttribute("aria-checked", "true");
  await expect(hunkBox(w, 1)).toHaveAttribute("aria-checked", "false");
  await expect(hunkBox(w, 3)).toHaveAttribute("aria-checked", "false");
  await expect(fileRow(w, "Unstaged", "f.txt").getByRole("img", { name: "Partly staged" })).toBeVisible({ timeout: 10_000 });
  await expect(fileRow(w, "Staged", "f.txt")).toHaveCount(0);
  const cached = (await git(repoDir, ["diff", "--cached", "-U0"])).stdout;
  expect(cached.match(/^@@/gm)).toHaveLength(1);
  expect(cached).toContain("+CHANGED30");
  expect(cached).toContain("+CHANGED34");
  expect(cached).not.toContain("CHANGED05");
  expect(cached).not.toContain("CHANGED60");
  expect(Buffer.compare(before, await fs.readFile(path.join(repoDir, "f.txt")))).toBe(0);
  // clicking the (now ticked) hunk checkbox unstages the whole hunk again
  await hunkBox(w, 2).click();
  await expect(hunkBox(w, 2)).toHaveAttribute("aria-checked", "false");
  await expect.poll(cachedHunks).toBe(0);
});

test("AC2+AC3+AC5 single-line ticks and a Shift range: -34 then Shift-click +30 stages exactly two lines; unticking restores the index bytes", async () => {
  await setupThreeHunks();
  const w = await openRepoInApp();
  await selectFile(w, "Unstaged", "f.txt");
  const indexBefore = gitBytes(["show", ":f.txt"]);
  // hunk 2 = lines 30..34 removed (old nos 30..34), then CHANGED30..34 added (new nos 30..34)
  await tick(w, "Removed line 34");
  await expect(lineBox(w, "Removed line 34")).toHaveAttribute("aria-checked", "true");
  await tick(w, "Added line 30", ["Shift"]);
  await expect(lineBox(w, "Added line 30")).toHaveAttribute("aria-checked", "true");
  await expect(lineBox(w, "Removed line 33")).toHaveAttribute("aria-checked", "false");
  await expect(fileRow(w, "Unstaged", "f.txt").getByRole("img", { name: "Partly staged" })).toBeVisible({ timeout: 10_000 });
  const exp = lines(90);
  exp.splice(33, 1, "CHANGED30"); // line34 removed, CHANGED30 in its place, line30..33 kept as context
  // The tick is optimistic, so wait for git (the second, queued operation) rather than the UI.
  await expect.poll(() => gitBytes(["show", ":f.txt"]).toString("utf8")).toBe(join(exp));
  // untick both: the exact inverse, byte for byte
  await tick(w, "Removed line 34");
  await expect(lineBox(w, "Removed line 34")).toHaveAttribute("aria-checked", "false");
  await tick(w, "Added line 30");
  await expect(lineBox(w, "Added line 30")).toHaveAttribute("aria-checked", "false");
  await expect.poll(() => Buffer.compare(indexBefore, gitBytes(["show", ":f.txt"]))).toBe(0);
});

test("AC4 hunk checkbox states: none = unticked, some = mixed, all = ticked; mixed click stages the rest, ticked click unstages", async () => {
  await setupThreeHunks();
  const w = await openRepoInApp();
  await selectFile(w, "Unstaged", "f.txt");
  await expect(hunkBox(w, 2)).toHaveAttribute("aria-checked", "false");
  await tick(w, "Added line 31");
  await expect(hunkBox(w, 2)).toHaveAttribute("aria-checked", "mixed");
  await hunkBox(w, 2).click(); // mixed -> stages the rest
  await expect(hunkBox(w, 2)).toHaveAttribute("aria-checked", "true");
  await expect.poll(cachedHunks).toBe(1);
  await hunkBox(w, 2).click(); // all -> unstages the hunk
  await expect(hunkBox(w, 2)).toHaveAttribute("aria-checked", "false");
  await expect.poll(cachedHunks).toBe(0);
});

test("AC3/AC6 unstage a hunk of a fully staged file: it becomes ONE partly staged row in Unstaged, leaving the other hunks staged", async () => {
  await setupThreeHunks();
  await git(repoDir, ["add", "f.txt"]);
  const w = await openRepoInApp();
  await selectFile(w, "Staged", "f.txt");
  await expect(hunkBox(w, 2)).toHaveAttribute("aria-checked", "true");
  await hunkBox(w, 2).click();
  await expect(fileRow(w, "Unstaged", "f.txt").getByRole("img", { name: "Partly staged" })).toBeVisible({ timeout: 10_000 });
  await expect(fileRow(w, "Staged", "f.txt")).toHaveCount(0);
  const cached = (await git(repoDir, ["diff", "--cached", "-U0"])).stdout;
  expect(cached.match(/^@@/gm)).toHaveLength(2);
  expect(cached).not.toContain("CHANGED30");
});

test("AC6 mixed row: Stage stages the rest, Unstage unstages all, Discard removes only the unstaged part (index unchanged)", async () => {
  await setupThreeHunks();
  const w = await openRepoInApp();
  await selectFile(w, "Unstaged", "f.txt");
  await hunkBox(w, 1).click();
  const mixed = () => fileRow(w, "Unstaged", "f.txt").getByRole("img", { name: "Partly staged" });
  await expect(mixed()).toBeVisible({ timeout: 10_000 });

  // Stage = everything remaining
  await fileRow(w, "Unstaged", "f.txt").hover();
  await fileRow(w, "Unstaged", "f.txt").getByRole("button", { name: "Stage", exact: true }).click();
  await expect(fileRow(w, "Staged", "f.txt")).toBeVisible({ timeout: 10_000 });
  await expect.poll(async () => (await git(repoDir, ["diff"])).stdout).toBe(""); // the row moves optimistically
  expect(await cachedHunks()).toBe(3);

  // Back to mixed, then Unstage = everything
  await selectFile(w, "Staged", "f.txt");
  await hunkBox(w, 3).click();
  await expect(mixed()).toBeVisible({ timeout: 10_000 });
  await fileRow(w, "Unstaged", "f.txt").hover();
  await fileRow(w, "Unstaged", "f.txt").getByRole("button", { name: "Unstage", exact: true }).click();
  await expect(fileRow(w, "Staged", "f.txt")).toHaveCount(0, { timeout: 10_000 });
  await expect.poll(async () => (await git(repoDir, ["diff", "--cached"])).stdout).toBe("");
  await expect(fileRow(w, "Unstaged", "f.txt")).toBeVisible();

  // Discard (unstaged part only): stage hunk 1 again, then discard the row
  await selectFile(w, "Unstaged", "f.txt");
  await hunkBox(w, 1).click();
  await expect(mixed()).toBeVisible({ timeout: 10_000 });
  await expect.poll(cachedHunks).toBe(1);
  const indexBefore = (await git(repoDir, ["diff", "--cached"])).stdout;
  await fileRow(w, "Unstaged", "f.txt").hover();
  await fileRow(w, "Unstaged", "f.txt").getByRole("button", { name: "Discard changes to f.txt" }).click();
  const dlg = w.getByRole("alertdialog");
  await expect(dlg).toContainText("Only the unstaged part is discarded");
  await dlg.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(dlg).toHaveCount(0);
  await expect.poll(async () => (await fs.readFile(path.join(repoDir, "f.txt"), "utf8")).includes("CHANGED30")).toBe(false);
  const wt = await fs.readFile(path.join(repoDir, "f.txt"), "utf8");
  expect(wt).toContain("CHANGED05"); // the staged hunk survives in the worktree
  expect((await git(repoDir, ["diff", "--cached"])).stdout).toBe(indexBefore);
});

test("AC9 discard hunk: cancel changes nothing; confirm restores only that hunk's unstaged lines, index untouched", async () => {
  await setupThreeHunks();
  const w = await openRepoInApp();
  await selectFile(w, "Unstaged", "f.txt");
  await hunkBox(w, 1).click(); // the file now has staged changes too
  await expect(fileRow(w, "Unstaged", "f.txt").getByRole("img", { name: "Partly staged" })).toBeVisible({ timeout: 10_000 });
  await expect.poll(cachedHunks).toBe(1);
  const indexBefore = (await git(repoDir, ["diff", "--cached"])).stdout;
  const wtBefore = await fs.readFile(path.join(repoDir, "f.txt"));
  // Discard is hidden until hover/focus, and lives on the header, not on a checkbox
  const discardBtn = w.getByRole("button", { name: /^Discard hunk 2 of 3$/ });
  const opacity = () => discardBtn.evaluate((e) => getComputedStyle(e).opacity);
  await w.mouse.move(5, 5);
  expect(await opacity()).toBe("0");
  await hunkHeader(w, 2).hover();
  expect(await opacity()).toBe("1");
  await expect(hunkBox(w, 2).getByText(/discard/i)).toHaveCount(0);

  await discardBtn.click();
  const dlg = w.getByRole("alertdialog");
  await expect(dlg).toContainText("f.txt");
  await expect(dlg).toContainText(/1 hunk/);
  await expect(dlg).toContainText("This cannot be undone.");
  await expect(dlg.getByRole("button", { name: "Cancel" })).toBeFocused();
  await dlg.getByRole("button", { name: "Cancel" }).click();
  await expect(dlg).toHaveCount(0);
  expect(Buffer.compare(wtBefore, await fs.readFile(path.join(repoDir, "f.txt")))).toBe(0);

  await hunkHeader(w, 2).hover();
  await discardBtn.click();
  await w.getByRole("alertdialog").getByRole("button", { name: "Discard hunk", exact: true }).click();
  await expect(w.getByRole("alertdialog")).toHaveCount(0);
  await expect.poll(async () => (await fs.readFile(path.join(repoDir, "f.txt"), "utf8")).includes("CHANGED30")).toBe(false);
  const wt = await fs.readFile(path.join(repoDir, "f.txt"), "utf8");
  expect(wt).toContain("line30");
  expect(wt).toContain("CHANGED60"); // hunk 3 untouched
  expect(wt).toContain("CHANGED05"); // staged hunk 1 still in worktree
  expect((await git(repoDir, ["diff", "--cached"])).stdout).toBe(indexBefore);
});

test("AC9 the right-click menu offers Stage/Unstage and Discard only for unstaged lines", async () => {
  await setupThreeHunks();
  const w = await openRepoInApp();
  await selectFile(w, "Unstaged", "f.txt");
  await tick(w, "Added line 31"); // staged now
  await expect(lineBox(w, "Added line 31")).toHaveAttribute("aria-checked", "true");
  await lineBox(w, "Added line 31").click({ button: "right" });
  let menu = w.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: "Unstage 1 line" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /discard/i })).toHaveCount(0);
  await w.keyboard.press("Escape");
  await lineBox(w, "Added line 32").click({ button: "right" });
  menu = w.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: "Stage 1 line" })).toBeVisible();
  await menu.getByRole("menuitem", { name: "Discard 1 line" }).click();
  const dlg = w.getByRole("alertdialog");
  await expect(dlg).toContainText("Discard 1 line from f.txt?");
  await dlg.getByRole("button", { name: "Cancel" }).click();
});

test("AC7 stale guard: external edit after the diff shows -> the tick is refused with a notice, index unchanged, diff reloaded", async () => {
  await setupThreeHunks();
  const w = await openRepoInApp();
  await selectFile(w, "Unstaged", "f.txt");
  await expect(hunkBox(w, 2)).toBeVisible();
  const ls = lines(90);
  ls[4] = "EXTERNAL05";
  await fs.writeFile(path.join(repoDir, "f.txt"), join(ls)); // now only ONE hunk vs the index
  await hunkBox(w, 2).evaluate((b) => (b as HTMLButtonElement).click());
  await expect(w.locator(".gh-diff-view__notice")).toContainText("The file changed on disk, so nothing was staged.", { timeout: 10_000 });
  await w.locator(".gh-diff-view__notice").getByRole("button", { name: "Show details" }).click();
  await expect(w.locator(".gh-diff-view__notice")).toContainText(/reloaded/i);
  await expect(w.locator(".gh-diff-view__notice")).toContainText(/Try again/);
  expect((await git(repoDir, ["diff", "--cached"])).stdout).toBe("");
  await expect(w.getByText("EXTERNAL05")).toBeVisible();
  await expect(hunkBox(w, 1, 1)).toBeVisible();
  await expect(hunkBox(w, 1, 1)).toHaveAttribute("aria-checked", "false"); // the optimistic tick was reverted
});

test("AC11 scroll position and the row cursor are unchanged after a successful tick", async () => {
  await setupThreeHunks();
  const w = await openRepoInApp();
  await selectFile(w, "Unstaged", "f.txt");
  await expect(hunkBox(w, 2)).toBeVisible();
  const before = await w.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".gh-diff-view__hunks")!;
    el.scrollTop = 150;
    return { top: el.scrollTop, scrollable: el.scrollHeight > el.clientHeight };
  });
  expect(before.scrollable).toBe(true);
  expect(before.top).toBeGreaterThan(50);
  // DOM click so Playwright does not scroll the target into view first
  await hunkBox(w, 1).evaluate((b) => (b as HTMLButtonElement).click());
  await expect(hunkBox(w, 1)).toHaveAttribute("aria-checked", "true");
  await expect(fileRow(w, "Unstaged", "f.txt").getByRole("img", { name: "Partly staged" })).toBeVisible({ timeout: 10_000 });
  const after = await w.evaluate(() => document.querySelector<HTMLElement>(".gh-diff-view__hunks")!.scrollTop);
  expect(after).toBe(before.top);

  // the cursor survives a toggle too
  await diffGroup(w).focus();
  await w.keyboard.press("ArrowDown");
  const cursorId = await diffGroup(w).getAttribute("aria-activedescendant");
  expect(cursorId).toBeTruthy();
  await w.keyboard.press("Space");
  await expect(fileRow(w, "Unstaged", "f.txt")).toBeVisible();
  await expect.poll(() => diffGroup(w).getAttribute("aria-activedescendant")).toBe(cursorId);
  await expect(diffGroup(w)).toBeFocused();
});

test("AC10 keyboard: Up/Down skips context, Space toggles the row, Shift+Down then Space toggles a range, Esc clears, Tab reaches the hunk checkbox", async () => {
  await setupThreeHunks();
  const w = await openRepoInApp();
  await selectFile(w, "Unstaged", "f.txt");
  await expect(hunkBox(w, 1)).toBeVisible();
  await diffGroup(w).focus();
  await w.keyboard.press("ArrowDown"); // first changed row = -line05
  await expect(lineBox(w, "Removed line 5")).toHaveClass(/gh-diff-view__line--cursor/);
  await w.keyboard.press("Space");
  await expect(lineBox(w, "Removed line 5")).toHaveAttribute("aria-checked", "true");
  await w.keyboard.press("ArrowDown"); // +CHANGED05 (next changed row; no context between)
  await w.keyboard.press("ArrowDown"); // skips ~3 context rows into hunk 2: -line30
  await expect(lineBox(w, "Removed line 30")).toHaveClass(/gh-diff-view__line--cursor/);
  await w.keyboard.press("Shift+ArrowDown");
  await w.keyboard.press("Shift+ArrowDown");
  await expect(w.locator(".gh-diff-view__line--in-range")).toHaveCount(3);
  await w.keyboard.press("Space");
  await expect(lineBox(w, "Removed line 31")).toHaveAttribute("aria-checked", "true");
  await expect.poll(async () => (await git(repoDir, ["diff", "--cached", "-U0"])).stdout).toMatch(/-line30/);
  expect((await git(repoDir, ["diff", "--cached", "-U0"])).stdout).toMatch(/-line32/);
  await w.keyboard.press("Escape");
  await expect(w.locator(".gh-diff-view__line--in-range")).toHaveCount(0);
  // Tab from the diff reaches the first hunk checkbox, Space toggles that hunk
  await w.keyboard.press("Tab");
  await expect(hunkBox(w, 1)).toBeFocused();
  await w.keyboard.press("Space");
  await expect(hunkBox(w, 1)).toHaveAttribute("aria-checked", "true");
  await expect.poll(async () => (await git(repoDir, ["diff", "--cached", "-U0"])).stdout).toContain("+CHANGED05");
});

test("AC10 Command Palette: 'Stage/Unstage current hunk' and 'Discard hunk' act on the hunk under the cursor; Discard still confirms", async () => {
  await setupThreeHunks();
  const w = await openRepoInApp();
  await selectFile(w, "Unstaged", "f.txt");
  await expect(hunkBox(w, 1)).toBeVisible();
  // unavailable until a hunk has the cursor
  await w.keyboard.press("Control+k");
  await w.getByRole("combobox").fill("current hunk");
  await expect(w.getByRole("option", { name: /Stage\/Unstage current hunk/ })).toHaveCount(0);
  await w.keyboard.press("Escape");

  await diffGroup(w).focus();
  await w.keyboard.press("ArrowDown"); // cursor in hunk 1
  await w.keyboard.press("Control+k");
  await w.getByRole("combobox").fill("current hunk");
  await w.getByRole("option", { name: /Stage\/Unstage current hunk/ }).click();
  await expect(hunkBox(w, 1)).toHaveAttribute("aria-checked", "true");
  await expect.poll(cachedHunks).toBe(1);

  await w.keyboard.press("Control+k");
  await w.getByRole("combobox").fill("discard hunk");
  // hunk 1 is fully staged: nothing discardable, so the command is hidden
  await expect(w.getByRole("option", { name: /^Discard hunk/ })).toHaveCount(0);
  await w.keyboard.press("Escape");

  await tick(w, "Removed line 30"); // cursor moves to hunk 2
  await w.keyboard.press("Control+k");
  await w.getByRole("combobox").fill("discard hunk");
  await w.getByRole("option", { name: /^Discard hunk/ }).click();
  const dlg = w.getByRole("alertdialog");
  await expect(dlg).toContainText("f.txt");
  await dlg.getByRole("button", { name: "Cancel" }).click();
  expect(await fs.readFile(path.join(repoDir, "f.txt"), "utf8")).toContain("CHANGED30");
});

test("AC8 ineligible files (untracked, deleted, binary, staged-added) show no checkboxes and keep whole-file controls", async () => {
  repoDir = await initRepo();
  await writeFile(repoDir, "gone.txt", "a\nb\nc\n");
  await fs.writeFile(path.join(repoDir, "bin.dat"), Buffer.from([0, 1, 2, 3, 0, 5]));
  await commitAll(repoDir, "base");
  await fs.rm(path.join(repoDir, "gone.txt"));
  await fs.writeFile(path.join(repoDir, "bin.dat"), Buffer.from([0, 9, 2, 3, 0, 7, 7]));
  await writeFile(repoDir, "untracked.txt", "x\ny\n");
  await writeFile(repoDir, "added.txt", "p\nq\n");
  await git(repoDir, ["add", "added.txt"]);
  const w = await openRepoInApp();
  const none = async () => {
    await expect(w.getByRole("checkbox")).toHaveCount(0);
    await expect(w.getByText("Line-level staging unavailable for this file.")).toHaveCount(0); // only "ambiguous" explains itself
  };
  await selectFile(w, "Unstaged", "gone.txt");
  await expect(w.locator(".gh-diff-view__line").first()).toBeVisible();
  await none();
  await selectFile(w, "Unstaged", "bin.dat");
  await expect(w.getByText(/Binary file/)).toBeVisible();
  await none();
  await selectFile(w, "Untracked", "untracked.txt");
  await expect(w.locator(".gh-diff-view__line").first()).toBeVisible();
  await none();
  await selectFile(w, "Staged", "added.txt");
  await expect(w.locator(".gh-diff-view__line").first()).toBeVisible();
  await none();
  // whole-file controls still work
  await fileRow(w, "Unstaged", "gone.txt").hover();
  await fileRow(w, "Unstaged", "gone.txt").getByRole("button", { name: "Stage", exact: true }).click();
  await expect(fileRow(w, "Staged", "gone.txt")).toBeVisible({ timeout: 10_000 });
});

/** A staged line edited again in the worktree cannot be mapped exactly (FR-481): git-core answers "ambiguous". */
async function setupAmbiguous() {
  repoDir = await initRepo();
  await writeFile(repoDir, "amb.txt", "a\nb\nc\n");
  await commitAll(repoDir, "base");
  await writeFile(repoDir, "amb.txt", "a\nB1\nc\n");
  await git(repoDir, ["add", "amb.txt"]);
  await writeFile(repoDir, "amb.txt", "a\nB2\nc\n");
}

test("AC8 ambiguous mapping: falls back to the separate diffs with exactly one neutral note, never a half tick; the file stays in both sections", async () => {
  await setupAmbiguous();
  const w = await openRepoInApp();
  await selectFile(w, "Unstaged", "amb.txt");
  await expect(w.getByText("Line-level staging unavailable for this file.")).toBeVisible({ timeout: 10_000 });
  await expect(w.getByRole("checkbox")).toHaveCount(0);
  await expect(w.locator(".gh-diff-view__line").first()).toBeVisible();
  await expect(fileRow(w, "Staged", "amb.txt")).toBeVisible();
  await expect(fileRow(w, "Unstaged", "amb.txt")).toBeVisible();
  await expect(w.getByRole("img", { name: "Partly staged" })).toHaveCount(0);
  // whole-file controls remain
  await fileRow(w, "Unstaged", "amb.txt").hover();
  await expect(fileRow(w, "Unstaged", "amb.txt").getByRole("button", { name: "Stage", exact: true })).toBeVisible();
});

test("AC13 locked index: the failed apply surfaces git's message, the tick reverts, and the UI matches porcelain", async () => {
  await setupThreeHunks();
  const w = await openRepoInApp();
  await selectFile(w, "Unstaged", "f.txt");
  await expect(hunkBox(w, 2)).toBeVisible();
  await fs.writeFile(path.join(repoDir, ".git", "index.lock"), "");
  await hunkBox(w, 2).click();
  await expect(w.getByRole("alert").first()).toBeVisible({ timeout: 10_000 });
  await w.screenshot({ path: path.join(shotDir, "locked-index-error.png") });
  const msg = (await w.getByRole("alert").first().innerText()).toLowerCase();
  expect(msg).toContain("another git process holds index.lock");
  expect(msg).not.toContain("core.");
  await expect(w.getByRole("alert").first().locator("xpath=ancestor::*[contains(@class,'gh-changes-panel__diff')]")).toHaveCount(1);
  await expect(hunkBox(w, 2)).toHaveAttribute("aria-checked", "false"); // reverted
  await fs.rm(path.join(repoDir, ".git", "index.lock"));
  expect((await git(repoDir, ["status", "--porcelain"])).stdout).toBe(" M f.txt\n");
  await expect(fileRow(w, "Staged", "f.txt")).toHaveCount(0);
  await expect(fileRow(w, "Unstaged", "f.txt")).toBeVisible();
  // not stuck busy: a retry goes through
  await hunkBox(w, 2).click();
  await expect.poll(cachedHunks).toBe(1);
});

for (const theme of ["light", "dark"] as const) {
  test(`visuals ${theme}: default, hover hunk checkbox, mixed hunk, Shift range, discard confirm, mixed file row`, async () => {
    await setupThreeHunks();
    const w = await openRepoInApp();
    await setTheme(w, theme);
    await selectFile(w, "Unstaged", "f.txt");
    await expect(hunkBox(w, 2)).toBeVisible();
    await w.mouse.move(5, 5);
    await w.screenshot({ path: path.join(shotDir, `${theme}-01-default.png`) });

    await hunkHeader(w, 2).hover();
    await w.screenshot({ path: path.join(shotDir, `${theme}-02-hover-hunk-checkbox.png`) });

    await tick(w, "Added line 31"); // hunk 2 becomes mixed (dash)
    await expect(hunkBox(w, 2)).toHaveAttribute("aria-checked", "mixed");
    await w.mouse.move(5, 5);
    await w.screenshot({ path: path.join(shotDir, `${theme}-03-mixed-hunk.png`) });

    await tick(w, "Removed line 60");
    await tick(w, "Removed line 64", ["Shift"]);
    await expect(lineBox(w, "Removed line 62")).toHaveAttribute("aria-checked", "true");
    await w.mouse.move(5, 5);
    await w.screenshot({ path: path.join(shotDir, `${theme}-04-shift-range.png`) });

    await hunkHeader(w, 3).hover();
    await w.getByRole("button", { name: "Discard hunk 3 of 3" }).click();
    const dialog = w.getByRole("alertdialog");
    await expect(dialog).toContainText("Discard");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await w.screenshot({ path: path.join(shotDir, `${theme}-05-discard-confirm.png`) });
    await dialog.getByRole("button", { name: "Cancel" }).click();

    await expect(fileRow(w, "Unstaged", "f.txt").getByRole("img", { name: "Partly staged" })).toBeVisible();
    await fileRow(w, "Unstaged", "f.txt").hover();
    await w.screenshot({ path: path.join(shotDir, `${theme}-06-mixed-file-row.png`) });
  });

  test(`visuals ${theme}: ambiguous note`, async () => {
    await setupAmbiguous();
    const w = await openRepoInApp();
    await setTheme(w, theme);
    await selectFile(w, "Unstaged", "amb.txt");
    await expect(w.getByText("Line-level staging unavailable for this file.")).toBeVisible({ timeout: 10_000 });
    await w.mouse.move(5, 5);
    await w.screenshot({ path: path.join(shotDir, `${theme}-07-ambiguous-note.png`) });
  });
}

test("no-trailing-newline file: ticking the last line keeps the marker (byte compare)", async () => {
  repoDir = await initRepo();
  await fs.writeFile(path.join(repoDir, "n.txt"), "a\nb\nc");
  await commitAll(repoDir, "base");
  await fs.writeFile(path.join(repoDir, "n.txt"), "a\nb\nC");
  const w = await openRepoInApp();
  await selectFile(w, "Unstaged", "n.txt");
  await hunkBox(w, 1, 1).click();
  await expect(fileRow(w, "Unstaged", "n.txt")).toHaveCount(0, { timeout: 10_000 });
  await expect(fileRow(w, "Staged", "n.txt")).toBeVisible();
  expect(gitBytes(["show", ":n.txt"]).toString("latin1")).toBe("a\nb\nC");
});

for (const autocrlf of ["true", "false"] as const) {
  test(`CRLF file, core.autocrlf=${autocrlf}: stage 1 of 2 changes with a Shift range, then discard the rest, bytes`, async () => {
    repoDir = await initRepo();
    await git(repoDir, ["config", "core.autocrlf", autocrlf]);
    const base = ["one", "two", "three", "four", "five"];
    await fs.writeFile(path.join(repoDir, "c.txt"), base.join("\r\n") + "\r\n");
    await commitAll(repoDir, "base");
    const edited = ["one", "TWO", "three", "FOUR", "five"];
    // Context 3 merges both edits into one hunk -> 4 changed lines.
    await fs.writeFile(path.join(repoDir, "c.txt"), edited.join("\r\n") + "\r\n");
    const w = await openRepoInApp();
    await selectFile(w, "Unstaged", "c.txt");
    await expect(w.locator(".gh-diff-view__line").first()).toBeVisible();
    await w.screenshot({ path: path.join(shotDir, `crlf-${autocrlf}.png`) });
    const controls = await w.getByRole("checkbox").count();
    if (controls === 0) {
      // eslint-disable-next-line no-console
      console.log(`autocrlf=${autocrlf}: no checkboxes (fell back to the separate diff)`);
      test.info().annotations.push({ type: "finding", description: "no checkboxes for CRLF file" });
      return;
    }
    const before = gitBytes(["show", ":c.txt"]).toString("latin1");
    // remove 'two' + add 'TWO' only
    await tick(w, "Removed line 2");
    await tick(w, "Added line 2", ["Shift"]);
    await expect(fileRow(w, "Unstaged", "c.txt").getByRole("img", { name: "Partly staged" })).toBeVisible({ timeout: 10_000 });
    // blob bytes: autocrlf=true stores LF; false stores CRLF verbatim. Poll: the second tick is a queued, optimistic operation.
    const eol = autocrlf === "true" ? "\n" : "\r\n";
    await expect
      .poll(() => gitBytes(["show", ":c.txt"]).toString("latin1"))
      .toBe(["one", "TWO", "three", "four", "five"].join(eol) + eol);
    // eslint-disable-next-line no-console
    console.log(`autocrlf=${autocrlf} before=${JSON.stringify(before)} index=${JSON.stringify(gitBytes(["show", ":c.txt"]).toString("latin1"))}`);
    // worktree untouched by staging
    expect((await fs.readFile(path.join(repoDir, "c.txt"))).toString("latin1")).toBe(edited.join("\r\n") + "\r\n");

    // discard the remaining FOUR/four change lines (the hunk header Discard offers only the unstaged ones)
    await hunkHeader(w, 1).hover();
    await w.getByRole("button", { name: "Discard hunk 1 of 1" }).click();
    await expect(w.getByRole("alertdialog")).toContainText("Discard 2 lines from c.txt?");
    await w.getByRole("alertdialog").getByRole("button", { name: "Discard 2 lines" }).click();
    await expect(w.getByRole("alertdialog")).toHaveCount(0);
    await expect.poll(async () => (await fs.readFile(path.join(repoDir, "c.txt"), "latin1")).includes("FOUR")).toBe(false);
    const wt = (await fs.readFile(path.join(repoDir, "c.txt"))).toString("latin1");
    // eslint-disable-next-line no-console
    console.log(`autocrlf=${autocrlf} worktree after discard=${JSON.stringify(wt)}`);
    expect(wt).toBe(["one", "TWO", "three", "four", "five"].join("\r\n") + "\r\n");
    expect((await git(repoDir, ["status", "--porcelain"])).stdout.trim()).toMatch(/^M\s+c\.txt$|^MM c\.txt$|^M {2}c\.txt$/);
  });
}
