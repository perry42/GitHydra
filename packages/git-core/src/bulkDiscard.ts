// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runInMutationQueue } from "./gitProcess";
import { BULK_DISCARD_ROW_LIMIT, DiscardFingerprintError, InvalidArgumentError, StaleBatchError, TooManyFilesError } from "./errors";
import { assertPathWithinWorkdir, isErrnoException } from "./pathSafety";
import { getWorkingDirectoryChanges } from "./workingDirStatus";
import {
  getDiscardFingerprints,
  guardedBulkDiscard,
  type DiscardBackupInfo,
  type DiscardFingerprintOutcome,
  type DiscardKind,
} from "./discardGuard";
import type { BulkSkipped } from "./bulkStaging";

/**
 * specs/ignore-and-multiselect.md FR-508/FR-509: bulk discard never acts on a path alone. Every row carries the
 * fingerprint read when the confirmation opened; pass 1 verifies all of them, pass 2 re-verifies each worktree file and acts in batched chunks (`guardedBulkDiscard`).
 */

export type BulkDiscardSection = "unstaged" | "untracked" | "mixed";

export interface BulkDiscardRow {
  path: string;
  section: BulkDiscardSection;
  /** From `getDiscardFingerprint` (kind `untracked` for an untracked row, else `tracked`). Required. */
  expectedFingerprint: string;
}

export interface BulkDiscardResult {
  /** `partial` when a file failed midway; `discarded` and `notAttempted` say exactly what happened. */
  status: "complete" | "partial";
  discarded: string[];
  skipped: BulkSkipped[];
  failed: { path: string; code: string; message: string } | null;
  notAttempted: string[];
  /** Safety copies written before each discard (ROADMAP residuals apply unchanged). */
  backups: { path: string; backup: DiscardBackupInfo }[];
}

function kindOf(section: string): DiscardKind {
  return section === "untracked" ? "untracked" : "tracked";
}

/** Node fs errors carry absolute paths in their message; report the errno and the repo-relative name only. */
function describeFailure(err: unknown, relPath: string): { code: string; message: string } {
  if (isErrnoException(err) && typeof (err as { syscall?: unknown }).syscall === "string") {
    return { code: err.code!, message: `${err.code} (${(err as { syscall: string }).syscall}) on "${relPath}"` };
  }
  const e = err as { code?: unknown; name?: string; message?: string };
  return { code: typeof e.code === "string" ? e.code : (e.name ?? "ERROR"), message: e.message ?? "unknown error" };
}

type FpKey = string;
const fpKey = (kind: DiscardKind, p: string): FpKey => `${kind}\0${p}`;

/** One batched read for all rows (per kind); outcomes keyed by kind+path. */
async function fingerprintRows(workdir: string, rows: readonly { path: string; section: string }[]) {
  const out = new Map<FpKey, DiscardFingerprintOutcome>();
  for (const kind of ["tracked", "untracked"] as const) {
    const seen = new Set<string>();
    const items: { path: string; kind: DiscardKind }[] = [];
    for (const r of rows) {
      if (kindOf(r.section) !== kind || seen.has(r.path)) continue;
      seen.add(r.path);
      items.push({ path: r.path, kind });
    }
    if (items.length === 0) continue;
    for (const [p, v] of await getDiscardFingerprints(workdir, items)) out.set(fpKey(kind, p), v);
  }
  return out;
}

function assertRowLimit(count: number): void {
  if (count > BULK_DISCARD_ROW_LIMIT) throw new TooManyFilesError(count, BULK_DISCARD_ROW_LIMIT);
}

