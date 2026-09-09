// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * test-agent verification (specs/filter-bar-visual-redesign.md AC7/FR-253): a real-Electron,
 * real-pixel regression guard for the From/To date inputs' calendar-picker icon and empty-state
 * placeholder segments actually rendering in `var(--gh-ink-muted)` (#898781 in the light theme, see
 * `src/theme.css`) at rest — not just a `getComputedStyle` check, which can't catch this class of
 * bug. Chromium's native `<input type="date">` calendar-picker glyph is an internal image the
 * `::-webkit-calendar-picker-indicator` pseudo-element's `color` property does not actually recolor
 * in this Chromium build (confirmed by this spec, currently RED) — only `filter`-based approaches
 * (e.g. `filter: invert(...)`) or a fully custom background-image icon reach it. This is a rendering
 * defect FilterBar.css's current `color: var(--gh-ink-muted)` rule on
 * `.gh-filter-bar__field input[type="date"]::-webkit-calendar-picker-indicator` does not fix, even
 * though it reads correct at the CSS-source level — exactly the gap AC7's "confirmed via a real
 * Electron screenshot (not a code-only read)" requirement exists to catch.
 */
import { test, expect } from "@playwright/test";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import { closeApp, launchGitHydra, removeUserDataDir, stubOpenRepoDialog, type LaunchedApp } from "../helpers/launchApp";
import { cleanup, commitAll, initRepo, writeFile } from "../../src/test/gitFixture";
import { decodePng, countPixelsNearColor } from "../helpers/pngPixels";

let handle: LaunchedApp;
let repoDir: string;
let scratchDir: string;

test.beforeEach(async () => {
  handle = await launchGitHydra();
  scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "githydra-pw-ac7-"));
});

test.afterEach(async () => {
  await closeApp(handle);
  await removeUserDataDir(handle.userDataDir);
  if (repoDir) await cleanup(repoDir);
  await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => {});
});

test("AC7/FR-253: From date input's calendar-picker icon renders in muted ink, not default black, at rest", async () => {
  repoDir = await initRepo();
  await writeFile(repoDir, "a.txt", "base\n");
  await commitAll(repoDir, "First commit");

  await stubOpenRepoDialog(handle.app, repoDir);
  await handle.window.getByRole("button", { name: "Open a repository", exact: true }).click();
  await handle.window.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });

  await handle.window.getByRole("button", { name: /search & filter/i }).click();
  await handle.window.getByRole("button", { name: /more filters/i }).click();

  const fromInput = handle.window.getByLabel(/^from$/i);
  await fromInput.waitFor();

  // Move the mouse away first so we capture the icon's at-rest color, not its hover/focus accent
  // swap (FilterBar.css's own `:hover`/`:focus` rule, which is correct and out of scope here).
  await handle.window.mouse.move(0, 0);

  const shotPath = path.join(scratchDir, "from-input.png");
  await fromInput.screenshot({ path: shotPath });
  const img = decodePng(shotPath);

  // The placeholder's empty "dd"/"yyyy" segments must render in the muted-ink token (confirms the
  // half of FR-253 that *does* work today).
  const mutedInkPixels = countPixelsNearColor(img, "898781", 4);
  expect(mutedInkPixels).toBeGreaterThan(0);

  // The calendar-picker icon must NOT render in default browser black — this is the half of FR-253
  // that currently fails: the icon renders as pure #000000 regardless of the CSS `color` rule
  // targeting `::-webkit-calendar-picker-indicator`, because Chromium's native calendar glyph
  // doesn't respond to `color` the way ordinary text does.
  const pureBlackPixels = countPixelsNearColor(img, "000000", 0);
  expect(pureBlackPixels).toBe(0);
});
