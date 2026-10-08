// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Visual record for specs/edit-in-diff.md slice B: idle diff, dirty staged file, error banner, leave prompt, ineligible file,
 * each in dark and light at 1400x900 and 900x700. Files go to $EDIT_SHOTS. No assertions beyond "the scene reached its state".
 */
import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closeApp, launchGitHydra, removeUserDataDir, stubOpenRepoDialog, type LaunchedApp } from "../helpers/launchApp";
import { cleanup, commitAll, git, initRepo } from "../../src/test/gitFixture";

let handle: LaunchedApp;
let repoDir: string;

test.afterEach(async () => {
  await closeApp(handle);
  await removeUserDataDir(handle.userDataDir);
  if (repoDir) await cleanup(repoDir);
});

const rowLabel = (w: Page, section: string, p: string) =>
  w
    .locator("section.gh-changes-panel__section", { has: w.locator("h3", { hasText: new RegExp(`^${section}`) }) })
    .locator("li.gh-changes-panel__file", { hasText: p })
    .locator(".gh-changes-panel__file-label");

async function setTheme(w: Page, theme: "light" | "dark") {
  if ((await w.evaluate(() => document.documentElement.dataset.theme)) === theme) return;
  await w.getByRole("button", { name: "More actions" }).click();
  await w.getByRole("menuitem", { name: /switch to (light|dark) theme/i }).click();
  await expect.poll(() => w.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
}

test("edit-in-diff screenshots", async () => {
  test.setTimeout(240_000);
  const shots = process.env.EDIT_SHOTS ?? (await fs.mkdtemp(path.join(os.tmpdir(), "githydra-pw-editshots-")));
  await fs.mkdir(shots, { recursive: true });
  handle = await launchGitHydra();
  const root = process.env.GH_FIXTURE_ROOT;
  repoDir = root ? await fs.mkdtemp(path.join(root, "shots-")) : await initRepo();
  if (root) await git(repoDir, ["init", "-q", "--initial-branch=main"]);
  const lines = Array.from({ length: 80 }, (_, i) => `const value${i + 1} = compute(${i + 1}); // line ${i + 1}`);
  const put = (rel: string, data: string | Buffer) => fs.writeFile(path.join(repoDir, rel), data);
  await put("staged.txt", lines.join("\n") + "\n");
  await put("ro.txt", "alpha\nbeta\ngamma\n");
  await put("other.txt", "one\ntwo\n");
  await put("bin.dat", Buffer.from([0, 1, 2, 3, 0, 255]));
  await commitAll(repoDir, "base");
  const changed = [...lines];
  changed[9] = "const value10 = compute(10) + 1; // changed";
  changed[60] = "const value61 = compute(61) * 2; // changed";
  await put("staged.txt", changed.join("\n") + "\n");
  await put("ro.txt", "alpha\nBETA\ngamma\n");
  await put("other.txt", "one\nTWO\n");
  await put("bin.dat", Buffer.from([0, 1, 2, 3, 0, 254]));
  await fs.chmod(path.join(repoDir, "ro.txt"), 0o444);

  const w = handle.window;
  await stubOpenRepoDialog(handle.app, repoDir);
  await w.getByRole("button", { name: "Open a repository", exact: true }).click();
  await w.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });
  await w.getByRole("button", { name: /^changes/i }).click();
  await w.locator(".gh-changes-panel__file").first().waitFor({ timeout: 15_000 });
  await rowLabel(w, "Unstaged", "staged.txt").click();
  await w.getByRole("checkbox", { name: "Hunk 1 of 2" }).click();
  await expect(rowLabel(w, "Staged", "staged.txt")).toBeVisible({ timeout: 10_000 });

  const edit = w.locator("[data-edit-button]");
  const cm = w.locator(".cm-content");
  const discardOut = async () => {
    await w.getByRole("button", { name: "Back to diff" }).click();
    await w.getByRole("alertdialog").getByRole("button", { name: "Discard" }).click();
    await expect(cm).toHaveCount(0);
  };

  for (const [size, width, height] of [["1400", 1400, 900], ["900", 900, 700]] as const) {
    await handle.app.evaluate(({ BrowserWindow }, [ww, hh]) => BrowserWindow.getAllWindows()[0]!.setSize(ww as number, hh as number), [width, height]);
    await w.waitForTimeout(500);
    for (const theme of ["dark", "light"] as const) {
      await setTheme(w, theme);
      const shot = async (name: string) => {
        await w.waitForTimeout(450);
        await w.screenshot({ path: path.join(shots, `${name}-${theme}-${size}.png`) });
      };

      await rowLabel(w, "Unstaged", "other.txt").click();
      await expect(edit).toBeEnabled();
      await shot("1-idle-diff-edit-button");

      await rowLabel(w, "Staged", "staged.txt").click();
      await expect(edit).toBeEnabled();
      await edit.click();
      await expect(cm).toBeFocused();
      await w.keyboard.press("Control+End");
      await w.keyboard.type(" // edited");
      await expect(w.locator(".gh-edit__state", { hasText: "Unsaved" })).toBeVisible();
      await shot("2-editing-dirty-staged-file");

      await rowLabel(w, "Unstaged", "other.txt").click();
      await expect(w.getByRole("alertdialog")).toBeVisible();
      await shot("4-leave-prompt");
      await w.getByRole("alertdialog").getByRole("button", { name: "Discard" }).click();
      await expect(cm).toHaveCount(0);

      await rowLabel(w, "Unstaged", "ro.txt").click();
      await expect(edit).toBeEnabled();
      await edit.click();
      await expect(cm).toBeFocused();
      await w.keyboard.press("Control+End");
      await w.keyboard.type("more");
      await w.keyboard.press("Control+s");
      await expect(w.getByRole("alert").filter({ hasText: "Couldn't save" })).toBeVisible();
      await w.getByRole("alert").getByRole("button", { name: "Show details" }).click();
      await shot("3-error-banner");
      await discardOut();

      await rowLabel(w, "Unstaged", "bin.dat").click();
      await expect(edit).toHaveAttribute("aria-disabled", "true", { timeout: 10_000 });
      await shot("5-ineligible-file");
    }
  }
  await fs.chmod(path.join(repoDir, "ro.txt"), 0o644);
});
