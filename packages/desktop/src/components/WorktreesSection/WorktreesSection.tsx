// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from "react";
import type { WorktreeEntry, WorktreeList } from "@githydra/git-core";
import { describeWorktree, MISSING_CLEANUP_DESCRIPTION, type WorktreeRowModel } from "../../lib/worktrees";
import { ContextMenu, type ContextMenuItem } from "../ContextMenu/ContextMenu";
import { IconChevronDown, IconChevronRight, IconLock, IconMoreHorizontal, IconNewBranch, IconWarning, IconWorktree, IconWorktreeMain } from "../Icon/Icon";
import "./WorktreesSection.css";

export const WORKTREES_COLLAPSED_KEY = "githydra:layout:worktreesCollapsed";

export interface WorktreesSectionProps {
  status: "idle" | "loading" | "ready" | "error";
  list: WorktreeList | null;
  errorMessage: string | null;
  /** FR-601: a planted network path means worktree info (and every action) is unavailable. */
  unavailable: boolean;
  isOpenAsTab: (entry: WorktreeEntry) => boolean;
  onOpen: (entry: WorktreeEntry) => void;
  onRemove: (entry: WorktreeEntry, deleteBranch: boolean) => void;
  onCleanUp: (entry: WorktreeEntry) => void;
  onCreate: () => void;
  /** FR-615: removal puts focus back here once the dialog closes. */
  headingRef: RefObject<HTMLHeadingElement | null>;
  onMenuOpenChange?: (open: boolean) => void;
}

function readCollapsedPreference(): boolean | null {
  try {
    const raw = window.localStorage?.getItem(WORKTREES_COLLAPSED_KEY);
    return raw === "1" ? true : raw === "0" ? false : null;
  } catch {
    return null;
  }
}

/** FR-613: a plain, collapsible list of the repository's worktrees. Opening and removing are delegated; this owns only the view. */
export function WorktreesSection({
  status,
  list,
  errorMessage,
  unavailable,
  isOpenAsTab,
  onOpen,
  onRemove,
  onCleanUp,
  onCreate,
  headingRef,
  onMenuOpenChange,
}: WorktreesSectionProps) {
  const listId = useId();
  const entries = list?.entries.filter((e) => !e.isBare || list.entries.length === 1) ?? [];
  const count = entries.length;
  // With only the main worktree there is little to see; start collapsed until the user chooses otherwise.
  const [userCollapsed, setUserCollapsed] = useState<boolean | null>(() => readCollapsedPreference());
  const collapsed = userCollapsed ?? count <= 1;
  const [menu, setMenu] = useState<{ x: number; y: number; row: WorktreeRowModel; returnTo: HTMLElement | null } | null>(null);

  useEffect(() => {
    onMenuOpenChange?.(menu !== null);
  }, [menu, onMenuOpenChange]);

  const toggle = () => {
    const next = !collapsed;
    setUserCollapsed(next);
    try {
      window.localStorage?.setItem(WORKTREES_COLLAPSED_KEY, next ? "1" : "0");
    } catch {
      // Not persisted: the choice still holds for this session.
    }
  };

  // True once an item was chosen: the action (a dialog, a new tab) owns the focus then, not the row that opened the menu.
  const chosen = useRef(false);
  const closeMenu = () => {
    const back = menu?.returnTo ?? null;
    const skip = chosen.current;
    chosen.current = false;
    setMenu(null);
    // FR-635: Esc (and a click outside) returns focus to the control that opened the menu.
    if (!skip && back && back.isConnected) queueMicrotask(() => back.focus());
  };
  const pick = (fn: () => void) => () => {
    chosen.current = true;
    fn();
  };

  const menuItems = (row: WorktreeRowModel): ContextMenuItem[] => {
    const e = row.entry;
    const items: ContextMenuItem[] = [
      {
        label: "Open worktree",
        disabled: row.openReason !== null,
        description: row.openReason ?? undefined,
        title: row.openReason ?? undefined,
        onSelect: pick(() => onOpen(e)),
      },
      {
        label: "Remove this worktree",
        disabled: row.removeReason !== null,
        description: row.removeReason ?? undefined,
        title: row.removeReason ?? undefined,
        onSelect: pick(() => onRemove(e, false)),
      },
      {
        label: "Remove worktree and delete branch",
        disabled: row.removeReason !== null || !row.canDeleteBranch,
        description: row.removeReason ?? (row.canDeleteBranch ? undefined : "This worktree has no branch to delete."),
        title: row.removeReason ?? undefined,
        onSelect: pick(() => onRemove(e, true)),
      },
    ];
    if (row.canCleanUp) {
      items.push({ label: "Clean up", description: MISSING_CLEANUP_DESCRIPTION, onSelect: pick(() => onCleanUp(e)) });
    }
    return items;
  };

  const openMenuAt = (row: WorktreeRowModel, x: number, y: number, returnTo: HTMLElement | null) => setMenu({ x, y, row, returnTo });

  return (
    <section className="gh-worktrees" aria-labelledby={`${listId}-heading`}>
      <h3 id={`${listId}-heading`} ref={headingRef} tabIndex={-1} className="gh-branches-panel__section-heading gh-worktrees__heading">
        <button type="button" className="gh-worktrees__toggle" aria-expanded={!collapsed} aria-controls={listId} onClick={toggle}>
          <span className="gh-worktrees__chevron" aria-hidden="true">
            {collapsed ? <IconChevronRight size={12} /> : <IconChevronDown size={12} />}
          </span>
          Worktrees{status === "ready" ? ` (${count})` : ""}
        </button>
        {!unavailable && status === "ready" && (
          <button type="button" className="gh-worktrees__new" onClick={onCreate} title="Create a new branch in a new worktree" aria-label="Create worktree">
            <IconNewBranch size={14} />
          </button>
        )}
      </h3>
      <div id={listId} hidden={collapsed}>
        {!collapsed && status === "loading" && (
          <p className="gh-worktrees__note" role="status" aria-busy="true">
            Loading worktrees…
          </p>
        )}
        {!collapsed && status === "error" && (
          <p className="gh-worktrees__note gh-worktrees__note--error" role="alert">
            Could not load worktrees: {errorMessage}
          </p>
        )}
        {!collapsed && unavailable && (
          <p className="gh-worktrees__note" role="status">
            Worktree actions are unavailable: this repository records a worktree on a network path, which GitHydra will not read.
          </p>
        )}
        {!collapsed && !unavailable && status === "ready" && list && list.untrusted && (
          <p className="gh-worktrees__note" role="status">
            Git's worktree list and this repository's records disagree, so Open and Remove are turned off for linked worktrees.
          </p>
        )}
        {!collapsed && !unavailable && status === "ready" && list && (
          <ul className="gh-worktrees__list" aria-label="Worktrees">
            {entries.map((entry) => (
              <WorktreeRow
                key={entry.id ?? "main"}
                row={describeWorktree(entry, list.untrusted)}
                showMainLabel={entries.length > 1}
                openAsTab={isOpenAsTab(entry)}
                onOpen={() => onOpen(entry)}
                openMenuAt={openMenuAt}
              />
            ))}
          </ul>
        )}
      </div>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} ariaLabel={`Actions for worktree ${menu.row.name}`} items={menuItems(menu.row)} onClose={closeMenu} />
      )}
    </section>
  );
}

