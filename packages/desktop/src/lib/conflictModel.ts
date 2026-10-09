// SPDX-License-Identifier: GPL-3.0-or-later
import { classifyConflictResolution, composeConflictResolution, type ConflictSideLabels } from "@githydra/git-core";

// Pure helpers for the conflict block editor (specs/edit-in-diff.md FR-556..565); no React, no CodeMirror.

export type ChipKey = "ours" | "theirs" | "both" | "neither" | "custom";
export type BothOrder = "file" | "rev";
export type SideRole = "you" | "oth";

export interface SideName {
  /** Yours is always the purple hue, the other section the green one (mockup), whichever stage it is. */
  role: SideRole;
  /** "yours" | "incoming" | "onto": the human word for this section (FR-61), never the bare ours/theirs. */
  short: "yours" | "incoming" | "onto";
  /** Branch name when known. */
  name: string | null;
  /** Full FR-61 label, e.g. "Your branch (main @ a1b2c3d)". */
  label: string;
}

/** `top` is git stage 2 (the first section in the file), `bottom` is stage 3. In a rebase top is the onto branch (FR-559). */
export interface SideNames {
  top: SideName;
  bottom: SideName;
  rebase: boolean;
}

export function sideNamesFromLabels(labels: ConflictSideLabels | null): SideNames {
  const rebase = labels?.ours.label.startsWith("Onto") ?? false;
  const mk = (l: { label: string; refName: string | null } | undefined, short: SideName["short"]): SideName => ({
    role: short === "yours" ? "you" : "oth",
    short,
    name: l?.refName ?? null,
    label: l?.label ?? (short === "yours" ? "Yours" : short === "onto" ? "Onto" : "Incoming"),
  });
  return rebase
    ? { top: mk(labels?.ours, "onto"), bottom: mk(labels?.theirs, "yours"), rebase }
    : { top: mk(labels?.ours, "yours"), bottom: mk(labels?.theirs, "incoming"), rebase };
}

export const capitalize = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** The result text a chip stands for. `custom` is resolved by the caller (it needs the remembered slot). */
export function textForChip(key: Exclude<ChipKey, "custom">, order: BothOrder, ours: string, theirs: string): string {
  if (key === "ours") return composeConflictResolution("ours", ours, theirs);
  if (key === "theirs") return composeConflictResolution("theirs", ours, theirs);
  if (key === "neither") return "";
  return composeConflictResolution(order === "rev" ? "both-theirs-first" : "both-ours-first", ours, theirs);
}

export interface DerivedChoice {
  key: ChipKey;
  /** Only meaningful for `both`. */
  order: BothOrder;
}

/** FR-557: the single ticked chip, read from the text. Nothing is stored. */
export function deriveChoice(result: string, ours: string, theirs: string): DerivedChoice {
  const c = classifyConflictResolution(result, ours, theirs);
  switch (c) {
    case "ours":
      return { key: "ours", order: "file" };
    case "theirs":
      return { key: "theirs", order: "file" };
    case "both-ours-first":
      return { key: "both", order: "file" };
    case "both-theirs-first":
      return { key: "both", order: "rev" };
    case "neither":
      return { key: "neither", order: "file" };
    default:
      return { key: "custom", order: "file" };
  }
}

export interface RoleSpan {
  role: SideRole | "custom";
  lines: number;
}

const lineCount = (s: string): number => (s === "" ? 0 : s.split(/\r\n|\r|\n/).length - (/(\r\n|\r|\n)$/.test(s) ? 1 : 0));

/** Which side each result line came from, for the per-line tint; a custom result is one accent run. */
export function roleSpans(d: DerivedChoice, ours: string, theirs: string, names: SideNames): RoleSpan[] {
  const o = lineCount(ours);
  const t = lineCount(theirs);
  switch (d.key) {
    case "ours":
      return [{ role: names.top.role, lines: o }];
    case "theirs":
      return [{ role: names.bottom.role, lines: t }];
    case "both":
      return d.order === "rev"
        ? [{ role: names.bottom.role, lines: t }, { role: names.top.role, lines: o }]
        : [{ role: names.top.role, lines: o }, { role: names.bottom.role, lines: t }];
    case "neither":
      return [];
    default:
      return [{ role: "custom", lines: Infinity }];
  }
}

/** FR-563: why Mark as resolved is off. `null` = nothing left. */
export function gateReason(markerLines: readonly number[]): string | null {
  if (markerLines.length === 0) return null;
  const shown = markerLines.slice(0, 8).join(", ");
  const more = markerLines.length > 8 ? ` and ${markerLines.length - 8} more` : "";
  return `Conflict markers still present (lines ${shown}${more}). Remove them before marking this file resolved.`;
}

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Polite status for a chip change (FR-562); `left` counts conflicts still undecided afterwards. */
export function decisionStatus(n: number, total: number, choiceLabel: string, left: number): string {
  return `Conflict ${n} of ${total}: ${choiceLabel}. ${left === 0 ? "No conflicts unresolved." : `${plural(left, "conflict")} unresolved.`}`;
}

export function choiceLabel(key: ChipKey, names: SideNames, order: BothOrder): string {
  switch (key) {
    case "ours":
      return capitalize(names.top.short) + (names.top.name ? ` (${names.top.name})` : "");
    case "theirs":
      return capitalize(names.bottom.short) + (names.bottom.name ? ` (${names.bottom.name})` : "");
    case "both": {
      const first = order === "rev" ? names.bottom : names.top;
      return `both sides, ${first.short} first`;
    }
    case "neither":
      return "neither side, removed";
    default:
      return "custom text";
  }
}

/** Per-block data the React side needs; JSON-comparable so an unchanged summary never re-renders. */
export interface BlockSummary {
  id: number;
  n: number;
  open: boolean;
  /** `none` while the block is still undecided (its markers are in the text). */
  choice: ChipKey | "none";
  /** 1-based first line, for scroll targets and the footer. */
  line: number;
}

export interface ConflictSummary {
  enabled: boolean;
  total: number;
  unresolved: number;
  /** Every remaining marker line (blocks and strays), sorted. FR-563/FR-564: "none left" is exactly "gate open". */
  markerLines: number[];
  strayCount: number;
  blocks: BlockSummary[];
  currentId: number | null;
  /** The current block's sides, for the read-only reference strip. */
  current: { n: number; ours: string; theirs: string; base: string | null } | null;
}

export const EMPTY_SUMMARY: ConflictSummary = {
  enabled: false,
  total: 0,
  unresolved: 0,
  markerLines: [],
  strayCount: 0,
  blocks: [],
  currentId: null,
  current: null,
};

export type ConflictEvent =
  /** The FIRST decision on a block moved to the next unresolved one (FR-562). */
  | { type: "advance"; fromN: number; toN: number; total: number; status: string }
  /** A decision with no further unresolved block. */
  | { type: "all-decided"; status: string }
  /** Any other chip action, for the live region. */
  | { type: "status"; status: string };
