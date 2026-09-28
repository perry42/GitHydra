// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * specs/ref-chip-gutter-legibility.md AC9: the type-glyph size fix (FR-406, 6x6 -> 8x8, remote-
 * branch ring border 1.5px -> 2px) must be verified against REAL Electron screenshots at both a
 * 100% and a high-DPI (150-200%) display scale — this project's own documented regression history
 * (CLAUDE.md's `GraphCanvas` scroll-sync pitfall, `layoutBudget.test.ts`'s own "jsdom can't verify
 * real layout" admission, `App.branchTagGutter.e2e.test.tsx` precedent for this exact component)
 * is why CSS-only/jsdom-only reasoning isn't sufficient sign-off for this one criterion.
 *
 * `--force-device-scale-factor` is a real Electron/Chromium command-line switch (honored before
 * `app.whenReady()`, same mechanism `launchApp.ts`'s own `--user-data-dir` already relies on) — the
 * high-DPI variant below relaunches the app with it set to 2 (200%) rather than trying to fake DPI
 * any other way.
 *
 * Screenshots are written to the OS temp dir (path logged to the console); this spec also asserts
 * each icon's real rendered bounding box is ~8 real CSS px (not the old 6px) as a supplementary,
 * automatable check — but per AC9's own text, the screenshots themselves are the actual
 * verification evidence, not a replacement for it.
 */
import { test, expect } from "@playwright/test";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import { closeApp, launchGitHydra, removeUserDataDir, type LaunchedApp } from "../helpers/launchApp";
import { cleanup, commitAll, git, initRepo, writeFile } from "../../src/test/gitFixture";

let handle: LaunchedApp;
let repoDir: string;
let shotDir: string;

test.afterEach(async () => {
  await closeApp(handle);
  await removeUserDataDir(handle.userDataDir);
  if (repoDir) await cleanup(repoDir);
  if (shotDir) {
    // eslint-disable-next-line no-console
    console.log(`ref-chip-gutter glyph screenshots: ${shotDir}`);
  }
});

async function openRepoThroughRealUiExact(h: LaunchedApp, repoPath: string): Promise<void> {
  await h.app.evaluate(({ dialog }, dir) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
  }, repoPath);
  await h.window.getByRole("button", { name: "Open a repository", exact: true }).click();
  await h.window.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });
}

