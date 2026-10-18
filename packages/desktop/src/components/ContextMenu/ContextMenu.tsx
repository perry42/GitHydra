// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { IconCheck, IconChevronDown, IconChevronRight } from "../Icon/Icon";
import "./ContextMenu.css";

/** One row of an accordion's expanded list (specs/external-programs.md FR-617). */
export interface ContextMenuAccordionChild {
  key: string;
  label: string;
  /** A muted word after the label, e.g. "default". */
  badge?: string;
  /** Draws the check; used for the current default. */
  checked?: boolean;
  /** Stays focusable (aria-disabled), never skipped: `reason` is its aria-describedby text. */
  disabled?: boolean;
  reason?: string;
  separatorBefore?: boolean;
  onSelect: () => void;
}

/**
 * specs/external-programs.md FR-617: an inline accordion row inside the flat menu (no cascading submenu). The row body runs the
 * default; the chevron or Right expands `children` in place; Left collapses. Opens collapsed unless `initiallyExpanded`.
 */
export interface ContextMenuAccordion {
  children: ContextMenuAccordionChild[];
  /** An extra muted line above the hint, e.g. "Checked out at <path>" (specs/worktrees.md FR-607). Part of the description too. */
  contextLine?: string;
  /** Visible secondary line, e.g. "Opens in Cursor". */
  hint: string;
  /** The accessible description, also a real element (aria-description is not announced everywhere). */
  description: string;
  /** Row body click / Enter. Omitted: the body expands instead (first run, no default). */
  onBodyActivate?: () => void;
  /** Child that receives focus on expand. */
  defaultKey?: string;
  initiallyExpanded?: boolean;
  /** Called once when the menu mounts, so the caller can re-validate its list with a stat. */
  onMenuOpen?: () => void;
}

export interface ContextMenuItem {
  label: string;
  accordion?: ContextMenuAccordion;
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
  /**
   * Follow-up to specs/ref-chip-gutter-legibility.md FR-411: an optional icon rendered before the
   * label (`CommitGraph.tsx`'s "+N" ref-collapse popover uses this to show the same per-type icon
   * `RefChip.tsx` renders on the visible chip — `RefChip.tsx`'s exported `TYPE_ICON` map). Omitted
   * (the default) renders exactly as before — every other existing caller needs no change. Always
   * `aria-hidden` here, same as on the chip itself: the item's own accessible name still comes from
   * its `label`/`aria-label`, never the icon.
   */
  icon?: ReactNode;
  /** Informational row (content, not an unavailable action): stays `disabled` for click/keyboard
   * purposes but is styled in primary ink rather than the dimmed disabled treatment. */
  informational?: boolean;
  /** Custom row content (e.g. a real `RefChip`) rendered in place of the icon + label text. The
   * button's accessible name still comes from `label` (applied as `aria-label`). */
  content?: ReactNode;
  /** Chip-drag drop target: the WHOLE row button is the target (stamped with the same
   * `data-ref-branch`/`data-ref-sha` the gutter chips use), not a small element nested inside it. */
  dropTarget?: { branch: string; sha: string };
  /** This row is the chip-drag target currently under the pointer — fills the whole row. */
  dropActive?: boolean;
  /** Right-click on the row (e.g. a branch chip in the "+N" popover opening that branch's own menu). */
  onContextMenu?: (event: MouseEvent<HTMLButtonElement>) => void;
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
  // Every caller supplies `x`/`y` as "the anchor point," never knowing this menu's own rendered
  // size in advance (item count/description text/header vary per caller) — so a menu anchored
  // near the right or bottom edge of the window (the Toolbar's rightmost "More actions" button is
  // the first caller to actually hit this, but any caller can) can render partially or fully off
  // screen with no way to reach or even see the cut-off items. `position` starts at the given
  // anchor and is clamped to the actual viewport the instant this menu's real size is known —
  // before the browser paints (`useLayoutEffect`, not `useEffect`), so there's no visible flash at
  // the wrong position first.
  const [position, setPosition] = useState({ left: x, top: y });
  // FR-617: one accordion at a time, keyed by the item label; `focusAfter` says where focus goes once the new state has rendered.
  const [expandedKey, setExpandedKey] = useState<string | null>(() => items.find((i) => i.accordion?.initiallyExpanded)?.label ?? null);
  const focusAfter = useRef<"child" | "parent" | null>(null);
  const idBase = useId();
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const expandedKeyRef = useRef(expandedKey);
  expandedKeyRef.current = expandedKey;

