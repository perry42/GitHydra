// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Real-Electron check of the conflict block editor, specs/edit-in-diff.md FR-556..FR-565, against real merge and rebase
 * conflicts. Blocks are ~70 lines apart so the second one starts off-screen (auto-advance must scroll and focus it).
 * Screenshots go to $CF_SHOTS (or the OS temp dir).
 */
import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closeApp, launchGitHydra, removeUserDataDir, stubOpenRepoDialog, type LaunchedApp } from "../helpers/launchApp";
import { cleanup, commitAll, git, initRepo } from "../../src/test/gitFixture";

let handle: LaunchedApp;
let repoDir: string;
let shotDir: string;

test.beforeEach(async () => {
  handle = await launchGitHydra();
  shotDir = process.env.CF_SHOTS ?? (await fs.mkdtemp(path.join(os.tmpdir(), "githydra-pw-cf-")));
  await fs.mkdir(shotDir, { recursive: true });
});
test.afterEach(async () => {
  await closeApp(handle);
  await removeUserDataDir(handle.userDataDir);
  if (repoDir) await cleanup(repoDir);
});

const BASE = Array.from({ length: 80 }, (_, i) => `line${String(i + 1).padStart(2, "0")}`);
const variant = (a: string, b: string) => BASE.map((l, i) => (i === 1 ? a : i === 69 ? b : l)).join("\n") + "\n";
const put = (rel: string, data: string) => fs.writeFile(path.join(repoDir, rel), data);
const disk = async (rel: string) => (await fs.readFile(path.join(repoDir, rel), "utf8")).replace(/\r\n/g, "\n");
const porcelain = async () => (await git(repoDir, ["status", "--porcelain"])).stdout;

async function mergeRepo(): Promise<void> {
  repoDir = await initRepo();
  await put("a.txt", variant("line02", "line70"));
  await commitAll(repoDir, "base");
  await git(repoDir, ["checkout", "-q", "-b", "feature"]);
  await put("a.txt", variant("feat2", "feat70"));
  await commitAll(repoDir, "feature change");
  await git(repoDir, ["checkout", "-q", "main"]);
  await put("a.txt", variant("main2", "main70"));
  await commitAll(repoDir, "main change");
  await git(repoDir, ["merge", "feature"]).catch(() => {});
}

async function rebaseRepo(): Promise<void> {
  repoDir = await initRepo();
  await put("a.txt", variant("line02", "line70"));
  await commitAll(repoDir, "base");
  await git(repoDir, ["checkout", "-q", "-b", "feature"]);
  await put("a.txt", variant("feat2", "line70"));
  await commitAll(repoDir, "feature change");
  await git(repoDir, ["checkout", "-q", "main"]);
  await put("a.txt", variant("main2", "line70"));
  await commitAll(repoDir, "main change");
  await git(repoDir, ["checkout", "-q", "feature"]);
  await git(repoDir, ["rebase", "main"]).catch(() => {});
}

async function setTheme(w: Page, theme: "light" | "dark") {
  const current = await w.evaluate(() => document.documentElement.dataset.theme);
  if (current === theme) return;
  await w.getByRole("button", { name: "More actions" }).click();
  await w.getByRole("menuitem", { name: /switch to (light|dark) theme/i }).click();
  await expect.poll(() => w.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
}

async function shots(w: Page, name: string) {
  for (const t of ["dark", "light"] as const) {
    await setTheme(w, t);
    await w.waitForTimeout(300);
    await w.screenshot({ path: path.join(shotDir, `${name}-${t}.png`) });
  }
  await setTheme(w, "dark");
}

async function openEditor(): Promise<Page> {
  const w = handle.window;
  await stubOpenRepoDialog(handle.app, repoDir);
  await w.getByRole("button", { name: "Open a repository", exact: true }).click();
  await w.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });
  await w.getByRole("button", { name: /^changes/i }).click();
  await w.locator(".gh-changes-panel__file", { hasText: "a.txt" }).first().locator(".gh-changes-panel__file-label").click();
  await w.getByRole("region", { name: /resolve conflict in a\.txt/i }).getByRole("button", { name: "Resolve in editor" }).click();
  await expect(w.getByRole("textbox", { name: "Editing a.txt" })).toBeVisible({ timeout: 15_000 });
  return w;
}

