// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LocalBranchInfo, RemoteBranchInfo } from "@githydra/git-core";
import type { GitHydraApi } from "../../shared/ipcContract";
import { unwrap } from "./gitHydraClient";

export type BranchListStatus = "loading" | "ready" | "error";

export interface UseBranchListOptions {
  api: GitHydraApi;
  /**
   * Bumped by the caller after any successful create/switch/delete elsewhere (e.g. the graph's
   * ref-chip context menu, or the "Create branch here" flow) so the panel's list stays correct
   * without the caller needing a direct reference into this hook (same `reloadToken` convention
   * `useChangesPanel` already established).
   */
  reloadToken?: number;
}

export interface UseBranchListResult {
  status: BranchListStatus;
  errorMessage: string | null;
  /** FR-50: name-substring search, independent of the graph's ref-filter state (FR-47). */
  search: string;
  setSearch: (value: string) => void;
  localBranches: LocalBranchInfo[];
  remoteBranches: RemoteBranchInfo[];
  /** Remote branches bucketed by remote name (FR-34), in first-seen remote order. */
  remoteBranchesByRemote: Map<string, RemoteBranchInfo[]>;
  reload: () => void;
}

function matches(name: string, search: string): boolean {
  return name.toLowerCase().includes(search.trim().toLowerCase());
}

/**
 * FR-33/34/47/50: fetches local + remote-tracking branches (two batched calls, not N+1 — AC16)
 * and applies the search box's name-substring filter client-side, so typing narrows the list
 * without a re-fetch. Deliberately independent of the graph's `CommitLogFilter`/ref-filter state
 * (FR-47) — this hook only ever reads `listBranches`/`listRemoteBranches`, never the commit log.
 */
export function useBranchList({ api, reloadToken }: UseBranchListOptions): UseBranchListResult {
  const [status, setStatus] = useState<BranchListStatus>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [allLocal, setAllLocal] = useState<LocalBranchInfo[]>([]);
  const [allRemote, setAllRemote] = useState<RemoteBranchInfo[]>([]);
  const generationRef = useRef(0);

  const load = useCallback(() => {
    const generation = ++generationRef.current;
    setStatus("loading");
    setErrorMessage(null);
    void (async () => {
      try {
        const [local, remote] = await Promise.all([api.listBranches(), api.listRemoteBranches()]);
        if (generation !== generationRef.current) return;
        setAllLocal(unwrap(local));
        setAllRemote(unwrap(remote));
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

  const localBranches = useMemo(
    () => (search.trim() ? allLocal.filter((b) => matches(b.name, search)) : allLocal),
    [allLocal, search],
  );
  const remoteBranches = useMemo(
    () =>
      search.trim() ? allRemote.filter((b) => matches(`${b.remoteName}/${b.name}`, search)) : allRemote,
    [allRemote, search],
  );

  const remoteBranchesByRemote = useMemo(() => {
    const map = new Map<string, RemoteBranchInfo[]>();
    for (const branch of remoteBranches) {
      const bucket = map.get(branch.remoteName);
      if (bucket) bucket.push(branch);
      else map.set(branch.remoteName, [branch]);
    }
    return map;
  }, [remoteBranches]);

  return {
    status,
    errorMessage,
    search,
    setSearch,
    localBranches,
    remoteBranches,
    remoteBranchesByRemote,
    reload: load,
  };
}
