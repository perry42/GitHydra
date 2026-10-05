// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * specs/live-refresh.md FR-458/FR-459 budget + edge cases in the real app: file bursts, ignored churn, huge
 * branch switches, renames/deletes underneath, a ~50k-file repo, tab close mid-flush, two tabs, blocked Discard.
 * Numbers are printed with `console.log` ("STRESS ...") for the QA report; assertions are the pass/fail bars.
 */
import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { closeApp, launchGitHydra, removeUserDataDir, stubOpenRepoDialog, type LaunchedApp } from "../helpers/launchApp";
import { cleanup, commitAll, git, initRepo, writeFile } from "../../src/test/gitFixture";

const SHOTS =
  process.env.LR_SHOTS ??
  "C:\\Users\\elizu\\AppData\\Local\\Temp\\claude\\d--projects-GitHydra\\8b6fe097-ca84-4722-89ef-14f1a13f1ea2\\scratchpad\\lr-shots";

let handle: LaunchedApp;
const dirs: string[] = [];
const consoleErrors: string[] = [];
const pageErrors: string[] = [];

test.beforeEach(async () => {
  consoleErrors.length = 0;
  pageErrors.length = 0;
  handle = await launchGitHydra();
  handle.window.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  handle.window.on("pageerror", (e) => pageErrors.push(String(e)));
  await fs.mkdir(SHOTS, { recursive: true });
});
test.afterEach(async () => {
  await closeApp(handle);
  await removeUserDataDir(handle.userDataDir);
  while (dirs.length) await cleanup(dirs.pop()!).catch(() => {});
});

const win = (): Page => handle.window;
const changesPanel = () => win().getByRole("complementary", { name: "Changes" });
const banner = () => win().getByText(/history changed outside githydra/i);

async function newRepo(): Promise<string> {
  const d = await initRepo();
  dirs.push(d);
  return d;
}
async function openRepo(repoPath: string, timeout = 15_000): Promise<number> {
  const t0 = Date.now();
  await stubOpenRepoDialog(handle.app, repoPath);
  await win().getByRole("button", { name: "Open a repository", exact: true }).click();
  await win().getByRole("button", { name: /^stashes/i }).waitFor({ timeout });
  return Date.now() - t0;
}
async function openChanges(): Promise<void> {
  await win().getByRole("button", { name: /^changes/i }).click();
  await changesPanel().waitFor();
}
async function instrumentSpawns(): Promise<void> {
  await handle.app.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    if (g.__spawnLog) return;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const req = typeof require === "function" ? require : process.mainModule!.require;
    const cp = req("node:child_process");
    const orig = cp.spawn;
    g.__spawnLog = [];
    cp.spawn = function (cmd: string, args: string[], opts: { cwd?: string }, ...rest: unknown[]) {
      g.__spawnLog.push({ t: Date.now(), cwd: opts?.cwd ?? "", args: Array.isArray(args) ? args.slice(0, 8) : [] });
      return orig.call(this, cmd, args, opts, ...rest);
    };
  });
}
type Spawn = { t: number; cwd: string; args: string[] };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const spawnLog = (): Promise<Spawn[]> => handle.app.evaluate(() => ((globalThis as any).__spawnLog ?? []).slice());
const statuses = (xs: Spawn[]) => xs.filter((e) => e.args.includes("status"));

async function writeMany(root: string, rel: string, n: number, content = "x\n"): Promise<void> {
  await fs.mkdir(path.join(root, rel), { recursive: true });
  const BATCH = 250;
  for (let i = 0; i < n; i += BATCH) {
    await Promise.all(
      Array.from({ length: Math.min(BATCH, n - i) }, (_, k) =>
        fs.writeFile(path.join(root, rel, `f${String(i + k).padStart(6, "0")}.txt`), content),
      ),
    );
  }
}