/** FR-508: pass 1 (verify all, mutate nothing) then pass 2 (per-file guarded discard, stop on first failure). */
export function bulkDiscard(workdir: string, rows: readonly BulkDiscardRow[]): Promise<BulkDiscardResult> {
  if (!Array.isArray(rows)) return Promise.reject(new InvalidArgumentError("Rows must be an array."));
  const seen = new Set<string>();
  const input: BulkDiscardRow[] = [];
  try {
    assertRowLimit(rows.length);
    for (const r of rows) {
      if (typeof r?.path !== "string") throw new InvalidArgumentError("Each row needs a path.");
      if (typeof r.expectedFingerprint !== "string" || r.expectedFingerprint === "") {
        throw new InvalidArgumentError(`A discard needs the fingerprint read when the user confirmed; "${r.path}" has none. Nothing was changed.`);
      }
      assertPathWithinWorkdir(workdir, r.path.endsWith("/") && r.path.length > 1 ? r.path.slice(0, -1) : r.path);
      if (seen.has(r.path)) continue;
      seen.add(r.path);
      input.push(r);
    }
  } catch (err) {
    return Promise.reject(err);
  }

  return runInMutationQueue(async () => {
    const changes = await getWorkingDirectoryChanges(workdir);
    const conflicted = new Set(changes.conflicted.map((c) => c.path));
    const unstaged = new Set(changes.unstaged.map((c) => c.path));
    const untracked = new Set(changes.untracked.map((c) => c.path));

    const skipped: BulkSkipped[] = [];
    const stale: string[] = [];
    const todo: BulkDiscardRow[] = [];
    const eligible: BulkDiscardRow[] = [];
    for (const r of input) {
      if (r.section !== "unstaged" && r.section !== "untracked" && r.section !== "mixed") {
        skipped.push({ path: r.path, reason: "Only unstaged, untracked and mixed rows can be discarded." });
      } else if (r.path.endsWith("/")) {
        skipped.push({ path: r.path, reason: "Directories and nested repositories cannot be discarded." });
      } else if (conflicted.has(r.path)) {
        skipped.push({ path: r.path, reason: "Conflicted files cannot be discarded here." });
      } else {
        eligible.push(r);
      }
    }
    const outcomes = await fingerprintRows(workdir, eligible);
    for (const r of eligible) {
      const o = outcomes.get(fpKey(kindOf(r.section), r.path))!;
      if (!o.ok) {
        if (o.error instanceof DiscardFingerprintError) skipped.push({ path: r.path, reason: o.error.reason });
        else if (isErrnoException(o.error)) skipped.push({ path: r.path, reason: describeFailure(o.error, r.path).message });
        else throw o.error;
        continue;
      }
      const lst = await fs.lstat(path.resolve(workdir, r.path)).catch(() => null);
      if (lst?.isDirectory()) {
        skipped.push({ path: r.path, reason: "Directories cannot be discarded." });
        continue;
      }
      const stillInCategory = r.section === "untracked" ? untracked.has(r.path) : unstaged.has(r.path);
      if (o.fingerprint !== r.expectedFingerprint || !stillInCategory) stale.push(r.path);
      else todo.push(r);
    }
    if (stale.length > 0) throw new StaleBatchError(stale);

    // FR-508 pass 2: worktrees re-verified per file; git side, safety copies and `git restore` batched per chunk.
    const g = await guardedBulkDiscard(workdir, todo.map((r) => ({ path: r.path, kind: kindOf(r.section), expectedFingerprint: r.expectedFingerprint })));
    const failed: BulkDiscardResult["failed"] = g.failed ? { path: g.failed.path, ...describeFailure(g.failed.error, g.failed.path) } : null;
    const { discarded, backups, notAttempted } = g;
    return { status: failed ? "partial" : "complete", discarded, skipped, failed, notAttempted, backups } as BulkDiscardResult;
  });
}

export interface BulkDiscardCandidate {
  path: string;
  section: BulkDiscardSection;
}

export type BulkFingerprintResult =
  | { path: string; section: BulkDiscardSection; expectedFingerprint: string }
  | { path: string; section: BulkDiscardSection; error: string };

