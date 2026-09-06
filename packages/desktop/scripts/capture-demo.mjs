#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// One-off (re-runnable) tool that captures the README's hero demo GIF from the REAL, built
// Electron app — never a mockup. Mirrors `e2e-playwright/helpers/launchApp.ts`'s
// `launchGitHydra`/`stubOpenRepoDialog`/`openRepoThroughRealUi` exactly (same isolated
// `--user-data-dir`, same `ELECTRON_RUN_AS_NODE` stripping, same dialog stub + "Stashes" button
// ready-signal) rather than inventing a new launch path — it just can't literally `import` that
// TypeScript module from a plain Node script without a TS loader, so the few lines of launch
// logic are reproduced here instead.
//
// Pipeline:
//   1. Build a realistic fixture repo on disk (real `git` CLI, real commits/branches/merges/tag)
//      via the same minimal "spawn git directly" convention as
//      `packages/git-core/tests/testRepo.ts` / `src/test/gitFixture.ts` (never routes through the
//      code under test).
//   2. Launch the real built app (`dist-electron/main.js`) via Playwright's real `_electron`
//      launcher (imported from `playwright-core`, the actual dependency backing
//      `@playwright/test`'s own `_electron` export) and drive it through real UI interactions.
//   3. Take real `page.screenshot()` PNGs at each narrative beat, waiting out every "Loading…"
//      state first so no frame captures a spinner mid-fetch.
//   4. Encode those PNGs into an animated GIF with `sharp`'s multi-page `join`/`.gif()` support
//      (already a `packages/desktop` devDependency for icon generation — no new dependency).
//      Playwright's own bundled `ffmpeg` was tried first, but that binary is a stripped
//      video-recording-only build (`--disable-everything`, only vp8/webm + mjpeg/png enabled) with
//      no `concat` demuxer, no `gif` muxer, and no `palettegen`/`paletteuse` filters compiled in —
//      it cannot produce a GIF at all.
//
// Usage: `node scripts/capture-demo.mjs` from `packages/desktop` (requires `npm run build` to
// have been run first, same precondition as `npm run test:e2e:playwright`).
import { _electron as electron } from "playwright-core";
import sharp from "sharp";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(path.dirname(desktopRoot));
const mainJsPath = path.join(desktopRoot, "dist-electron", "main.js");
const outDir = path.join(repoRoot, "docs", "assets");
const gifPath = path.join(outDir, "demo.gif");

// GIF-friendly, fixed window size — independent of this machine's actual display size, and
// downscaled again (see encodeGif) to keep the final file small.
const WINDOW_WIDTH = 1280;
const WINDOW_HEIGHT = 800;
const GIF_WIDTH = 880;

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Ada Chen",
  GIT_AUTHOR_EMAIL: "ada@example.com",
  GIT_COMMITTER_NAME: "Ada Chen",
  GIT_COMMITTER_EMAIL: "ada@example.com",
  GIT_TERMINAL_PROMPT: "0",
};

// ---------------------------------------------------------------------------------------------
// Fixture repo (real git, spawned directly — never through git-core, matching testRepo.ts).
// ---------------------------------------------------------------------------------------------

function git(cwd, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      shell: false,
      env: { ...process.env, ...GIT_ENV, ...extraEnv },
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`git ${args.join(" ")} failed (${code}): ${stderr}`));
        return;
      }
      resolve();
    });
  });
}

async function writeFile(repoDir, relPath, contents) {
  const full = path.join(repoDir, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, contents, "utf8");
}

