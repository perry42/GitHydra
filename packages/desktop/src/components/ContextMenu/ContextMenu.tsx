// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, type ReactNode } from "react";
import "./ContextMenu.css";

export interface ContextMenuItem {
  label: string;
  /** Disabled for v1 (FR-16 only requires the interaction surface to exist — the actual git
   * semantics belong to the branch-management/cherry-pick/merge-rebase specs). */
  disabled?: boolean;
  /** specs/cherry-pick.md FR-115/FR-122: a `title` naming the SPECIFIC reason a disabled item is
   * disabled — never a silently-disabled item with no explanation, and never color-only. Also
   * usable on an enabled item for an ordinary tooltip, though no current caller does. */
  title?: string;
  onSelect?: () => void;
}

export interface ContextMenuProps {
  x: number;
  y: number;
  sha: string;
  /** Overrides the default "Actions for commit <sha7>" aria-label — used by non-commit menus
   * (e.g. FR-55's ref-chip Checkout/Delete menu, whose `sha` slot instead carries a branch name). */
  ariaLabel?: string;
  /**
   * specs/drag-commit-menu.md FR-304: an optional header row rendered above the item list (via
   * `gh-context-menu__header` below), styled from the same surface/ink tokens the rest of this
   * component already uses — the drag-drop menu's "Dragged {A} onto {B}" identification line
   * (FR-305). Omitted (the default) by every existing caller, unchanged.
   */
  header?: ReactNode;
  items: ContextMenuItem[];
  onClose: () => void;
}

/** FR-16/FR-54/FR-55: right-click extension point on a commit node or a local-branch ref chip.
 * Cherry-pick/revert/reset remain stubs pending their own specs' PRDs.
 *
 * specs/drag-commit-menu.md FR-304: also the shared chrome for the drag-drop action menu (an
 * optional `header` slot above the items, see `ContextMenuProps` above) — one component, reused
 * pixel-for-pixel, rather than a forked visual duplicate. */
export function ContextMenu({ x, y, sha, ariaLabel, header, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onPointerDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    // specs/drag-commit-menu.md FR-316: scrolling the graph while this menu is open also closes
    // it — explicit regression coverage for the design-draft bug where an inline
    // `style.display = "block"` (used to measure the menu before positioning it) silently
    // out-specificity'd the CSS class actually controlling visibility, so scroll/Escape/
    // outside-click all appeared wired but did nothing. This component drives visibility from its
    // own mount/unmount (the CSS class on `.gh-context-menu` — see ContextMenu.css) alone, never a
    // direct `style.display` write, so that bug class can't recur here. `capture: true` is
    // required: the graph's own scroll container (`.gh-commit-graph__scroll`) is the element that
    // actually scrolls, and a plain `scroll` event does not bubble — only its capture phase
    // reaches this `document`-level listener. Benefits every `ContextMenu` instance uniformly
    // (the existing commit-row/ref-chip right-click menus too), not just the new drag-drop one.
    const onScroll = () => onClose();
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("scroll", onScroll, true);
    ref.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="gh-context-menu"
      style={{ top: y, left: x }}
      role="menu"
      aria-label={ariaLabel ?? `Actions for commit ${sha.slice(0, 7)}`}
      tabIndex={-1}
    >
      {header && <div className="gh-context-menu__header">{header}</div>}
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className="gh-context-menu__item"
          disabled={item.disabled}
          title={item.title}
          onClick={() => {
            item.onSelect?.();
            onClose();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
