// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from "react";
import type { WorktreeEntry, WorktreeList } from "@githydra/git-core";
import { describeWorktree, MISSING_FORGET_MENU_DESCRIPTION, truncatePathMiddle, type WorktreeRowModel } from "../../lib/worktrees";
import { ContextMenu, type ContextMenuItem } from "../ContextMenu/ContextMenu";
import {
  IconError,
  IconLock,
  IconMoreHorizontal,
  IconWorktreeAdd,
  IconTab,
  IconWorktree,
  IconWorktreeMain,
} from "../Icon/Icon";
import { SectionHeader } from "../SectionHeader/SectionHeader";
import "./WorktreesSection.css";

export const WORKTREES_COLLAPSED_KEY = "githydra:layout:worktreesCollapsed";
/** The visible path keeps its leaf and is cut in the middle at this many characters (the full path is the tooltip and Copy path). */
export const WORKTREE_PATH_MAX_CHARS = 38;
export const WORKTREES_HINT = "Other folders with a branch checked out. Right-click a branch to create one.";

export interface WorktreesSectionProps {
  status: "idle" | "loading" | "ready" | "error";
  list: WorktreeList | null;
  errorMessage: string | null;
  /** FR-601: a planted network path means worktree info (and every action) is unavailable. */
  unavailable: boolean;
  isOpenAsTab: (entry: WorktreeEntry) => boolean;
  onOpen: (entry: WorktreeEntry) => void;
  /** specs/external-programs.md FR-617: the "Open worktree" accordion; omitted (standalone tests): the plain item. */
  openItem?: (entry: WorktreeEntry, opts: { contextLine?: string; wrap: (fn: () => void) => () => void }) => ContextMenuItem;
  onRemove: (entry: WorktreeEntry, deleteBranch: boolean) => void;
  onCleanUp: (entry: WorktreeEntry) => void;
  onCreate: () => void;
  /** FR-615: removal puts focus back here once the dialog closes. */
  headingRef: RefObject<HTMLHeadingElement | null>;
  onMenuOpenChange?: (open: boolean) => void;
  /** Injectable for tests; defaults to the Clipboard API. */
  writeClipboard?: (text: string) => Promise<void>;
}

function readCollapsedPreference(): boolean | null {
  try {
    const raw = window.localStorage?.getItem(WORKTREES_COLLAPSED_KEY);
    return raw === "1" ? true : raw === "0" ? false : null;
  } catch {
    return null;
  }
}

const rowKey = (e: WorktreeEntry): string => e.id ?? "main";

