// SPDX-License-Identifier: GPL-3.0-or-later
import type { WorkingDirectoryChanges, WorkingDirectoryFileChange } from "@githydra/git-core";

/**
 * specs/ignore-and-multiselect.md FR-505/FR-506/FR-511: the Changes list's selection model as pure functions, so the
 * rules (key = path + section, one selection across sections, per-action eligibility) are testable without React.
 */

export type RowSection = "staged" | "unstaged" | "untracked" | "conflicted";

export interface FileRow {
  /** `section:path` (FR-505: the row key is path + section). */
  key: string;
  path: string;
  section: RowSection;
  /** FR-482: partly staged; lives in Unstaged and keeps FR-23/FR-30/FR-31 semantics. */
  mixed: boolean;
  /** An untracked nested repository: git reports it as `dir/`. Never discardable (FR-501). */
  isDir: boolean;
  entry: WorkingDirectoryFileChange;
}

export function rowKey(section: RowSection, path: string): string {
  return `${section}:${path}`;
}

/** Visible rows in display order: Staged, Unstaged, Untracked, Conflicted (mixed rows appear once, in Unstaged). */
export function buildRows(changes: WorkingDirectoryChanges | null, mixedPaths: ReadonlySet<string>): FileRow[] {
  if (!changes) return [];
  const make = (section: RowSection, entry: WorkingDirectoryFileChange): FileRow => ({
    key: rowKey(section, entry.path),
    path: entry.path,
    section,
    mixed: section === "unstaged" && mixedPaths.has(entry.path),
    isDir: entry.path.endsWith("/"),
    entry,
  });
  return [
    ...changes.staged.filter((e) => !mixedPaths.has(e.path)).map((e) => make("staged", e)),
    ...changes.unstaged.map((e) => make("unstaged", e)),
    ...changes.untracked.map((e) => make("untracked", e)),
    ...changes.conflicted.map((e) => make("conflicted", e)),
  ];
}

export interface SelectionState {
  keys: ReadonlySet<string>;
  /** Shift-range origin (FR-505). */
  anchor: string | null;
}

export const EMPTY_SELECTION: SelectionState = { keys: new Set(), anchor: null };

export function selectOnly(key: string): SelectionState {
  return { keys: new Set([key]), anchor: key };
}

export function toggleKey(state: SelectionState, key: string): SelectionState {
  const keys = new Set(state.keys);
  if (keys.has(key)) keys.delete(key);
  else keys.add(key);
  return { keys, anchor: key };
}

/** FR-505: the range runs through the flat display order, across sections (D4). The anchor stays put. */
export function selectRange(
  state: SelectionState,
  rows: readonly FileRow[],
  toKey: string,
  additive: boolean,
  /** Origin when nothing was ever anchored (Shift+Arrow from a row that was only focused). */
  fallbackAnchor?: string,
): SelectionState {
  const to = rows.findIndex((r) => r.key === toKey);
  if (to < 0) return state;
  const valid = (k: string | null | undefined): k is string => !!k && rows.some((r) => r.key === k);
  const fromKey = valid(state.anchor) ? state.anchor : valid(fallbackAnchor) ? fallbackAnchor : toKey;
  const from = rows.findIndex((r) => r.key === fromKey);
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  const keys = additive ? new Set(state.keys) : new Set<string>();
  for (let i = lo; i <= hi; i++) keys.add(rows[i]!.key);
  return { keys, anchor: fromKey };
}

/** FR-505: Ctrl/Cmd+A selects the whole section the focused row is in. */
export function selectSection(rows: readonly FileRow[], section: RowSection): SelectionState {
  const inSection = rows.filter((r) => r.section === section);
  return { keys: new Set(inSection.map((r) => r.key)), anchor: inSection[0]?.key ?? null };
}

/**
 * FR-511: after the list changed, a selected path that moved sections keeps its selection in the new one; a path that
 * vanished drops silently. Returns the same object when nothing changed so callers can skip a state update.
 */
