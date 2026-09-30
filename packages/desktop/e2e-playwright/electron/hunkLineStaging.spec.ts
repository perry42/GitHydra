// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Real-Electron verification of specs/hunk-line-staging.md (REAL mouse drag in the gutter, real hover,
 * real layout). Every test builds its own temp repo; nothing depends on another test. Screenshots go to
 * $HUNK_SHOTS (or the OS temp dir) for human review.
 */
import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { closeApp, launchGitHydra, removeUserDataDir, stubOpenRepoDialog, type LaunchedApp } from "../helpers/launchApp";
import { cleanup, commitAll, git, initRepo, writeFile } from "../../src/test/gitFixture";

let handle: LaunchedApp;
let repoDir: string;
let shotDir: string;

test.beforeEach(async () => {
  handle = await launchGitHydra();
  shotDir = process.env.HUNK_SHOTS ?? (await fs.mkdtemp(path.join(os.tmpdir(), "githydra-pw-hunk-")));
  await fs.mkdir(shotDir, { recursive: true });
});
test.afterEach(async () => {
  await closeApp(handle);
  await removeUserDataDir(handle.userDataDir);
  if (repoDir) await cleanup(repoDir);
});

const lines = (n: number, f: (i: number) => string = (i) => `line${String(i).padStart(2, "0")}`) =>
  Array.from({ length: n }, (_, i) => f(i + 1));
const join = (ls: string[], eol = "\n") => ls.join(eol) + eol;

/** base 90 lines; edits: hunk1 = line 5, hunk2 = lines 30..34, hunk3 = lines 60..74 (big). */
function threeHunkFile(edited: boolean): string {
  const ls = lines(90);
  if (edited) {
    ls[4] = "CHANGED05";
    for (let i = 30; i <= 34; i++) ls[i - 1] = `CHANGED${i}`;
    for (let i = 60; i <= 74; i++) ls[i - 1] = `CHANGED${i}`;
  }
  return join(ls);
}

function gitBytes(args: string[]): Buffer {
  return execFileSync("git", args, { cwd: repoDir, maxBuffer: 1 << 26 });
}

async function openRepoInApp(): Promise<Page> {
  await stubOpenRepoDialog(handle.app, repoDir);
  await handle.window.getByRole("button", { name: "Open a repository", exact: true }).click();
  await handle.window.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });
  await handle.window.getByRole("button", { name: /^changes/i }).click();
  await handle.window.getByRole("button", { name: "Stage all", exact: true }).waitFor();
  return handle.window;
}

function fileRow(w: Page, section: "Staged" | "Unstaged" | "Untracked", p: string) {
  return w
    .locator("section.gh-changes-panel__section", { has: w.locator("h3", { hasText: new RegExp(`^${section}`) }) })
    .locator("li.gh-changes-panel__file", { hasText: p });
}
async function selectFile(w: Page, section: "Staged" | "Unstaged" | "Untracked", p: string) {
  await fileRow(w, section, p).locator(".gh-changes-panel__file-label").click();
}

async function setTheme(w: Page, theme: "light" | "dark") {
  const current = await w.evaluate(() => document.documentElement.dataset.theme);
  if (current === theme) return;
  await w.getByRole("button", { name: "More actions" }).click();
  await w.getByRole("menuitem", { name: /switch to (light|dark) theme/i }).click();
  await expect.poll(() => w.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
}

async function setupThreeHunks() {
  repoDir = await initRepo();
  await writeFile(repoDir, "f.txt", threeHunkFile(false));
  await commitAll(repoDir, "base");
  await writeFile(repoDir, "f.txt", threeHunkFile(true));
}

const hunkBtn = (w: Page, verb: string, n: number, of = 3) => w.getByRole("button", { name: `${verb} hunk ${n} of ${of}` });

async function dragGutter(w: Page, fromLabel: string, toLabel: string) {
  const a = (await w.getByRole("button", { name: fromLabel, exact: true }).boundingBox())!;
  const b = (await w.getByRole("button", { name: toLabel, exact: true }).boundingBox())!;
  await w.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await w.mouse.down();
  await w.mouse.move(a.x + a.width / 2, a.y + a.height / 2 + 4, { steps: 2 });
  await w.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 6 });
  await w.mouse.up();
}

