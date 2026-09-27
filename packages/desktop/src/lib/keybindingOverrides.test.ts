// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from "vitest";
import {
  applyKeybindingOverrides,
  conflictMessage,
  findConflictingCommand,
  keyCombosEqual,
  keyComboFromEvent,
  reservedComboMessage,
  sanitizeOverrides,
  validateNewCombo,
} from "./keybindingOverrides";
import type { Command } from "./commands";

function setPlatform(platform: string | undefined) {
  Object.defineProperty(window.navigator, "platform", { value: platform, configurable: true });
}

function makeCommand(overrides: Partial<Command> = {}): Command {
  return {
    id: "some-command",
    label: "Some command",
    category: "general",
    isAvailable: () => true,
    run: () => {},
    ...overrides,
  };
}

describe("applyKeybindingOverrides (specs/keyboard-shortcut-rebinding.md FR-395)", () => {
  it("leaves a command with no override entry untouched (same keybindings reference not required, but same values)", () => {
    const commands = [makeCommand({ id: "a", keybindings: [{ key: "r", mod: true }] })];
    const result = applyKeybindingOverrides(commands, {});
    expect(result[0]!.keybindings).toEqual([{ key: "r", mod: true }]);
  });

  it("replaces keybindings entirely for a custom array override, never merging with the default", () => {
    const commands = [makeCommand({ id: "a", keybindings: [{ key: "r", mod: true }, { key: "F5" }] })];
    const result = applyKeybindingOverrides(commands, { a: [{ key: "b", mod: true, shift: true }] });
    expect(result[0]!.keybindings).toEqual([{ key: "b", mod: true, shift: true }]);
  });

  it('"unbound" produces an empty keybindings array, not undefined, and not the default', () => {
    const commands = [makeCommand({ id: "a", keybindings: [{ key: "r", mod: true }] })];
    const result = applyKeybindingOverrides(commands, { a: "unbound" });
    expect(result[0]!.keybindings).toEqual([]);
  });

  it("gives New branch… (no default keybindings) a fresh custom binding", () => {
    const commands = [makeCommand({ id: "new-branch", label: "New branch…" })];
    const result = applyKeybindingOverrides(commands, { "new-branch": [{ key: "b", mod: true, shift: true }] });
    expect(result[0]!.keybindings).toEqual([{ key: "b", mod: true, shift: true }]);
  });

  it("never mutates the input command objects", () => {
    const original = makeCommand({ id: "a", keybindings: [{ key: "r", mod: true }] });
    applyKeybindingOverrides([original], { a: "unbound" });
    expect(original.keybindings).toEqual([{ key: "r", mod: true }]);
  });

  it("preserves every other field untouched", () => {
    const run = () => {};
    const isAvailable = () => true;
    const commands = [makeCommand({ id: "a", label: "A", category: "git", run, isAvailable })];
    const result = applyKeybindingOverrides(commands, { a: "unbound" });
    expect(result[0]!.label).toBe("A");
    expect(result[0]!.category).toBe("git");
    expect(result[0]!.run).toBe(run);
    expect(result[0]!.isAvailable).toBe(isAvailable);
  });
});

describe("keyCombosEqual", () => {
  it("is case-insensitive on key and treats missing mod/shift as false", () => {
    expect(keyCombosEqual({ key: "K" }, { key: "k" })).toBe(true);
    expect(keyCombosEqual({ key: "k", mod: false }, { key: "k" })).toBe(true);
  });

  it("distinguishes mod/shift combinations", () => {
    expect(keyCombosEqual({ key: "k", mod: true }, { key: "k", mod: true, shift: true })).toBe(false);
    expect(keyCombosEqual({ key: "k", mod: true }, { key: "j", mod: true })).toBe(false);
  });
});

describe("reservedComboMessage / validateNewCombo (FR-397/FR-398)", () => {
  it("rejects Ctrl/Cmd+K naming the Command Palette", () => {
    expect(reservedComboMessage({ key: "k", mod: true })).toMatch(/command palette/i);
  });

  it("rejects Ctrl/Cmd+Tab and Ctrl/Cmd+Shift+Tab naming tab switching", () => {
    expect(reservedComboMessage({ key: "Tab", mod: true })).toMatch(/switch tabs/i);
    expect(reservedComboMessage({ key: "Tab", mod: true, shift: true })).toMatch(/switch tabs/i);
  });

  it("does not flag an ordinary combo as reserved", () => {
    expect(reservedComboMessage({ key: "p", mod: true })).toBeNull();
  });

  it("AC5: validateNewCombo rejects the three reserved combos inline, nothing else needed", () => {
    expect(validateNewCombo({ key: "k", mod: true })).toEqual({ ok: false, message: expect.stringMatching(/command palette/i) });
    expect(validateNewCombo({ key: "Tab", mod: true })).toEqual({ ok: false, message: expect.stringMatching(/switch tabs/i) });
  });

  it("AC4: rejects a bare key or Shift-only combo (no primary modifier) with an explicit message", () => {
    expect(validateNewCombo({ key: "b" })).toEqual({ ok: false, message: "Shortcuts must include Ctrl (Cmd on macOS)." });
    expect(validateNewCombo({ key: "b", shift: true })).toEqual({
      ok: false,
      message: "Shortcuts must include Ctrl (Cmd on macOS).",
    });
  });

  it("accepts an ordinary mod-carrying combo", () => {
    expect(validateNewCombo({ key: "b", mod: true, shift: true })).toEqual({ ok: true });
  });
});

