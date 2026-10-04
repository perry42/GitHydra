// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Regression: a partly staged row's hover actions (Unstage | Stage | Discard) used to outgrow a narrow file
 * column, spill past the row's left edge and hide the file name. Screenshots go to $ROWACTION_SHOTS.
 */
import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closeApp, launchGitHydra, removeUserDataDir, stubOpenRepoDialog, type LaunchedApp } from "../helpers/launchApp";
import { cleanup, commitAll, git, initRepo, writeFile } from "../../src/test/gitFixture";

let handle: LaunchedApp;
let repoDir: string;
let shotDir: string;

test.beforeEach(async () => {
  handle = await launchGitHydra();
  shotDir = process.env.ROWACTION_SHOTS ?? (await fs.mkdtemp(path.join(os.tmpdir(), "githydra-pw-rowaction-")));
  await fs.mkdir(shotDir, { recursive: true });
});
test.afterEach(async () => {
  await closeApp(handle);
  await removeUserDataDir(handle.userDataDir);
  if (repoDir) await cleanup(repoDir);
});

async function setTheme(w: Page, theme: "light" | "dark") {
  const current = await w.evaluate(() => document.documentElement.dataset.theme);
  if (current === theme) return;
  await w.getByRole("button", { name: "More actions" }).click();
  await w.getByRole("menuitem", { name: /switch to (light|dark) theme/i }).click();
  await expect.poll(() => w.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
}

const body = (n: number, tweak: Record<number, string> = {}) =>
  Array.from({ length: n }, (_, i) => tweak[i] ?? `line${i}`).join("\n") + "\n";

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: row actions stay inside the row and the name stays clickable at 280/370/520px`, async () => {
    repoDir = await initRepo();
    await writeFile(repoDir, "src/hooks/useRepositoryGraph.ts", body(30));
    await writeFile(repoDir, "plain.txt", body(5));
    await commitAll(repoDir, "base");
    await writeFile(repoDir, "src/hooks/useRepositoryGraph.ts", body(30, { 2: "A" }));
    await git(repoDir, ["add", "-A"]);
    await writeFile(repoDir, "src/hooks/useRepositoryGraph.ts", body(30, { 2: "A", 20: "B" }));
    await writeFile(repoDir, "plain.txt", body(5, { 1: "X" }));
    await writeFile(repoDir, "brand-new-file.ts", "x\n");
    await stubOpenRepoDialog(handle.app, repoDir);
    const w = handle.window;
    await w.getByRole("button", { name: "Open a repository", exact: true }).click();
    await w.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });
    await w.getByRole("button", { name: /^changes/i }).click();
    await w.getByRole("button", { name: "Stage all", exact: true }).waitFor();
    await setTheme(w, theme);

    for (const width of [280, 370, 520]) {
      await w.evaluate((px) => {
        const el = document.querySelector<HTMLElement>(".gh-changes-panel__files")!;
        el.style.width = `${px}px`;
        el.style.flex = "0 0 auto";
        el.style.minWidth = `${px}px`;
      }, width);
      const row = w.locator("li.gh-changes-panel__file", { hasText: "useRepositoryGraph.ts" }).first();
      await w.mouse.move(2, 2);

      // Partly staged marker must be visible without hovering.
      const marker = row.getByRole("img", { name: "Partly staged" });
      await expect(marker).toBeVisible();
      const idle = await Promise.all([marker.boundingBox(), row.boundingBox()]);
      expect(idle[0]!.x).toBeGreaterThanOrEqual(idle[1]!.x);
      expect(idle[0]!.x + idle[0]!.width).toBeLessThanOrEqual(idle[1]!.x + idle[1]!.width);
      await w.screenshot({ path: path.join(shotDir, `${theme}-${width}-idle.png`) });

      await row.hover();
      const actions = row.locator(".gh-changes-panel__file-actions");
      await expect.poll(() => actions.evaluate((e) => getComputedStyle(e).opacity)).toBe("1");
      await expect(row.getByRole("button")).toHaveCount(4); // label button + Unstage + Stage + Discard
      const [a, r] = await Promise.all([actions.boundingBox(), row.boundingBox()]);
      expect(a!.x).toBeGreaterThanOrEqual(r!.x);
      expect(a!.x + a!.width).toBeLessThanOrEqual(r!.x + r!.width + 0.5);
      // The file name itself is never covered: its left part sits clear of the actions.
      const name = row.locator(".gh-changes-panel__file-name");
      const n = (await name.boundingBox())!;
      expect(n.x).toBeLessThan(a!.x);
      expect(a!.x - n.x).toBeGreaterThanOrEqual(40);
      await w.screenshot({ path: path.join(shotDir, `${theme}-${width}-hover.png`) });

      // Name remains a click target that selects the file.
      await name.click({ position: { x: 4, y: 4 } });
      await expect(row.locator(".gh-changes-panel__file-label")).toHaveAttribute("aria-pressed", "true");

      // Keyboard: every action is reachable and labelled.
      await row.locator(".gh-changes-panel__file-label").focus();
      for (const label of ["Unstage", "Stage", /Discard changes to/]) {
        await w.keyboard.press("Tab");
        await expect(row.getByRole("button", typeof label === "string" ? { name: label, exact: true } : { name: label })).toBeFocused();
      }
      await w.mouse.move(2, 2);
    }
  });
}