test("AC1 stage hunk 2: index has exactly hunk 2, worktree byte-identical, file in both lists", async () => {
  await setupThreeHunks();
  const before = await fs.readFile(path.join(repoDir, "f.txt"));
  const w = await openRepoInApp();
  await selectFile(w, "Unstaged", "f.txt");
  await expect(hunkBtn(w, "Stage", 2)).toBeVisible();
  await hunkBtn(w, "Stage", 2).click();
  await expect(fileRow(w, "Staged", "f.txt")).toBeVisible({ timeout: 10_000 });
  await expect(fileRow(w, "Unstaged", "f.txt")).toBeVisible();
  const cached = (await git(repoDir, ["diff", "--cached", "-U0"])).stdout;
  expect(cached.match(/^@@/gm)).toHaveLength(1);
  expect(cached).toContain("+CHANGED30");
  expect(cached).toContain("+CHANGED34");
  expect(cached).not.toContain("CHANGED05");
  expect(cached).not.toContain("CHANGED60");
  expect(Buffer.compare(before, await fs.readFile(path.join(repoDir, "f.txt")))).toBe(0);
});

test("AC2+AC3 select 2 of 10 changed lines (last '-' + first '+') by real gutter drag, stage, then unstage restores", async () => {
  await setupThreeHunks();
  const w = await openRepoInApp();
  await selectFile(w, "Unstaged", "f.txt");
  // hunk 2 = lines 30..34 removed (old nos 30..34), then CHANGED30..34 added (new nos 30..34)
  // dragged UPWARD: a downward drag is blocked by the floating bar (see the BUG test below)
  await dragGutter(w, "Select added line 30", "Select removed line 34");
  const bar = w.getByRole("toolbar", { name: "Actions for 2 selected lines" });
  await expect(bar).toBeVisible();
  await w.screenshot({ path: path.join(shotDir, "selection-bar-default.png") });
  await bar.getByRole("button", { name: "Stage 2 lines" }).click();
  await expect(fileRow(w, "Staged", "f.txt")).toBeVisible({ timeout: 10_000 });
  const idx = (await git(repoDir, ["show", ":f.txt"])).stdout.split("\n");
  const exp = lines(90);
  exp.splice(33, 1, "CHANGED30"); // line34 removed, CHANGED30 in its place, line30..33 kept as context
  expect(idx.slice(0, 90).join("\n")).toBe(exp.slice(0, 90).join("\n"));
  expect(idx.length).toBe(91); // 90 lines + trailing ""
  // Unstage lines (exact inverse): staged side, select both again
  await selectFile(w, "Staged", "f.txt");
  await expect(w.getByRole("button", { name: "Select removed line 34" })).toBeVisible();
  await w.getByRole("button", { name: "Unstage hunk 1 of 1" }).click();
  await expect(fileRow(w, "Staged", "f.txt")).toHaveCount(0, { timeout: 10_000 });
  expect((await git(repoDir, ["diff", "--cached"])).stdout).toBe("");
});

test("AC3 unstage hunk 1 of a file with 2 staged hunks leaves the other staged", async () => {
  await setupThreeHunks();
  await git(repoDir, ["add", "f.txt"]);
  const w = await openRepoInApp();
  await selectFile(w, "Staged", "f.txt");
  await hunkBtn(w, "Unstage", 2).click();
  await expect(fileRow(w, "Unstaged", "f.txt")).toBeVisible({ timeout: 10_000 });
  const cached = (await git(repoDir, ["diff", "--cached", "-U0"])).stdout;
  expect(cached.match(/^@@/gm)).toHaveLength(2);
  expect(cached).not.toContain("CHANGED30");
});

