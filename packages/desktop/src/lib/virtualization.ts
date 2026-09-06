// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Pure virtualization math (FR-12): given how far the user has scrolled and the viewport size,
 * compute which row indices actually need to exist as DOM/canvas work. Kept dependency-free and
 * framework-free so it's trivially unit-testable and so CommitGraph never has to re-render (or
 * even touch) rows outside this range while scrolling a 100k+ commit history.
 */
export interface VisibleRange {
  startIndex: number;
  endIndex: number; // exclusive
}

export function computeVisibleRange(
  scrollTop: number,
  containerHeight: number,
  rowHeight: number,
  itemCount: number,
  overscan = 8,
): VisibleRange {
  if (itemCount <= 0 || containerHeight <= 0 || rowHeight <= 0) {
    return { startIndex: 0, endIndex: 0 };
  }
  const firstVisible = Math.floor(scrollTop / rowHeight);
  const visibleCount = Math.ceil(containerHeight / rowHeight) + 1;
  const startIndex = Math.max(0, firstVisible - overscan);
  const endIndex = Math.min(itemCount, firstVisible + visibleCount + overscan);
  return { startIndex, endIndex };
}

/** How close to the bottom (in rows) before triggering the next incremental page load. */
export function isNearEnd(
  scrollTop: number,
  containerHeight: number,
  rowHeight: number,
  itemCount: number,
  thresholdRows = 20,
): boolean {
  if (itemCount <= 0) return false;
  const bottomRow = (scrollTop + containerHeight) / rowHeight;
  return bottomRow >= itemCount - thresholdRows;
}
