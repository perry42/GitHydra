// SPDX-License-Identifier: GPL-3.0-or-later

export type ActionIconKind = "stage" | "unstage" | "discard" | "ignore" | "clear";

const PATHS: Record<ActionIconKind, string> = {
  stage: "M8 3v10M3 8h10",
  unstage: "M3 8h10",
  discard: "M3 7h7a3 3 0 010 6H6M3 7l3-3M3 7l3 3",
  ignore: "M2 8s2.5-4.5 6-4.5S14 8 14 8s-2.5 4.5-6 4.5S2 8 2 8zM3 13L13 3",
  clear: "M4 4l8 8M12 4l-8 8",
};

/** One stroke icon vocabulary for the Changes panel's row, header and bulk-bar buttons (DESIGN.md: icon + text label, never icon alone for meaning). */
export function ActionIcon({ kind, className }: { kind: ActionIconKind; className?: string }) {
  return (
    <svg className={`gh-action-icon${className ? ` ${className}` : ""}`} viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path d={PATHS[kind]} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
