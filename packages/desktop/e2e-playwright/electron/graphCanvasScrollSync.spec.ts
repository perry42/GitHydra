// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Real-Electron regression guard for graph canvas / DOM-row scroll sync (CLAUDE.md "Known pitfalls":
 * "Graph canvas must track scroll position like `CommitRow` does"). Fix under guard: `GraphCanvas`
 * draws in `useLayoutEffect` and `CommitGraph.handleScroll` `flushSync`s when the visible window
 * changes, so the canvas element's `top`, its bitmap, and the rows' tops all commit in one frame.
 *
 * jsdom cannot see this (no frames, no compositor), and a MutationObserver-ordering check is wrong
 * under layout effects, so a per-frame rAF recorder plus a `clearRect` hook is used instead: the
 * hook records the `style.top` the canvas had at the moment it was actually (re)drawn.
 */
import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import {
  closeApp,
  launchGitHydra,
  openRepoThroughRealUi,
  removeUserDataDir,
  type LaunchedApp,
} from "../helpers/launchApp";
import { cleanup, git, initRepo } from "../../src/test/gitFixture";

// > several PAGE_SIZE (150) pages so the virtualization window shifts many times while scrolling.
const TOTAL_COMMITS = 700;

let handle: LaunchedApp;
let repoDir: string;

async function buildHistory(dir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["fast-import", "--quiet", "--date-format=raw"], { cwd: dir, shell: false });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`fast-import exited ${code}`))));
    let script = "";
    for (let i = 0; i < TOTAL_COMMITS; i += 1) {
      const msg = `commit ${i}`;
      script += `commit refs/heads/main\ncommitter T <t@e.com> ${1_700_000_000 + i} +0000\ndata ${msg.length}\n${msg}\n\n`;
    }
    child.stdin.end(script);
  });
  await git(dir, ["reset", "-q", "--hard", "main"]);
}

interface Report {
  frames: number;
  topChanges: number;
  topMismatchFrames: number;
  staleBitmapFrames: number;
  uncoveredFrames: number;
}

test.beforeEach(async () => {
  repoDir = await initRepo();
  await buildHistory(repoDir);
  handle = await launchGitHydra();
  await openRepoThroughRealUi(handle, repoDir);
});

test.afterEach(async () => {
  await closeApp(handle);
  await removeUserDataDir(handle.userDataDir);
  await cleanup(repoDir);
});

async function installRecorder(w: LaunchedApp["window"]): Promise<void> {
  await w.evaluate(() => {
    const P = CanvasRenderingContext2D.prototype as unknown as { clearRect: (...a: unknown[]) => void };
    const orig = P.clearRect;
    P.clearRect = function (this: CanvasRenderingContext2D, ...a: unknown[]) {
      const c = this.canvas;
      if (c.classList.contains("gh-graph-canvas")) c.dataset.drawnTop = c.style.top;
      return orig.apply(this, a);
    };
    // The hook is installed after the first draw, so seed from the already-consistent initial state.
    const initial = document.querySelector(".gh-graph-canvas") as HTMLCanvasElement;
    initial.dataset.drawnTop = initial.style.top;
    const sc = document.querySelector('[role="listbox"][aria-label="Commit graph"]') as HTMLElement;
    const R = { on: false, frames: 0, topChanges: 0, topMismatchFrames: 0, staleBitmapFrames: 0, uncoveredFrames: 0, lastTop: "" };
    (window as unknown as { __sync: typeof R }).__sync = R;
    const loop = () => {
      if (R.on) {
        const cv = document.querySelector(".gh-graph-canvas") as HTMLCanvasElement | null;
        const rows = Array.from(document.querySelectorAll(".gh-commit-row")) as HTMLElement[];
        if (cv && rows.length > 0) {
          R.frames += 1;
          const tops = rows.map((r) => parseFloat(r.style.top));
          const lo = Math.min(...tops);
          const hi = Math.max(...tops) + 28;
          if (parseFloat(cv.style.top) !== lo) R.topMismatchFrames += 1;
          if (cv.style.top !== R.lastTop) {
            R.topChanges += 1;
            R.lastTop = cv.style.top;
          }
          if (cv.dataset.drawnTop !== cv.style.top) R.staleBitmapFrames += 1;
          if (lo > sc.scrollTop || hi < sc.scrollTop + sc.clientHeight) R.uncoveredFrames += 1;
        }
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
}

async function record(w: LaunchedApp["window"], run: () => Promise<void>): Promise<Report> {
  await w.evaluate(() => {
    const R = (window as unknown as { __sync: Record<string, unknown> }).__sync;
    Object.assign(R, { frames: 0, topChanges: 0, topMismatchFrames: 0, staleBitmapFrames: 0, uncoveredFrames: 0, lastTop: "", on: true });
  });
  await run();
  await w.waitForTimeout(300);
  return w.evaluate(() => {
    const R = (window as unknown as { __sync: Report & { on: boolean } }).__sync;
    R.on = false;
    const { frames, topChanges, topMismatchFrames, staleBitmapFrames, uncoveredFrames } = R;
    return { frames, topChanges, topMismatchFrames, staleBitmapFrames, uncoveredFrames };
  });
}

function expectInSync(r: Report): void {
  expect(r.topChanges, "window must actually shift during the run").toBeGreaterThan(5);
  expect(r.topMismatchFrames, "canvas style.top != first rendered row top").toBe(0);
  expect(r.staleBitmapFrames, "canvas top changed but bitmap was not redrawn in that frame").toBe(0);
  expect(r.uncoveredFrames, "rows do not cover the viewport").toBe(0);
}

test("canvas top, bitmap and rows stay in sync every frame during a fast wheel run", async () => {
  test.setTimeout(90_000);
  const w = handle.window;
  const scroller = w.locator('[role="listbox"][aria-label="Commit graph"]');
  await w.waitForSelector(".gh-commit-row");
  await installRecorder(w);
  const box = (await scroller.boundingBox())!;
  await w.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

  const report = await record(w, async () => {
    for (let i = 0; i < 80; i += 1) await w.mouse.wheel(0, 600);
  });
  expectInSync(report);
});

test("canvas top, bitmap and rows stay in sync every frame during a fast scrollbar-thumb drag", async () => {
  test.setTimeout(90_000);
  const w = handle.window;
  const scroller = w.locator('[role="listbox"][aria-label="Commit graph"]');
  await w.waitForSelector(".gh-commit-row");
  await installRecorder(w);
  const box = (await scroller.boundingBox())!;
  const sbw = await scroller.evaluate((el) => el.offsetWidth - el.clientWidth);
  const x = box.x + box.width - Math.max(sbw, 4) / 2;

  const report = await record(w, async () => {
    await w.mouse.move(x, box.y + 20);
    await w.mouse.down();
    for (let i = 0; i < 100; i += 1) {
      await w.mouse.move(x, box.y + 20 + (i / 99) * (box.height - 60));
    }
    await w.mouse.up();
  });
  expectInSync(report);
});