/** Installs an rAF gap recorder; returns a stop() giving the max frame gap (ms) and the page round-trip max. */
async function startJankProbe(): Promise<() => Promise<{ maxFrameGap: number; maxRoundTrip: number }>> {
  await win().evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    w.__gap = 0;
    w.__run = true;
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      w.__gap = Math.max(w.__gap, now - last);
      last = now;
      if (w.__run) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  let running = true;
  let maxRT = 0;
  const loop = (async () => {
    while (running) {
      const t0 = Date.now();
      await win().evaluate(() => 1);
      maxRT = Math.max(maxRT, Date.now() - t0);
      await new Promise((r) => setTimeout(r, 50));
    }
  })();
  return async () => {
    running = false;
    await loop;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gap = await win().evaluate(() => { (window as any).__run = false; return (window as any).__gap as number; });
    return { maxFrameGap: Math.round(gap), maxRoundTrip: maxRT };
  };
}

async function cpuPercent(): Promise<number> {
  return handle.app.evaluate(({ app }) => app.getAppMetrics().reduce((a, m) => a + m.cpu.percentCPUUsage, 0));
}

// ---------------------------------------------------------------------------------------------------------------
test("STRESS: 5k-file burst in a NON-ignored directory: UI stays responsive, refresh count bounded, list correct", async () => {
  test.setTimeout(180_000);
  const dir = await newRepo();
  await writeFile(dir, "a.txt", "base\n");
  await commitAll(dir, "Base");
  await openRepo(dir);
  await openChanges();
  await win().waitForTimeout(1500);
  await instrumentSpawns();
  const stop = await startJankProbe();
  const t0 = Date.now();
  await writeMany(dir, "burst", 5000);
  const writeMs = Date.now() - t0;
  // the whole directory is untracked: git status shows the dir collapsed, or 5000 files with -uall
  await expect(changesPanel().getByRole("heading", { name: /^Untracked \(/ })).toBeVisible({ timeout: 20_000 });
  await win().waitForTimeout(4000);
  const jank = await stop();
  const st = statuses(await spawnLog());
  const heading = await changesPanel().getByRole("heading", { name: /^Untracked \(/ }).innerText();
  const truth = (await git(dir, ["status", "--porcelain", "-uall"])).stdout.split("\n").filter(Boolean).length;
  console.log(`STRESS nonignored5k: write ${writeMs} ms; status spawns=${st.length}; maxFrameGap=${jank.maxFrameGap} ms; maxRoundTrip=${jank.maxRoundTrip} ms; heading="${heading}"; git -uall count=${truth}`);
  expect(heading).toContain(`(${truth})`);
  expect(st.length).toBeLessThan(40);
  expect(jank.maxFrameGap).toBeLessThan(5000);
  await expect(banner()).toHaveCount(0);
  await win().screenshot({ path: path.join(SHOTS, "stress-5k-nonignored.png") });
});

test("STRESS: 5k-file burst inside an IGNORED directory and npm-install-like churn: ~no refreshes, list untouched", async () => {
  test.setTimeout(180_000);
  const dir = await newRepo();
  await writeFile(dir, ".gitignore", "node_modules/\n");
  await writeFile(dir, "package.json", "{}\n");
  await commitAll(dir, "Base");
  await writeFile(dir, "visible.txt", "v\n");
  await openRepo(dir);
  await openChanges();
  await win().waitForTimeout(2000);
  await instrumentSpawns();
  const stop = await startJankProbe();
  await writeMany(dir, "node_modules/pkg", 5000, "module.exports={}\n");
  for (let round = 0; round < 3; round++) await writeMany(dir, `node_modules/pkg${round}/lib`, 1500, "// churn\n");
  await win().waitForTimeout(4000);
  const jank = await stop();
  const log = await spawnLog();
  const st = statuses(log);
  console.log(`STRESS ignored5k+churn: status spawns=${st.length}; all spawns=${log.length} ${JSON.stringify(log.slice(0, 6).map((e) => e.args.slice(0, 3).join(" ")))}; maxFrameGap=${jank.maxFrameGap} ms; maxRoundTrip=${jank.maxRoundTrip}`);
  await expect(changesPanel().getByRole("button", { name: /visible\.txt/ }).first()).toBeVisible();
  await expect(changesPanel().getByText(/node_modules/)).toHaveCount(0);
  expect(st.length).toBeLessThanOrEqual(5);
  // a real change after the churn is still picked up promptly
  await writeFile(dir, "after.txt", "a\n");
  await expect(changesPanel().getByRole("button", { name: /after\.txt/ }).first()).toBeVisible({ timeout: 10_000 });
});

test("STRESS: external branch switch rewriting 3000 files follows silently, list ends clean and correct, no banner", async () => {
  test.setTimeout(240_000);
  const dir = await newRepo();
  await writeMany(dir, "src", 3000, "one\n");
  await commitAll(dir, "main files");
  await git(dir, ["checkout", "-q", "-b", "other"]);
  await writeMany(dir, "src", 3000, "two\n");
  await commitAll(dir, "other files");
  await git(dir, ["checkout", "-q", "main"]);
  await openRepo(dir);
  await openChanges();
  await win().waitForTimeout(1500);
  await instrumentSpawns();
  const t0 = Date.now();
  await git(dir, ["checkout", "-q", "other"]);
  console.log("STRESS 3000-file switch: external git checkout itself took " + (Date.now() - t0) + " ms");
  const gitDone = Date.now() - t0;
  const cleanP = win().waitForFunction(() => [...document.querySelectorAll("aside[aria-label='Changes'] h3")].some((h) => /^Unstaged \(0\)/i.test(h.textContent ?? "")), null, { timeout: 120_000, polling: 100 }).then(() => Date.now() - t0, () => -1);
  const followP = win().locator('[role="option"][aria-selected="true"]', { hasText: "other files" }).waitFor({ timeout: 120_000 }).then(() => Date.now() - t0, () => -1);
  const [cleanAt, followAt] = await Promise.all([cleanP, followP]);
  console.log(`STRESS 3000-file branch switch: git done at ${gitDone} ms; selection followed at ${followAt} ms; Changes list clean at ${cleanAt} ms (-1 = never within 120 s)`);
  expect(followAt).toBeGreaterThan(0);
  expect(cleanAt).toBeGreaterThan(0);
  await win().waitForTimeout(3000);
  const sl = await spawnLog();
  const by: Record<string, number> = {};
  for (const e of sl) { const k = e.args.filter((a) => !a.startsWith("-") && !a.includes("=")).slice(0, 1).join(""); by[k] = (by[k] ?? 0) + 1; }
  console.log("STRESS 3000-file switch spawns by command: " + JSON.stringify(by) + " first@" + (sl[0] ? sl[0].t - t0 : -1) + "ms last@" + (sl.length ? sl[sl.length - 1].t - t0 : -1) + "ms");
  await expect(banner()).toHaveCount(0);
  expect((await git(dir, ["status", "--porcelain"])).stdout).toBe("");
  await expect(changesPanel().getByRole("heading", { name: /^(Unstaged|Untracked|Staged) \([1-9]/ })).toHaveCount(0);
});

test("STRESS: renaming the open file externally moves the entry; the old pane says it no longer has changes (no crash)", async () => {
  const dir = await newRepo();
  await writeFile(dir, "a.txt", "one\n");
  await commitAll(dir, "Base");
  await writeFile(dir, "a.txt", "two\n");
  await openRepo(dir);
  await openChanges();
  await changesPanel().getByRole("button", { name: /modified.*a\.txt/i }).click();
  await expect(changesPanel().getByText("+two")).toBeVisible();
  await fs.rename(path.join(dir, "a.txt"), path.join(dir, "renamed.txt"));
  await expect(changesPanel().getByRole("button", { name: /renamed\.txt/ }).first()).toBeVisible({ timeout: 10_000 });
  await expect(changesPanel().getByRole("button", { name: /deleted.*a\.txt/i }).first()).toBeVisible({ timeout: 10_000 });
  console.log(`STRESS rename: pane text=${JSON.stringify((await changesPanel().locator(".gh-changes-panel__diff").innerText()).slice(0, 120))}`);
  expect(pageErrors).toEqual([]);
});

test("STRESS: deleting the repo folder externally while open: app stays alive, no unhandled renderer errors", async () => {
  const dir = await newRepo();
  await writeFile(dir, "a.txt", "one\n");
  await commitAll(dir, "Base");
  await openRepo(dir);
  await openChanges();
  await win().waitForTimeout(1000);
  const mainErrors: string[] = [];
  handle.app.process().stderr?.on("data", (d) => mainErrors.push(String(d)));
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch((e) => console.log(`STRESS delete-folder: rm failed (watch handle?) ${String(e).slice(0, 120)}`));
  await win().waitForTimeout(4000);
  const alive = await win().evaluate(() => document.title).then(() => true, () => false);
  console.log(`STRESS deleted-folder: window alive=${alive}; pageErrors=${JSON.stringify(pageErrors)}; consoleErrorCount=${consoleErrors.length}; mainStderr=${JSON.stringify(mainErrors.join("").slice(0, 300))}`);
  await win().screenshot({ path: path.join(SHOTS, "stress-deleted-repo.png") });
  expect(alive).toBe(true);
  expect(pageErrors).toEqual([]);
});

test("STRESS: ~50k tracked files: open time, first Changes render and idle CPU", async () => {
  test.setTimeout(600_000);
  const dir = await newRepo();
  const t0 = Date.now();
  for (let d = 0; d < 50; d++) await writeMany(dir, `d${d}`, 1000, "x\n");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "fifty thousand"]);
  console.log(`STRESS 50k: fixture built in ${Date.now() - t0} ms`);
  await writeFile(dir, "d0/f000001.txt", "edited\n");
  const openMs = await openRepo(dir, 120_000);
  await openChanges();
  const t1 = Date.now();
  await expect(changesPanel().getByRole("button", { name: /f000001\.txt/ }).first()).toBeVisible({ timeout: 60_000 });
  console.log(`STRESS 50k: open ${openMs} ms; Changes shows the edit ${Date.now() - t1} ms after the panel opened`);
  await instrumentSpawns();
  await win().waitForTimeout(3000);
  const c0 = await cpuPercent();
  const samples: number[] = [];
  for (let i = 0; i < 10; i++) {
    await win().waitForTimeout(1000);
    samples.push(Math.round((await cpuPercent()) * 10) / 10);
  }
  const early = await spawnLog();
  console.log("STRESS 50k spawns in first 13 s after open: " + JSON.stringify(early.map((e) => [e.t - early[0].t, e.args.slice(0, 4).join(" ")])));
  await win().waitForTimeout(15_000);
  const mark = (await spawnLog()).length;
  await win().waitForTimeout(20_000);
  const idleSpawns = (await spawnLog()).length - mark;
  console.log(`STRESS 50k idle CPU% (sum of all Electron procs, 1 s samples): ${samples.join(",")} (warm-up ${c0}); spawns during idle: ${idleSpawns}`);
  // an external edit is still seen promptly in the huge repo
  const t2 = Date.now();
  await writeFile(dir, "d1/f000002.txt", "edited\n");
  await expect(changesPanel().getByRole("button", { name: /f000002\.txt/ }).first()).toBeVisible({ timeout: 20_000 });
  console.log(`STRESS 50k: external edit visible after ${Date.now() - t2} ms`);
  expect(idleSpawns).toBe(0);
});

test("STRESS: closing the tab while the watcher is mid-flush: no console/page errors, no spawns afterwards, repo dir removable (no leaked watcher handle)", async () => {
  test.setTimeout(180_000);
  const dir = await newRepo();
  await writeFile(dir, "a.txt", "one\n");
  await commitAll(dir, "Base");
  await openRepo(dir);
  await openChanges();
  await win().waitForTimeout(1500);
  await instrumentSpawns();
  const mainErrors: string[] = [];
  handle.app.process().stderr?.on("data", (d) => mainErrors.push(String(d)));
  const burst = writeMany(dir, "burst", 3000);
  await win().waitForTimeout(350); // inside the first debounce/flush window
  await win().getByRole("button", { name: /^Close .* tab$/ }).click();
  await burst;
  const closedAt = Date.now();
  await win().waitForTimeout(4000);
  const after = (await spawnLog()).filter((e) => e.t > closedAt + 1500 && e.cwd.includes(path.basename(dir)));
  console.log(`STRESS close-mid-flush: spawns >1.5s after close for that repo=${after.length} ${JSON.stringify(after.slice(0, 4).map((e) => e.args.slice(0, 3).join(" ")))}; consoleErrors=${JSON.stringify(consoleErrors)}; pageErrors=${JSON.stringify(pageErrors)}; mainStderr=${JSON.stringify(mainErrors.join("").slice(0, 300))}`);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(after).toEqual([]);
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); // throws EBUSY if a watcher still holds the dir
});