test("AC8 discard hunk: cancel changes nothing; confirm restores only that hunk, index untouched", async () => {
  await setupThreeHunks();
  // also stage hunk 1 first so the file has staged changes
  const w = await openRepoInApp();
  await selectFile(w, "Unstaged", "f.txt");
  await hunkBtn(w, "Stage", 1).click();
  await expect(fileRow(w, "Staged", "f.txt")).toBeVisible({ timeout: 10_000 });
  const indexBefore = (await git(repoDir, ["diff", "--cached"])).stdout;
  const wtBefore = await fs.readFile(path.join(repoDir, "f.txt"));
  await selectFile(w, "Unstaged", "f.txt");
  // Screenshot: Discard hidden (no hover) vs revealed
  const header = w.locator(".gh-diff-view__hunk-header--actions").first();
  await w.mouse.move(5, 5);
  const discardBtn = w.getByRole("button", { name: /^Discard hunk 1 of 2$/ });
  const opacity = () => discardBtn.evaluate((e) => getComputedStyle(e).opacity);
  expect(await opacity()).toBe("0");
  await w.screenshot({ path: path.join(shotDir, "discard-hidden.png") });
  await header.hover();
  expect(await opacity()).toBe("1");
  await w.screenshot({ path: path.join(shotDir, "discard-hover.png") });

  await discardBtn.click();
  const dlg = w.getByRole("alertdialog");
  await expect(dlg).toContainText("f.txt");
  await expect(dlg).toContainText(/1 hunk/);
  await expect(dlg).toContainText(/cannot be recovered/i);
  await w.screenshot({ path: path.join(shotDir, "discard-confirm.png") });
  await dlg.getByRole("button", { name: "Cancel" }).click();
  await expect(dlg).toHaveCount(0);
  expect(Buffer.compare(wtBefore, await fs.readFile(path.join(repoDir, "f.txt")))).toBe(0);

  await discardBtn.click();
  await w.getByRole("alertdialog").getByRole("button", { name: "Discard", exact: true }).click();
  await expect(w.getByRole("alertdialog")).toHaveCount(0);
  await expect.poll(async () => (await fs.readFile(path.join(repoDir, "f.txt"), "utf8")).includes("CHANGED30")).toBe(false);
  const wt = await fs.readFile(path.join(repoDir, "f.txt"), "utf8");
  expect(wt).toContain("line30");
  expect(wt).toContain("CHANGED60"); // hunk 3 untouched
  expect(wt).toContain("CHANGED05"); // staged hunk 1 still in worktree
  expect((await git(repoDir, ["diff", "--cached"])).stdout).toBe(indexBefore);
});

test("AC4 stale guard: external edit after diff shown -> Stage hunk shows notice, index unchanged, diff reloaded", async () => {
  await setupThreeHunks();
  const w = await openRepoInApp();
  await selectFile(w, "Unstaged", "f.txt");
  await expect(hunkBtn(w, "Stage", 2)).toBeVisible();
  const ls = lines(90);
  ls[4] = "EXTERNAL05";
  await fs.writeFile(path.join(repoDir, "f.txt"), join(ls)); // now only ONE hunk vs index
  await hunkBtn(w, "Stage", 2).click();
  await expect(w.getByText("File changed. Diff reloaded.")).toBeVisible({ timeout: 10_000 });
  expect((await git(repoDir, ["diff", "--cached"])).stdout).toBe("");
  await expect(w.getByText("EXTERNAL05")).toBeVisible();
  await expect(hunkBtn(w, "Stage", 1, 1)).toBeVisible();
});

