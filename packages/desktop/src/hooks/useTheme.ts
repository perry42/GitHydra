// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "githydra:theme";

function getInitialTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  // specs/restore-tabs-on-relaunch.md AC10: this read wasn't actually try/catch-guarded despite
  // this module's own doc comment (and other callers) treating it as the reference pattern for
  // "localStorage unavailable degrades gracefully" — an unavailable/throwing `localStorage` (e.g.
  // a private/sandboxed environment) crashed the whole app here before it ever got to render
  // anything, since this hook runs on every `App` mount. Matches every other read in this
  // codebase now: never throws.
  try {
    const stored = window.localStorage?.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // Fall through to the prefers-color-scheme default below.
  }
  // DESIGN.md: dark graphite UI ground by default, with a validated light-theme equivalent.
  const prefersLight = window.matchMedia?.("(prefers-color-scheme: light)").matches;
  return prefersLight ? "light" : "dark";
}

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage?.setItem(STORAGE_KEY, theme);
    } catch {
      // localStorage unavailable (e.g. private mode) — theme just won't persist across restarts.
    }
  }, [theme]);

  const toggle = useCallback(() => setTheme((t) => (t === "dark" ? "light" : "dark")), []);
  return [theme, toggle];
}
