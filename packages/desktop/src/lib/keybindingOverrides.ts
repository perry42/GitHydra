// SPDX-License-Identifier: GPL-3.0-or-later
import type { Command } from "./commands";
import { isMac, keyComboLabel, type KeyCombo } from "./platform";

/**
 * specs/keyboard-shortcut-rebinding.md FR-394: a command id mapped to an array is a custom
 * rebinding (replacing its registry-default `keybindings` entirely — FR-396's "no additional
 * binding without discarding the default" scope); mapped to the literal sentinel `"unbound"` means
 * the user explicitly cleared that command's shortcut with no replacement; a command id absent
 * from this map inherits its registry-default `keybindings` unchanged. Global (not per-repo),
 * persisted by `useKeybindingOverrides.ts` under `githydra:keybindings:overrides`.
 */
export type KeybindingOverrides = Record<string, KeyCombo[] | "unbound">;

/**
 * FR-395: the ONE place a `KeybindingOverrides` map is turned into effective `Command[]`
 * `keybindings` — `useGlobalKeybindings`'s lookup loop, `CommandPalette`'s shortcut-hint
 * rendering, and `KeyboardShortcutsScreen`'s row rendering all call this over `getCommands(ctx)`'s
 * raw output rather than reading `keybindings` directly, so there is never a second,
 * independently-patched call site. Every other field is untouched (a fresh object per command,
 * never mutating the registry's own array in place).
 */
export function applyKeybindingOverrides(commands: Command[], overrides: KeybindingOverrides): Command[] {
  return commands.map((command) => {
    const override = overrides[command.id];
    if (override === undefined) return command;
    return { ...command, keybindings: override === "unbound" ? [] : override };
  });
}

/** FR-227-style case-insensitive key compare plus exact `mod`/`shift` boolean match (`undefined`
 * treated as `false`, matching every combo literal already written in `commands.ts`). */
export function keyCombosEqual(a: KeyCombo, b: KeyCombo): boolean {
  return a.key.toLowerCase() === b.key.toLowerCase() && Boolean(a.mod) === Boolean(b.mod) && Boolean(a.shift) === Boolean(b.shift);
}

/**
 * FR-397: the two combos that are permanently reserved for `STATIC_SHORTCUT_ROWS`
 * (`commands.ts`) — never assignable to any command, default or custom. Returns the exact inline
 * rejection message when `combo` matches one of them, else `null`.
 */
export function reservedComboMessage(combo: KeyCombo): string | null {
  if (keyCombosEqual(combo, { key: "k", mod: true })) {
    return "Reserved — used to open the Command Palette.";
  }
  if (keyCombosEqual(combo, { key: "Tab", mod: true }) || keyCombosEqual(combo, { key: "Tab", mod: true, shift: true })) {
    return "Reserved — used to switch tabs.";
  }
  return null;
}

/**
 * FR-397/FR-398: the two inline-rejection checks that run before a captured combo is ever
 * considered for a conflict lookup or a save. Order doesn't matter in practice (every reserved
 * combo already carries the primary modifier), but reserved is checked first since it has the
 * more specific message.
 */
export function validateNewCombo(combo: KeyCombo): { ok: true } | { ok: false; message: string } {
  const reserved = reservedComboMessage(combo);
  if (reserved) return { ok: false, message: reserved };
  if (!combo.mod) return { ok: false, message: "Shortcuts must include Ctrl (Cmd on macOS)." };
  return { ok: true };
}

/**
 * FR-399: the first OTHER command (by id, excluding `excludeCommandId`) whose current effective
 * `keybindings` (already override-applied — callers pass the same `commands` array
 * `applyKeybindingOverrides` produced) contains a combo equal to `combo`. `undefined` means no
 * conflict — the combo is free to assign.
 */
export function findConflictingCommand(combo: KeyCombo, commands: Command[], excludeCommandId: string): Command | undefined {
  return commands.find((c) => c.id !== excludeCommandId && (c.keybindings ?? []).some((kb) => keyCombosEqual(kb, combo)));
}

/** A rendering-ready conflict message, matching FR-399's own example verbatim (`"Ctrl+Shift+P is
 * already used by "Pull"."`). */
export function conflictMessage(combo: KeyCombo, conflictingLabel: string): string {
  return `${keyComboLabel(combo)} is already used by "${conflictingLabel}".`;
}

const MODIFIER_ONLY_KEYS = new Set([
  "Control",
  "Meta",
  "Shift",
  "Alt",
  "AltGraph",
  "CapsLock",
  "Fn",
  "FnLock",
  "Hyper",
  "Super",
  "OS",
  "ScrollLock",
  "NumLock",
  "Symbol",
  "SymbolLock",
]);

/**
 * FR-402: turns a raw capture-state `KeyboardEvent` into a candidate `KeyCombo`, or `null` when
 * the event is just a modifier key being pressed on its own (holding Ctrl before pressing the
 * real key fires its own `keydown` first) — callers keep listening in that case rather than
 * previewing an empty/partial combo. Mirrors `matchesKeyCombo`'s own platform/`mod` logic exactly
 * (mac: `metaKey` is the primary modifier, `ctrlKey` the "other" one to reject, and vice versa
 * off-mac) so a combo captured here, once saved, matches the identical keystroke later.
 *
 * Also returns `null` while Alt is held — none of this app's bindings use Alt (a common IME/
 * accented-character modifier), and `matchesKeyCombo` would never match a combo carrying it
 * anyway, so capturing one would silently produce a dead binding.
 */
export function keyComboFromEvent(e: KeyboardEvent): KeyCombo | null {
  if (MODIFIER_ONLY_KEYS.has(e.key)) return null;
  if (e.altKey) return null;
  const mac = isMac();
  const mod = mac ? e.metaKey : e.ctrlKey;
  const otherModHeld = mac ? e.ctrlKey : e.metaKey;
  if (otherModHeld) return null;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return { key, mod, shift: e.shiftKey };
}

function isKeyCombo(value: unknown): value is KeyCombo {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.key !== "string") return false;
  if (v.mod !== undefined && typeof v.mod !== "boolean") return false;
  if (v.shift !== undefined && typeof v.shift !== "boolean") return false;
  return true;
}

/**
 * Defensive shape validation for whatever `JSON.parse`d value came out of `localStorage` —
 * `useKeybindingOverrides.ts`'s read path runs every entry through this rather than trusting the
 * stored JSON's shape, the same "never throw on a corrupt/stale stored value" posture
 * `useLayoutPreferences.ts`'s `getPersistedRightPanel` already established. Unrecognized keys or
 * malformed values are silently dropped, never thrown.
 */
export function sanitizeOverrides(raw: unknown): KeybindingOverrides {
  if (!raw || typeof raw !== "object") return {};
  const result: KeybindingOverrides = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === "unbound") {
      result[id] = "unbound";
    } else if (Array.isArray(value) && value.every(isKeyCombo)) {
      result[id] = value;
    }
  }
  return result;
}
