// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { computeVisibleRange } from "../lib/virtualization";

/**
 * Windows the fixed-height rows of several stacked lists that share ONE scroll container (the Changes panel's
 * Staged/Unstaged/Untracked/Conflicted sections). A list renders only the rows near the viewport and keeps its full
 * height with top/bottom padding, so section heads and scroll position behave exactly as with every row mounted.
 * ROADMAP.md "Changes list with thousands of files": 5,000 rendered rows cost ~1 s per refresh and per click.
 */
export const WINDOW_MIN_ROWS = 200;
const OVERSCAN = 12;
const INITIAL_ROWS = 60;

export interface RowWindow {
  start: number;
  end: number;
}

export interface ListWindowing {
  /** The rows [start, end) of list `id` to mount; the whole list while it is small or the viewport is unmeasurable. */
  windowFor: (id: string, count: number) => RowWindow;
  /** Ref callback for the list's element (its top offset anchors the maths). */
  listRef: (id: string) => (el: HTMLElement | null) => void;
  /** Scrolls so row `index` of list `id` is mounted and roughly centred, unless it is already in view. */
  scrollToRow: (id: string, index: number) => void;
}

export function useListWindowing(
  scrollerRef: RefObject<HTMLElement | null>,
  counts: Readonly<Record<string, number>>,
  rowHeight: number,
): ListWindowing {
  const [ranges, setRanges] = useState<Record<string, RowWindow>>({});
  const listEls = useRef(new Map<string, HTMLElement>());
  const refCallbacks = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const countsRef = useRef(counts);
  countsRef.current = counts;
  const countsKey = Object.entries(counts)
    .map(([id, n]) => `${id}:${n}`)
    .join(",");

  const recompute = useCallback(() => {
    const sc = scrollerRef.current;
    if (!sc) return;
    const height = sc.clientHeight;
    const scRect = sc.getBoundingClientRect();
    const next: Record<string, RowWindow> = {};
    for (const [id, n] of Object.entries(countsRef.current)) {
      if (n <= WINDOW_MIN_ROWS) continue;
      const ul = listEls.current.get(id);
      if (height <= 0) {
        next[id] = { start: 0, end: n };
        continue;
      }
      if (!ul) {
        next[id] = { start: 0, end: Math.min(n, INITIAL_ROWS) };
        continue;
      }
      const listTop = ul.getBoundingClientRect().top - scRect.top + sc.scrollTop;
      const r = computeVisibleRange(sc.scrollTop - listTop, height, rowHeight, n, OVERSCAN);
      const end = Math.max(0, r.endIndex);
      next[id] = { start: Math.min(r.startIndex, end), end };
    }
    setRanges((prev) => {
      const keys = Object.keys(next);
      const same =
        keys.length === Object.keys(prev).length && keys.every((k) => prev[k]?.start === next[k]!.start && prev[k]?.end === next[k]!.end);
      return same ? prev : next;
    });
  }, [scrollerRef, rowHeight]);

  // Before paint, so a refresh that changes the counts never flashes the wrong rows.
  useLayoutEffect(() => {
    recompute();
  }, [countsKey, recompute]);

  // The scroller can mount after this hook (status flips to ready), so re-check its identity every render.
  const bound = useRef<{ el: HTMLElement; ro: ResizeObserver | null } | null>(null);
  useEffect(() => {
    const sc = scrollerRef.current;
    if (bound.current?.el === sc) return;
    if (bound.current) {
      bound.current.el.removeEventListener("scroll", recompute);
      bound.current.ro?.disconnect();
      bound.current = null;
    }
    if (!sc) return;
    sc.addEventListener("scroll", recompute, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(recompute);
    ro?.observe(sc);
    bound.current = { el: sc, ro };
  });
  useEffect(
    () => () => {
      bound.current?.el.removeEventListener("scroll", recompute);
      bound.current?.ro?.disconnect();
      bound.current = null;
    },
    [recompute],
  );

  const windowFor = useCallback(
    (id: string, count: number): RowWindow => {
      if (count <= WINDOW_MIN_ROWS) return { start: 0, end: count };
      const r = ranges[id] ?? { start: 0, end: Math.min(count, INITIAL_ROWS) };
      const end = Math.min(count, r.end);
      return { start: Math.min(r.start, end), end };
    },
    [ranges],
  );

  const listRef = useCallback((id: string) => {
    let cb = refCallbacks.current.get(id);
    if (!cb) {
      cb = (el) => {
        if (el) listEls.current.set(id, el);
        else listEls.current.delete(id);
      };
      refCallbacks.current.set(id, cb);
    }
    return cb;
  }, []);

  const scrollToRow = useCallback(
    (id: string, index: number) => {
      const sc = scrollerRef.current;
      const ul = listEls.current.get(id);
      if (!sc || !ul) return;
      const top = ul.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop + index * rowHeight;
      if (top < sc.scrollTop || top + rowHeight > sc.scrollTop + sc.clientHeight) {
        sc.scrollTop = Math.max(0, top - (sc.clientHeight - rowHeight) / 2);
      }
      recompute();
    },
    [scrollerRef, rowHeight, recompute],
  );

  return { windowFor, listRef, scrollToRow };
}
