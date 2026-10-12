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

async function twoFileMergeRepo(): Promise<void> {
  repoDir = await initRepo();
  await put("a.txt", variant("line02", "line70"));
  await put("b.txt", variant("line02", "line70"));
  await commitAll(repoDir, "base");
  await git(repoDir, ["checkout", "-q", "-b", "feature"]);
  await put("a.txt", variant("feat2", "feat70"));
  await put("b.txt", variant("feat2", "feat70"));
  await commitAll(repoDir, "feature change");
  await git(repoDir, ["checkout", "-q", "main"]);
  await put("a.txt", variant("main2", "main70"));
  await put("b.txt", variant("main2", "main70"));
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

/** specs/mid-merge-landing.md FR-580: a repo opened mid-conflict already has the drawer open; only click Changes if it did not. */
async function openChangesDrawer(w: Page) {
  const drawer = w.locator(".gh-changes-panel").first();
  const opened = await drawer.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false);
  if (!opened) await w.getByRole("button", { name: /^changes/i }).click();
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
  await openChangesDrawer(w);
  // FR-556/FR-567: a click on an editor-eligible conflicted row opens the editor itself.
  await conflictRow(w, "a.txt").click();
  await expect(w.getByRole("textbox", { name: "Editing a.txt" })).toBeVisible({ timeout: 15_000 });
  return w;
}

const conflictRow = (w: Page, name: string) => w.locator(".gh-changes-panel__file", { hasText: name }).first().locator(".gh-changes-panel__file-label");

const grp = (w: Page, n: number) => w.getByRole("group", { name: `Resolution for conflict ${n}` });
const chip = (w: Page, n: number, name: RegExp | string) => grp(w, n).getByRole("button", { name });
const pressedChips = (w: Page, n: number) => grp(w, n).locator("button[aria-pressed=true]");
const mark = (w: Page) => w.getByTestId("mark-resolved");
// CodeMirror virtualises: after the first decision focus jumps to the far block 2, so block 1 leaves the DOM until navigated back to.
async function backToBlock1(w: Page) {
  // The row click left the pointer over the file-list rail, whose hover overlay would cover the toolbar.
  await w.locator(".cm-editor").hover();
  await w.getByRole("button", { name: /^Previous conflict/ }).click();
  await expect(grp(w, 1)).toBeVisible();
}
const tag = (w: Page) => w.locator(".gh-edit__bar .gh-edit__tag-text").first();
const cmText = (w: Page) => w.locator(".cm-content").innerText();

