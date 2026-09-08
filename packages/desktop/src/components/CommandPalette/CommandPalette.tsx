// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { getCommands, type Command, type CommandContext } from "../../lib/commands";
import { keyComboLabel } from "../../lib/platform";
import "./CommandPalette.css";

export interface CommandPaletteProps {
  ctx: CommandContext;
  onClose: () => void;
}

/**
 * specs/keyboard-shortcuts-command-palette.md FR-222/FR-225/FR-228: `Ctrl/Cmd+K`'s overlay — a
 * filterable list of the commands from `commands.ts`'s registry that are available RIGHT NOW
 * (FR-225: unavailable commands are hidden entirely, never shown-and-disabled). Follows the exact
 * centered-overlay / focused-input-on-open / Escape-to-close / click-outside-to-close convention
 * `NewBranchDialog`/`CreateStashDialog`/`ConfirmDialog` already establish, rather than inventing a
 * new one.
 *
 * Only ever rendered by `App.tsx` while `useGlobalKeybindings`'s own `paletteOpen` is true — that
 * same flag is what suspends the global keybinding layer while this is open (FR-229), so there's
 * nothing here that also needs to guard against a duplicate Ctrl/Cmd+K reopening a second overlay.
 */
export function CommandPalette({ ctx, onClose }: CommandPaletteProps) {
  const titleId = useId();
  const listId = useId();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const [query, setQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  // FR-225: computed fresh from the live `ctx` every render — hidden, not shown-disabled.
  const available = useMemo(() => getCommands(ctx).filter((c) => c.isAvailable(ctx)), [ctx]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return available;
    return available.filter((c) => c.label.toLowerCase().includes(q));
  }, [available, query]);

  // Reset the highlight back to the top of the list whenever the typed filter itself changes —
  // navigating a freshly-narrowed list from wherever the previous, differently-filtered list left
  // off would be disorienting. A stale index from `ctx` alone changing (not `query`) is instead
  // just clamped at render time below, so an in-place list update (e.g. a tab closing while the
  // palette happens to still be open) doesn't unnecessarily reset the user's place in the list.
  useEffect(() => {
    setHighlightedIndex(0);
  }, [query]);

  const safeIndex = filtered.length === 0 ? -1 : Math.min(highlightedIndex, filtered.length - 1);

  useEffect(() => {
    function onDocKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onDocKeyDown);
    inputRef.current?.focus();
    return () => document.removeEventListener("keydown", onDocKeyDown);
  }, [onClose]);

  function runCommand(command: Command) {
    command.run(ctx);
    onClose();
  }

  function handleInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightedIndex((i) => (filtered.length === 0 ? 0 : (Math.max(i, 0) + 1) % filtered.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightedIndex((i) => (filtered.length === 0 ? 0 : (Math.max(i, 0) - 1 + filtered.length) % filtered.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const command = safeIndex >= 0 ? filtered[safeIndex] : undefined;
      if (command) runCommand(command);
    }
    // Escape is handled by the document-level listener above (FR-228's shared convention) — every
    // other key (including "k"/"r"/Tab — FR-229) is left to fall through as ordinary filter-text
    // entry, since the global keybinding layer is already suspended while this is open.
  }

  return (
    <div className="gh-command-palette__overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={containerRef} className="gh-command-palette" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId} className="gh-visually-hidden">
          Command Palette
        </h2>
        <input
          ref={inputRef}
          type="text"
          className="gh-command-palette__input gh-mono"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={safeIndex >= 0 ? optionId(listId, filtered[safeIndex]!.id) : undefined}
          aria-label="Command palette — type to filter commands"
          placeholder="Type a command…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleInputKeyDown}
        />
        <ul id={listId} role="listbox" aria-label="Commands" className="gh-command-palette__list">
          {filtered.length === 0 ? (
            // AC2: an explicit "no match" state, never a silently blank list.
            <li className="gh-command-palette__empty" role="presentation">
              No matching commands
            </li>
          ) : (
            filtered.map((command, index) => (
              <li
                key={command.id}
                id={optionId(listId, command.id)}
                role="option"
                aria-selected={index === safeIndex}
                className={`gh-command-palette__item${index === safeIndex ? " gh-command-palette__item--highlighted" : ""}`}
                onMouseEnter={() => setHighlightedIndex(index)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => runCommand(command)}
              >
                <span className="gh-command-palette__label">{command.label}</span>
                {command.keybindings && command.keybindings.length > 0 && (
                  <span className="gh-command-palette__shortcut gh-mono">
                    {command.keybindings.map(keyComboLabel).join(" / ")}
                  </span>
                )}
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}

function optionId(listId: string, commandId: string): string {
  return `${listId}-${commandId}`;
}
