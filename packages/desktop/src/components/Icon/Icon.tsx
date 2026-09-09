// SPDX-License-Identifier: GPL-3.0-or-later
import type { SVGProps } from "react";

/**
 * design-pass fix #2 ("New icon set"): the system's one authored icon vocabulary — real SVG
 * paths, never Unicode glyphs/emoji standing in for an icon. Every icon shares one 18x18 grid,
 * `currentColor` stroke, and a 2px stroke weight matching DESIGN.md's lane-line weight
 * ("Component language (first surface: commit graph)" — "Lane: 2px stroke, rounded joins"), so
 * chrome iconography reads as the same hand as the graph itself rather than a second vocabulary.
 * Reused verbatim by `Toolbar` (Branches/Changes/Stashes/Open repository/Refresh/theme toggle)
 * and `BranchesPanel`'s row-level New Branch/Checkout/Delete buttons — one icon per concept,
 * never redrawn per caller. Decorative by default (`aria-hidden`, `focusable="false"`): every
 * caller pairs an icon with a visible label or an `aria-label` on the interactive element that
 * contains it, per this system's existing "color/shape is never the only signal" policy extended
 * to icon-only controls.
 */
export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "viewBox" | "fill" | "stroke"> {
  size?: number;
}

function IconBase({ size = 18, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** Branches — a lane splitting off a trunk, echoing the graph's own transit-line grammar. */
export function IconBranches(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="5" cy="4" r="1.6" />
      <circle cx="5" cy="14" r="1.6" />
      <circle cx="13" cy="8" r="1.6" />
      <path d="M5 5.6V12.4" />
      <path d="M5 8.5c0 2.5 2.2 3.9 4.6 3.9H10" />
      <path d="M13 9.6V8" />
    </IconBase>
  );
}

/** Changes — a pencil, standing for uncommitted edits to the working tree. */
export function IconChanges(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M11.3 3.3a1.6 1.6 0 0 1 2.3 2.3L6 13.2l-3 .8.8-3Z" />
      <path d="M10 4.6l2.3 2.3" />
    </IconBase>
  );
}

/** Stashes — a stack of items set aside, distinct from the flat Changes edit glyph. */
export function IconStashes(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3" y="2.7" width="12" height="3.1" rx="1" />
      <rect x="3" y="7.4" width="12" height="3.1" rx="1" />
      <rect x="3" y="12.1" width="12" height="3.1" rx="1" />
    </IconBase>
  );
}

/** Open repository — a folder, for the dialog-launcher action. */
export function IconOpenRepo(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M2.3 5.4c0-.77.63-1.4 1.4-1.4H7l1.5 1.9h6.1c.77 0 1.4.63 1.4 1.4v6.3c0 .77-.63 1.4-1.4 1.4H3.7c-.77 0-1.4-.63-1.4-1.4Z" />
    </IconBase>
  );
}

/** Refresh — a chasing arc with an arrowhead, the system's one reload glyph. */
export function IconRefresh(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M14.2 8.4A5.7 5.7 0 1 1 12.7 4" />
      <path d="M14.4 3.8v4h-4" />
    </IconBase>
  );
}

/** Light-theme toggle target — sun. */
export function IconSun(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="9" cy="9" r="3.1" />
      <path d="M9 1.8v1.9M9 14.3v1.9M2.9 9H1M17 9h-1.9M4.2 4.2l1.3 1.3M12.5 12.5l1.3 1.3M4.2 13.8l1.3-1.3M12.5 5.5l1.3-1.3" />
    </IconBase>
  );
}

/** Dark-theme toggle target — crescent moon. */
export function IconMoon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M14.8 10.9A6.3 6.3 0 0 1 7.1 3.2a6.3 6.3 0 1 0 7.7 7.7Z" />
    </IconBase>
  );
}

/** New Branch — the Branches glyph with a small plus badge, reused wherever a branch is created. */
export function IconNewBranch(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="4.4" cy="13.6" r="1.5" />
      <circle cx="12.2" cy="13.6" r="1.5" />
      <path d="M4.4 12.3V7" />
      <path d="M4.4 9.4c0 2.2 1.9 2.9 3.9 2.9h2.4" />
      <path d="M11.6 2v5.4M9 4.7h5.2" />
    </IconBase>
  );
}

/** Checkout — an arrow moving into a lane, standing for switching to a branch/ref. */
export function IconCheckout(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 2.5v13" />
      <path d="M7.5 9H15" />
      <path d="M11.5 5.3 15.2 9l-3.7 3.7" />
    </IconBase>
  );
}

/**
 * specs/repo-list.md: the landing screen's visually-reserved (not yet wired up — see
 * `EmptyState`'s own doc comment) "Clone a repository" slot — `IconOpenRepo`'s folder shape with
 * an inbound arrow, so the two landing actions read as a clear pair (open a local folder vs. bring
 * one down from elsewhere) rather than two unrelated glyphs.
 */
export function IconClone(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M2.3 5.4c0-.77.63-1.4 1.4-1.4H7l1.5 1.9h6.1c.77 0 1.4.63 1.4 1.4v6.3c0 .77-.63 1.4-1.4 1.4H3.7c-.77 0-1.4-.63-1.4-1.4Z" />
      <path d="M9 7.6v3.8M7.2 9.6 9 11.4l1.8-1.8" />
    </IconBase>
  );
}

/**
 * Calendar — a simple month grid, standing in for the From/To date fields' native calendar
 * affordance. specs/filter-bar-visual-redesign.md FR-255: introduced because Chromium's
 * `::-webkit-calendar-picker-indicator` pseudo-element does not respond to the `color` property
 * (confirmed by `e2e-playwright/electron/filterBarDateIconColor.spec.ts` — the glyph renders pure
 * browser-default black regardless of that CSS rule), so `FilterBar` hides the native glyph
 * (`opacity: 0`, still in place and clickable) and layers this token-colored icon on top instead —
 * the only way to get `var(--gh-ink-muted)`/`var(--gh-accent)` pixel-exact in both themes.
 */
export function IconCalendar(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="2.5" y="3.4" width="13" height="12.1" rx="1.4" />
      <path d="M2.5 7.2h13" />
      <path d="M5.8 2v2.8M12.2 2v2.8" />
    </IconBase>
  );
}

/** Delete — a trash can, the system's one destructive-action glyph. */
export function IconDelete(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M3 5.1h12" />
      <path d="M7 5.1V3.6c0-.66.54-1.2 1.2-1.2h1.6c.66 0 1.2.54 1.2 1.2v1.5" />
      <path d="M5.7 5.1V14c0 .66.54 1.2 1.2 1.2h4.2c.66 0 1.2-.54 1.2-1.2V5.1" />
      <path d="M7.8 7.8v4.4M10.2 7.8v4.4" />
    </IconBase>
  );
}
