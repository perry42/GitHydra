// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * test-agent verification (specs/keyboard-shortcut-rebinding.md FR-394..405): real-Electron,
 * real-`localStorage` confirmation of the rebinding feature end to end — through the real UI, the
 * real global keydown layer, and a real relaunch against the same profile — rather than the
 * jsdom-level component/hook coverage already in `KeyboardShortcutsScreen.test.tsx`/
 * `useGlobalKeybindings.test.ts`/`useKeybindingOverrides.test.ts`.
 */
import { test, expect } from "@playwright/test";
import { closeApp, launchGitHydra, removeUserDataDir, stubOpenRepoDialog, type LaunchedApp } from "../helpers/launchApp";
import { cleanup, commitAll, initRepo, writeFile } from "../../src/test/gitFixture";

let handle: LaunchedApp;
let repoDir: string;

async function openRepoThroughRealUiExact(h: LaunchedApp, repoPath: string): Promise<void> {
  await stubOpenRepoDialog(h.app, repoPath);
  await h.window.getByRole("button", { name: "Open a repository", exact: true }).click();
  await h.window.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });
}

test.afterEach(async () => {
  await closeApp(handle);
  await removeUserDataDir(handle.userDataDir);
  if (repoDir) await cleanup(repoDir);
});

test("AC1: rebinding 'New branch…' to Ctrl+Shift+B persists, fires the real dialog from outside, and the Command Palette shows the same hint", async () => {
  handle = await launchGitHydra();
  repoDir = await initRepo();
  await writeFile(repoDir, "a.txt", "base\n");
  await commitAll(repoDir, "First commit");
  await openRepoThroughRealUiExact(handle, repoDir);

  await handle.window.keyboard.press("Control+/");
  await expect(handle.window.getByRole("dialog", { name: /keyboard shortcuts/i })).toBeVisible();

  const newBranchRow = handle.window.locator(".gh-keyboard-shortcuts__item", { hasText: "New branch…" });
  await newBranchRow.getByRole("button", { name: /edit shortcut/i }).click();
  await handle.window.keyboard.press("Control+Shift+B");
  // Click the screen's own title to move focus/blur out of the capturing row and finalize the save.
  await handle.window.getByRole("heading", { name: "Keyboard shortcuts" }).click();

  await expect(newBranchRow.locator(".gh-keycap")).toHaveText(["Ctrl", "Shift", "B"]);

  await handle.window.keyboard.press("Escape");
  await expect(handle.window.getByRole("dialog", { name: /keyboard shortcuts/i })).not.toBeVisible();

  // The new combo fires the real command from outside any dialog.
  await handle.window.keyboard.press("Control+Shift+B");
  await expect(handle.window.getByRole("dialog", { name: "New Branch" })).toBeVisible();
  await handle.window.keyboard.press("Escape");
  await expect(handle.window.getByRole("dialog", { name: "New Branch" })).not.toBeVisible();

  // The Command Palette's own row reflects the same new hint.
  await handle.window.keyboard.press("Control+k");
  const paletteRow = handle.window.getByRole("option", { name: /new branch/i });
  await expect(paletteRow).toContainText(/ctrl.*shift.*b/i);
  await handle.window.keyboard.press("Escape");
});

test("AC3: a real conflict shows Reassign/Cancel, and Reassign leaves the losing command unbound (fires neither its old combo nor anything else)", async () => {
  handle = await launchGitHydra();
  repoDir = await initRepo();
  await writeFile(repoDir, "a.txt", "base\n");
  await commitAll(repoDir, "First commit");
  await openRepoThroughRealUiExact(handle, repoDir);

  await handle.window.keyboard.press("Control+/");
  await expect(handle.window.getByRole("dialog", { name: /keyboard shortcuts/i })).toBeVisible();

  // "Focus branches search" ships exactly one default combo, Ctrl+F — rebinding "New stash…" to
  // the same combo triggers FR-399's conflict flow against it.
  const newStashRow = handle.window.locator(".gh-keyboard-shortcuts__item", { hasText: "New stash…" });
  await newStashRow.getByRole("button", { name: /edit shortcut/i }).click();
  await handle.window.keyboard.press("Control+f");
  // Finalize the capture (blur out of the row) so the parent screen actually runs the
  // validate/conflict-lookup logic — a live preview alone never triggers it.
  await handle.window.getByRole("heading", { name: "Keyboard shortcuts" }).click();

  const conflictText = handle.window.locator(".gh-shortcut-row__conflict-text");
  await expect(conflictText).toContainText(/ctrl\+f is already used by "focus branches search"/i);

  // Cancel: nothing saved, back to capture state on the same row.
  await handle.window.getByRole("button", { name: /^cancel$/i }).click();
  await expect(handle.window.getByText(/press a key combination/i)).toBeVisible();
  await handle.window.getByRole("heading", { name: "Keyboard shortcuts" }).click();
  await expect(newStashRow.getByText(/no shortcut/i)).toBeVisible();

  // Do it again for real, and Reassign this time.
  await newStashRow.getByRole("button", { name: /edit shortcut/i }).click();
  await handle.window.keyboard.press("Control+f");
  await handle.window.getByRole("heading", { name: "Keyboard shortcuts" }).click();
  await expect(conflictText).toContainText(/ctrl\+f is already used by "focus branches search"/i);
  await handle.window.getByRole("button", { name: /reassign/i }).click();

  await expect(newStashRow.locator(".gh-keycap")).toHaveText(["Ctrl", "F"]);
  const focusSearchRow = handle.window.locator(".gh-keyboard-shortcuts__item", { hasText: "Focus branches search" });
  await expect(focusSearchRow.getByText(/no shortcut/i)).toBeVisible();
  await expect(focusSearchRow.getByRole("button", { name: /reset to default/i })).toBeVisible();

  await handle.window.keyboard.press("Escape");

  // The real effective binding moved: Ctrl+F now opens New Stash (the branches sidebar is
  // collapsed by default in this fixture, so its search input isn't even mounted — the dialog
  // opening at all is itself proof Ctrl+F no longer reaches "Focus branches search").
  await handle.window.keyboard.press("Control+f");
  await expect(handle.window.getByRole("dialog", { name: "New Stash" })).toBeVisible();
  await handle.window.keyboard.press("Escape");
});

