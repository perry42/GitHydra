// SPDX-License-Identifier: GPL-3.0-or-later
import { Fragment, useId, useMemo, useRef, useState } from "react";
import { getCommands, STATIC_SHORTCUT_ROWS, type Command, type CommandCategory, type CommandContext } from "../../lib/commands";
import { useDialogChrome } from "../../hooks/useDialogChrome";
import {
  applyKeybindingOverrides,
  findConflictingCommand,
  keyCombosEqual,
  validateNewCombo,
  type KeybindingOverrides,
} from "../../lib/keybindingOverrides";
import type { KeyCombo } from "../../lib/platform";
import { ConfirmDialog } from "../ConfirmDialog/ConfirmDialog";
import { KeyCap } from "../KeyCap/KeyCap";
import { ShortcutRow, type ShortcutRowConflict } from "./ShortcutRow";
import "./KeyboardShortcutsScreen.css";

export interface KeyboardShortcutsScreenProps {
  ctx: CommandContext;
  onClose: () => void;
  /** specs/keyboard-shortcut-rebinding.md FR-394/FR-404: `useKeybindingOverrides().overrides`,
   * applied before this screen renders any row. Optional (defaults to `{}`, no customizations)
   * purely so this component's own pre-existing render-only tests keep compiling/passing
   * unchanged — `App.tsx` always supplies the real value alongside the three callbacks below. */
  overrides?: KeybindingOverrides;
  /** FR-396/FR-399: persists a rebind (or FR-399's Reassign leftover) for one command id. */
  onSetOverride?: (commandId: string, value: KeyCombo[] | "unbound") => void;
  /** FR-400: per-row "Reset to default" — removes just this command's override. */
  onResetOverride?: (commandId: string) => void;
  /** FR-401: the header's "Reset all shortcuts to default" (already routed through `ConfirmDialog`
   * by this component itself — see `resetAllConfirmOpen` below). */
  onResetAll?: () => void;
}

interface ScreenRow {
  id: string;
  label: string;
  keybindings: KeyCombo[];
  /** FR-396: every registry command is rebindable EXCEPT the dynamic `switch-to-tab:<id>`
   * entries (collapsed into the synthetic `id === "switch-to-tab"` summary row below, which is
   * itself not editable either) and the two `STATIC_SHORTCUT_ROWS` rows (`id` prefixed
   * `"static:"`) — both excluded from the Edit affordance entirely, per FR-396's explicit scope. */
  editable: boolean;
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
    .map((c) => ({ id: c.id, label: c.label, keybindings: c.keybindings ?? [], editable: true }));

  const staticRows: ScreenRow[] = STATIC_SHORTCUT_ROWS.filter((r) => r.category === category).map((r) => ({
    id: `static:${r.label}`,
    label: r.label,
    keybindings: r.keybindings,
    editable: false,
  }));

