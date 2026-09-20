// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, type ReactNode } from "react";
import { IconCheck } from "../Icon/Icon";
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
  /**
   * toolbar-action-row redesign: marks this item as the current single-select choice within a
   * radio-style menu (Pull's strategy picker, Push's remote picker) — renders `role="menuitemradio"`
   * / `aria-checked` plus a drawn `IconCheck` glyph, instead of the plain `role="menuitem"` every
   * other caller still gets. Omitted (the default, `undefined`) renders exactly the original
   * plain-action item, unchanged — existing callers (commit-row/ref-chip menus) need no update.
   */
  checked?: boolean;
  /**
   * toolbar-action-row redesign: an optional one-line explanation rendered under the label (Pull
   * strategy's "Auto follows this repository's own git config" copy, or a keybinding hint for
   * "Keyboard shortcuts…"). Omitted renders exactly the original single-line item.
   */
  description?: string;
}

interface ContextMenuBaseProps {
  x: number;
  y: number;
  /**
   * specs/drag-commit-menu.md FR-304: an optional header row rendered above the item list (via
   * `gh-context-menu__header` below), styled from the same surface/ink tokens the rest of this
   * component already uses — the drag-drop menu's "Dragged {A} onto {B}" identification line
   * (FR-305). Omitted (the default) by every existing caller, unchanged.
   */
  header?: ReactNode;
  items: ContextMenuItem[];
  onClose: () => void;
  /**
   * toolbar-action-row redesign: an optional footer row rendered below the item list — Pull's
   * strategy menu's "Applies to this pull only. Your git config is never written." caption.
   * Omitted (the default) by every existing caller, unchanged.
   */
  footer?: ReactNode;
}

/**
 * `sha`/`ariaLabel` are a discriminated pair rather than two independent optionals: every
 * commit-row/ref-chip menu supplies a real `sha` (and may optionally override its default "Actions
 * for commit <sha7>" label via `ariaLabel`); toolbar-action-row redesign's Pull-strategy/Push-
 * remote/overflow menus have no commit sha at all, so they're required to supply `ariaLabel`
 * directly instead — enforced here at the type level rather than by convention alone.
 */
export type ContextMenuProps =
  | (ContextMenuBaseProps & { sha: string; ariaLabel?: string })
  | (ContextMenuBaseProps & { sha?: undefined; ariaLabel: string });

/** FR-16/FR-54/FR-55: right-click extension point on a commit node or a local-branch ref chip.
 * Cherry-pick/revert/reset remain stubs pending their own specs' PRDs.
 *
 * specs/drag-commit-menu.md FR-304: also the shared chrome for the drag-drop action menu (an
 * optional `header` slot above the items, see `ContextMenuProps` above) — one component, reused
 * pixel-for-pixel, rather than a forked visual duplicate. */
export function ContextMenu({ x, y, sha, ariaLabel, header, items, onClose, footer }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // toolbar-action-row redesign: Up/Down/Home/End move focus among the menu's own enabled
    // items (wrapping at either end) — full keyboard support for the new Pull-strategy/Push-remote/
    // overflow menus, benefiting every existing `ContextMenu` instance uniformly (same "one
    // component, reused verbatim" reasoning the scroll-close fix above already established) rather
    // than a second, bespoke keyboard handler grown just for the new callers.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
      const container = ref.current;
      if (!container) return;
      const enabledItems = Array.from(
        container.querySelectorAll<HTMLButtonElement>(".gh-context-menu__item:not(:disabled)"),
      );
      if (enabledItems.length === 0) return;
      e.preventDefault();
      const currentIndex = enabledItems.indexOf(document.activeElement as HTMLButtonElement);
      let nextIndex: number;
      if (e.key === "Home") nextIndex = 0;
      else if (e.key === "End") nextIndex = enabledItems.length - 1;
      else if (e.key === "ArrowDown") nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % enabledItems.length;
      else nextIndex = currentIndex === -1 ? enabledItems.length - 1 : (currentIndex - 1 + enabledItems.length) % enabledItems.length;
      enabledItems[nextIndex]?.focus();
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
    // toolbar-action-row redesign: opens focus on the current radio-style choice (Pull's active
    // strategy, Push's active remote) when there is one, so arrow-key navigation starts from
    // "where you already are" rather than always the top — falling back to the first enabled item,
    // then the menu container itself, for every menu with no `checked` items at all (unchanged
    // behavior for every pre-existing caller).
    const container = ref.current;
    const checkedItem = container?.querySelector<HTMLButtonElement>('.gh-context-menu__item[aria-checked="true"]');
    const firstEnabledItem = container?.querySelector<HTMLButtonElement>(".gh-context-menu__item:not(:disabled)");
    (checkedItem ?? firstEnabledItem ?? container)?.focus();
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
      aria-label={ariaLabel ?? `Actions for commit ${(sha ?? "").slice(0, 7)}`}
      tabIndex={-1}
    >
      {header && <div className="gh-context-menu__header">{header}</div>}
      {items.map((item, index) => {
        // A description span sits inside the button and would otherwise be folded into its
        // accessible NAME (the browser's default subtree-text computation) alongside the label,
        // producing something like "AutoFollows this repository's own git config" instead of just
        // "Auto" — the exact "aria-label overrides the subtree" pitfall this codebase already has a
        // standing note about (Toolbar.tsx). An explicit `aria-label` keeps the name to the label
        // alone; `aria-describedby` still surfaces the description text to assistive tech, just as
        // a description rather than folded into the name.
        const descriptionId = item.description ? `gh-context-menu-desc-${index}` : undefined;
        return (
          <button
            key={item.label}
            type="button"
            role={item.checked === undefined ? "menuitem" : "menuitemradio"}
            aria-checked={item.checked}
            aria-label={item.description ? item.label : undefined}
            aria-describedby={descriptionId}
            className="gh-context-menu__item"
            disabled={item.disabled}
            title={item.title}
            onClick={() => {
              item.onSelect?.();
              onClose();
            }}
          >
            <span className="gh-context-menu__item-row">
              {item.checked !== undefined && (
                <span className="gh-context-menu__item-check" aria-hidden="true">
                  {item.checked && <IconCheck size={13} />}
                </span>
              )}
              <span className="gh-context-menu__item-label">{item.label}</span>
            </span>
            {item.description && (
              <span id={descriptionId} className="gh-context-menu__item-description">
                {item.description}
              </span>
            )}
          </button>
        );
      })}
      {footer && <div className="gh-context-menu__footer">{footer}</div>}
    </div>
  );
}
