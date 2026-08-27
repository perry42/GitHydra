import { useEffect, useRef } from "react";
import "./ContextMenu.css";

export interface ContextMenuItem {
  label: string;
  /** Disabled for v1 (FR-16 only requires the interaction surface to exist — the actual git
   * semantics belong to the branch-management/cherry-pick/merge-rebase specs). */
  disabled?: boolean;
  onSelect?: () => void;
}

export interface ContextMenuProps {
  x: number;
  y: number;
  sha: string;
  items: ContextMenuItem[];
  onClose: () => void;
}

/** FR-16: right-click extension point on a commit node. Every item is a stub for now — checkout,
 * create-branch-here, cherry-pick, revert, and reset all belong to their own specs' PRDs. */
export function ContextMenu({ x, y, sha, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onPointerDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    ref.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="gh-context-menu"
      style={{ top: y, left: x }}
      role="menu"
      aria-label={`Actions for commit ${sha.slice(0, 7)}`}
      tabIndex={-1}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className="gh-context-menu__item"
          disabled={item.disabled}
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