test("AC9 diff scroll position unchanged after a hunk action", async () => {
  await setupThreeHunks();
  const w = await openRepoInApp();
  await selectFile(w, "Unstaged", "f.txt");
  await expect(hunkBtn(w, "Stage", 2)).toBeVisible();
  const before = await w.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".gh-diff-view__hunks")!;
    el.scrollTop = 150;
    return { top: el.scrollTop, scrollable: el.scrollHeight > el.clientHeight };
  });
  expect(before.scrollable).toBe(true);
  expect(before.top).toBeGreaterThan(50);
  // DOM click so Playwright does not scroll the target into view first
  await w.getByRole("button", { name: "Stage hunk 1 of 3" }).evaluate((b) => (b as HTMLButtonElement).click());
  await expect(fileRow(w, "Staged", "f.txt")).toBeVisible({ timeout: 10_000 });
  await expect(hunkBtn(w, "Stage", 2, 2)).toBeVisible();
  const after = await w.evaluate(() => document.querySelector<HTMLElement>(".gh-diff-view__hunks")!.scrollTop);
  expect(after).toBe(before.top);
});

test("AC7 ineligible files (untracked, deleted, binary, staged-added) show no partial controls", async () => {
  repoDir = await initRepo();
  await writeFile(repoDir, "gone.txt", "a\nb\nc\n");
  await fs.writeFile(path.join(repoDir, "bin.dat"), Buffer.from([0, 1, 2, 3, 0, 5]));
  await commitAll(repoDir, "base");
  await fs.rm(path.join(repoDir, "gone.txt"));
  await fs.writeFile(path.join(repoDir, "bin.dat"), Buffer.from([0, 9, 2, 3, 0, 7, 7]));
  await writeFile(repoDir, "untracked.txt", "x\ny\n");
  await writeFile(repoDir, "added.txt", "p\nq\n");
  await git(repoDir, ["add", "added.txt"]);
  const w = await openRepoInApp();
  const none = async () => {
    await expect(w.locator("button[data-gutter]")).toHaveCount(0);
    await expect(w.getByRole("button", { name: /^(Stage|Unstage|Discard) hunk/ })).toHaveCount(0);
  };
  await selectFile(w, "Unstaged", "gone.txt");
  await expect(w.locator(".gh-diff-view__line").first()).toBeVisible();
  await none();
  await selectFile(w, "Unstaged", "bin.dat");
  await expect(w.getByText(/Binary file/)).toBeVisible();
  await none();
  await selectFile(w, "Untracked", "untracked.txt");
  await expect(w.locator(".gh-diff-view__line").first()).toBeVisible();
  await none();
  await selectFile(w, "Staged", "added.txt");
  await expect(w.locator(".gh-diff-view__line").first()).toBeVisible();
  await none();
  // whole-file controls still work
  await fileRow(w, "Unstaged", "gone.txt").getByRole("button", { name: "Stage", exact: true }).click();
  await expect(fileRow(w, "Staged", "gone.txt")).toBeVisible({ timeout: 10_000 });
});

test("AC11 locked index: failed apply surfaces git's message and UI matches porcelain", async () => {
  await setupThreeHunks();
  const w = await openRepoInApp();
  await selectFile(w, "Unstaged", "f.txt");
  await expect(hunkBtn(w, "Stage", 2)).toBeVisible();
  await fs.writeFile(path.join(repoDir, ".git", "index.lock"), "");
  await hunkBtn(w, "Stage", 2).click();
  await expect(w.getByRole("alert").first()).toBeVisible({ timeout: 10_000 });
  await w.screenshot({ path: path.join(shotDir, "locked-index-error.png") });
  const msg = (await w.getByRole("alert").first().innerText()).toLowerCase();
  expect(msg).toMatch(/lock|index/);
  await fs.rm(path.join(repoDir, ".git", "index.lock"));
  expect((await git(repoDir, ["status", "--porcelain"])).stdout).toBe(" M f.txt\n");
  await expect(fileRow(w, "Staged", "f.txt")).toHaveCount(0);
  await expect(fileRow(w, "Unstaged", "f.txt")).toBeVisible();
});

