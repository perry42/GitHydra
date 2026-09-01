import { useCallback, useEffect, useRef, useState } from "react";
import type { StashInfo } from "@githydra/git-core";
import type { GitHydraApi } from "../../shared/ipcContract";
import { unwrap } from "./gitHydraClient";

export type StashListStatus = "loading" | "ready" | "bare" | "error";

export interface UseStashListOptions {
  api: GitHydraApi;
  /**
   * Bumped by the caller (App) after any successful create/apply/pop/drop — regardless of which
   * surface triggered it — so this panel's list stays correct without a direct hook reference
   * (same `reloadToken` convention `useBranchList`/`useChangesPanel` already establish). Also
   * bumped after the ordinary external-change alert (FR-91/AC7) is acknowledged.
   */
  reloadToken?: number;
}

export interface UseStashListResult {
  status: StashListStatus;
  errorMessage: string | null;
  /** FR-81: `stash@{0}`-first order, exactly as `listStashes()` returns it. Empty (never `null`)
   * once `status` is `"ready"` — bare repos get their own `"bare"` status instead. */
  stashes: StashInfo[];
  reload: () => void;
}

/**
 * FR-81/FR-94: fetches every stash from `listStashes()`. Read fresh on every load — no cached
 * authoritative copy, matching git-core's own convention for this data.
 */
export function useStashList({ api, reloadToken }: UseStashListOptions): UseStashListResult {
  const [status, setStatus] = useState<StashListStatus>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [stashes, setStashes] = useState<StashInfo[]>([]);
  const generationRef = useRef(0);

  const load = useCallback(() => {
    const generation = ++generationRef.current;
    setStatus("loading");
    setErrorMessage(null);
    void (async () => {
      try {
        const result = unwrap(await api.listStashes());
        if (generation !== generationRef.current) return;
        if (result === null) {
          // FR-82/edge cases: a bare repository has no working directory — an explicit state,
          // matching `getWorkingDirectoryChanges()`'s `null` convention.
          setStatus("bare");
          setStashes([]);
          return;
        }
        setStashes(result);
        setStatus("ready");
      } catch (err) {
        if (generation !== generationRef.current) return;
        setStatus("error");
        setErrorMessage(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  const prevReloadTokenRef = useRef(reloadToken);
  useEffect(() => {
    if (reloadToken === undefined || reloadToken === prevReloadTokenRef.current) return;
    prevReloadTokenRef.current = reloadToken;
    load();
  }, [reloadToken, load]);

  return { status, errorMessage, stashes, reload: load };
}
