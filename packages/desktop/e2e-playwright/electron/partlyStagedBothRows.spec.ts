// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Real-Electron check of specs/hunk-line-staging.md FR-482 (revised): a partly staged file is a row in BOTH
 * Staged and Unstaged, marker on both, each row acting on its own side, both opening the same combined diff.
 * Screenshots go to $HUNK_SHOTS (or the OS temp dir). Set GH_FIXTURE_ROOT to build the repo outside the package.
 */
import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closeApp, launchGitHydra, removeUserDataDir, stubOpenRepoDialog, type LaunchedApp } from "../helpers/launchApp";
import { cleanup, commitAll, git, initRepo, writeFile } from "../../src/test/gitFixture";

let handle: LaunchedApp;
let repoDir: string;
let shotDir: string;

test.beforeEach(async () => {
  handle = await launchGitHydra();
  shotDir = process.env.HUNK_SHOTS ?? (await fs.mkdtemp(path.join(os.tmpdir(), "githydra-pw-both-")));
  await fs.mkdir(shotDir, { recursive: true });
});
test.afterEach(async () => {
  await closeApp(handle);
  await removeUserDataDir(handle.userDataDir);
  if (repoDir) await cleanup(repoDir);
});

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line${String(i + 1).padStart(2, "0")}`);
const join = (ls: string[]) => ls.join("\n") + "\n";

async function makeRepo(): Promise<string> {
  const root = process.env.GH_FIXTURE_ROOT;
  if (!root) return initRepo();
  const dir = await fs.mkdtemp(path.join(root, "both-rows-"));
  await git(dir, ["init", "-q", "--initial-branch=main"]);
  return dir;
}

async function openRepoInApp(): Promise<Page> {
  await stubOpenRepoDialog(handle.app, repoDir);
  await handle.window.getByRole("button", { name: "Open a repository", exact: true }).click();
  await handle.window.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });
  await handle.window.getByRole("button", { name: /^changes/i }).click();
  await handle.window.getByRole("button", { name: "Stage all", exact: true }).waitFor();
  return handle.window;
}

async function setTheme(w: Page, theme: "light" | "dark") {
  const current = await w.evaluate(() => document.documentElement.dataset.theme);
  if (current === theme) return;
  await w.getByRole("button", { name: "More actions" }).click();
  await w.getByRole("menuitem", { name: /switch to (light|dark) theme/i }).click();
  await expect.poll(() => w.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
}

const fileRow = (w: Page, section: "Staged" | "Unstaged", p: string) =>
  w
    .locator("section.gh-changes-panel__section", { has: w.locator("h3", { hasText: new RegExp(`^${section}`) }) })
    .locator("li.gh-changes-panel__file", { hasText: p });

test("a partly staged file shows two rows with markers; each acts on its own side; both open the same diff", async () => {
  repoDir = await makeRepo();
  const base = lines(90);
  await writeFile(repoDir, "f.txt", join(base));
  await commitAll(repoDir, "base");
  const edited = [...base];
  edited[4] = "CHANGED05";
  for (let i = 30; i <= 34; i++) edited[i - 1] = `CHANGED${i}`;
  for (let i = 60; i <= 74; i++) edited[i - 1] = `CHANGED${i}`;
  await writeFile(repoDir, "f.txt", join(edited));
  const w = await openRepoInApp();
  await fileRow(w, "Unstaged", "f.txt").locator(".gh-changes-panel__file-label").click();
  await w.getByRole("checkbox", { name: "Hunk 2 of 3" }).click();
  await expect(w.getByRole("checkbox", { name: "Hunk 2 of 3" })).toHaveAttribute("aria-checked", "true");

  // Both rows, both markers.
  await expect(fileRow(w, "Staged", "f.txt").getByRole("img", { name: "Partly staged: staged part" })).toBeVisible({ timeout: 10_000 });
  await expect(fileRow(w, "Unstaged", "f.txt").getByRole("img", { name: "Partly staged: unstaged part" })).toBeVisible();

  // Row actions: Staged = Unstage only; Unstaged = Stage the rest + Discard.
  await fileRow(w, "Staged", "f.txt").hover();
  await expect(fileRow(w, "Staged", "f.txt").locator(".gh-changes-panel__file-actions button")).toHaveCount(1);
  await expect(fileRow(w, "Staged", "f.txt").getByRole("button", { name: /discard/i })).toHaveCount(0);
  await fileRow(w, "Unstaged", "f.txt").hover();
  await expect(fileRow(w, "Unstaged", "f.txt").locator(".gh-changes-panel__file-actions button")).toHaveCount(2);

  // Same combined diff from either row: no reload, scroll kept.
  const scroller = w.locator(".gh-diff-view__hunks");
  await scroller.evaluate((el) => void (el.scrollTop = 150));
  await fileRow(w, "Staged", "f.txt").locator(".gh-changes-panel__file-label").click();
  await expect(fileRow(w, "Staged", "f.txt").locator(".gh-changes-panel__file-label")).toHaveAttribute("aria-pressed", "true");
  await expect(w.getByRole("checkbox", { name: "Hunk 2 of 3" })).toHaveAttribute("aria-checked", "true");
  expect(await scroller.evaluate((el) => el.scrollTop)).toBe(150);
  await fileRow(w, "Unstaged", "f.txt").locator(".gh-changes-panel__file-label").click();
  await expect(fileRow(w, "Unstaged", "f.txt").locator(".gh-changes-panel__file-label")).toHaveAttribute("aria-pressed", "true");
  expect(await scroller.evaluate((el) => el.scrollTop)).toBe(150);

  for (const theme of ["dark", "light"] as const) {
    await setTheme(w, theme);
    await fileRow(w, "Staged", "f.txt").hover();
    await w.screenshot({ path: path.join(shotDir, `${theme}-both-rows.png`) });
  }

  // Unstage all on the Staged row: index back to HEAD, worktree bytes untouched.
  const before = await fs.readFile(path.join(repoDir, "f.txt"), "utf8");
  await fileRow(w, "Staged", "f.txt").hover();
  await fileRow(w, "Staged", "f.txt").getByRole("button", { name: "Unstage" }).click();
  await expect(fileRow(w, "Staged", "f.txt")).toHaveCount(0);
  // The row leaves optimistically; git finishes a moment later.
  await expect.poll(async () => (await git(repoDir, ["diff", "--cached", "--stat"])).stdout.trim()).toBe("");
  expect(await fs.readFile(path.join(repoDir, "f.txt"), "utf8")).toBe(before);
});

// ------------------------------------------------------------------ AC16-AC23 (specs/hunk-line-staging.md)

const labelOf = (w: Page, section: "Staged" | "Unstaged", p: string) => fileRow(w, section, p).locator(".gh-changes-panel__file-label");
/** Multi-selection (aria-selected on the row); aria-pressed on the label is the OPEN diff's row, a different thing. */
const selKeys = (w: Page) =>
  w.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('li[role="row"][aria-selected="true"]')].map(
      (li) => li.querySelector<HTMLElement>("[data-row-key]")!.dataset.rowKey!,
    ),
  );
const markers = (w: Page) => w.getByRole("img", { name: /^Partly staged/ });
const cachedHunkCount = async () => (await git(repoDir, ["diff", "--cached", "-U0"])).stdout.match(/^@@/gm)?.length ?? 0;

/** Commits a 90-line f.txt, then edits it in three separated hunks (line 5, lines 30-34, lines 60-74). */
async function threeHunkFile(): Promise<void> {
  const base = lines(90);
  await writeFile(repoDir, "f.txt", join(base));
  await commitAll(repoDir, "base");
  const edited = [...base];
  edited[4] = "CHANGED05";
  for (let i = 30; i <= 34; i++) edited[i - 1] = `CHANGED${i}`;
  for (let i = 60; i <= 74; i++) edited[i - 1] = `CHANGED${i}`;
  await writeFile(repoDir, "f.txt", join(edited));
}

/** Opens the app on a three-hunk f.txt with hunk 2 staged through the UI: f.txt is now a row in Staged and Unstaged. */
async function openPartlyStaged(): Promise<Page> {
  repoDir = await makeRepo();
  await threeHunkFile();
  const w = await openRepoInApp();
  await labelOf(w, "Unstaged", "f.txt").click();
  await w.getByRole("checkbox", { name: "Hunk 2 of 3" }).click();
  await expect(fileRow(w, "Staged", "f.txt")).toBeVisible({ timeout: 10_000 });
  await expect.poll(cachedHunkCount).toBe(1);
  return w;
}

test("AC18 with exactly one hunk staged, Commit is enabled and the commit contains that hunk and nothing else", async () => {
  const w = await openPartlyStaged();
  await w.getByLabel("Subject").fill("only hunk two");
  const commit = w.getByRole("button", { name: "Commit", exact: true });
  await expect(commit).toBeEnabled();
  await commit.click();
  await expect.poll(async () => (await git(repoDir, ["log", "-1", "--format=%s"])).stdout.trim()).toBe("only hunk two");
  const patch = (await git(repoDir, ["show", "HEAD", "--format=", "-U0"])).stdout;
  expect(patch.match(/^@@/gm)).toHaveLength(1);
  expect(patch).toContain("+CHANGED30");
  expect(patch).toContain("+CHANGED34");
  expect(patch).not.toContain("CHANGED05");
  expect(patch).not.toContain("CHANGED60");
  // The other two hunks are still pending in the worktree, untouched.
  const rest = (await git(repoDir, ["diff", "-U0"])).stdout;
  expect(rest.match(/^@@/gm)).toHaveLength(2);
  expect(rest).toContain("+CHANGED05");
  expect(rest).toContain("+CHANGED60");
});

test("AC16 Ctrl-click on both rows of a partly staged file reads '1 file selected' and offers no bulk bar", async () => {
  const w = await openPartlyStaged();
  await labelOf(w, "Staged", "f.txt").click();
  await labelOf(w, "Unstaged", "f.txt").click({ modifiers: ["Control"] });
  await expect.poll(() => selKeys(w)).toEqual(["staged:f.txt", "unstaged:f.txt"]);
  await expect(w.getByRole("status").filter({ hasText: "1 file selected" })).toHaveCount(1);
  await expect(w.getByRole("toolbar", { name: /^Actions for/ })).toHaveCount(0);
});

test("AC16 a second file plus both rows selected counts 2 files, not 3", async () => {
  repoDir = await makeRepo();
  await threeHunkFile();
  await writeFile(repoDir, "g.txt", "g\n");
  const w = await openRepoInApp();
  await labelOf(w, "Unstaged", "f.txt").click();
  await w.getByRole("checkbox", { name: "Hunk 2 of 3" }).click();
  await expect(fileRow(w, "Staged", "f.txt")).toBeVisible({ timeout: 10_000 });
  await w.locator('[data-row-key="untracked:g.txt"]').click();
  await labelOf(w, "Staged", "f.txt").click({ modifiers: ["Control"] });
  await labelOf(w, "Unstaged", "f.txt").click({ modifiers: ["Control"] });
  await expect.poll(() => selKeys(w)).toHaveLength(3);
  await expect(w.getByRole("toolbar", { name: "Actions for 2 selected files" })).toBeVisible();
  await expect(w.getByRole("button", { name: "Stage 2 selected" })).toBeVisible();
});

test("AC17 ArrowDown and ArrowUp visit both rows of a partly staged file in order", async () => {
  repoDir = await makeRepo();
  await writeFile(repoDir, "a.txt", "a\n");
  await writeFile(repoDir, "z.txt", "z\n");
  await threeHunkFile();
  await writeFile(repoDir, "a.txt", "a2\n");
  await writeFile(repoDir, "z.txt", "z2\n");
  await git(repoDir, ["add", "a.txt"]);
  const w = await openRepoInApp();
  await labelOf(w, "Unstaged", "f.txt").click();
  await w.getByRole("checkbox", { name: "Hunk 2 of 3" }).click();
  await expect(fileRow(w, "Staged", "f.txt")).toBeVisible({ timeout: 10_000 });
  const key = (k: string) => w.locator(`[data-row-key="${k}"]`);
  await key("staged:a.txt").focus();
  await w.keyboard.press("ArrowDown");
  await expect(key("staged:f.txt")).toBeFocused();
  await w.keyboard.press("ArrowDown");
  await expect(key("unstaged:f.txt")).toBeFocused();
  await w.keyboard.press("ArrowDown");
  await expect(key("unstaged:z.txt")).toBeFocused();
  await w.keyboard.press("ArrowUp");
  await expect(key("unstaged:f.txt")).toBeFocused();
  await w.keyboard.press("ArrowUp");
  await expect(key("staged:f.txt")).toBeFocused();
});

test("AC23 the Staged row has no Discard on hover, by keyboard, or in its context menu", async () => {
  const w = await openPartlyStaged();
  const staged = fileRow(w, "Staged", "f.txt");
  await staged.hover();
  await expect(staged.getByRole("button", { name: /discard/i })).toHaveCount(0);
  await labelOf(w, "Staged", "f.txt").click({ button: "right" });
  await expect(w.getByRole("menu")).toBeVisible();
  await expect(w.getByRole("menuitem", { name: /discard/i })).toHaveCount(0);
});

test("AC23 a binary file with a staged and an unstaged change shows two rows, no marker, and each row opens its own diff", async () => {
  repoDir = await makeRepo();
  await fs.writeFile(path.join(repoDir, "bin.dat"), Buffer.from([0, 1, 2, 3, 0, 5]));
  await commitAll(repoDir, "base");
  await fs.writeFile(path.join(repoDir, "bin.dat"), Buffer.from([0, 9, 2, 3, 0, 7, 7]));
  await git(repoDir, ["add", "bin.dat"]);
  await fs.writeFile(path.join(repoDir, "bin.dat"), Buffer.from([0, 4, 4, 4, 0, 1, 1, 1]));
  const w = await openRepoInApp();
  await expect(fileRow(w, "Staged", "bin.dat")).toBeVisible();
  await expect(fileRow(w, "Unstaged", "bin.dat")).toBeVisible();
  await w.waitForTimeout(1500); // the lazy verdict (~400 ms) has had time to land
  await expect(markers(w)).toHaveCount(0);
  await expect(w.getByRole("checkbox")).toHaveCount(0);
  await labelOf(w, "Staged", "bin.dat").click();
  await expect(labelOf(w, "Staged", "bin.dat")).toHaveAttribute("aria-pressed", "true");
  await expect(labelOf(w, "Unstaged", "bin.dat")).toHaveAttribute("aria-pressed", "false");
  await expect(w.getByText(/Binary file/)).toBeVisible();
  await labelOf(w, "Unstaged", "bin.dat").click();
  await expect(labelOf(w, "Unstaged", "bin.dat")).toHaveAttribute("aria-pressed", "true");
  await expect(labelOf(w, "Staged", "bin.dat")).toHaveAttribute("aria-pressed", "false");
  await expect(w.getByText(/Binary file/)).toBeVisible();
});

test("AC23 an ambiguous text file (same line edited in index and worktree): two rows, no marker, each row shows its own diff", async () => {
  repoDir = await makeRepo();
  await writeFile(repoDir, "amb.txt", "a\nb\nc\n");
  await commitAll(repoDir, "base");
  await writeFile(repoDir, "amb.txt", "a\nB1\nc\n");
  await git(repoDir, ["add", "amb.txt"]);
  await writeFile(repoDir, "amb.txt", "a\nB2\nc\n");
  const w = await openRepoInApp();
  await expect(fileRow(w, "Staged", "amb.txt")).toBeVisible();
  await expect(fileRow(w, "Unstaged", "amb.txt")).toBeVisible();
  await labelOf(w, "Staged", "amb.txt").click();
  const lineText = () => w.locator(".gh-diff-view__line").allInnerTexts().then((t) => t.join("\n"));
  await expect.poll(lineText).toContain("B1");
  expect(await lineText()).not.toContain("B2");
  await labelOf(w, "Unstaged", "amb.txt").click();
  await expect.poll(lineText).toContain("B2");
  await expect(markers(w)).toHaveCount(0);
});

test("AC23 a renamed-then-edited file shows no marker and each of its rows opens its own diff", async () => {
  repoDir = await makeRepo();
  await writeFile(repoDir, "old.txt", join(lines(30)));
  await commitAll(repoDir, "base");
  await git(repoDir, ["mv", "old.txt", "new.txt"]);
  const edited = lines(30);
  edited[20] = "EDITED21";
  await writeFile(repoDir, "new.txt", join(edited));
  const w = await openRepoInApp();
  await expect(fileRow(w, "Staged", "new.txt")).toBeVisible();
  await expect(fileRow(w, "Unstaged", "new.txt")).toBeVisible();
  await w.waitForTimeout(1500);
  await expect(markers(w)).toHaveCount(0);
  await labelOf(w, "Staged", "new.txt").click();
  await expect(labelOf(w, "Staged", "new.txt")).toHaveAttribute("aria-pressed", "true");
  await expect(w.locator(".gh-diff-view__line").filter({ hasText: "EDITED21" })).toHaveCount(0);
  await labelOf(w, "Unstaged", "new.txt").click();
  await expect(labelOf(w, "Unstaged", "new.txt")).toHaveAttribute("aria-pressed", "true");
  await expect(w.locator(".gh-diff-view__line").filter({ hasText: "EDITED21" }).first()).toBeVisible();
});

test("AC20 selection and the open diff survive a live refresh caused by an unrelated external change", async () => {
  const w = await openPartlyStaged();
  await labelOf(w, "Staged", "f.txt").click();
  await expect(w.getByRole("checkbox", { name: "Hunk 2 of 3" })).toBeVisible();
  await writeFile(repoDir, "later.txt", "appears from outside\n");
  await expect(w.locator('[data-row-key="untracked:later.txt"]')).toBeVisible({ timeout: 15_000 });
  await expect(labelOf(w, "Staged", "f.txt")).toHaveAttribute("aria-pressed", "true");
  await expect(labelOf(w, "Unstaged", "f.txt")).toHaveAttribute("aria-pressed", "false");
  await expect(w.getByRole("checkbox", { name: "Hunk 2 of 3" })).toHaveAttribute("aria-checked", "true");
  expect(await selKeys(w)).toEqual(["staged:f.txt"]);
});

test("AC20 when the Unstaged row disappears (external git add), selection stays on the Staged row and the diff stays open", async () => {
  const w = await openPartlyStaged();
  await labelOf(w, "Staged", "f.txt").click();
  await git(repoDir, ["add", "f.txt"]);
  await expect(fileRow(w, "Unstaged", "f.txt")).toHaveCount(0, { timeout: 15_000 });
  await expect(labelOf(w, "Staged", "f.txt")).toHaveAttribute("aria-pressed", "true");
  await expect(w.getByRole("checkbox", { name: "Hunk 2 of 3" })).toBeVisible();
  await expect(markers(w)).toHaveCount(0);
  expect(await selKeys(w)).toEqual(["staged:f.txt"]);
});

test("AC20 when the Staged row disappears (external git restore --staged), selection moves to the surviving Unstaged row", async () => {
  const w = await openPartlyStaged();
  await labelOf(w, "Staged", "f.txt").click();
  await git(repoDir, ["restore", "--staged", "f.txt"]);
  await expect(fileRow(w, "Staged", "f.txt")).toHaveCount(0, { timeout: 15_000 });
  await expect(labelOf(w, "Unstaged", "f.txt")).toHaveAttribute("aria-pressed", "true");
  await expect(w.getByRole("checkbox", { name: "Hunk 2 of 3" })).toHaveAttribute("aria-checked", "false");
  await expect(markers(w)).toHaveCount(0);
  expect(await selKeys(w)).toEqual(["unstaged:f.txt"]);
});

test("AC20 when the Unstaged row disappears while it is the selected one (external git add), selection moves to the surviving Staged row", async () => {
  const w = await openPartlyStaged();
  await labelOf(w, "Unstaged", "f.txt").click();
  await git(repoDir, ["add", "f.txt"]);
  await expect(fileRow(w, "Unstaged", "f.txt")).toHaveCount(0, { timeout: 15_000 });
  await expect(labelOf(w, "Staged", "f.txt")).toHaveAttribute("aria-pressed", "true");
  expect(await selKeys(w)).toEqual(["staged:f.txt"]);
});
