// SPDX-License-Identifier: GPL-3.0-or-later
import type { ReactNode, Ref } from "react";
import { IconChevronDown, IconChevronRight } from "../Icon/Icon";
import "./SectionHeader.css";

export interface SectionHeaderProps {
  /** Id of the `<h3>`; the section may label itself with it. */
  headingId?: string;
  headingRef?: Ref<HTMLHeadingElement>;
  /** A 14px glyph from Icon.tsx; rendered `aria-hidden` (the label already says what it is). */
  icon: ReactNode;
  label: string;
  /** Rendered as ` (n)` after the label; omit while unknown. */
  count?: number | null;
  collapsed: boolean;
  onToggle: () => void;
  /** Id of the element the toggle shows and hides. */
  controlsId: string;
  /** An optional trailing icon button (e.g. Create worktree). */
  action?: ReactNode;
}

/**
 * The ONE Branches-panel section heading (DESIGN.md "Branches panel sections"): chevron toggle, 14px icon, uppercase label, count,
 * optional trailing action. The toggle is a real button so Enter/Space, focus and aria-expanded come for free.
 */
export function SectionHeader({ headingId, headingRef, icon, label, count, collapsed, onToggle, controlsId, action }: SectionHeaderProps) {
  return (
    <h3 id={headingId} ref={headingRef} tabIndex={-1} className="gh-branches-panel__section-heading gh-section-header">
      <button type="button" className="gh-section-header__toggle" aria-expanded={!collapsed} aria-controls={controlsId} onClick={onToggle}>
        <span className="gh-section-header__chevron" aria-hidden="true">
          {collapsed ? <IconChevronRight size={12} /> : <IconChevronDown size={12} />}
        </span>
        <span className="gh-section-header__icon" aria-hidden="true">
          {icon}
        </span>
        <span>
          {label}
          {count === undefined || count === null ? "" : ` (${count})`}
        </span>
      </button>
      {action}
    </h3>
  );
}
