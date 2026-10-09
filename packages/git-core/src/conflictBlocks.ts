// SPDX-License-Identifier: GPL-3.0-or-later
// Pure string logic only: the renderer value-imports this package, so no Node globals or imports here.
// specs/edit-in-diff.md FR-556..FR-558, specs/merge-rebase-conflict-resolution.md FR-66.

export type ConflictMarkerKind = "start" | "base" | "separator" | "end";

/**
 * `<<<<<<<`, `|||||||` and `>>>>>>>` are exactly 7 chars then a space or end of line (git appends a
 * label after a space); `=======` is exactly 7 chars alone. Longer runs (`========`, a heading
 * underline) are ordinary text. `line` must have no line terminator.
 */
export function classifyConflictMarkerLine(line: string): ConflictMarkerKind | null {
  if (line.length < 7 || (line.length > 7 && line[7] !== " " && line[7] !== "\t")) {
    // Fall through for the separator below: it must be exactly 7 chars, so length != 7 is never one.
    return null;
  }
  const head = line.slice(0, 7);
  switch (head) {
    case "<<<<<<<":
      return "start";
    case "|||||||":
      return "base";
    case ">>>>>>>":
      return "end";
    case "=======":
      return line.length === 7 ? "separator" : null;
    default:
      return null;
  }
}

/** Split into lines keeping offsets; terminators are `\r\n`, `\n` or a lone `\r` (what the editor treats as a break). */
interface RawLine {
  /** 1-based. */
  number: number;
  /** Offset of the first char. */
  from: number;
  /** Offset just past the content, before the terminator. */
  to: number;
  /** Offset of the next line's start (== text.length for the last line). */
  next: number;
  text: string;
}

function splitLines(text: string): RawLine[] {
  const lines: RawLine[] = [];
  const re = /\r\n|\n|\r/g;
  let from = 0;
  let number = 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    lines.push({ number: number++, from, to: m.index, next: m.index + m[0].length, text: text.slice(from, m.index) });
    from = m.index + m[0].length;
  }
  // A trailing terminator does not start a phantom empty line that could matter to marker scans, but keep it for numbering parity with editors.
  lines.push({ number, from, to: text.length, next: text.length, text: text.slice(from) });
  return lines;
}

/** 1-based line numbers of every marker line (any kind, well-formed or not). */
export function findConflictMarkerLines(text: string): number[] {
  return splitLines(text)
    .filter((l) => classifyConflictMarkerLine(l.text) !== null)
    .map((l) => l.number);
}

export interface ConflictMarkerLine {
  kind: ConflictMarkerKind;
  /** 1-based. */
  line: number;
  from: number;
  /** Excludes the line terminator. */
  to: number;
  /** Text after the 7 marker characters, trimmed (git's side label); "" if none. */
  label: string;
}

/** A run of whole lines; `text` keeps each line's own terminator. Empty when `from === to` (and `lastLine < firstLine`). */
export interface ConflictRegion {
  from: number;
  to: number;
  firstLine: number;
  lastLine: number;
  text: string;
}

export interface ConflictBlock {
  /** 0-based position among well-formed blocks in the file. */
  index: number;
  /** Start of the `<<<<<<<` line. */
  from: number;
  /** End of the `>>>>>>>` line content, before its terminator. */
  to: number;
  /** `to` plus the end-marker line's own terminator: replace `[from, toWithEol)` with whole-line resolution text. */
  toWithEol: number;
  startMarker: ConflictMarkerLine;
  /** diff3/zdiff3 only. */
  baseMarker: ConflictMarkerLine | null;
  separatorMarker: ConflictMarkerLine;
  endMarker: ConflictMarkerLine;
  /** Between `<<<<<<<` and `|||||||`/`=======`: index stage 2. */
  ours: ConflictRegion;
  /** diff3/zdiff3 only: index stage 1. */
  base: ConflictRegion | null;
  /** Between `=======` and `>>>>>>>`: index stage 3. */
  theirs: ConflictRegion;
}

export interface ParsedConflictText {
  blocks: ConflictBlock[];
  /** Marker lines outside any well-formed block (truncated, nested, orphaned or edited-into-text markers). */
  strayMarkers: ConflictMarkerLine[];
}