async function appendFile(repoDir, relPath, contents) {
  const full = path.join(repoDir, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.appendFile(full, contents, "utf8");
}

/** Commits with an explicit, synthetic, strictly-increasing date (via `next()`) so the graph's
 * date column reads as a coherent history instead of every commit landing at "just now"/today —
 * applies to merge commits and the annotated tag too, not just plain commits, since `git merge`/
 * `git tag -a` otherwise fall back to the real wall-clock time. */
async function commit(repoDir, message, when) {
  await git(repoDir, ["add", "-A"]);
  await git(repoDir, ["commit", "-q", "-m", message], { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when });
}

async function mergeBranch(repoDir, branch, message, when) {
  await git(repoDir, ["merge", "--no-ff", "-q", "-m", message, branch], {
    GIT_AUTHOR_DATE: when,
    GIT_COMMITTER_DATE: when,
  });
}

/** Builds a small but structurally interesting repo: two feature branches merged back with real
 * merge commits, a third branch left open (unmerged) for graph-color divergence, a tag, and an
 * uncommitted change left in the working tree so the Changes panel has something real to stage.
 *
 * Also prepends ~30 plain linear commits as the *oldest* history (real commits, just less
 * structurally interesting) purely so the graph is taller than one screenful — without them a
 * ~12-commit history renders entirely on-screen at once and the "scroll the commit graph" beat
 * has nothing to scroll. They land below the merge-heavy commits (newest-first ordering), so the
 * initial view is unaffected and only shows up once the demo actually scrolls down. */
async function buildFixtureRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "githydra-demo-fixture-"));
  await git(repoRoot, ["init", "-q", "--initial-branch=main", dir]);

  let t = Date.parse("2026-05-01T09:00:00Z") / 1000;
  const next = () => {
    t += 60 * 60 * 6; // 6 hours between commits, for a readable spread in the date column
    return `${t} +0000`;
  };

  const paddingMessages = [
    "Set up project scaffolding",
    "Add CI configuration",
    "Update dependencies",
    "Fix lint warnings",
    "Improve error messages",
    "Refactor date utilities",
    "Bump TypeScript version",
    "Tidy up imports",
    "Add editorconfig",
    "Improve build script output",
  ];
  await writeFile(dir, "CHANGELOG.md", "# Changelog\n\n");
  for (let i = 0; i < 30; i++) {
    const message = paddingMessages[i % paddingMessages.length];
    await appendFile(dir, "CHANGELOG.md", `- ${message}\n`);
    await commit(dir, message, next());
  }

  // Fast-forward the synthetic clock so the structured section below reads as noticeably later.
  t = Date.parse("2026-08-01T09:00:00Z") / 1000;

  await writeFile(dir, "README.md", "# Transit\n\nA tiny sample app used to demo GitHydra's commit graph.\n");
  await writeFile(dir, "src/index.ts", "export function boot() {\n  console.log(\"transit booting\");\n}\n");
  await commit(dir, "Initial commit", next());

  await writeFile(
    dir,
    "src/index.ts",
    "export function boot() {\n  console.log(\"transit booting\");\n  loadSchedule();\n}\n\nfunction loadSchedule() {\n  // TODO: fetch real schedule data\n}\n",
  );
  await commit(dir, "Sketch out schedule loading", next());

  await git(dir, ["checkout", "-q", "-b", "feature/commit-graph-canvas"]);
  await writeFile(dir, "src/graph/renderer.ts", "export class LaneRenderer {\n  draw(): void {\n    // canvas-based lane drawing\n  }\n}\n");
  await commit(dir, "Add canvas-based lane renderer", next());
  await writeFile(
    dir,
    "src/graph/renderer.ts",
    "export class LaneRenderer {\n  private visibleStart = 0;\n\n  draw(): void {\n    // canvas-based lane drawing, virtualized to the visible row window\n  }\n}\n",
  );
  await commit(dir, "Virtualize visible row window", next());

  await git(dir, ["checkout", "-q", "main"]);
  await mergeBranch(dir, "feature/commit-graph-canvas", "Merge branch 'feature/commit-graph-canvas'", next());

  await writeFile(dir, "src/changes/panel.ts", "export function renderChangesPanel(): string {\n  return \"stage/unstage panel\";\n}\n");
  await commit(dir, "Add stage/unstage panel", next());

  await git(dir, ["checkout", "-q", "-b", "feature/conflict-ui"]);
  await writeFile(dir, "src/conflicts/view.ts", "export function renderConflictView(): string {\n  return \"conflict resolution skeleton\";\n}\n");
  await commit(dir, "Add conflict resolution view skeleton", next());
  await writeFile(
    dir,
    "src/conflicts/view.ts",
    "export function renderConflictView(kind: \"text\" | \"binary\"): string {\n  if (kind === \"binary\") return \"binary conflict diff\";\n  return \"conflict resolution skeleton\";\n}\n",
  );
  await commit(dir, "Support binary conflict diffs", next());

  await git(dir, ["checkout", "-q", "main"]);
  await writeFile(dir, "src/blame/view.ts", "export function renderBlame(): string {\n  return \"per-line blame\";\n}\n");
  await commit(dir, "Add blame view", next());

  await mergeBranch(dir, "feature/conflict-ui", "Merge branch 'feature/conflict-ui'", next());
  const tagWhen = next();
  await git(dir, ["tag", "-a", "v0.9.0", "-m", "v0.9.0"], { GIT_AUTHOR_DATE: tagWhen, GIT_COMMITTER_DATE: tagWhen });

  await git(dir, ["checkout", "-q", "-b", "feature/stash-worktree-aware"]);
  await writeFile(dir, "src/stash/list.ts", "export function listStashes(): string[] {\n  return [];\n}\n");
  await commit(dir, "Make stash list worktree aware", next());
  await writeFile(
    dir,
    "src/stash/list.ts",
    "export function listStashes(): string[] {\n  // TODO: preview each stash's diff\n  return [];\n}\n",
  );
  await commit(dir, "Add stash preview", next());

  // Leave HEAD on main with an open (unmerged) branch sitting alongside it, for graph divergence.
  await git(dir, ["checkout", "-q", "main"]);

  // Leave a real, uncommitted change for the Changes panel / diff view / staging beat.
  await writeFile(
    dir,
    "src/index.ts",
    "export function boot() {\n  console.log(\"transit booting\");\n  loadSchedule();\n  renderInitialGraph();\n}\n\nfunction loadSchedule() {\n  // TODO: fetch real schedule data\n}\n\nfunction renderInitialGraph() {\n  // paints the commit graph on first load\n}\n",
  );

  return dir;
}

