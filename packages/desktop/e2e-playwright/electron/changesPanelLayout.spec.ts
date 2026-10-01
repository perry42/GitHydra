// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Real-Electron verification of specs/changes-panel-layout.md (FR-486..FR-490): drawer width, compact
 * file rows with left-truncated directories, hover/focus-revealed row actions, and the pinned commit
 * form with a long file list. Screenshots go to $LAYOUT_SHOTS (or the OS temp dir) for human review.
 */
import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closeApp, launchGitHydra, removeUserDataDir, stubOpenRepoDialog, type LaunchedApp } from "../helpers/launchApp";
import { cleanup, commitAll, initRepo, writeFile } from "../../src/test/gitFixture";

let handle: LaunchedApp;
let repoDir: string;
let shotDir: string;

test.beforeEach(async () => {
  handle = await launchGitHydra();
  shotDir = process.env.LAYOUT_SHOTS ?? (await fs.mkdtemp(path.join(os.tmpdir(), "githydra-pw-layout-")));
  await fs.mkdir(shotDir, { recursive: true });
});
test.afterEach(async () => {
  await closeApp(handle);
  await removeUserDataDir(handle.userDataDir);
  if (repoDir) await cleanup(repoDir);
});

async function setTheme(w: Page, theme: "light" | "dark") {
  const current = await w.evaluate(() => document.documentElement.dataset.theme);
  if (current === theme) return;
  await w.getByRole("button", { name: "More actions" }).click();
  await w.getByRole("menuitem", { name: /switch to (light|dark) theme/i }).click();
  await expect.poll(() => w.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
}

async function setup(fileCount: number) {
  repoDir = await initRepo();
  await writeFile(repoDir, "seed.txt", "seed\n");
  await commitAll(repoDir, "base");
  await writeFile(repoDir, "packages/desktop/src/components/ChangesPanel/ChangesLayout.test.tsx", "x\n");
  for (let i = 0; i < fileCount; i++) {
    await writeFile(repoDir, `src/feature-${i % 7}/nested/deeper/file-${i}.ts`, `export const v${i} = ${i};\n`);
  }
  await stubOpenRepoDialog(handle.app, repoDir);
  await handle.window.getByRole("button", { name: "Open a repository", exact: true }).click();
  await handle.window.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });
  await handle.window.getByRole("button", { name: /^changes/i }).click();
  await handle.window.getByRole("button", { name: "Stage all", exact: true }).waitFor();
  return handle.window;
}

const preferred = (w: Page) =>
  w.evaluate(() => Number(document.querySelector('[aria-label="Resize Changes panel"]')!.getAttribute("aria-valuenow")));

const metrics = (w: Page) =>
  w.evaluate(() => {
    const r = (sel: string) => document.querySelector<HTMLElement>(sel)!.getBoundingClientRect();
    return {
      win: window.innerWidth,
      panel: r(".gh-changes-panel").width,
      files: r(".gh-changes-panel__files").width,
      diff: r(".gh-changes-panel__diff").width,
    };
  });

