// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from "node:fs";
import * as path from "node:path";

export type ThemeHint = "light" | "dark";

const FILE = "theme-hint.json";
const MAX_BYTES = 1024;

/**
 * The renderer owns the theme (localStorage), but the close prompt must not ask a renderer that may be hung. The renderer
 * pushes its theme here on every change; this file survives restarts. Never throws; the file is read size-capped and written atomically.
 */
export function loadThemeHint(userDataPath: string): ThemeHint | null {
  try {
    const fd = fs.openSync(path.join(userDataPath, FILE), "r");
    let text: string;
    try {
      const buf = Buffer.alloc(MAX_BYTES + 1);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      if (n > MAX_BYTES) return null;
      text = buf.toString("utf8", 0, n);
    } finally {
      fs.closeSync(fd);
    }
    const parsed: unknown = JSON.parse(text);
    const theme = (parsed as { theme?: unknown } | null)?.theme;
    return theme === "light" || theme === "dark" ? theme : null;
  } catch {
    return null;
  }
}

export function saveThemeHint(userDataPath: string, theme: ThemeHint): void {
  try {
    fs.mkdirSync(userDataPath, { recursive: true });
    const target = path.join(userDataPath, FILE);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ theme }));
    fs.renameSync(tmp, target);
  } catch {
    // Best effort: the prompt falls back to the OS colour scheme.
  }
}

export function parseThemeHint(value: unknown): ThemeHint | null {
  return value === "light" || value === "dark" ? value : null;
}
