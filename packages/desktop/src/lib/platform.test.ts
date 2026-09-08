// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from "vitest";
import { isMac, keyComboLabel, matchesKeyCombo } from "./platform";

function setPlatform(platform: string | undefined) {
  Object.defineProperty(window.navigator, "platform", { value: platform, configurable: true });
}

function makeEvent(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key: init.key,
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    shiftKey: init.shiftKey ?? false,
    altKey: init.altKey ?? false,
  });
}

describe("platform (FR-227)", () => {
  const originalPlatform = window.navigator.platform;
  afterEach(() => {
    setPlatform(originalPlatform);
  });

  it("isMac reflects navigator.platform", () => {
    setPlatform("MacIntel");
    expect(isMac()).toBe(true);
    setPlatform("Win32");
    expect(isMac()).toBe(false);
    setPlatform("Linux x86_64");
    expect(isMac()).toBe(false);
  });

  describe("matchesKeyCombo — AC11: Ctrl on Windows/Linux, Cmd on macOS", () => {
    it("on Windows/Linux, a mod-combo matches ctrlKey and not metaKey", () => {
      setPlatform("Win32");
      const combo = { key: "k", mod: true };
      expect(matchesKeyCombo(makeEvent({ key: "k", ctrlKey: true }), combo)).toBe(true);
      expect(matchesKeyCombo(makeEvent({ key: "k", metaKey: true }), combo)).toBe(false);
      expect(matchesKeyCombo(makeEvent({ key: "k" }), combo)).toBe(false);
    });

    it("on macOS, a mod-combo matches metaKey and not ctrlKey", () => {
      setPlatform("MacIntel");
      const combo = { key: "k", mod: true };
      expect(matchesKeyCombo(makeEvent({ key: "k", metaKey: true }), combo)).toBe(true);
      expect(matchesKeyCombo(makeEvent({ key: "k", ctrlKey: true }), combo)).toBe(false);
    });

    it("is case-insensitive on the key and requires shift to match exactly", () => {
      setPlatform("Win32");
      expect(matchesKeyCombo(makeEvent({ key: "K", ctrlKey: true }), { key: "k", mod: true })).toBe(true);
      expect(matchesKeyCombo(makeEvent({ key: "Tab", ctrlKey: true, shiftKey: true }), { key: "Tab", mod: true })).toBe(false);
      expect(matchesKeyCombo(makeEvent({ key: "Tab", ctrlKey: true, shiftKey: true }), { key: "Tab", mod: true, shift: true })).toBe(
        true,
      );
    });

    it("never matches while Alt is held", () => {
      setPlatform("Win32");
      expect(matchesKeyCombo(makeEvent({ key: "k", ctrlKey: true, altKey: true }), { key: "k", mod: true })).toBe(false);
    });

    it("a mod-less combo does not match when a modifier is held", () => {
      setPlatform("Win32");
      expect(matchesKeyCombo(makeEvent({ key: "Escape" }), { key: "Escape" })).toBe(true);
      expect(matchesKeyCombo(makeEvent({ key: "Escape", ctrlKey: true }), { key: "Escape" })).toBe(false);
    });
  });

  describe("keyComboLabel", () => {
    it("labels the mod key per platform", () => {
      setPlatform("Win32");
      expect(keyComboLabel({ key: "k", mod: true })).toBe("Ctrl+K");
      setPlatform("MacIntel");
      expect(keyComboLabel({ key: "k", mod: true })).toBe("Cmd+K");
    });

    it("includes Shift and preserves multi-character key names", () => {
      setPlatform("Win32");
      expect(keyComboLabel({ key: "Tab", mod: true, shift: true })).toBe("Ctrl+Shift+Tab");
      expect(keyComboLabel({ key: "Enter", mod: true })).toBe("Ctrl+Enter");
    });
  });
});