  useEffect(() => {
    for (const i of itemsRef.current) i.accordion?.onMenuOpen?.();
  }, []);

  useEffect(() => {
    const where = focusAfter.current;
    if (!where) return;
    focusAfter.current = null;
    const container = ref.current;
    if (!container) return;
    if (where === "child") {
      const child =
        container.querySelector<HTMLElement>('.gh-context-menu__item--child[data-default="true"]') ??
        container.querySelector<HTMLElement>(".gh-context-menu__item--child");
      child?.focus();
    } else {
      container.querySelector<HTMLElement>(".gh-context-menu__item--accordion")?.focus();
    }
  }, [expandedKey]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    const left = Math.min(x, Math.max(margin, window.innerWidth - rect.width - margin));
    const top = Math.min(y, Math.max(margin, window.innerHeight - rect.height - margin));
    setPosition({ left, top });
  }, [x, y]);

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
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        // Only the accordion cares: Right expands from its row, Left collapses from the row or any child.
        const active = document.activeElement as HTMLElement | null;
        const inAccordion = active?.closest(".gh-context-menu__accordion") ?? null;
        if (!inAccordion) return;
        e.preventDefault();
        const key = inAccordion.getAttribute("data-accordion-key");
        const open = key !== null && key === expandedKeyRef.current;
        if (e.key === "ArrowRight") {
          if (!active?.classList.contains("gh-context-menu__item--accordion") || key === null) return;
          focusAfter.current = "child";
          if (open) {
            // Already open: just move into the list.
            focusAfter.current = null;
            inAccordion.querySelector<HTMLElement>('.gh-context-menu__item--child[data-default="true"], .gh-context-menu__item--child')?.focus();
          } else setExpandedKey(key);
        } else if (open) {
          focusAfter.current = "parent";
          setExpandedKey(null);
        }
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
      // Found via test-agent's real-keyboard verification of specs/ref-chip-gutter-legibility.md
      // FR-411's "+N" popover (every row there is `disabled: true` by design — informational only):
      // `preventDefault()` used to run AFTER the `enabledItems.length === 0` early-return, so for a
      // menu with zero enabled items, Arrow/Home/End fell through to the browser's own native
      // default — scrolling the underlying graph into view — which this component's OWN separate
      // FR-316 "close on any scroll of the graph" listener then reacted to, closing the very menu
      // the keypress was trying to navigate. Moved above the early-return so an open ContextMenu
      // NEVER lets a native default fire for these keys, regardless of whether it has anything to
      // move focus among — the rest of this handler (focus movement) still no-ops correctly below
      // when `enabledItems` is empty.
      e.preventDefault();
      const container = ref.current;
      if (!container) return;
      const enabledItems = Array.from(
        // Accordion children stay in the order even when disabled: their reason must be reachable by keyboard (FR-617).
        container.querySelectorAll<HTMLButtonElement>(".gh-context-menu__item--child, .gh-context-menu__item:not(:disabled):not([aria-disabled='true'])"),
      );
      if (enabledItems.length === 0) return;
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
    const firstEnabledItem = container?.querySelector<HTMLButtonElement>(".gh-context-menu__item:not(:disabled):not([aria-disabled='true'])");
    // An accordion that opens expanded (the chooser) starts on its default child, else its first one.
    const initialChild =
      container?.querySelector<HTMLButtonElement>('.gh-context-menu__item--child[data-default="true"]') ??
      container?.querySelector<HTMLButtonElement>(".gh-context-menu__item--child");
    (initialChild ?? checkedItem ?? firstEnabledItem ?? container)?.focus();
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [onClose]);

  const renderAccordion = (item: ContextMenuItem, id: string) => {
    const acc = item.accordion!;
    const expanded = expandedKey === item.label;
    const descId = `${id}-desc`;
    const childrenId = `${id}-children`;
    const contextId = acc.contextLine ? `${id}-context` : undefined;
    return (
      <div key={item.label} className="gh-context-menu__accordion" data-accordion-key={item.label}>
        <button
          type="button"
          role="menuitem"
          className={`gh-context-menu__item gh-context-menu__item--accordion${expanded ? " gh-context-menu__item--expanded" : ""}`}
          aria-label={item.label}
          aria-haspopup="menu"
          aria-expanded={expanded}
          aria-controls={expanded ? childrenId : undefined}
          aria-describedby={contextId ? `${contextId} ${descId}` : descId}
          title={item.title}
          onClick={(e) => {
            const onChevron = (e.target as HTMLElement).closest(".gh-context-menu__chevron") !== null;
            if (onChevron || !acc.onBodyActivate) {
              focusAfter.current = expanded ? "parent" : "child";
              setExpandedKey(expanded ? null : item.label);
              return;
            }
            acc.onBodyActivate();
            onClose();
          }}
        >
          <span className="gh-context-menu__item-row">
            <span className="gh-context-menu__item-label">{item.label}</span>
            <span className="gh-context-menu__chevron" aria-hidden="true">
              {expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
            </span>
          </span>
          {acc.contextLine && (
            <span id={contextId} className="gh-context-menu__item-description">
              {acc.contextLine}
            </span>
          )}
          <span className="gh-context-menu__item-description" aria-hidden="true">
            {acc.hint}
          </span>
        </button>
        <span id={descId} className="gh-visually-hidden">
          {acc.description}
        </span>
        {expanded && (
          <div id={childrenId} role="menu" aria-label={`${item.label}: choose a program`} className="gh-context-menu__children">
            {acc.children.map((child) => {
              const reasonId = child.disabled && child.reason ? `${id}-${child.key}-reason` : undefined;
              return (
                <div key={child.key} className={`gh-context-menu__child-group${child.separatorBefore ? " gh-context-menu__child-group--separated" : ""}`}>
                  <button
                    type="button"
                    role="menuitem"
                    className="gh-context-menu__item gh-context-menu__item--child"
                    data-default={acc.defaultKey === child.key ? "true" : undefined}
                    aria-disabled={child.disabled ? true : undefined}
                    aria-describedby={reasonId}
                    onClick={() => {
                      if (child.disabled) return;
                      child.onSelect();
                      onClose();
                    }}
                  >
                    <span className="gh-context-menu__item-row">
                      <span className="gh-context-menu__item-check" aria-hidden="true">
                        {child.checked && <IconCheck size={13} />}
                      </span>
                      <span className="gh-context-menu__item-label">{child.label}</span>
                      {child.badge && <span className="gh-context-menu__badge">{child.badge}</span>}
                    </span>
                    {child.disabled && child.reason && (
                      <span id={reasonId} className="gh-context-menu__item-description">
                        {child.reason}
                      </span>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      ref={ref}
      className="gh-context-menu"
      style={{ top: position.top, left: position.left }}
      role="menu"
      aria-label={ariaLabel ?? `Actions for commit ${(sha ?? "").slice(0, 7)}`}
      tabIndex={-1}
    >
      {header && <div className="gh-context-menu__header">{header}</div>}
      {items.map((item, index) => {
        if (item.accordion) return renderAccordion(item, `${idBase}-${index}`);
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
            aria-label={item.description || item.content ? item.label : undefined}
            aria-describedby={descriptionId}
            className={`gh-context-menu__item${item.informational ? " gh-context-menu__item--info" : ""}${item.content ? " gh-context-menu__item--chip" : ""}${item.dropActive ? " gh-context-menu__item--drop-active" : ""}${item.onContextMenu ? " gh-context-menu__item--has-menu" : ""}`}
            data-ref-branch={item.dropTarget?.branch}
            data-ref-sha={item.dropTarget?.sha}
            // Informational rows are NOT `disabled`: Chromium suppresses pointer events/hit-testing
            // on a disabled button's contents, and the chip drag needs `elementFromPoint` to land on
            // the chip inside. `aria-disabled` + no tab stop + a no-op click keep them inert.
            disabled={item.informational ? undefined : item.disabled}
            aria-disabled={item.informational ? true : undefined}
            tabIndex={item.informational ? -1 : undefined}
            title={item.title}
            onContextMenu={item.onContextMenu}
            onClick={() => {
              if (item.informational) return;
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
              {item.content ? (
                item.content
              ) : (
                <>
                  {item.icon && (
                    <span className="gh-context-menu__item-icon" aria-hidden="true">
                      {item.icon}
                    </span>
                  )}
                  <span className="gh-context-menu__item-label">{item.label}</span>
                </>
              )}
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