async function setTheme(h: LaunchedApp, theme: "light" | "dark"): Promise<void> {
  const current = await h.window.evaluate(() => document.documentElement.dataset.theme);
  if (current === theme) return;
  await h.window.getByRole("button", { name: "More actions" }).click();
  await h.window.getByRole("menuitem", { name: /switch to (light|dark) theme/i }).click();
  await expect.poll(() => h.window.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
}

/** Builds a repo with one ref decoration per commit (branch/tag/remote-branch/detached HEAD),
 * mirroring App.branchTagGutter.e2e.test.tsx's own AC3 fixture — no row here ever collapses
 * (FR-408), so all four glyph shapes are simultaneously visible for the screenshot. */
async function buildFourGlyphRepo(): Promise<{ dir: string; detachSha: string }> {
  const dir = await initRepo();
  await writeFile(dir, "a.txt", "base\n");
  const detachSha = await commitAll(dir, "detach target commit");
  await writeFile(dir, "b.txt", "tag\n");
  await commitAll(dir, "tag commit");
  await git(dir, ["tag", "v1.0"]);
  await writeFile(dir, "c.txt", "remote\n");
  const remoteSha = await commitAll(dir, "remote-tracked commit");
  await git(dir, ["update-ref", "refs/remotes/origin/feature", remoteSha]);
  await writeFile(dir, "d.txt", "main tip\n");
  await commitAll(dir, "main tip commit");
  await git(dir, ["checkout", "-q", detachSha]);
  return { dir, detachSha };
}

async function showAllRefsAndFindRows(h: LaunchedApp) {
  await h.window.getByRole("button", { name: "Find commits" }).click();
  await h.window.getByRole("checkbox", { name: /show all branches & tags/i }).click();
  await h.window.keyboard.press("Escape");

  return {
    tagRow: h.window.locator('[role="option"]', { hasText: "tag commit" }),
    remoteRow: h.window.locator('[role="option"]', { hasText: "remote-tracked commit" }),
    branchRow: h.window.locator('[role="option"]', { hasText: "main tip commit" }),
    headRow: h.window.locator('[role="option"]', { hasText: "detach target commit" }),
  };
}

/**
 * Follow-up to specs/ref-chip-gutter-legibility.md, found via a real user screenshot after the
 * FR-406/FR-410 fix shipped: on the checked-out commit's own row, the synthetic HEAD badge, the
 * one visible branch chip, and the "+N" affix are three flex-shrink competitors in the same fixed
 * 100px gutter — `CommitRow.test.tsx`'s AC3 test only checked the right elements were PRESENT,
 * never that they'd still be legible at real pixel width. In the real app, both text labels
 * collapsed via their own ellipsis down to one character ("H..", "m."). The fix: the HEAD badge
 * renders `iconOnly` (RefChip.tsx) whenever this exact crowding happens, freeing width for the
 * branch name. This is real layout math jsdom can't verify (`layoutBudget.test.ts`'s own
 * admission) — hence a real Electron screenshot, same rationale as AC9 above.
 */
async function buildCrowdedCheckedOutRepo(): Promise<{ dir: string }> {
  const dir = await initRepo();
  await writeFile(dir, "a.txt", "base\n");
  await commitAll(dir, "checked out tip commit");
  await git(dir, ["tag", "v1.0"]);
  return { dir };
}

test("Follow-up: the checked-out row's HEAD badge stays icon-only when a second ref crowds it, keeping the branch name legible", async () => {
  handle = await launchGitHydra();
  shotDir = await fs.mkdtemp(path.join(os.tmpdir(), "githydra-pw-refchip-crowd-"));

  const built = await buildCrowdedCheckedOutRepo();
  repoDir = built.dir;

  await openRepoThroughRealUiExact(handle, repoDir);

  const row = handle.window.locator('[role="option"]', { hasText: "checked out tip commit" });
  await expect(row).toBeVisible();

  const gutter = row.locator(".gh-commit-row__refgutter");
  const headBadge = gutter.getByRole("img", { name: /^HEAD: HEAD$/i });
  const mainChip = gutter.getByRole("img", { name: /local branch: main/i });
  const moreButton = gutter.getByRole("button", { name: /1 more refs on this commit/i });
  await expect(headBadge).toBeVisible();
  await expect(mainChip).toBeVisible();
  await expect(moreButton).toBeVisible();

  // The structural fix: the HEAD badge has no visible label span left to crush.
  await expect(headBadge.locator(".gh-refchip__label")).toHaveCount(0);
  // The actual legibility evidence: the branch chip's rendered box is wide enough to show "main"
  // close to in full, not squeezed down to a single character the way the bug report showed.
  await expect.poll(() => mainChip.boundingBox()).not.toBeNull();
  const mainBox = (await mainChip.boundingBox())!;
  expect(mainBox.width).toBeGreaterThanOrEqual(30);

  await handle.window.screenshot({ path: path.join(shotDir, "crowded-checked-out-full.png") });
  await gutter.screenshot({ path: path.join(shotDir, "crowded-checked-out-gutter.png") });
});

for (const scale of [
  { label: "100%", args: [] as string[] },
  { label: "200% (high-DPI)", args: ["--force-device-scale-factor=2"] },
]) {
  for (const theme of ["dark", "light"] as const) {
    test(`AC9: at ${scale.label} display scale, ${theme} theme — type glyphs are visibly larger and distinguishable (dot/ring/diamond/square)`, async () => {
      handle = await launchGitHydra(scale.args);
      shotDir = await fs.mkdtemp(path.join(os.tmpdir(), "githydra-pw-refchip-glyph-"));

      const built = await buildFourGlyphRepo();
      repoDir = built.dir;

      await openRepoThroughRealUiExact(handle, repoDir);
      await setTheme(handle, theme);

      const { tagRow, remoteRow, branchRow, headRow } = await showAllRefsAndFindRows(handle);
      await expect(tagRow).toBeVisible();
      await expect(remoteRow).toBeVisible();
      await expect(branchRow).toBeVisible();
      await expect(headRow).toBeVisible();

      const tagIcon = tagRow.locator(".gh-refchip__icon--tag");
      const remoteIcon = remoteRow.locator(".gh-refchip__icon--remote");
      const branchIcon = branchRow.locator(".gh-refchip__icon--branch");
      const headIcon = headRow.locator(".gh-refchip__icon--head");
      await expect(tagIcon).toBeVisible();
      await expect(remoteIcon).toBeVisible();
      await expect(branchIcon).toBeVisible();
      await expect(headIcon).toBeVisible();

      // FR-406: 8x8 CSS px (up from the old 6x6) — Playwright's boundingBox() reports real CSS
      // pixels regardless of the OS-level device scale factor, so this same assertion is a
      // meaningful cross-check at both 100% and 200%: a real layout box, not a jsdom style string.
      // The tag glyph's box is rotated 45deg (RefChip.css), so its own AXIS-ALIGNED bounding box is
      // the rotated square's diagonal (8 * sqrt(2) ~= 11.31), not 8 itself — checked separately.
      // `expect.poll` (rather than a bare `await icon.boundingBox()`) rides out the occasional
      // reflow-timing race right after the Find Commits overlay's Escape-close animation settles.
      for (const icon of [remoteIcon, branchIcon, headIcon]) {
        // `expect.poll` re-queries the locator on every attempt, riding out the transient
        // detach/reattach race a `scrollIntoViewIfNeeded()`-style one-shot action can't survive.
        await expect.poll(() => icon.boundingBox()).not.toBeNull();
        const box = (await icon.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(7);
        expect(box.width).toBeLessThanOrEqual(9);
        expect(box.height).toBeGreaterThanOrEqual(7);
        expect(box.height).toBeLessThanOrEqual(9);
      }
      await expect.poll(() => tagIcon.boundingBox()).not.toBeNull();
      const tagBox = (await tagIcon.boundingBox())!;
      expect(tagBox.width).toBeGreaterThanOrEqual(10.5);
      expect(tagBox.width).toBeLessThanOrEqual(12.5);
      expect(tagBox.height).toBeGreaterThanOrEqual(10.5);
      expect(tagBox.height).toBeLessThanOrEqual(12.5);

      const shotBase = `${theme}-${scale.label.replace(/[^a-z0-9]+/gi, "")}`;
      await handle.window.screenshot({ path: path.join(shotDir, `${shotBase}-full.png`) });
      // Tight crops of the gutter column on each row — the actual "is this legible" evidence.
      for (const [name, row] of [
        ["tag", tagRow],
        ["remote", remoteRow],
        ["branch", branchRow],
        ["head", headRow],
      ] as const) {
        const gutter = row.locator(".gh-commit-row__refgutter");
        await gutter.screenshot({ path: path.join(shotDir, `${shotBase}-${name}-gutter.png`) });
      }
    });
  }
}