/** FR-613: a plain, collapsible list of the repository's worktrees. Opening and removing are delegated; this owns only the view. */
export function WorktreesSection({
  status,
  list,
  errorMessage,
  unavailable,
  isOpenAsTab,
  onOpen,
  openItem,
  onRemove,
  onCleanUp,
  onCreate,
  headingRef,
  onMenuOpenChange,
  writeClipboard = (t) => navigator.clipboard.writeText(t),
}: WorktreesSectionProps) {
  const listId = useId();
  const entries = list?.entries.filter((e) => !e.isBare || list.entries.length === 1) ?? [];
  const count = entries.length;
  // With only the main worktree there is little to see; start collapsed until the user chooses otherwise.
  const [userCollapsed, setUserCollapsed] = useState<boolean | null>(() => readCollapsedPreference());
  const collapsed = userCollapsed ?? count <= 1;
  const [menu, setMenu] = useState<{ x: number; y: number; row: WorktreeRowModel; returnTo: HTMLElement | null } | null>(null);
  // Roving tabindex: the list is ONE Tab stop; arrows move between rows.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const currentKey = activeKey && entries.some((e) => rowKey(e) === activeKey) ? activeKey : entries[0] ? rowKey(entries[0]) : null;

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
    // One reason is spelled out once (on the first item it disables); later items keep it as a tooltip only.
    const spelled = new Set<string>();
    const reasonText = (r: string | null): string | undefined => {
      if (!r || spelled.has(r)) return undefined;
      spelled.add(r);
      return r;
    };
    const items: ContextMenuItem[] = [
      openItem && row.openReason === null
        ? openItem(e, { wrap: pick })
        : {
            label: "Open worktree",
            disabled: row.openReason !== null,
            description: reasonText(row.openReason) ?? (row.openReason === null ? "Opens it in a new tab." : undefined),
            title: row.openReason ?? undefined,
            onSelect: pick(() => onOpen(e)),
          },
      {
        label: "Copy path",
        description: "Copies the full folder path.",
        onSelect: pick(() => void writeClipboard(e.path)),
      },
      {
        label: "Remove this worktree",
        disabled: row.removeReason !== null,
        description: reasonText(row.removeReason),
        title: row.removeReason ?? undefined,
        onSelect: pick(() => onRemove(e, false)),
      },
      {
        label: "Remove worktree and delete branch",
        disabled: row.removeReason !== null || !row.canDeleteBranch,
        description: reasonText(row.removeReason) ?? (row.removeReason === null && !row.canDeleteBranch ? "This worktree has no branch to delete." : undefined),
        title: row.removeReason ?? undefined,
        onSelect: pick(() => onRemove(e, true)),
      },
    ];
    if (row.canCleanUp) {
      items.push({ label: "Forget missing worktree", description: MISSING_FORGET_MENU_DESCRIPTION, onSelect: pick(() => onCleanUp(e)) });
    }
    return items;
  };

  const openMenuAt = (row: WorktreeRowModel, x: number, y: number, returnTo: HTMLElement | null) => setMenu({ x, y, row, returnTo });

  const move = (from: string, to: "prev" | "next" | "first" | "last") => {
    const keys = entries.map(rowKey);
    const i = keys.indexOf(from);
    const target = to === "first" ? 0 : to === "last" ? keys.length - 1 : Math.max(0, Math.min(keys.length - 1, i + (to === "next" ? 1 : -1)));
    const k = keys[target];
    if (k === undefined) return;
    setActiveKey(k);
    rowRefs.current.get(k)?.focus();
  };

  const showHint = collapsed || count <= 1;

  return (
    <section className="gh-worktrees" aria-labelledby={`${listId}-heading`}>
      <SectionHeader
        headingId={`${listId}-heading`}
        headingRef={headingRef}
        icon={<IconWorktree size={14} />}
        label="Worktrees"
        count={status === "ready" ? count : null}
        collapsed={collapsed}
        onToggle={toggle}
        controlsId={listId}
        action={
          !unavailable && status === "ready" ? (
            <button type="button" className="gh-worktrees__new" onClick={onCreate} title="Create a worktree: another folder with a branch checked out" aria-label="New worktree">
              <IconWorktreeAdd size={14} />
            </button>
          ) : undefined
        }
      />
      {showHint && !unavailable && status === "ready" && <p className="gh-worktrees__hint">{WORKTREES_HINT}</p>}
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
            {list?.untrustedReason === "special-file"
              ? "This worktree list could not be read safely: a worktree record contains a special file."
              : "Worktree actions are unavailable: this repository records a worktree on a network path, which GitHydra will not read."}
          </p>
        )}
        {!collapsed && !unavailable && status === "ready" && list && list.untrusted && (
          <p className="gh-worktrees__note" role="status">
            Git's worktree list and this repository's records disagree, so Open and Remove are turned off for linked worktrees.
          </p>
        )}
        {!collapsed && !unavailable && status === "ready" && list && (
          <ul className="gh-worktrees__list" aria-label="Worktrees">
            {entries.map((entry) => {
              const key = rowKey(entry);
              return (
                <WorktreeRow
                  key={key}
                  rowRef={(el) => {
                    if (el) rowRefs.current.set(key, el);
                    else rowRefs.current.delete(key);
                  }}
                  row={describeWorktree(entry, list.untrusted)}
                  showMainLabel={entries.length > 1}
                  openAsTab={isOpenAsTab(entry)}
                  tabStop={key === currentKey}
                  menuOpen={menu?.row.entry === entry}
                  onFocusRow={() => setActiveKey(key)}
                  onNavigate={(to) => move(key, to)}
                  onOpen={() => onOpen(entry)}
                  openMenuAt={openMenuAt}
                />
              );
            })}
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
  rowRef,
  showMainLabel,
  openAsTab,
  tabStop,
  menuOpen,
  onFocusRow,
  onNavigate,
  onOpen,
  openMenuAt,
}: {
  row: WorktreeRowModel;
  rowRef: (el: HTMLLIElement | null) => void;
  showMainLabel: boolean;
  openAsTab: boolean;
  tabStop: boolean;
  menuOpen: boolean;
  onFocusRow: () => void;
  onNavigate: (to: "prev" | "next" | "first" | "last") => void;
  onOpen: () => void;
  openMenuAt: (row: WorktreeRowModel, x: number, y: number, returnTo: HTMLElement | null) => void;
}) {
  const { entry } = row;
  const el = useRef<HTMLLIElement | null>(null);
  const flags: string[] = [];
  if (entry.locked) flags.push("locked");
  if (entry.prunable) flags.push("missing");
  const label = `Worktree ${row.name}, ${row.isMain ? "main" : "linked"}${flags.length ? `, ${flags.join(", ")}` : ""}${openAsTab ? ", open as a tab" : ""}, at ${row.path}`;

  const openFromKeyboard = () => {
    const rect = el.current?.getBoundingClientRect();
    openMenuAt(row, (rect?.left ?? 0) + 24, (rect?.top ?? 0) + 24, el.current);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLLIElement>) => {
    // Keys typed in the "..." button are its own business (Enter/Space click it).
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (row.openReason === null) onOpen();
    } else if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") {
      e.preventDefault();
      openFromKeyboard();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
      e.preventDefault();
      onNavigate(e.key === "ArrowDown" ? "next" : e.key === "ArrowUp" ? "prev" : e.key === "Home" ? "first" : "last");
    }
  };

  const onContextMenu = (e: MouseEvent<HTMLLIElement>) => {
    e.preventDefault();
    // A keyboard-invoked contextmenu event carries no pointer position.
    if (e.clientX === 0 && e.clientY === 0) openFromKeyboard();
    else openMenuAt(row, e.clientX, e.clientY, el.current);
  };

  return (
    <li
      ref={(node) => {
        el.current = node;
        rowRef(node);
      }}
      className={`gh-worktrees__row${row.openReason ? " gh-worktrees__row--muted" : ""}`}
      tabIndex={tabStop ? 0 : -1}
      aria-label={label}
      onFocus={(e) => {
        if (e.target === e.currentTarget) onFocusRow();
      }}
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
        {row.isMain && showMainLabel && <span className="gh-worktrees__flag gh-worktrees__flag--quiet">Main</span>}
        {openAsTab && (
          <span className="gh-worktrees__flag gh-worktrees__flag--quiet">
            <IconTab size={12} />
            tab
          </span>
        )}
        {entry.locked && (
          <span className="gh-worktrees__flag gh-worktrees__flag--locked">
            <IconLock size={12} />
            Locked
          </span>
        )}
        {entry.prunable && (
          <span className="gh-worktrees__flag gh-worktrees__flag--missing">
            <IconError size={12} />
            Missing
          </span>
        )}
        <button
          type="button"
          className="gh-worktrees__more"
          aria-label={`Actions for worktree ${row.name}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            openMenuAt(row, r.left, r.bottom, e.currentTarget);
          }}
        >
          <IconMoreHorizontal size={14} />
        </button>
      </div>
      {/* One line, cut in the middle with the leaf kept; the whole path is the tooltip, the accessible name and "Copy path". */}
      <span className="gh-worktrees__path gh-mono" title={row.path}>
        {truncatePathMiddle(row.path, WORKTREE_PATH_MAX_CHARS)}
      </span>
    </li>
  );
}