test("AC6 and AC9: Reset to default reverts real firing behavior, and a custom binding survives a relaunch against the same profile", async () => {
  handle = await launchGitHydra();
  repoDir = await initRepo();
  await writeFile(repoDir, "a.txt", "base\n");
  await commitAll(repoDir, "First commit");
  await openRepoThroughRealUiExact(handle, repoDir);

  await handle.window.keyboard.press("Control+/");
  const newBranchRow = handle.window.locator(".gh-keyboard-shortcuts__item", { hasText: "New branch…" });
  await newBranchRow.getByRole("button", { name: /edit shortcut/i }).click();
  await handle.window.keyboard.press("Control+Shift+B");
  await handle.window.getByRole("heading", { name: "Keyboard shortcuts" }).click();
  await expect(newBranchRow.locator(".gh-keycap")).toHaveText(["Ctrl", "Shift", "B"]);

  // AC9 setup: confirm the override actually landed in real localStorage before relaunching.
  const stored = await handle.window.evaluate(() => window.localStorage.getItem("githydra:keybindings:overrides"));
  expect(stored).not.toBeNull();
  expect(JSON.parse(stored!)).toMatchObject({ "new-branch": [{ key: "b", mod: true, shift: true }] });

  await newBranchRow.getByRole("button", { name: /reset to default/i }).click();
  await expect(newBranchRow.getByText(/no shortcut/i)).toBeVisible();
  await handle.window.keyboard.press("Escape");

  // AC6: the actual effective binding reverted too, not just the row's own display.
  await handle.window.keyboard.press("Control+Shift+B");
  await expect(handle.window.getByRole("dialog", { name: "New Branch" })).not.toBeVisible();

  // Give the reset a second custom binding to verify AC9's relaunch persistence with.
  await handle.window.keyboard.press("Control+/");
  await newBranchRow.getByRole("button", { name: /edit shortcut/i }).click();
  await handle.window.keyboard.press("Control+Shift+N");
  await handle.window.getByRole("heading", { name: "Keyboard shortcuts" }).click();
  await expect(newBranchRow.locator(".gh-keycap")).toHaveText(["Ctrl", "Shift", "N"]);
  await handle.window.keyboard.press("Escape");

  const userDataDir = handle.userDataDir;
  await closeApp(handle);
  handle = await launchGitHydra([], userDataDir);
  // Unlike the first launch, this one reuses the same real `userDataDir` — `useRepoTabs.ts`'s own
  // session-restore feature (a pre-existing, unrelated feature) auto-reopens the previously-active
  // repo tab straight from its persisted session, so the empty-state "Open a repository" button
  // never renders here at all; wait for the restored graph directly instead of the manual-open flow.
  await handle.window.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });

  await handle.window.keyboard.press("Control+/");
  const reopenedRow = handle.window.locator(".gh-keyboard-shortcuts__item", { hasText: "New branch…" });
  await expect(reopenedRow.locator(".gh-keycap")).toHaveText(["Ctrl", "Shift", "N"]);
  await handle.window.keyboard.press("Escape");

  // And the relaunched app's real global keydown layer fires it too, not just the display.
  await handle.window.keyboard.press("Control+Shift+N");
  await expect(handle.window.getByRole("dialog", { name: "New Branch" })).toBeVisible();
  await handle.window.keyboard.press("Escape");
});
