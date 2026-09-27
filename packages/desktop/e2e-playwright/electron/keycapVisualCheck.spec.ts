// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * test-agent verification (specs/keyboard-shortcuts-visual-redesign.md FR-387-393): real-pixel
 * confirmation of the KeyCap chip redesign in the Command Palette (Ctrl+K) and the Keyboard
 * Shortcuts reference screen (Ctrl+/), in both light and dark theme, including the palette's
 * highlighted-row accent-inverted override and a multi-combo command's " / " separator. Screenshots
 * are this verification pass's own visual evidence (logged path), not asserted on pixel content
 * beyond the DOM/class assertions already covered by the unit suites.
 */
import { test, expect } from "@playwright/test";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import { closeApp, launchGitHydra, removeUserDataDir, stubOpenRepoDialog, type LaunchedApp } from "../helpers/launchApp";
import { cleanup, commitAll, initRepo, writeFile } from "../../src/test/gitFixture";

let handle: LaunchedApp;
let repoDir: string;
let shotDir: string;

test.beforeEach(async () => {
  handle = await launchGitHydra();
  shotDir = await fs.mkdtemp(path.join(os.tmpdir(), "githydra-pw-keycap-"));
});

test.afterEach(async () => {
  await closeApp(handle);
  await removeUserDataDir(handle.userDataDir);
  if (repoDir) await cleanup(repoDir);
  // eslint-disable-next-line no-console
  console.log(`keycap screenshots: ${shotDir}`);
});

async function openRepoThroughRealUiExact(h: LaunchedApp, repoPath: string): Promise<void> {
  await stubOpenRepoDialog(h.app, repoPath);
  await h.window.getByRole("button", { name: "Open a repository", exact: true }).click();
  await h.window.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });
}

async function setTheme(h: LaunchedApp, theme: "light" | "dark"): Promise<void> {
  const current = await h.window.evaluate(() => document.documentElement.dataset.theme);
  if (current === theme) return;
  await h.window.getByRole("button", { name: "More actions" }).click();
  await h.window.getByRole("menuitem", { name: /switch to (light|dark) theme/i }).click();
  await expect
    .poll(() => h.window.evaluate(() => document.documentElement.dataset.theme))
    .toBe(theme);
}

for (const theme of ["dark", "light"] as const) {
  test(`${theme} theme: Command Palette keycap chips are visible, legible, and the highlighted row's chips stay legible against the accent background`, async () => {
    repoDir = await initRepo();
    await writeFile(repoDir, "a.txt", "base\n");
    await commitAll(repoDir, "First commit");
    await openRepoThroughRealUiExact(handle, repoDir);
    await setTheme(handle, theme);
    // Move the real cursor away from the toolbar first — otherwise a stray mouseenter from
    // `setTheme`'s own click can pre-highlight whatever palette row happens to open under it.
    await handle.window.mouse.move(50, 500);

    await handle.window.keyboard.press("Control+k");
    const dialog = handle.window.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Sanity: at least one KeyCap chip rendered as a real bordered element, not flat text.
    const anyChip = handle.window.locator(".gh-keycap").first();
    await expect(anyChip).toBeVisible();

    await handle.window.screenshot({ path: path.join(shotDir, `01-palette-${theme}.png`) });

    // FR-391: highlighted row's chips must stay legible against the inverted accent background.
    // Arrow down until we land on a row that actually HAS a keybinding chip (row 0 and some early
    // rows have none) — otherwise this check silently verifies nothing.
    const highlighted = handle.window.locator(".gh-command-palette__item--highlighted");
    const highlightedChips = highlighted.locator(".gh-keycap");
    let landedOnChipRow = (await highlightedChips.count()) > 0;
    for (let i = 0; i < 20 && !landedOnChipRow; i++) {
      await handle.window.keyboard.press("ArrowDown");
      landedOnChipRow = (await highlightedChips.count()) > 0;
    }
    await expect(highlighted).toBeVisible();
    expect(landedOnChipRow).toBe(true);
    if ((await highlightedChips.count()) > 0) {
      // Confirm the accent-safe override is actually the one in effect on a real rendered chip
      // (not just present somewhere in the stylesheet) — background/color must differ from the
      // plain (non-highlighted) chip's own colors so it isn't invisible against the accent fill.
      const highlightedStyle = await highlightedChips.first().evaluate((el) => {
        const s = getComputedStyle(el);
        return { background: s.backgroundColor, color: s.color, borderBottomColor: s.borderBottomColor };
      });
      const plainChip = handle.window.locator(".gh-command-palette__item:not(.gh-command-palette__item--highlighted) .gh-keycap").first();
      if ((await plainChip.count()) > 0) {
        const plainStyle = await plainChip.evaluate((el) => {
          const s = getComputedStyle(el);
          return { background: s.backgroundColor, color: s.color, borderBottomColor: s.borderBottomColor };
        });
        expect(highlightedStyle.background).not.toBe(plainStyle.background);
      }
    }
    await handle.window.screenshot({ path: path.join(shotDir, `02-palette-highlighted-${theme}.png`) });

    // FR-389: a multi-combo command (Refresh commit graph: "Ctrl+R" / "F5" on Windows/Linux) shows
    // two separate keycap groups joined by the plain-text " / " separator, not chips for it.
    const refreshRow = handle.window.locator(".gh-command-palette__item", { hasText: "Refresh commit graph" });
    if ((await refreshRow.count()) > 0) {
      const shortcutEl = refreshRow.locator(".gh-command-palette__shortcut").first();
      await expect(shortcutEl).toBeVisible();
      const text = await shortcutEl.evaluate((el) => el.textContent ?? "");
      expect(text.replace(/\s+/g, " ").trim()).toMatch(/^Ctrl \+ R \/ F5$|^Ctrl\+R \/ F5$/);
      const groups = await shortcutEl.locator(".gh-keycap-group").count();
      expect(groups).toBe(2);
      await refreshRow.scrollIntoViewIfNeeded();
      await handle.window.screenshot({ path: path.join(shotDir, `03-palette-refresh-row-${theme}.png`) });
    }

    await handle.window.keyboard.press("Escape");
  });

  test(`${theme} theme: Keyboard Shortcuts reference screen keycap chips are visible and legible`, async () => {
    repoDir = await initRepo();
    await writeFile(repoDir, "a.txt", "base\n");
    await commitAll(repoDir, "First commit");
    await openRepoThroughRealUiExact(handle, repoDir);
    await setTheme(handle, theme);

    await handle.window.keyboard.press("Control+/");
    const dialog = handle.window.getByRole("dialog");
    await expect(dialog).toBeVisible();

    const anyChip = handle.window.locator(".gh-keycap").first();
    await expect(anyChip).toBeVisible();

    // FR-389 in the reference screen too: Refresh's row shows two groups + " / ".
    const refreshRow = handle.window.locator(".gh-keyboard-shortcuts__item", { hasText: "Refresh commit graph" });
    await expect(refreshRow).toBeVisible();
    const shortcutEl = refreshRow.locator(".gh-keyboard-shortcuts__shortcut").first();
    const groups = await shortcutEl.locator(".gh-keycap-group").count();
    expect(groups).toBe(2);

    await handle.window.screenshot({ path: path.join(shotDir, `04-shortcuts-screen-${theme}.png`) });
    await handle.window.screenshot({ path: path.join(shotDir, `05-shortcuts-screen-refresh-row-${theme}.png`) });

    await handle.window.keyboard.press("Escape");
  });
}
