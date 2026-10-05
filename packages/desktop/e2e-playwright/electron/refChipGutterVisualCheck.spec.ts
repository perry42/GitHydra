// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * specs/ref-chip-gutter-legibility.md AC9 (glyph-size fix, FR-406) plus
 * specs/ref-chip-gutter-redesign.md AC5/AC6 (148px gutter + literal type icons, FR-414/416) plus
 * this same spec's same-day Addendum AC3/AC3a/AC3b (lane-color-tinted chip background, superseding
 * FR-415's neutral border for every chip that has a real lane color to tint with, FR-417) — all
 * must be verified against REAL Electron screenshots, at both a 100% and a high-DPI (150-200%)
 * display scale, per this project's own documented regression history (CLAUDE.md's `GraphCanvas`
 * scroll-sync pitfall, `layoutBudget.test.ts`'s own "jsdom can't verify real layout" admission,
 * `App.branchTagGutter.e2e.test.tsx` precedent for this exact component). CSS-only/jsdom-only
 * reasoning is not sufficient sign-off for any of these criteria — notably, jsdom's
 * `getComputedStyle` cannot resolve `color-mix()` at all (verified directly, see
 * `RefChip.test.tsx`'s FR-415/FR-417 describe blocks), so the REAL per-pixel background color/
 * contrast checks below (AC3a's live cross-check of the same math `refChipLaneTint.contrast.test.ts`
 * already verifies abstractly) can only run here, against a real Chromium.
 *
 * `--force-device-scale-factor` is a real Electron/Chromium command-line switch (honored before
 * `app.whenReady()`, same mechanism `launchApp.ts`'s own `--user-data-dir` already relies on) — the
 * high-DPI variant below relaunches the app with it set to 2 (200%) rather than trying to fake DPI
 * any other way.
 *
 * Screenshots are written to the OS temp dir (path logged to the console); this spec also asserts
 * real rendered geometry (icon bounding boxes, visible-character counts against the actual
 * computed font, real computed background colors) as a supplementary, automatable check — but per
 * these ACs' own text, the screenshots themselves are the actual verification evidence for the
 * visual/legibility claims, not a replacement for it.
 */
import { test, expect, type Locator } from "@playwright/test";
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

/**
 * specs/ref-chip-gutter-redesign.md AC5/AC7: "the app's documented default window size (1400x900)"
 * — `electron/windowBounds.ts`'s real behavior is now display-relative (no saved
 * `window-bounds.json` in this test's fresh `--user-data-dir`), not a hardcoded 1400x900, so this
 * explicitly forces the real `BrowserWindow` back to that documented default rather than trusting
 * whatever size the test runner's own display happens to produce — same pattern
 * `toolbarActionRow.spec.ts` already established for exactly this reason.
 */
async function resizeToDocumentedDefault(h: LaunchedApp): Promise<void> {
  await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1400, 900));
  await h.window.waitForTimeout(200);
}

/**
 * specs/ref-chip-gutter-redesign.md AC5: measures exactly how many leading characters of `fullText`
 * are visible inside `label`'s rendered box before CSS `text-overflow: ellipsis` clips the rest —
 * using a canvas 2D context with the label's own real computed font, not a monospace-character-
 * count approximation, so this is an exact measurement against the real rendered pixels rather than
 * a rough guess.
 */
