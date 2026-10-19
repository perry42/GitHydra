// SPDX-License-Identifier: GPL-3.0-or-later
import type { Page } from "@playwright/test";

/**
 * Linux has deliberately no recursive working-tree watch (FR-458, specs/live-refresh.md): an external file edit
 * is picked up on window focus regain. A headless virtual display never moves focus, so after an external write
 * the specs fire the same `focus` event the OS would. Elsewhere this is a no-op, so Windows/macOS keep proving
 * the real watch.
 */
export const hasWorkingTreeWatch = process.platform !== "linux";

export async function nudgeFocusOnLinux(win: Page): Promise<void> {
  if (hasWorkingTreeWatch) return;
  await win.evaluate(() => window.dispatchEvent(new Event("focus")));
}