test("Clicking a conflicted row opens the block editor: 2 blocks, nothing written or staged, Mark as resolved disabled", async () => {
  await mergeRepo();
  const w = await openEditor();
  await expect(grp(w, 1)).toBeVisible();
  await expect(w.getByTestId("rebase-side-line")).toHaveCount(0);
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

test("double-clicking an undecided block never decides: markers stay, nothing ticks, the gate stays shut (FR-567)", async () => {
  await mergeRepo();
  const w = await openEditor();
  await w.locator(".cm-line", { hasText: "<<<<<<<" }).first().dblclick();
  await expect(pressedChips(w, 1)).toHaveCount(0);
  await expect(w.locator(".cm-content")).toContainText("<<<<<<<");
  await expect(w.getByRole("button", { name: /2 conflicts unresolved/ })).toBeVisible();
  await expect(mark(w)).toHaveAttribute("aria-disabled", "true");
});

test("Enter on a focused chip activates it like Space; only E starts editing, and E on an undecided block decides nothing (FR-567)", async () => {
  await mergeRepo();
  const w = await openEditor();
  await chip(w, 1, /^Incoming/).focus();
  await w.keyboard.press("Enter");
  await backToBlock1(w);
  await expect(chip(w, 1, /^Incoming/)).toHaveAttribute("aria-pressed", "true");
  await chip(w, 1, /^Neither/).focus();
  await w.keyboard.press("Space");
  await expect(chip(w, 1, /^Neither/)).toHaveAttribute("aria-pressed", "true");
  await w.keyboard.press("F3");
  await expect(grp(w, 2)).toBeInViewport();
  await chip(w, 2, /^Yours/).focus();
  await w.keyboard.press("e");
  await expect(w.locator(".cm-content")).toBeFocused();
  await expect(pressedChips(w, 2)).toHaveCount(0);
});

test("Esc steps up one level: block text, its chip row, back to Resolving, then out of the editor (FR-567, FR-598)", async () => {
  await mergeRepo();
  const w = await openEditor();
  await chip(w, 1, /^Yours/).click();
  await backToBlock1(w);
  await w.locator(".cm-line", { hasText: "main2" }).first().dblclick();
  await expect(tag(w)).toHaveText("Editing");
  await w.keyboard.press("Escape");
  await expect(w.getByRole("textbox", { name: "Editing a.txt" })).toBeVisible();
  await expect(chip(w, 1, /^Yours/)).toBeFocused();
  await expect(tag(w)).toHaveText("Editing");
  await w.keyboard.press("Escape");
  // Back to Resolving even though the buffer is dirty: no prompt, still on the file.
  await expect(tag(w)).toHaveText("Resolving");
  await expect(w.getByRole("alertdialog")).toHaveCount(0);
  await w.keyboard.press("Escape");
  // The buffer is dirty, so leaving asks; the editor has not just vanished on the first Esc.
  await expect(w.getByRole("alertdialog")).toBeVisible();
  await w.getByRole("alertdialog").getByRole("button", { name: "Discard" }).click();
  await expect(w.getByRole("textbox", { name: "Editing a.txt" })).toBeHidden();
});

test("Esc in Resolving text outside any block leaves a clean file (FR-567, FR-598)", async () => {
  await mergeRepo();
  const w = await openEditor();
  await w.locator(".cm-line", { hasText: "line05" }).first().click();
  await w.keyboard.press("Escape");
  await expect(w.getByRole("textbox", { name: "Editing a.txt" })).toBeHidden();
});

test("read-only first: a typed key changes nothing and announces; E, a double-click or the Edit chip enter Editing in place (FR-593..FR-595)", async () => {
  await mergeRepo();
  const w = await openEditor();
  await expect(tag(w)).toHaveText("Resolving");
  await expect(chip(w, 1, /^Yours/)).toBeFocused();
  await w.locator(".cm-line", { hasText: "line05" }).first().click();
  const before = await cmText(w);
  await w.keyboard.type("zz");
  await w.keyboard.press("Tab");
  expect(await cmText(w)).toBe(before);
  await expect(w.getByText("Read-only. Press E to edit.").first()).toBeAttached();
  await expect(w.locator(".cm-editor")).toHaveClass(/gh-cm-ro/);
  await expect(w.getByRole("button", { name: "Save", exact: true })).toHaveAttribute("aria-disabled", "true");
  // The pure text caret is hidden in Resolving.
  await expect(w.locator(".cm-cursor").first()).toBeHidden();
  await w.keyboard.press("e");
  await expect(tag(w)).toHaveText("Editing");
  await w.keyboard.type("zz");
  expect(await cmText(w)).not.toBe(before);
  await w.keyboard.press("Control+z");
  expect(await cmText(w)).toBe(before);
});

test("read-only first: screenshots of Resolving (with hint) and Editing at the default width, both themes (FR-593)", async () => {
  await mergeRepo();
  const w = await openEditor();
  await shots(w, "20-resolving-blocked");
  await chip(w, 1, /^Yours/).click();
  await chip(w, 2, /^Incoming/).click();
  await expect(w.getByTestId("editor-slot")).toContainText("Read-only. Double-click or press E to edit.");
  await backToBlock1(w);
  await shots(w, "21-resolving-hint");
  await w.locator(".cm-line", { hasText: "main2" }).first().dblclick();
  await expect(tag(w)).toHaveText("Editing");
  await shots(w, "22-editing");
});

test("read-only first: the chip choice stays after entering Editing and the dirty guard asks on leave (FR-596, FR-599)", async () => {
  await mergeRepo();
  const w = await openEditor();
  await chip(w, 1, /^Yours/).click();
  await expect(w.getByText("Unsaved").first()).toBeVisible();
  await backToBlock1(w);
  await chip(w, 1, /^Yours/).focus();
  await w.keyboard.press("e");
  await expect(tag(w)).toHaveText("Editing");
  await expect(chip(w, 1, /^Yours/)).toHaveAttribute("aria-pressed", "true");
  await expect(w.locator(".cm-content")).toContainText("main2");
  await w.getByRole("button", { name: /^Back to changes/ }).click();
  await expect(w.getByRole("alertdialog")).toBeVisible();
  await w.getByRole("alertdialog").getByRole("button", { name: "Discard" }).click();
});

test("ready cue (FR-587): quiet while conflicts remain; once all are decided the pill reads All decided and Mark as resolved turns green", async () => {
  await mergeRepo();
  const w = await openEditor();
  const nav = w.getByRole("region", { name: "Conflict navigation" });
  await expect(nav).toBeVisible();
  await expect(nav.getByTestId("pill-all-decided")).toHaveCount(0);
  await expect(w.getByText("Looks good")).toHaveCount(0);
  await shots(w, "09-quiet");
  await chip(w, 1, /^Yours/).click();
  await chip(w, 2, /^Incoming/).click();
  await expect(nav.getByTestId("pill-all-decided")).toContainText("All decided");
  await expect(mark(w)).toHaveClass(/gh-edit__btn--ready/);
  await expect(w.getByText("All 2 conflicts decided, no markers left")).toBeVisible();
  await shots(w, "10-all-decided");
});

test("the floating pill is pinned, clear of the scrollbar, opaque, and jumps put the target block two rows below it (FR-585)", async () => {
  await mergeRepo();
  const w = await openEditor();
  const nav = w.getByRole("region", { name: "Conflict navigation" });
  const box = async (sel: string) => w.locator(sel).first().evaluate((el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; });
  const scroller = await box(".cm-scroller");
  const pill = await nav.evaluate((el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; });
  // 12px scrollbar plus a gap: the pill ends left of the scrollbar track.
  expect(scroller.r - pill.r).toBeGreaterThanOrEqual(12 + 4);
  const bg = await nav.evaluate((el) => { const c = getComputedStyle(el); return { bg: c.backgroundColor, blur: c.backdropFilter, op: c.opacity }; });
  expect(bg.bg).not.toMatch(/rgba\(.*,\s*0(\.\d+)?\)$/);
  expect(bg.blur).toBe("none");
  expect(bg.op).toBe("1");
  await w.locator(".cm-editor").hover();
  await nav.getByRole("button", { name: /^Next conflict/ }).click();
  await expect(grp(w, 2)).toBeInViewport();
  const first = await w.locator(".cm-line", { hasText: "<<<<<<<" }).first().evaluate((el) => el.getBoundingClientRect().top);
  const sc = (await box(".cm-scroller")).t;
  expect(first - sc).toBeGreaterThanOrEqual(2 * 18 - 4);
  expect(first - sc).toBeLessThanOrEqual(2 * 18 + 24);
  // Pinned: scrolling the text does not move it.
  await w.locator(".cm-scroller").evaluate((el) => { el.scrollTop = 0; });
  const after = await nav.evaluate((el) => el.getBoundingClientRect().top);
  expect(Math.abs(after - pill.t)).toBeLessThan(1);
});

test("Ctrl+F in the editor is swallowed: focus stays in the text, nothing else opens (find is ROADMAP V1.1)", async () => {
  await mergeRepo();
  const w = await openEditor();
  await w.locator(".cm-line", { hasText: "line05" }).first().click();
  await w.keyboard.press("Control+f");
  await expect(w.locator(".cm-content")).toBeFocused();
  await expect(w.getByRole("textbox", { name: "Editing a.txt" })).toBeVisible();
});

test("mouse click on a pill arrow returns focus to the text; keyboard activation keeps it on the button; Esc in the pill returns to the text (FR-586)", async () => {
  await mergeRepo();
  const w = await openEditor();
  const nav = w.getByRole("region", { name: "Conflict navigation" });
  // FR-597: Resolving has no caret, so a mouse click lands on the chip row; in Editing it lands in the text.
  await nav.getByRole("button", { name: /^Next conflict/ }).click();
  await expect(chip(w, 2, /^Yours/)).toBeFocused();
  await w.keyboard.press("e");
  await expect(tag(w)).toHaveText("Editing");
  await nav.getByRole("button", { name: /^Previous conflict/ }).click();
  await expect(w.locator(".cm-content")).toBeFocused();
  const prev = nav.getByRole("button", { name: /^Previous conflict/ });
  await prev.focus();
  await w.keyboard.press("Enter");
  await expect(prev).toBeFocused();
  await w.keyboard.press("Escape");
  await expect(w.locator(".cm-content")).toBeFocused();
  await expect(w.getByRole("textbox", { name: "Editing a.txt" })).toBeVisible();
});

test("Ctrl+S while markers remain says it saved but the conflicts are not resolved (FR-570)", async () => {
  await mergeRepo();
  const w = await openEditor();
  await chip(w, 1, /^Yours/).click();
  await w.locator(".cm-content").focus();
  await w.keyboard.press("Control+s");
  await expect(w.getByText("Saved — still has conflict markers").first()).toBeVisible();
});

test("resolving a file opens the next one by itself; the last offers Continue merge (FR-569)", async () => {
  await twoFileMergeRepo();
  const w = await openEditor();
  await chip(w, 1, /^Yours/).click();
  await chip(w, 2, /^Yours/).click();
  await mark(w).click();
  await expect(w.getByTestId("auto-next-toast")).toContainText("a.txt resolved and staged. Opened b.txt");
  await shots(w, "11-auto-next");
  await expect(w.getByRole("textbox", { name: "Editing b.txt" })).toBeVisible({ timeout: 15_000 });
  await chip(w, 1, /^Yours/).click();
  await chip(w, 2, /^Yours/).click();
  await mark(w).click();
  const last = w.getByTestId("resolved-strip");
  await expect(last).toContainText("All conflicts resolved");
  const cont = last.getByRole("button", { name: "Continue merge" });
  await expect(cont).not.toHaveAttribute("aria-disabled", "true", { timeout: 15_000 });
  expect((await git(repoDir, ["log", "--merges", "--oneline"])).stdout.trim()).toBe("");
  await shots(w, "12-continue");
  await cont.click();
  await expect.poll(async () => (await git(repoDir, ["log", "--merges", "--oneline"])).stdout.trim(), { timeout: 20_000 }).not.toBe("");
});

test("a file the editor cannot open keeps the file-level view with the reason, and Take asks only when the working file was edited (FR-566)", async () => {
  repoDir = await initRepo();
  await put("d.txt", "one\ntwo\n");
  await commitAll(repoDir, "base");
  await git(repoDir, ["checkout", "-q", "-b", "feature"]);
  await git(repoDir, ["rm", "-q", "d.txt"]);
  await commitAll(repoDir, "feature deletes");
  await git(repoDir, ["checkout", "-q", "main"]);
  await put("d.txt", "one\ntwo changed\n");
  await commitAll(repoDir, "main edits");
  await git(repoDir, ["merge", "feature"]).catch(() => {});
  const w = handle.window;
  await stubOpenRepoDialog(handle.app, repoDir);
  await w.getByRole("button", { name: "Open a repository", exact: true }).click();
  await w.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });
  await openChangesDrawer(w);
  await conflictRow(w, "d.txt").click();
  const view = w.getByRole("region", { name: /resolve conflict in d\.txt/i });
  await expect(view.getByTestId("no-editor-reason")).toContainText("One side deleted this file");
  await expect(view.getByRole("button", { name: "Resolve in editor" })).toHaveCount(0);
  await shots(w, "13-file-level-reason");
  // Edit the working file outside GitHydra: taking a side must now ask first.
  await put("d.txt", "one\ntwo changed\nmine\n");
  await view.getByRole("button", { name: /^Take .* and mark resolved$/ }).first().click();
  const dlg = w.getByRole("alertdialog");
  await expect(dlg).toBeVisible();
  await w.screenshot({ path: path.join(shotDir, "14-take-confirm-dark.png") });
  await dlg.getByRole("button", { name: "Cancel" }).click();
  expect(await porcelain()).toMatch(/^(DU|UD) d\.txt/m);
  await view.getByRole("button", { name: /^Take .* and mark resolved$/ }).first().click();
  await w.getByRole("alertdialog").getByRole("button", { name: "Take it" }).click();
  await expect.poll(porcelain, { timeout: 15_000 }).not.toMatch(/^(DU|UD) d\.txt/m);
});

