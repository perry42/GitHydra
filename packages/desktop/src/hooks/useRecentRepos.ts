import { useCallback, useState } from "react";

/**
 * specs/repo-list.md Must-have 1: a persisted, most-recently-opened-first list of repo paths,
 * capped at `MAX_RECENT_REPOS` entries (AC3, oldest evicted). Same storage mechanism
 * (`localStorage`) and try/catch-guarded read/write pattern as `useLayoutPreferences.ts` — Must-
 * have 1's "same mechanism as this app's other persisted preferences", deliberately not a new
 * persistence layer. Stored locally only — never synced, no telemetry (Must-haves 1/6, AC7/AC8).
 */

const RECENT_REPOS_KEY = "githydra:recentRepos";
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

/** AC1/AC9: read the persisted list directly — used by `App.tsx` (indirectly, via
 * `useRecentRepos`) to seed initial render state, and exported standalone for tests. */
export function getPersistedRecentRepos(): string[] {
  return readStored();
}

/**
 * Must-have 1: moves `path` to the front if already present, else prepends it — capped at
 * `MAX_RECENT_REPOS`, oldest evicted beyond that (AC3). Returns the new list (already persisted).
 */
export function addPersistedRecentRepo(path: string): string[] {
  const current = readStored();
  const next = [path, ...current.filter((p) => p !== path)].slice(0, MAX_RECENT_REPOS);
  writeStored(next);
  return next;
}

/** AC6: removes exactly one entry (a "not found" recent-list entry's "remove from list" action)
 * — every other entry is left in its existing order. A no-op (returns the list unchanged) if
 * `path` isn't present. */
export function removePersistedRecentRepo(path: string): string[] {
  const next = readStored().filter((p) => p !== path);
  writeStored(next);
  return next;
}

export interface UseRecentReposResult {
  /** MRU-ordered, capped at `MAX_RECENT_REPOS`. Empty array on a fresh profile — every consuming
   * surface must treat that as "render no Recent repositories section at all" (AC9), never an
   * empty-but-visible section. */
  recentRepos: string[];
  addRecentRepo: (path: string) => void;
  removeRecentRepo: (path: string) => void;
}

/**
 * React-state-backed wrapper around the persisted list above — `App.tsx` owns exactly one
 * instance; every surface that reads/mutates the recent list (`EmptyState`, the "+ New tab" and
 * "Open repository…" recent menus) is handed callbacks/derived data from this single instance so
 * they all stay in sync within one session (e.g. removing a stale entry from one surface is
 * immediately reflected on the others).
 */
export function useRecentRepos(): UseRecentReposResult {
  const [recentRepos, setRecentRepos] = useState<string[]>(() => getPersistedRecentRepos());

  const addRecentRepo = useCallback((path: string) => {
    setRecentRepos(addPersistedRecentRepo(path));
  }, []);

  const removeRecentRepo = useCallback((path: string) => {
    setRecentRepos(removePersistedRecentRepo(path));
  }, []);

  return { recentRepos, addRecentRepo, removeRecentRepo };
}