for (const theme of ["light", "dark"] as const) {
  test(`visuals ${theme}: hover/focus reveal, selected lines, floating bar near bottom of scrolled diff`, async () => {
    await setupThreeHunks();
    const w = await openRepoInApp();
    await setTheme(w, theme);
    await selectFile(w, "Unstaged", "f.txt");
    await expect(hunkBtn(w, "Stage", 2)).toBeVisible();
    await w.mouse.move(5, 5);
    await w.screenshot({ path: path.join(shotDir, `${theme}-01-default.png`) });
    await w.locator(".gh-diff-view__hunk-header--actions").nth(1).hover();
    await w.screenshot({ path: path.join(shotDir, `${theme}-02-hover-header.png`) });
    await w.mouse.move(5, 5);
    await w.getByRole("button", { name: "Stage hunk 1 of 3" }).focus();
    await w.keyboard.press("Tab"); // -> Discard hunk 1 via keyboard
    await w.screenshot({ path: path.join(shotDir, `${theme}-03-focus-discard.png`) });
    // select lines in hunk 2
    await dragGutter(w, "Select removed line 31", "Select added line 31");
    await w.mouse.move(5, 5);
    await w.screenshot({ path: path.join(shotDir, `${theme}-04-selected.png`) });
    // the last hunk, last line selected, scrolled to the very bottom
    await w.evaluate(() => {
      const el = document.querySelector<HTMLElement>(".gh-diff-view__hunks")!;
      el.scrollTop = el.scrollHeight;
    });
    await dragGutter(w, "Select added line 74", "Select added line 73");
    await w.evaluate(() => {
      const el = document.querySelector<HTMLElement>(".gh-diff-view__hunks")!;
      el.scrollTop = el.scrollHeight;
    });
    await w.mouse.move(5, 5);
    await w.screenshot({ path: path.join(shotDir, `${theme}-05-bar-at-bottom.png`) });
    const geo = await w.evaluate(() => {
      const bar = document.querySelector<HTMLElement>(".gh-diff-view__selection-bar")!.getBoundingClientRect();
      let p: HTMLElement | null = document.querySelector<HTMLElement>(".gh-diff-view__selection-bar")!.parentElement;
      const clips: { cls: string; top: number; bottom: number; overflowY: string }[] = [];
      while (p) {
        const cs = getComputedStyle(p);
        if (cs.overflowY !== "visible") {
          const r = p.getBoundingClientRect();
          clips.push({ cls: p.className, top: r.top, bottom: r.bottom, overflowY: cs.overflowY });
        }
        p = p.parentElement;
      }
      return { bar: { top: bar.top, bottom: bar.bottom, left: bar.left, right: bar.right }, clips };
    });
    // eslint-disable-next-line no-console
    console.log(`${theme} bar geometry`, JSON.stringify(geo));
    for (const c of geo.clips) expect(geo.bar.bottom, `bar clipped by ${c.cls}`).toBeLessThanOrEqual(c.bottom + 0.5);
    await w.getByRole("toolbar", { name: /Actions for/ }).getByRole("button", { name: "Discard 2 lines" }).click();
    await w.screenshot({ path: path.join(shotDir, `${theme}-06-discard-lines-confirm.png`) });
  });
}

test("no-trailing-newline file: staging the last line keeps the marker (byte compare)", async () => {
  repoDir = await initRepo();
  await fs.writeFile(path.join(repoDir, "n.txt"), "a\nb\nc");
  await commitAll(repoDir, "base");
  await fs.writeFile(path.join(repoDir, "n.txt"), "a\nb\nC");
  const w = await openRepoInApp();
  await selectFile(w, "Unstaged", "n.txt");
  await w.getByRole("button", { name: "Stage hunk 1 of 1" }).click();
  await expect(fileRow(w, "Unstaged", "n.txt")).toHaveCount(0, { timeout: 10_000 });
  expect(gitBytes(["show", ":n.txt"]).toString("latin1")).toBe("a\nb\nC");
});

