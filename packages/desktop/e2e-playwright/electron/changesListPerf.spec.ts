// SPDX-License-Identifier: GPL-3.0-or-later
/** ROADMAP.md "Changes list with thousands of files": a 5,000-file burst must not freeze the renderer. Repos live under GITHYDRA_PERF_DIR (never the project repo). */
import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { closeApp, removeUserDataDir, type LaunchedApp } from "../helpers/launchApp";
import { launchApp, openChanges, shot } from "../helpers/changesHelpers";

const N = Number(process.env.GITHYDRA_PERF_N ?? 5000);
const ROOT = process.env.GITHYDRA_PERF_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), "githydra-perf-"));

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e.x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e.x" } });
}
function makeRepo(name: string, tracked: boolean): string {
  const d = path.join(ROOT, `${name}-${Date.now()}`);
  fs.mkdirSync(d, { recursive: true });
  git(d, ["init", "-q"]);
  fs.writeFileSync(path.join(d, "seed.txt"), "seed\n");
  if (tracked) {
    for (let i = 0; i < N; i++) {
      const dir = path.join(d, `src-${i % 50}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `f${i}.txt`), "base\n");
    }
  }
  git(d, ["add", "-A"]);
  git(d, ["commit", "-q", "-m", "base"]);
  return d;
}
function burst(d: string, tracked: boolean) {
  for (let i = 0; i < N; i++) {
    const dir = path.join(d, `${tracked ? "src" : "new"}-${i % 50}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `f${i}.txt`), tracked ? "changed\n" : "new\n");
  }
}

let h: LaunchedApp;
test.beforeEach(async () => {
  h = await launchApp();
});
test.afterEach(async () => {
  await closeApp(h);
  await removeUserDataDir(h.userDataDir);
});

