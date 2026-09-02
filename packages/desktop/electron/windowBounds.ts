import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Layout-persistence fix (confirmed directly with the user, not routed through product-manager —
 * a UX preference call, not a product-principle question): persists the OS window's own bounds
 * (size + position + maximized state) across relaunches. `main.ts`'s `createWindow()` used to
 * hardcode `width: 1400, height: 900` on every launch — the user resizing/moving the actual OS
 * window had no memory at all, unlike every other layout preference in this app (theme, panel
 * widths — see `RIGHT_PANEL_STORAGE_KEY` in `src/lib/layoutSizes.ts`).
 *
 * This is main-process-only work: Node has full fs access here, unlike the renderer's
 * `localStorage`-only pattern — and `BrowserWindow` bounds aren't something the renderer can
 * read/set itself anyway. Deliberately kept as pure, Electron-import-free functions so almost all
 * of this file's logic is testable without mocking the `electron` module at all — only `main.ts`'s
 * own wiring (reading `screen.getAllDisplays()`, listening for resize/move/close,
 * `app.getPath('userData')`) needs the real Electron mock `main.test.ts` already establishes.
 */

export interface WindowBounds {
  width: number;
  height: number;
  x: number;
  y: number;
  isMaximized: boolean;
}

/** Minimal shape of `Electron.Rectangle`/work-area size — avoids a runtime import of `electron`
 * from this otherwise-pure module (only `main.ts` needs the real thing). */
export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Mirrors createWindow()'s own minWidth/minHeight (electron/main.ts) — the default/fallback size
// this module computes must never itself be smaller than what the window enforces at runtime.
const MIN_WIDTH = 880;
const MIN_HEIGHT = 560;
// A generous ceiling so an ultrawide/very-tall display doesn't get a window that's technically
// "85% of the screen" but still absurdly large — still comfortably bigger than any normal laptop
// screen's full work area.
const MAX_DEFAULT_WIDTH = 1800;
const MAX_DEFAULT_HEIGHT = 1200;
// ~85-90% of the primary display's work area, per the fix's brief.
const DEFAULT_SIZE_RATIO = 0.87;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * First-launch / invalid-saved-bounds fallback: sized relative to the primary display's actual
 * work area (not a fixed 1400x900) so it looks reasonable on both a small laptop screen and an
 * ultrawide monitor, rather than a fixed pixel size that's cramped on one and tiny on the other.
 * Centered on that work area.
 */
export function computeDefaultBounds(primaryWorkArea: { width: number; height: number }): WindowBounds {
  const width = clamp(Math.round(primaryWorkArea.width * DEFAULT_SIZE_RATIO), MIN_WIDTH, MAX_DEFAULT_WIDTH);
  const height = clamp(Math.round(primaryWorkArea.height * DEFAULT_SIZE_RATIO), MIN_HEIGHT, MAX_DEFAULT_HEIGHT);
  const x = Math.round((primaryWorkArea.width - width) / 2);
  const y = Math.round((primaryWorkArea.height - height) / 2);
  return { width, height, x, y, isMaximized: false };
}

/** Two rectangles intersect if they overlap on both axes (a real, non-zero overlap) — a window
 * whose edge merely touches a display's edge (0-width overlap) doesn't count as "reachable." */
function rectanglesIntersect(a: Rectangle, b: Rectangle): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** Guards against a saved position that's now off-screen (e.g. the user unplugged a second
 * monitor since last launch) — the saved bounds must intersect at least one CURRENT display's
 * work area, otherwise the window would open somewhere the user can't see or reach. */
export function boundsAreOnScreen(bounds: Rectangle, displayWorkAreas: readonly Rectangle[]): boolean {
  return displayWorkAreas.some((display) => rectanglesIntersect(bounds, display));
}

function isValidBounds(value: unknown): value is WindowBounds {
  if (!value || typeof value !== "object") return false;
  const b = value as Record<string, unknown>;
  return (
    Number.isFinite(b.width) &&
    Number.isFinite(b.height) &&
    Number.isFinite(b.x) &&
    Number.isFinite(b.y) &&
    (b.width as number) > 0 &&
    (b.height as number) > 0 &&
    typeof b.isMaximized === "boolean"
  );
}

/**
 * Resolves the bounds to actually open the window with: the saved bounds, if present, structurally
 * valid, and on-screen against the CURRENT display arrangement; otherwise a fresh default sized to
 * the primary display's current work area. Never returns bounds narrower/shorter than
 * `MIN_WIDTH`/`MIN_HEIGHT` (`createWindow()`'s own enforced minimum).
 */
export function resolveInitialBounds(
  saved: WindowBounds | null,
  displayWorkAreas: readonly Rectangle[],
  primaryWorkArea: { width: number; height: number },
): WindowBounds {
  if (saved && isValidBounds(saved) && boundsAreOnScreen(saved, displayWorkAreas)) {
    return {
      ...saved,
      width: Math.max(saved.width, MIN_WIDTH),
      height: Math.max(saved.height, MIN_HEIGHT),
    };
  }
  return computeDefaultBounds(primaryWorkArea);
}

function boundsFilePath(userDataPath: string): string {
  return path.join(userDataPath, "window-bounds.json");
}

/** Reads persisted bounds from `<userData>/window-bounds.json`. Guarded like every other
 * localStorage-pattern read in this app (`useResizableWidth.ts`'s `readStored`, `useTheme.ts`) —
 * never throws, e.g. on first launch (file doesn't exist yet) or a corrupted/foreign-shaped file. */
export function loadWindowBounds(userDataPath: string): WindowBounds | null {
  try {
    const raw = fs.readFileSync(boundsFilePath(userDataPath), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isValidBounds(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Writes persisted bounds. Guarded the same way — a write failure (e.g. a read-only userData
 * directory in some sandboxed environment) just means bounds won't persist this session, not a
 * crash. Callers are responsible for debouncing (`resize`/`move` fire per-pixel-of-drag). */
export function saveWindowBounds(userDataPath: string, bounds: WindowBounds): void {
  try {
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.writeFileSync(boundsFilePath(userDataPath), JSON.stringify(bounds));
  } catch {
    // best-effort persistence only — see doc comment above.
  }
}

/** Simple trailing-edge debounce — `resize`/`move` fire on every pixel of a live drag, and
 * Must-have-style precedent elsewhere in this app (`useResizableWidth.ts`'s AC14) is "coalesce to
 * one write per gesture," not one write per event. */
export function debounce<Args extends unknown[]>(fn: (...args: Args) => void, waitMs: number): (...args: Args) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: Args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, waitMs);
  };
}
