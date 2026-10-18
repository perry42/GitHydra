// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useDialogChrome } from "../../hooks/useDialogChrome";
import "../CommandPalette/CommandPalette.css";

export interface WorktreePickerItem {
  key: string;
  label: string;
  /** Muted second line (a path, "origin", ...). */
  secondary?: string;
  /** Non-null: listed but not choosable; the reason is visible text, so keyboard and screen-reader users reach it too. */
  disabledReason: string | null;
}

export interface WorktreePickerProps {
  title: string;
  placeholder: string;
  emptyText: string;
  items: readonly WorktreePickerItem[];
  loading?: boolean;
  loadError?: string | null;
  onPick: (key: string) => void;
  /** specs/external-programs.md FR-617: Right arrow on the highlighted row chooses another program (Open mode only). */
  onChoose?: (key: string) => void;
  /** A muted caption under the list, e.g. what Enter does. */
  footerHint?: string;
  onClose: () => void;
}

/**
 * specs/worktrees.md FR-607: the palette's "Worktree: Create from branch... / Open... / Remove..." list pickers. Same overlay
 * chrome as the Command Palette and MergeBranchPicker; unavailable rows stay in the arrow-key order with their reason shown.
 */
export function WorktreePicker({ title, placeholder, emptyText, items, loading = false, loadError = null, onPick, onChoose, footerHint, onClose }: WorktreePickerProps) {
  const titleId = useId();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  const { onOverlayMouseDown } = useDialogChrome({
    onEscape: onClose,
    escapeDeps: [onClose],
    refocusWithEscapeEffect: true,
    getFocusTarget: () => inputRef.current,
    onBackdropClick: onClose,
  });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? items.filter((i) => `${i.label} ${i.secondary ?? ""}`.toLowerCase().includes(q)) : items;
  }, [items, query]);
  useEffect(() => setHighlighted(0), [query]);
  const safeIndex = filtered.length === 0 ? -1 : Math.min(highlighted, filtered.length - 1);

  function choose(item: WorktreePickerItem | undefined) {
    if (!item) return;
    if (item.disabledReason) {
      setNotice(`${item.label}: ${item.disabledReason}`);
      return;
    }
    onPick(item.key);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlighted((i) => (filtered.length === 0 ? 0 : (Math.max(i, 0) + 1) % filtered.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((i) => (filtered.length === 0 ? 0 : (Math.max(i, 0) - 1 + filtered.length) % filtered.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(safeIndex >= 0 ? filtered[safeIndex] : undefined);
    } else if (e.key === "ArrowRight" && onChoose) {
      // Only at the end of the text: Right inside the query keeps moving the caret.
      const input = e.currentTarget;
      const item = safeIndex >= 0 ? filtered[safeIndex] : undefined;
      if (item && !item.disabledReason && input.selectionStart === input.value.length && input.selectionEnd === input.value.length) {
        e.preventDefault();
        onChoose(item.key);
      }
    }
  }

  const highlightedItem = safeIndex >= 0 ? filtered[safeIndex] : undefined;
  return (
    <div className="gh-command-palette__overlay" onMouseDown={onOverlayMouseDown}>
      <div className="gh-command-palette" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId} className="gh-visually-hidden">
          {title}
        </h2>
        <input
          ref={inputRef}
          type="text"
          className="gh-command-palette__input gh-mono"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={safeIndex >= 0 ? `${listId}-${safeIndex}` : undefined}
          aria-label={title}
          placeholder={placeholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {(notice || highlightedItem?.disabledReason) && (
          <p className="gh-command-palette__empty" role="status">
            {notice ?? highlightedItem?.disabledReason}
          </p>
        )}
        <ul id={listId} role="listbox" aria-label={title} className="gh-command-palette__list">
          {loadError ? (
            <li className="gh-command-palette__empty" role="presentation">
              {loadError}
            </li>
          ) : loading ? (
            <li className="gh-command-palette__empty" role="presentation">
              Loading…
            </li>
          ) : filtered.length === 0 ? (
            <li className="gh-command-palette__empty" role="presentation">
              {emptyText}
            </li>
          ) : (
            filtered.map((item, index) => (
              <li
                key={item.key}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === safeIndex}
                aria-disabled={item.disabledReason ? true : undefined}
                className={`gh-command-palette__item${index === safeIndex ? " gh-command-palette__item--highlighted" : ""}${item.disabledReason ? " gh-command-palette__item--disabled" : ""}`}
                onMouseEnter={() => setHighlighted(index)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(item)}
              >
                <span className="gh-command-palette__label gh-mono">{item.label}</span>
                {item.secondary && <span className="gh-command-palette__reason gh-mono">{item.secondary}</span>}
                {item.disabledReason && <span className="gh-command-palette__reason">{item.disabledReason}</span>}
              </li>
            ))
          )}
        </ul>
        {footerHint && <p className="gh-command-palette__footer">{footerHint}</p>}
      </div>
    </div>
  );
}