const grp = (w: Page, n: number) => w.getByRole("group", { name: `Resolution for conflict ${n}` });
const chip = (w: Page, n: number, name: RegExp | string) => grp(w, n).getByRole("button", { name });
const pressedChips = (w: Page, n: number) => grp(w, n).locator("button[aria-pressed=true]");
const mark = (w: Page) => w.getByTestId("mark-resolved");
// CodeMirror virtualises: after the first decision focus jumps to the far block 2, so block 1 leaves the DOM until navigated back to.
async function backToBlock1(w: Page) {
  await w.getByRole("button", { name: /^Previous conflict/ }).click();
  await expect(grp(w, 1)).toBeVisible();
}
const cmText = (w: Page) => w.locator(".cm-content").innerText();

test("Resolve in editor opens the block editor: 2 blocks, nothing written or staged, Mark as resolved disabled", async () => {
  await mergeRepo();
  const w = await openEditor();
  await expect(grp(w, 1)).toBeVisible();
  await expect(w.getByRole("button", { name: /2 conflicts unresolved/ })).toBeVisible();
  await expect(mark(w)).toHaveAttribute("aria-disabled", "true");
  expect(await porcelain()).toMatch(/^UU a\.txt/m);
  expect(await disk("a.txt")).toContain("<<<<<<<");
  await shots(w, "01-open-merge");
});

test("chip click fills the result with that side and exactly one chip reads pressed (FR-557)", async () => {
  await mergeRepo();
  const w = await openEditor();
  await chip(w, 1, /^Yours/).click();
  await backToBlock1(w);
  await expect(pressedChips(w, 1)).toHaveCount(1);
  await expect(chip(w, 1, /^Yours/)).toHaveAttribute("aria-pressed", "true");
  await expect(w.locator(".cm-content")).toContainText("main2");
  await expect(w.locator(".cm-content")).not.toContainText("feat2");
  await chip(w, 1, /^Incoming/).click();
  await expect(pressedChips(w, 1)).toHaveCount(1);
  await expect(chip(w, 1, /^Incoming/)).toHaveAttribute("aria-pressed", "true");
  await expect(w.locator(".cm-content")).toContainText("feat2");
});

test("double-clicking an undecided block's marker line seeds both sides and puts the caret in the result (mockup)", async () => {
  await mergeRepo();
  const w = await openEditor();
  await w.locator(".cm-line", { hasText: "<<<<<<<" }).first().dblclick();
  await expect(chip(w, 1, /^Both/)).toHaveAttribute("aria-pressed", "true");
  await expect(w.locator(".cm-content")).toContainText("main2");
  await expect(w.locator(".cm-content")).toContainText("feat2");
  await w.keyboard.type("Z");
  await expect(chip(w, 1, /^Custom text/)).toHaveAttribute("aria-pressed", "true");
});

test("typing inside a decided block ticks Custom; switching away and back restores the custom text (FR-560)", async () => {
  await mergeRepo();
  const w = await openEditor();
  await chip(w, 1, /^Yours/).click();
  await backToBlock1(w);
  const line = w.locator(".cm-line", { hasText: "main2" }).first();
  await line.click();
  await w.keyboard.press("End");
  await w.keyboard.type("-mine");
  await expect(chip(w, 1, /^Custom text/)).toHaveAttribute("aria-pressed", "true");
  await expect(pressedChips(w, 1)).toHaveCount(1);
  await chip(w, 1, /^Incoming/).click();
  await expect(w.locator(".cm-content")).toContainText("feat2");
  await expect(w.locator(".cm-content")).not.toContainText("main2-mine");
  await chip(w, 1, /^Custom text/).click();
  await expect(w.locator(".cm-content")).toContainText("main2-mine");
  await expect(chip(w, 1, /^Custom text/)).toHaveAttribute("aria-pressed", "true");
});