test("STRESS: two tabs on two repos, changes only in the background one: active tab neither refreshes nor banners; switching shows fresh state", async () => {
  test.setTimeout(180_000);
  const a = await newRepo();
  const b = await newRepo();
  for (const d of [a, b]) {
    await writeFile(d, "a.txt", "one\n");
    await commitAll(d, `Base ${path.basename(d)}`);
  }
  await openRepo(a);
  await openChanges();
  await win().waitForTimeout(1500);
  await stubOpenRepoDialog(handle.app, b);
  await win().getByRole("button", { name: "Open a repository in a new tab", exact: true }).click();
  await win().getByRole("button", { name: "Open a repository", exact: true }).click();
  await win().getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });
  await win().getByRole("tab").first().click(); // back to A (active), B in background
  await win().getByRole("button", { name: /^changes/i }).waitFor();
  await win().waitForTimeout(2000);
  await instrumentSpawns();
  await writeFile(b, "only-in-b.txt", "b\n");
  await git(b, ["commit", "--allow-empty", "-q", "-m", "commit in background repo"]);
  await win().waitForTimeout(4000);
  const log = await spawnLog();
  const touchedA = log.filter((e) => e.cwd.includes(path.basename(a)));
  const touchedB = log.filter((e) => e.cwd.includes(path.basename(b)));
  console.log(`STRESS two-tabs: spawns for active A=${touchedA.length}, for background B=${touchedB.length}`);
  await expect(banner()).toHaveCount(0);
  expect(touchedA).toEqual([]);
  // now switch to B: shows its state
  await win().getByRole("tab").nth(1).click();
  await expect(win().locator('[role="option"]', { hasText: "commit in background repo" })).toBeVisible({ timeout: 15_000 });
  if (!(await changesPanel().isVisible())) await openChanges();
  await expect(changesPanel().getByRole("button", { name: /only-in-b\.txt/ }).first()).toBeVisible({ timeout: 10_000 });
  await expect(banner()).toHaveCount(0);
});