function WorktreeRow({
  row,
  showMainLabel,
  openAsTab,
  onOpen,
  openMenuAt,
}: {
  row: WorktreeRowModel;
  showMainLabel: boolean;
  openAsTab: boolean;
  onOpen: () => void;
  openMenuAt: (row: WorktreeRowModel, x: number, y: number, returnTo: HTMLElement | null) => void;
}) {
  const { entry } = row;
  const rowRef = useRef<HTMLLIElement | null>(null);
  const flags: string[] = [];
  if (entry.locked) flags.push("locked");
  if (entry.prunable) flags.push("missing");
  const label = `Worktree ${row.name}, ${row.isMain ? "main" : "linked"}${flags.length ? `, ${flags.join(", ")}` : ""}${openAsTab ? ", open as a tab" : ""}, at ${row.path}`;

  const openFromKeyboard = () => {
    const rect = rowRef.current?.getBoundingClientRect();
    openMenuAt(row, (rect?.left ?? 0) + 24, (rect?.top ?? 0) + 24, rowRef.current);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLLIElement>) => {
    // Keys typed in the "..." button are its own business (Enter/Space click it).
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter") {
      e.preventDefault();
      if (row.openReason === null) onOpen();
    } else if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") {
      e.preventDefault();
      openFromKeyboard();
    }
  };

  const onContextMenu = (e: MouseEvent<HTMLLIElement>) => {
    e.preventDefault();
    // A keyboard-invoked contextmenu event carries no pointer position.
    if (e.clientX === 0 && e.clientY === 0) openFromKeyboard();
    else openMenuAt(row, e.clientX, e.clientY, rowRef.current);
  };

  return (
    <li
      ref={rowRef}
      className={`gh-worktrees__row${row.openReason ? " gh-worktrees__row--muted" : ""}`}
      tabIndex={0}
      aria-label={label}
      onKeyDown={onKeyDown}
      onContextMenu={onContextMenu}
      onDoubleClick={() => {
        if (row.openReason === null) onOpen();
      }}
    >
      <div className="gh-worktrees__line">
        <span className="gh-worktrees__glyph" aria-hidden="true">
          {row.isMain ? <IconWorktreeMain size={16} /> : <IconWorktree size={16} />}
        </span>
        <span className="gh-mono gh-worktrees__name">{row.name}</span>
        {row.isMain && showMainLabel && <span className="gh-worktrees__flag">Main</span>}
        {openAsTab && <span className="gh-worktrees__flag gh-worktrees__flag--tab">tab</span>}
        {entry.locked && (
          <span className="gh-worktrees__flag gh-worktrees__flag--state">
            <IconLock size={12} />
            Locked
          </span>
        )}
        {entry.prunable && (
          <span className="gh-worktrees__flag gh-worktrees__flag--state">
            <IconWarning size={12} />
            Missing
          </span>
        )}
        <button
          type="button"
          className="gh-worktrees__more"
          aria-label={`Actions for worktree ${row.name}`}
          aria-haspopup="menu"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            openMenuAt(row, r.left, r.bottom, e.currentTarget);
          }}
        >
          <IconMoreHorizontal size={14} />
        </button>
      </div>
      <span className="gh-worktrees__path gh-mono" title={row.path}>
        {row.path}
      </span>
    </li>
  );
}
