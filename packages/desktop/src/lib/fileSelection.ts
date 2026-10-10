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
  /** specs/hunk-line-staging.md FR-482: display flag only - the combined-diff verdict proved a Staged/Unstaged row is the same partly staged file; it is never a row kind. */
  mixed: boolean;
  /** The path is in both Staged and Unstaged (no verdict needed): an Unstaged row's Stage/Discard then keep the staged part. */
  partlyStaged: boolean;
  /** An untracked nested repository: git reports it as `dir/`. Never discardable (FR-501). */
  isDir: boolean;
  entry: WorkingDirectoryFileChange;
}

export function rowKey(section: RowSection, path: string): string {
  return `${section}:${path}`;
}

/** Paths git-core lists in both Staged and Unstaged (FR-19). */
export function partlyStagedPaths(changes: WorkingDirectoryChanges | null): Set<string> {
  const out = new Set<string>();
  if (!changes || changes.staged.length === 0 || changes.unstaged.length === 0) return out;
  const staged = new Set(changes.staged.map((e) => e.path));
  for (const u of changes.unstaged) if (staged.has(u.path)) out.add(u.path);
  return out;
}

/** Visible rows in display order: Staged, Unstaged, Untracked, Conflicted. A partly staged file is two rows (FR-482). */
export function buildRows(changes: WorkingDirectoryChanges | null, markerPaths: ReadonlySet<string>): FileRow[] {
  if (!changes) return [];
  const partly = partlyStagedPaths(changes);
  const make = (section: RowSection, entry: WorkingDirectoryFileChange): FileRow => ({
    key: rowKey(section, entry.path),
    path: entry.path,
    section,
    mixed: (section === "staged" || section === "unstaged") && markerPaths.has(entry.path),
    partlyStaged: (section === "staged" || section === "unstaged") && partly.has(entry.path),
    isDir: entry.path.endsWith("/"),
    entry,
  });
  const conflicted = changes.conflicted.map((e) => make("conflicted", e));
  const rest = [
    ...changes.staged.map((e) => make("staged", e)),
    ...changes.unstaged.map((e) => make("unstaged", e)),
    ...changes.untracked.map((e) => make("untracked", e)),
  ];
  // specs/conflict-first-layout.md FR-573: Conflicted renders first while it is non-empty; keyboard order must match.
  return [...conflicted, ...rest];
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
      return row.section === "staged" ? null : "Not staged.";
    case "discard":
      if (row.section === "staged") return "Staged changes are not discarded here; unstage first.";
      if (row.isDir) return "Directories and nested repositories cannot be discarded.";
      return null;
    case "ignore":
      return null;
  }
}

/**
 * FR-506: which selected rows an action applies to, and why the rest are skipped. Counts are by path
 * (specs/hunk-line-staging.md FR-482): a partly staged file selected on both rows is one file, and its other
 * row is not "skipped" when the action applies to this one.
 */
export function eligibility(action: BulkAction, rows: readonly FileRow[]): Eligibility {
  const eligible: FileRow[] = [];
  const skipped: SkippedRow[] = [];
  const eligiblePaths = new Set<string>();
  for (const row of rows) {
    const reason = reasonFor(action, row);
    if (reason === null) {
      if (!eligiblePaths.has(row.path)) {
        eligiblePaths.add(row.path);
        eligible.push(row);
      }
    } else skipped.push({ row, reason });
  }
  const skippedPaths = new Set<string>();
  const skippedDeduped = skipped.filter((s) => {
    if (eligiblePaths.has(s.row.path) || skippedPaths.has(s.row.path)) return false;
    skippedPaths.add(s.row.path);
    return true;
  });
  return { eligible, skipped: skippedDeduped };
}

/** "N selected" counts files, not rows. */
export function uniquePathCount(rows: readonly FileRow[]): number {
  return new Set(rows.map((r) => r.path)).size;
}

export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

/** The git-core row shape: a partly staged Unstaged row stages as `mixed`; a Staged row unstages through the index-only `staged` section. */
export function toBulkRow(
  row: FileRow,
  _action: "stage" | "unstage",
): { path: string; section: "staged" | "unstaged" | "untracked" | "mixed" | "conflicted" } {
  return { path: row.path, section: row.section === "unstaged" && row.partlyStaged ? "mixed" : row.section };
}

/** A Staged row has no discard (FR-506); callers filter with `eligibility("discard", ...)` first. */
export function toDiscardCandidate(row: FileRow): { path: string; section: "unstaged" | "untracked" | "mixed" } {
  return { path: row.path, section: row.section === "untracked" ? "untracked" : row.partlyStaged ? "mixed" : "unstaged" };
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
