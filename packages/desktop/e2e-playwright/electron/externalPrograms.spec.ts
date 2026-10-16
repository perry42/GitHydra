// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * specs/external-programs.md AC9 on the BUILT app: open a worktree through the accordion, the default persists across a relaunch
 * with the same userData, and no request leaves file:/devtools:. The editor is never started: the spawn recorder is honoured
 * only by an UNPACKAGED app that was given GITHYDRA_E2E_SPAWN_RECORD (electron/programs/e2eSpawnRecorder.ts).
 * The same file saves the slice-3 screenshots (light and dark) under SLICE3_SHOTS.
 */
import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closeApp, launchGitHydra, removeUserDataDir, stubOpenRepoDialog, type LaunchedApp } from "../helpers/launchApp";
import { cleanup, commitAll, git, makeTempDir, writeFile } from "../../src/test/gitFixture";

const SHOTS = process.env.SLICE3_SHOTS ?? "";
let handle: LaunchedApp | undefined;
let parent: string | undefined;
let recordDir: string | undefined;

test.afterEach(async () => {
  await closeApp(handle);
  if (handle) await removeUserDataDir(handle.userDataDir);
  if (parent) await cleanup(parent);
  if (recordDir) await fs.rm(recordDir, { recursive: true, force: true });
  parent = recordDir = undefined;
  delete process.env.GITHYDRA_E2E_SPAWN_RECORD;
});

const EDITOR = path.basename(process.execPath).replace(/\.exe$/i, "");

async function makeRepo(): Promise<{ repo: string; worktree: string }> {
  parent = await makeTempDir("pw-ext-");
  const repo = path.join(parent, "acme");
  await fs.mkdir(repo);
  await git(repo, ["init", "-q", "--initial-branch=main"]);
  await writeFile(repo, "a.txt", "base\n");
  await commitAll(repo, "Base commit");
  await git(repo, ["branch", "feature"]);
  const worktree = path.join(parent, "acme.worktrees", "feature");
  await git(repo, ["worktree", "add", "-q", worktree, "feature"]);
  return { repo, worktree };
}

async function openApp(repo: string, userData?: string): Promise<Page> {
  handle = await launchGitHydra([], userData);
  const w = handle.window;
  // A relaunch on the same profile restores the open tab (no Open step).
  if (!userData) {
    await stubOpenRepoDialog(handle.app, repo);
    await w.getByRole("button", { name: "Open a repository", exact: true }).click();
  }
  await w.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });
  return w;
}

async function addEditor(w: Page) {
  await stubOpenRepoDialog(handle!.app, process.execPath); // the same stub answers the main-side program picker
  await w.keyboard.press("Control+k");
  await w.keyboard.type("Manage external programs");
  await w.keyboard.press("Enter");
  const dialog = w.getByRole("dialog", { name: "Programs" });
  await dialog.getByRole("button", { name: "Add program…" }).click();
  await expect(dialog.getByText(`Added ${EDITOR}.`)).toBeVisible();
  return dialog;
}

/** A right-click that first needs a scroll would see the scroll close the menu (FR-316): scroll first and let it settle. */
async function rightClickFeature(w: Page) {
  const card = w.getByRole("button", { name: /Jump to feature in the commit graph/ });
  await card.scrollIntoViewIfNeeded();
  await w.waitForTimeout(200);
  await card.click({ button: "right" });
}