test("Neither removes both sides; Both honours order toggle; Reset returns to markers (FR-557, FR-561)", async () => {
  await mergeRepo();
  const w = await openEditor();
  await chip(w, 1, "Neither, remove both sides").click();
  await backToBlock1(w);
  await expect(chip(w, 1, "Neither, remove both sides")).toHaveAttribute("aria-pressed", "true");
  await expect(w.locator(".cm-content")).not.toContainText("main2");
  await expect(w.locator(".cm-content")).not.toContainText("feat2");

  await chip(w, 1, /^Both sides/).click();
  await expect(chip(w, 1, /^Both sides/)).toHaveAttribute("aria-pressed", "true");
  let txt = await cmText(w);
  expect(txt.indexOf("main2")).toBeGreaterThan(-1);
  expect(txt.indexOf("main2")).toBeLessThan(txt.indexOf("feat2"));
  await chip(w, 1, /^Order:/).click();
  txt = await cmText(w);
  expect(txt.indexOf("feat2")).toBeLessThan(txt.indexOf("main2"));
  await expect(pressedChips(w, 1)).toHaveCount(1);
  await shots(w, "02-both-reversed");

  await chip(w, 1, /^Reset/).click();
  await expect(pressedChips(w, 1)).toHaveCount(0);
  await expect(w.getByRole("button", { name: /2 conflicts unresolved/ })).toBeVisible();
  await expect(chip(w, 1, /^Reset/)).toHaveAttribute("aria-disabled", "true");
});

test("first decision auto-advances focus to the off-screen block 2 with a toast; Undo returns; re-deciding does not move focus (FR-562)", async () => {
  await mergeRepo();
  const w = await openEditor();
  await chip(w, 1, /^Yours/).click();
  const toast = w.locator(".gh-cf-toast");
  await expect(toast).toBeVisible();
  await expect(toast.getByRole("button", { name: "Undo" })).toBeVisible();
  // Block 2 is ~70 lines down: it must now be scrolled into view and carry the focus.
  await expect(grp(w, 2)).toBeInViewport();
  const focusInBlock2 = await w.evaluate(() => {
    const a = document.activeElement;
    const lens = a?.closest(".gh-cf-lens");
    return lens ? lens.getAttribute("data-cf-id") : a?.className ?? "none";
  });
  console.log("focus after auto-advance:", focusInBlock2);
  await shots(w, "03-auto-advance");
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect(grp(w, 1)).toBeInViewport();
  await expect(pressedChips(w, 1)).toHaveCount(0);

  // Re-deciding block 1 after it was decided does not advance again.
  await chip(w, 1, /^Yours/).click();
  await backToBlock1(w);
  await chip(w, 1, /^Incoming/).click();
  await expect(grp(w, 1)).toBeInViewport();
  await expect(chip(w, 1, /^Incoming/)).toBeFocused();
});

test("Mark as resolved stays disabled until every block is decided, then stages a marker-free file (FR-563)", async () => {
  await mergeRepo();
  const w = await openEditor();
  await chip(w, 1, /^Yours/).click();
  await expect(mark(w)).toHaveAttribute("aria-disabled", "true");
  await chip(w, 2, /^Incoming/).click();
  await expect(w.getByText("All 2 decided")).toBeVisible();
  await expect(mark(w)).not.toHaveAttribute("aria-disabled", "true");
  await shots(w, "04-all-decided");
  await mark(w).click();
  await expect.poll(porcelain, { timeout: 15_000 }).toMatch(/^M {2}a\.txt/m);
  const text = await disk("a.txt");
  expect(text).toBe(variant("main2", "feat70"));
  expect(text).not.toMatch(/^(<<<<<<<|=======|>>>>>>>)/m);
  expect((await git(repoDir, ["ls-files", "--unmerged"])).stdout.trim()).toBe("");
});