async function rmrf(dir) {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}

// ---------------------------------------------------------------------------------------------
// App launch — mirrors e2e-playwright/helpers/launchApp.ts exactly (see file header comment).
// ---------------------------------------------------------------------------------------------

async function launchGitHydra() {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "githydra-demo-userdata-"));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: [mainJsPath, `--user-data-dir=${userDataDir}`],
    cwd: desktopRoot,
    env,
  });
  const window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");

  // Force dark theme for the capture. A brand-new profile has no `githydra:theme` localStorage
  // entry yet, so `useTheme.ts`'s `getInitialTheme()` falls through to
  // `matchMedia("(prefers-color-scheme: light)")` — this automation environment's OS reports a
  // light color-scheme preference, so a fresh launch renders light, not DESIGN.md's dark-graphite
  // default. Seed the same `githydra:theme` key `useTheme.ts` itself persists to (same
  // try/catch-guarded localStorage access it already uses) and reload so its `useState`
  // initializer re-reads the now-stored value on first render, exactly like a real returning user
  // who previously chose dark.
  await window.evaluate(() => {
    try {
      window.localStorage.setItem("githydra:theme", "dark");
    } catch {
      // localStorage unavailable — nothing more we can do; caller's screenshots would just show
      // whatever the system-preference fallback resolves to.
    }
  });
  await window.reload();
  await window.waitForLoadState("domcontentloaded");

  return { app, window, userDataDir };
}

async function stubOpenRepoDialog(app, repoPath) {
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
  }, repoPath);
}

// ---------------------------------------------------------------------------------------------
// Capture sequence.
// ---------------------------------------------------------------------------------------------

/** { file, holdMs } beats — `holdMs` is how long this frame should be held in the final GIF. */
const frames = [];
let frameIndex = 0;

