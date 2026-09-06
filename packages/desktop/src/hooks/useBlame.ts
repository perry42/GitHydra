// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useRef, useState } from "react";
import type { BlameResult, CommitInfo } from "@githydra/git-core";
import type { GitHydraApi } from "../../shared/ipcContract";
import { unwrap } from "./gitHydraClient";

/** What `BlamePanel` is currently blaming — a file path plus the revision to blame it as of
 * (`null` blames the current working-tree content, per `getFileBlame`'s own contract). */
export interface BlameTarget {
  path: string;
  revision: string | null;
}

export type BlameContentState =
  | { status: "loading" }
  | { status: "ready"; result: BlameResult }
  | { status: "error"; message: string };

/**
 * FR-124/126/127: fetches `getFileBlame(target.path, target.revision)` whenever the target's
 * identity changes (including FR-133's "re-blame in place against a different revision", which
 * only ever changes `revision` while `path` stays fixed) — race-safe the same way `useFileDiff`/
 * `useStashDiff` already are (a superseded in-flight fetch's response is dropped, never clobbers
 * a newer target's result). Pure read (FR-137/138): never touches HEAD/the index/the working
 * tree, so there's nothing to wire into the app's mutation refresh contract.
 */
export function useBlame(api: GitHydraApi, target: BlameTarget): BlameContentState {
  const [state, setState] = useState<BlameContentState>({ status: "loading" });
  const generationRef = useRef(0);

  useEffect(() => {
    const generation = ++generationRef.current;
    setState({ status: "loading" });
    void (async () => {
      try {
        const result = unwrap(await api.getFileBlame(target.path, target.revision));
        if (generation !== generationRef.current) return;
        setState({ status: "ready", result });
      } catch (err) {
        if (generation !== generationRef.current) return;
        setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
      }
    })();
  }, [api, target.path, target.revision]);

  return state;
}

const FILE_HISTORY_PAGE_SIZE = 30;

export interface UseFileHistoryResult {
  status: "loading" | "ready" | "error";
  commits: CommitInfo[];
  hasMore: boolean;
  isLoadingMore: boolean;
  errorMessage: string | null;
  loadMore: () => void;
}

/**
 * FR-129/FR-133: opens a paged `createFileHistoryReader` reader for `target` (working-tree blame
 * — `revision: null` — is looked up starting from "HEAD", since `getFileHistory` itself always
 * needs a concrete revision to start `git log --follow` from; a historical blame starts from that
 * commit) and exposes its first page immediately plus a `loadMore()` for FR-133's "pages
 * incrementally rather than blocking BlamePanel's open on a full history fetch" (AC13). Opens a
 * fresh reader (closing the previous one) whenever `target.path`/`target.revision` changes,
 * mirroring `useRepositoryGraph`'s own reader-lifecycle discipline.
 */
export function useFileHistory(api: GitHydraApi, target: BlameTarget): UseFileHistoryResult {
  const [status, setStatus] = useState<UseFileHistoryResult["status"]>("loading");
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const readerIdRef = useRef<string | null>(null);
  const generationRef = useRef(0);

  useEffect(() => {
    const generation = ++generationRef.current;
    const previousReaderId = readerIdRef.current;
    readerIdRef.current = null;
    if (previousReaderId) void api.closeReader(previousReaderId).catch(() => {});

    setStatus("loading");
    setCommits([]);
    setHasMore(false);
    setErrorMessage(null);

    void (async () => {
      try {
        const revision = target.revision ?? "HEAD";
        const readerId = unwrap(await api.createFileHistoryReader(revision, target.path));
        if (generation !== generationRef.current) {
          void api.closeReader(readerId).catch(() => {});
          return;
        }
        readerIdRef.current = readerId;
        const page = unwrap(await api.readPage(readerId, FILE_HISTORY_PAGE_SIZE));
        if (generation !== generationRef.current) return;
        setCommits(page.commits);
        setHasMore(!page.done);
        setStatus("ready");
      } catch (err) {
        if (generation !== generationRef.current) return;
        setStatus("error");
        setErrorMessage(err instanceof Error ? err.message : String(err));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, target.path, target.revision]);

  // Close whatever reader is still open when this hook (i.e. BlamePanel) unmounts — mirrors
  // `useRepositoryGraph`'s own `closeCurrentReader` discipline, never leaking a live git child
  // process past the panel that opened it.
  useEffect(() => {
    return () => {
      const readerId = readerIdRef.current;
      if (readerId) void api.closeReader(readerId).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  const loadMore = useCallback(() => {
    const readerId = readerIdRef.current;
    if (!readerId || isLoadingMore || !hasMore) return;
    const generation = generationRef.current;
    setIsLoadingMore(true);
    void (async () => {
      try {
        const page = unwrap(await api.readPage(readerId, FILE_HISTORY_PAGE_SIZE));
        if (generation !== generationRef.current) return;
        setCommits((prev) => prev.concat(page.commits));
        setHasMore(!page.done);
      } catch (err) {
        if (generation !== generationRef.current) return;
        setStatus("error");
        setErrorMessage(err instanceof Error ? err.message : String(err));
      } finally {
        if (generation === generationRef.current) setIsLoadingMore(false);
      }
    })();
  }, [api, hasMore, isLoadingMore]);

  return { status, commits, hasMore, isLoadingMore, errorMessage, loadMore };
}
