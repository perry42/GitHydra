// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * specs/layout-and-view-polish.md Must-have C16/C17: persists which of the toggleable right
 * panels ("none" / "changes" / "stashes" — never "commit", which has no independent toggle, see
 * App.tsx) was last showing. Global, not per-repo (Must-have C17) — the same scope
 * `useTheme.ts`'s `githydra:theme` already has. Same try/catch-guarded pattern as `useTheme.ts`.
 *
 * specs/stash.md FR-93 extends this set with "stashes", following the exact pattern "branches"
 * used to.
 *
 * design-pass "Branches panel relocation": "branches" was removed from this union when the
 * Branches panel moved from a toggleable right-hand rail into the persistent left sidebar
 * (`BranchesPanel.tsx`, rendered unconditionally alongside the graph rather than gated on
 * `rightPanel`) — it's no longer one of the mutually-exclusive right panels this preference
 * tracks. A previously-persisted `"branches"` value (from before this change) simply falls
 * through `getPersistedRightPanel`'s validity check below and defaults to `"none"`, same as any
 * other unrecognized stored value — no migration needed.
 */

export type PersistedRightPanel = "none" | "changes" | "stashes";

const RIGHT_PANEL_KEY = "githydra:layout:rightPanel";

export function getPersistedRightPanel(): PersistedRightPanel {
  if (typeof window === "undefined") return "none";
  try {
    const stored = window.localStorage?.getItem(RIGHT_PANEL_KEY);
    if (stored === "none" || stored === "changes" || stored === "stashes") return stored;
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

/**
 * design-pass "Branches panel relocation": whether the persistent left Branches sidebar is
 * collapsed to its slim rail — global, not per-repo (same scope as `rightPanel` above and
 * `useTheme.ts`'s theme preference), and defaults to expanded (`false`) so the relocated sidebar
 * is visible out of the box rather than requiring a first-run discovery step. Same try/catch-
 * guarded read/write pattern as every other layout preference in this module.
 */

const SIDEBAR_COLLAPSED_KEY = "githydra:layout:sidebarCollapsed";

export function getPersistedSidebarCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage?.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

export function persistSidebarCollapsed(value: boolean): void {
  try {
    window.localStorage?.setItem(SIDEBAR_COLLAPSED_KEY, value ? "true" : "false");
  } catch {
    // localStorage unavailable — this preference just won't persist across restarts.
  }
}