async function shoot(window, framesDir, holdMs) {
  frameIndex += 1;
  const file = path.join(framesDir, `frame-${String(frameIndex).padStart(3, "0")}.png`);
  await window.screenshot({ path: file });
  frames.push({ file, holdMs });
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

/** Waits for any visible "Loading…"-style status text to clear, so no captured frame freezes on a
 * spinner mid-fetch (branches list, diff view, etc. all render one of these while pending). */
async function waitForSettled(window) {
  await window
    .getByText(/^loading[ ….]/i)
    .first()
    .waitFor({ state: "hidden", timeout: 10_000 })
    .catch(() => {});
}

async function run() {
  await fs.mkdir(outDir, { recursive: true });
  const framesDir = await fs.mkdtemp(path.join(os.tmpdir(), "githydra-demo-frames-"));

  console.log("Building fixture repo...");
  const repoDir = await buildFixtureRepo();

  console.log("Launching real Electron app...");
  const { app, window, userDataDir } = await launchGitHydra();

  try {
    await app.evaluate(
      ({ BrowserWindow }, size) => {
        const win = BrowserWindow.getAllWindows()[0];
        win.setBounds({ x: 0, y: 0, width: size.width, height: size.height });
      },
      { width: WINDOW_WIDTH, height: WINDOW_HEIGHT },
    );
    await window.setViewportSize({ width: WINDOW_WIDTH, height: WINDOW_HEIGHT });

    // Beat 1: landing screen (specs/repo-list.md's single-surface "Open a repository" empty state).
    await window.getByRole("button", { name: /^open a repository$/i }).waitFor({ timeout: 15_000 });
    await shoot(window, framesDir, 700);

    // Open the fixture repo through the real UI (stubbed native dialog, real IPC round trip).
    await stubOpenRepoDialog(app, repoDir);
    await window.getByRole("button", { name: /^open a repository$/i }).click();
    await window.getByRole("button", { name: /^stashes/i }).waitFor({ timeout: 15_000 });
    await waitForSettled(window);
    await sleep(300);
    await shoot(window, framesDir, 1100);

    // Beat 2: scroll the commit graph to show branch/merge topology in motion.
    const graph = window.getByRole("listbox", { name: /commit graph/i });
    await graph.hover();
    await window.mouse.wheel(0, 220);
    await sleep(250);
    await shoot(window, framesDir, 650);
    await window.mouse.wheel(0, 220);
    await sleep(250);
    await shoot(window, framesDir, 650);
    await window.mouse.wheel(0, -440);
    await sleep(250);
    await shoot(window, framesDir, 700);

    // Beat 3: click a commit to open the DetailPanel.
    const mergeRow = window.locator('[role="option"]', { hasText: "Merge branch 'feature/conflict-ui'" });
    await mergeRow.scrollIntoViewIfNeeded();
    await mergeRow.click();
    const detailPanel = window.getByRole("complementary", { name: "Commit details" });
    await detailPanel.waitFor({ timeout: 10_000 });
    await waitForSettled(window);
    await sleep(200);
    await shoot(window, framesDir, 1400);

    // Beat 4: open the Changes panel and show the real uncommitted diff.
    await window.getByRole("button", { name: /^changes/i }).click();
    const changesPanel = window.getByRole("complementary", { name: "Changes" });
    await changesPanel.waitFor({ timeout: 10_000 });
    await waitForSettled(window);
    await sleep(200);
    await shoot(window, framesDir, 900);

    const fileLabel = changesPanel.locator(".gh-changes-panel__file-label", { hasText: "src/index.ts" }).first();
    await fileLabel.click();
    await waitForSettled(window);
    await sleep(200);
    await shoot(window, framesDir, 1400);

    // Beat 5: stage the file — a real `stageFile` IPC round trip against the real on-disk index.
    const stageButton = changesPanel.locator(".gh-changes-panel__file", { hasText: "src/index.ts" }).getByRole("button", { name: /^stage$/i });
    await stageButton.click();
    await changesPanel.locator(".gh-changes-panel__section", { hasText: "Staged (1)" }).waitFor({ timeout: 10_000 });
    await waitForSettled(window);
    await sleep(300);
    await shoot(window, framesDir, 1800);
  } finally {
    await app.close().catch(() => {});
    await rmrf(userDataDir);
    await rmrf(repoDir);
  }

  console.log(`Captured ${frames.length} frames. Encoding GIF...`);
  await encodeGif();
  await rmrf(framesDir);
  console.log(`Done: ${gifPath}`);
}

// ---------------------------------------------------------------------------------------------
// GIF encoding via sharp's animated-image `join` support (see file header for why not ffmpeg).
// ---------------------------------------------------------------------------------------------

async function encodeGif() {
  const targetHeight = Math.round((WINDOW_HEIGHT * GIF_WIDTH) / WINDOW_WIDTH);
  const pageBuffers = [];
  for (const frame of frames) {
    const buf = await sharp(frame.file)
      .resize({ width: GIF_WIDTH, height: targetHeight, fit: "fill" })
      .png()
      .toBuffer();
    pageBuffers.push(buf);
  }
  const delays = frames.map((f) => f.holdMs);

  await sharp(pageBuffers, { join: { animated: true, across: 1 } })
    .gif({ delay: delays, loop: 0, colours: 160, effort: 8, dither: 1.0, keepDuplicateFrames: true })
    .toFile(gifPath);
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