  if (category === "tabs") {
    return [
      ...registryRows,
      { id: "switch-to-tab", label: "Switch to tab", keybindings: [], editable: false },
      ...staticRows,
    ];
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
 *
 * specs/keyboard-shortcut-rebinding.md FR-402: also the one screen for editing those bindings —
 * each eligible row (`ScreenRow.editable`) renders via `ShortcutRow`, which owns its own local
 * capture mechanics (FR-403); this component owns the actual validation/conflict-lookup/
 * persistence decisions (FR-395's "one place applies overrides" extended to "one place decides
 * whether a captured combo is even valid to save"), since only it has the full effective command
 * list a conflict lookup needs.
 */
export function KeyboardShortcutsScreen({
  ctx,
  onClose,
  overrides = {},
  onSetOverride = () => {},
  onResetOverride = () => {},
  onResetAll = () => {},
}: KeyboardShortcutsScreenProps) {
  const titleId = useId();
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  // FR-233: every registered command, regardless of `isAvailable` — deliberately not filtered the
  // way `CommandPalette`'s own `available` memo filters it. FR-395: overrides applied here, the
  // one place this screen reads effective keybindings from.
  const commands = useMemo(() => applyKeybindingOverrides(getCommands(ctx), overrides), [ctx, overrides]);

  // FR-402/403: at most one row is ever mid-edit. `conflict` is only meaningful while
  // `activeRowId` is set (FR-399's Reassign/Cancel warning replacing the plain capture preview);
  // `message` is FR-397/398's inline rejection text, attached to whichever row it's about and
  // cleared the moment any row starts a new edit.
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ShortcutRowConflict & { conflictCommandId: string } | null>(null);
  const [message, setMessage] = useState<{ rowId: string; text: string } | null>(null);
  const [resetAllConfirmOpen, setResetAllConfirmOpen] = useState(false);

  const { onOverlayMouseDown } = useDialogChrome({
    onEscape: onClose,
    // FR-402/403: while a row is capturing (or a nested "Reset all" ConfirmDialog is open), this
    // screen's OWN Escape-to-close/backdrop-click-to-close must stand down — otherwise Escape
    // would close the whole screen out from under a row's own local Escape handling (or the
    // nested ConfirmDialog's), since both listeners live on `document` and this one was mounted
    // first. `useDialogChrome`'s `escapeActive`/`backdropActive` options exist exactly for this —
    // no new suspension mechanism invented here.
    escapeActive: activeRowId === null && !resetAllConfirmOpen,
    escapeDeps: [onClose, activeRowId, resetAllConfirmOpen],
    refocusWithEscapeEffect: true,
    getFocusTarget: () => closeButtonRef.current,
    onBackdropClick: onClose,
    backdropActive: activeRowId === null && !resetAllConfirmOpen,
  });

  function startEdit(commandId: string) {
    setActiveRowId(commandId);
    setConflict(null);
    setMessage(null);
  }

  function handleCapture(commandId: string, combo: KeyCombo | null) {
    if (!combo) {
      // FR-402: "or silently reverts if nothing was captured."
      setActiveRowId(null);
      return;
    }
    const validation = validateNewCombo(combo);
    if (!validation.ok) {
      // FR-397/398: rejected inline; nothing saved; the row reverts to its previous display.
      setActiveRowId(null);
      setMessage({ rowId: commandId, text: validation.message });
      return;
    }
    const conflictingCommand = findConflictingCommand(combo, commands, commandId);
    if (conflictingCommand) {
      // FR-399: stay on this row, now showing the conflict warning instead of the capture preview.
      setConflict({ combo, conflictLabel: conflictingCommand.label, conflictCommandId: conflictingCommand.id });
      return;
    }
    onSetOverride(commandId, [combo]);
    setActiveRowId(null);
    setMessage(null);
  }

  function handleCancelEdit(commandId: string) {
    // Escape: FR-402 "reverts to prior display, no save" — deliberately no message, distinct from
    // a rejected `handleCapture`.
    if (activeRowId !== commandId) return;
    setActiveRowId(null);
    setConflict(null);
  }

  function handleReassign() {
    if (!conflict || !activeRowId) return;
    const conflictingCommand = commands.find((c) => c.id === conflict.conflictCommandId);
    const remaining = (conflictingCommand?.keybindings ?? []).filter((kb) => !keyCombosEqual(kb, conflict.combo));
    // FR-399: "if that leaves it with zero combos, it becomes unbound, not silently restored to
    // any other default."
    onSetOverride(conflict.conflictCommandId, remaining.length > 0 ? remaining : "unbound");
    onSetOverride(activeRowId, [conflict.combo]);
    setConflict(null);
    setActiveRowId(null);
    setMessage(null);
  }

  function handleCancelConflict() {
    // FR-399: "returns to capture state" — same row, preview cleared, ready to try again.
    setConflict(null);
  }

  function handleResetToDefault(commandId: string) {
    onResetOverride(commandId);
    setMessage((prev) => (prev?.rowId === commandId ? null : prev));
  }

  return (
    <div className="gh-keyboard-shortcuts__overlay" onMouseDown={onOverlayMouseDown}>
      <div className="gh-keyboard-shortcuts" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="gh-keyboard-shortcuts__header">
          <h2 id={titleId} className="gh-keyboard-shortcuts__title">
            Keyboard shortcuts
          </h2>
          <div className="gh-keyboard-shortcuts__header-actions">
            <button
              type="button"
              className="gh-keyboard-shortcuts__reset-all"
              onClick={() => setResetAllConfirmOpen(true)}
            >
              Reset all shortcuts to default
            </button>
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
                  {rows.map((row) =>
                    row.editable ? (
                      <ShortcutRow
                        key={row.id}
                        commandId={row.id}
                        label={row.label}
                        keybindings={row.keybindings}
                        hasOverride={overrides[row.id] !== undefined}
                        isActive={activeRowId === row.id}
                        conflict={activeRowId === row.id ? conflict : null}
                        message={message?.rowId === row.id ? message.text : null}
                        disabled={activeRowId !== null && activeRowId !== row.id}
                        onStartEdit={startEdit}
                        onCapture={handleCapture}
                        onCancelEdit={handleCancelEdit}
                        onReassign={handleReassign}
                        onCancelConflict={handleCancelConflict}
                        onResetToDefault={handleResetToDefault}
                      />
                    ) : (
                      <li key={row.id} className="gh-keyboard-shortcuts__item">
                        <span className="gh-keyboard-shortcuts__label">{row.label}</span>
                        {row.keybindings.length > 0 && (
                          <span className="gh-keyboard-shortcuts__shortcut">
                            {row.keybindings.map((combo, comboIndex) => (
                              <Fragment key={comboIndex}>
                                {comboIndex > 0 && " / "}
                                <KeyCap combo={combo} />
                              </Fragment>
                            ))}
                          </span>
                        )}
                      </li>
                    ),
                  )}
                </ul>
              </section>
            );
          })}
        </div>
      </div>
      {resetAllConfirmOpen && (
        <ConfirmDialog
          title="Reset all shortcuts to default?"
          message="Every custom keyboard shortcut you've set — rebound or explicitly cleared — will revert to its original default. This can't be undone in one step."
          confirmLabel="Reset all"
          onConfirm={() => {
            onResetAll();
            setResetAllConfirmOpen(false);
          }}
          onCancel={() => setResetAllConfirmOpen(false)}
        />
      )}
    </div>
  );
}
