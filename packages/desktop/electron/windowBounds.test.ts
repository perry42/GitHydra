import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  boundsAreOnScreen,
  computeDefaultBounds,
  debounce,
  loadWindowBounds,
  resolveInitialBounds,
  saveWindowBounds,
  type WindowBounds,
} from "./windowBounds";

const PRIMARY_1080P = { width: 1920, height: 1080 };
const DISPLAY_1080P = { x: 0, y: 0, width: 1920, height: 1080 };

describe("computeDefaultBounds", () => {
  it("sizes to ~85-90% of the primary display's work area, not a fixed pixel size", () => {
    const bounds = computeDefaultBounds(PRIMARY_1080P);
    expect(bounds.width).toBeGreaterThan(PRIMARY_1080P.width * 0.8);
    expect(bounds.width).toBeLessThan(PRIMARY_1080P.width * 0.95);
    expect(bounds.height).toBeGreaterThan(PRIMARY_1080P.height * 0.8);
    expect(bounds.height).toBeLessThan(PRIMARY_1080P.height * 0.95);
    expect(bounds.isMaximized).toBe(false);
  });

  it("centers the window on the work area", () => {
    const bounds = computeDefaultBounds(PRIMARY_1080P);
    expect(bounds.x).toBeCloseTo((PRIMARY_1080P.width - bounds.width) / 2, 0);
    expect(bounds.y).toBeCloseTo((PRIMARY_1080P.height - bounds.height) / 2, 0);
  });

  it("looks reasonable on a small laptop screen (not cramped, not overflowing)", () => {
    const laptop = { width: 1366, height: 768 };
    const bounds = computeDefaultBounds(laptop);
    expect(bounds.width).toBeLessThanOrEqual(laptop.width);
    expect(bounds.height).toBeLessThanOrEqual(laptop.height);
    expect(bounds.width).toBeGreaterThanOrEqual(880); // createWindow()'s own minWidth
    expect(bounds.height).toBeGreaterThanOrEqual(560); // createWindow()'s own minHeight
  });

  it("looks reasonable on an ultrawide monitor (clamped, not literally 85% of 3440px)", () => {
    const ultrawide = { width: 3440, height: 1440 };
    const bounds = computeDefaultBounds(ultrawide);
    // Clamped well below a literal 85% of 3440 (2924px) — not tiny, not absurdly huge either.
    expect(bounds.width).toBeLessThan(2000);
    expect(bounds.width).toBeGreaterThanOrEqual(880);
  });

  it("never goes below the app's own enforced minimum on a tiny display", () => {
    const tiny = { width: 700, height: 400 };
    const bounds = computeDefaultBounds(tiny);
    expect(bounds.width).toBeGreaterThanOrEqual(880);
    expect(bounds.height).toBeGreaterThanOrEqual(560);
  });
});

describe("boundsAreOnScreen", () => {
  const saved: WindowBounds = { x: 100, y: 100, width: 1400, height: 900, isMaximized: false };

  it("true when the saved bounds overlap a current display", () => {
    expect(boundsAreOnScreen(saved, [DISPLAY_1080P])).toBe(true);
  });

  it("false when the saved bounds are entirely off every current display (e.g. an unplugged second monitor)", () => {
    const offscreen: WindowBounds = { x: 5000, y: 5000, width: 1400, height: 900, isMaximized: false };
    expect(boundsAreOnScreen(offscreen, [DISPLAY_1080P])).toBe(false);
  });

  it("false when there are no current displays at all", () => {
    expect(boundsAreOnScreen(saved, [])).toBe(false);
  });

  it("true when the saved bounds overlap at least one of several current displays", () => {
    const secondDisplay = { x: 1920, y: 0, width: 1920, height: 1080 };
    const onSecond: WindowBounds = { x: 2000, y: 100, width: 1400, height: 900, isMaximized: false };
    expect(boundsAreOnScreen(onSecond, [DISPLAY_1080P, secondDisplay])).toBe(true);
  });
});

