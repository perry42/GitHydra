// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useState } from "react";
import { looksLikeSamePath } from "../../shared/pathEquivalence";

/**
 * specs/repo-list.md Must-have 1: a persisted, most-recently-opened-first list of repo paths,
 * capped at `MAX_RECENT_REPOS` entries (AC3, oldest evicted). Same storage mechanism
 * (`localStorage`) and try/catch-guarded read/write pattern as `useLayoutPreferences.ts` — Must-
 * have 1's "same mechanism as this app's other persisted preferences", deliberately not a new
 * persistence layer. Stored locally only — never synced, no telemetry (Must-haves 1/6, AC7/AC8).
 *
 * specs/repo-open-feedback-fixes.md FR-204: the "originally-picked path" divergence map is
 * deliberately a *second*, separate persisted key (`RECENT_REPO_PICKED_PATHS_KEY`) rather than a
 * reshaped `RECENT_REPOS_KEY` entry — `RECENT_REPOS_KEY` stays exactly `string[]` so every existing
 * reader/writer/test of it (including specs/repo-list.md's already-shipped, already-verified
 * AC1-11 coverage) is untouched. This map only ever holds entries where the two paths genuinely
 * diverge (FR-204's "not merely a trivial spelling variant" — see `looksLikeSamePath`); the common
 * non-divergent case (FR-205) simply never gets an entry here, so `EmptyState`/`RecentRepoRow` see
 * nothing new to render for it.
 */

const RECENT_REPOS_KEY = "githydra:recentRepos";
const RECENT_REPO_PICKED_PATHS_KEY = "githydra:recentRepoPickedPaths";
export const MAX_RECENT_REPOS = 20;

/** test-agent/security review: a hand-tampered (or otherwise corrupted) stored array can contain
 * the same path more than once — every write path here (`addPersistedRecentRepo`) already keeps
 * the list unique via this exact "first occurrence wins" filter, but a read of already-on-disk
 * duplicate data bypassed it entirely, producing duplicate React list keys (`key={path}`) in every
 * consuming surface. Harmless (every duplicate row still opens the correct path) but easy to close
 * at the one shared read path instead of leaving it for each caller to notice. */
function uniqueInOrder(list: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of list) {
    if (seen.has(path)) continue;
    seen.add(path);
    result.push(path);
  }
  return result;
}

function readStored(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage?.getItem(RECENT_REPOS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const strings = parsed.filter((v): v is string => typeof v === "string");
    return uniqueInOrder(strings).slice(0, MAX_RECENT_REPOS);
  } catch {
    // Missing/corrupt/unavailable localStorage — degrade to "no recent list" (AC9-equivalent
    // fallback), never throw.
    return [];
  }
}

function writeStored(list: string[]): void {
  try {
    window.localStorage?.setItem(RECENT_REPOS_KEY, JSON.stringify(list));
  } catch {
    // localStorage unavailable — this list just won't persist across restarts.
  }
}

function readPickedPaths(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage?.getItem(RECENT_REPO_PICKED_PATHS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") result[key] = value;
    }
    return result;
  } catch {
    // Missing/corrupt/unavailable localStorage — degrade to "no divergence info" (same
    // never-throw contract `readStored` above already has), never throw.
    return {};
  }
}

function writePickedPaths(map: Record<string, string>): void {
  try {
    window.localStorage?.setItem(RECENT_REPO_PICKED_PATHS_KEY, JSON.stringify(map));
  } catch {
    // localStorage unavailable — this map just won't persist across restarts.
  }
}

/** AC1/AC9: read the persisted list directly — used by `App.tsx` (indirectly, via
 * `useRecentRepos`) to seed initial render state, and exported standalone for tests. */
export function getPersistedRecentRepos(): string[] {
  return readStored();
}

/** FR-204: resolved-path -> originally-picked-path, for every currently-recent entry whose picked
 * path genuinely diverges from its resolved path. Exported standalone for tests, mirroring
 * `getPersistedRecentRepos` above. */
export function getPersistedPickedPaths(): Record<string, string> {
  return readPickedPaths();
}

