// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runInMutationQueue } from "./gitProcess";
import { DiscardFingerprintError, InvalidArgumentError, StaleBatchError } from "./errors";
import { assertPathWithinWorkdir } from "./pathSafety";
import { getWorkingDirectoryChanges } from "./workingDirStatus";
import { getDiscardFingerprint, guardedDestructive, guardedUnlinkUntracked, type DiscardBackupInfo, type DiscardKind } from "./discardGuard";
import type { BulkSkipped } from "./bulkStaging";

/**
 * specs/ignore-and-multiselect.md FR-508/FR-509: bulk discard never acts on a path alone. Every row carries the
 * fingerprint read when the confirmation opened; pass 1 verifies all of them, pass 2 reuses the per-file guard.
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

/** FR-508: pass 1 (verify all, mutate nothing) then pass 2 (per-file guarded discard, stop on first failure). */
export function bulkDiscard(workdir: string, rows: readonly BulkDiscardRow[]): Promise<BulkDiscardResult> {
  if (!Array.isArray(rows)) return Promise.reject(new InvalidArgumentError("Rows must be an array."));
  const seen = new Set<string>();
  const input: BulkDiscardRow[] = [];
  try {
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
    for (const r of input) {
      if (r.section !== "unstaged" && r.section !== "untracked" && r.section !== "mixed") {
        skipped.push({ path: r.path, reason: "Only unstaged, untracked and mixed rows can be discarded." });
        continue;
      }
      if (r.path.endsWith("/")) {
        skipped.push({ path: r.path, reason: "Directories and nested repositories cannot be discarded." });
        continue;
      }
      if (conflicted.has(r.path)) {
        skipped.push({ path: r.path, reason: "Conflicted files cannot be discarded here." });
        continue;
      }
      let fp: string;
      try {
        fp = await getDiscardFingerprint(workdir, r.path, kindOf(r.section));
      } catch (err) {
        if (err instanceof DiscardFingerprintError) {
          skipped.push({ path: r.path, reason: err.reason });
          continue;
        }
        throw err;
      }
      const lst = await fs.lstat(path.resolve(workdir, r.path)).catch(() => null);
      if (lst?.isDirectory()) {
        skipped.push({ path: r.path, reason: "Directories cannot be discarded." });
        continue;
      }
      const stillInCategory = r.section === "untracked" ? untracked.has(r.path) : unstaged.has(r.path);
      if (fp !== r.expectedFingerprint || !stillInCategory) stale.push(r.path);
      else todo.push(r);
    }
    if (stale.length > 0) throw new StaleBatchError(stale);

    const discarded: string[] = [];
    const backups: BulkDiscardResult["backups"] = [];
    let failed: BulkDiscardResult["failed"] = null;
    let i = 0;
    for (; i < todo.length; i++) {
      const r = todo[i]!;
      const opts = { expectedFingerprint: r.expectedFingerprint, onBackup: (backup: DiscardBackupInfo) => backups.push({ path: r.path, backup }) };
      try {
        if (r.section === "untracked") await guardedUnlinkUntracked(workdir, r.path, opts);
        else await guardedDestructive(workdir, r.path, "tracked", ["--literal-pathspecs", "restore", "--", r.path], opts);
        discarded.push(r.path);
      } catch (err) {
        const e = err as { code?: unknown; name?: string; message?: string };
        failed = { path: r.path, code: typeof e.code === "string" ? e.code : (e.name ?? "ERROR"), message: e.message ?? "unknown error" };
        break;
      }
    }
    const notAttempted = failed ? todo.slice(i + 1).map((r) => r.path) : [];
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

/** FR-508: read every row's fingerprint at once when the confirmation opens (reads only). */
export async function getBulkDiscardFingerprints(workdir: string, rows: readonly BulkDiscardCandidate[]): Promise<BulkFingerprintResult[]> {
  const out: BulkFingerprintResult[] = [];
  for (let i = 0; i < rows.length; i += 8) {
    out.push(
      ...(await Promise.all(
        rows.slice(i, i + 8).map(async (r): Promise<BulkFingerprintResult> => {
          try {
            return { path: r.path, section: r.section, expectedFingerprint: await getDiscardFingerprint(workdir, r.path, kindOf(r.section)) };
          } catch (err) {
            return { path: r.path, section: r.section, error: err instanceof DiscardFingerprintError ? err.reason : err instanceof Error ? err.message : "unreadable" };
          }
        }),
      )),
    );
  }
  return out;
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
  const kept = options.rows.filter((r) => options.includeUntracked || r.section !== "untracked");
  const dropped = options.rows.filter((r) => !kept.includes(r));
  return bulkDiscard(workdir, kept).then((res) => ({
    ...res,
    skipped: [...res.skipped, ...dropped.map((r) => ({ path: r.path, reason: "Untracked files were not included." }))],
  }));
}
