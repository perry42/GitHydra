// SPDX-License-Identifier: GPL-3.0-or-later
import { evictRecords, nextRecordAt, normalizeRecord, RECORD_MAX_REPOS, type CopyMemoryRecord, type MemoryDecision } from "@githydra/git-core";

/**
 * specs/worktree-copy-ignored.md FR-629: one record per repository in guarded localStorage (same pattern as ignorePrefs.ts).
 * Names only, never contents. Nothing here ever throws (storage can be blocked) and nothing is written into the repo or `.git`.
 * The record only pre-ticks; main re-checks everything at copy time (FR-643).
 */
const PREFIX = "githydra:worktreeCopy:";
const KEY_SHAPE = /^[0-9a-f]{64}$/;

const keyOf = (repoKey: string): string => `${PREFIX}${repoKey}`;
const usable = (repoKey: string | null): repoKey is string => repoKey !== null && KEY_SHAPE.test(repoKey);

function getStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Corrupt, wrong-shape or over-cap records read as "no record" (and are dropped when possible). */
export function readCopyRecord(repoKey: string | null, storage: Storage | null = getStorage()): CopyMemoryRecord | null {
  if (!usable(repoKey) || !storage) return null;
  try {
    const raw = storage.getItem(keyOf(repoKey));
    if (raw === null) return null;
    const record = normalizeRecord(JSON.parse(raw));
    if (!record) removeQuietly(storage, keyOf(repoKey));
    return record;
  } catch {
    return null;
  }
}

function removeQuietly(storage: Storage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    /* a stale record is harmless: it is validated again on every read */
  }
}

/** The records of every repository, oldest first by `at`; unreadable ones are dropped on the way. */
function allRecords(storage: Storage): { key: string; at: number }[] {
  const out: { key: string; at: number }[] = [];
  const bad: string[] = [];
  const count = storage.length;
  for (let i = 0; i < count; i++) {
    const key = storage.key(i);
    if (key === null || !key.startsWith(PREFIX)) continue;
    let record: CopyMemoryRecord | null = null;
    try {
      record = normalizeRecord(JSON.parse(storage.getItem(key) ?? "null"));
    } catch {
      record = null;
    }
    if (record) out.push({ key, at: record.at });
    else bad.push(key);
  }
  for (const key of bad) removeQuietly(storage, key);
  return out;
}

/** FR-629 save rule output (from git-core `decide`) applied to storage. `none` touches nothing at all. */
export function applyCopyDecision(repoKey: string | null, decision: MemoryDecision, now: () => number = Date.now, storage: Storage | null = getStorage()): void {
  if (decision.action === "none" || !usable(repoKey) || !storage) return;
  try {
    if (decision.action === "delete") {
      storage.removeItem(keyOf(repoKey));
      return;
    }
    const existing = allRecords(storage);
    const lastAt = existing.reduce((m, e) => Math.max(m, e.at), 0);
    const record: CopyMemoryRecord = { v: 1, paths: decision.paths, at: nextRecordAt(now(), lastAt) };
    storage.setItem(keyOf(repoKey), JSON.stringify(record));
    const others = existing.filter((e) => e.key !== keyOf(repoKey));
    // The record just written is the newest; counting it keeps the cap at 200 including it.
    for (const key of evictRecords([...others, { key: keyOf(repoKey), at: record.at }], RECORD_MAX_REPOS)) removeQuietly(storage, key);
  } catch {
    /* a remembered default is a convenience, never worth failing the create that already happened */
  }
}
