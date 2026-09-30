// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Renderer-side counterpart of git-core's `sanitizeSubject` character policy, for repo-controlled
 * text (branch names, etc.) embedded in a sentence the user must trust (FR-430 dialog). git-core's
 * own module cannot be imported here (it pulls in Node-only code). Drops bidi marks/overrides/
 * isolates, BOM, zero-width and other invisible characters, tag characters and variation selectors;
 * turns control characters into spaces. Numeric ranges, so no invisible characters live in source.
 */
function isDropped(cp: number): boolean {
  return (
    cp === 0x061c || cp === 0x200e || cp === 0x200f || cp === 0xfeff ||
    (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069) ||
    (cp >= 0x200b && cp <= 0x200d) || (cp >= 0x2060 && cp <= 0x2064) ||
    cp === 0xad || cp === 0x180e || cp === 0x34f || cp === 0x115f || cp === 0x1160 ||
    cp === 0x3164 || cp === 0xffa0 ||
    (cp >= 0xe0000 && cp <= 0xe007f) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef)
  );
}

function isControl(cp: number): boolean {
  return cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029;
}

/** Strip bidi/invisible/control characters from repo-controlled text before showing it in a sentence. */
export function sanitizeDisplayText(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const cp = ch.codePointAt(0)!;
    if (isDropped(cp)) continue;
    out += isControl(cp) ? " " : ch;
  }
  return out.replace(/ {2,}/g, " ").trim();
}