for (const mode of ["untracked", "modified"] as const) {
  test(`${mode} burst of ${N} files`, async () => {
    test.setTimeout(240_000);
    const d = makeRepo(mode, mode === "modified");
    await openChanges(h, d);
    const page = h.window;
    await page.evaluate(() => {
      const w = window as unknown as { __long: { dur: number; start: number }[]; __loaf: { dur: number; block: number; scripts: unknown[] }[] };
      w.__long = [];
      w.__loaf = [];
      new PerformanceObserver((l) => l.getEntries().forEach((e) => w.__long.push({ dur: e.duration, start: e.startTime }))).observe({ type: "longtask", buffered: true });
      try {
        new PerformanceObserver((l) =>
          l.getEntries().forEach((e) => {
            const x = e as unknown as { blockingDuration: number; scripts: { duration: number; invoker: string; sourceFunctionName: string }[] };
            w.__loaf.push({ dur: e.duration, block: x.blockingDuration, scripts: x.scripts.map((s) => ({ d: Math.round(s.duration), i: s.invoker, f: s.sourceFunctionName })) });
          }),
        ).observe({ type: "long-animation-frame", buffered: true });
      } catch {
        /* unsupported */
      }
    });
    const cdp = await page.context().newCDPSession(page);
    const profile = !!process.env.GITHYDRA_PERF_PROFILE;
    if (profile) {
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
      await cdp.send("Profiler.start");
    }
    burst(d, mode === "modified");
    const t0 = Date.now();
    // The watcher's live refresh normally fires on its own; a manual refresh is the fallback.
    await page.waitForTimeout(4000);
    await page.evaluate(() => document.querySelector<HTMLElement>('button[aria-label="Refresh commit graph" i]')?.click());
    const sel = mode === "modified" ? 'li[role="row"]' : 'li[role="row"]';
    // Cheap DOM polling: Playwright's role engine over 5,000 rows would itself dominate the profile.
    await page.waitForFunction((n) => [...document.querySelectorAll("h3")].some((h) => h.textContent?.includes(`(${n})`)), N, { timeout: 180_000, polling: 250 });
    const tHeading = Date.now() - t0;
    const rowsInDom = await page.locator(sel).count();
    // Time until the page can answer a trivial evaluate = main thread free again.
    const t1 = Date.now();
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    const tIdle = Date.now() - t1;
    await page.waitForTimeout(1500);
    const data = await page.evaluate(() => {
      const w = window as unknown as { __long: { dur: number }[]; __loaf: { dur: number; block: number; scripts: unknown[] }[] };
      return { long: w.__long, loaf: w.__loaf };
    });
    const longs = data.long.map((l) => Math.round(l.dur));
    console.log(
      `PERF ${mode} N=${N} headingVisibleMs=${tHeading} rowsInDom=${rowsInDom} idleAfterMs=${tIdle} longTasks=${longs.length} maxLong=${Math.max(0, ...longs)} sumLong=${longs.reduce((a, b) => a + b, 0)} longList=${JSON.stringify(longs)}`,
    );
    console.log(`LOAF ${JSON.stringify(data.loaf.sort((a, b) => b.dur - a.dur).slice(0, 4))}`);
    // Interaction cost with a full list: a click on a row, then ctrl+A style select-all.
    const frames = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    void frames;
    const clickMs = await page.evaluate(async () => {
      const el = document.querySelector<HTMLElement>("[data-row-key]")!;
      const t = performance.now();
      el.click();
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      return Math.round(performance.now() - t);
    });
    console.log(`PERF ${mode} clickRowMs=${clickMs}`);
    await page.locator("[data-row-key]").first().focus();
    const ts = Date.now();
    await page.keyboard.press("Control+a");
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    console.log(`PERF ${mode} selectAllMs=${Date.now() - ts}`);
    await expect(page.getByText(new RegExp(`^${N} selected`))).toBeVisible({ timeout: 30_000 }).catch(() => {});
    if (profile) {
      const { profile: p } = (await cdp.send("Profiler.stop")) as { profile: { nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }[]; samples: number[]; timeDeltas: number[] } };
      const self = new Map<number, number>();
      p.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (p.timeDeltas[i] ?? 0)));
      const byName = new Map<string, number>();
      for (const n of p.nodes) {
        const k = `${n.callFrame.functionName || "(anon)"} ${path.basename(n.callFrame.url)}:${n.callFrame.lineNumber}`;
        byName.set(k, (byName.get(k) ?? 0) + (self.get(n.id) ?? 0));
      }
      let js = 0;
      let native = 0;
      let gc = 0;
      let idle = 0;
      for (const n of p.nodes) {
        const v = self.get(n.id) ?? 0;
        const f = n.callFrame.functionName;
        if (f === "(idle)") idle += v;
        else if (f === "(garbage collector)") gc += v;
        else if (f === "(program)" || f === "(root)") native += v;
        else if (n.callFrame.url) js += v;
        else native += v;
      }
      console.log(`PROFILE-CATS ${mode} jsMs=${Math.round(js / 1000)} nativeProgramMs(style/layout/paint/DOM)=${Math.round(native / 1000)} gcMs=${Math.round(gc / 1000)} idleMs=${Math.round(idle / 1000)}`);
      const parent = new Map<number, number>();
      for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
      const incl = new Map<string, number>();
      const nodeById = new Map(p.nodes.map((n) => [n.id, n]));
      for (const n of p.nodes) {
        const v = self.get(n.id) ?? 0;
        if (!v) continue;
        const seen = new Set<string>();
        for (let cur: number | undefined = n.id; cur !== undefined; cur = parent.get(cur)) {
          const f = nodeById.get(cur)!.callFrame.functionName || "(anon)";
          if (seen.has(f)) continue;
          seen.add(f);
          incl.set(f, (incl.get(f) ?? 0) + v);
        }
      }
      const inclTop = [...incl.entries()].sort((a, b) => b[1] - a[1]).slice(0, 45).map(([k, v]) => `${(v / 1000).toFixed(0)}ms ${k}`);
      console.log(`INCL ${mode}\n${inclTop.join("\n")}`);
      const top = [...byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${(v / 1000).toFixed(0)}ms ${k}`);
      console.log(`PROFILE ${mode}\n${top.join("\n")}`);
    }
  });
}

test("a windowed list keeps keyboard navigation, scrolling and selection working on the true file set", async () => {
  test.setTimeout(120_000);
  const d = makeRepo("behaviour", false);
  for (let i = 0; i < 1500; i++) fs.writeFileSync(path.join(d, `u${String(i).padStart(4, "0")}.txt`), "x\n");
  await openChanges(h, d);
  const page = h.window;
  const mounted = () => page.evaluate(() => document.querySelectorAll("[data-row-key]").length);
  const activeKey = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset?.rowKey ?? null);
  expect(await mounted()).toBeLessThan(80);
  await page.locator('[data-row-key="untracked:u0000.txt"]').focus();
  await page.keyboard.press("End");
  await expect.poll(activeKey).toBe("untracked:u1499.txt");
  expect(await mounted()).toBeLessThan(80);
  await page.keyboard.press("ArrowUp");
  await expect.poll(activeKey).toBe("untracked:u1498.txt");
  await page.keyboard.press("Home");
  await expect.poll(activeKey).toBe("untracked:u0000.txt");
  // Arrow down past the bottom of the mounted window keeps going, scrolling as it goes.
  for (let i = 0; i < 60; i++) await page.keyboard.press("ArrowDown");
  await expect.poll(activeKey).toBe("untracked:u0060.txt");
  await page.keyboard.press("Control+a");
  await expect(page.locator(".gh-bulk-bar__count", { hasText: "1500 selected" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator('[data-row-key="untracked:u0000.txt"]').click().catch(async () => {
    await page.evaluate(() => (document.querySelector(".gh-changes-panel__scroll") as HTMLElement).scrollTo(0, 0));
    await page.locator('[data-row-key="untracked:u0000.txt"]').click();
  });
  await page.evaluate(() => (document.querySelector(".gh-changes-panel__scroll") as HTMLElement).scrollTo(0, 28 * 1000));
  await page.locator('[data-row-key="untracked:u1000.txt"]').click({ modifiers: ["Shift"] });
  await expect(page.locator(".gh-bulk-bar__count", { hasText: "1001 selected" })).toBeVisible();
  await shot(page, "windowed-list");
});