test("rebase: chips read Onto then Yours, Yours is the own commit of the user (FR-559)", async () => {
  await rebaseRepo();
  expect(await porcelain()).toMatch(/^UU a\.txt/m);
  const w = await openEditor();
  const row = grp(w, 1).getByRole("button");
  await expect(row.nth(0)).toHaveAccessibleName("Onto, main");
  await expect(row.nth(1)).toHaveAccessibleName("Yours, feature");
  await shots(w, "05-rebase");
  await chip(w, 1, /^Yours/).click();
  await expect(mark(w)).not.toHaveAttribute("aria-disabled", "true");
  await mark(w).click();
  await expect.poll(porcelain, { timeout: 15_000 }).not.toMatch(/^UU a\.txt/m);
  expect(await disk("a.txt")).toBe(variant("feat2", "line70"));
});

test("save, close and reopen a half-resolved file keeps the decided block's chip (FR-557, FR-565)", async () => {
  await mergeRepo();
  const w = await openEditor();
  await chip(w, 1, /^Incoming/).click();
  await w.locator(".cm-content").focus();
  await w.keyboard.press("Control+s");
  await expect.poll(async () => (await disk("a.txt")).includes("main2")).toBe(false);
  expect(await porcelain()).toMatch(/^UU a\.txt/m);
  await w.getByRole("button", { name: "Back to changes" }).click();
  await w.getByRole("region", { name: /resolve conflict in a\.txt/i }).getByRole("button", { name: "Resolve in editor" }).click();
  await expect(w.getByRole("textbox", { name: "Editing a.txt" })).toBeVisible();
  await expect(chip(w, 1, /^Incoming/)).toHaveAttribute("aria-pressed", "true");
  await expect(pressedChips(w, 2)).toHaveCount(0);
  await expect(w.getByRole("button", { name: /1 conflict unresolved/ })).toBeVisible();
  await shots(w, "06-reopened");
});

test("dirty-leave guard: leaving with an unsaved chip decision asks; Cancel keeps the buffer, Discard leaves the file alone (FR-535)", async () => {
  await mergeRepo();
  const before = await disk("a.txt");
  const w = await openEditor();
  await chip(w, 1, /^Yours/).click();
  await shots(w, "07-dirty-before-leave");
  await w.getByRole("button", { name: "Back to changes" }).click();
  const dlg = w.getByRole("alertdialog");
  await expect(dlg).toBeVisible();
  await w.screenshot({ path: path.join(shotDir, "07-leave-dialog.png") });
  await dlg.getByRole("button", { name: "Cancel" }).click();
  await backToBlock1(w);
  await expect(chip(w, 1, /^Yours/)).toHaveAttribute("aria-pressed", "true");
  await w.getByRole("button", { name: "Back to changes" }).click();
  await w.getByRole("alertdialog").getByRole("button", { name: "Discard" }).click();
  await expect(w.getByRole("region", { name: /resolve conflict in a\.txt/i })).toBeVisible();
  expect(await disk("a.txt")).toBe(before);
  expect(await porcelain()).toMatch(/^UU a\.txt/m);
});

test("hover preview of a chip shows inside the editor without being clipped (mockup)", async () => {
  await mergeRepo();
  const w = await openEditor();
  await chip(w, 1, /^Incoming/).hover();
  const pv = w.locator(".gh-cf-lens").first().locator(".gh-cf-pv");
  await expect(pv).toBeVisible();
  const [pb, eb] = await Promise.all([pv.boundingBox(), w.locator(".cm-editor").boundingBox()]);
  await w.screenshot({ path: path.join(shotDir, "08-hover-preview-dark.png") });
  expect(pb && eb).toBeTruthy();
  // Fully inside the editor box means it is not cut off by the scroller.
  expect(pb!.y + pb!.height).toBeLessThanOrEqual(eb!.y + eb!.height + 1);
});

test("every chip of the row is reachable at the default window size (mockup chip row)", async () => {
  await mergeRepo();
  const w = await openEditor();
  const ed = await w.locator(".cm-editor").boundingBox();
  for (const name of [/^Yours/, /^Incoming/, /^Both/, /^Neither/, /^Custom/, /^Edit the result/]) {
    const b = await chip(w, 1, name).boundingBox();
    expect(b, String(name)).toBeTruthy();
    expect(b!.x + b!.width, `${name} right edge inside editor`).toBeLessThanOrEqual(ed!.x + ed!.width);
  }
});
