// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * specs/find-commits-overlay.md AC1/AC12/FR-269: two real-Electron checks migrated/added when
 * `FilterBar` was retired in favor of the floating `FindCommitsOverlay`:
 *
 *  - AC1: with a repo open, no permanent filter row occupies any vertical space above the commit
 *    graph before the overlay is ever opened — a real pixel check (the toolbar's bottom edge sits
 *    directly against the graph's top edge), not just a DOM/CSS-source read.
 *  - AC12: the From/To date inputs' calendar-picker icon and empty-state placeholder segments
 *    still render in `var(--gh-ink-muted)` (#898781 in the light theme, see `src/theme.css`) at
 *    rest inside the overlay's new markup. This is the exact same real-Electron pixel-sampling
 *    check `specs/filter-bar-visual-redesign.md`'s AC7/FR-253 originally added for `FilterBar` —
 *    per FR-269, the CSS technique itself (hide the native glyph, layer a real `IconCalendar` on
 *    top) moved into `FindCommitsOverlay.css` unchanged, so this is a "same CSS rules still apply
 *    in the new markup" smoke check (AC12's own wording), not a from-scratch re-derivation: only
 *    the two selectors that used to open FilterBar's now-retired "Search & filter"/"More filters"
 *    disclosures were updated to open the overlay instead (a single toolbar-button click — every
 *    field, including From/To, is already flat/visible once it's open, FR-260).
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
  scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "githydra-pw-find-commits-"));
});

test.afterEach(async () => {
  await closeApp(handle);
  await removeUserDataDir(handle.userDataDir);
  if (repoDir) await cleanup(repoDir);
  await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => {});
});

test("AC1: no permanent filter row is reserved above the commit graph — the toolbar sits flush against the graph before the overlay is ever opened", async () => {
  repoDir = await initRepo();
  await writeFile(repoDir, "a.txt", "base\n");
  await commitAll(repoDir, "First commit");

  await stubOpenRepoDialog(handle.app, repoDir);
  await handle.window.getByRole("button", { name: "Open a repository", exact: true }).click();
  await handle.window.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });

  // The "Find commits" trigger itself must be present (FR-258)...
  await expect(handle.window.getByRole("button", { name: "Find commits" })).toBeVisible();
  // ...but nothing FilterBar-shaped (its collapsed row, its disclosure toggle, any of its fields)
  // is anywhere in the DOM before the overlay is opened.
  await expect(handle.window.getByRole("search", { name: /find commits/i })).toHaveCount(0);
  await expect(handle.window.getByRole("button", { name: /search & filter/i })).toHaveCount(0);

  const toolbarBox = await handle.window.locator(".gh-toolbar").boundingBox();
  const graphBox = await handle.window.getByRole("listbox", { name: /commit graph/i }).boundingBox();
  expect(toolbarBox).not.toBeNull();
  expect(graphBox).not.toBeNull();
  // The commit graph's top edge sits directly against the toolbar's bottom edge — no reserved
  // filter-row strip in between (the historical `gh-filter-bar-collapsed-row`'s `min-height: 44px`
  // this feature removed).
  expect(graphBox!.y).toBeCloseTo(toolbarBox!.y + toolbarBox!.height, 0);
});

test("AC12: From date input's calendar-picker icon renders in muted ink, not default black, at rest inside the overlay", async () => {
  repoDir = await initRepo();
  await writeFile(repoDir, "a.txt", "base\n");
  await commitAll(repoDir, "First commit");

  await stubOpenRepoDialog(handle.app, repoDir);
  await handle.window.getByRole("button", { name: "Open a repository", exact: true }).click();
  await handle.window.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });

  await handle.window.getByRole("button", { name: "Find commits" }).click();

  const fromInput = handle.window.getByLabel(/^from$/i);
  await fromInput.waitFor();

  // Move the mouse away first so we capture the icon's at-rest color, not its hover/focus accent
  // swap (FindCommitsOverlay.css's own `:hover`/`:focus` rule, carried over from FilterBar.css
  // unchanged and out of scope here).
  await handle.window.mouse.move(0, 0);

  const shotPath = path.join(scratchDir, "from-input.png");
  await fromInput.screenshot({ path: shotPath });
  const img = decodePng(shotPath);

  // The placeholder's empty "dd"/"yyyy" segments still render in the muted-ink token.
  const mutedInkPixels = countPixelsNearColor(img, "898781", 4);
  expect(mutedInkPixels).toBeGreaterThan(0);

  // The calendar-picker icon must NOT render in default browser black — confirms the
  // hide-native/layer-a-real-icon fix (FR-253/255) still applies verbatim in the new markup.
  const pureBlackPixels = countPixelsNearColor(img, "000000", 0);
  expect(pureBlackPixels).toBe(0);
});
