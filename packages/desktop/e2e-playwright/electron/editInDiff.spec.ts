// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Real-Electron check of specs/edit-in-diff.md slice B (editor core): FR-467..475, FR-527..531, FR-535..540.
 * Screenshots go to $EDIT_SHOTS (or the OS temp dir). Set GH_FIXTURE_ROOT to build the repos outside the package.
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
const requests: string[] = [];

test.beforeEach(async () => {
  handle = await launchGitHydra();
  shotDir = process.env.EDIT_SHOTS ?? (await fs.mkdtemp(path.join(os.tmpdir(), "githydra-pw-edit-")));
  await fs.mkdir(shotDir, { recursive: true });
  requests.length = 0;
  handle.window.on("request", (r) => requests.push(r.url()));
});
test.afterEach(async () => {
  await closeApp(handle);
  await removeUserDataDir(handle.userDataDir);
  if (repoDir) await cleanup(repoDir);
});

async function makeRepo(): Promise<string> {
  const root = process.env.GH_FIXTURE_ROOT;
  if (!root) return initRepo();
  const dir = await fs.mkdtemp(path.join(root, "edit-"));
  await git(dir, ["init", "-q", "--initial-branch=main"]);
  return dir;
}

const put = (rel: string, data: string | Buffer) => fs.writeFile(path.join(repoDir, rel), data);
const bytes = (rel: string) => fs.readFile(path.join(repoDir, rel));
const numbered = (n: number, tag = "line") => Array.from({ length: n }, (_, i) => `${tag}${String(i + 1).padStart(2, "0")}`);

async function openRepoInApp(): Promise<Page> {
  await stubOpenRepoDialog(handle.app, repoDir);
  await handle.window.getByRole("button", { name: "Open a repository", exact: true }).click();
  await handle.window.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });
  await handle.window.getByRole("button", { name: /^changes/i }).click();
  await handle.window.locator(".gh-changes-panel__file").first().waitFor({ timeout: 15_000 });
  return handle.window;
}