async function openDiscard(dir: string, initial: string, committed: string) {
  await writeFile(dir, "a.txt", committed);
  await commitAll(dir, "Base");
  await writeFile(dir, "a.txt", initial);
  await openRepo(dir);
  await openChanges();
  await win().getByRole("button", { name: /discard changes to a\.txt/i }).click();
  const dialog = win().getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  return dialog;
}
const NL = String.fromCharCode(10);
const lf = (s: string) => s.split(String.fromCharCode(13)).join("");

test("Discard dialog (baseline ready) blocked after the file changes underneath: screenshots light+dark", async () => {
  const dir = await newRepo();
  const dialog = await openDiscard(dir, "my local edit" + NL, "base" + NL);
  await expect(dialog.getByRole("button", { name: /^discard$/i })).toBeEnabled();
  await writeFile(dir, "a.txt", "someone else's newer work" + NL);
  await win().waitForTimeout(1500);
  await dialog.getByRole("button", { name: /^discard$/i }).click();
  await expect(dialog.getByRole("alert")).toContainText(/changed since you opened this/i);
  await win().screenshot({ path: path.join(SHOTS, "discard-blocked-light.png") });
  await win().evaluate(() => (document.documentElement.dataset.theme = "dark"));
  await win().waitForTimeout(300);
  await win().screenshot({ path: path.join(SHOTS, "discard-blocked-dark.png") });
  expect(lf(await fs.readFile(path.join(dir, "a.txt"), "utf8"))).toBe("someone else's newer work" + NL);
});

