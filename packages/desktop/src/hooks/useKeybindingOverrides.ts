// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useState } from "react";
import type { KeyCombo } from "../lib/platform";
import { sanitizeOverrides, type KeybindingOverrides } from "../lib/keybindingOverrides";

const STORAGE_KEY = "githydra:keybindings:overrides";

/**
 * specs/keyboard-shortcut-rebinding.md FR-394/FR-405: global, not per-repo — the same scope
 * `useTheme.ts`/`useLayoutPreferences.ts` already use for their own preferences, following the
 * exact try/catch-guarded `localStorage` read/write pattern those two hooks establish (never
 * throws, degrades to "nothing persists" when `localStorage` is unavailable).
 */
function getInitialOverrides(): KeybindingOverrides {
  if (typeof window === "undefined") return {};
  try {
    const stored = window.localStorage?.getItem(STORAGE_KEY);
    if (!stored) return {};
    return sanitizeOverrides(JSON.parse(stored));
  } catch {
    // Corrupt JSON, or localStorage unavailable — start from "no customizations" rather than
    // throwing, matching `useTheme.ts`'s `getInitialTheme` fix for the same class of bug.
    return {};
  }
}

export interface UseKeybindingOverridesResult {
  overrides: KeybindingOverrides;
  /** FR-396/FR-399: rebinds `commandId` to exactly `combos` (replacing its previous effective
   * keybindings entirely — the "no additional binding without discarding the default" scope), or
   * FR-399's Reassign leaving a conflicting command with its own remaining combos (or "unbound" if
   * that empties it). */
  setOverride: (commandId: string, value: KeyCombo[] | "unbound") => void;
  /** FR-400: removes `commandId`'s entry entirely, reverting it to the registry's shipped
   * default — no confirmation, instantly reversible. */
  resetOverride: (commandId: string) => void;
  /** FR-401: clears every custom override in one step (caller routes this through
   * `ConfirmDialog` first — this hook itself has no opinion on confirmation). */
  resetAll: () => void;
}

export function useKeybindingOverrides(): UseKeybindingOverridesResult {
  const [overrides, setOverrides] = useState<KeybindingOverrides>(getInitialOverrides);

  useEffect(() => {
    try {
      window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(overrides));
    } catch {
      // localStorage unavailable (e.g. private mode) — customizations just won't persist across
      // restarts, matching every other preference hook's own degrade-gracefully posture.
    }
  }, [overrides]);

  const setOverride = useCallback((commandId: string, value: KeyCombo[] | "unbound") => {
    setOverrides((prev) => ({ ...prev, [commandId]: value }));
  }, []);

  const resetOverride = useCallback((commandId: string) => {
    setOverrides((prev) => {
      if (!(commandId in prev)) return prev;
      const next = { ...prev };
      delete next[commandId];
      return next;
    });
  }, []);

  const resetAll = useCallback(() => setOverrides({}), []);

  return { overrides, setOverride, resetOverride, resetAll };
}
