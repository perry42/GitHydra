// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Right-clicks `target` and waits for the context menu, retrying: on a loaded Windows runner the first right-click can
 * land while a refresh re-renders the row (or just after a scroll closed the menu, FR-316) and opens nothing.
 */
export async function openContextMenu(w: Page, target: Locator, attempts = 3): Promise<Locator> {
  const menu = w.getByRole("menu").first();
  for (let i = 1; ; i++) {
    await target.scrollIntoViewIfNeeded();
    await w.waitForTimeout(150);
    await target.click({ button: "right" });
    try {
      await expect(menu).toBeVisible({ timeout: 3_000 });
      return menu;
    } catch (err) {
      if (i >= attempts) throw err;
      await w.keyboard.press("Escape");
    }
  }
}
