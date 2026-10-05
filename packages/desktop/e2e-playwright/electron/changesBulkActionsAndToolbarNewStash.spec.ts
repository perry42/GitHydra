// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Real-Electron check: (B) Changes-panel bulk-action buttons never spill out of their boxes at the
 * minimum file-list width, and (C) the toolbar's icon-only "New Stash…" button stays visible and
 * enabled/disabled correctly at the narrowest window width, in both themes. Screenshots are
 * logged for human review.
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
  shotDir = await fs.mkdtemp(path.join(os.tmpdir(), "githydra-pw-bulk-newstash-"));
});

test.afterEach(async () => {
  await closeApp(handle);
  await removeUserDataDir(handle.userDataDir);
  if (repoDir) await cleanup(repoDir);
  // eslint-disable-next-line no-console
  console.log(`bulk-actions/new-stash screenshots: ${shotDir}`);
});

async function setTheme(h: LaunchedApp, theme: "light" | "dark"): Promise<void> {
  const current = await h.window.evaluate(() => document.documentElement.dataset.theme);
  if (current === theme) return;
  await h.window.getByRole("button", { name: "More actions" }).click();
  await h.window.getByRole("menuitem", { name: /switch to (light|dark) theme/i }).click();
  await expect.poll(() => h.window.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
}

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: bulk actions stay inside their boxes at min file-list width; toolbar New Stash… works at the narrowest window`, async () => {
    repoDir = await initRepo();
    await writeFile(repoDir, "a.txt", "base\n");
    await commitAll(repoDir, "base");
    await stubOpenRepoDialog(handle.app, repoDir);
    await handle.window.getByRole("button", { name: "Open a repository", exact: true }).click();
    await handle.window.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });
    await setTheme(handle, theme);

    // Narrowest window the app allows.
    await handle.app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]!;
      w.setSize(880, 700);
    });

    // Clean tree: toolbar New Stash… is disabled with the FR-100 reason.
    const newStash = handle.window.getByRole("button", { name: "New Stash…" });
    await expect(newStash).toBeVisible();
    await expect(newStash).toBeDisabled();
    await expect(newStash).toHaveAttribute("title", /no changes to stash/i);

    await writeFile(repoDir, "a.txt", "changed\n");
    await handle.window.getByRole("button", { name: /^refresh commit graph$/i }).click();
    await expect(newStash).toBeEnabled({ timeout: 15_000 });
    await expect(newStash).toHaveAttribute("title", "New Stash…");

    await handle.window.getByRole("button", { name: /^changes/i }).click();
    await expect(handle.window.getByRole("button", { name: "Stage all", exact: true })).toBeVisible();
    // The Changes panel no longer has its own New Stash… button.
    await expect(handle.window.locator(".gh-changes-panel").getByRole("button", { name: /new stash/i })).toHaveCount(0);

    // Drive the file-list width to its minimum via the keyboard-accessible separator.
    const sep = handle.window.getByRole("separator", { name: "Resize file list" });
    await sep.focus();
    for (let i = 0; i < 60; i++) await handle.window.keyboard.press("ArrowLeft");
    await expect(sep).toHaveAttribute("aria-valuenow", "160");

    // Geometry: every bulk-action button's label must fit inside its own border box, single line.
    const metrics = await handle.window.evaluate(() =>
      [...document.querySelectorAll<HTMLButtonElement>(".gh-changes-panel__bulk-actions button")].map((b) => {
        const range = document.createRange();
        range.selectNodeContents(b);
        const text = range.getBoundingClientRect();
        const box = b.getBoundingClientRect();
        return { label: b.textContent, scrollW: b.scrollWidth, clientW: b.clientWidth, textH: text.height, boxH: box.height, textRight: text.right, boxRight: box.right };
      }),
    );
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(metrics));
    expect(metrics.length).toBe(3); // Stage all, Unstage all, Discard all… (FR-509 added the third)
    for (const m of metrics) {
      expect(m.scrollW).toBeLessThanOrEqual(m.clientW);
      expect(m.textRight).toBeLessThanOrEqual(m.boxRight);
      expect(m.textH).toBeLessThan(m.boxH); // one line of text, not two wrapped lines
    }
    await handle.window.screenshot({ path: path.join(shotDir, `${theme}-min-file-list-narrow-toolbar.png`) });

    // Toolbar New Stash… actually opens the dialog.
    await newStash.click();
    await expect(handle.window.getByRole("dialog", { name: "New Stash" })).toBeVisible();
  });
}