async function visibleCharCount(label: Locator, fullText: string): Promise<number> {
  return label.evaluate((el, text) => {
    const style = getComputedStyle(el);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const availablePx = el.getBoundingClientRect().width;
    let count = 0;
    for (let i = 1; i <= text.length; i++) {
      if (ctx.measureText(text.slice(0, i)).width > availablePx) break;
      count = i;
    }
    return count;
  }, fullText);
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
    test(`AC9/AC6: at ${scale.label} display scale, ${theme} theme — literal type icons are visible, legible, and distinguishable from each other and the graph's own commit-node dot (FR-416)`, async () => {
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

      // specs/ref-chip-gutter-redesign.md FR-416: one literal icon per ref-decoration type,
      // selected via `data-ref-icon` (set in `RefChip.tsx`) — the old shape-drawing CSS classes
      // (`.gh-refchip__icon--tag`/`--remote`/`--branch`/`--head`) no longer exist at all.
      const tagIcon = tagRow.locator("svg[data-ref-icon='tag']");
      const remoteIcon = remoteRow.locator("svg[data-ref-icon='remote-branch']");
      const branchIcon = branchRow.locator("svg[data-ref-icon='local-branch']");
      const headIcon = headRow.locator("svg[data-ref-icon='head']");
      await expect(tagIcon).toBeVisible();
      await expect(remoteIcon).toBeVisible();
      await expect(branchIcon).toBeVisible();
      await expect(headIcon).toBeVisible();

      // FR-416: all four render at a shared 14x14 CSS px box (`size={14}`, `IconWarning`'s own
      // already-shipped small-icon-in-a-chip precedent) — a real, literal SVG shape, not the old
      // CSS-drawn dot/ring/diamond/square. Playwright's boundingBox() reports real CSS pixels
      // regardless of the OS-level device scale factor, so this is a meaningful cross-check at
      // both 100% and 200%. `expect.poll` (rather than a bare `await icon.boundingBox()`) rides out
      // the occasional reflow-timing race right after the Find Commits overlay's Escape-close
      // animation settles, and the transient detach/reattach race a one-shot action can't survive.
      for (const icon of [tagIcon, remoteIcon, branchIcon, headIcon]) {
        await expect.poll(() => icon.boundingBox()).not.toBeNull();
        const box = (await icon.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(12);
        expect(box.width).toBeLessThanOrEqual(16);
        expect(box.height).toBeGreaterThanOrEqual(12);
        expect(box.height).toBeLessThanOrEqual(16);
      }

      // specs/ref-chip-gutter-redesign.md FR-416: distinct SVG shapes — a cheap, automatable proxy
      // for "distinguishable from each other" (the actual legibility/recognizability call is the
      // screenshot below, per AC6's own text).
      const iconMarkups = await Promise.all(
        [tagIcon, remoteIcon, branchIcon, headIcon].map((icon) => icon.evaluate((el) => el.outerHTML)),
      );
      expect(new Set(iconMarkups).size).toBe(iconMarkups.length);

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

/**
 * specs/ref-chip-gutter-redesign.md AC5: this repo's own real branch names, recreated on distinct
 * commits so each renders as a single, non-collapsed chip (FR-408 only collapses at chips.length
 * >= 2 per row) — the exact scenario the spec's Problem section found truncating mid-type-prefix at
 * the old 100px gutter. A trailing, unref'd commit moves the checked-out branch's own tip past the
 * last named commit, so that row shows only its own single custom chip too (not a second "main"
 * chip crowding it into collapse).
 */
const REAL_BRANCH_NAMES = [
  "fix/context-menu-viewport-clamp",
  "docs/keyboard-shortcuts-specs",
  "docs/ref-chip-gutter-legibility",
  "feat/online-sync-clone",
  "fix/keyboard-shortcuts-label-truncation",
] as const;

async function buildRealBranchNameRepo(): Promise<{ dir: string }> {
  const dir = await initRepo();
  let i = 0;
  for (const name of REAL_BRANCH_NAMES) {
    i += 1;
    await writeFile(dir, `f${i}.txt`, `${name}\n`);
    const sha = await commitAll(dir, `commit for ${name}`);
    await git(dir, ["branch", name, sha]);
  }
  await writeFile(dir, "trailer.txt", "trailer\n");
  await commitAll(dir, "trailer commit (keeps the checked-out branch's own tip off the named rows)");
  return { dir };
}

for (const scale of [
  { label: "100%", args: [] as string[] },
  { label: "200% (high-DPI)", args: ["--force-device-scale-factor=2"] },
]) {
  for (const theme of ["dark", "light"] as const) {
    test(`AC5/AC6: at ${scale.label} display scale, ${theme} theme — this repo's own real type/scope branch names show their full type prefix plus a meaningfully longer fragment than the old ~10-12 char/mid-prefix cut, with a visible lane-tinted background`, async () => {
      handle = await launchGitHydra(scale.args);
      shotDir = await fs.mkdtemp(path.join(os.tmpdir(), "githydra-pw-refchip-realnames-"));

      const built = await buildRealBranchNameRepo();
      repoDir = built.dir;

      await openRepoThroughRealUiExact(handle, repoDir);
      await resizeToDocumentedDefault(handle);
      await setTheme(handle, theme);

      // AC5: BranchesPanel + DetailPanel both open at default width — BranchesPanel is always on
      // (the left sidebar), DetailPanel only opens once a commit is selected.
      const firstRow = handle.window.locator('[role="option"]').first();
      await firstRow.click();
      await expect(handle.window.getByRole("complementary", { name: "Commit details" })).toBeVisible();

      await handle.window.screenshot({ path: path.join(shotDir, `${theme}-${scale.label.replace(/[^a-z0-9]+/gi, "")}-full.png`) });

      for (const name of REAL_BRANCH_NAMES) {
        const row = handle.window.locator('[role="option"]', { hasText: `commit for ${name}` });
        await expect(row).toBeVisible();
        const chip = row.getByRole("img", { name: new RegExp(`local branch: ${name.replace(/\//g, "\\/")}$`, "i") });
        await expect(chip).toBeVisible();

        // FR-417: a visible, lane-tinted background on every chip (superseding FR-415's neutral
        // border for chips with a real lane color) — real Chromium fully resolves `color-mix()`
        // (jsdom cannot at all), so this reads the REAL computed pixel color, not a CSS string.
        const chipBox = await chip.boundingBox();
        expect(chipBox).not.toBeNull();
        const bgAlpha = await chip.evaluate((el) => {
          // Chromium serializes a resolved `color-mix(in srgb, ...)` background as a CSS Color 4
          // `color(srgb r g b [/ a])` function (0-1 floats), NOT the classic `rgb()`/`rgba()`
          // 0-255 notation — found only by actually running this against real Chromium, not
          // something jsdom (or reading the spec) would have surfaced. Handle both notations.
          const css = getComputedStyle(el).backgroundColor;
          const colorFn = css.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/);
          if (colorFn) return Number(colorFn[4] ?? 1);
          const rgbFn = css.match(/^rgba?\([\d.]+,\s*[\d.]+,\s*[\d.]+(?:,\s*([\d.]+))?\)$/);
          if (rgbFn) return Number(rgbFn[1] ?? 1);
          throw new Error(`unparseable computed backgroundColor: ${css}`);
        });
        // A real resolved color-mix() output is always opaque (alpha 1) — an alpha of 0 (or the
        // literal "transparent") would mean the mix silently failed to resolve, the exact class of
        // bug this real-Chromium check exists to catch that jsdom cannot.
        expect(bgAlpha).toBe(1);

        const label = chip.locator(".gh-refchip__label");
        const count = await visibleCharCount(label, name);
        // The old 100px gutter cut every one of these five real names to ~10-12 characters, always
        // landing inside the `fix/`/`docs/`/`feat/` type prefix (specs/ref-chip-gutter-redesign.md
        // Problem #1). At 148px, the visible fragment must be meaningfully longer AND clear the
        // whole type prefix (through its trailing "/").
        expect(count).toBeGreaterThanOrEqual(14);
        const prefixEnd = name.indexOf("/") + 1;
        expect(count).toBeGreaterThanOrEqual(prefixEnd);
        expect(name.slice(0, count).startsWith(name.slice(0, prefixEnd))).toBe(true);

        const gutter = row.locator(".gh-commit-row__refgutter");
        const shotBase = `${theme}-${scale.label.replace(/[^a-z0-9]+/gi, "")}-${name.replace(/\//g, "-")}`;
        await gutter.screenshot({ path: path.join(shotDir, `${shotBase}-gutter.png`) });
      }
    });
  }
}

/**
 * specs/ref-chip-gutter-redesign.md Addendum, AC3b: two ref chips on DIFFERENT graph lanes need to
 * be visually distinguishable from each other by their background tint alone. A straight, unmerged
 * two-branch repo (`main` tip and a sibling `feature` tip, both visible simultaneously, still
 * diverged) is the simplest real fixture that puts two real branch chips on two different lanes —
 * `LaneAssigner` (`lib/laneAssignment.ts`) allocates each unconverged branch tip its own lane in
 * the topo-ordered log, so `main`'s chip gets `colorSlot 0` (`--gh-lane-1`) and `feature`'s chip
 * gets `colorSlot 1` (`--gh-lane-2`) — two different tokens, not the same one repeated.
 */
async function buildTwoLaneRepo(): Promise<{ dir: string }> {
  const dir = await initRepo();
  await writeFile(dir, "a.txt", "base\n");
  await commitAll(dir, "base commit");
  await git(dir, ["checkout", "-q", "-b", "feature"]);
  await writeFile(dir, "f.txt", "feature\n");
  await commitAll(dir, "feature branch commit");
  await git(dir, ["checkout", "-q", "main"]);
  await writeFile(dir, "m.txt", "main\n");
  await commitAll(dir, "main branch commit");
  return { dir };
}

for (const theme of ["dark", "light"] as const) {
  test(`AC3/AC3a/AC3b, ${theme} theme — two ref chips on different real graph lanes render visibly distinct background tints, each keeping its own text at real >= 4.5:1 contrast`, async () => {
    handle = await launchGitHydra();
    shotDir = await fs.mkdtemp(path.join(os.tmpdir(), "githydra-pw-refchip-lanetint-"));

    const built = await buildTwoLaneRepo();
    repoDir = built.dir;

    await openRepoThroughRealUiExact(handle, repoDir);
    await resizeToDocumentedDefault(handle);
    await setTheme(handle, theme);

    const mainRow = handle.window.locator('[role="option"]', { hasText: "main branch commit" });
    const featureRow = handle.window.locator('[role="option"]', { hasText: "feature branch commit" });
    await expect(mainRow).toBeVisible();
    await expect(featureRow).toBeVisible();

    const mainChip = mainRow.getByRole("img", { name: /local branch: main/i });
    const featureChip = featureRow.getByRole("img", { name: /local branch: feature/i });
    await expect(mainChip).toBeVisible();
    await expect(featureChip).toBeVisible();

    // AC3: no background fill on the old neutral-border chip is expected anymore — both chips are
    // the FR-417 `--tinted` variant (this repo has no DetailPanel-only, lane-less chip in view).
    await expect(mainChip).toHaveClass(/gh-refchip--tinted/);
    await expect(featureChip).toHaveClass(/gh-refchip--tinted/);

    // AC3b: real computed pixel colors, not the CSS source string — two DIFFERENT lanes must
    // resolve to two DIFFERENT real background colors.
    const mainBg = await mainChip.evaluate((el) => getComputedStyle(el).backgroundColor);
    const featureBg = await featureChip.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(mainBg).not.toBe(featureBg);

    // AC3a, live cross-check: compute the REAL contrast ratio from the two real rendered pixel
    // colors (background + actual text color, both read live from the browser) — the same WCAG
    // formula `contrastRatio.ts`/`refChipLaneTint.contrast.test.ts` already verify abstractly
    // against every token combination, now checked against the literal resolved-in-Chromium pixels
    // for these two specific chips, in this specific theme.
    const contrastRatios = await handle.window.evaluate(
      ([mainSelector, featureSelector]) => {
        // Returns [r, g, b] each normalized to 0-1. Chromium serializes a resolved
        // `color-mix(in srgb, ...)` result as a CSS Color 4 `color(srgb r g b [/ a])` function
        // (already 0-1 floats) rather than classic `rgb()`/`rgba()` (0-255 ints) — found only by
        // running this against real Chromium (jsdom never exercises this code path at all, and the
        // spec text alone wouldn't have flagged which notation a real browser actually serializes).
        // Plain `color:` (the text ink, still a plain token, never color-mix()) still serializes as
        // classic `rgb()`, so both notations have to be handled here.
        function parseColor01([r, g, b]: [number, number, number], is255: boolean): [number, number, number] {
          return is255 ? [r / 255, g / 255, b / 255] : [r, g, b];
        }
        function parseCss(css: string): [number, number, number] {
          const colorFn = css.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
          if (colorFn) return parseColor01([Number(colorFn[1]), Number(colorFn[2]), Number(colorFn[3])], false);
          const rgbFn = css.match(/^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
          if (rgbFn) return parseColor01([Number(rgbFn[1]), Number(rgbFn[2]), Number(rgbFn[3])], true);
          throw new Error(`unparseable color: ${css}`);
        }
        function srgbToLinear(c01: number): number {
          return c01 <= 0.04045 ? c01 / 12.92 : Math.pow((c01 + 0.055) / 1.055, 2.4);
        }
        function luminance([r, g, b]: [number, number, number]): number {
          return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
        }
        function contrast(a: [number, number, number], b: [number, number, number]): number {
          const la = luminance(a);
          const lb = luminance(b);
          const lighter = Math.max(la, lb);
          const darker = Math.min(la, lb);
          return (lighter + 0.05) / (darker + 0.05);
        }
        const results: number[] = [];
        for (const sel of [mainSelector, featureSelector]) {
          const el = document.querySelector(sel) as HTMLElement;
          const style = getComputedStyle(el);
          results.push(contrast(parseCss(style.color), parseCss(style.backgroundColor)));
        }
        return results;
      },
      [`[aria-label="local branch: main"]`, `[aria-label="local branch: feature"]`] as [string, string],
    );
    for (const ratio of contrastRatios) {
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    }

    await handle.window.screenshot({ path: path.join(shotDir, `${theme}-two-lane-full.png`) });
    await mainRow.locator(".gh-commit-row__refgutter").screenshot({ path: path.join(shotDir, `${theme}-main-lane-gutter.png`) });
    await featureRow.locator(".gh-commit-row__refgutter").screenshot({ path: path.join(shotDir, `${theme}-feature-lane-gutter.png`) });
  });
}

/**
 * Follow-up to specs/ref-chip-gutter-legibility.md FR-411, found via a real user report: opening
 * the "+N" collapse popover on a row with a remote-tracking branch showed that ref's row as plain
 * text only — no icon — inconsistent with every visible chip now carrying a literal per-type icon
 * (specs/ref-chip-gutter-redesign.md FR-416). Reproduces the exact reported scenario: the checked-
 * out branch's own commit also carries a remote-tracking ref for the same branch (a completely
 * ordinary, common state — `origin/main` sitting on the same commit as local `main`), so the row
 * collapses to the filled `main` chip + a real "+1", and opening it must show the cloud icon next
 * to "remote branch: origin/main", not bare text.
 */
test("Follow-up: the +N popover shows the same per-type icon as the visible chip, for a collapsed remote-tracking branch", async () => {
  handle = await launchGitHydra();
  shotDir = await fs.mkdtemp(path.join(os.tmpdir(), "githydra-pw-refchip-popovericon-"));

  const dir = await initRepo();
  await writeFile(dir, "a.txt", "base\n");
  const sha = await commitAll(dir, "checked out tip with a remote-tracking ref too");
  await git(dir, ["update-ref", "refs/remotes/origin/main", sha]);
  repoDir = dir;

  await openRepoThroughRealUiExact(handle, repoDir);

  // Remote-tracking refs aren't shown by default — same "show all branches & tags" toggle
  // `buildFourGlyphRepo`'s own AC9 test above already needs for the same reason.
  await handle.window.getByRole("button", { name: "Find commits" }).click();
  await handle.window.getByRole("checkbox", { name: /show all branches & tags/i }).click();
  await handle.window.keyboard.press("Escape");

  const row = handle.window.locator('[role="option"]', { hasText: "checked out tip with a remote-tracking ref too" });
  await expect(row).toBeVisible();
  const moreButton = row.locator(".gh-commit-row__refgutter-more");
  await expect(moreButton).toBeVisible();
  await moreButton.click();

  const menu = handle.window.getByRole("menu", { name: /more refs on this commit/i });
  await expect(menu).toBeVisible();
  const remoteItem = menu.getByRole("menuitem", { name: "remote branch: origin/main" });
  await expect(remoteItem).toBeVisible();
  // The structural fix: a real icon element inside the row, not bare text.
  await expect(remoteItem.locator('svg[data-ref-icon="remote-branch"]')).toBeVisible();

  // A single screenshot of just the popover, taken immediately after the assertions above
  // confirm it's open — a second, separate full-window shot first was observed to occasionally
  // let the popover close before this one fired (each `locator.screenshot()` scrolls its target
  // into view first, and this component's own FR-316 closes on any scroll of the graph).
  // Clip a page screenshot to the menu's box: locator.screenshot() scroll-into-view can close the popover (FR-316).
  const box = await menu.boundingBox();
  expect(box).not.toBeNull();
  await handle.window.screenshot({ path: path.join(shotDir, "popover-icon-menu.png"), clip: box! });
});

/**
 * specs/ref-chip-synced-upstream-merge.md AC6: a local branch and its EXACTLY-synced upstream
 * (real `git clone`, so `ahead===0 && behind===0` and a genuine configured `upstreamName` — not
 * faked via `update-ref`) must render as one merged chip with both icons, not two separate chips.
 */
test("Follow-up: a local branch and its exactly-synced upstream merge into one chip with both icons", async () => {
  handle = await launchGitHydra();
  shotDir = await fs.mkdtemp(path.join(os.tmpdir(), "githydra-pw-refchip-syncmerge-"));

  // Real bare "remote" + a real clone, exactly `App.push.e2e.test.tsx`'s own `setupRemoteAndClone`
  // shape — `git clone` itself configures `main`'s upstream to `origin/main`, both already at the
  // identical commit, so `ahead===0 && behind===0` is real, not simulated.
  const remoteDir = await initRepo({ bare: true });
  const seedDir = await initRepo();
  await writeFile(seedDir, "a.txt", "base\n");
  await commitAll(seedDir, "synced tip commit");
  await git(seedDir, ["remote", "add", "origin", remoteDir]);
  await git(seedDir, ["push", "-q", "origin", "main"]);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "githydra-pw-refchip-syncmerge-clone-"));
  await git(process.cwd(), ["clone", "-q", "--branch", "main", remoteDir, dir]);
  repoDir = dir;

  await openRepoThroughRealUiExact(handle, repoDir);
  await handle.window.getByRole("button", { name: "Find commits" }).click();
  await handle.window.getByRole("checkbox", { name: /show all branches & tags/i }).click();
  await handle.window.keyboard.press("Escape");

  const row = handle.window.locator('[role="option"]', { hasText: "synced tip commit" });
  await expect(row).toBeVisible();
  const gutter = row.locator(".gh-commit-row__refgutter");

  // One merged chip, not two, and no "+N" — nothing else is competing for space on this commit.
  await expect(gutter.getByRole("button")).toHaveCount(0);
  const chip = gutter.getByRole("img", { name: "local branch: main (synced with origin/main)" });
  await expect(chip).toBeVisible();
  await expect(chip.locator('svg[data-ref-icon="local-branch"]')).toBeVisible();
  await expect(chip.locator('svg[data-ref-icon="remote-branch"]')).toBeVisible();

  await gutter.screenshot({ path: path.join(shotDir, "synced-merge-gutter.png") });

  // `repoDir` (cleaned by afterEach) is the clone; the bare "remote" and its seed checkout are
  // this test's own extra fixtures, cleaned up directly here.
  await cleanup(remoteDir);
  await cleanup(seedDir);
});
