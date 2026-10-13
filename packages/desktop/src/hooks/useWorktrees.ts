// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorktreeList } from "@githydra/git-core";
import type { GitHydraApi } from "../../shared/ipcContract";
import { unwrap } from "./gitHydraClient";
import { EMPTY_WORKTREE_INDEX, indexWorktrees, type WorktreeIndex } from "../lib/worktrees";

export interface UseWorktreesOptions {
  api: GitHydraApi;
  /** False while no repository is open; nothing is read then. */
  enabled: boolean;
  /** Bumped after any change that can add, remove or move a worktree (create, remove, prune, a branch operation, a manual refresh). */
  reloadToken?: number;
  /** Re-read when the repository changes (the app's openSequence), like the branch list. */
  repoKey?: number | string | null;
}

export interface UseWorktreesResult {
  status: "idle" | "loading" | "ready" | "error";
  list: WorktreeList | null;
  errorMessage: string | null;
  index: WorktreeIndex;
  reload: () => void;
}

/**
 * specs/worktrees.md FR-601/FR-606/FR-613: the registered worktrees of the open repository. Reads are cheap and local, so it
 * also re-reads on window focus (a worktree added in a terminal shows up without any polling, using no new timers). A late
 * answer for a previous repository or request never overwrites a newer one.
 */
export function useWorktrees({ api, enabled, reloadToken, repoKey }: UseWorktreesOptions): UseWorktreesResult {
  const [status, setStatus] = useState<UseWorktreesResult["status"]>("idle");
  const [list, setList] = useState<WorktreeList | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const generation = useRef(0);

  const load = useCallback(
    (quiet: boolean) => {
      const mine = ++generation.current;
      if (!quiet) setStatus("loading");
      void (async () => {
        try {
          const next = unwrap(await api.listWorktrees());
          if (mine !== generation.current) return;
          setList(next);
          setErrorMessage(null);
          setStatus("ready");
        } catch (err) {
          if (mine !== generation.current) return;
          setErrorMessage(err instanceof Error ? err.message : String(err));
          setStatus("error");
        }
      })();
    },
    [api],
  );

  useEffect(() => {
    if (!enabled) {
      generation.current++;
      setList(null);
      setStatus("idle");
      return;
    }
    load(false);
  }, [enabled, repoKey, load]);

  const lastToken = useRef(reloadToken);
  useEffect(() => {
    if (reloadToken === undefined || reloadToken === lastToken.current) return;
    lastToken.current = reloadToken;
    if (enabled) load(true);
  }, [reloadToken, enabled, load]);

  useEffect(() => {
    if (!enabled) return;
    const onFocus = () => load(true);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [enabled, load]);

  const index = useMemo(() => (list ? indexWorktrees(list.entries) : EMPTY_WORKTREE_INDEX), [list]);
  const reload = useCallback(() => load(true), [load]);
  return { status, list, errorMessage, index, reload };
}
