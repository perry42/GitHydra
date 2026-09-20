// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * test-agent verification: real Electron/real-git coverage for the toolbar-action-row redesign
 * (feat/toolbar-action-row) — the implementing agent's own unit/component suites (Toolbar.test.tsx,
 * ContextMenu.test.tsx) cover the same claims against jsdom; this suite is the "does it actually
 * render/behave this way in a real BrowserWindow against a real repo" half, per this project's
 * established `e2e-playwright/electron/*` convention (see `fetch.spec.ts`/`manualRefresh.spec.ts`).
 *
 * Fixture: a real bare remote `origin`, a real second remote `fork` (no tracking relationship —
 * exists purely so `showPushRemotePicker`'s ">1 remote" gate is genuinely true), and a local clone
 * whose `main` ends up 2 ahead / 3 behind its `origin/main` upstream after a real `git fetch`
 * (driven through the real Fetch button, not a shell-out from this test) — the same "genuine
 * divergence" shape `fetch.spec.ts` already established, just with distinct ahead/behind counts so
 * a pill-swap bug (ahead value landing on Pull's pill or vice versa) would be caught.
 */
import { test, expect } from "@playwright/test";
import {
  closeApp,
  launchGitHydra,
  openRepoThroughRealUi,
  removeUserDataDir,
  type LaunchedApp,
} from "../helpers/launchApp";
import { cleanup, commitAll, git, initRepo, writeFile } from "../../src/test/gitFixture";

let handle: LaunchedApp;
let localDir: string;
let bareDir: string;
let forkBareDir: string;
let otherCloneDir: string;

test.afterEach(async () => {
  await closeApp(handle);
  await removeUserDataDir(handle.userDataDir);
  if (localDir) await cleanup(localDir);
  if (bareDir) await cleanup(bareDir);
  if (forkBareDir) await cleanup(forkBareDir);
  if (otherCloneDir) await cleanup(otherCloneDir);
});

/** Builds the ahead-2/behind-3/multi-remote fixture and opens it in the real app, real Fetch
 * clicked so the divergence is actually known (ahead/behind read remote-tracking refs, which only
 * a real fetch updates). `branchName` defaults to `"main"` (every pre-existing call site's real
 * behavior, unchanged); a caller can pass a long, realistic branch name instead to exercise the
 * branch chip's own width — see the 880px-floor overflow test below, the one caller that does. */
async function openDivergedMultiRemoteRepo(branchName = "main"): Promise<void> {
  bareDir = await initRepo({ bare: true });
  forkBareDir = await initRepo({ bare: true });

  localDir = await initRepo();
  await writeFile(localDir, "a.txt", "base\n");
  await commitAll(localDir, "base commit");
  await git(localDir, ["remote", "add", "origin", bareDir]);
  await git(localDir, ["remote", "add", "fork", forkBareDir]);
  if (branchName !== "main") await git(localDir, ["branch", "-m", "main", branchName]);
  await git(localDir, ["push", "-q", "-u", "origin", branchName]);

  // A teammate pushes 3 commits to origin that `local` doesn't have yet.
  otherCloneDir = await initRepo();
  await git(otherCloneDir, ["remote", "add", "origin", bareDir]);
  await git(otherCloneDir, ["fetch", "-q", "origin"]);
  await git(otherCloneDir, ["checkout", "-q", "-b", branchName, `origin/${branchName}`]);
  for (let i = 1; i <= 3; i++) {
    await writeFile(otherCloneDir, `teammate-${i}.txt`, `commit ${i}\n`);
    await commitAll(otherCloneDir, `Teammate commit ${i}`);
  }
  await git(otherCloneDir, ["push", "-q", "origin", branchName]);

  // `local` makes 2 of its own unpushed commits.
  for (let i = 1; i <= 2; i++) {
    await writeFile(localDir, `local-${i}.txt`, "not pushed\n");
    await commitAll(localDir, `Local commit ${i}`);
  }

  handle = await launchGitHydra();
  await openRepoThroughRealUi(handle, localDir);

  const fetchButton = handle.window.getByRole("button", { name: /^fetch all remotes$/i });
  await fetchButton.click();
  // Wait for the fetch outcome banner, then dismiss it so it doesn't obscure the toolbar.
  await expect(handle.window.getByText(/origin: fetched successfully/i)).toBeVisible({ timeout: 15_000 });
  const dismiss = handle.window.getByRole("button", { name: /^dismiss$/i });
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click();
}

test.describe("toolbar-action-row redesign — real app verification", () => {
  test("three-tier layout: exactly two divider hairlines, in local-tools / sync / settings order", async () => {
    localDir = await initRepo();
    await writeFile(localDir, "a.txt", "base\n");
    await commitAll(localDir, "base commit");

    handle = await launchGitHydra();
    await openRepoThroughRealUi(handle, localDir);

    const actions = handle.window.locator(".gh-toolbar__actions");
    const dividers = actions.locator("> .gh-toolbar__divider");
    await expect(dividers).toHaveCount(2);

    // Cluster 1 (local tools) precedes divider 1, which precedes the sync cluster, which precedes
    // divider 2, which precedes the settings cluster — asserted via each element's real x-position
    // rather than DOM order alone (a `flex-direction` regression could reorder visually without
    // reordering the DOM).
    const toggles = handle.window.locator(".gh-toolbar__group--toggles");
    const syncCluster = handle.window.locator(".gh-sync-cluster");
    const settings = handle.window.locator(".gh-toolbar__group--settings");
    const togglesBox = await toggles.boundingBox();
    const syncBox = await syncCluster.boundingBox();
    const settingsBox = await settings.boundingBox();
    expect(togglesBox).not.toBeNull();
    expect(syncBox).not.toBeNull();
    expect(settingsBox).not.toBeNull();
    expect(togglesBox!.x).toBeLessThan(syncBox!.x);
    expect(syncBox!.x).toBeLessThan(settingsBox!.x);

    // This fixture has no remote configured at all, so Pull/Push render disabled with a reason
    // folded into their accessible NAME (e.g. "Pull (no configured upstream)") — matched via
    // `aria-label` (a negative lookahead excludes the "Pull strategy options"/"Push remote options"
    // caret buttons, which also start with the same word) rather than visible text content: see
    // this file's own dedicated, currently-RED "width shedding must not collapse..." test for the
    // separate, already-flagged bug that the visible text label is empty even at a comfortably wide
    // window — this assertion intentionally doesn't re-depend on that being fixed.
    await expect(handle.window.getByRole("button", { name: /^fetch all remotes$/i })).toBeVisible();
    await expect(handle.window.getByRole("button", { name: /^pull(?! strategy)/i })).toBeVisible({
      timeout: 20_000,
    });
    await expect(handle.window.getByRole("button", { name: /^push(?! remote)/i })).toBeVisible({
      timeout: 20_000,
    });
    await expect(handle.window.getByRole("button", { name: "Find commits" })).toBeVisible();
    await expect(handle.window.getByRole("button", { name: /^refresh commit graph$/i })).toBeVisible();
    // Identity renders EITHER as its own standalone button OR folded into "⋯" (see this file's own
    // dedicated, currently-RED width-shedding test — a real app launch already folds it in even at
    // a comfortably wide window, which that test tracks as its own separate finding). Accepting
    // either form here keeps this layout-structure test from failing for that already-documented
    // reason.
    const identityStandalone = handle.window.getByRole("button", { name: "Git identity profiles" });
    const moreButton = handle.window.getByRole("button", { name: "More actions" });
    await expect(moreButton).toBeVisible();
    const identityFoldedIn = (await identityStandalone.count()) === 0;
    if (!identityFoldedIn) await expect(identityStandalone).toBeVisible();

    await handle.window.screenshot({ path: "test-results/toolbar-three-tier-layout.png" });
  });

  test("zero ahead/behind: no pills, no directional icon, plain accessible names", async () => {
    localDir = await initRepo();
    await writeFile(localDir, "a.txt", "base\n");
    await commitAll(localDir, "base commit");
    bareDir = await initRepo({ bare: true });
    await git(localDir, ["remote", "add", "origin", bareDir]);
    await git(localDir, ["push", "-q", "-u", "origin", "main"]);

    handle = await launchGitHydra();
    await openRepoThroughRealUi(handle, localDir);

    const pullButton = handle.window.getByRole("button", { name: /^pull($| —)/i });
    await expect(pullButton).toHaveAccessibleName(/^pull$/i);
    const pushButton = handle.window.getByRole("button", { name: /^push($| —)/i });
    await expect(pushButton).toHaveAccessibleName(/^push$/i);

    // No pill text and no directional-arrow svg child inside either button at zero count.
    await expect(pullButton.locator(".gh-sync-pill")).toHaveCount(0);
    await expect(pushButton.locator(".gh-sync-pill")).toHaveCount(0);
    await expect(pullButton.locator("svg")).toHaveCount(0);
    await expect(pushButton.locator("svg")).toHaveCount(0);

    const syncCluster = handle.window.locator(".gh-sync-cluster");
    await expect(syncCluster).not.toHaveClass(/diverged/);
  });

  test("ahead/behind honesty: correct counts, warning treatment on diverged pills+border, freshness caveat in accessible name", async () => {
    await openDivergedMultiRemoteRepo();

    const pullButton = handle.window.getByRole("button", { name: /^pull —/i });
    const pushButton = handle.window.getByRole("button", { name: /^push —/i });
    await expect(pullButton).toBeVisible();
    await expect(pushButton).toBeVisible();

    // Real counts land on the right button — a swapped-pill bug (ahead on Pull, behind on Push)
    // would fail these two independently.
    await expect(pullButton.locator(".gh-sync-pill")).toHaveText("3");
    await expect(pushButton.locator(".gh-sync-pill")).toHaveText("2");

    // Both are true divergence pills, so both get the warning treatment.
    await expect(pullButton.locator(".gh-sync-pill")).toHaveClass(/warning/);
    await expect(pushButton.locator(".gh-sync-pill")).toHaveClass(/warning/);
    await expect(handle.window.locator(".gh-sync-cluster")).toHaveClass(/diverged/);

    // Accessible name states real numbers, the word "diverged", and a freshness caveat — never
    // implying a live number.
    const pullName = (await pullButton.getAttribute("aria-label")) ?? "";
    const pushName = (await pushButton.getAttribute("aria-label")) ?? "";
    expect(pullName).toMatch(/diverged/i);
    expect(pullName).toMatch(/3 commits behind/i);
    expect(pullName).toMatch(/2 commits ahead/i);
    expect(pullName).toMatch(/(just now|\d+ seconds? ago|fetched)/i);
    expect(pushName).toMatch(/diverged/i);
    expect(pushName).toMatch(/(just now|\d+ seconds? ago|fetched)/i);

    await handle.window.screenshot({ path: "test-results/toolbar-diverged-sync-cluster.png" });
  });

  test("Fetch's glyph sits on a dashed track with no dot; Pull's sits on a solid track with a filled dot", async () => {
    localDir = await initRepo();
    await writeFile(localDir, "a.txt", "base\n");
    await commitAll(localDir, "base commit");
    bareDir = await initRepo({ bare: true });
    await git(localDir, ["remote", "add", "origin", bareDir]);
    await git(localDir, ["push", "-q", "-u", "origin", "main"]);
    // Give Pull an icon to inspect too (icons only render once busy or a non-zero behind count).
    otherCloneDir = await initRepo();
    await git(otherCloneDir, ["remote", "add", "origin", bareDir]);
    await git(otherCloneDir, ["fetch", "-q", "origin"]);
    await git(otherCloneDir, ["checkout", "-q", "-b", "main", "origin/main"]);
    await writeFile(otherCloneDir, "t.txt", "x\n");
    await commitAll(otherCloneDir, "teammate commit");
    await git(otherCloneDir, ["push", "-q", "origin", "main"]);

    handle = await launchGitHydra();
    await openRepoThroughRealUi(handle, localDir);
    await handle.window.getByRole("button", { name: /^fetch all remotes$/i }).click();
    await expect(handle.window.getByText(/origin: fetched successfully/i)).toBeVisible({ timeout: 15_000 });

    const fetchSvg = handle.window.getByRole("button", { name: /^fetch all remotes$/i }).locator("svg");
    const pullSvg = handle.window.getByRole("button", { name: /^pull —/i }).locator("svg");
    await expect(fetchSvg).toBeVisible();
    await expect(pullSvg).toBeVisible();

    // Fetch: no filled circle (no "commit dot") anywhere in its glyph.
    await expect(fetchSvg.locator("circle")).toHaveCount(0);
    // Pull: exactly one filled circle — the commit dot landing on the solid lane.
    const pullCircle = pullSvg.locator("circle");
    await expect(pullCircle).toHaveCount(1);
    await expect(pullCircle).toHaveAttribute("fill", "currentColor");

    // Fetch's own track is drawn from multiple short dash segments (3 separate horizontal
    // sub-paths), not one continuous line — the dashed-vs-solid distinction the redesign claims.
    const fetchPathCount = await fetchSvg.locator("path").count();
    expect(fetchPathCount).toBeGreaterThanOrEqual(3);

    await handle.window.screenshot({ path: "test-results/toolbar-fetch-vs-pull-glyphs.png" });
  });

  test("Pull's split menu: keyboard-only open/navigate/close, checked item (Auto) focused on open, Merge/Rebase selectable", async () => {
    await openDivergedMultiRemoteRepo();

    const caret = handle.window.getByRole("button", { name: "Pull strategy options" });
    await caret.focus();
    await expect(caret).toBeFocused();
    await handle.window.keyboard.press("Enter");

    const menu = handle.window.getByRole("menu", { name: /strategy for this pull/i });
    await expect(menu).toBeVisible();
    const auto = handle.window.getByRole("menuitemradio", { name: "Auto" });
    const merge = handle.window.getByRole("menuitemradio", { name: "Merge" });
    const rebase = handle.window.getByRole("menuitemradio", { name: "Rebase" });
    await expect(auto).toHaveAttribute("aria-checked", "true");
    // The currently-checked item is focused on open, not just the first item in DOM order.
    await expect(auto).toBeFocused();

    await handle.window.keyboard.press("ArrowDown");
    await expect(merge).toBeFocused();
    await handle.window.keyboard.press("ArrowDown");
    await expect(rebase).toBeFocused();
    await handle.window.keyboard.press("End");
    await expect(rebase).toBeFocused();
    await handle.window.keyboard.press("Home");
    await expect(auto).toBeFocused();

    await handle.window.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    // Escape returns focus to the caret that opened it.
    await expect(caret).toBeFocused();

    // Re-open and actually pick "Merge" by keyboard — confirms the menu is fully keyboard-operable,
    // not just navigable.
    await handle.window.keyboard.press("Enter");
    await expect(handle.window.getByRole("menu", { name: /strategy for this pull/i })).toBeVisible();
    await handle.window.keyboard.press("ArrowDown");
    await handle.window.keyboard.press("Enter");
    await expect(handle.window.getByRole("menu", { name: /strategy for this pull/i })).toHaveCount(0);
  });

  test("Push's split menu: keyboard-only open/navigate/close, lists remotes only because >1 is configured, checked item (origin) focused on open", async () => {
    await openDivergedMultiRemoteRepo();

    const caret = handle.window.getByRole("button", { name: "Push remote options" });
    await caret.focus();
    await handle.window.keyboard.press(" ");

    const menu = handle.window.getByRole("menu", { name: /push to/i });
    await expect(menu).toBeVisible();
    const origin = handle.window.getByRole("menuitemradio", { name: "origin" });
    const fork = handle.window.getByRole("menuitemradio", { name: "fork" });
    await expect(origin).toHaveAttribute("aria-checked", "true");
    await expect(origin).toBeFocused();

    await handle.window.keyboard.press("ArrowDown");
    await expect(fork).toBeFocused();
    await handle.window.keyboard.press("ArrowUp");
    await expect(origin).toBeFocused();

    await handle.window.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(caret).toBeFocused();
  });

  test("Push's remote caret is reserved (present but non-interactive) on a single-remote repo — no menu to open", async () => {
    localDir = await initRepo();
    await writeFile(localDir, "a.txt", "base\n");
    await commitAll(localDir, "base commit");
    bareDir = await initRepo({ bare: true });
    await git(localDir, ["remote", "add", "origin", bareDir]);
    await git(localDir, ["push", "-q", "-u", "origin", "main"]);

    handle = await launchGitHydra();
    await openRepoThroughRealUi(handle, localDir);

    await expect(handle.window.getByRole("button", { name: "Push remote options" })).toHaveCount(0);
    // By design (`.gh-sync-cluster__caret--reserved { visibility: hidden }`, Toolbar.css) this
    // placeholder is genuinely CSS-invisible — it exists purely to reserve the interactive caret's
    // width so the cluster's geometry doesn't shift between a one-remote and multi-remote repo, not
    // to be seen or focused. Confirmed present-but-inert here, not visible.
    const reserved = handle.window.locator(".gh-sync-cluster__caret--reserved");
    await expect(reserved).toHaveCount(1);
    await expect(reserved).toHaveCSS("visibility", "hidden");
    await expect(reserved).not.toBeVisible();
  });

  test("adaptive Stashes chip: ghost icon at zero stashes, promotes to a labeled+badge chip once a real stash exists", async () => {
    localDir = await initRepo();
    await writeFile(localDir, "a.txt", "base\n");
    await commitAll(localDir, "base commit");

    handle = await launchGitHydra();
    await openRepoThroughRealUi(handle, localDir);

    // Zero-stash form: icon-only ghost button, accessible name has no count.
    const stashGhost = handle.window.getByRole("button", { name: "Stashes" });
    await expect(stashGhost).toHaveClass(/gh-toolbar__icon-button/);
    await expect(stashGhost.locator("span.gh-toolbar__badge")).toHaveCount(0);

    // Create a real stash through the live UI (not a shelled-out `git stash`).
    await writeFile(localDir, "a.txt", "changed\n");
    // Drive a manual Refresh rather than trusting the real fs watcher's own (unspecified-here)
    // debounce window — Refresh always re-reads status synchronously with the click, so this is
    // the deterministic way to guarantee "New Stash…" is enabled once clicked, not a race.
    await handle.window.getByRole("button", { name: /^refresh commit graph$/i }).click();
    await expect(handle.window.getByRole("button", { name: /^changes, \d+ pending$/i })).toBeVisible({
      timeout: 15_000,
    });
    const changesToggle = handle.window.getByRole("button", { name: /^changes/i });
    await changesToggle.click();
    const newStashButton = handle.window.getByRole("button", { name: "New Stash…" });
    await expect(newStashButton).toBeEnabled({ timeout: 15_000 });
    await newStashButton.click();

    const dialog = handle.window.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: /create stash/i }).click();
    await expect(dialog).toHaveCount(0, { timeout: 15_000 });

    // Real on-disk proof: a real stash now exists, independent of what the UI claims.
    const { stdout } = await git(localDir, ["stash", "list"]);
    expect(stdout.trim().length).toBeGreaterThan(0);

    // Promoted form: labeled chip with a "1" badge, same toggle semantics.
    const stashChip = handle.window.getByRole("button", { name: /^stashes, 1$/i });
    await expect(stashChip).toBeVisible();
    await expect(stashChip.locator(".gh-toolbar__badge")).toHaveText("1");
    await expect(stashChip).not.toHaveClass(/gh-toolbar__icon-button(?!\S)/);

    await handle.window.screenshot({ path: "test-results/toolbar-stash-chip-promoted.png" });
  });

  test("the '...' overflow menu: contains the theme toggle and Keyboard shortcuts, and both genuinely work", async () => {
    localDir = await initRepo();
    await writeFile(localDir, "a.txt", "base\n");
    await commitAll(localDir, "base commit");

    handle = await launchGitHydra();
    await openRepoThroughRealUi(handle, localDir);

    const themeBefore = await handle.window.evaluate(() => document.documentElement.dataset.theme);

    await handle.window.getByRole("button", { name: "More actions" }).click();
    const menu = handle.window.getByRole("menu", { name: /more actions/i });
    await expect(menu).toBeVisible();
    const themeItem = menu.getByRole("menuitem", { name: /switch to (dark|light) theme/i });
    await expect(themeItem).toBeVisible();
    const shortcutsItem = menu.getByRole("menuitem", { name: /keyboard shortcuts/i });
    await expect(shortcutsItem).toBeVisible();

    await themeItem.click();
    await expect(async () => {
      const themeAfter = await handle.window.evaluate(() => document.documentElement.dataset.theme);
      expect(themeAfter).not.toBe(themeBefore);
    }).toPass({ timeout: 5_000 });

    await handle.window.getByRole("button", { name: "More actions" }).click();
    await handle.window.getByRole("menuitem", { name: /keyboard shortcuts/i }).click();
    await expect(handle.window.getByRole("dialog", { name: /keyboard shortcuts/i })).toBeVisible();
  });

  // test-agent finding (severity: functional/visual, not data-loss/security): the width-shedding
  // `ResizeObserver` in `Toolbar.tsx` watches `.gh-toolbar__actions` itself — an element with
  // `flex: none` (no shrink) whose OWN rendered width already depends on `shedLevel`, the very
  // state that observer sets. That's a self-referential measurement target: any full-label natural
  // width that happens to sit under the widest (760px) threshold trips a shed level, which removes
  // DOM content, which shrinks the observed element further, which computes an even higher shed
  // level next callback — collapsing all the way to the maximally-shed state with no correction,
  // regardless of how much room is genuinely free elsewhere in the header (the repo-path label
  // happily absorbs any slack via its own `flex: 1`). Reproduced here at the app's own natural
  // launch size (~1300px inner width, a comfortably wide window, zero manual resizing) — plenty of
  // room exists (confirmed via `.gh-toolbar__repo-path`'s own rendered width in this same state),
  // yet Pull/Push already render with no visible text label and Identity is already folded into
  // the "⋯" menu. This is currently RED — left in place as the reproduction for whoever fixes it
  // (Toolbar.tsx/its ResizeObserver target and thresholds are ui-graphics's file, out of this
  // agent's edit scope). Recommended direction, not just new numbers: observe something that
  // reflects genuinely AVAILABLE space (e.g. the `.gh-toolbar` header's own width, or whether
  // `.gh-toolbar__repo-path` has been compressed to some minimum) rather than the shrinking-on-
  // shed element itself — new threshold constants alone won't fix a target that shrinks in
  // response to its own measurement.
  test("width shedding must not collapse to its most-shed state on a comfortably wide window with nothing crowding it", async () => {
    localDir = await initRepo();
    await writeFile(localDir, "a.txt", "base\n");
    await commitAll(localDir, "base commit");

    handle = await launchGitHydra();
    await openRepoThroughRealUi(handle, localDir);
    // A short repo path (the fixture's own temp-dir name) leaves the header's `flex: 1` repo-path
    // slot far under its available space — genuinely nothing crowds the actions row here.
    await handle.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]!;
      win.setSize(1400, 800);
    });
    await handle.window.waitForTimeout(300);

    const repoPathWidth = await handle.window.locator(".gh-toolbar__repo-path").evaluate((el) => el.getBoundingClientRect().width);
    // Sanity check on the repro's own premise: the repo path must actually have slack (proving the
    // window is genuinely not crowded) before the assertions below mean anything.
    expect(repoPathWidth).toBeGreaterThan(200);

    // Whatever the exact fixture-dependent accessible name, the visible "Pull" text label should
    // render at this width — it currently does not (the row is already fully shed).
    await expect(handle.window.locator(".gh-sync-cluster__segment", { hasText: "Pull" })).toContainText("Pull");
    await expect(handle.window.getByRole("button", { name: "Git identity profiles" })).toBeVisible();
  });

  test("width shedding sweep: reports the real shed order and thresholds across the full window-width range", async () => {
    await openDivergedMultiRemoteRepo();

    const actions = handle.window.locator(".gh-toolbar__actions");
    const header = handle.window.locator(".gh-toolbar");

    // Sweep from a comfortably wide window down to a narrow one, recording real measurements at
    // each width — this is a diagnostic sweep (reported in prose, not asserted pass/fail per step)
    // since the agent that built this flagged the five thresholds as an untuned first pass.
    const widths = [1400, 1100, 900, 820, 760, 700, 660, 620, 580, 540, 500, 460, 420, 380];
    const results: Record<string, unknown>[] = [];
    for (const width of widths) {
      await handle.app.evaluate(({ BrowserWindow }, w) => {
        const win = BrowserWindow.getAllWindows()[0]!;
        const [, height] = win.getSize();
        win.setSize(w, height);
      }, width);
      // Let layout/ResizeObserver settle.
      await handle.window.waitForTimeout(150);

      const actionsBox = await actions.boundingBox();
      const headerBox = await header.boundingBox();
      const headerScrollWidth = await header.evaluate((el) => el.scrollWidth);
      const headerClientWidth = await header.evaluate((el) => el.clientWidth);
      const stashHasLabel = await handle.window
        .getByRole("button", { name: /^stashes/i })
        .evaluate((el) => el.textContent?.includes("Stashes") ?? false)
        .catch(() => null);
      const changesHasLabel = await handle.window
        .getByRole("button", { name: /^changes/i })
        .evaluate((el) => el.textContent?.includes("Changes") ?? false)
        .catch(() => null);
      const branchesHasLabel = await handle.window
        .locator(".gh-toolbar__branch")
        .evaluate((el) => el.querySelector("span.gh-mono") !== null)
        .catch(() => null);
      const pullHasLabel = await handle.window
        .getByRole("button", { name: /^pull —/i })
        .evaluate((el) => /pull/i.test(el.textContent ?? ""))
        .catch(() => null);
      const pullPillVisible = await handle.window
        .getByRole("button", { name: /^pull —/i })
        .locator(".gh-sync-pill")
        .isVisible()
        .catch(() => null);
      const identityStandaloneVisible = await handle.window
        .getByRole("button", { name: "Git identity profiles" })
        .isVisible()
        .catch(() => false);
      const syncClusterWraps = await handle.window
        .locator(".gh-sync-cluster")
        .evaluate((el) => el.getBoundingClientRect().height > 30)
        .catch(() => null);

      results.push({
        width,
        actionsWidth: actionsBox?.width ?? null,
        headerOverflows: headerScrollWidth > headerClientWidth + 1,
        stashHasLabel,
        changesHasLabel,
        branchesHasLabel,
        pullHasLabel,
        pullPillVisible,
        identityStandaloneVisible,
        syncClusterWraps,
      });
    }

    // Always-true invariants, actually asserted (not just reported): the count pill must survive
    // every width tested (it's the one thing the redesign promises never sheds), and the sync
    // cluster must never wrap into a second visual row.
    for (const r of results) {
      if (r.pullPillVisible === true || r.pullPillVisible === false) {
        expect(r.pullPillVisible, `pull pill must stay visible at width=${r.width}`).toBe(true);
      }
      if (typeof r.syncClusterWraps === "boolean") {
        expect(r.syncClusterWraps, `sync cluster must not wrap at width=${r.width}`).toBe(false);
      }
    }

    // eslint-disable-next-line no-console
    console.log("WIDTH SHEDDING SWEEP RESULTS:\n" + JSON.stringify(results, null, 2));

    await handle.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1400, 900));
    await handle.window.waitForTimeout(150);
    await handle.window.screenshot({ path: "test-results/toolbar-width-1400.png" });
    for (const w of [700, 500, 380]) {
      await handle.app.evaluate(({ BrowserWindow }, ww) => {
        const win = BrowserWindow.getAllWindows()[0]!;
        const [, height] = win.getSize();
        win.setSize(ww, height);
      }, w);
      await handle.window.waitForTimeout(150);
      await handle.window.screenshot({ path: `test-results/toolbar-width-${w}.png` });
    }
  });

  // width-shedding fix: the case none of the coverage above pins — the app's own enforced 880px
  // window floor (`electron/windowBounds.ts`'s `MIN_WIDTH`), combined with the single largest
  // variable-width contributor to the row (a long branch name), which is exactly the combination
  // that motivated re-deriving every threshold from real measurement rather than guesses.
  test("880px floor + a long branch name: the action row genuinely does not overflow or wrap", async () => {
    const longBranch = "feature/redesign-onboarding-flow-v2"; // 36 chars — the same worst-case
    // length the real threshold re-derivation was measured against.
    await openDivergedMultiRemoteRepo(longBranch);

    await handle.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(880, 900));
    await handle.window.waitForTimeout(300);

    const header = handle.window.locator(".gh-toolbar");
    const scrollWidth = await header.evaluate((el) => el.scrollWidth);
    const clientWidth = await header.evaluate((el) => el.clientWidth);
    expect(scrollWidth, "header must not overflow its own client width at the 880px floor").toBeLessThanOrEqual(
      clientWidth + 1,
    );

    // No second visual row anywhere — a wrapped sync cluster or actions group would be the other
    // way this could visually break even without a horizontal-scrollbar-triggering overflow.
    const headerHeight = await header.evaluate((el) => el.getBoundingClientRect().height);
    expect(headerHeight, "header must stay a single row at the 880px floor").toBeLessThanOrEqual(48);

    // The ahead/behind count pills survive even the most-shed state reachable here — the one
    // invariant that must never shed at any width.
    await expect(handle.window.getByRole("button", { name: /^pull —/i }).locator(".gh-sync-pill")).toBeVisible();
    await expect(handle.window.getByRole("button", { name: /^push —/i }).locator(".gh-sync-pill")).toBeVisible();

    // The branch chip is genuinely capped (not just visually truncated by accident) — its rendered
    // width stays well under the full, uncapped label's own natural width — and the full name is
    // still recoverable via a real `title` attribute, independent of whatever ellipsis renders.
    const branchButton = handle.window.locator(".gh-toolbar__branch");
    const branchWidth = await branchButton.evaluate((el) => el.getBoundingClientRect().width);
    expect(branchWidth, "branch chip must stay capped, not render the full 36-char name unbounded").toBeLessThan(230);
    await expect(branchButton).toHaveAttribute("title", new RegExp(longBranch.replace(/[/.]/g, "\\$&")));
    await expect(branchButton).toHaveAttribute("aria-label", new RegExp(longBranch.replace(/[/.]/g, "\\$&")));

    await handle.window.screenshot({ path: "test-results/toolbar-880-floor-long-branch.png" });
  });

  test("dark theme: three-tier layout and diverged sync cluster both render correctly", async () => {
    await openDivergedMultiRemoteRepo();

    await handle.window.getByRole("button", { name: "More actions" }).click();
    const themeItem = handle.window.getByRole("menuitem", { name: /switch to (dark|light) theme/i });
    const willBeDark = (await themeItem.textContent())?.toLowerCase().includes("dark theme");
    await themeItem.click();
    await expect(async () => {
      const theme = await handle.window.evaluate(() => document.documentElement.dataset.theme);
      expect(theme).toBe(willBeDark ? "dark" : "light");
    }).toPass({ timeout: 5_000 });

    const dividers = handle.window.locator(".gh-toolbar__actions > .gh-toolbar__divider");
    await expect(dividers).toHaveCount(2);
    await expect(handle.window.locator(".gh-sync-cluster")).toHaveClass(/diverged/);
    await expect(handle.window.getByRole("button", { name: /^pull —/i }).locator(".gh-sync-pill")).toHaveClass(
      /warning/,
    );

    await handle.window.screenshot({ path: "test-results/toolbar-dark-theme-diverged.png" });
  });
});
