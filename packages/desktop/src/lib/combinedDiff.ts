// SPDX-License-Identifier: GPL-3.0-or-later
import type { CombinedDiffHunk, CombinedLineRef } from "@githydra/git-core";

/**
 * specs/hunk-line-staging.md FR-453/FR-477/FR-480: pure helpers over a combined (HEAD vs worktree) diff.
 * Everything here works on `{ hunk, line }` positions, the same addressing git-core uses for
 * `CombinedLineRef`, so a UI position and an IPC ref are interchangeable.
 */

export interface RowPos {
  hunk: number;
  line: number;
}

export type StagedState = "none" | "some" | "all";

export const posKey = (hunk: number, line: number): string => `${hunk}:${line}`;

/** Every add/remove row in reading order, across hunks; context rows are never addressable (FR-453). */
export function changedRowPositions(hunks: readonly CombinedDiffHunk[]): RowPos[] {
  const out: RowPos[] = [];
  hunks.forEach((hunk, h) => hunk.lines.forEach((line, i) => line.type !== "context" && out.push({ hunk: h, line: i })));
  return out;
}

export const toRef = (p: RowPos): CombinedLineRef => ({ hunkIndex: p.hunk, lineIndex: p.line });

export function hunkChangedRefs(hunk: CombinedDiffHunk, h: number): CombinedLineRef[] {
  const refs: CombinedLineRef[] = [];
  hunk.lines.forEach((line, i) => line.type !== "context" && refs.push({ hunkIndex: h, lineIndex: i }));
  return refs;
}

/** Recomputed from the lines (not `hunk.stagedState`) so an optimistic tick moves the hunk checkbox too (FR-477). */
export function hunkStagedState(hunk: CombinedDiffHunk): StagedState {
  let staged = 0;
  let total = 0;
  for (const line of hunk.lines) {
    if (line.type === "context") continue;
    total++;
    if (line.staged) staged++;
  }
  if (staged === 0) return "none";
  return staged === total ? "all" : "some";
}

/** FR-482: a file is "mixed" when it has staged AND unstaged changed lines. */
export function fileStagingSummary(hunks: readonly CombinedDiffHunk[]): { anyStaged: boolean; anyUnstaged: boolean } {
  let anyStaged = false;
  let anyUnstaged = false;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.type === "context") continue;
      if (line.staged) anyStaged = true;
      else anyUnstaged = true;
    }
  }
  return { anyStaged, anyUnstaged };
}

/** Immutable optimistic edit: set the staged flag of `refs`. `discardable` mirrors `!staged` (git-core's rule). */
export function withStaged(
  hunks: readonly CombinedDiffHunk[],
  refs: readonly CombinedLineRef[],
  staged: boolean,
): CombinedDiffHunk[] {
  if (refs.length === 0) return hunks.slice();
  const byHunk = new Map<number, Set<number>>();
  for (const r of refs) {
    const set = byHunk.get(r.hunkIndex) ?? new Set<number>();
    set.add(r.lineIndex);
    byHunk.set(r.hunkIndex, set);
  }
  return hunks.map((hunk, h) => {
    const wanted = byHunk.get(h);
    if (!wanted) return hunk;
    const lines = hunk.lines.map((line, i) =>
      wanted.has(i) && line.type !== "context" ? { ...line, staged, discardable: !staged } : line,
    );
    const next = { ...hunk, lines };
    return { ...next, stagedState: hunkStagedState(next) };
  });
}

/** The changed rows between two positions inclusive (either order), for a Shift range (FR-453/FR-483). */
export function rangeBetween(order: readonly RowPos[], a: RowPos, b: RowPos): RowPos[] {
  const ia = order.findIndex((p) => p.hunk === a.hunk && p.line === a.line);
  const ib = order.findIndex((p) => p.hunk === b.hunk && p.line === b.line);
  if (ia < 0 || ib < 0) return [];
  return order.slice(Math.min(ia, ib), Math.max(ia, ib) + 1);
}

/**
 * specs/hunk-line-staging.md FR-453/FR-483: the one Shift-range rule for mouse and keyboard - tick every changed
 * line in the range unless all are already ticked, then untick them all. Context rows are never in `rows`.
 */
export function rangeToggleTarget(hunks: readonly CombinedDiffHunk[], rows: readonly RowPos[]): "stage" | "unstage" {
  return rows.length > 0 && rows.every((p) => lineAt(hunks, p)?.staged) ? "unstage" : "stage";
}

export function lineAt(hunks: readonly CombinedDiffHunk[], p: RowPos | CombinedLineRef) {
  const hunk = "hunkIndex" in p ? p.hunkIndex : p.hunk;
  const line = "lineIndex" in p ? p.lineIndex : p.line;
  return hunks[hunk]?.lines[line];
}

/** FR-478: discard is offered only for unstaged changed lines; staged ones are filtered out, never sent. */
export function discardableRefs(hunks: readonly CombinedDiffHunk[], refs: readonly CombinedLineRef[]): CombinedLineRef[] {
  return refs.filter((r) => {
    const line = lineAt(hunks, r);
    return !!line && line.type !== "context" && line.discardable;
  });
}

/**
 * specs/live-refresh.md FR-493: the diff's shape with staged flags left out. Staging never changes it (line
 * indexes stay put, FR-453); an edit to the file does. Equal signatures mean a `{ hunk, line }` address still names
 * the same row, so a pending tick or a Shift anchor stays valid across a reload.
 */
export function layoutSignature(hunks: readonly CombinedDiffHunk[]): string {
  return JSON.stringify(
    hunks.map((h) => [h.header, h.lines.map((l) => [l.type, l.oldLineNumber ?? null, l.newLineNumber ?? null, l.content])]),
  );
}

/** "+c,d" of a hunk header as the worktree range the user sees in the file, e.g. "27–37". */
export function hunkWorktreeRange(header: string): string | undefined {
  const m = /\+(\d+)(?:,(\d+))?/.exec(header);
  if (!m) return undefined;
  const start = Number(m[1]);
  const len = m[2] === undefined ? 1 : Number(m[2]);
  return len <= 1 ? `${start}` : `${start}–${start + len - 1}`;
}

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
