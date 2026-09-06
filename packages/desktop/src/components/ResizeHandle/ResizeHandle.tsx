// SPDX-License-Identifier: GPL-3.0-or-later
import type { KeyboardEvent, PointerEvent } from "react";
import "./ResizeHandle.css";

export interface ResizeHandleProps {
  /** Accessible name — e.g. "Resize Changes panel" (Must-have C15/AC9). */
  label: string;
  role: "separator";
  "aria-orientation": "vertical";
  "aria-valuenow": number;
  "aria-valuemin": number;
  "aria-valuemax": number;
  tabIndex: 0;
  onPointerDown: (e: PointerEvent<HTMLDivElement>) => void;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
}

/**
 * specs/layout-and-view-polish.md Must-have C13/C15: the shared drag-handle used by all five
 * resizable surfaces (ChangesPanel/DetailPanel/BranchesPanel width, and the file-list/diff
 * divider inside the first two) — one component so the pattern (hit target, hover/focus
 * treatment, keyboard contract) never forks between the five instances. Purely presentational;
 * all drag/keyboard/persistence logic lives in `useResizableWidth` — this just spreads its
 * `separatorProps` output plus an accessible `label`, so the two can never drift out of sync.
 */
export function ResizeHandle({ label, ...separatorProps }: ResizeHandleProps) {
  return (
    <div className="gh-resize-handle" aria-label={label} {...separatorProps}>
      <div className="gh-resize-handle__grip" aria-hidden="true" />
    </div>
  );
}