/**
 * Must-have 1: moves `path` to the front if already present, else prepends it — capped at
 * `MAX_RECENT_REPOS`, oldest evicted beyond that (AC3). Returns the new list (already persisted).
 *
 * specs/repo-open-feedback-fixes.md FR-204/FR-205: `pickedPath` is the original, caller-supplied
 * path this `path` was resolved from. When it's provided and genuinely diverges from `path` (per
 * `looksLikeSamePath` — never a trivial spelling variant), it's recorded in the separate picked-
 * paths map for `getPersistedPickedPaths`/`RecentRepoRow` to surface as persistent secondary
 * context. Omitted, or equal to `path`, clears any previously-recorded divergence for this exact
 * `path` instead — this always reflects the *most recent* open of that resolved repo, so e.g.
 * reopening a repo by its actual root after previously reaching it via a subfolder correctly drops
 * the stale secondary context (FR-205's "no new UI" for the common case).
 */
export function addPersistedRecentRepo(path: string, pickedPath?: string): string[] {
  const current = readStored();
  const next = [path, ...current.filter((p) => p !== path)].slice(0, MAX_RECENT_REPOS);
  writeStored(next);

  const pickedPaths = readPickedPaths();
  if (pickedPath && !looksLikeSamePath(path, pickedPath)) {
    pickedPaths[path] = pickedPath;
  } else {
    delete pickedPaths[path];
  }
  // Keep this map from drifting from the recent list it annotates — e.g. an entry evicted by the
  // MAX_RECENT_REPOS cap above should never leave an orphaned divergence entry behind.
  for (const key of Object.keys(pickedPaths)) {
    if (!next.includes(key)) delete pickedPaths[key];
  }
  writePickedPaths(pickedPaths);

  return next;
}

/** AC6: removes exactly one entry (a "not found" recent-list entry's "remove from list" action)
 * — every other entry is left in its existing order. A no-op (returns the list unchanged) if
 * `path` isn't present. Also drops that path's divergence entry (if any), so a removed-then-later-
 * re-added path never resurfaces stale secondary context from before its removal. */
export function removePersistedRecentRepo(path: string): string[] {
  const next = readStored().filter((p) => p !== path);
  writeStored(next);

  const pickedPaths = readPickedPaths();
  if (path in pickedPaths) {
    delete pickedPaths[path];
    writePickedPaths(pickedPaths);
  }

  return next;
}

export interface UseRecentReposResult {
  /** MRU-ordered, capped at `MAX_RECENT_REPOS`. Empty array on a fresh profile — every consuming
   * surface must treat that as "render no Recent repositories section at all" (AC9), never an
   * empty-but-visible section. */
  recentRepos: string[];
  /** specs/repo-open-feedback-fixes.md FR-204: resolved-path -> originally-picked-path, present
   * only for entries whose picked path genuinely diverges from the resolved path currently shown
   * in `recentRepos` — a separate, path-keyed side-channel (mirroring how `notFoundPath`/
   * `busyPath` already annotate specific `recentRepos` entries) rather than a reshaped
   * `recentRepos` element, so the common non-divergent case (FR-205) needs no new plumbing at all. */
  divergentPickedPaths: Record<string, string>;
  addRecentRepo: (path: string, pickedPath?: string) => void;
  removeRecentRepo: (path: string) => void;
}

/**
 * React-state-backed wrapper around the persisted list above — `App.tsx` owns exactly one
 * instance, handed to `EmptyState` (the landing screen, this list's one reading/mutating surface
 * per the revised IA — see its own doc comment).
 */
export function useRecentRepos(): UseRecentReposResult {
  const [recentRepos, setRecentRepos] = useState<string[]>(() => getPersistedRecentRepos());
  const [divergentPickedPaths, setDivergentPickedPaths] = useState<Record<string, string>>(
    () => getPersistedPickedPaths(),
  );

  const addRecentRepo = useCallback((path: string, pickedPath?: string) => {
    setRecentRepos(addPersistedRecentRepo(path, pickedPath));
    setDivergentPickedPaths(getPersistedPickedPaths());
  }, []);

  const removeRecentRepo = useCallback((path: string) => {
    setRecentRepos(removePersistedRecentRepo(path));
    setDivergentPickedPaths(getPersistedPickedPaths());
  }, []);

  return { recentRepos, divergentPickedPaths, addRecentRepo, removeRecentRepo };
}
