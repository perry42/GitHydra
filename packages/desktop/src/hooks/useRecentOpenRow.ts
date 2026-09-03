import { useCallback, useState } from "react";
import type { RecentOpenResult } from "./useRepoTabs";

export interface UseRecentOpenRowResult {
  /** specs/repo-list.md AC6: the path of the entry currently showing the inline "not found" +
   * "remove from list" state, or `null`. At most one at a time — clicking a different entry (or
   * removing/clearing this one) resets it. */
  notFoundPath: string | null;
  /** The path of the entry whose open attempt is currently in flight, or `null` — lets a caller
   * disable just that one row rather than the whole list while it resolves. */
  busyPath: string | null;
  openRecent: (path: string) => Promise<void>;
  clearNotFound: (path: string) => void;
}

/**
 * specs/repo-list.md AC6: shared "did this recent-list click just fail" bookkeeping for every
 * surface that renders a `RecentRepoRow` list (`EmptyState`, `OpenRepoMenu`) — keeps the
 * busy/not-found local state and its reset rules in exactly one place so the two surfaces can't
 * drift apart on when the inline "not found" state appears or clears.
 */
export function useRecentOpenRow(
  onOpenRecent: (path: string) => Promise<RecentOpenResult>,
  /** Called only when this specific attempt actually resolves into `"opened"` or
   * `"activated-existing"` — never on `"not-found"` or `"cancelled"`. `OpenRepoMenu` uses this to
   * close its popover; `EmptyState` has nothing extra to do (it simply unmounts once `graph.status`
   * leaves `"idle"`), so it omits this. */
  onOpened?: () => void,
): UseRecentOpenRowResult {
  const [notFoundPath, setNotFoundPath] = useState<string | null>(null);
  const [busyPath, setBusyPath] = useState<string | null>(null);

  const openRecent = useCallback(
    async (path: string) => {
      setBusyPath(path);
      setNotFoundPath(null);
      try {
        const result = await onOpenRecent(path);
        if (result === "not-found") {
          setNotFoundPath(path);
          return;
        }
        if (result === "opened" || result === "activated-existing") onOpened?.();
        // "cancelled": nothing to show — treated as a dismissed action, same as a cancelled
        // native-dialog Browse attempt.
      } finally {
        setBusyPath(null);
      }
    },
    [onOpenRecent, onOpened],
  );

  const clearNotFound = useCallback((path: string) => {
    setNotFoundPath((current) => (current === path ? null : current));
  }, []);

  return { notFoundPath, busyPath, openRecent, clearNotFound };
}