async function setTheme(w: Page, theme: "light" | "dark") {
  const current = await w.evaluate(() => document.documentElement.dataset.theme);
  if (current === theme) return;
  await w.getByRole("button", { name: "More actions" }).click();
  await w.getByRole("menuitem", { name: /switch to (light|dark) theme/i }).click();
  await expect.poll(() => w.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
}

const fileRow = (w: Page, section: "Staged" | "Unstaged" | "Untracked", p: string) =>
  w
    .locator("section.gh-changes-panel__section", { has: w.locator("h3", { hasText: new RegExp(`^${section}`) }) })
    .locator("li.gh-changes-panel__file", { hasText: p });
const rowLabel = (w: Page, section: "Staged" | "Unstaged" | "Untracked", p: string) => fileRow(w, section, p).locator(".gh-changes-panel__file-label");
const editBtn = (w: Page) => w.locator("[data-edit-button]");
const cm = (w: Page) => w.locator(".cm-content");
const toolbar = (w: Page) => w.getByRole("toolbar", { name: "Editor actions" });
const saveBtn = (w: Page) => toolbar(w).getByRole("button", { name: "Save", exact: true });
const saveStageBtn = (w: Page) => toolbar(w).getByRole("button", { name: /^Save and stage/ });
const status = (w: Page) => w.locator(".gh-edit [role=status]");

async function selectAndEdit(w: Page, section: "Staged" | "Unstaged" | "Untracked", p: string) {
  await rowLabel(w, section, p).click();
  await expect(editBtn(w)).toBeEnabled();
  await editBtn(w).click();
  await expect(cm(w)).toBeVisible();
  await expect(cm(w)).toBeFocused();
}

const cachedDiff = async () => (await git(repoDir, ["diff", "--cached"])).stdout;

test("Edit button: type + Ctrl+S writes CRLF, BOM and no-final-newline byte-exact; git diff shows it; own save is silent", async () => {
  repoDir = await makeRepo();
  const bom = "﻿";
  await put("crlf.txt", bom + ["one", "two", "three"].join("\r\n"));
  await commitAll(repoDir, "base");
  await put("crlf.txt", bom + ["one", "two edited", "three"].join("\r\n"));
  const w = await openRepoInApp();
  await selectAndEdit(w, "Unstaged", "crlf.txt");

  await expect(cm(w)).toHaveAttribute("aria-label", "Editing crlf.txt");
  await expect(w.locator(".gh-edit__foot")).toContainText("CRLF");
  await expect(w.locator(".gh-edit__foot")).toContainText("UTF-8 with BOM, plain text");
  await expect(w.locator(".gh-edit__foot")).toContainText("no final newline");
  await expect(saveBtn(w)).toHaveAttribute("aria-disabled", "true");

  // FR-539: the hunk's first working-file line is where the caret starts.
  await expect(w.locator(".gh-edit__foot")).toContainText("Ln 1, Col 1");
  await w.keyboard.press("End");
  await w.keyboard.type("!");
  await expect(w.locator(".gh-edit__state", { hasText: "Unsaved" })).toBeVisible();
  await expect(fileRow(w, "Unstaged", "crlf.txt").locator(".gh-changes-panel__unsaved")).toHaveCount(1);
  await setTheme(w, "dark");
  await w.waitForTimeout(400);
  await w.screenshot({ path: path.join(shotDir, "dark-dirty.png") });
  await setTheme(w, "light");
  await w.waitForTimeout(400);
  await w.screenshot({ path: path.join(shotDir, "light-dirty.png") });

  await cm(w).focus();
  await w.keyboard.press("Control+s");
  await expect(w.locator(".gh-edit__state--saved")).toBeVisible();
  const saved = await bytes("crlf.txt");
  expect(saved.toString("latin1")).toBe(Buffer.from(bom + "one!\r\ntwo edited\r\nthree", "utf8").toString("latin1"));
  expect((await git(repoDir, ["diff"])).stdout).toContain("one!");

  // FR-536/AC16: our own save raises no banner, and a second edit + save does not ask to overwrite.
  await w.waitForTimeout(800);
  await expect(w.getByRole("alert").filter({ hasText: /changed on disk/ })).toHaveCount(0);
  await cm(w).focus();
  await w.keyboard.press("Control+End");
  await w.keyboard.type("?");
  await w.keyboard.press("Control+s");
  await expect.poll(async () => (await bytes("crlf.txt")).toString("utf8")).toContain("three?");
  await expect(w.getByRole("alertdialog")).toHaveCount(0);

  // AC9: zero network requests.
  expect(requests.filter((u) => !/^(file|devtools|data|blob):/.test(u))).toEqual([]);
});

test("double-click on a row opens at that line; gutter, hunk header and checkboxes never start an edit or toggle", async () => {
  repoDir = await makeRepo();
  const base = numbered(40);
  await put("f.txt", base.join("\n") + "\n");
  await commitAll(repoDir, "base");
  const edited = [...base];
  edited[4] = "CHANGED05";
  edited[30] = "CHANGED31";
  await put("f.txt", edited.join("\n") + "\n");
  const w = await openRepoInApp();
  await rowLabel(w, "Unstaged", "f.txt").click();
  await expect(w.getByRole("checkbox", { name: "Hunk 1 of 2" })).toBeVisible();

  const stagedInitial = await cachedDiff();
  const gutter = w.locator(".gh-diff-view__gutter--check").first();
  await gutter.dblclick();
  await expect(cm(w)).toHaveCount(0);
  await w.locator(".gh-diff-view__hunk-header").first().dblclick();
  await expect(cm(w)).toHaveCount(0);
  // Gutter and hunk-header double-clicks must leave the index untouched.
  expect(await cachedDiff()).toBe(stagedInitial);
  // A checkbox double-click is two real clicks (each may toggle, and the 2nd can land mid-reload), so only
  // "no editor opens" is asserted; then settle on observable state (checkbox agrees with the index) rather than sleeping.
  await w.getByRole("checkbox", { name: "Hunk 1 of 2" }).dblclick();
  await expect(cm(w)).toHaveCount(0);
  await expect
    .poll(async () => {
      const staged = (await cachedDiff()) !== "";
      const state = await w.getByRole("checkbox", { name: "Hunk 1 of 2" }).getAttribute("aria-checked");
      const stagedRow = await rowLabel(w, "Staged", "f.txt").count();
      return `${staged}|${state}|${stagedRow > 0}`;
    })
    .toMatch(/^(false\|false\|false|true\|(true|mixed)\|true)$/);
  const stagedBefore = await cachedDiff();
  await w.locator(".gh-diff-view__line-content", { hasText: "CHANGED31" }).dblclick();
  await expect(cm(w)).toBeVisible();
  await expect(w.locator(".gh-edit__foot")).toContainText("Ln 31,");
  expect(await cachedDiff()).toBe(stagedBefore);
});

test("E opens the editor only from inside the diff pane, by physical key (Hebrew layout), not from a text input", async () => {
  repoDir = await makeRepo();
  await put("f.txt", "a\nb\nc\n");
  await commitAll(repoDir, "base");
  await put("f.txt", "a\nB\nc\n");
  const w = await openRepoInApp();
  await rowLabel(w, "Unstaged", "f.txt").click();
  await expect(w.getByRole("checkbox", { name: "Hunk 1 of 1" })).toBeVisible();

  await w.locator("#gh-commit-subject").focus();
  await w.keyboard.press("e");
  await expect(cm(w)).toHaveCount(0);
  await expect(w.locator("#gh-commit-subject")).toHaveValue("e");

  await w.locator("[data-combined-root]").focus();
  await w.evaluate(() =>
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "ק", code: "KeyE", bubbles: true, cancelable: true })),
  );
  await expect(cm(w)).toBeVisible();
});