export function reconcileSelection(state: SelectionState, rows: readonly FileRow[]): SelectionState {
  if (state.keys.size === 0 && state.anchor === null) return state;
  const present = new Set(rows.map((r) => r.key));
  const byPath = new Map<string, FileRow>();
  for (const r of rows) if (!byPath.has(r.path)) byPath.set(r.path, r);
  const remap = (key: string): string | null => {
    if (present.has(key)) return key;
    const path = key.slice(key.indexOf(":") + 1);
    return byPath.get(path)?.key ?? null;
  };
  let changed = false;
  const keys = new Set<string>();
  for (const k of state.keys) {
    const next = remap(k);
    if (next !== k) changed = true;
    if (next !== null) keys.add(next);
  }
  const anchor = state.anchor === null ? null : remap(state.anchor);
  if (anchor !== state.anchor) changed = true;
  return changed ? { keys, anchor } : state;
}

export type BulkAction = "stage" | "unstage" | "discard" | "ignore";

export interface SkippedRow {
  row: FileRow;
  reason: string;
}

export interface Eligibility {
  eligible: FileRow[];
  skipped: SkippedRow[];
}

function reasonFor(action: BulkAction, row: FileRow): string | null {
  if (row.section === "conflicted") {
    return action === "ignore"
      ? "Conflicted files cannot be ignored; resolve the conflict first."
      : "Conflicted files are resolved in the conflict view.";
  }
  switch (action) {
    case "stage":
      return row.section === "staged" ? "Already staged." : null;
    case "unstage":
      // A partly staged row keeps its per-row Unstage (FR-30): the staged part is what comes out.
      return row.section === "staged" || row.mixed ? null : "Not staged.";
    case "discard":
      if (row.section === "staged") return "Staged changes are not discarded here; unstage first.";
      if (row.isDir) return "Directories and nested repositories cannot be discarded.";
      return null;
    case "ignore":
      return null;
  }
}

/** FR-506: which selected rows an action applies to, and why the rest are skipped. */
export function eligibility(action: BulkAction, rows: readonly FileRow[]): Eligibility {
  const eligible: FileRow[] = [];
  const skipped: SkippedRow[] = [];
  for (const row of rows) {
    const reason = reasonFor(action, row);
    if (reason === null) eligible.push(row);
    else skipped.push({ row, reason });
  }
  return { eligible, skipped };
}

export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

/** The git-core row shape: a mixed row stages as `mixed`, and unstages as its `staged` side (git-core only unstages Staged rows). */
export function toBulkRow(
  row: FileRow,
  action: "stage" | "unstage",
): { path: string; section: "staged" | "unstaged" | "untracked" | "mixed" | "conflicted" } {
  if (action === "unstage") return { path: row.path, section: row.mixed ? "staged" : row.section };
  return { path: row.path, section: row.mixed ? "mixed" : row.section };
}

export function toDiscardCandidate(row: FileRow): { path: string; section: "unstaged" | "untracked" | "mixed" } {
  return { path: row.path, section: row.mixed ? "mixed" : row.section === "untracked" ? "untracked" : "unstaged" };
}

/** What a bulk action would do, in words ("Stage 3 files" / "Stage 3 files, 2 skipped"). */
export function actionSummary(verb: string, e: Eligibility): string {
  const base = `${verb} ${plural(e.eligible.length, "file")}`;
  return e.skipped.length > 0 ? `${base}, ${e.skipped.length} skipped` : base;
}

/** Up to `limit` paths for a dialog, then "and M more" (FR-509). */
export function pathSample(paths: readonly string[], limit = 8): { shown: string[]; more: number } {
  return { shown: paths.slice(0, limit), more: Math.max(0, paths.length - limit) };
}

export const DISCARD_TYPE_TO_CONFIRM_ABOVE = 20;
/** The number the user types to confirm a large discard (the mockup's "Type 34 to confirm"): it forces reading the count. */
export const discardConfirmToken = (count: number): string => String(count);