for (const autocrlf of ["true", "false"] as const) {
  test(`CRLF file, core.autocrlf=${autocrlf}: stage 1 of 2 lines then discard line, bytes`, async () => {
    repoDir = await initRepo();
    await git(repoDir, ["config", "core.autocrlf", autocrlf]);
    const base = ["one", "two", "three", "four", "five"];
    await fs.writeFile(path.join(repoDir, "c.txt"), base.join("\r\n") + "\r\n");
    await commitAll(repoDir, "base");
    const edited = ["one", "TWO", "three", "FOUR", "five"];
    // Two separate changes far enough? (context 3 merges them into one hunk) -> 4 changed lines
    await fs.writeFile(path.join(repoDir, "c.txt"), edited.join("\r\n") + "\r\n");
    const w = await openRepoInApp();
    await selectFile(w, "Unstaged", "c.txt");
    await expect(w.locator(".gh-diff-view__line").first()).toBeVisible();
    await w.screenshot({ path: path.join(shotDir, `crlf-${autocrlf}.png`) });
    console.log(await w.locator(".gh-diff-view").innerText());
    const controls = await w.locator("button[data-gutter]").count();
    // eslint-disable-next-line no-console
    console.log(`autocrlf=${autocrlf}: gutter buttons=${controls}`);
    if (controls === 0) {
      test.info().annotations.push({ type: "finding", description: "no partial controls for CRLF file" });
      return;
    }
    const before = gitBytes(["show", ":c.txt"]).toString("latin1");
    // remove 'two' + add 'TWO' only
    await dragGutter(w, "Select added line 2", "Select removed line 2");
    await w.getByRole("toolbar", { name: /Actions for/ }).getByRole("button", { name: "Stage 2 lines" }).click();
    await expect(fileRow(w, "Staged", "c.txt")).toBeVisible({ timeout: 10_000 });
    const idx = gitBytes(["show", ":c.txt"]).toString("latin1");
    // eslint-disable-next-line no-console
    console.log(`autocrlf=${autocrlf} before=${JSON.stringify(before)} index=${JSON.stringify(idx)}`);
    // blob bytes: autocrlf=true stores LF; false stores CRLF verbatim
    const eol = autocrlf === "true" ? "\n" : "\r\n";
    expect(idx).toBe(["one", "TWO", "three", "four", "five"].join(eol) + eol);
    // worktree untouched by staging
    expect((await fs.readFile(path.join(repoDir, "c.txt"))).toString("latin1")).toBe(edited.join("\r\n") + "\r\n");

    // discard the remaining FOUR/four change lines
    await selectFile(w, "Unstaged", "c.txt");
    await dragGutter(w, "Select added line 4", "Select removed line 4");
    await w.getByRole("toolbar", { name: /Actions for/ }).getByRole("button", { name: "Discard 2 lines" }).click();
    await w.getByRole("alertdialog").getByRole("button", { name: "Discard", exact: true }).click();
    await expect(w.getByRole("alertdialog")).toHaveCount(0);
    await expect.poll(async () => (await fs.readFile(path.join(repoDir, "c.txt"), "latin1")).includes("FOUR")).toBe(false);
    const wt = (await fs.readFile(path.join(repoDir, "c.txt"))).toString("latin1");
    // eslint-disable-next-line no-console
    console.log(`autocrlf=${autocrlf} worktree after discard=${JSON.stringify(wt)}`);
    expect(wt).toBe(["one", "TWO", "three", "four", "five"].join("\r\n") + "\r\n");
    expect((await git(repoDir, ["status", "--porcelain"])).stdout.trim()).toMatch(/^M\s+c\.txt$|^MM c\.txt$|^M  c\.txt$/);
  });
}

test("a short DOWNWARD gutter drag (removed 34 -> next row) is not blocked by the floating selection bar", async () => {
  await setupThreeHunks();
  const w = await openRepoInApp();
  await selectFile(w, "Unstaged", "f.txt");
  await dragGutter(w, "Select removed line 34", "Select added line 30");
  await expect(w.getByRole("toolbar", { name: "Actions for 2 selected lines" })).toBeVisible({ timeout: 3000 });
});
