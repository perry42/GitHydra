/**
 * Gap 2 (test-agent's Playwright coverage plan): `electron/main.test.ts`'s
 * "createWindow() — window bounds persistence (Fix 2)" describe block mocks the entire `electron`
 * module (`BrowserWindow`, `screen`, `app`) and fires synthetic `instance.__emit("resize"/"move"/
 * "close")` events — it proves `windowBounds.ts`'s own bounds-COMPUTATION logic is correct (already
 * covered as fast pure-function unit tests in `electron/windowBounds.test.ts`, untouched here), but
 * never proves a REAL `BrowserWindow` actually emits `resize`/`move`/`close` the way the mock
 * assumes, that `getNormalBounds()` behaves as expected, or that a real window really opens at the
 * resolved size/position and restores correctly on relaunch.
 *
 * This suite launches the real built app and drives real `BrowserWindow` API calls in the real
 * main process (`electronApp.evaluate`) to trigger genuine OS-level resize/move/close — not a
 * replacement for `main.test.ts`'s mock-based coverage (which stays, and still earns its keep for
 * edge cases a single real display can't produce: multi-monitor arrangements, off-screen fallback
 * — see that file's own describe block), purely additive: real event wiring, not logic coverage.
 */
import { test, expect } from "@playwright/test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { closeApp, launchGitHydra, removeUserDataDir, type LaunchedApp } from "../helpers/launchApp";

let handle: LaunchedApp | undefined;

test.afterEach(async () => {
  if (!handle) return;
  await closeApp(handle);
  await removeUserDataDir(handle.userDataDir);
  handle = undefined;
});

test("opens a real BrowserWindow sized relative to the primary display on first launch, not a tiny fixed size", async () => {
  handle = await launchGitHydra();

  const primaryWorkArea = await handle.app.evaluate(({ screen }) => screen.getPrimaryDisplay().workAreaSize);
  const bounds = await handle.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds());

  // windowBounds.ts's own DEFAULT_SIZE_RATIO (~0.87) is unit-tested directly in
  // windowBounds.test.ts — this only needs to prove a REAL window really opened comfortably larger
  // than half the real display, i.e. that `createWindow()` really wired `resolveInitialBounds()`'s
  // return value into the real `new BrowserWindow(...)` call, not a hardcoded small default.
  expect(bounds.width).toBeGreaterThan(primaryWorkArea.width * 0.5);
  expect(bounds.height).toBeGreaterThan(primaryWorkArea.height * 0.5);
});

test("persists a real resize + move to disk (debounced), and restores those exact bounds on the next real launch", async () => {
  handle = await launchGitHydra();
  const userDataDir = handle.userDataDir;
  const targetBounds = { x: 120, y: 90, width: 1100, height: 760 };

  // Real Electron `BrowserWindow.setPosition`/`setSize` calls in the actual main process — genuine
  // OS-level move/resize that fire the real `resize`/`move` events `createWindow()` listens for,
  // not a synthetic emitted event (that side of the feature is `main.test.ts`'s own mock-based
  // coverage — this is deliberately the complementary "does a REAL window really behave this way"
  // half). Two separate calls, mirroring `main.ts`'s own two separate `.on("resize", ...)`/
  // `.on("move", ...)` listeners, so both real event paths are exercised independently.
  await handle.app.evaluate(({ BrowserWindow }, b) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    win.setPosition(b.x, b.y);
    win.setSize(b.width, b.height);
  }, targetBounds);

  // main.ts's persistBounds is debounced 500ms after resize/move — wait past that, then confirm
  // via the real file on disk (not a spied-on write call).
  const boundsFile = path.join(userDataDir, "window-bounds.json");
  await expect(async () => {
    const raw = await fs.readFile(boundsFile, "utf8");
    expect(JSON.parse(raw)).toMatchObject(targetBounds);
  }).toPass({ timeout: 5_000 });

  await closeApp(handle);

  const relaunched = await launchGitHydra([], userDataDir);
  handle = relaunched;
  const restoredBounds = await relaunched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds());
  expect(restoredBounds).toMatchObject(targetBounds);
});

test("persists a real close event's bounds immediately (not debounced), so a gesture right before quitting isn't lost", async () => {
  handle = await launchGitHydra();
  const userDataDir = handle.userDataDir;
  const targetBounds = { x: 60, y: 40, width: 1000, height: 700 };

  await handle.app.evaluate(({ BrowserWindow }, b) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    win.setBounds(b);
  }, targetBounds);

  // No debounce wait here — closing the real window fires the real `close` event, whose listener
  // (`main.ts`) persists immediately/synchronously, unlike resize/move's debounced path.
  await handle.app.close();
  handle = undefined;

  const boundsFile = path.join(userDataDir, "window-bounds.json");
  const raw = await fs.readFile(boundsFile, "utf8");
  expect(JSON.parse(raw)).toMatchObject(targetBounds);

  await removeUserDataDir(userDataDir);
});

test("restores a real maximized window by creating it hidden, then maximizing and showing it (no flash)", async () => {
  // First launch: real-maximize the real window, then close it (persisting isMaximized: true).
  handle = await launchGitHydra();
  const userDataDir = handle.userDataDir;
  await handle.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.maximize());

  const boundsFile = path.join(userDataDir, "window-bounds.json");
  await expect(async () => {
    const raw = await fs.readFile(boundsFile, "utf8");
    expect(JSON.parse(raw)).toMatchObject({ isMaximized: true });
  }).toPass({ timeout: 5_000 });

  await closeApp(handle);

  // Second launch against the same profile: createWindow() should restore it really maximized.
  const relaunched = await launchGitHydra([], userDataDir);
  handle = relaunched;
  const isMaximized = await relaunched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMaximized());
  expect(isMaximized).toBe(true);
});
