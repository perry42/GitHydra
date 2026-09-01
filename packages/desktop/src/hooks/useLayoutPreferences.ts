/**
 * specs/layout-and-view-polish.md Must-have C16/C17: persists which of the toggleable right
 * panels ("none" / "changes" / "branches" / "stashes" — never "commit", which has no independent
 * toggle, see App.tsx) was last showing. Global, not per-repo (Must-have C17) — the same scope
 * `useTheme.ts`'s `githydra:theme` already has. Same try/catch-guarded pattern as `useTheme.ts`.
 *
 * specs/stash.md FR-93 extends this set with "stashes", following the exact pattern "branches"
 * already established.
 */

export type PersistedRightPanel = "none" | "changes" | "branches" | "stashes";

const RIGHT_PANEL_KEY = "githydra:layout:rightPanel";

export function getPersistedRightPanel(): PersistedRightPanel {
  if (typeof window === "undefined") return "none";
  try {
    const stored = window.localStorage?.getItem(RIGHT_PANEL_KEY);
    if (stored === "none" || stored === "changes" || stored === "branches" || stored === "stashes") return stored;
  } catch {
    // localStorage unavailable — default to "none", matching today's shipped behavior (C18).
  }
  return "none";
}

export function persistRightPanel(value: PersistedRightPanel): void {
  try {
    window.localStorage?.setItem(RIGHT_PANEL_KEY, value);
  } catch {
    // localStorage unavailable — this preference just won't persist across restarts.
  }
}
