// SPDX-License-Identifier: GPL-3.0-or-later
// Shared by the renderer and the main process (the native hook box, specs/worktrees.md FR-644): no Node or DOM imports.
// Control, bidi and invisible characters become visible escapes (FR-612): a branch or path is attacker-controlled text.
// Code point ranges (control, soft hyphen, Arabic letter mark, Hangul fillers, Mongolian selectors, zero-width and bidi
// marks, word joiner and invisible operators, Braille blank, variation selectors, BOM, tag characters, interlinear annotation and musical invisible formatting characters).
const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x34f, 0x34f], [0x61c, 0x61c], [0x115f, 0x1160], [0x17b4, 0x17b5],
  [0x180b, 0x180f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069], [0x2800, 0x2800],
  [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xffa0, 0xffa0], [0xfff9, 0xfffb], [0x1d173, 0x1d17a], [0xe0000, 0xe007f],
];
const hex = (n: number): string => "\\u{" + n.toString(16) + "}";
const INVISIBLE = new RegExp("[" + INVISIBLE_RANGES.map(([a, b]) => (a === b ? hex(a) : hex(a) + "-" + hex(b))).join("") + "]", "gu");

export function visibleText(raw: string): string {
  return raw.replace(INVISIBLE, (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`);
}
