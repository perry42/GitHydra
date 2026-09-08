// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * specs/keyboard-shortcuts-command-palette.md FR-227: the one shared "which platform am I on"
 * check every keybinding in this feature funnels through — no per-binding platform-sniffing
 * duplicated at each call site.
 */
export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  // `navigator.userAgentData` (Chromium's modern replacement for the deprecated
  // `navigator.platform`) isn't guaranteed present in every Electron/Chromium build this app might
  // run under — falls back to `navigator.platform`/`navigator.userAgent` sniffing, the same
  // defensive-layering convention `useTheme.ts`'s `getInitialTheme` already uses for other
  // environment reads that can't be relied on unconditionally.
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  if (typeof uaData?.platform === "string") return /mac/i.test(uaData.platform);
  return /mac/i.test(navigator.platform || navigator.userAgent || "");
}

/**
 * FR-227: a keybinding's platform-independent description — `mod` means "the platform's primary
 * modifier" (Cmd on macOS, Ctrl on Windows/Linux). `key` is matched case-insensitively against
 * `KeyboardEvent.key` (e.g. `"k"`, `"r"`, `"Enter"`, `"Tab"`).
 */
export interface KeyCombo {
  key: string;
  mod?: boolean;
  shift?: boolean;
}

/**
 * FR-227/AC11: does this `KeyboardEvent` satisfy `combo`, translating `mod` to `metaKey` on macOS
 * and `ctrlKey` everywhere else? Also requires the OTHER platform's modifier to be up (so, e.g., a
 * Windows/Linux user who happens to also be holding the (Windows) "Meta" key doesn't accidentally
 * satisfy a `mod`-less binding, and vice versa) and requires `altKey` to be up (none of this
 * feature's bindings use Alt, and Alt is a common IME/accented-character modifier that shouldn't
 * accidentally arm one of these).
 */
export function matchesKeyCombo(e: KeyboardEvent, combo: KeyCombo): boolean {
  if (e.key.toLowerCase() !== combo.key.toLowerCase()) return false;
  if (e.altKey) return false;
  if (Boolean(combo.shift) !== e.shiftKey) return false;
  const mac = isMac();
  const primaryModHeld = mac ? e.metaKey : e.ctrlKey;
  const otherModHeld = mac ? e.ctrlKey : e.metaKey;
  if (otherModHeld) return false;
  return Boolean(combo.mod) === primaryModHeld;
}

/** FR-227: a display label for a `KeyCombo` (e.g. for the palette's shortcut hints), reusing the
 * exact same platform check `matchesKeyCombo` does rather than a second, independently-maintained
 * one. */
export function keyComboLabel(combo: KeyCombo): string {
  const mac = isMac();
  const parts: string[] = [];
  if (combo.mod) parts.push(mac ? "Cmd" : "Ctrl");
  if (combo.shift) parts.push("Shift");
  parts.push(combo.key.length === 1 ? combo.key.toUpperCase() : combo.key);
  return parts.join("+");
}
