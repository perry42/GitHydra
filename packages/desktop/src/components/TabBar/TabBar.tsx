// SPDX-License-Identifier: GPL-3.0-or-later
import { useRef, type KeyboardEvent, type ReactNode } from "react";
import type { RepoTab } from "../../hooks/useRepoTabs";
import { repoTabLabel } from "../../lib/repoLabel";
import type { TabLabelModel } from "../../lib/worktrees";
import { IconWarning, IconWorktree, IconWorktreeMain } from "../Icon/Icon";
import "./TabBar.css";

export interface TabBarProps {
  tabs: RepoTab[];
  activeTabId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  /**
   * specs/repo-list.md Must-have 2/3 (revised IA): a plain button — it no longer opens any
   * dialog or menu itself. Clicking it deactivates the current tab and shows the always-available
   * "No repository open" landing screen (`EmptyState`), which is the single surface every repo
   * open (native-dialog browse or a recent-repositories click) now goes through.
   */
  onNewTab: () => void;
  /**
   * specs/multi-repo-tabs.md fast-tab-switching bugfix: true while a tab switch/open is in
   * flight (`useRepoTabs`'s `switching`). Disables every *other* tab's activate control, every
   * tab's close control, and "+ New tab" so a fast click or held-down arrow key can't queue up a
   * second overlapping switch — gives an honest "still switching" cue instead of silently
   * dropping the extra input. Defaults to `false` so existing callers/tests are unaffected.
   */
  switching?: boolean;
  /** specs/mid-merge-landing.md FR-582: tab id -> unresolved conflict count; only the live (active) tab's count is known. */
  conflictCounts?: Record<string, number>;
  /**
   * specs/worktrees.md FR-612: worktree-aware labels by tab id (branch first, glyph, muted repo suffix, full path in the title and
   * accessible name). A tab without an entry keeps the folder-name label.
   */
  tabLabels?: Record<string, TabLabelModel>;
  /** specs/external-programs.md FR-624: the "Open folder in editor" split button, right-aligned and outside the scrolling tab strip. */
  trailing?: ReactNode;
}

/**
 * specs/multi-repo-tabs.md Must-have 1: always visible (even with zero or one tab open) — the
 * discoverable affordance for the feature, not something that appears only once a second repo is
 * opened. Sits above `Toolbar` (which is per-active-repo chrome); this bar is the outer,
 * which-repo-am-I-looking-at level, the way a browser's tab strip sits above its address bar.
 */
export function TabBar({
  tabs,
  activeTabId,
  onActivate,
  onClose,
  onNewTab,
  switching = false,
  conflictCounts,
  tabLabels,
  trailing,
}: TabBarProps) {
  const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  function focusTabAt(index: number) {
    const id = tabs[index]?.id;
    if (!id) return;
    tabRefs.current.get(id)?.focus();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    // A switch is already in flight — ignore any further tab-navigation/close key while it
    // settles (see `switching`'s doc comment).
    if (switching) return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      const next = (index + 1) % tabs.length;
      onActivate(tabs[next]!.id);
      focusTabAt(next);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      const prev = (index - 1 + tabs.length) % tabs.length;
      onActivate(tabs[prev]!.id);
      focusTabAt(prev);
    } else if (e.key === "Home") {
      e.preventDefault();
      onActivate(tabs[0]!.id);
      focusTabAt(0);
    } else if (e.key === "End") {
      e.preventDefault();
      const last = tabs.length - 1;
      onActivate(tabs[last]!.id);
      focusTabAt(last);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      onClose(tabs[index]!.id);
    }
  }

  return (
    <div className="gh-tab-bar">
      <div className="gh-tab-bar__scroll">
        <div className="gh-tab-bar__tablist" role="tablist" aria-label="Open repositories">
          {tabs.map((tab, index) => {
            const isActive = tab.id === activeTabId;
            const worktreeLabel = tabLabels?.[tab.id];
            const label = worktreeLabel?.label ?? repoTabLabel(tab.repoPath);
            const conflicts = conflictCounts?.[tab.id] ?? 0;
            const conflictText = `${conflicts} conflict${conflicts === 1 ? "" : "s"} to resolve`;
            return (
              <div
                key={tab.id}
                role="presentation"
                className={`gh-tab-bar__tab${isActive ? " gh-tab-bar__tab--active" : ""}${worktreeLabel ? " gh-tab-bar__tab--worktree" : ""}`}
              >
                <button
                  ref={(el) => {
                    if (el) tabRefs.current.set(tab.id, el);
                    else tabRefs.current.delete(tab.id);
                  }}
                  type="button"
                  role="tab"
                  id={`gh-tab-${tab.id}`}
                  aria-selected={isActive}
                  aria-controls="gh-app-main"
                  tabIndex={isActive ? 0 : -1}
                  // Only *other* tabs go inert during a switch — the active one is already the
                  // current selection, so activating it is already a no-op either way.
                  disabled={switching && !isActive}
                  className="gh-tab-bar__tab-button gh-mono"
                  title={conflicts > 0 ? `${worktreeLabel?.title ?? tab.repoPath} — ${conflictText}` : (worktreeLabel?.title ?? tab.repoPath)}
                  aria-label={
                    conflicts > 0
                      ? `${worktreeLabel?.ariaLabel ?? label}, ${conflictText}`
                      : worktreeLabel?.ariaLabel
                  }
                  onClick={() => onActivate(tab.id)}
                  onKeyDown={(e) => handleKeyDown(e, index)}
                >
                  {worktreeLabel?.glyph && (
                    <span className="gh-tab-bar__glyph" aria-hidden="true">
                      {worktreeLabel.glyph === "main" ? <IconWorktreeMain size={14} /> : <IconWorktree size={14} />}
                    </span>
                  )}
                  <span className={worktreeLabel ? "gh-tab-bar__label gh-tab-bar__label--branch" : "gh-tab-bar__label"}>{label}</span>
                  {worktreeLabel?.suffix && <span className="gh-tab-bar__suffix">{worktreeLabel.suffix}</span>}
                </button>
                {conflicts > 0 && (
                  // Outside the label button so its ellipsis can never clip the count.
                  <span className="gh-tab-bar__badge gh-tabular" title={conflictText} aria-hidden="true">
                    <IconWarning size={10} strokeWidth={2.4} />
                    {conflicts}
                  </span>
                )}
                <button
                  type="button"
                  className="gh-tab-bar__tab-close"
                  aria-label={`Close ${label} tab`}
                  title={`Close ${label} tab`}
                  disabled={switching}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(tab.id);
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
        <button
          type="button"
          className="gh-tab-bar__new"
          aria-label="Open a repository in a new tab"
          title="New tab"
          disabled={switching}
          onClick={onNewTab}
        >
          +
        </button>
      </div>
      {trailing && <div className="gh-tab-bar__trailing">{trailing}</div>}
    </div>
  );
}
