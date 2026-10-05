// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Real-Electron verification of the "Drag-to-merge: unverified corners" list from ROADMAP.md
 * (specs/branch-panel-drag-merge.md FR-418..439): lane colors other than blue, the light theme, a
 * dirty-tree checkout refusal, a conflicting merge reached through a real drag, detached HEAD
 * (FR-430), a card whose branch has no rendered chip (FR-432), a search filter (FR-433), and the
 * palette picker's behavior in bare-repo / in-progress states (FR-437).
 *
 * Every test uses REAL pointer events on a real BrowserWindow (jsdom's stubbed `elementFromPoint`
 * can't prove any of this) and saves screenshots under `.tmp-critique-screenshots/drag-merge-corners/`
 * (git-ignored) — class-name assertions alone are not proof for visual states.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { closeApp, launchGitHydra, removeUserDataDir, stubOpenRepoDialog, type LaunchedApp } from "../helpers/launchApp";
import { cleanup, commitAll, git, initRepo, writeFile } from "../../src/test/gitFixture";

const SHOT_DIR = path.join(process.cwd(), ".tmp-critique-screenshots", "drag-merge-corners");

let handle: LaunchedApp;
let repoDir: string;

test.beforeEach(async () => {
  await fs.mkdir(SHOT_DIR, { recursive: true });
  handle = await launchGitHydra();
  repoDir = "";
});
test.afterEach(async () => {
  await closeApp(handle);
  await removeUserDataDir(handle.userDataDir);
  if (repoDir) await cleanup(repoDir);
});

async function shot(name: string, target?: Locator): Promise<void> {
  const file = path.join(SHOT_DIR, `${name}.png`);
  if (target) await target.screenshot({ path: file });
  else await handle.window.screenshot({ path: file });
}

async function openRepo(theme: "dark" | "light" = "dark"): Promise<Page> {
  const w = handle.window;
  await w.evaluate((t) => window.localStorage.setItem("githydra:theme", t), theme);
  await w.reload();
  await w.waitForLoadState("domcontentloaded");
  await stubOpenRepoDialog(handle.app, repoDir);
  await w.getByRole("button", { name: "Open a repository", exact: true }).click();
  await w.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });
  await expect(w.locator("html")).toHaveAttribute("data-theme", theme);
  return w;
}

/** base commit on main + one sibling branch per name, each with its own commit (parallel lanes). */
async function buildMultiLaneRepo(branches: string[]): Promise<void> {
  repoDir = await initRepo();
  await writeFile(repoDir, "a.txt", "base\n");
  await commitAll(repoDir, "Base commit");
  for (const b of branches) {
    await git(repoDir, ["checkout", "-q", "-b", b, "main"]);
    await writeFile(repoDir, `${b}.txt`, `${b}\n`);
    await commitAll(repoDir, `Commit on ${b}`);
  }
  await git(repoDir, ["checkout", "-q", "main"]);
  await writeFile(repoDir, "main.txt", "main\n");
  await commitAll(repoDir, "Commit on main");
}

const card = (w: Page, name: string) => w.locator(`li[data-ref-branch="${name}"]`);
const chip = (w: Page, name: string) => w.locator(`.gh-commit-row__refgutter [data-ref-branch="${name}"]`).first();

