// SPDX-License-Identifier: GPL-3.0-or-later
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * specs/mid-merge-landing.md FR-580: opening a repo mid-conflict auto-opens Changes, so a blind toggle click would close it.
 * Click, and if that closed an already-open panel, click once more.
 */
export async function ensureChangesPanelOpen(name: string | RegExp = /changes/i): Promise<HTMLElement> {
  await userEvent.click(await screen.findByRole("button", { name: /^changes/i }, { timeout: 10000 }));
  try {
    return await screen.findByRole("complementary", { name }, { timeout: 1500 });
  } catch {
    await userEvent.click(screen.getByRole("button", { name: /^changes/i }));
    return screen.findByRole("complementary", { name });
  }
}