// DATA-LOSS RACE (left red on purpose): useChangesPanel.requestDiscard reads its content baseline ASYNCHRONOUSLY after the
// dialog opens (ready:false until then), so an external write landing in that window (~100-400 ms here) becomes the baseline
// and the confirm then discards the externally written content, which the user never saw.
test("RACE: an external edit landing right after the Discard dialog opens (before its baseline read) must not be discarded", async () => {
  const dir = await newRepo();
  const dialog = await openDiscard(dir, "my local edit" + NL, "base" + NL);
  await writeFile(dir, "a.txt", "someone else's newer work" + NL);
  await win().waitForTimeout(1500);
  await dialog.getByRole("button", { name: /^discard$/i }).click().catch(() => {});
  await win().waitForTimeout(2000);
  const content = lf(await fs.readFile(path.join(dir, "a.txt"), "utf8"));
  console.log("RACE discard: file after confirm=" + JSON.stringify(content));
  expect(content).toBe("someone else's newer work" + NL);
});

// Security review H1/M2: the backend guard compares the CLICK-TIME fingerprint inside the mutation queue.
test("H1: an external write AFTER the dialog is fully open and BEFORE confirm is never discarded", async () => {
  const dir = await newRepo();
  const dialog = await openDiscard(dir, "my local edit" + NL, "base" + NL);
  await expect(dialog.getByRole("button", { name: /^discard$/i })).toBeEnabled();
  await win().waitForTimeout(500);
  await writeFile(dir, "a.txt", "written after the dialog opened" + NL);
  // Click straight away, before the live refresh can mark the dialog stale: the backend guard must still refuse.
  await dialog.getByRole("button", { name: /^discard$/i }).click({ noWaitAfter: true }).catch(() => {});
  await win().waitForTimeout(2500);
  expect(lf(await fs.readFile(path.join(dir, "a.txt"), "utf8"))).toBe("written after the dialog opened" + NL);
});

test("H1: an external write during the confirm's wait in the mutation queue (slow pre-commit hook) is never discarded", async () => {
  const dir = await newRepo();
  await writeFile(dir, "a.txt", "base" + NL);
  await writeFile(dir, "b.txt", "one" + NL);
  await commitAll(dir, "Base");
  await writeFile(dir, "a.txt", "my local edit" + NL);
  await writeFile(dir, "b.txt", "two" + NL);
  await git(dir, ["add", "b.txt"]);
  await fs.writeFile(path.join(dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
  await openRepo(dir);
  await openChanges();
  await win().getByPlaceholder("Summarize this commit").fill("slow commit");
  await changesPanel().getByRole("button", { name: "Commit", exact: true }).click();
  await win().waitForTimeout(600);
  await win().getByRole("button", { name: /discard changes to a\.txt/i }).click();
  const dialog = win().getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /^discard$/i }).click({ noWaitAfter: true });
  await win().waitForTimeout(800);
  await writeFile(dir, "a.txt", "written while confirm was queued" + NL);
  await win().waitForTimeout(8000);
  expect(lf(await fs.readFile(path.join(dir, "a.txt"), "utf8"))).toBe("written while confirm was queued" + NL);
});
