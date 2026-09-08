// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useId, useMemo, useRef } from "react";
import { getCommands, STATIC_SHORTCUT_ROWS, type Command, type CommandCategory, type CommandContext } from "../../lib/commands";
import { keyComboLabel, type KeyCombo } from "../../lib/platform";
import "./KeyboardShortcutsScreen.css";

export interface KeyboardShortcutsScreenProps {
  ctx: CommandContext;
  onClose: () => void;
}

interface ScreenRow {
  id: string;
  label: string;
  keybindings: KeyCombo[];
}

const CATEGORY_SECTIONS: { key: CommandCategory; heading: string }[] = [
  { key: "tabs", heading: "Tabs" },
  { key: "view", heading: "View" },
  { key: "git", heading: "Git actions" },
  { key: "general", heading: "General" },
];

/**
 * specs/keyboard-shortcuts-reference.md FR-234/FR-235/FR-236: builds one category's display rows —
 * the registry's own commands for that category (FR-233: every one of them, `isAvailable` never
 * consulted), in registration order, plus this feature's two screen-only deviations from a plain
 * "filter the registry by category" pass:
 *  - "tabs": the (possibly many, possibly zero) `switch-to-tab:<id>` entries are excluded here and
 *    replaced by exactly one generic "Switch to tab" row (FR-235) — collapsed unconditionally
 *    rather than derived from however many happen to exist right now, since a reference screen
 *    documents a capability, not a live readout of this session's open tabs.
 *  - "general"/"tabs": `STATIC_SHORTCUT_ROWS` (FR-236) are spliced in at the exact position
 *    `commands.ts`'s own registration-order comments document: "Open Command Palette" BEFORE the
 *    registry's "general" commands, "Next / previous tab" AFTER the registry's "tabs" commands.
 */
function rowsForCategory(category: CommandCategory, commands: Command[]): ScreenRow[] {
  const registryRows: ScreenRow[] = commands
    .filter((c) => c.category === category && !c.id.startsWith("switch-to-tab:"))
    .map((c) => ({ id: c.id, label: c.label, keybindings: c.keybindings ?? [] }));

  const staticRows: ScreenRow[] = STATIC_SHORTCUT_ROWS.filter((r) => r.category === category).map((r) => ({
    id: `static:${r.label}`,
    label: r.label,
    keybindings: r.keybindings,
  }));

  if (category === "tabs") {
    return [...registryRows, { id: "switch-to-tab", label: "Switch to tab", keybindings: [] }, ...staticRows];
  }
  if (category === "general") {
    return [...staticRows, ...registryRows];
  }
  return registryRows;
}

/**
 * specs/keyboard-shortcuts-reference.md FR-231/232/233/234: the `Ctrl/Cmd+/` reference screen — a
 * static, read-only render of the full command registry (every command, `isAvailable` ignored —
 * FR-233) grouped under four fixed headings (FR-234), plus the two direct keybindings that have no
 * registry entry at all (FR-236). Follows the exact centered-overlay / `role="dialog"` /
 * `aria-modal` / Escape-to-close / click-outside-to-close convention `CommandPalette`/
 * `NewBranchDialog`/`ConfirmDialog` already establish. Unlike the palette, there's no text input to
 * focus on open — focus lands on the explicit close button instead (FR-232).
 *
 * Only ever rendered by `App.tsx` while its own `shortcutsOpen` boolean is true, which is folded
 * into the same `anyModalDialogOpen` aggregate that suspends the global keybinding layer (FR-237) —
 * nothing here needs to separately guard against a duplicate Ctrl/Cmd+/ reopening a second overlay,
 * or against another dialog/the palette opening underneath it.
 */
export function KeyboardShortcutsScreen({ ctx, onClose }: KeyboardShortcutsScreenProps) {
  const titleId = useId();
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  // FR-233: every registered command, regardless of `isAvailable` — deliberately not filtered the
  // way `CommandPalette`'s own `available` memo filters it.
  const commands = useMemo(() => getCommands(ctx), [ctx]);

  useEffect(() => {
    function onDocKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onDocKeyDown);
    closeButtonRef.current?.focus();
    return () => document.removeEventListener("keydown", onDocKeyDown);
  }, [onClose]);

  return (
    <div className="gh-keyboard-shortcuts__overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="gh-keyboard-shortcuts" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="gh-keyboard-shortcuts__header">
          <h2 id={titleId} className="gh-keyboard-shortcuts__title">
            Keyboard shortcuts
          </h2>
          <button
            ref={closeButtonRef}
            type="button"
            className="gh-keyboard-shortcuts__close"
            aria-label="Close keyboard shortcuts"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="gh-keyboard-shortcuts__body">
          {CATEGORY_SECTIONS.map(({ key, heading }) => {
            const headingId = `${titleId}-${key}`;
            const rows = rowsForCategory(key, commands);
            return (
              <section key={key} className="gh-keyboard-shortcuts__section" aria-labelledby={headingId}>
                <h3 id={headingId} className="gh-keyboard-shortcuts__heading">
                  {heading}
                </h3>
                <ul className="gh-keyboard-shortcuts__list">
                  {rows.map((row) => (
                    <li key={row.id} className="gh-keyboard-shortcuts__item">
                      <span className="gh-keyboard-shortcuts__label">{row.label}</span>
                      {row.keybindings.length > 0 && (
                        <span className="gh-keyboard-shortcuts__shortcut gh-mono">
                          {row.keybindings.map(keyComboLabel).join(" / ")}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
