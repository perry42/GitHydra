// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * QA sweep beyond hunkLineStaging.spec.ts: Shift-click target-state rule, re-edited staged lines, 300-line
 * performance, sticky hunk headers, header/checkbox alignment, linked worktree, no-remote, zero network,
 * aria-live, 500-file open time, and squeezed-graph screenshots. Every test builds its own temp repo.
 * Screenshots go to $HUNK_SHOTS (or the OS temp dir).
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
const extraCleanup: string[] = [];

test.beforeEach(async () => {
  handle = await launchGitHydra();
  shotDir = process.env.HUNK_SHOTS ?? (await fs.mkdtemp(path.join(os.tmpdir(), "githydra-pw-hunkx-")));
  await fs.mkdir(shotDir, { recursive: true });
});
test.afterEach(async () => {
  await closeApp(handle);
  await removeUserDataDir(handle.userDataDir);
  if (repoDir) await cleanup(repoDir);
  for (const d of extraCleanup.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

const lines = (n: number, f: (i: number) => string = (i) => `line${String(i).padStart(2, "0")}`) =>
  Array.from({ length: n }, (_, i) => f(i + 1));
const join = (ls: string[], eol = "\n") => ls.join(eol) + eol;

function threeHunkFile(edited: boolean): string {
  const ls = lines(90);
  if (edited) {
    ls[4] = "CHANGED05";
    for (let i = 30; i <= 34; i++) ls[i - 1] = `CHANGED${i}`;
    for (let i = 60; i <= 74; i++) ls[i - 1] = `CHANGED${i}`;
  }
  return join(ls);
}
async function setupThreeHunks() {
  repoDir = await initRepo();
  await writeFile(repoDir, "f.txt", threeHunkFile(false));
  await commitAll(repoDir, "base");
  await writeFile(repoDir, "f.txt", threeHunkFile(true));
}
function gitIn(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, maxBuffer: 1 << 26 }).toString("utf8");
}

async function openRepoInApp(dir = repoDir): Promise<Page> {
  await stubOpenRepoDialog(handle.app, dir);
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
const lineBox = (w: Page, label: string) => w.getByRole("checkbox", { name: new RegExp(`^${label}(:|$)`) });
const hunkBox = (w: Page, n: number, of = 3) => w.getByRole("checkbox", { name: `Hunk ${n} of ${of}` });
async function tick(w: Page, label: string, modifiers: "Shift"[] = []) {
  const row = lineBox(w, label);
  await row.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await row.locator(".gh-diff-view__gutter--check").click({ modifiers });
}
const states = async (w: Page, labels: string[]) => {
  const out: Record<string, string | null> = {};
  for (const l of labels) out[l] = await lineBox(w, l).getAttribute("aria-checked");
  return out;
};
const log = (...a: unknown[]) => console.log("[QA]", ...a);

test("Shift-click rule A: click row 2 (stages it), Shift-click row 6 (unticked) -> characterize", async () => {
  await setupThreeHunks();
  const w = await openRepoInApp();
  await selectFile(w, "Unstaged", "f.txt");
  await tick(w, "Removed line 61"); // row 2 of the hunk-3 block
  await expect(lineBox(w, "Removed line 61")).toHaveAttribute("aria-checked", "true");
  await tick(w, "Removed line 65", ["Shift"]); // row 6
  await expect(lineBox(w, "Removed line 65")).toHaveAttribute("aria-checked", /true|false/);
  await w.waitForTimeout(7000);
  const names = [60, 61, 62, 63, 64, 65, 66].map((n) => `Removed line ${n}`);
  log("A UI states", JSON.stringify(await states(w, names)));
  log("A index -U0", JSON.stringify(gitIn(repoDir, ["diff", "--cached", "-U0"]).split("\n").filter((l) => /^[-+]/.test(l))));
});

test("Shift-click rule B: end row already staged, click row 2 (stages), Shift-click row 6 (staged) -> characterize", async () => {
  await setupThreeHunks();
  const w = await openRepoInApp();
  await selectFile(w, "Unstaged", "f.txt");
  await tick(w, "Removed line 65");
  await expect(lineBox(w, "Removed line 65")).toHaveAttribute("aria-checked", "true");
  await tick(w, "Removed line 61");
  await expect(lineBox(w, "Removed line 61")).toHaveAttribute("aria-checked", "true");
  await tick(w, "Removed line 65", ["Shift"]);
  await w.waitForTimeout(7000);
  const names = [60, 61, 62, 63, 64, 65, 66].map((n) => `Removed line ${n}`);
  log("B UI states", JSON.stringify(await states(w, names)));
  log("B index -U0", JSON.stringify(gitIn(repoDir, ["diff", "--cached", "-U0"]).split("\n").filter((l) => /^[-+]/.test(l))));
});

test("Shift keyboard: Shift+Down x4 then Space after row 2 is already staged (anchor-state rule) -> characterize", async () => {
  await setupThreeHunks();
  const w = await openRepoInApp();
  await selectFile(w, "Unstaged", "f.txt");
  await tick(w, "Removed line 61"); // staged, cursor+anchor on it
  await expect(lineBox(w, "Removed line 61")).toHaveAttribute("aria-checked", "true");
  for (let i = 0; i < 4; i++) await w.keyboard.press("Shift+ArrowDown");
  await w.keyboard.press("Space");
  await w.waitForTimeout(7000);
  const names = [60, 61, 62, 63, 64, 65, 66].map((n) => `Removed line ${n}`);
  log("K UI states", JSON.stringify(await states(w, names)));
  log("K index -U0", JSON.stringify(gitIn(repoDir, ["diff", "--cached", "-U0"]).split("\n").filter((l) => /^[-+]/.test(l))));
});

test("re-edited staged line: same line vs other line vs adjacent vs appended", async () => {
  test.setTimeout(240_000); // five scenarios x (setup + 4 s settle) exceeds the 60 s default
  const scenarios: { name: string; edit: (ls: string[]) => string[] }[] = [
    { name: "other line", edit: (ls) => ls.map((l, i) => (i === 7 ? "EDIT8" : l)) },
    { name: "same line", edit: (ls) => ls.map((l, i) => (i === 3 ? "EDIT4-again" : l)) },
    { name: "adjacent line", edit: (ls) => ls.map((l, i) => (i === 4 ? "EDIT5" : l)) },
    { name: "line appended after staged", edit: (ls) => [...ls.slice(0, 4), "NEW-AFTER", ...ls.slice(4)] },
    { name: "line deleted elsewhere", edit: (ls) => ls.filter((_, i) => i !== 9) },
  ];
  for (const s of scenarios) {
    repoDir = await initRepo();
    const base = lines(12);
    await writeFile(repoDir, "r.txt", join(base));
    await commitAll(repoDir, "base");
    const staged = base.map((l, i) => (i === 3 ? "STAGED4" : l));
    await writeFile(repoDir, "r.txt", join(staged));
    await git(repoDir, ["add", "r.txt"]);
    await writeFile(repoDir, "r.txt", join(s.edit(staged)));
    // fresh app per scenario
    await closeApp(handle);
    handle = await launchGitHydra();
    const w = await openRepoInApp();
    await selectFile(w, "Unstaged", "r.txt").catch(() => {});
    await w.locator(".gh-diff-view__line").first().waitFor({ timeout: 10_000 }).catch(() => {});
    await w.waitForTimeout(4000);
    const boxes = await w.getByRole("checkbox").count();
    const note = await w.getByText("Line-level staging unavailable for this file.").count();
    log(`reedit[${s.name}] checkboxes=${boxes} fallbackNote=${note} inStagedSection=${await fileRow(w, "Staged", "r.txt").count()} inUnstaged=${await fileRow(w, "Unstaged", "r.txt").count()}`);
    await cleanup(repoDir);
  }
  repoDir = "";
});

test("perf: 300-line file, 100 changed lines: time per toggle", async () => {
  repoDir = await initRepo();
  const base = lines(300);
  await writeFile(repoDir, "big.txt", join(base));
  await commitAll(repoDir, "base");
  await writeFile(repoDir, "big.txt", join(base.map((l, i) => (i % 3 === 0 ? `CHG${i}` : l))));
  const w = await openRepoInApp();
  const t0 = Date.now();
  await selectFile(w, "Unstaged", "big.txt");
  await w.getByRole("checkbox", { name: /^Hunk 1 of/ }).waitFor();
  log("diff open ms", Date.now() - t0, "checkboxes", await w.getByRole("checkbox").count());
  const stagedLines = () => (gitIn(repoDir, ["diff", "--cached", "-U0"]).match(/^[-+](?![-+])/gm) ?? []).length;
  const labels = [4, 7, 10, 13, 16].map((n) => `Removed line ${n}`);
  const ui: number[] = [];
  const idx: number[] = [];
  for (let k = 0; k < labels.length; k++) {
    const start = Date.now();
    await tick(w, labels[k]!);
    await expect(lineBox(w, labels[k]!)).toHaveAttribute("aria-checked", "true");
    ui.push(Date.now() - start);
    while (stagedLines() < k + 1 && Date.now() - start < 20_000) await new Promise((r) => setTimeout(r, 15));
    idx.push(Date.now() - start);
  }
  // single hunk toggle for the whole thing (huge)
  const h = Date.now();
  await w.getByRole("checkbox", { name: /^Hunk 1 of/ }).evaluate((b) => (b as HTMLButtonElement).click());
  while (stagedLines() < 200 && Date.now() - h < 30_000) await new Promise((r) => setTimeout(r, 15));
  log("perf per line toggle: ui(ms, includes scroll+click)=", ui, "index-complete(ms)=", idx, " whole-hunk stage ms=", Date.now() - h, "staged lines", stagedLines());
});

test("sticky hunk headers: scan scroll positions, record header geometry, screenshot", async () => {
  repoDir = await initRepo();
  const base = lines(200);
  await writeFile(repoDir, "s.txt", join(base));
  await commitAll(repoDir, "base");
  // 6 hunks of 4 changed lines each, separated by 20 context lines
  const ed = base.slice();
  for (let h = 0; h < 6; h++) for (let k = 0; k < 4; k++) ed[10 + h * 30 + k] = `HUNK${h + 1}-${k}`;
  await writeFile(repoDir, "s.txt", join(ed));
  const w = await openRepoInApp();
  await selectFile(w, "Unstaged", "s.txt");
  await w.getByRole("checkbox", { name: /^Hunk 1 of 6/ }).waitFor();
  const info = await w.evaluate(async () => {
    const sc = document.querySelector<HTMLElement>(".gh-diff-view__hunks")!;
    const out: unknown[] = [];
    const worst = { overlapPx: 0, scrollTop: 0 };
    for (let st = 0; st < sc.scrollHeight; st += 6) {
      sc.scrollTop = st;
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const top = sc.getBoundingClientRect().top;
      const hs = [...document.querySelectorAll<HTMLElement>(".gh-diff-view__hunk-header")]
        .map((e) => ({ y: e.getBoundingClientRect(), t: e.textContent }))
        .filter((x) => x.y.bottom > top && x.y.top < sc.getBoundingClientRect().bottom);
      if (hs.length >= 2) {
        // two headers visible at once, how much is the first one's bottom covering/abutting the second's top?
        const gap = hs[1]!.y.top - hs[0]!.y.bottom;
        if (gap < 0) {
          const o = -gap;
          if (o > worst.overlapPx) {
            worst.overlapPx = o;
            worst.scrollTop = st;
          }
        }
        if (gap < 60) out.push({ st, gap: Math.round(gap), h0top: Math.round(hs[0]!.y.top - top), h1top: Math.round(hs[1]!.y.top - top) });
      }
    }
    return { rows: out.length, sample: out.slice(0, 6), worst };
  });
  log("sticky scan", JSON.stringify(info));
  // screenshot at a position where header 1 is pinned, hunk 1's last row is near, and header 2 follows
  const pos = await w.evaluate(async () => {
    const sc = document.querySelector<HTMLElement>(".gh-diff-view__hunks")!;
    const hs = [...document.querySelectorAll<HTMLElement>(".gh-diff-view__hunk")];
    // scroll so the 1st hunk's bottom is ~50px below the viewport top
    const target = hs[0]!.getBoundingClientRect().bottom - sc.getBoundingClientRect().top - 70 + sc.scrollTop;
    sc.scrollTop = target;
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    return sc.scrollTop;
  });
  log("screenshot scrollTop", pos);
  await w.screenshot({ path: path.join(shotDir, "sticky-hunk1-to-hunk2.png") });
});

test("hunk header alignment vs checkbox column; aria-live announcements; zero network", async () => {
  await setupThreeHunks();
  const w = await openRepoInApp();
  const requests: string[] = [];
  w.on("request", (r) => {
    const u = r.url();
    if (!u.startsWith("file:") && !u.startsWith("devtools:") && !u.startsWith("data:") && !u.startsWith("blob:")) requests.push(u);
  });
  await selectFile(w, "Unstaged", "f.txt");
  await hunkBox(w, 2).waitFor();
  const geo = await w.evaluate(() => {
    const r = (e: Element | null) => (e ? e.getBoundingClientRect() : null);
    const hc = document.querySelector(".gh-diff-view__hunk-check .gh-diff-view__hcb, .gh-diff-view__hunk-check button, .gh-diff-view__hunk-check");
    const lc = document.querySelector(".gh-diff-view__gutter--check");
    const range = document.querySelector(".gh-diff-view__hunk-range");
    const noCol = document.querySelector(".gh-diff-view__line .gh-diff-view__line-no");
    const hb = document.querySelector(".gh-diff-view__hunk-header");
    const f = (b: DOMRect | null) => (b ? { x: Math.round(b.x * 10) / 10, w: Math.round(b.width * 10) / 10, y: Math.round(b.y) } : null);
    return { hunkCheckCol: f(r(document.querySelector(".gh-diff-view__hunk-check"))), hunkBox: f(r(hc)), lineCheckCol: f(r(lc)), hunkRangeText: f(r(range)), firstLineNo: f(r(noCol)), header: f(r(hb)) };
  });
  log("alignment", JSON.stringify(geo));
  const live = w.locator('div[role="status"][aria-live="polite"].gh-visually-hidden') // div only: the Changes list added its own <p> live region (FR-513);
  await w.evaluate(() => {
    (window as any).__live = [];
    const el = document.querySelector('[role="status"][aria-live="polite"].gh-visually-hidden')!;
    new MutationObserver(() => (window as any).__live.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
  });
  await tick(w, "Added line 31");
  await expect.poll(() => live.innerText()).not.toBe("");
  log("live after tick:", JSON.stringify(await live.innerText()));
  await tick(w, "Added line 31");
  await expect(lineBox(w, "Added line 31")).toHaveAttribute("aria-checked", "false");
  await w.waitForTimeout(4000);
  log("live after untick:", JSON.stringify(await live.innerText()), "all mutations so far:", JSON.stringify(await w.evaluate(() => (window as any).__live)));
  await fs.writeFile(path.join(repoDir, ".git", "index.lock"), "");
  await tick(w, "Added line 32");
  await expect(w.getByRole("alert").first()).toBeVisible({ timeout: 10_000 });
  log("live after failure:", JSON.stringify(await live.innerText()));
  await fs.rm(path.join(repoDir, ".git", "index.lock"));
  log("non-file network requests:", JSON.stringify(requests));
  expect(requests).toEqual([]);
});

test("no remote + linked worktree: stage a hunk in a linked worktree opened as its own repo", async () => {
  repoDir = await initRepo();
  await writeFile(repoDir, "f.txt", threeHunkFile(false));
  await commitAll(repoDir, "base");
  expect(gitIn(repoDir, ["remote"]).trim()).toBe("");
  const wt = repoDir + "-wt";
  extraCleanup.push(wt);
  gitIn(repoDir, ["worktree", "add", wt, "-b", "wtb"]);
  await fs.writeFile(path.join(wt, "f.txt"), threeHunkFile(true));
  const w = await openRepoInApp(wt);
  await selectFile(w, "Unstaged", "f.txt");
  await hunkBox(w, 2).click();
  await expect(hunkBox(w, 2)).toHaveAttribute("aria-checked", "true");
  await expect(fileRow(w, "Unstaged", "f.txt").getByRole("img", { name: "Partly staged" })).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => (gitIn(wt, ["diff", "--cached", "-U0"]).match(/^@@/gm) ?? []).length).toBe(1);
  expect(gitIn(repoDir, ["diff", "--cached"])).toBe("");
});

test("500 changed files, 100 of them partly staged: open time", async () => {
  test.setTimeout(240_000);
  repoDir = await initRepo();
  const mk = (i: number, v: number) => join(lines(12).map((l, k) => (k === 1 && v >= 1 ? `v1-${i}` : k === 9 && v >= 2 ? `v2-${i}` : l)));
  for (let i = 0; i < 500; i++) await fs.writeFile(path.join(repoDir, `file-${String(i).padStart(3, "0")}.txt`), mk(i, 0));
  await commitAll(repoDir, "base");
  for (let i = 0; i < 500; i++) await fs.writeFile(path.join(repoDir, `file-${String(i).padStart(3, "0")}.txt`), mk(i, 1));
  const first100 = Array.from({ length: 100 }, (_, i) => `file-${String(i).padStart(3, "0")}.txt`);
  gitIn(repoDir, ["add", "--", ...first100]);
  for (let i = 0; i < 100; i++) await fs.writeFile(path.join(repoDir, `file-${String(i).padStart(3, "0")}.txt`), mk(i, 2));
  const w = handle.window;
  await stubOpenRepoDialog(handle.app, repoDir);
  const t0 = Date.now();
  await w.getByRole("button", { name: "Open a repository", exact: true }).click();
  await w.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 60_000 });
  const tOpen = Date.now() - t0;
  const t1 = Date.now();
  await w.getByRole("button", { name: /^changes/i }).click();
  await w.getByRole("button", { name: "Stage all", exact: true }).waitFor({ timeout: 60_000 });
  await w.locator(".gh-changes-panel__file").first().waitFor({ timeout: 60_000 });
  const tList = Date.now() - t1;
  // wait for mixed markers to settle
  let mixedAt = -1;
  for (let k = 0; k < 400; k++) {
    if ((await w.getByRole("img", { name: "Partly staged" }).count()) > 0) { mixedAt = Date.now() - t1; break; }
    await w.waitForTimeout(50);
  }
  const series: string[] = [];
  for (let k = 0; k < 40; k++) { series.push(`${Date.now() - t1}ms:${await w.getByRole("img", { name: "Partly staged" }).count()}`); await w.waitForTimeout(500); }
  log("500-files mixed-marker count over time", series.filter((_, i) => i % 3 === 0).join(" "));
  log(`500-files: repo open ${tOpen}ms, Changes panel list ${tList}ms, first mixed marker at ${mixedAt}ms, mixed markers=${await w.getByRole("img", { name: "Partly staged" }).count()}, rows=${await w.locator(".gh-changes-panel__file").count()}, subject visible=${await w.getByLabel("Subject").isVisible()}`);
});