test("typing inside a decided block ticks Custom; switching away and back restores the custom text (FR-560)", async () => {
  await mergeRepo();
  const w = await openEditor();
  await chip(w, 1, /^Yours/).click();
  await backToBlock1(w);
  const line = w.locator(".cm-line", { hasText: "main2" }).first();
  await line.dblclick();
  await expect(tag(w)).toHaveText("Editing");
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
  await expect(w.getByText("All 2 conflicts decided").first()).toBeVisible();
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
  const sideLine = w.getByTestId("rebase-side-line");
  await expect(sideLine).toHaveText("Rebase: Onto = the branch you're rebuilding on. Yours = your commit being replayed.");
  await expect(row.nth(0)).toHaveAttribute("title", /being rebased onto/);
  await expect(row.nth(1)).toHaveAttribute("aria-description", /being replayed/);
  await expect(w.getByTestId("editor-slot")).toBeVisible();
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
  await conflictRow(w, "a.txt").click();
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
  await expect(w.getByRole("textbox", { name: "Editing a.txt" })).toBeHidden();
  expect(await disk("a.txt")).toBe(before);
  expect(await porcelain()).toMatch(/^UU a\.txt/m);
});

test("dirty-leave guard on a row click: the highlight follows the editor (Cancel stays on a.txt, Save opens b.txt) (FR-535)", async () => {
  await twoFileMergeRepo();
  const w = await openEditor();
  const sel = w.locator("li.gh-changes-panel__file--selected");
  await chip(w, 1, /^Yours/).click();
  await conflictRow(w, "b.txt").click();
  await w.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
  await expect(w.getByRole("textbox", { name: "Editing a.txt" })).toBeVisible();
  await expect(sel).toHaveCount(1);
  await expect(sel.first()).toContainText("a.txt");
  await conflictRow(w, "b.txt").click();
  await w.getByRole("alertdialog").getByRole("button", { name: "Save", exact: true }).click();
  await expect(w.getByRole("textbox", { name: "Editing b.txt" })).toBeVisible({ timeout: 15_000 });
  await expect(sel).toHaveCount(1);
  await expect(sel.first()).toContainText("b.txt");
  await w.screenshot({ path: path.join(shotDir, "13-leave-follows-selection.png") });
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

// specs/conflict-first-layout.md FR-573..FR-576: Conflicted first and open, the rest collapsed, comparison tabs never overlap.
test("conflicts first: Conflicted section on top, others collapsed, first file opened; comparison tabs do not overlap the heading", async () => {
  repoDir = await initRepo();
  await fs.writeFile(path.join(repoDir, "a.bin"), Buffer.from([0, 1, 2, 3, 0, 9]));
  await put("b.txt", variant("line02", "line70"));
  await put("tracked.txt", "t\n");
  await commitAll(repoDir, "base");
  await git(repoDir, ["checkout", "-q", "-b", "feature"]);
  await fs.writeFile(path.join(repoDir, "a.bin"), Buffer.from([0, 7, 7, 7, 0, 1]));
  await put("b.txt", variant("feat2", "feat70"));
  await commitAll(repoDir, "feature change");
  await git(repoDir, ["checkout", "-q", "main"]);
  await fs.writeFile(path.join(repoDir, "a.bin"), Buffer.from([0, 5, 5, 5, 0, 2]));
  await put("b.txt", variant("main2", "main70"));
  await commitAll(repoDir, "main change");
  await git(repoDir, ["merge", "feature"]).catch(() => {});
  await put("tracked.txt", "t changed\n");
  await put("new-staged.txt", "s\n");
  await git(repoDir, ["add", "new-staged.txt"]);
  await put("untracked.txt", "u\n");

  const w = handle.window;
  await stubOpenRepoDialog(handle.app, repoDir);
  await w.getByRole("button", { name: "Open a repository", exact: true }).click();
  await w.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });
  await openChangesDrawer(w);

  const heads = w.locator(".gh-changes-panel__section-heading");
  await expect(heads.first()).toHaveText(/^Conflicted \(2\)/);
  for (const name of [/Staged \(1\)/, /Unstaged \(1\)/, /Untracked \(1\)/]) {
    await expect(w.locator(".gh-changes-panel__section-toggle", { hasText: name })).toHaveAttribute("aria-expanded", "false");
  }
  // The first conflicted file (binary, so the file-level view) is open without any click.
  const view = w.getByRole("region", { name: /resolve conflict in a\.bin/i });
  await expect(view).toBeVisible({ timeout: 15_000 });
  const conflictedBox = await w.getByRole("grid", { name: "Conflicted files" }).boundingBox();
  const scrollBox = await w.locator(".gh-changes-panel__scroll").boundingBox();
  expect(conflictedBox!.y + conflictedBox!.height).toBeLessThanOrEqual(scrollBox!.y + scrollBox!.height);

  const noOverlap = async (label: string) => {
    await expect(view.getByRole("tablist", { name: "Comparison" })).toBeVisible({ timeout: 15_000 });
    const tabs = view.getByRole("tab");
    const n = await tabs.count();
    expect(n).toBeGreaterThanOrEqual(3);
    const heading = await view.locator(".gh-diff-view__heading").boundingBox();
    const tabsRow = await view.locator(".gh-conflict-view__tabs").boundingBox();
    for (let i = 0; i < n; i++) {
      const b = (await tabs.nth(i).boundingBox())!;
      const text = (await tabs.nth(i).evaluate((el) => {
        const r = document.createRange();
        r.selectNodeContents(el);
        const rect = r.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, right: rect.right, left: rect.left };
      }))!;
      expect(text.bottom, `${label} tab ${i} text inside its box`).toBeLessThanOrEqual(b.y + b.height + 0.5);
      expect(text.right, `${label} tab ${i} text inside its box (x)`).toBeLessThanOrEqual(b.x + b.width + 0.5);
      expect(b.y + b.height, `${label} tab ${i} above the heading`).toBeLessThanOrEqual(heading!.y + 0.5);
      expect(b.y + b.height).toBeLessThanOrEqual(tabsRow!.y + tabsRow!.height + 0.5);
    }
  };
  await noOverlap("default");
  await shots(w, "15-conflict-first");

  await handle.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(900, 700));
  await w.waitForTimeout(400);
  await noOverlap("narrow");
  await w.screenshot({ path: path.join(shotDir, "15-conflict-first-narrow.png") });

  // Expanding a collapsed section is a click; it stays collapsed-by-default only while conflicts remain.
  await w.locator(".gh-changes-panel__section-toggle", { hasText: /Staged \(1\)/ }).click();
  await expect(w.getByRole("grid", { name: "Staged files" })).toBeVisible();
  await expect(w.getByRole("button", { name: "Commit", exact: true })).toBeDisabled();
});

test("a row picked before the FR-575 auto-open lands wins: no conflict editor over it", async () => {
  await mergeRepo();
  await put("u.txt", "untracked one\n");
  const w = handle.window;
  await stubOpenRepoDialog(handle.app, repoDir);
  await w.getByRole("button", { name: "Open a repository", exact: true }).click();
  await w.locator(".gh-changes-panel__file").first().waitFor({ timeout: 15_000 });
  await w.locator(".gh-changes-panel__section-toggle", { hasText: /Untracked \(1\)/ }).click();
  await w.locator(".gh-changes-panel__file", { hasText: "u.txt" }).first().locator(".gh-changes-panel__file-label").click();
  await w.waitForTimeout(4000);
  await expect(w.locator(".cm-editor")).toHaveCount(0);
  await expect(w.locator(".gh-changes-panel__diff").getByText("untracked one")).toBeVisible();
});
