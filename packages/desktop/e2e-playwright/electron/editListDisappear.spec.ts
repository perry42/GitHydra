// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Real-Electron check of "the editor stays open when its file drops out of the Changes list"
 * (specs/edit-in-diff.md FR-532, FR-528/529/531/540, FR-473) against specs/hunk-line-staging.md FR-482 / AC20
 * (selection and open diff survive a refresh and move to the surviving row). Generated repos only.
 * Set GH_FIXTURE_ROOT to build the repos outside the package.
 */
import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { closeApp, launchGitHydra, removeUserDataDir, stubOpenRepoDialog, type LaunchedApp } from "../helpers/launchApp";
import { cleanup, commitAll, git, initRepo } from "../../src/test/gitFixture";

let handle: LaunchedApp;
let repoDir: string;
let problems: string[] = [];

test.beforeEach(async () => {
  handle = await launchGitHydra();
  problems = [];
  handle.window.on("console", (m) => {
    if (m.type() === "error") problems.push(`console.error: ${m.text()}`);
  });
  handle.window.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
});
test.afterEach(async () => {
  // A dirty buffer vetoes a polite close; closeApp destroys the windows, so teardown never hangs on the prompt.
  await closeApp(handle);
  await removeUserDataDir(handle.userDataDir);
  if (repoDir) await cleanup(repoDir);
  expect(problems, "renderer console errors / unhandled rejections").toEqual([]);
});

async function makeRepo(): Promise<string> {
  const root = process.env.GH_FIXTURE_ROOT;
  let dir: string;
  if (!root) dir = await initRepo();
  else {
    dir = await fs.mkdtemp(path.join(root, "disappear-"));
    await git(dir, ["init", "-q", "--initial-branch=main"]);
  }
  // A checkout/stash must restore the exact LF bytes the test wrote, whatever the machine's autocrlf says.
  await git(dir, ["config", "core.autocrlf", "false"]);
  return dir;
}

/**
 * Marks a test as a CONFIRMED product bug: it asserts the correct behaviour and is expected to fail until fixed
 * (Playwright then flags it if it starts passing). GH_SHOW_KNOWN_BUGS=1 runs it as an ordinary, red test.
 */
function knownBug(reason: string) {
  test.fail(!process.env.GH_SHOW_KNOWN_BUGS, reason);
}