describe("resolveInitialBounds", () => {
  it("uses the saved bounds when present, valid, and on-screen", () => {
    const saved: WindowBounds = { x: 50, y: 60, width: 1200, height: 800, isMaximized: false };
    const resolved = resolveInitialBounds(saved, [DISPLAY_1080P], PRIMARY_1080P);
    expect(resolved).toEqual(saved);
  });

  it("preserves a saved maximized flag", () => {
    const saved: WindowBounds = { x: 50, y: 60, width: 1200, height: 800, isMaximized: true };
    const resolved = resolveInitialBounds(saved, [DISPLAY_1080P], PRIMARY_1080P);
    expect(resolved.isMaximized).toBe(true);
  });

  it("falls back to a fresh default when nothing is saved (first launch)", () => {
    const resolved = resolveInitialBounds(null, [DISPLAY_1080P], PRIMARY_1080P);
    expect(resolved).toEqual(computeDefaultBounds(PRIMARY_1080P));
  });

  it("falls back to a fresh default when the saved position is now off-screen, rather than opening somewhere unreachable", () => {
    const offscreen: WindowBounds = { x: 9000, y: 9000, width: 1400, height: 900, isMaximized: false };
    const resolved = resolveInitialBounds(offscreen, [DISPLAY_1080P], PRIMARY_1080P);
    expect(resolved).toEqual(computeDefaultBounds(PRIMARY_1080P));
  });

  it("falls back to a fresh default when the saved bounds are structurally invalid (corrupted file)", () => {
    const corrupted = { x: 10, y: 10, width: -5, height: NaN } as unknown as WindowBounds;
    const resolved = resolveInitialBounds(corrupted, [DISPLAY_1080P], PRIMARY_1080P);
    expect(resolved).toEqual(computeDefaultBounds(PRIMARY_1080P));
  });

  it("clamps a saved width/height narrower than the app's own minimum back up to it", () => {
    const tooSmall: WindowBounds = { x: 50, y: 60, width: 500, height: 300, isMaximized: false };
    const resolved = resolveInitialBounds(tooSmall, [DISPLAY_1080P], PRIMARY_1080P);
    expect(resolved.width).toBeGreaterThanOrEqual(880);
    expect(resolved.height).toBeGreaterThanOrEqual(560);
  });
});

describe("loadWindowBounds / saveWindowBounds (real fs, temp userData dir)", () => {
  let tmpUserData: string;

  beforeEach(async () => {
    tmpUserData = await fs.promises.mkdtemp(path.join(os.tmpdir(), "githydra-windowbounds-"));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpUserData, { recursive: true, force: true });
  });

  it("returns null when nothing has been saved yet (first launch)", () => {
    expect(loadWindowBounds(tmpUserData)).toBeNull();
  });

  it("round-trips a saved bounds object", () => {
    const bounds: WindowBounds = { x: 20, y: 30, width: 1500, height: 950, isMaximized: false };
    saveWindowBounds(tmpUserData, bounds);
    expect(loadWindowBounds(tmpUserData)).toEqual(bounds);
  });

  it("round-trips isMaximized: true", () => {
    const bounds: WindowBounds = { x: 0, y: 0, width: 1920, height: 1080, isMaximized: true };
    saveWindowBounds(tmpUserData, bounds);
    expect(loadWindowBounds(tmpUserData)).toEqual(bounds);
  });

  it("returns null (not a throw) when the persisted file is corrupted/not JSON", async () => {
    await fs.promises.mkdir(tmpUserData, { recursive: true });
    await fs.promises.writeFile(path.join(tmpUserData, "window-bounds.json"), "{not valid json", "utf8");
    expect(loadWindowBounds(tmpUserData)).toBeNull();
  });

  it("never throws even if the userData directory doesn't exist at all (guarded like localStorage reads elsewhere in this app)", () => {
    const missingDir = path.join(tmpUserData, "does", "not", "exist");
    expect(() => loadWindowBounds(missingDir)).not.toThrow();
    expect(loadWindowBounds(missingDir)).toBeNull();
  });

  it("creates the userData directory on save if it doesn't exist yet, rather than throwing", () => {
    const nestedDir = path.join(tmpUserData, "nested", "userdata");
    const bounds: WindowBounds = { x: 0, y: 0, width: 1400, height: 900, isMaximized: false };
    expect(() => saveWindowBounds(nestedDir, bounds)).not.toThrow();
    expect(loadWindowBounds(nestedDir)).toEqual(bounds);
  });
});

describe("debounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces rapid calls (e.g. a live resize drag) into exactly one trailing call", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 500);
    debounced();
    debounced();
    debounced();
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("passes through the latest call's arguments", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 500);
    debounced("first");
    debounced("second");
    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledWith("second");
  });

  it("fires again after the wait window if called again later", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 500);
    debounced();
    vi.advanceTimersByTime(500);
    debounced();
    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
