// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Real-Electron check of specs/edit-recovery-draft.md slice B+C (FR-541..555, ACs 1, 2, 4, 6, 7, 8, 12): the draft written
 * while editing, every delete trigger, and the kill-and-relaunch restore. Relaunches reuse one fixed --user-data-dir.
 * Screenshots go to $GITHYDRA_SHOT_DIR (or the OS temp dir).
 */
import { test, expect, type Page } from "@playwright/test";
import { realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closeApp, launchGitHydra, removeUserDataDir, stubOpenRepoDialog, type LaunchedApp } from "../helpers/launchApp";
import { killTree } from "../helpers/processTree";
import { cleanup, commitAll, git, initRepo } from "../../src/test/gitFixture";
import { computeFileKey, computeRepoKey } from "../../electron/recoveryDrafts";

let handle: LaunchedApp;
let userDataDir: string;
let repoDir: string;
let shotDir: string;
const requests: string[] = [];

const BOM = "﻿";
const BASE = BOM + ["one", "two", "three"].join("\r\n");
const WORKING = BOM + ["one", "two edited", "three"].join("\r\n");
const WARNING =
  "This file changed on disk since your draft was saved. Restoring keeps your draft in the editor. Saving will ask before overwriting.";

function track(app: LaunchedApp) {
  requests.length = 0;
  app.window.on("request", (r) => requests.push(r.url()));
}

test.beforeEach(async () => {
  userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "githydra-pw-recovery-"));
  handle = await launchGitHydra([], userDataDir);
  shotDir = process.env.GITHYDRA_SHOT_DIR ?? path.join(os.tmpdir(), "githydra-recovery-shots");
  await fs.mkdir(shotDir, { recursive: true });
  track(handle);
});
test.afterEach(async () => {
  await closeApp(handle);
  await removeUserDataDir(userDataDir);
  if (repoDir) await cleanup(repoDir);
});

const put = (rel: string, data: string | Buffer) => fs.writeFile(path.join(repoDir, rel), data);
const bytes = (rel: string) => fs.readFile(path.join(repoDir, rel));

async function makeEditedRepo(): Promise<void> {
  repoDir = await initRepo();
  await put("crlf.txt", BASE);
  await commitAll(repoDir, "base");
  await put("crlf.txt", WORKING);
}

async function openChanges(w: Page): Promise<void> {
  await w.getByRole("button", { name: /^changes/i }).click();
  await w.locator(".gh-changes-panel__file").first().waitFor({ timeout: 15_000 });
}

async function openRepoInApp(): Promise<Page> {
  const w = handle.window;
  await stubOpenRepoDialog(handle.app, repoDir);
  await w.getByRole("button", { name: "Open a repository", exact: true }).click();
  await w.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });
  await openChanges(w);
  return w;
}

const cm = (w: Page) => w.locator(".cm-content");
const toolbar = (w: Page) => w.getByRole("toolbar", { name: "Editor actions" });
const restoreDialog = (w: Page) => w.getByRole("alertdialog", { name: /^Restore your unsaved edits to / });

async function startEditing(w: Page): Promise<void> {
  await w.locator('[data-row-key="unstaged:crlf.txt"]').click();
  const edit = w.locator("[data-edit-button]");
  await expect(edit).toBeEnabled();
  await edit.click();
  await expect(cm(w)).toBeFocused();
}

async function typeBang(w: Page): Promise<void> {
  await w.keyboard.press("Control+Home");
  await w.keyboard.press("End");
  await w.keyboard.type("!");
}

interface DraftOnDisk {
  repoKeyDir: string;
  file: string;
  json: Record<string, unknown>;
}
async function draftsOnDisk(): Promise<DraftOnDisk[]> {
  const root = path.join(userDataDir, "recovery-drafts");
  const out: DraftOnDisk[] = [];
  const dirs = await fs.readdir(root).catch(() => [] as string[]);
  for (const d of dirs) {
    for (const f of await fs.readdir(path.join(root, d)).catch(() => [] as string[])) {
      const text = await fs.readFile(path.join(root, d, f), "utf8").catch(() => "{}");
      out.push({ repoKeyDir: d, file: f, json: JSON.parse(text) as Record<string, unknown> });
    }
  }
  return out;
}
const draftCount = async () => (await draftsOnDisk()).length;