test("FR-486/489/487: 60% drawer, resize + reset, pinned form with 500 files, row actions on hover and focus", async () => {
  const w = await setup(500);
  await expect(w.locator(".gh-changes-panel__file").first()).toBeVisible({ timeout: 20_000 });

  let m = await metrics(w);
  // The stored/preferred width is 60% of the window; App.css's squeeze-to-fit rule may render it
  // narrower so the commit graph keeps its 280px floor beside the Branches sidebar.
  expect(Math.abs((await preferred(w)) - m.win * 0.6)).toBeLessThanOrEqual(2);
  expect(m.panel).toBeGreaterThan(m.win * 0.5);
  expect(m.diff).toBeGreaterThanOrEqual(478);

  // Commit subject is visible and inside the viewport without scrolling (AC4).
  const subject = w.getByLabel("Subject");
  await expect(subject).toBeInViewport();
  await w.screenshot({ path: path.join(shotDir, "light-01-default-60pct-500files.png") });

  // Keyboard resize, then drag-free reset via double click (AC1).
  const handleEl = w.getByRole("separator", { name: "Resize Changes panel" });
  await handleEl.focus();
  for (let i = 0; i < 20; i++) await w.keyboard.press("ArrowRight"); // shrink toward ~40%
  m = await metrics(w);
  expect(m.panel).toBeLessThan(m.win * 0.5);
  await w.screenshot({ path: path.join(shotDir, "light-02-narrowed-40pct.png") });
  await handleEl.dblclick();
  m = await metrics(w);
  expect(Math.abs((await preferred(w)) - m.win * 0.6)).toBeLessThanOrEqual(2);

  // Diff never drops under ~480: drag the file-list divider as far right as it goes.
  const fileSep = w.getByRole("separator", { name: "Resize file list" });
  await fileSep.focus();
  for (let i = 0; i < 40; i++) await w.keyboard.press("ArrowRight");
  m = await metrics(w);
  expect(m.diff).toBeGreaterThanOrEqual(478);

  // Row actions: invisible at rest, visible on hover and on keyboard focus (AC3).
  const row = w.locator(".gh-changes-panel__file", { hasText: "file-3.ts" }).first();
  const actions = row.locator(".gh-changes-panel__file-actions");
  await w.mouse.move(2, 2);
  await expect.poll(() => actions.evaluate((e) => getComputedStyle(e).opacity)).toBe("0");
  await row.hover();
  await expect.poll(() => actions.evaluate((e) => getComputedStyle(e).opacity)).toBe("1");
  await w.screenshot({ path: path.join(shotDir, "light-03-row-hover.png") });
  await w.mouse.move(2, 2);
  await row.locator(".gh-changes-panel__file-label").focus();
  await w.keyboard.press("Tab");
  await expect(row.getByRole("button", { name: "Stage" })).toBeFocused();
  await expect.poll(() => actions.evaluate((e) => getComputedStyle(e).opacity)).toBe("1");

  // Long path: file name intact, directory ellipsized from the left (AC2).
  const long = w.locator(".gh-changes-panel__file", { hasText: "ChangesLayout" }).first();
  const dir = long.locator(".gh-changes-panel__file-dir");
  const name = long.locator(".gh-changes-panel__file-name");
  await expect(name).toHaveText("ChangesLayout.test.tsx");
  expect(await name.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
  expect(await dir.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
  expect(await dir.evaluate((e) => getComputedStyle(e).direction)).toBe("rtl");

  // Commit form expansion (AC5).
  const more = w.locator(".gh-changes-panel__composer-more");
  await expect(more).toBeHidden();
  await subject.click();
  await expect(more).toBeVisible();
  await w.getByLabel(/^Body/).fill("typed body must survive");
  await w.mouse.click(2, 2);
  await expect(more).toBeVisible();
  await expect(w.getByLabel(/^Body/)).toHaveValue("typed body must survive");
  await w.screenshot({ path: path.join(shotDir, "light-04-form-expanded.png") });
  await w.getByLabel(/^Body/).fill("");
  await w.mouse.click(2, 2);
  await expect(more).toBeHidden();
  await expect(subject).toBeInViewport();

  // Dark theme pass.
  await setTheme(w, "dark");
  await row.hover();
  await w.screenshot({ path: path.join(shotDir, "dark-01-row-hover.png") });
  await subject.click();
  await w.screenshot({ path: path.join(shotDir, "dark-02-form-expanded.png") });
});

test("FR-486: a narrow window lets the diff win - file column sits at its own minimum", async () => {
  const w = await setup(5);
  await expect(w.locator(".gh-changes-panel__file").first()).toBeVisible({ timeout: 20_000 });
  await handle.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(820, 700));
  await expect.poll(() => w.evaluate(() => window.innerWidth)).toBeLessThan(900);
  const m = await metrics(w);
  expect(m.files).toBeLessThanOrEqual(300);
  expect(m.files).toBeGreaterThanOrEqual(158);
  expect(m.diff).toBeGreaterThan(m.files);
  await w.screenshot({ path: path.join(shotDir, "light-05-narrow-window.png") });
});
