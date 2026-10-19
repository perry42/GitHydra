// SPDX-License-Identifier: GPL-3.0-or-later
import type { Page } from "@playwright/test";

/**
 * Linux has deliberately no live working-tree watch (specs/live-refresh.md FR-458): an external file change shows up
 * when the window regains focus. A headless virtual display never moves focus, so after an external write the specs
 * fire the same `focus` event the OS would. Windows/macOS keep the real watch and this is a no-op there.
 */
export const hasWorkingTreeWatch = process.platform !== "linux";

export async function refreshLikeUserReturns(win: Page): Promise<void> {
  if (hasWorkingTreeWatch) return;
  await win.evaluate(() => window.dispatchEvent(new Event("focus")));
}