const readRecords = async (file: string) =>
  (await fs.readFile(file, "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { command: string; args: string[]; shell: boolean; detached: boolean; stdio: string });

test("open a worktree through the accordion; the default survives a relaunch; no request leaves the app", async () => {
  recordDir = await fs.mkdtemp(path.join(os.tmpdir(), "gh-spawn-"));
  const record = path.join(recordDir, "spawns.jsonl");
  process.env.GITHYDRA_E2E_SPAWN_RECORD = record;
  const { repo, worktree } = await makeRepo();
  const w = await openApp(repo);
  const foreign: string[] = [];
  w.on("request", (r) => {
    if (!/^(file|devtools|data|blob):/.test(r.url())) foreign.push(r.url());
  });
  const dialog = await addEditor(w);
  await dialog.getByRole("button", { name: "Done" }).click();

  await rightClickFeature(w);
  const open = w.getByRole("menuitem", { name: "Open worktree" });
  await expect(open).toHaveAttribute("aria-expanded", "false");
  await open.focus();
  await w.keyboard.press("ArrowRight");
  await expect(open).toHaveAttribute("aria-expanded", "true");
  await expect(w.getByRole("menuitem", { name: new RegExp(EDITOR) })).toBeVisible();
  await w.getByRole("menuitem", { name: new RegExp(EDITOR) }).click();
  await expect(w.getByText(`Opened in ${EDITOR}. ${EDITOR} is now your default.`)).toBeVisible();
  await expect.poll(async () => (await readRecords(record)).length).toBe(1);
  const [call] = await readRecords(record);
  expect(call!.command).toBe(process.execPath);
  expect(call!.args).toEqual([await fs.realpath(worktree)]);
  expect(call).toMatchObject({ shell: false, detached: true, stdio: "ignore" });
  expect(foreign).toEqual([]);

  const userData = handle!.userDataDir;
  await closeApp(handle);
  const w2 = await openApp(repo, userData);
  // The list loads asynchronously at start; the split button shows when it has.
  await expect(w2.getByRole("button", { name: "Open folder in editor" })).toHaveAttribute("title", new RegExp(`Opens in ${EDITOR}`));
  await rightClickFeature(w2);
  await expect(w2.getByRole("menu").getByText(`Opens in ${EDITOR}`).first()).toBeVisible();
  await w2.getByRole("menuitem", { name: "Open worktree" }).click();
  await expect.poll(async () => (await readRecords(record)).length).toBe(2);
});

test("screenshots: accordion collapsed and open, the not-found row, the Programs dialog, the split button", async () => {
  test.skip(!SHOTS, "set SLICE3_SHOTS to a folder to save screenshots");
  recordDir = await fs.mkdtemp(path.join(os.tmpdir(), "gh-spawn-"));
  process.env.GITHYDRA_E2E_SPAWN_RECORD = path.join(recordDir, "spawns.jsonl");
  await fs.mkdir(SHOTS, { recursive: true });
  const { repo } = await makeRepo();
  const w = await openApp(repo);
  const dialog = await addEditor(w);
  const shot = async (name: string, target?: ReturnType<Page["locator"]>) => {
    for (const theme of ["light", "dark"]) {
      await w.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      await w.waitForTimeout(150);
      const file = path.join(SHOTS, `${name}-${theme}.png`);
      if (target) await target.screenshot({ path: file });
      else await w.screenshot({ path: file });
    }
  };
  // A hand-added program whose file then vanishes: the disabled "Not found at" row.
  const lost = path.join(recordDir, process.platform === "win32" ? "lost-editor.exe" : "lost-editor");
  await fs.copyFile(process.execPath, lost);
  await stubOpenRepoDialog(handle!.app, lost);
  await dialog.getByRole("button", { name: "Add program…" }).click();
  await expect(dialog.getByText("Added lost-editor.")).toBeVisible();
  await fs.rm(lost);
  await dialog.getByRole("button", { name: "Rescan" }).click();
  await expect(dialog.getByText(/Not found at/)).toBeVisible();
  await shot("programs-dialog", dialog);
  await dialog.getByRole("button", { name: "Done" }).click();
  await shot("split-button", w.getByRole("group", { name: "Open folder in editor" }));

  await rightClickFeature(w);
  const menu = w.getByRole("menu", { name: "Actions for branch feature" });
  await shot("accordion-collapsed", menu);
  await w.getByRole("menuitem", { name: "Open worktree" }).focus();
  await w.keyboard.press("ArrowRight");
  await shot("accordion-open", menu);
  await expect(menu.getByRole("menuitem", { name: /lost-editor/ })).toHaveAttribute("aria-disabled", "true");
  await w.keyboard.press("Escape");
});