test("Save and stage whole file stages everything; the editor stays open and clean; plain Save leaves the index byte-identical", async () => {
  repoDir = await makeRepo();
  const base = numbered(60);
  await put("f.txt", base.join("\n") + "\n");
  await commitAll(repoDir, "base");
  const edited = [...base];
  edited[4] = "STAGED05";
  edited[50] = "WORK51";
  await put("f.txt", edited.join("\n") + "\n");
  const w = await openRepoInApp();
  await rowLabel(w, "Unstaged", "f.txt").click();
  await w.getByRole("checkbox", { name: "Hunk 1 of 2" }).click();
  await expect(rowLabel(w, "Staged", "f.txt")).toBeVisible();
  const before = await cachedDiff();
  expect(before).toContain("STAGED05");

  await selectAndEdit(w, "Staged", "f.txt");
  await expect(w.locator(".gh-edit__note")).toContainText("Editing the working copy. Your staged version is unchanged.");
  await expect(w.locator(".gh-edit__tag", { hasText: "Working copy" })).toBeVisible();
  await expect(saveStageBtn(w)).toHaveText("Save and stage whole file");
  await saveStageBtn(w).hover();
  await expect(saveStageBtn(w)).toHaveAttribute("data-tip", "Replaces your current staged version with the full working copy.");

  await cm(w).focus();
  await w.keyboard.press("Control+End");
  await w.keyboard.type("tail");
  await expect(fileRow(w, "Unstaged", "f.txt").locator(".gh-changes-panel__file-actions button[aria-disabled=true]").first()).toBeVisible();
  await expect(fileRow(w, "Staged", "f.txt").locator(".gh-changes-panel__file-actions button[aria-disabled=true]")).toHaveCount(1);
  await expect(w.locator(".gh-diff-view__hunks")).toHaveCount(0);

  await w.keyboard.press("Control+s");
  await expect(w.locator(".gh-edit__state--saved")).toBeVisible();
  expect(await cachedDiff()).toBe(before);

  await w.keyboard.type("more");
  await w.keyboard.press("Control+Shift+s");
  await expect(w.locator(".gh-edit__stat")).toHaveText("Saved and staged the whole file.");
  await expect.poll(async () => (await git(repoDir, ["status", "--porcelain"])).stdout.trim()).toBe("M  f.txt");
  await expect(cm(w)).toBeVisible();
  await expect(w.locator(".gh-edit__state", { hasText: "Unsaved" })).toHaveCount(0);
  expect((await bytes("f.txt")).toString()).toContain("tailmore");
});

