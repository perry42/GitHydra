import { useEffect, useRef, useState, type ReactNode } from "react";
import type { RecentOpenResult } from "../../hooks/useRepoTabs";
import { useRecentOpenRow } from "../../hooks/useRecentOpenRow";
import { IconChevronDown } from "../Icon/Icon";
import { RecentRepoRow } from "./RecentRepoRow";
import "./OpenRepoMenu.css";

export interface OpenRepoMenuProps {
  /** The trigger button's own visual content (e.g. "+" for `TabBar`, or the icon+label for
   * `Toolbar`'s "Open repository…") — unchanged from each caller's existing treatment; this
   * wrapper only adds a second, adjacent disclosure control, never restyles or re-wires the
   * trigger itself. */
  triggerContent: ReactNode;
  triggerClassName: string;
  /** Optional class on the outer positioning wrapper (`position: relative`) — for a caller that
   * needs to place the trigger within its own flex layout (e.g. `TabBar`'s `align-self: flex-end`
   * on its "+" trigger) without that layout concern leaking into this component's own styling. */
  containerClassName?: string;
  /** Unchanged from each caller's existing aria-label. */
  ariaLabel: string;
  title?: string;
  disabled?: boolean;
  recentRepos: string[];
  /**
   * specs/repo-list.md Must-have 2 ("alongside the existing native-dialog 'Browse…' affordance"):
   * the ORIGINAL trigger button keeps its exact existing behavior unconditionally — a single click
   * always opens the native dialog directly, whether or not any recent repos exist. This is a
   * deliberate split-button design (the trigger + a separate small disclosure caret, rendered only
   * once there's a recent list to show), not a menu that intercepts the trigger's own click: an
   * earlier version of this component made the primary click open a popover instead of the dialog
   * once recents existed, which regressed every existing test/user flow that clicks "+ New tab" or
   * "Open repository…" expecting the dialog every time, recents or not.
   */
  onBrowse: () => void;
  onOpenRecent: (path: string) => Promise<RecentOpenResult>;
  onRemoveRecent: (path: string) => void;
  /** Accessible name for both the disclosure caret and the popover it opens — distinct per caller
   * (e.g. "Recent repositories — new tab" vs. "Recent repositories — open repository") so a
   * screen-reader user can tell the two controls apart. */
  menuLabel: string;
}

/**
 * specs/repo-list.md Must-have 2/3/4/AC2/AC4/AC6: a split button — the unchanged existing trigger
 * (`TabBar`'s "+ New tab", `Toolbar`'s "Open repository…", always opening the native dialog) plus
 * a small adjacent disclosure caret, rendered only once there's at least one recent repo, that
 * opens a popover of "Recent repositories" entries alongside its own "Browse…" item.
 */
export function OpenRepoMenu({
  triggerContent,
  triggerClassName,
  containerClassName,
  ariaLabel,
  title,
  disabled = false,
  recentRepos,
  onBrowse,
  onOpenRecent,
  onRemoveRecent,
  menuLabel,
}: OpenRepoMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const caretRef = useRef<HTMLButtonElement | null>(null);
  const hasRecent = recentRepos.length > 0;

  const close = () => setOpen(false);
  const { notFoundPath, busyPath, openRecent, clearNotFound } = useRecentOpenRow(onOpenRecent, close);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      close();
      caretRef.current?.focus();
    };
    const onPointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) close();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open]);

  function handleRemove(path: string) {
    onRemoveRecent(path);
    clearNotFound(path);
  }

  function handleBrowse() {
    close();
    onBrowse();
  }

  return (
    <div
      className={containerClassName ? `gh-open-repo-menu ${containerClassName}` : "gh-open-repo-menu"}
      ref={containerRef}
    >
      <div className="gh-open-repo-menu__split">
        <button
          type="button"
          className={triggerClassName}
          aria-label={ariaLabel}
          title={title}
          disabled={disabled}
          onClick={onBrowse}
        >
          {triggerContent}
        </button>
        {hasRecent && (
          <button
            ref={caretRef}
            type="button"
            className="gh-open-repo-menu__caret"
            aria-label={menuLabel}
            title="Recent repositories"
            disabled={disabled}
            aria-haspopup="true"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            <IconChevronDown size={12} />
          </button>
        )}
      </div>
      {open && hasRecent && (
        <div className="gh-open-repo-menu__popover" role="group" aria-label={menuLabel}>
          <p className="gh-open-repo-menu__heading">Recent repositories</p>
          <ul className="gh-open-repo-menu__list">
            {recentRepos.map((path) => (
              <li key={path}>
                <RecentRepoRow
                  path={path}
                  busy={busyPath === path}
                  notFound={notFoundPath === path}
                  onOpen={openRecent}
                  onRemove={handleRemove}
                />
              </li>
            ))}
          </ul>
          <div className="gh-open-repo-menu__divider" aria-hidden="true" />
          <button type="button" className="gh-open-repo-menu__browse" onClick={handleBrowse}>
            Browse…
          </button>
        </div>
      )}
    </div>
  );
}
