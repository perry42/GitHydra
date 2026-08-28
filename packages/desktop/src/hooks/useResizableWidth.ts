import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

/**
 * specs/layout-and-view-polish.md Must-have C: a single generic drag-to-resize-a-width hook,
 * shared by all five handles (ChangesPanel/DetailPanel/BranchesPanel width, and the file-list/
 * diff divider inside each of the first two). Persists to `localStorage` using the exact
 * try/catch-guarded read/write pattern `useTheme.ts` already establishes (AC15's "no crash in a
 * private-mode/unavailable-storage environment").
 */

function clamp(value: number, min: number, max: number): number {
  // AC13: the panel's own minimum always wins over a (possibly smaller, e.g. a shrunk window's)
  // max — never squeeze narrower than min, never push the graph pane off-screen.
  const effectiveMax = Math.max(max, min);
  return Math.min(Math.max(value, min), effectiveMax);
}

function readStored(storageKey: string, defaultWidth: number, min: number, max: number): number {
  if (typeof window === "undefined") return defaultWidth;
  try {
    const raw = window.localStorage?.getItem(storageKey);
    if (raw == null) return defaultWidth;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return defaultWidth;
    // Must-have C19: a persisted width from a larger window/session is clamped down at read time.
    return clamp(parsed, min, max);
  } catch {
    // localStorage unavailable (e.g. private mode) — fall back to the shipped default.
    return defaultWidth;
  }
}

export interface UseResizableWidthOptions {
  /** e.g. "githydra:layout:changesPanelWidth" — see the spec's suggested key list. */
  storageKey: string;
  defaultWidth: number;
  min: number;
  /** Called to get the current max (e.g. `80vw` in px, or 50% of a live panel width) — invoked
   * fresh on every drag/keyboard step and on window resize, so it always reflects the current
   * window/panel size rather than a stale snapshot from mount time. */
  getMax: () => number;
  /** +1: dragging the pointer right increases width (e.g. a left-edge column's right-hand
   * divider). -1: dragging the pointer left increases width (e.g. a right-edge panel's left-edge
   * handle, since the panel sits to the right of the handle). */
  direction: 1 | -1;
  /** Keyboard step in px (Must-have C15's "fixed 16px increments"). */
  step?: number;
}

export interface UseResizableWidthResult {
  width: number;
  /** Spread onto the drag-handle element — `role="separator"`, `aria-orientation="vertical"`,
   * live `aria-valuenow`/min/max, and the pointer/keyboard handlers (Must-have C15). */
  separatorProps: {
    role: "separator";
    "aria-orientation": "vertical";
    "aria-valuenow": number;
    "aria-valuemin": number;
    "aria-valuemax": number;
    tabIndex: 0;
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => void;
    onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
  };
}

export function useResizableWidth({
  storageKey,
  defaultWidth,
  min,
  getMax,
  direction,
  step = 16,
}: UseResizableWidthOptions): UseResizableWidthResult {
  const [width, setWidth] = useState<number>(() => readStored(storageKey, defaultWidth, min, getMax()));
  // Tracks the true latest value independent of React's render/commit timing, so a drag
  // gesture's final `persist()` call (at pointerup) never races a not-yet-committed render —
  // see the module doc comment on why this can't just read `width` from closure/state.
  const liveWidthRef = useRef(width);
  liveWidthRef.current = width;

  const persist = useCallback(
    (value: number) => {
      try {
        window.localStorage?.setItem(storageKey, String(Math.round(value)));
      } catch {
        // localStorage unavailable — this size just won't persist across restarts (AC15).
      }
    },
    [storageKey],
  );

  // AC13: re-clamp on window resize (e.g. the app window itself is dragged smaller), not just at
  // initial read time — a width that was valid a moment ago can exceed the live 80vw cap now.
  useEffect(() => {
    function onResize() {
      setWidth((w) => {
        const next = clamp(w, min, getMax());
        liveWidthRef.current = next;
        return next;
      });
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [min]);

  const onPointerDown = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      // Only the primary button/touch-equivalent starts a drag.
      if (e.button !== 0) return;
      e.preventDefault();
      const handle = e.currentTarget;
      handle.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startWidth = liveWidthRef.current;

      function onMove(ev: globalThis.PointerEvent) {
        const delta = (ev.clientX - startX) * direction;
        const next = clamp(startWidth + delta, min, getMax());
        liveWidthRef.current = next;
        setWidth(next);
      }
      function onUp() {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        // Must-have C20/AC14: exactly one write per drag gesture, committed here on pointer-up —
        // never inside onMove, which fires once per pixel of movement.
        persist(liveWidthRef.current);
      }
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [direction, getMax, min, persist],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      let delta = 0;
      if (e.key === "ArrowRight") delta = step;
      else if (e.key === "ArrowLeft") delta = -step;
      else return;
      e.preventDefault();
      const next = clamp(liveWidthRef.current + delta, min, getMax());
      liveWidthRef.current = next;
      setWidth(next);
      // A single keypress is already a complete, discrete gesture (unlike a mouse drag's stream
      // of pointermove events) — persisting immediately here doesn't violate AC14's "one write
      // per drag gesture," which is specifically about coalescing rapid pointer-move spam.
      persist(next);
    },
    [getMax, min, persist, step],
  );

  const max = getMax();
  return {
    width,
    separatorProps: {
      role: "separator",
      "aria-orientation": "vertical",
      "aria-valuenow": Math.round(width),
      "aria-valuemin": Math.round(min),
      "aria-valuemax": Math.round(max),
      tabIndex: 0,
      onPointerDown,
      onKeyDown,
    },
  };
}