const put = (rel: string, data: string | Buffer) => fs.writeFile(path.join(repoDir, rel), data);
const bytes = (rel: string) => fs.readFile(path.join(repoDir, rel), "utf8");
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line${String(i + 1).padStart(2, "0")}`);
const join = (ls: string[]) => ls.join("\n") + "\n";
const out = async (...args: string[]) => (await git(repoDir, args)).stdout;
const shortStatus = async () => (await out("status", "--porcelain")).trim();

async function openRepoInApp(): Promise<Page> {
  await stubOpenRepoDialog(handle.app, repoDir);
  await handle.window.getByRole("button", { name: "Open a repository", exact: true }).click();
  await handle.window.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });
  await handle.window.getByRole("button", { name: /^changes/i }).click();
  await handle.window.locator(".gh-changes-panel__file").first().waitFor({ timeout: 15_000 });
  return handle.window;
}

type Section = "Staged" | "Unstaged" | "Untracked";
const sectionOf = (w: Page, s: Section) => w.locator("section.gh-changes-panel__section", { has: w.locator("h3", { hasText: new RegExp(`^${s}`) }) });
const fileRow = (w: Page, s: Section, p: string) => sectionOf(w, s).locator("li.gh-changes-panel__file", { hasText: p });
const rowLabel = (w: Page, s: Section, p: string) => fileRow(w, s, p).locator(".gh-changes-panel__file-label");
/** A CSS locator on purpose: the collapsed rail hides markers from the accessibility tree, and a role query would then count 0 for a marker that is still in the DOM. */
const markers = (w: Page) => w.locator('[role="img"][aria-label^="Partly staged"]');
const cm = (w: Page) => w.locator(".cm-content");
const editBtn = (w: Page) => w.locator("[data-edit-button]");
const toolbar = (w: Page) => w.getByRole("toolbar", { name: "Editor actions" });
const saveBtn = (w: Page) => toolbar(w).getByRole("button", { name: "Save", exact: true });
const saveStageBtn = (w: Page) => toolbar(w).getByRole("button", { name: /^Save and stage/ });
const note = (w: Page) => w.locator(".gh-edit__note");
const banner = (w: Page) => w.locator(".gh-edit__alerts [role=alert]");
const dirtyTag = (w: Page) => w.locator(".gh-edit__state", { hasText: /^\s*Unsaved\s*$/ });

/** Every list row as `Section|rowKey` (plus `*` when it carries a partly-staged marker), in DOM order. */
const listRows = (w: Page) =>
  w.evaluate(() =>
    [...document.querySelectorAll("section.gh-changes-panel__section")].flatMap((sec) => {
      const head = sec.querySelector("h3")?.textContent?.trim().match(/^[A-Za-z]+/)?.[0] ?? "?";
      return [...sec.querySelectorAll("li.gh-changes-panel__file")].map((li) => {
        const key = li.querySelector<HTMLElement>("[data-row-key]")?.dataset.rowKey ?? "?";
        return `${head}|${key}${li.querySelector('[role="img"][aria-label^="Partly staged"]') ? "*" : ""}`;
      });
    }),
  );
/** Row keys of the multi-selection (aria-selected). */
const selKeys = (w: Page) =>
  w.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('li[role="row"][aria-selected="true"]')].map((li) => li.querySelector<HTMLElement>("[data-row-key]")!.dataset.rowKey!),
  );
/** Row keys of the OPEN diff (aria-pressed on the label). */
const openKeys = (w: Page) =>
  w.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.gh-changes-panel__file-label[aria-pressed="true"]')].map((b) => b.closest("li")!.querySelector<HTMLElement>("[data-row-key]")!.dataset.rowKey!),
  );
const sectionHeads = (w: Page) => w.evaluate(() => [...document.querySelectorAll("section.gh-changes-panel__section h3")].map((h) => h.textContent!.replace(/\s+/g, " ").trim()));

async function selectAndEdit(w: Page, s: Section, p: string) {
  await rowLabel(w, s, p).click();
  await expect(editBtn(w)).toBeEnabled();
  await editBtn(w).click();
  await expect(cm(w)).toBeVisible();
  await expect(cm(w)).toBeFocused();
}
/** Replaces the whole buffer. */
async function setBuffer(w: Page, text: string) {
  await cm(w).focus();
  await w.keyboard.press("Control+a");
  await w.keyboard.insertText(text);
}
const bufferText = (w: Page) => cm(w).evaluate((el) => [...el.querySelectorAll(".cm-line")].map((l) => l.textContent).join("\n"));
async function save(w: Page) {
  await cm(w).focus();
  await w.keyboard.press("Control+s");
}

/** Commits a 90-line f.txt, then edits it in three separated hunks (line 5, lines 30-34, lines 60-74). */
async function threeHunk(): Promise<{ base: string[]; edited: string[] }> {
  const base = lines(90);
  await put("f.txt", join(base));
  await commitAll(repoDir, "base");
  const edited = [...base];
  edited[4] = "CHANGED05";
  for (let i = 30; i <= 34; i++) edited[i - 1] = `CHANGED${i}`;
  for (let i = 60; i <= 74; i++) edited[i - 1] = `CHANGED${i}`;
  await put("f.txt", join(edited));
  return { base, edited };
}
async function openPartlyStaged(): Promise<{ w: Page; base: string[]; edited: string[] }> {
  repoDir = await makeRepo();
  const { base, edited } = await threeHunk();
  const w = await openRepoInApp();
  await rowLabel(w, "Unstaged", "f.txt").click();
  await w.getByRole("checkbox", { name: "Hunk 2 of 3" }).click();
  await expect(fileRow(w, "Staged", "f.txt")).toBeVisible({ timeout: 10_000 });
  await expect.poll(async () => (await out("diff", "--cached", "-U0")).match(/^@@/gm)?.length ?? 0).toBe(1);
  return { w, base, edited };
}


const isDisabled = (loc: ReturnType<Page["locator"]>) => loc.getAttribute("aria-disabled").then((v) => v === "true");
const footPos = (w: Page) => w.locator(".gh-edit__pos").innerText().then((t) => t.split("·")[0]!.trim());
/** The editor is still the same mounted instance and holds the text: not remounted, not closed. */
async function expectEditorOpen(w: Page, text?: string) {
  await expect(w.locator(".gh-edit")).toHaveCount(1);
  await expect(cm(w)).toHaveCount(1);
  if (text !== undefined) expect(await bufferText(w)).toBe(text);
}
const rowsNoMarker = (w: Page) => listRows(w).then((r) => r.map((x) => x.replace(/\*$/, "")));
const rowActions = (w: Page, s: Section, p: string) => fileRow(w, s, p).locator(".gh-changes-panel__file-actions button");
const text = (ls: string[]) => ls.join("\n");

test("A) unstaged-only file: buffer edited back to exactly HEAD and saved leaves the list; editor stays open and clean; typing brings it back", async () => {
  repoDir = await makeRepo();
  await put("f.txt", "one\ntwo\nthree\n");
  await put("other.txt", "keep\n");
  await commitAll(repoDir, "base");
  await put("f.txt", "one\nTWO\nthree\n");
  const w = await openRepoInApp();
  await selectAndEdit(w, "Unstaged", "f.txt");
  expect(await listRows(w)).toEqual(["Unstaged|unstaged:f.txt"]);

  await setBuffer(w, "one\ntwo\nthree");
  await expect(dirtyTag(w)).toBeVisible();
  await expect(saveBtn(w)).not.toHaveAttribute("aria-disabled", "true");
  // While dirty the row's actions are locked (FR-531); the disk (and so the list) is untouched.
  for (const b of await rowActions(w, "Unstaged", "f.txt").all()) await expect(b).toHaveAttribute("aria-disabled", "true");
  expect(await listRows(w)).toEqual(["Unstaged|unstaged:f.txt"]);
  const caret = await footPos(w);

  await save(w);
  await expect.poll(() => listRows(w)).toEqual([]);
  expect(await bytes("f.txt")).toBe("one\ntwo\nthree\n");
  expect(await shortStatus()).toBe("");
  expect(await out("diff")).toBe("");
  expect(await out("diff", "--cached")).toBe("");
  expect(await sectionHeads(w)).toEqual(["Staged (0)", "Unstaged (0)", "Untracked (0)", "Conflicted (0)"]);

  // Editor: same instance, text and caret intact, clean, nothing to save, no banner/note, focus kept.
  await expectEditorOpen(w, "one\ntwo\nthree");
  expect(await footPos(w)).toBe(caret);
  await expect(dirtyTag(w)).toHaveCount(0);
  await expect(saveBtn(w)).toHaveAttribute("aria-disabled", "true");
  await expect(saveStageBtn(w)).toHaveAttribute("aria-disabled", "true");
  await expect(saveBtn(w)).toHaveAttribute("title", "No unsaved edits");
  await expect(banner(w)).toHaveCount(0);
  await expect(note(w)).toHaveCount(0);
  await expect(cm(w)).toBeFocused();
  expect(await openKeys(w)).toEqual([]);
  expect(await selKeys(w)).toEqual([]);
  // The state is stable: a later live refresh does not close the editor or resurrect a row.
  await put("later.txt", "x\n");
  await expect.poll(() => listRows(w)).toEqual(["Untracked|untracked:later.txt"]);
  await expectEditorOpen(w, "one\ntwo\nthree");
  await fs.rm(path.join(repoDir, "later.txt"));

  // Typing and saving again makes the file reappear as Unstaged, with the editor still the same one.
  await cm(w).focus();
  await w.keyboard.press("Control+End");
  await w.keyboard.type("!");
  await expect(dirtyTag(w)).toBeVisible();
  expect(await listRows(w)).not.toContain("Unstaged|unstaged:f.txt"); // unsaved edits are not on disk yet
  await save(w);
  await expect.poll(() => listRows(w)).toContain("Unstaged|unstaged:f.txt");
  expect(await bytes("f.txt")).toBe("one\ntwo\nthree!\n");
  await expectEditorOpen(w, "one\ntwo\nthree!");
  await expect(saveBtn(w)).toHaveAttribute("aria-disabled", "true");
  await expect(cm(w)).toBeFocused();
});

test("B) partly staged: editing away every unstaged hunk leaves only the Staged row; selection and editor survive; editing again restores two rows", async () => {
  const { w, base } = await openPartlyStaged();
  const stagedCopy = [...base];
  for (let i = 30; i <= 34; i++) stagedCopy[i - 1] = `CHANGED${i}`;
  const cachedBefore = await out("diff", "--cached");
  await selectAndEdit(w, "Unstaged", "f.txt");
  expect(await listRows(w)).toEqual(["Staged|staged:f.txt*", "Unstaged|unstaged:f.txt*"]);
  expect(await openKeys(w)).toEqual(["unstaged:f.txt"]);
  await expect(note(w)).toContainText("Editing the working copy. Your staged version is unchanged.");

  await setBuffer(w, text(stagedCopy));
  await save(w);
  await expect.poll(() => listRows(w)).toEqual(["Staged|staged:f.txt"]);

  // git truth: fully staged, worktree == index, nothing lost, index untouched by the save.
  expect(await out("diff")).toBe("");
  expect(await out("diff", "--cached")).toBe(cachedBefore);
  expect(await bytes("f.txt")).toBe(join(stagedCopy));
  expect(await shortStatus()).toBe("M  f.txt");
  // UI: selection and "open diff" moved to the surviving row; editor, buffer and the staged-copy note persist.
  await expect.poll(() => openKeys(w)).toEqual(["staged:f.txt"]);
  expect(await selKeys(w)).toEqual(["staged:f.txt"]);
  expect(await markers(w).count()).toBe(0);
  await expectEditorOpen(w, text(stagedCopy));
  await expect(note(w)).toContainText("Editing the working copy. Your staged version is unchanged.");
  await expect(w.locator(".gh-edit__tag", { hasText: "Working copy" })).toBeVisible();
  await expect(saveBtn(w)).toHaveAttribute("aria-disabled", "true");
  // Index == worktree, so there is nothing for "Save and stage" to add.
  await expect(saveStageBtn(w)).toHaveAttribute("aria-disabled", "true");
  await expect(saveStageBtn(w)).toHaveText("Save and stage whole file");
  await expect(cm(w)).toBeFocused();
  // The Staged row's only action (Unstage) is available again now the buffer is clean.
  await expect(rowActions(w, "Staged", "f.txt")).toHaveCount(1);
  await expect(rowActions(w, "Staged", "f.txt").first()).not.toHaveAttribute("aria-disabled", "true");

  // Edit again: the Unstaged row (and both markers) return.
  await cm(w).focus();
  await w.keyboard.press("Control+End");
  await w.keyboard.type("tail");
  await save(w);
  await expect.poll(() => listRows(w)).toEqual(["Staged|staged:f.txt*", "Unstaged|unstaged:f.txt*"]);
  expect(await out("diff", "--cached")).toBe(cachedBefore);
  expect((await out("diff")).includes("tail")).toBe(true);
  await expectEditorOpen(w);
  await expect(note(w)).toContainText("Editing the working copy.");
});

test("C) partly staged: deleting the lines of the STAGED hunk makes it ambiguous: both rows, no marker, no checkboxes, FR-540 note; nothing is lost", async () => {
  const { w, edited } = await openPartlyStaged();
  const withoutStaged = edited.filter((_, i) => i < 29 || i > 33);
  const cachedBefore = await out("diff", "--cached");
  await selectAndEdit(w, "Staged", "f.txt");
  await setBuffer(w, text(withoutStaged));
  await save(w);

  await expect(w.locator(".gh-edit__note", { hasText: "This line was already staged." })).toBeVisible({ timeout: 15_000 });
  await expect(w.locator(".gh-edit__note", { hasText: "This line was already staged." })).toContainText("Your edit is unstaged on top of it. Use Unstage on the Staged row, or Save and stage whole file.");
  expect(await listRows(w)).toEqual(["Staged|staged:f.txt", "Unstaged|unstaged:f.txt"]);
  expect(await markers(w).count()).toBe(0);
  // What git says: the index still has the staged hunk; the worktree removes those lines on top of it.
  expect(await out("diff", "--cached")).toBe(cachedBefore);
  const wt = await out("diff");
  for (let i = 30; i <= 34; i++) expect(wt).toContain(`-CHANGED${i}`);
  expect(await bytes("f.txt")).toBe(join(withoutStaged));
  expect(await shortStatus()).toBe("MM f.txt");
  await expectEditorOpen(w, text(withoutStaged));
  // Editor stays: staged-copy note, Working copy tag, clean buffer; Save-and-stage is the way out (enabled: index differs).
  await expect(note(w).first()).toContainText("Editing the working copy.");
  await expect(saveBtn(w)).toHaveAttribute("aria-disabled", "true");
  await expect(saveStageBtn(w)).not.toHaveAttribute("aria-disabled", "true");
  await expect(cm(w)).toBeFocused();
  // Leaving the editor shows the separate diffs, no hunk checkboxes.
  await w.getByRole("button", { name: "Back to diff" }).click();
  await expect(cm(w)).toHaveCount(0);
  await expect(w.getByRole("checkbox")).toHaveCount(0);
  await expect(w.getByText("Line-level staging unavailable for this file.")).toBeVisible();
});

test("C2) ambiguous file: Save and stage whole file with the buffer at HEAD makes index == worktree == HEAD; the file leaves the list, editor stays", async () => {
  const { w, base, edited } = await openPartlyStaged();
  await selectAndEdit(w, "Staged", "f.txt");
  await setBuffer(w, text(edited.filter((_, i) => i < 29 || i > 33)));
  await save(w);
  await expect(w.locator(".gh-edit__note", { hasText: "This line was already staged." })).toBeVisible({ timeout: 15_000 });
  await setBuffer(w, text(base));
  await expect(dirtyTag(w)).toBeVisible();
  // Dirty: Stage/Unstage/Discard on both rows are locked with the reason.
  for (const s of ["Staged", "Unstaged"] as const)
    for (const b of await rowActions(w, s, "f.txt").all()) await expect(b).toHaveAttribute("aria-disabled", "true");
  await w.keyboard.press("Control+Shift+s");
  await expect.poll(() => listRows(w)).toEqual([]);
  expect(await shortStatus()).toBe("");
  expect(await out("diff", "--cached")).toBe("");
  expect(await out("diff")).toBe("");
  expect(await bytes("f.txt")).toBe(join(base));
  await expectEditorOpen(w, text(base));
  await expect(dirtyTag(w)).toHaveCount(0);
  await expect(saveBtn(w)).toHaveAttribute("aria-disabled", "true");
  await expect(saveStageBtn(w)).toHaveAttribute("aria-disabled", "true");
  await expect(banner(w)).toHaveCount(0);
  await expect(cm(w)).toBeFocused();
});

test("C3) ambiguous file: Unstage on the Staged row restores index == HEAD with the worktree bytes untouched; editor stays", async () => {
  const { w, edited } = await openPartlyStaged();
  const withoutStaged = edited.filter((_, i) => i < 29 || i > 33);
  await selectAndEdit(w, "Staged", "f.txt");
  await setBuffer(w, text(withoutStaged));
  await save(w);
  await expect(w.locator(".gh-edit__note", { hasText: "This line was already staged." })).toBeVisible({ timeout: 15_000 });
  const before = await bytes("f.txt");
  await unstageStagedRow(w);
  await expect.poll(() => listRows(w)).toEqual(["Unstaged|unstaged:f.txt"]);
  // The row leaves optimistically; git finishes a moment later.
  await expect.poll(() => out("diff", "--cached")).toBe("");
  expect(await bytes("f.txt")).toBe(before);
  expect(await shortStatus()).toBe("M f.txt");
  await expectEditorOpen(w, text(withoutStaged));
  await expect.poll(() => openKeys(w)).toEqual(["unstaged:f.txt"]);
});

test("D) partly staged where the buffer is saved equal to HEAD (net no change) but the index differs: two rows, no crash; Unstage clears the file", async () => {
  const { w, base } = await openPartlyStaged();
  await selectAndEdit(w, "Unstaged", "f.txt");
  await setBuffer(w, text(base));
  await save(w);
  await expect.poll(() => bytes("f.txt")).toBe(join(base));
  // git: HEAD == worktree, index has the staged hunk: a staged change and its exact reverse.
  await expect.poll(() => shortStatus()).toBe("MM f.txt");
  await expect.poll(() => rowsNoMarker(w)).toEqual(["Staged|staged:f.txt", "Unstaged|unstaged:f.txt"]);
  expect((await out("diff", "--cached")).match(/^@@/gm)).toHaveLength(1);
  await expectEditorOpen(w, text(base));
  await expect(note(w).first()).toContainText("Editing the working copy.");
  await expect(saveBtn(w)).toHaveAttribute("aria-disabled", "true");
  await expect(saveStageBtn(w)).not.toHaveAttribute("aria-disabled", "true");
  await expect(cm(w)).toBeFocused();

  await unstageStagedRow(w);
  await expect.poll(() => listRows(w)).toEqual([]);
  await expect.poll(() => shortStatus()).toBe("");
  expect(await bytes("f.txt")).toBe(join(base));
  await expectEditorOpen(w, text(base));
  await expect(saveStageBtn(w)).toHaveAttribute("aria-disabled", "true");
});

test("E) staged-only file: an edit makes it partly staged (two rows with markers) and the staged copy stays byte-identical", async () => {
  repoDir = await makeRepo();
  const base = lines(60);
  await put("f.txt", join(base));
  await commitAll(repoDir, "base");
  const staged = [...base];
  staged[9] = "STAGED10";
  await put("f.txt", join(staged));
  await git(repoDir, ["add", "f.txt"]);
  const w = await openRepoInApp();
  expect(await listRows(w)).toEqual(["Staged|staged:f.txt"]);
  const cachedBefore = await out("diff", "--cached");
  await selectAndEdit(w, "Staged", "f.txt");
  await expect(note(w)).toContainText("Editing the working copy.");
  await expect(saveStageBtn(w)).toHaveAttribute("aria-disabled", "true"); // nothing differs yet

  await cm(w).focus();
  await w.keyboard.press("Control+End");
  await w.keyboard.type("more");
  await save(w);
  await expect.poll(() => listRows(w)).toEqual(["Staged|staged:f.txt*", "Unstaged|unstaged:f.txt*"]);
  expect(await out("diff", "--cached")).toBe(cachedBefore);
  expect(await shortStatus()).toBe("MM f.txt");
  await expect.poll(() => openKeys(w)).toEqual(["staged:f.txt"]); // the open row did not jump
  await expectEditorOpen(w);
  await expect(note(w)).toContainText("Editing the working copy.");
  await expect(saveStageBtn(w)).not.toHaveAttribute("aria-disabled", "true"); // the worktree now differs from the index
  await expect(cm(w)).toBeFocused();
  // Leaving the editor shows the combined diff with the staged hunk ticked and the new one not.
  await w.getByRole("button", { name: "Back to diff" }).click();
  await expect(w.getByRole("checkbox", { name: "Hunk 1 of 2" })).toHaveAttribute("aria-checked", "true");
  await expect(w.getByRole("checkbox", { name: "Hunk 2 of 2" })).toHaveAttribute("aria-checked", "false");
});

/**
 * Clicks Unstage on the Staged row. A background git read (status/diff) can briefly hold .git/index.lock and make the
 * mutation fail with a visible "Unable to create index.lock" alert (PRODUCT RACE, see report; gitProcess.ts only queues
 * mutations against each other). A user would just click again, so do that, but record each race as a test annotation.
 */
async function unstageStagedRow(w: Page) {
  for (let attempt = 0; attempt < 4; attempt++) {
    await fileRow(w, "Staged", "f.txt").hover();
    const btn = rowActions(w, "Staged", "f.txt").first();
    await expect(btn).not.toHaveAttribute("aria-disabled", "true");
    await btn.click();
    const lockAlert = w.locator("[role=alert]", { hasText: "index.lock" });
    const done = expect.poll(() => out("diff", "--cached", "--", "f.txt"), { timeout: 4_000 }).toBe("").then(() => true, () => false);
    if (await done) return;
    expect(await lockAlert.count(), "Unstage did nothing and there is no index.lock alert").toBeGreaterThan(0);
    test.info().annotations.push({ type: "index.lock race", description: `Unstage failed on attempt ${attempt + 1}` });
    await lockAlert.getByRole("button", { name: "Dismiss" }).click();
  }
}

const GONE_MSG = "The file does not exist in the working tree. Your editor still holds the last version.";
const closeTabBtn = (w: Page) => w.getByRole("button", { name: /^Close .* tab$/ });
const leaveDialog = (w: Page) => w.getByRole("alertdialog");

/** The ambiguous state of scenario C: the staged hunk's lines deleted from the worktree, saved. */
async function openAmbiguous() {
  const s = await openPartlyStaged();
  const withoutStaged = s.edited.filter((_, i) => i < 29 || i > 33);
  await selectAndEdit(s.w, "Staged", "f.txt");
  await setBuffer(s.w, text(withoutStaged));
  await save(s.w);
  await expect(s.w.locator(".gh-edit__note", { hasText: "This line was already staged." })).toBeVisible({ timeout: 15_000 });
  return { ...s, withoutStaged };
}

// ------------------------------------------------------------------ stale "staged copy" state (FR-528)

test("C3b) FR-528: after Unstage on the Staged row the index equals HEAD, so the 'Editing the working copy' note and tag go away", async () => {
  knownBug("BUG: EditorPane's staged-copy note/tag read meta.hasStagedContent, which is re-probed only after a save (useEditSession.refreshProbe), not after a row action or external index change");
  const { w } = await openAmbiguous();
  await unstageStagedRow(w);
  await expect.poll(() => out("diff", "--cached")).toBe("");
  await expect(w.locator(".gh-edit__note", { hasText: "Editing the working copy." })).toHaveCount(0, { timeout: 5_000 });
  await expect(w.locator(".gh-edit__tag", { hasText: "Working copy" })).toHaveCount(0);
  await expect(saveStageBtn(w)).toHaveText("Save and stage");
});

// FLAKY PRODUCT RACE (passes ~5 runs in 6): the verdict cache key is status-only (useMixedFilePaths.ts `signature`), so "MM" -> "MM"
// never re-runs the verdict; the marker clears only if the open diff's `known` verdict happens to be refreshed after the save.
test.fixme("D2) the partly-staged markers on both rows go away when the saved buffer nets to HEAD (no line-level staging is possible)", async () => {
  const { w, base } = await openPartlyStaged();
  await selectAndEdit(w, "Unstaged", "f.txt");
  await setBuffer(w, text(base));
  await save(w);
  await expect.poll(() => shortStatus()).toBe("MM f.txt");
  await expect.poll(() => rowsNoMarker(w)).toEqual(["Staged|staged:f.txt", "Unstaged|unstaged:f.txt"]);
  await expect(markers(w)).toHaveCount(0, { timeout: 5_000 });
});

// ------------------------------------------------------------------ F) file deleted on disk while the editor is open

test("F1) clean buffer, file deleted externally: row shows Deleted, editor holds the last version, Save and stage is disabled and cannot stage a deletion", async () => {
  repoDir = await makeRepo();
  await put("f.txt", "one\ntwo\nthree\n");
  await put("other.txt", "keep\n");
  await commitAll(repoDir, "base");
  await put("f.txt", "one\nTWO\nthree\n");
  const w = await openRepoInApp();
  await selectAndEdit(w, "Unstaged", "f.txt");
  await fs.rm(path.join(repoDir, "f.txt"));

  await expect(fileRow(w, "Unstaged", "f.txt").getByText("Deleted:")).toHaveCount(1, { timeout: 15_000 });
  await expect(fileRow(w, "Unstaged", "f.txt").locator(".gh-file-status-icon")).toHaveText("D");
  await expect(banner(w)).toContainText(GONE_MSG, { timeout: 15_000 });
  await expect(banner(w).getByRole("button", { name: "Dismiss" })).toBeVisible();
  expect(await shortStatus()).toBe("D f.txt");
  await expectEditorOpen(w, "one\nTWO\nthree\n");
  await expect(saveBtn(w)).toHaveAttribute("aria-disabled", "true");
  await expect(saveStageBtn(w)).toHaveAttribute("aria-disabled", "true");
  await expect(dirtyTag(w)).toHaveCount(0);
  await expect(cm(w)).toBeFocused();
  // Neither the button nor the shortcut may stage the deletion or recreate the file.
  await saveStageBtn(w).click({ force: true });
  await w.keyboard.press("Control+Shift+s");
  await w.keyboard.press("Control+s");
  await w.waitForTimeout(600); // negative check: give a wrongly enabled action time to act
  expect(await out("diff", "--cached")).toBe("");
  expect(await shortStatus()).toBe("D f.txt");
  await expect(fs.access(path.join(repoDir, "f.txt"))).rejects.toThrow();
  expect(await openKeys(w)).toEqual(["unstaged:f.txt"]);
});

test("F2) dirty buffer, file deleted externally: buffer kept, leave prompt still protects it; re-created file raises the changed-on-disk banner and Reload adopts it", async () => {
  repoDir = await makeRepo();
  await put("f.txt", "one\ntwo\nthree\n");
  await commitAll(repoDir, "base");
  await put("f.txt", "one\nTWO\nthree\n");
  const w = await openRepoInApp();
  await selectAndEdit(w, "Unstaged", "f.txt");
  await w.keyboard.type("mine ");
  await fs.rm(path.join(repoDir, "f.txt"));
  await expect(banner(w)).toContainText(GONE_MSG, { timeout: 15_000 });
  await expect(fileRow(w, "Unstaged", "f.txt").getByText("Deleted:")).toHaveCount(1);
  await expectEditorOpen(w, "mine one\nTWO\nthree\n");
  await expect(dirtyTag(w)).toBeVisible();
  await expect(cm(w)).toBeFocused();
  // The row's actions stay locked while the buffer is dirty, even for a deleted file.
  for (const b of await rowActions(w, "Unstaged", "f.txt").all()) await expect(b).toHaveAttribute("aria-disabled", "true");
  // Leaving still asks; Cancel keeps everything.
  await w.keyboard.press("Escape");
  await expect(leaveDialog(w)).toBeVisible();
  await expect(leaveDialog(w).getByRole("button", { name: "Save", exact: true })).toBeFocused();
  await leaveDialog(w).getByRole("button", { name: "Cancel" }).click();
  await expect(leaveDialog(w)).toHaveCount(0);
  await expectEditorOpen(w, "mine one\nTWO\nthree\n");
  await expect(cm(w)).toBeFocused();

  // The file comes back with other content: the banner turns into the FR-473 one, nothing is overwritten.
  await put("f.txt", "one\nRECREATED\nthree\n");
  await expect(banner(w)).toContainText("changed on disk. Neither version was overwritten.", { timeout: 15_000 });
  await expect(banner(w).getByRole("button", { name: "Reload" })).toBeVisible();
  await expect(banner(w).getByRole("button", { name: "Keep mine" })).toBeVisible();
  expect(await bytes("f.txt")).toBe("one\nRECREATED\nthree\n");
  expect(await bufferText(w)).toBe("mine one\nTWO\nthree\n");
  await banner(w).getByRole("button", { name: "Reload" }).click();
  const ask = leaveDialog(w);
  await expect(ask).toBeVisible();
  await expect(ask.getByRole("button", { name: "Cancel" })).toBeFocused();
  await ask.getByRole("button", { name: "Reload" }).click();
  await expect.poll(() => bufferText(w)).toBe("one\nRECREATED\nthree\n");
  await expect(dirtyTag(w)).toHaveCount(0);
  await expect(banner(w)).toHaveCount(0);
  expect(await bytes("f.txt")).toBe("one\nRECREATED\nthree\n");
});

test("F3) dirty buffer, file deleted externally: Save and Save-and-stage write nothing and stage nothing; the buffer survives with an error", async () => {
  repoDir = await makeRepo();
  await put("f.txt", "one\ntwo\nthree\n");
  await commitAll(repoDir, "base");
  await put("f.txt", "one\nTWO\nthree\n");
  const w = await openRepoInApp();
  await selectAndEdit(w, "Unstaged", "f.txt");
  await w.keyboard.type("mine ");
  await fs.rm(path.join(repoDir, "f.txt"));
  await expect(banner(w)).toContainText(GONE_MSG, { timeout: 15_000 });
  await w.keyboard.press("Control+s");
  await expect(banner(w).filter({ hasText: "Couldn't save." })).toHaveCount(1);
  await banner(w).filter({ hasText: "Couldn't save." }).getByRole("button", { name: "Dismiss" }).click();
  await cm(w).focus();
  await w.keyboard.press("Control+Shift+s");
  await expect(banner(w).filter({ hasText: "Couldn't save." })).toHaveCount(1);
  await expect(leaveDialog(w)).toHaveCount(0);
  await expect(fs.access(path.join(repoDir, "f.txt"))).rejects.toThrow();
  expect(await shortStatus()).toBe("D f.txt");
  expect(await out("diff", "--cached")).toBe("");
  await expectEditorOpen(w, "mine one\nTWO\nthree\n");
  await expect(dirtyTag(w)).toBeVisible();
  await expect(banner(w).filter({ hasText: GONE_MSG })).toHaveCount(1);
});

// ------------------------------------------------------------------ G) the file leaves the list because of an external git change

test("G1) clean buffer, external git checkout: list empties, editor reloads quietly to HEAD, nothing else moves", async () => {
  repoDir = await makeRepo();
  await put("f.txt", "one\ntwo\nthree\n");
  await commitAll(repoDir, "base");
  await put("f.txt", "one\nTWO\nthree\n");
  const w = await openRepoInApp();
  await selectAndEdit(w, "Unstaged", "f.txt");
  await git(repoDir, ["checkout", "--", "f.txt"]);
  await expect.poll(() => listRows(w), { timeout: 15_000 }).toEqual([]);
  await expect(w.locator(".gh-edit__stat")).toHaveText("Reloaded from disk", { timeout: 15_000 });
  await expectEditorOpen(w, "one\ntwo\nthree\n");
  await expect(banner(w)).toHaveCount(0);
  await expect(dirtyTag(w)).toHaveCount(0);
  await expect(saveBtn(w)).toHaveAttribute("aria-disabled", "true");
  await expect(saveStageBtn(w)).toHaveAttribute("aria-disabled", "true");
  await expect(cm(w)).toBeFocused();
  expect(await shortStatus()).toBe("");
  expect(await bytes("f.txt")).toBe("one\ntwo\nthree\n");
});

for (const how of ["checkout", "stash"] as const) {
  test(`G2) dirty buffer, external git ${how}: list empties, buffer kept, changed-on-disk banner, disk never overwritten; Keep mine + Save asks first`, async () => {
    repoDir = await makeRepo();
    await put("f.txt", "one\ntwo\nthree\n");
    await commitAll(repoDir, "base");
    await put("f.txt", "one\nTWO\nthree\n");
    const w = await openRepoInApp();
    await selectAndEdit(w, "Unstaged", "f.txt");
    await w.keyboard.type("mine ");
    await git(repoDir, how === "stash" ? ["stash"] : ["checkout", "--", "f.txt"]);
    await expect.poll(() => listRows(w), { timeout: 15_000 }).toEqual([]);
    await expect(banner(w)).toContainText("changed on disk. Neither version was overwritten.", { timeout: 15_000 });
    expect(await bytes("f.txt")).toBe("one\ntwo\nthree\n"); // the app did not touch the disk
    await expectEditorOpen(w, "mine one\nTWO\nthree\n");
    await expect(dirtyTag(w)).toBeVisible();
    await expect(saveBtn(w)).not.toHaveAttribute("aria-disabled", "true");
    await expect(cm(w)).toBeFocused();
    if (how === "stash") expect((await out("stash", "list")).trim().split("\n")).toHaveLength(1);

    await banner(w).getByRole("button", { name: "Keep mine" }).click();
    await expect(cm(w)).toBeFocused();
    await w.keyboard.press("Control+s");
    await expect(leaveDialog(w)).toBeVisible();
    await expect(leaveDialog(w).getByRole("button", { name: "Cancel" })).toBeFocused();
    await leaveDialog(w).getByRole("button", { name: "Cancel" }).click();
    await expect(leaveDialog(w)).toHaveCount(0);
    expect(await bytes("f.txt")).toBe("one\ntwo\nthree\n");
    expect(await bufferText(w)).toBe("mine one\nTWO\nthree\n");
    // Overwrite is an explicit yes and writes exactly the buffer; the file is back in the list.
    await expect(cm(w)).toBeFocused();
    await w.keyboard.press("Control+s");
    await leaveDialog(w).getByRole("button", { name: "Overwrite" }).click();
    await expect.poll(() => bytes("f.txt")).toBe("mine one\nTWO\nthree\n");
    await expect.poll(() => listRows(w)).toEqual(["Unstaged|unstaged:f.txt"]);
    await expect(dirtyTag(w)).toHaveCount(0);
  });
}

test("G4) partly staged, clean buffer, external git reset: Staged row leaves, selection and open diff move to Unstaged, editor and buffer stay", async () => {
  const { w } = await openPartlyStaged();
  await selectAndEdit(w, "Staged", "f.txt");
  const buf = await bufferText(w);
  await git(repoDir, ["reset", "-q"]);
  await expect.poll(() => listRows(w), { timeout: 15_000 }).toEqual(["Unstaged|unstaged:f.txt"]);
  await expect.poll(() => openKeys(w)).toEqual(["unstaged:f.txt"]);
  expect(await selKeys(w)).toEqual(["unstaged:f.txt"]);
  await expectEditorOpen(w, buf);
  await expect(banner(w)).toHaveCount(0);
  await expect(dirtyTag(w)).toHaveCount(0);
  await expect(cm(w)).toBeFocused();
  expect(await out("diff", "--cached")).toBe("");
});

test("G4b) FR-528: after an external git reset the index equals HEAD, so the staged-copy note and 'Save and stage whole file' label go away", async () => {
  knownBug("BUG: same root cause as C3b: meta.hasStagedContent is only re-probed after a save");
  const { w } = await openPartlyStaged();
  await selectAndEdit(w, "Staged", "f.txt");
  await git(repoDir, ["reset", "-q"]);
  await expect.poll(() => listRows(w), { timeout: 15_000 }).toEqual(["Unstaged|unstaged:f.txt"]);
  await expect(w.locator(".gh-edit__note", { hasText: "Editing the working copy." })).toHaveCount(0, { timeout: 5_000 });
  await expect(saveStageBtn(w)).toHaveText("Save and stage");
});

test("G6) unstaged-only file, external git add: row moves to Staged, selection follows, editor stays; the staged-copy note appears (FR-528)", async () => {
  repoDir = await makeRepo();
  await put("f.txt", "one\ntwo\nthree\n");
  await commitAll(repoDir, "base");
  await put("f.txt", "one\nTWO\nthree\n");
  const w = await openRepoInApp();
  await selectAndEdit(w, "Unstaged", "f.txt");
  await expect(note(w)).toHaveCount(0);
  await git(repoDir, ["add", "f.txt"]);
  await expect.poll(() => listRows(w), { timeout: 15_000 }).toEqual(["Staged|staged:f.txt"]);
  await expect.poll(() => openKeys(w)).toEqual(["staged:f.txt"]);
  expect(await selKeys(w)).toEqual(["staged:f.txt"]);
  await expectEditorOpen(w, "one\nTWO\nthree\n");
  await expect(cm(w)).toBeFocused();
  await expect(saveStageBtn(w)).toHaveAttribute("aria-disabled", "true"); // index == worktree
});

test("G6b) FR-528: after an external git add the index differs from HEAD, so the 'Editing the working copy' note and tag appear", async () => {
  knownBug("BUG: meta.hasStagedContent is only re-probed after a save, so an external stage never raises the note (root cause shared with C3b/G4b)");
  repoDir = await makeRepo();
  await put("f.txt", "one\ntwo\nthree\n");
  await commitAll(repoDir, "base");
  await put("f.txt", "one\nTWO\nthree\n");
  const w = await openRepoInApp();
  await selectAndEdit(w, "Unstaged", "f.txt");
  await git(repoDir, ["add", "f.txt"]);
  await expect.poll(() => listRows(w), { timeout: 15_000 }).toEqual(["Staged|staged:f.txt"]);
  await expect(note(w)).toContainText("Editing the working copy.", { timeout: 5_000 });
  await expect(w.locator(".gh-edit__tag", { hasText: "Working copy" })).toBeVisible();
});

// ------------------------------------------------------------------ H) selection, guard and keyboard once the row is gone

async function twoFilesOneVanished() {
  repoDir = await makeRepo();
  await put("a.txt", "a1\na2\n");
  await put("f.txt", "one\ntwo\nthree\n");
  await put("z.txt", "z1\nz2\n");
  await commitAll(repoDir, "base");
  await put("a.txt", "a1\nA2\n");
  await put("f.txt", "one\nTWO\nthree\n");
  await put("z.txt", "z1\nZ2\n");
  const w = await openRepoInApp();
  await selectAndEdit(w, "Unstaged", "f.txt");
  await setBuffer(w, "one\ntwo\nthree");
  await save(w);
  await expect.poll(() => listRows(w)).toEqual(["Unstaged|unstaged:a.txt", "Unstaged|unstaged:z.txt"]);
  return w;
}

test("H1) with the file gone from the list, typing then clicking another row asks Save / Discard / Cancel; Cancel keeps the buffer, Discard leaves the disk alone", async () => {
  const w = await twoFilesOneVanished();
  await cm(w).focus();
  await w.keyboard.press("Control+End");
  await w.keyboard.type("X");
  await expect(dirtyTag(w)).toBeVisible();
  await rowLabel(w, "Unstaged", "z.txt").click();
  await expect(leaveDialog(w)).toBeVisible();
  await expect(leaveDialog(w).getByRole("button", { name: "Save", exact: true })).toBeFocused();
  await leaveDialog(w).getByRole("button", { name: "Cancel" }).click();
  await expectEditorOpen(w, "one\ntwo\nthreeX");
  await expect(dirtyTag(w)).toBeVisible();
  expect(await bytes("f.txt")).toBe("one\ntwo\nthree\n");
  await rowLabel(w, "Unstaged", "z.txt").click();
  await leaveDialog(w).getByRole("button", { name: "Discard" }).click();
  await expect(cm(w)).toHaveCount(0);
  expect(await bytes("f.txt")).toBe("one\ntwo\nthree\n");
  expect(await shortStatus()).toBe("M a.txt\n M z.txt"); // (the helper trims the leading space of the first line)
  await expect.poll(() => openKeys(w)).toEqual(["unstaged:z.txt"]);
});

test("H2) with the file gone from the list, closing the repo tab with a dirty buffer asks first; Cancel keeps tab and buffer, Discard closes it", async () => {
  const w = await twoFilesOneVanished();
  await cm(w).focus();
  await w.keyboard.type("X");
  await closeTabBtn(w).click();
  await expect(leaveDialog(w)).toBeVisible();
  await leaveDialog(w).getByRole("button", { name: "Cancel" }).click();
  await expect(w.getByRole("tab")).toHaveCount(1);
  await expectEditorOpen(w, "one\ntwo\nthreeX");
  await expect(cm(w)).toBeFocused();
  await closeTabBtn(w).click();
  await leaveDialog(w).getByRole("button", { name: "Discard" }).click();
  await expect(w.getByRole("tab")).toHaveCount(0);
  expect(await bytes("f.txt")).toBe("one\ntwo\nthree\n");
});

test("H3) no editor: when the open file's changes disappear externally the pane says so and shows no stale hunks", async () => {
  repoDir = await makeRepo();
  await put("f.txt", "one\ntwo\nthree\n");
  await put("g.txt", "g1\ng2\n");
  await commitAll(repoDir, "base");
  await put("f.txt", "one\nTWO\nthree\n");
  await put("g.txt", "g1\nG2\n");
  const w = await openRepoInApp();
  await rowLabel(w, "Unstaged", "f.txt").click();
  await expect(w.locator(".gh-diff-view__line", { hasText: "TWO" }).first()).toBeVisible();
  await git(repoDir, ["checkout", "--", "f.txt"]);
  await expect(w.getByText("This file no longer has changes.")).toBeVisible({ timeout: 15_000 });
  await expect(w.locator(".gh-diff-view__line")).toHaveCount(0);
  await expect(w.getByRole("checkbox")).toHaveCount(0);
  expect(await listRows(w)).toEqual(["Unstaged|unstaged:g.txt"]);
  expect(await openKeys(w)).toEqual([]);
  expect(await selKeys(w)).toEqual([]); // no row to hold a selection; g.txt is NOT silently picked for the user
});

test("H4) after the edited file vanished, Back to diff shows no stale diff and arrow keys on the remaining rows still work", async () => {
  const w = await twoFilesOneVanished();
  await w.getByRole("button", { name: "Back to diff" }).click();
  await expect(cm(w)).toHaveCount(0);
  await expect(editBtn(w).or(w.getByText(/no longer has changes|No diff found|Select a file/i)).first()).toBeVisible();
  await expect(w.locator(".gh-diff-view__line", { hasText: "TWO" })).toHaveCount(0);
  await expect(w.locator(".gh-diff-view__line", { hasText: "three" })).toHaveCount(0);
  const key = (k: string) => w.locator(`[data-row-key="${k}"]`);
  await key("unstaged:a.txt").focus();
  await w.keyboard.press("ArrowDown");
  await expect(key("unstaged:z.txt")).toBeFocused();
  await w.keyboard.press("ArrowDown");
  await expect(key("unstaged:z.txt")).toBeFocused(); // end of the list: stays, does not run off into nothing
  await w.keyboard.press("ArrowUp");
  await expect(key("unstaged:a.txt")).toBeFocused();
  await w.keyboard.press("Enter");
  await expect.poll(() => openKeys(w)).toEqual(["unstaged:a.txt"]);
});

// ------------------------------------------------------------------ I) two files, one disappears

test("I1) no editor, two files: the unselected one disappears; selection, open diff and focus stay on the other", async () => {
  repoDir = await makeRepo();
  await put("a.txt", "a1\na2\n");
  await put("b.txt", "b1\nb2\n");
  await commitAll(repoDir, "base");
  await put("a.txt", "a1\nA2\n");
  await put("b.txt", "b1\nB2\n");
  const w = await openRepoInApp();
  await rowLabel(w, "Unstaged", "b.txt").click();
  await expect(w.locator(".gh-diff-view__line", { hasText: "B2" }).first()).toBeVisible();
  await git(repoDir, ["checkout", "--", "a.txt"]);
  await expect.poll(() => listRows(w), { timeout: 15_000 }).toEqual(["Unstaged|unstaged:b.txt"]);
  expect(await openKeys(w)).toEqual(["unstaged:b.txt"]);
  expect(await selKeys(w)).toEqual(["unstaged:b.txt"]);
  await expect(w.locator(".gh-diff-view__line", { hasText: "B2" }).first()).toBeVisible();
  await expect(rowLabel(w, "Unstaged", "b.txt")).toBeFocused();
});

test("I2) editor on b, a different file a disappears externally: editor, buffer, caret and b's selection are untouched", async () => {
  repoDir = await makeRepo();
  await put("a.txt", "a1\na2\n");
  await put("b.txt", "b1\nb2\nb3\n");
  await commitAll(repoDir, "base");
  await put("a.txt", "a1\nA2\n");
  await put("b.txt", "b1\nB2\nb3\n");
  const w = await openRepoInApp();
  await selectAndEdit(w, "Unstaged", "b.txt");
  await w.keyboard.type("mine ");
  const caret = await footPos(w);
  await git(repoDir, ["checkout", "--", "a.txt"]);
  await expect.poll(() => listRows(w), { timeout: 15_000 }).toEqual(["Unstaged|unstaged:b.txt"]);
  await expectEditorOpen(w, "mine b1\nB2\nb3\n");
  expect(await footPos(w)).toBe(caret);
  await expect(dirtyTag(w)).toBeVisible();
  await expect(banner(w)).toHaveCount(0);
  expect(await openKeys(w)).toEqual(["unstaged:b.txt"]);
  expect(await selKeys(w)).toEqual(["unstaged:b.txt"]);
  await expect(cm(w)).toBeFocused();
});

test("I3) editor on a, a vanishes through Save while b stays: the list keeps only b, nothing is auto-selected, clicking b leaves the clean editor without a prompt", async () => {
  repoDir = await makeRepo();
  await put("a.txt", "a1\na2\n");
  await put("b.txt", "b1\nb2\n");
  await commitAll(repoDir, "base");
  await put("a.txt", "a1\nA2\n");
  await put("b.txt", "b1\nB2\n");
  const w = await openRepoInApp();
  await selectAndEdit(w, "Unstaged", "a.txt");
  await setBuffer(w, "a1\na2");
  await save(w);
  await expect.poll(() => listRows(w)).toEqual(["Unstaged|unstaged:b.txt"]);
  expect(await openKeys(w)).toEqual([]);
  expect(await selKeys(w)).toEqual([]);
  await expectEditorOpen(w, "a1\na2");
  await expect(cm(w)).toBeFocused();
  await rowLabel(w, "Unstaged", "b.txt").click();
  await expect(leaveDialog(w)).toHaveCount(0);
  await expect(cm(w)).toHaveCount(0);
  await expect.poll(() => openKeys(w)).toEqual(["unstaged:b.txt"]);
  expect(await bytes("a.txt")).toBe("a1\na2\n");
});

// ------------------------------------------------------------------ windowing (> 200 rows)

test("W) 250 changed files, the edited one is mid-list and vanishes: the list stays windowed, scroll position and editor survive", async () => {
  test.setTimeout(120_000);
  repoDir = await makeRepo();
  const name = (i: number) => `d/f${String(i).padStart(3, "0")}.txt`;
  await fs.mkdir(path.join(repoDir, "d"));
  for (let i = 0; i < 250; i++) await put(name(i), `base ${i}\nkeep\n`);
  await commitAll(repoDir, "base");
  for (let i = 0; i < 250; i++) await put(name(i), `edit ${i}\nkeep\n`);
  const w = await openRepoInApp();
  const grid = w.locator('section.gh-changes-panel__section [role="grid"]').first();
  await expect(grid).toHaveAttribute("aria-rowcount", "250");
  const scroller = w.locator(".gh-changes-panel__scroll");
  await scroller.evaluate((el) => void (el.scrollTop = 120 * 28 - 100));
  const target = w.locator('[data-row-key="unstaged:d/f120.txt"]');
  await expect(target).toHaveCount(1);
  await target.click();
  await expect(editBtn(w)).toBeEnabled();
  await editBtn(w).click();
  await expect(cm(w)).toBeFocused();
  await setBuffer(w, "base 120\nkeep");
  const before = await scroller.evaluate((el) => el.scrollTop);
  expect(before).toBeGreaterThan(2000);
  await save(w);

  await expect(grid).toHaveAttribute("aria-rowcount", "249", { timeout: 15_000 });
  await expect(w.locator('[data-row-key="unstaged:d/f120.txt"]')).toHaveCount(0);
  await expect(w.locator('[data-row-key="unstaged:d/f119.txt"]')).toHaveCount(1);
  await expect(w.locator('[data-row-key="unstaged:d/f121.txt"]')).toHaveCount(1);
  const domRows = await w.locator("li.gh-changes-panel__file").count();
  expect(domRows).toBeGreaterThan(5);
  expect(domRows).toBeLessThan(120); // still windowed, not 249 mounted rows
  expect(Math.abs((await scroller.evaluate((el) => el.scrollTop)) - before)).toBeLessThanOrEqual(28);
  expect((await out("status", "--porcelain")).trim().split("\n")).toHaveLength(249);
  await expectEditorOpen(w, "base 120\nkeep");
  await expect(saveBtn(w)).toHaveAttribute("aria-disabled", "true");
  await expect(cm(w)).toBeFocused();
  expect(await openKeys(w)).toEqual([]);
  // The rest of the list is still usable: the neighbour opens (clean editor, no prompt).
  await w.locator('[data-row-key="unstaged:d/f121.txt"]').click();
  await expect(cm(w)).toHaveCount(0);
  await expect.poll(() => openKeys(w)).toEqual(["unstaged:d/f121.txt"]);
});