/**
 * Parse conflict blocks out of file text. Anything that is not a complete
 * `<<<<<<<` [`|||||||`] `=======` `>>>>>>>` sequence is reported as a stray marker, never dropped,
 * so "no blocks and no strays" is exactly "no marker lines remain".
 */
export function parseConflictText(text: string): ParsedConflictText {
  const lines = splitLines(text);
  const blocks: ConflictBlock[] = [];
  const strays: ConflictMarkerLine[] = [];

  type Pending = { start: ConflictMarkerLine; startIdx: number; base?: ConflictMarkerLine; baseIdx?: number; sep?: ConflictMarkerLine; sepIdx?: number };
  let pending: Pending | null = null;

  const toMarker = (l: RawLine, kind: ConflictMarkerKind): ConflictMarkerLine => ({
    kind,
    line: l.number,
    from: l.from,
    to: l.to,
    label: l.text.slice(7).trim(),
  });
  const abandon = (p: Pending): void => {
    strays.push(p.start);
    if (p.base) strays.push(p.base);
    if (p.sep) strays.push(p.sep);
  };
  const region = (fromIdx: number, toIdx: number): ConflictRegion => {
    // Lines fromIdx..toIdx-1 inclusive; empty when fromIdx === toIdx.
    const from = lines[fromIdx]!.from;
    const to = lines[toIdx]!.from;
    return { from, to, firstLine: lines[fromIdx]!.number, lastLine: lines[toIdx]!.number - 1, text: text.slice(from, to) };
  };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const kind = classifyConflictMarkerLine(l.text);
    if (kind === null) continue;
    const marker = toMarker(l, kind);
    switch (kind) {
      case "start":
        if (pending) abandon(pending);
        pending = { start: marker, startIdx: i };
        break;
      case "base":
        if (pending && !pending.base && !pending.sep) {
          pending.base = marker;
          pending.baseIdx = i;
        } else strays.push(marker);
        break;
      case "separator":
        if (pending && !pending.sep) {
          pending.sep = marker;
          pending.sepIdx = i;
        } else strays.push(marker);
        break;
      case "end": {
        if (pending && pending.sep) {
          const p: Pending = pending;
          const oursEnd = p.baseIdx ?? p.sepIdx!;
          blocks.push({
            index: blocks.length,
            from: p.start.from,
            to: l.to,
            toWithEol: l.next,
            startMarker: p.start,
            baseMarker: p.base ?? null,
            separatorMarker: p.sep!,
            endMarker: marker,
            ours: region(p.startIdx + 1, oursEnd),
            base: p.base ? region(p.baseIdx! + 1, p.sepIdx!) : null,
            theirs: region(p.sepIdx! + 1, i),
          });
          pending = null;
        } else strays.push(marker);
        break;
      }
    }
  }
  if (pending) abandon(pending);

  strays.sort((a, b) => a.line - b.line);
  return { blocks, strayMarkers: strays };
}

export type ConflictChoice = "ours" | "theirs" | "both-ours-first" | "both-theirs-first" | "neither";

/** Whole-line resolution text for a chip. `ours`/`theirs` are region texts (each line keeps its terminator). */
export function composeConflictResolution(choice: ConflictChoice, ours: string, theirs: string): string {
  switch (choice) {
    case "ours":
      return ours;
    case "theirs":
      return theirs;
    case "both-ours-first":
      return ours + theirs;
    case "both-theirs-first":
      return theirs + ours;
    case "neither":
      return "";
  }
}

/**
 * Derive which chip a result text corresponds to, or `"custom"`. Chip state is never stored
 * (specs/edit-in-diff.md FR-557); line endings are compared normalised so a CRLF file still matches.
 * Ties (e.g. an empty side) resolve in the listed order: ours, theirs, both-ours-first, both-theirs-first, neither.
 */
export function classifyConflictResolution(result: string, ours: string, theirs: string): ConflictChoice | "custom" {
  const n = (s: string): string => s.replace(/\r\n?/g, "\n");
  const r = n(result);
  const order: ConflictChoice[] = ["ours", "theirs", "both-ours-first", "both-theirs-first", "neither"];
  for (const c of order) {
    if (n(composeConflictResolution(c, ours, theirs)) === r) return c;
  }
  return "custom";
}