test("leaving with unsaved edits asks Save / Discard / Cancel; Save is focused; Discard leaves disk untouched", async () => {
  repoDir = await makeRepo();
  await put("a.txt", "a1\na2\n");
  await put("b.txt", "b1\nb2\n");
  await commitAll(repoDir, "base");
  await put("a.txt", "a1\nA2\n");
  await put("b.txt", "b1\nB2\n");
  const w = await openRepoInApp();
  await selectAndEdit(w, "Unstaged", "a.txt");
  await w.keyboard.type("zzz");
  const diskBefore = (await bytes("a.txt")).toString();

  await rowLabel(w, "Unstaged", "b.txt").click();
  const dlg = w.getByRole("alertdialog");
  await expect(dlg).toBeVisible();
  await expect(dlg.getByRole("button", { name: "Save", exact: true })).toBeFocused();
  await dlg.getByRole("button", { name: "Cancel" }).click();
  await expect(cm(w)).toBeVisible();
  await expect(cm(w)).toBeFocused();

  await w.keyboard.press("Escape");
  await expect(dlg).toBeVisible();
  await dlg.getByRole("button", { name: "Discard" }).click();
  await expect(cm(w)).toHaveCount(0);
  await expect(editBtn(w)).toBeFocused();
  expect((await bytes("a.txt")).toString()).toBe(diskBefore);

  await selectAndEdit(w, "Unstaged", "a.txt");
  await w.keyboard.type("kept");
  await rowLabel(w, "Unstaged", "b.txt").click();
  await w.getByRole("alertdialog").getByRole("button", { name: "Save", exact: true }).click();
  await expect(cm(w)).toHaveCount(0);
  expect((await bytes("a.txt")).toString()).toContain("kept");
});

test("external change: clean buffer reloads quietly; dirty buffer shows the banner; Keep mine then Save asks to overwrite with Cancel focused", async () => {
  repoDir = await makeRepo();
  await put("f.txt", "one\ntwo\nthree\n");
  await commitAll(repoDir, "base");
  await put("f.txt", "one\nTWO\nthree\n");
  const w = await openRepoInApp();
  await selectAndEdit(w, "Unstaged", "f.txt");

  await put("f.txt", "one\nTWO\nthree\nfour\n");
  await expect(w.locator(".cm-line", { hasText: "four" })).toBeVisible({ timeout: 15_000 });
  await expect(w.locator(".gh-edit__stat")).toContainText("Reloaded from disk");
  await expect(w.getByRole("alert")).toHaveCount(0);

  await cm(w).focus();
  await w.keyboard.type("mine ");
  await put("f.txt", "one\nTWO\nthree\nfour\nfive\n");
  const banner = w.getByRole("alert").filter({ hasText: "changed on disk. Neither version" });
  await expect(banner).toBeVisible({ timeout: 15_000 });
  expect((await bytes("f.txt")).toString()).toContain("five");
  await w.screenshot({ path: path.join(shotDir, "banner.png") });
  await banner.getByRole("button", { name: "Keep mine" }).click();
  await expect(banner).toHaveCount(0);
  await cm(w).focus();
  await w.keyboard.press("Control+s");
  const dlg = w.getByRole("alertdialog");
  await expect(dlg).toBeVisible();
  await expect(dlg.getByRole("button", { name: "Cancel" })).toBeFocused();
  await dlg.getByRole("button", { name: "Cancel" }).click();
  expect((await bytes("f.txt")).toString()).toContain("five");
  await w.keyboard.press("Control+s");
  await w.getByRole("alertdialog").getByRole("button", { name: "Overwrite" }).click();
  await expect.poll(async () => (await bytes("f.txt")).toString()).toContain("mine");
  expect((await bytes("f.txt")).toString()).not.toContain("five");
});