async function center(loc: Locator) {
  const b = (await loc.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
/** Pointer-down on a card's own padding (never Checkout/Delete) and pass the drag threshold. */
async function pickUpCard(w: Page, name: string) {
  const b = (await card(w, name).boundingBox())!;
  const x = b.x + 6;
  const y = b.y + 5;
  await w.mouse.move(x, y);
  await w.mouse.down();
  await w.mouse.move(x + 12, y + 12, { steps: 3 });
}
async function pickUpChip(w: Page, name: string) {
  const c = await center(chip(w, name));
  await w.mouse.move(c.x, c.y);
  await w.mouse.down();
  await w.mouse.move(c.x + 10, c.y + 10, { steps: 3 });
}
async function moveTo(w: Page, p: { x: number; y: number }) {
  await w.mouse.move(p.x, p.y, { steps: 8 });
}
async function cardPad(w: Page, name: string) {
  const b = (await card(w, name).boundingBox())!;
  return { x: b.x + 6, y: b.y + 5 };
}
const cursorNow = (w: Page) => w.evaluate(() => document.body.style.cursor);

for (const theme of ["dark", "light"] as const) {
  test.describe(`${theme} theme`, () => {
    test(`[${theme}] drop-target ring/wash on chips of several lane colors, self-drop reject has a non-color cue`, async () => {
      await buildMultiLaneRepo(["lane1", "lane2", "lane3", "lane4", "lane5"]);
      const w = await openRepo(theme);
      // Every branch tip sits in its own lane, so each chip carries a different lane color.
      const lanes = ["main", "lane1", "lane2", "lane3", "lane4", "lane5"];
      const colors = new Set<string>();
      for (const n of lanes) {
        const bg = await chip(w, n).evaluate((el) => getComputedStyle(el).backgroundColor);
        colors.add(bg);
      }
      expect(colors.size, "chips should span several distinct lane colors").toBeGreaterThanOrEqual(4);

      for (const target of lanes) {
        const source = target === "lane1" ? "lane2" : "lane1";
        await pickUpChip(w, source);
        await moveTo(w, await center(chip(w, target)));
        await expect(chip(w, target)).toHaveClass(/gh-refchip--drag-target/);
        await shot(`${theme}-lane-target-${target}`, w.locator(".gh-commit-graph").first());
        await w.keyboard.press("Escape");
        await w.mouse.up();
        await expect(chip(w, target)).not.toHaveClass(/gh-refchip--drag-target/);
      }

      // Self-drop: reject ring + ghost reject + not-allowed cursor (the non-color cue).
      await pickUpChip(w, "lane3");
      await moveTo(w, await center(chip(w, "lane3")));
      expect(await cursorNow(w)).toBe("not-allowed");
      await expect(w.locator(".gh-drag-ghost--reject")).toBeVisible();
      await shot(`${theme}-lane-self-reject-lane3`, w.locator(".gh-commit-graph").first());
      await w.mouse.up();
      await expect(w.getByRole("menu")).toHaveCount(0);
    });

    test(`[${theme}] drop menu (enabled and disabled-with-reason) and the ghost/target card are legible`, async () => {
      await buildMultiLaneRepo(["lane1", "lane2"]);
      await git(repoDir, ["branch", "twin", "lane1"]); // same tip as lane1 -> "Already up to date"
      const w = await openRepo(theme);

      await pickUpCard(w, "lane2");
      await moveTo(w, await cardPad(w, "lane1"));
      await expect(card(w, "lane1")).toHaveClass(/gh-branches-panel__row--drag-target/);
      await shot(`${theme}-card-drag-target-with-ghost`);
      await w.mouse.up();
      const enabled = w.getByRole("menuitem", { name: "Merge lane2 into lane1" });
      await expect(enabled).toBeEnabled();
      await shot(`${theme}-drop-menu-enabled`);
      await w.keyboard.press("Escape");

      await pickUpCard(w, "lane1");
      await moveTo(w, await cardPad(w, "twin"));
      await w.mouse.up();
      const disabled = w.getByRole("menuitem", { name: "Merge lane1 into twin" });
      await expect(disabled).toBeDisabled();
      await expect(disabled).toContainText("Already up to date");
      await shot(`${theme}-drop-menu-disabled-reason`);
      await w.keyboard.press("Escape");
    });

    test(`[${theme}] palette "Merge branch into current branch…" picker, including its inline disabled reason`, async () => {
      await buildMultiLaneRepo(["lane1"]);
      await git(repoDir, ["branch", "twin", "main"]); // same tip as current main -> "Already up to date"
      const w = await openRepo(theme);
      await w.keyboard.press("Control+k");
      await w.getByRole("combobox").fill("Merge branch");
      await expect(w.getByText("Merge branch into current branch…")).toBeVisible();
      await shot(`${theme}-palette-entry`);
      await w.keyboard.press("Enter");
      const picker = w.getByRole("combobox", { name: /Choose a branch to merge into main/ });
      await expect(picker).toBeFocused();
      await expect(w.getByRole("option", { name: "twin" })).toBeVisible();
      await shot(`${theme}-picker-list`);
      await picker.fill("twin");
      await expect(w.getByRole("option", { name: "twin" })).toBeVisible();
      await w.keyboard.press("Enter");
      await expect(w.getByRole("status").filter({ hasText: "Already up to date" })).toBeVisible();
      await shot(`${theme}-picker-disabled-reason`);
    });
  });
}

test("dirty tree: dragging onto a non-current branch whose checkout git refuses shows git's reason verbatim and changes nothing", async () => {
  repoDir = await initRepo();
  await writeFile(repoDir, "a.txt", "base\n");
  await commitAll(repoDir, "Base commit");
  await git(repoDir, ["checkout", "-q", "-b", "target"]);
  await writeFile(repoDir, "a.txt", "target-version\n");
  await commitAll(repoDir, "Target edits a.txt");
  await git(repoDir, ["checkout", "-q", "-b", "source", "main"]);
  await writeFile(repoDir, "s.txt", "s\n");
  await commitAll(repoDir, "Source commit");
  await git(repoDir, ["checkout", "-q", "main"]);
  await writeFile(repoDir, "a.txt", "LOCAL UNCOMMITTED WORK\n"); // would be overwritten by `target`
  const headBefore = (await git(repoDir, ["rev-parse", "HEAD"])).stdout.trim();
  const refsBefore = (await git(repoDir, ["for-each-ref", "--format=%(refname) %(objectname)"])).stdout;

  const w = await openRepo();
  await pickUpCard(w, "source");
  await moveTo(w, await cardPad(w, "target"));
  await w.mouse.up();
  await w.getByRole("menuitem", { name: "Merge source into target" }).click();

  const alert = w.getByRole("alert").filter({ hasText: /overwritten|would be overwritten|local changes/i });
  await expect(alert).toBeVisible({ timeout: 10_000 });
  await shot("dirty-tree-refusal");
  expect(await alert.innerText()).toMatch(/a\.txt/);

  expect((await git(repoDir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(headBefore);
  expect((await git(repoDir, ["symbolic-ref", "--short", "HEAD"])).stdout.trim()).toBe("main");
  expect((await git(repoDir, ["for-each-ref", "--format=%(refname) %(objectname)"])).stdout).toBe(refsBefore);
  expect(await fs.readFile(path.join(repoDir, "a.txt"), "utf8")).toBe("LOCAL UNCOMMITTED WORK\n");
  await expect(fs.access(path.join(repoDir, ".git", "MERGE_HEAD"))).rejects.toBeTruthy();
});

test("conflicting merge via a real drag: banner + conflict view appear, panels refresh, Abort restores the exact pre-merge state", async () => {
  repoDir = await initRepo();
  await writeFile(repoDir, "a.txt", "base\n");
  await commitAll(repoDir, "Base commit");
  await git(repoDir, ["checkout", "-q", "-b", "feat"]);
  await writeFile(repoDir, "a.txt", "feat side\n");
  await commitAll(repoDir, "Feat edits a.txt");
  await git(repoDir, ["checkout", "-q", "main"]);
  await writeFile(repoDir, "a.txt", "main side\n");
  await commitAll(repoDir, "Main edits a.txt");
  const headBefore = (await git(repoDir, ["rev-parse", "HEAD"])).stdout.trim();

  const w = await openRepo();
  await pickUpCard(w, "feat");
  await moveTo(w, await cardPad(w, "main"));
  await w.mouse.up();
  await w.getByRole("menuitem", { name: "Merge feat into main" }).click();

  await expect(w.getByRole("status").filter({ hasText: /Merging/ }).first()).toBeVisible({ timeout: 15_000 });
  await expect(w.getByRole("button", { name: "Abort", exact: true })).toBeVisible();
  await expect(w.getByText("a.txt").first()).toBeVisible();
  await shot("conflicting-merge-banner");
  expect((await git(repoDir, ["status", "--porcelain"])).stdout).toMatch(/^UU a\.txt/m);

  await w.getByRole("button", { name: "Abort", exact: true }).click();
  await w.getByRole("alertdialog").getByRole("button", { name: "Abort", exact: true }).click();
  await expect(w.getByRole("button", { name: "Abort", exact: true })).toHaveCount(0, { timeout: 10_000 });
  await shot("conflicting-merge-after-abort");

  expect((await git(repoDir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(headBefore);
  expect((await git(repoDir, ["status", "--porcelain"])).stdout.trim()).toBe("");
  // autocrlf on Windows may rewrite EOLs on checkout; compare content only.
  expect((await fs.readFile(path.join(repoDir, "a.txt"), "utf8")).trim()).toBe("main side");
  await expect(fs.access(path.join(repoDir, ".git", "MERGE_HEAD"))).rejects.toBeTruthy();
});

test("detached HEAD (FR-430): drag is allowed, the orphaned-commits dialog appears BEFORE the checkout, and Leave proceeds with a banner", async () => {
  repoDir = await initRepo();
  await writeFile(repoDir, "a.txt", "base\n");
  await commitAll(repoDir, "Base commit");
  await git(repoDir, ["checkout", "-q", "-b", "feat"]);
  await writeFile(repoDir, "f.txt", "f\n");
  await commitAll(repoDir, "Feat commit");
  await git(repoDir, ["checkout", "-q", "--detach", "main"]);
  await writeFile(repoDir, "orphan.txt", "o\n"); // a commit reachable from no branch
  await commitAll(repoDir, "ORPHAN detached commit");
  const orphanSha = (await git(repoDir, ["rev-parse", "HEAD"])).stdout.trim();
  const mainBefore = (await git(repoDir, ["rev-parse", "main"])).stdout.trim();

  const w = await openRepo();
  await pickUpCard(w, "feat");
  await moveTo(w, await cardPad(w, "main"));
  await w.mouse.up();
  const item = w.getByRole("menuitem", { name: "Merge feat into main" });
  await expect(item).toBeEnabled();
  await shot("detached-head-drop-menu");
  await item.click();

  // The guard asks first: nothing has been checked out or merged yet.
  const dlg = w.getByRole("alertdialog");
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText("ORPHAN detached commit");
  await shot("detached-head-orphan-dialog");
  expect((await git(repoDir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(orphanSha);
  expect((await git(repoDir, ["rev-parse", "main"])).stdout.trim()).toBe(mainBefore);
  await expect(card(w, "main").getByText("Current")).toHaveCount(0);

  await dlg.getByRole("button", { name: "Leave commits behind" }).click();
  await expect(card(w, "main").getByText("Current")).toBeVisible({ timeout: 10_000 });
  await shot("detached-head-after-merge");
  // Checkout lands first ("Current" shows), the merge itself a moment later: poll instead of a one-shot read.
  const featSha = (await git(repoDir, ["rev-parse", "feat"])).stdout.trim();
  await expect.poll(async () => (await git(repoDir, ["rev-parse", "main"])).stdout.trim(), { timeout: 10_000 }).toBe(featSha);
  // The orphaned commit is now reflog-only; the user was told before AND after (banner).
  await expect(w.getByRole("status").filter({ hasText: new RegExp("behind at " + orphanSha.slice(0, 7)) })).toBeVisible();
  await shot("detached-head-after-merge-settled");
});

test("card with no rendered chip (FR-432): a branch on an off-screen commit can still be dragged onto a visible chip", async () => {
  repoDir = await initRepo();
  await writeFile(repoDir, "a.txt", "0\n");
  await commitAll(repoDir, "Root commit");
  await git(repoDir, ["branch", "ancient"]);
  // 400 commits of history: `ancient`'s row is far below the virtualized window, so no chip exists.
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["fast-import", "--quiet", "--date-format=raw"], { cwd: repoDir, shell: false });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`fast-import exited ${code}`))));
    let script = "";
    for (let i = 0; i < 400; i += 1) {
      const msg = `c${String(i % 10)}${String(i % 7)}`;
      script += `commit refs/heads/main\ncommitter T <t@e.com> ${1_700_000_000 + i} +0000\ndata ${msg.length}\n${msg}\n`;
      if (i === 0) script += "from refs/heads/main^0\n";
      script += "\n";
    }
    child.stdin.end(script);
  });
  await git(repoDir, ["reset", "-q", "--hard", "main"]);
  const w = await openRepo();
  await expect(card(w, "ancient")).toBeVisible();
  await expect(chip(w, "ancient")).toHaveCount(0);

  await pickUpCard(w, "ancient");
  await moveTo(w, await center(chip(w, "main")));
  await expect(chip(w, "main")).toHaveClass(/gh-refchip--drag-target/);
  await shot("no-chip-card-hover-main-chip");
  await w.mouse.up();
  const item = w.getByRole("menuitem", { name: "Merge ancient into main" });
  await expect(item).toBeVisible();
  await expect(item).toBeDisabled(); // ancient is an ancestor of main: "Already up to date"
  await expect(item).toContainText("Already up to date");
  await shot("no-chip-card-drop-menu");
});

test("Branches search filter (FR-433): filtered-out cards are neither sources nor targets and the search text is untouched", async () => {
  await buildMultiLaneRepo(["lane1", "lane2", "lane3"]);
  const w = await openRepo();
  const search = w.getByRole("searchbox", { name: "Search branches" });
  await search.fill("lane1");
  await expect(card(w, "lane2")).toHaveCount(0);
  await expect(card(w, "lane3")).toHaveCount(0);
  await expect(card(w, "lane1")).toBeVisible();

  // The visible card is still a source: drop it on a graph chip of a filtered-out branch.
  await pickUpCard(w, "lane1");
  await moveTo(w, await center(chip(w, "lane2")));
  await expect(chip(w, "lane2")).toHaveClass(/gh-refchip--drag-target/);
  await shot("search-filter-active-drag");
  await w.mouse.up();
  await expect(w.getByRole("menuitem", { name: "Merge lane1 into lane2" })).toBeEnabled();
  await w.keyboard.press("Escape");
  await expect(search).toHaveValue("lane1");
  await expect(card(w, "lane2")).toHaveCount(0);

  // Drag ending over the (now empty) space where other cards were opens nothing.
  await pickUpCard(w, "lane1");
  const b = (await card(w, "lane1").boundingBox())!;
  await moveTo(w, { x: b.x + 6, y: b.y + b.height + 40 });
  await w.mouse.up();
  await expect(w.getByRole("menu")).toHaveCount(0);
  await expect(search).toHaveValue("lane1");
});

test("FR-437 observation: palette entry in an in-progress merge state", async () => {
  repoDir = await initRepo();
  await writeFile(repoDir, "a.txt", "base\n");
  await commitAll(repoDir, "Base commit");
  await git(repoDir, ["checkout", "-q", "-b", "feat"]);
  await writeFile(repoDir, "a.txt", "feat side\n");
  await commitAll(repoDir, "Feat edits a.txt");
  await git(repoDir, ["checkout", "-q", "main"]);
  await writeFile(repoDir, "a.txt", "main side\n");
  await commitAll(repoDir, "Main edits a.txt");
  await git(repoDir, ["merge", "feat"]).catch(() => undefined); // conflicts -> MERGE_HEAD present

  const w = await openRepo();
  await expect(w.getByRole("button", { name: "Abort", exact: true })).toBeVisible();
  await w.keyboard.press("Control+k");
  await w.getByRole("combobox").fill("Merge branch");
  const entry = w.getByText("Merge branch into current branch…");
  await expect(entry).toBeVisible();
  await shot("fr437-in-progress-palette");
  await w.keyboard.press("Enter");
  const picker = w.getByRole("combobox", { name: /Choose a branch to merge into/ });
  await expect(picker).toBeFocused(); // reachable by keyboard alone
  await expect(w.getByRole("status").filter({ hasText: "disabled while another operation" })).toBeVisible();
  await shot("fr437-in-progress-picker");
});

test("FR-437 observation: palette entry in a bare repository", async () => {
  repoDir = await initRepo({ bare: true });
  const w = await openRepo();
  await w.keyboard.press("Control+k");
  await w.getByRole("combobox").fill("Merge branch");
  const visible = await w.getByText("Merge branch into current branch…").isVisible();
  await shot("fr437-bare-palette");
  // Observation only: record what the palette shows. (Bare repos may fail to open at all.)
  test.info().annotations.push({ type: "bare-palette-entry-visible", description: String(visible) });
});