/** FR-508: read every row's fingerprint at once when the confirmation opens (reads only; at most `BULK_DISCARD_ROW_LIMIT` rows). */
export async function getBulkDiscardFingerprints(workdir: string, rows: readonly BulkDiscardCandidate[]): Promise<BulkFingerprintResult[]> {
  assertRowLimit(rows.length);
  const outcomes = await fingerprintRows(workdir, rows);
  return rows.map((r): BulkFingerprintResult => {
    const o = outcomes.get(fpKey(kindOf(r.section), r.path))!;
    if (o.ok) return { path: r.path, section: r.section, expectedFingerprint: o.fingerprint };
    const e = o.error;
    return { path: r.path, section: r.section, error: e instanceof DiscardFingerprintError ? e.reason : isErrnoException(e) ? describeFailure(e, r.path).message : e instanceof Error ? e.message : "unreadable" };
  });
}

export interface DiscardAllPlan {
  /** Unstaged and mixed rows, each with its fingerprint. */
  tracked: BulkDiscardRow[];
  /** Untracked regular files, each with its fingerprint; only discarded when the user ticks the checkbox (D7). */
  untracked: BulkDiscardRow[];
  /** Directories, nested repos, conflicted paths and rows that could not be fingerprinted. */
  skipped: BulkSkipped[];
  counts: { trackedReset: number; untrackedDeleted: number };
}

/** FR-509: snapshot of every eligible row with fingerprints for the confirmation; mutates nothing. */
export async function planDiscardAll(workdir: string): Promise<DiscardAllPlan> {
  const changes = await getWorkingDirectoryChanges(workdir);
  const staged = new Set(changes.staged.map((c) => c.path));
  const skipped: BulkSkipped[] = changes.conflicted.map((c) => ({ path: c.path, reason: "Conflicted files cannot be discarded here." }));
  const cands: BulkDiscardCandidate[] = [];
  const seen = new Set<string>();
  for (const c of changes.unstaged) {
    if (seen.has(c.path)) continue;
    seen.add(c.path);
    cands.push({ path: c.path, section: staged.has(c.path) ? "mixed" : "unstaged" });
  }
  for (const c of changes.untracked) {
    if (c.path.endsWith("/")) skipped.push({ path: c.path, reason: "Nested repositories cannot be discarded." });
    else cands.push({ path: c.path, section: "untracked" });
  }
  assertRowLimit(cands.length);
  const tracked: BulkDiscardRow[] = [];
  const untracked: BulkDiscardRow[] = [];
  for (const f of await getBulkDiscardFingerprints(workdir, cands)) {
    if ("error" in f) {
      skipped.push({ path: f.path, reason: f.error });
      continue;
    }
    (f.section === "untracked" ? untracked : tracked).push(f);
  }
  return { tracked, untracked, skipped, counts: { trackedReset: tracked.length, untrackedDeleted: untracked.length } };
}

/**
 * FR-509: same two-pass flow over the confirmed snapshot; untracked rows run only when `includeUntracked` is true
 * (D7). Rows outside the snapshot are never touched, and nothing here runs a whole-tree reset or clean.
 */
export function discardAllChanges(workdir: string, options: { rows: readonly BulkDiscardRow[]; includeUntracked: boolean }): Promise<BulkDiscardResult> {
  if (!Array.isArray(options?.rows)) return Promise.reject(new InvalidArgumentError("Rows must be an array."));
  if (options.rows.length > BULK_DISCARD_ROW_LIMIT) return Promise.reject(new TooManyFilesError(options.rows.length, BULK_DISCARD_ROW_LIMIT));
  const kept = options.rows.filter((r) => options.includeUntracked || r.section !== "untracked");
  const keptSet = new Set(kept);
  const dropped = options.rows.filter((r) => !keptSet.has(r));
  return bulkDiscard(workdir, kept).then((res) => ({
    ...res,
    skipped: [...res.skipped, ...dropped.map((r) => ({ path: r.path, reason: "Untracked files were not included." }))],
  }));
}
