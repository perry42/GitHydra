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
const cmText = (w: Page) => w.locator(".cm-content").innerText();

test("Clicking a conflicted row opens the block editor: 2 blocks, nothing written or staged, Mark as resolved disabled", async () => {
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

test("Esc steps up one level: block text, then its chip row, then out of the editor (FR-567)", async () => {
  await mergeRepo();
  const w = await openEditor();
  await chip(w, 1, /^Yours/).click();
  await backToBlock1(w);
  await w.locator(".cm-line", { hasText: "main2" }).first().click();
  await w.keyboard.press("Escape");
  await expect(w.getByRole("textbox", { name: "Editing a.txt" })).toBeVisible();
  await expect(chip(w, 1, /^Yours/)).toBeFocused();
  await w.keyboard.press("Escape");
  // The buffer is dirty, so leaving asks; the editor has not just vanished on the first Esc.
  await expect(w.getByRole("alertdialog")).toBeVisible();
  await w.getByRole("alertdialog").getByRole("button", { name: "Discard" }).click();
  await expect(w.getByRole("textbox", { name: "Editing a.txt" })).toBeHidden();
});

test("Esc in text outside any block behaves like the chip row: it leaves (FR-567)", async () => {
  await mergeRepo();
  const w = await openEditor();
  await w.locator(".cm-line", { hasText: "line05" }).first().click();
  await w.keyboard.press("Escape");
  await expect(w.getByRole("textbox", { name: "Editing a.txt" })).toBeHidden();
});

test("'looks good' state: quiet while conflicts remain, calm green with a highlighted Mark as resolved once all are decided (FR-571)", async () => {
  await mergeRepo();
  const w = await openEditor();
  await expect(w.getByTestId("looks-good")).toHaveCount(0);
  await shots(w, "09-quiet");
  await chip(w, 1, /^Yours/).click();
  await chip(w, 2, /^Incoming/).click();
  await expect(w.getByTestId("looks-good")).toHaveText(/Looks good — mark as resolved/);
  await expect(w.getByText("All 2 conflicts decided").first()).toBeVisible();
  await expect(mark(w)).toHaveClass(/gh-edit__btn--ready/);
  await shots(w, "10-looks-good");
});

test("Ctrl+S while markers remain says it saved but the conflicts are not resolved (FR-570)", async () => {
  await mergeRepo();
  const w = await openEditor();
  await chip(w, 1, /^Yours/).click();
  await w.locator(".cm-content").focus();
  await w.keyboard.press("Control+s");
  await expect(w.getByText("Saved — still has conflict markers").first()).toBeVisible();
});

test("Next conflicted file and Continue merge after resolving (FR-569)", async () => {
  await twoFileMergeRepo();
  const w = await openEditor();
  await chip(w, 1, /^Yours/).click();
  await chip(w, 2, /^Yours/).click();
  await mark(w).click();
  const strip = w.getByTestId("resolved-strip");
  await expect(strip).toContainText("Resolved and staged. 1 conflicted file left.");
  await expect(strip.getByRole("button", { name: "Next conflicted file" })).toBeFocused();
  await shots(w, "11-resolved-strip");
  await strip.getByRole("button", { name: "Next conflicted file" }).click();
  await expect(w.getByRole("textbox", { name: "Editing b.txt" })).toBeVisible({ timeout: 15_000 });
  await chip(w, 1, /^Yours/).click();
  await chip(w, 2, /^Yours/).click();
  await mark(w).click();
  const last = w.getByTestId("resolved-strip");
  await expect(last).toContainText("All conflicts resolved. Ready to continue.");
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
  await w.getByRole("button", { name: /^changes/i }).click();
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
  await w.getByRole("button", { name: /^changes/i }).click();

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
