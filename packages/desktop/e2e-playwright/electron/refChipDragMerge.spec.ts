// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Real-Electron verification of ref-chip drag-to-merge with REAL pointer events (jsdom stubs
 * `elementFromPoint`; this doesn't): a descendant branch chip dropped on a branch chip collapsed
 * behind "+1" (same commit as another branch) opens the popover on hover and offers Merge.
 */
import { test, expect } from "@playwright/test";
import { closeApp, launchGitHydra, removeUserDataDir, stubOpenRepoDialog, type LaunchedApp } from "../helpers/launchApp";
import { cleanup, commitAll, git, initRepo, writeFile } from "../../src/test/gitFixture";

let handle: LaunchedApp;
let repoDir: string;

test.beforeEach(async () => {
  handle = await launchGitHydra();
});
test.afterEach(async () => {
  await closeApp(handle);
  await removeUserDataDir(handle.userDataDir);
  if (repoDir) await cleanup(repoDir);
});

test("dragging feat onto main inside the +1 popover offers an enabled fast-forward merge; chore onto main is up to date", async () => {
  repoDir = await initRepo();
  await writeFile(repoDir, "a.txt", "base\n");
  await commitAll(repoDir, "Base commit");
  await git(repoDir, ["branch", "chore"]);
  await git(repoDir, ["checkout", "-b", "feat"]);
  await writeFile(repoDir, "a.txt", "second\n");
  await commitAll(repoDir, "Feature commit");

  await stubOpenRepoDialog(handle.app, repoDir);
  await handle.window.getByRole("button", { name: "Open a repository", exact: true }).click();
  await handle.window.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });
  const w = handle.window;

  const baseRow = w.locator('[role="option"]', { hasText: "Base commit" });
  const more = baseRow.locator(".gh-commit-row__refgutter-more");
  await expect(more).toBeVisible();

  async function dragFrom(branch: string) {
    const chip = w.locator(`.gh-commit-row__refgutter [data-ref-branch="${branch}"]`).first();
    const cb = (await chip.boundingBox())!;
    const mb = (await more.boundingBox())!;
    await w.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
    await w.mouse.down();
    await w.mouse.move(cb.x + cb.width / 2 + 10, cb.y + cb.height / 2 + 10, { steps: 3 });
    await w.mouse.move(mb.x + mb.width / 2, mb.y + mb.height / 2, { steps: 5 });
    // Popover auto-opens after the ~400ms hover.
    const target = w.locator('.gh-context-menu [data-ref-branch="main"]');
    await expect(target).toBeVisible({ timeout: 3000 });
    const tb = (await target.boundingBox())!;
    await w.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2, { steps: 6 });
    await expect(target).toHaveClass(/gh-context-menu__item--drop-active/);
    await w.screenshot({ path: `${process.env.TEMP ?? "."}/chipdrag-${branch}.png` });
    await w.mouse.up();
  }

  await dragFrom("feat");
  const ff = w.getByRole("menuitem", { name: "Merge feat into main" });
  await expect(ff).toBeVisible();
  await expect(ff).toBeEnabled();
  await w.keyboard.press("Escape");

  await dragFrom("chore");
  const same = w.getByRole("menuitem", { name: "Merge chore into main" });
  await expect(same).toBeVisible();
  await expect(same).toBeDisabled();
  await expect(same).toHaveAttribute("title", "Already up to date");
});

test("Branches panel cards: card -> gutter chip, card -> '+N' popover chip, and card -> card (real merge, panel refreshes)", async () => {
  repoDir = await initRepo();
  await writeFile(repoDir, "a.txt", "base\n");
  await commitAll(repoDir, "Base commit");
  await git(repoDir, ["branch", "chore"]);
  await git(repoDir, ["checkout", "-b", "feat"]);
  await writeFile(repoDir, "a.txt", "second\n");
  await commitAll(repoDir, "Feature commit");

  await stubOpenRepoDialog(handle.app, repoDir);
  await handle.window.getByRole("button", { name: "Open a repository", exact: true }).click();
  await handle.window.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });
  const w = handle.window;

  const card = (name: string) => w.locator(`li[data-ref-branch="${name}"]`);
  await expect(card("feat")).toBeVisible();
  const spot = async (loc: ReturnType<typeof card>) => {
    const b = (await loc.boundingBox())!;
    return { x: b.x + 6, y: b.y + 5 }; // the card's own padding, never Checkout/Delete
  };
  async function pickUp(from: string) {
    const p = await spot(card(from));
    await w.mouse.move(p.x, p.y);
    await w.mouse.down();
    await w.mouse.move(p.x + 12, p.y + 12, { steps: 3 });
  }

  // 1. card -> visible gutter chip (`chore` on the base row): fast-forward is enabled.
  await pickUp("feat");
  const gutterChip = w.locator('.gh-commit-row__refgutter [data-ref-branch="chore"]').first();
  const gb = (await gutterChip.boundingBox())!;
  await w.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2, { steps: 8 });
  await expect(gutterChip).toHaveClass(/gh-refchip--drag-target/);
  await w.mouse.up();
  await expect(w.getByRole("menuitem", { name: "Merge feat into chore" })).toBeEnabled();
  await w.keyboard.press("Escape");

  // 2. card -> "+1" popover chip (`main`), hover-open included: same commit as chore, so the
  // reverse direction (main is an ancestor of feat) is a fast-forward too.
  await pickUp("feat");
  const more = w.locator(".gh-commit-row__refgutter-more").first();
  const mb = (await more.boundingBox())!;
  await w.mouse.move(mb.x + mb.width / 2, mb.y + mb.height / 2, { steps: 8 });
  const popChip = w.locator('.gh-context-menu [data-ref-branch="main"]');
  await expect(popChip).toBeVisible({ timeout: 3000 });
  const pb = (await popChip.boundingBox())!;
  await w.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2, { steps: 6 });
  await expect(popChip).toHaveClass(/gh-context-menu__item--drop-active/);
  await w.mouse.up();
  await expect(w.getByRole("menuitem", { name: "Merge feat into main" })).toBeEnabled();
  await w.keyboard.press("Escape");

  // 3. card -> card: highlight fills the target card, then really merge and check the result.
  await pickUp("feat");
  const tp = await spot(card("main"));
  await w.mouse.move(tp.x, tp.y, { steps: 8 });
  await expect(card("main")).toHaveClass(/gh-branches-panel__row--drag-target/);
  await expect(card("feat")).toHaveClass(/gh-branches-panel__row--drag-source/);
  await w.screenshot({ path: `${process.env.TEMP ?? "."}/carddrag.png` });
  await w.mouse.up();
  await w.getByRole("menuitem", { name: "Merge feat into main" }).click();

  // main was checked out and fast-forwarded to feat's tip; the panel shows main as Current.
  await expect(card("main").getByText("Current")).toBeVisible({ timeout: 10_000 });
  // Checkout lands first ("Current" shows), the merge itself a moment later: poll instead of a one-shot read.
  const featSha = (await git(repoDir, ["rev-parse", "feat"])).stdout.trim();
  await expect.poll(async () => (await git(repoDir, ["rev-parse", "main"])).stdout.trim(), { timeout: 10_000 }).toBe(featSha);
});
