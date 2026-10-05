// SPDX-License-Identifier: GPL-3.0-or-later
/** Test-only helpers for the ignore/multi-select real-Electron specs (specs/ignore-and-multiselect.md). */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page } from "@playwright/test";
import { openRepoThroughRealUi, type LaunchedApp } from "./launchApp";

export const SHOT_DIR = process.env.GITHYDRA_SHOT_DIR ?? path.join(os.tmpdir(), "githydra-ignore-multiselect-shots");

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

/** The one Ignore popover (specs/ignore-and-multiselect.md FR-516). */
export const ignorePopover = (page: Page) => page.getByRole("dialog", { name: /^Ignore/ });

/** Maps the old "Add to" radio regexes onto the select's option values. */
export function targetValue(target: RegExp): "root" | "nearest" | "exclude" {
  const src = target.source.toLowerCase();
  return src.includes("private") ? "exclude" : src.includes("nearest") ? "nearest" : "root";
}

/** The previews are read in parallel on open; wait until the popover is no longer busy. */
export async function popoverReady(page: Page): Promise<void> {
  const pop = ignorePopover(page);
  await expect(pop).toBeVisible();
  await expect(pop).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });
}

/** Right-click a row, Ignore..., then pick the scope radio (label regex). Returns the popover. */
export async function ignoreViaMenu(page: Page, section: string, p: string, scopeLabel: RegExp) {
  await rowBtn(page, section, p).click({ button: "right" });
  await page.getByRole("menuitem", { name: /^ignore…/i }).click();
  await popoverReady(page);
  const pop = ignorePopover(page);
  await pop.getByRole("radio", { name: scopeLabel }).check();
  await popoverReady(page);
  return pop;
}

/** Chooses the destination in the popover and presses the primary Ignore. */
export async function applyIgnorePopover(page: Page, target: RegExp): Promise<void> {
  const pop = ignorePopover(page);
  await pop.getByRole("combobox", { name: "Add to" }).selectOption(targetValue(target));
  await popoverReady(page);
  await expect(pop.locator("[aria-live=polite]")).toContainText(/adds/i);
  await pop.getByRole("button", { name: "Ignore", exact: true }).click();
  await expect(pop).toHaveCount(0);
}

/** FR-518a: "Discard all" lives in the Unstaged header's overflow menu. */
export async function openDiscardAll(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Unstaged section actions" }).click();
  await page.getByRole("menuitem", { name: "Discard all changes…" }).click();
}

/** Hover a row so its two icon buttons are shown, as a real user must. */
export async function hoverRow(page: Page, section: string, p: string): Promise<void> {
  await rowLi(page, section, p).hover();
}

export async function launchApp(): Promise<LaunchedApp> {
  const { launchGitHydra } = await import("./launchApp");
  return launchGitHydra();
}