test("history-diff has no checkboxes (nothing regressed): commit detail diff", async () => {
  await setupThreeHunks();
  await git(repoDir, ["add", "f.txt"]);
  await git(repoDir, ["commit", "-m", "second"]);
  const w = handle.window;
  await stubOpenRepoDialog(handle.app, repoDir);
  await w.getByRole("button", { name: "Open a repository", exact: true }).click();
  await w.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });
  await w.getByText("second", { exact: true }).first().click();
  await w.getByText("f.txt").first().click().catch(() => {});
  await w.waitForTimeout(1000);
  log("history diff checkboxes:", await w.getByRole("checkbox").count());
  await w.screenshot({ path: path.join(shotDir, "history-diff.png") });
});

for (const [W, H] of [[1324, 800], [1920, 1080]] as const) {
  test(`window ${W}x${H}: drawer open, graph column, screenshots light+dark`, async () => {
    await setupThreeHunks();
    // some history so the graph column has content
    for (let i = 0; i < 6; i++) await git(repoDir, ["commit", "--allow-empty", "-m", `commit number ${i} with a longish subject line`]);
    const w = await openRepoInApp();
    await handle.app.evaluate(({ BrowserWindow }, [ww, hh]) => {
      const win = BrowserWindow.getAllWindows()[0]!;
      win.setSize(ww as number, hh as number);
    }, [W, H]);
    await expect.poll(() => w.evaluate(() => window.innerWidth)).toBeGreaterThan(W - 80);
    await selectFile(w, "Unstaged", "f.txt");
    await hunkBox(w, 2).waitFor();
    for (const theme of ["light", "dark"] as const) {
      await setTheme(w, theme);
      await w.mouse.move(5, 5);
      const m = await w.evaluate(() => {
        const r = (s: string) => document.querySelector(s)?.getBoundingClientRect();
        const g = r(".gh-commit-graph, [class*='commit-graph']");
        return { win: window.innerWidth, panel: r(".gh-changes-panel")?.width, files: r(".gh-changes-panel__files")?.width, diff: r(".gh-changes-panel__diff")?.width, graphish: g ? Math.round(g.width) : null, sidebar: r("[class*='sidebar']")?.width };
      });
      log(`window ${W} ${theme}`, JSON.stringify(m));
      await w.screenshot({ path: path.join(shotDir, `win${W}-${theme}.png`) });
    }
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`error state ${theme}: locked index`, async () => {
    await setupThreeHunks();
    const w = await openRepoInApp();
    await setTheme(w, theme);
    await selectFile(w, "Unstaged", "f.txt");
    await hunkBox(w, 2).waitFor();
    await fs.writeFile(path.join(repoDir, ".git", "index.lock"), "");
    await hunkBox(w, 2).click();
    await expect(w.getByRole("alert").first()).toBeVisible({ timeout: 10_000 });
    await w.mouse.move(5, 5);
    await w.waitForTimeout(1500);
    log("error state hunk2 aria-checked after 1.5s:", await hunkBox(w, 2).getAttribute("aria-checked"));
    await w.screenshot({ path: path.join(shotDir, `${theme}-08-error-state.png`) });
    await fs.rm(path.join(repoDir, ".git", "index.lock"));
  });
}