describe("findConflictingCommand / conflictMessage (FR-399)", () => {
  it("finds the other command currently bound to the same combo", () => {
    const commands = [
      makeCommand({ id: "pull", label: "Pull", keybindings: [{ key: "p", mod: true }] }),
      makeCommand({ id: "toggle-theme", label: "Toggle theme", keybindings: [] }),
    ];
    const conflict = findConflictingCommand({ key: "p", mod: true }, commands, "toggle-theme");
    expect(conflict?.id).toBe("pull");
  });

  it("never reports the command being edited itself as its own conflict", () => {
    const commands = [makeCommand({ id: "pull", label: "Pull", keybindings: [{ key: "p", mod: true }] })];
    expect(findConflictingCommand({ key: "p", mod: true }, commands, "pull")).toBeUndefined();
  });

  it("returns undefined when the combo is free", () => {
    const commands = [makeCommand({ id: "pull", label: "Pull", keybindings: [{ key: "p", mod: true }] })];
    expect(findConflictingCommand({ key: "z", mod: true }, commands, "toggle-theme")).toBeUndefined();
  });

  it('conflictMessage matches FR-399\'s own example format', () => {
    setPlatform("Win32");
    expect(conflictMessage({ key: "p", mod: true, shift: true }, "Pull")).toBe('Ctrl+Shift+P is already used by "Pull".');
  });
});

describe("keyComboFromEvent (FR-402)", () => {
  const originalPlatform = window.navigator.platform;
  afterEach(() => setPlatform(originalPlatform));

  it("builds a combo from an ordinary modified keydown", () => {
    setPlatform("Win32");
    const e = new KeyboardEvent("keydown", { key: "B", ctrlKey: true, shiftKey: true });
    expect(keyComboFromEvent(e)).toEqual({ key: "b", mod: true, shift: true });
  });

  it("normalizes multi-character key names verbatim (case as delivered by the browser)", () => {
    setPlatform("Win32");
    const e = new KeyboardEvent("keydown", { key: "F5", ctrlKey: true });
    expect(keyComboFromEvent(e)).toEqual({ key: "F5", mod: true, shift: false });
  });

  it("returns null while only a modifier key itself is held (still listening)", () => {
    const e = new KeyboardEvent("keydown", { key: "Control" });
    expect(keyComboFromEvent(e)).toBeNull();
  });

  it("returns null while Alt is held (never a matchable combo)", () => {
    setPlatform("Win32");
    const e = new KeyboardEvent("keydown", { key: "b", ctrlKey: true, altKey: true });
    expect(keyComboFromEvent(e)).toBeNull();
  });

  it("returns null when the OTHER platform's modifier is held instead (mirrors matchesKeyCombo) — even combined with the real primary modifier", () => {
    setPlatform("Win32");
    const e = new KeyboardEvent("keydown", { key: "b", metaKey: true });
    expect(keyComboFromEvent(e)).toBeNull();
    const e2 = new KeyboardEvent("keydown", { key: "b", ctrlKey: true, metaKey: true });
    expect(keyComboFromEvent(e2)).toBeNull();
  });

  it("on macOS, metaKey is the primary modifier and ctrlKey is the 'other' one to reject", () => {
    setPlatform("MacIntel");
    const e = new KeyboardEvent("keydown", { key: "b", metaKey: true });
    expect(keyComboFromEvent(e)).toEqual({ key: "b", mod: true, shift: false });
    const e2 = new KeyboardEvent("keydown", { key: "b", ctrlKey: true });
    expect(keyComboFromEvent(e2)).toBeNull();
  });
});

describe("sanitizeOverrides", () => {
  it("passes through a well-formed map unchanged", () => {
    const raw = { "new-branch": [{ key: "b", mod: true, shift: true }], "toggle-theme": "unbound" };
    expect(sanitizeOverrides(raw)).toEqual(raw);
  });

  it("drops a malformed entry (missing key, wrong types) without throwing", () => {
    const raw = {
      good: [{ key: "b", mod: true }],
      badShape: { key: 5 },
      badArray: [{ notKey: "x" }],
      badSentinel: "bound",
    };
    expect(sanitizeOverrides(raw)).toEqual({ good: [{ key: "b", mod: true }] });
  });

  it("returns {} for null/non-object/primitive input", () => {
    expect(sanitizeOverrides(null)).toEqual({});
    expect(sanitizeOverrides(undefined)).toEqual({});
    expect(sanitizeOverrides("not an object")).toEqual({});
    expect(sanitizeOverrides(42)).toEqual({});
  });
});
