// SPDX-License-Identifier: GPL-3.0-or-later
/** Test-only helpers for the ignore/multi-select real-Electron specs (specs/ignore-and-multiselect.md). */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page } from "@playwright/test";
import { openRepoThroughRealUi, type LaunchedApp } from "./launchApp";

export const SHOT_DIR = path.join(os.tmpdir(), "githydra-ignore-multiselect-shots");

export async function shot(page: Page, name: string): Promise<void> {
  await fs.mkdir(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) });
}

export async function openChanges(h: LaunchedApp, repo: string): Promise<void> {
  await openRepoThroughRealUi(h, repo);
  await h.window.getByRole("button", { name: /^changes/i }).click();
  await expect(h.window.getByRole("button", { name: "Stage all", exact: true })).toBeVisible();
}

export async function setTheme(h: LaunchedApp, theme: "light" | "dark"): Promise<void> {
  const current = await h.window.evaluate(() => document.documentElement.dataset.theme);
  if (current === theme) return;
  await h.window.getByRole("button", { name: "More actions" }).click();
  await h.window.getByRole("menuitem", { name: /switch to (light|dark) theme/i }).click();
  await expect.poll(() => h.window.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
}

/** The label button of a list row, keyed `section:path`. */
export const rowBtn = (page: Page, section: string, p: string) => page.locator(`[data-row-key="${section}:${p}"]`);
export const rowLi = (page: Page, section: string, p: string) => rowBtn(page, section, p).locator("xpath=ancestor::li[1]");

export async function refresh(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^refresh commit graph$/i }).click();
}

/** Right-click a row, then Ignore… -> scope item (label regex). */
export async function ignoreViaMenu(page: Page, section: string, p: string, scopeLabel: RegExp): Promise<void> {
  await rowBtn(page, section, p).click({ button: "right" });
  await page.getByRole("menuitem", { name: /^ignore…/i }).click();
  await page.getByRole("menuitem", { name: scopeLabel }).click();
}

export async function launchApp(): Promise<LaunchedApp> {
  const { launchGitHydra } = await import("./launchApp");
  return launchGitHydra();
}