test("ineligible files show Edit disabled with the reason; double-click flashes it; bytes untouched", async () => {
  repoDir = await makeRepo();
  await put("bin.dat", Buffer.from([0, 1, 2, 3, 0, 255]));
  await put("big.txt", "x\n");
  await put("latin.txt", "plain\n");
  await commitAll(repoDir, "base");
  await put("bin.dat", Buffer.from([0, 1, 2, 3, 0, 254]));
  await put("big.txt", "y".repeat(1_100_000) + "\n");
  await put("latin.txt", Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  const w = await openRepoInApp();
  const cases: [string, RegExp][] = [
    ["bin.dat", /Binary file/],
    ["big.txt", /File too large to edit here/],
    ["latin.txt", /Not UTF-8, edit externally/],
  ];
  for (const [file, reason] of cases) {
    const before = await bytes(file);
    await rowLabel(w, "Unstaged", file).click();
    await expect(editBtn(w)).toHaveAttribute("aria-disabled", "true", { timeout: 10_000 });
    await expect(w.locator(".gh-diff-view__edit-reason")).toHaveText(reason);
    await editBtn(w).click({ force: true });
    await expect(cm(w)).toHaveCount(0);
    expect((await bytes(file)).equals(before)).toBe(true);
  }
  await rowLabel(w, "Unstaged", "latin.txt").click();
  await expect(w.locator(".gh-diff-view__edit-reason")).toBeVisible();
  await w.locator(".gh-diff-view__line-content").first().dblclick();
  await expect(w.locator(".gh-diff-view__edit-reason--flash")).toBeVisible();
  await expect(cm(w)).toHaveCount(0);
});

test("symlink is ineligible (where the OS allows creating one)", async () => {
  repoDir = await makeRepo();
  await put("target.txt", "t\n");
  try {
    await fs.symlink("target.txt", path.join(repoDir, "link.txt"));
  } catch {
    test.skip(true, "this OS/user cannot create symlinks");
  }
  await commitAll(repoDir, "base");
  await fs.rm(path.join(repoDir, "link.txt"));
  await fs.symlink("other.txt", path.join(repoDir, "link.txt"));
  const w = await openRepoInApp();
  await rowLabel(w, "Unstaged", "link.txt").click();
  await expect(editBtn(w)).toHaveAttribute("aria-disabled", "true", { timeout: 10_000 });
  await expect(w.locator(".gh-diff-view__edit-reason")).toContainText(/Symbolic links/);
});

test("untracked file: edit, Save and stage stages it", async () => {
  repoDir = await makeRepo();
  await put("seed.txt", "s\n");
  await commitAll(repoDir, "base");
  await put("new.txt", "hello\nworld\n");
  const w = await openRepoInApp();
  await selectAndEdit(w, "Untracked", "new.txt");
  await expect(w.locator(".gh-edit__note")).toHaveCount(0);
  await expect(saveStageBtn(w)).toHaveText("Save and stage");
  await w.keyboard.type("X");
  await w.keyboard.press("Control+Shift+s");
  await expect.poll(async () => (await git(repoDir, ["status", "--porcelain"])).stdout.trim()).toBe("A  new.txt");
  expect((await bytes("new.txt")).toString()).toBe("Xhello\nworld\n");
});

test("Tab indents a multi-line selection, Shift+Tab outdents, Ctrl+M moves to the toolbar and back", async () => {
  repoDir = await makeRepo();
  await put("f.txt", "a\nb\nc\n");
  await commitAll(repoDir, "base");
  await put("f.txt", "a\nb\nC\n");
  const w = await openRepoInApp();
  await selectAndEdit(w, "Unstaged", "f.txt");
  await w.keyboard.press("Control+a");
  await w.keyboard.press("Tab");
  await expect(w.locator(".cm-line").nth(0)).toHaveText("  a");
  await expect(w.locator(".cm-line").nth(2)).toHaveText("  C");
  await w.keyboard.press("Shift+Tab");
  await expect(w.locator(".cm-line").nth(0)).toHaveText("a");
  await w.keyboard.press("Control+m");
  await expect(toolbar(w).getByRole("button").first()).toBeFocused();
  await w.keyboard.press("Control+m");
  await expect(cm(w)).toBeFocused();
});