// A crash/power loss takes the WHOLE process tree down; killing only the main process orphaned the renderer/GPU helpers
// (leaked windows, worker teardown timeout), and nothing reaped them once `handle` moved on to the relaunched app.
async function hardKill(): Promise<void> {
  const proc = handle.app.process();
  const pid = proc.pid;
  const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
  if (pid) killTree(pid);
  else proc.kill("SIGKILL");
  await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
  // Releases Playwright's handle on the dead process and clears the launcher's registry entry; the tree is already dead.
  await closeApp(handle);
  await new Promise((r) => setTimeout(r, 500));
}

async function relaunchAndOpen(): Promise<Page> {
  handle = await launchGitHydra([], userDataDir);
  track(handle);
  const w = handle.window;
  // A restored tab may reopen the repo by itself; otherwise open it through the stubbed picker.
  const stashes = w.getByRole("button", { name: /^stashes/i });
  if (!(await stashes.waitFor({ timeout: 8000 }).then(() => true, () => false))) {
    await stubOpenRepoDialog(handle.app, repoDir);
    await w.getByRole("button", { name: "Open a repository", exact: true }).click();
    await stashes.waitFor({ timeout: 15_000 });
  }
  return w;
}

async function setTheme(w: Page, theme: "light" | "dark") {
  const current = await w.evaluate(() => document.documentElement.dataset.theme);
  if (current === theme) return;
  await w.getByRole("button", { name: "More actions" }).click();
  await w.getByRole("menuitem", { name: /switch to (light|dark) theme/i }).click();
  await expect.poll(() => w.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
}

async function paletteRestore(w: Page) {
  await w.keyboard.press("Control+k");
  const input = w.getByRole("combobox", { name: /command palette/i });
  await input.fill("restore unsaved");
  await w.keyboard.press("Enter");
}

const noNetwork = () => expect(requests.filter((u) => !/^(file|devtools|data|blob):/.test(u))).toEqual([]);

test("AC1/AC12: a draft appears within 2 s of the last keystroke (immediately on blur), only under userData, with hashed names; the repo and file are untouched", async () => {
  await makeEditedRepo();
  const statusBefore = (await git(repoDir, ["status", "--porcelain"])).stdout;
  const w = await openRepoInApp();
  await startEditing(w);
  expect(await draftCount()).toBe(0);

  await typeBang(w);
  const t0 = Date.now();
  await expect.poll(draftCount, { timeout: 3500, intervals: [100] }).toBe(1);
  expect(Date.now() - t0).toBeLessThan(3000);

  const [d] = await draftsOnDisk();
  expect(d!.repoKeyDir).toMatch(/^[0-9a-f]{64}$/);
  expect(d!.file).toMatch(/^[0-9a-f]{64}\.json$/);
  expect(d!.json).toMatchObject({ version: 1, relativePath: "crlf.txt", bom: true, eol: "crlf", finalNewline: false });
  expect(d!.json.content).toBe("one!\ntwo edited\nthree");
  expect(JSON.stringify(d!.json)).not.toContain(path.basename(repoDir));
  expect(d!.file).not.toContain("crlf");

  // Nothing in the repo or the real file changed.
  expect((await bytes("crlf.txt")).toString("utf8")).toBe(WORKING);
  expect((await git(repoDir, ["status", "--porcelain"])).stdout).toBe(statusBefore);
  const inRepo = await fs.readdir(repoDir);
  expect(inRepo.sort()).toEqual([".git", "crlf.txt"]);
  expect(await fs.readdir(path.join(repoDir, ".git")).then((n) => n.filter((x) => /draft|recover/i.test(x)))).toEqual([]);

  // Immediately on blur: focus leaves the editor.
  await w.keyboard.type("?");
  await cm(w).blur();
  const t1 = Date.now();
  await expect
    .poll(async () => (await draftsOnDisk())[0]?.json.content, { timeout: 1500, intervals: [50] })
    .toBe("one!?\ntwo edited\nthree");
  expect(Date.now() - t1).toBeLessThan(1500);
  noNetwork();
});

test("AC2: Save deletes the draft", async () => {
  await makeEditedRepo();
  const w = await openRepoInApp();
  await startEditing(w);
  await typeBang(w);
  await expect.poll(draftCount, { timeout: 4000 }).toBe(1);
  await cm(w).focus();
  await w.keyboard.press("Control+s");
  await expect(w.locator(".gh-edit__state--saved")).toBeVisible();
  await expect.poll(draftCount, { timeout: 4000 }).toBe(0);
  // A late debounce must not bring it back.
  await w.waitForTimeout(2600);
  expect(await draftCount()).toBe(0);
});

test("AC2: leave prompt Discard deletes the draft; Cancel keeps it", async () => {
  await makeEditedRepo();
  const w = await openRepoInApp();
  await startEditing(w);
  await typeBang(w);
  await expect.poll(draftCount, { timeout: 4000 }).toBe(1);

  await toolbar(w).getByRole("button", { name: "Back to diff" }).click();
  const dlg = w.getByRole("alertdialog", { name: /Save changes to crlf\.txt/ });
  await dlg.getByRole("button", { name: "Cancel" }).click();
  await w.waitForTimeout(500);
  expect(await draftCount()).toBe(1);

  await toolbar(w).getByRole("button", { name: "Back to diff" }).click();
  await dlg.getByRole("button", { name: "Discard" }).click();
  await expect(cm(w)).toHaveCount(0);
  await expect.poll(draftCount, { timeout: 3000 }).toBe(0);
  await w.waitForTimeout(2600);
  expect(await draftCount()).toBe(0);
  expect((await bytes("crlf.txt")).toString("utf8")).toBe(WORKING);
});

test("AC7/AC6: hard kill mid-edit, relaunch, Restore returns the exact text (CRLF, BOM, no final newline); Save writes it and deletes the draft", async () => {
  await makeEditedRepo();
  let w = await openRepoInApp();
  await startEditing(w);
  await typeBang(w);
  await expect.poll(draftCount, { timeout: 4000 }).toBe(1);
  await hardKill();
  expect(await draftCount()).toBe(1);
  expect((await bytes("crlf.txt")).toString("utf8")).toBe(WORKING);

  w = await relaunchAndOpen();
  const dlg = restoreDialog(w);
  await expect(dlg).toBeVisible({ timeout: 15_000 });
  await expect(dlg).toHaveAccessibleName("Restore your unsaved edits to crlf.txt?");
  await expect(dlg.getByRole("button", { name: "Restore" })).toBeFocused();
  await expect(dlg.getByRole("button", { name: "Discard" })).not.toBeFocused();
  await expect(dlg.getByText(WARNING)).toHaveCount(0);

  // AC8: Not now keeps the draft, ends the chain, and the palette entry re-offers it (once per theme for the screenshots).
  for (const theme of ["dark", "light"] as const) {
    await dlg.getByRole("button", { name: "Not now" }).click();
    await expect(dlg).toHaveCount(0);
    expect(await draftCount()).toBe(1);
    await setTheme(w, theme);
    await paletteRestore(w);
    await expect(dlg).toBeVisible();
    await w.screenshot({ path: path.join(shotDir, `restore-prompt-${theme}.png`) });
  }

  await dlg.getByRole("button", { name: "Restore" }).click();
  await expect(cm(w)).toBeVisible();
  await expect(w.locator(".gh-edit__state", { hasText: "Unsaved" })).toBeVisible();
  await expect(w.locator(".gh-edit__foot")).toContainText("CRLF");
  await expect(w.locator(".gh-edit__foot")).toContainText("UTF-8 with BOM");
  await expect(w.locator(".gh-edit__foot")).toContainText("no final newline");
  expect((await bytes("crlf.txt")).toString("utf8")).toBe(WORKING);

  await cm(w).focus();
  await w.keyboard.press("Control+s");
  await expect(w.locator(".gh-edit__state--saved")).toBeVisible();
  expect((await bytes("crlf.txt")).toString("latin1")).toBe(Buffer.from(BOM + "one!\r\ntwo edited\r\nthree", "utf8").toString("latin1"));
  await expect.poll(draftCount, { timeout: 4000 }).toBe(0);
  noNetwork();
});

test("AC6: the file changed on disk after the kill: warning text, then the FR-473 banner, and Save asks before overwriting (Cancel focused)", async () => {
  await makeEditedRepo();
  let w = await openRepoInApp();
  await startEditing(w);
  await typeBang(w);
  await expect.poll(draftCount, { timeout: 4000 }).toBe(1);
  await hardKill();

  const outside = BOM + ["one", "two from elsewhere", "three"].join("\r\n");
  await put("crlf.txt", outside);

  w = await relaunchAndOpen();
  const dlg = restoreDialog(w);
  await expect(dlg).toBeVisible({ timeout: 15_000 });
  await expect(dlg.getByText(WARNING)).toBeVisible();
  for (const theme of ["dark", "light"] as const) {
    await dlg.getByRole("button", { name: "Not now" }).click();
    await expect(dlg).toHaveCount(0);
    await setTheme(w, theme);
    await paletteRestore(w);
    await expect(dlg.getByText(WARNING)).toBeVisible();
    await w.screenshot({ path: path.join(shotDir, `restore-prompt-warning-${theme}.png`) });
  }

  await dlg.getByRole("button", { name: "Restore" }).click();
  await expect(cm(w)).toBeVisible();
  await expect(cm(w)).toContainText("one!");
  await expect(w.getByRole("alert").filter({ hasText: /changed on disk/ })).toBeVisible({ timeout: 5000 });
  await cm(w).focus();
  await w.keyboard.press("Control+s");
  const overwrite = w.getByRole("alertdialog", { name: "Overwrite the file on disk?" });
  await expect(overwrite).toBeVisible();
  await expect(overwrite.getByRole("button", { name: "Cancel" })).toBeFocused();
  await overwrite.getByRole("button", { name: "Cancel" }).click();
  expect((await bytes("crlf.txt")).toString("utf8")).toBe(outside);
  expect(await draftCount()).toBe(1);
});

test("AC8: Discard in the restore prompt deletes the draft and the file is never touched", async () => {
  await makeEditedRepo();
  let w = await openRepoInApp();
  await startEditing(w);
  await typeBang(w);
  await expect.poll(draftCount, { timeout: 4000 }).toBe(1);
  await hardKill();
  w = await relaunchAndOpen();
  const dlg = restoreDialog(w);
  await expect(dlg).toBeVisible({ timeout: 15_000 });
  await dlg.getByRole("button", { name: "Discard" }).click();
  await expect(dlg).toHaveCount(0);
  await expect.poll(draftCount, { timeout: 3000 }).toBe(0);
  expect((await bytes("crlf.txt")).toString("utf8")).toBe(WORKING);
});

test("AC4: a draft older than 7 days is purged at app start; one at 6 d 23 h survives", async () => {
  await makeEditedRepo();
  // Quit first so nothing else writes while the profile is seeded.
  await closeApp(handle);
  const real = realpathSync.native(repoDir);
  const repoKey = computeRepoKey(real);
  const dir = path.join(userDataDir, "recovery-drafts", repoKey);
  await fs.mkdir(dir, { recursive: true });
  const now = Date.now();
  const seed = async (rel: string, savedAt: number) => {
    const file = path.join(dir, `${computeFileKey(repoKey, rel)}.json`);
    await fs.writeFile(
      file,
      JSON.stringify({ version: 1, relativePath: rel, content: "seed\n", bom: false, eol: "lf", finalNewline: true, expectedHash: "a".repeat(64), savedAt }),
    );
    return file;
  };
  const expired = await seed("expired.txt", now - (7 * 24 * 60 + 1) * 60_000);
  const fresh = await seed("fresh.txt", now - (6 * 24 * 60 + 23 * 60) * 60_000);

  handle = await launchGitHydra([], userDataDir);
  track(handle);
  await expect.poll(() => fs.access(expired).then(() => true, () => false), { timeout: 10_000 }).toBe(false);
  expect(await fs.access(fresh).then(() => true, () => false)).toBe(true);
});
