// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useRef, useState } from "react";
import type { FileDiffResult } from "@githydra/git-core";
import type { IpcResult } from "../../shared/ipcContract";
import { unwrap } from "./gitHydraClient";

export type FileDiffState<T = FileDiffResult> =
  | { status: "idle" }
  | { status: "loading"; key: string }
  | { status: "ready"; key: string; result: T }
  | { status: "error"; key: string; message: string };

export interface ReloadOptions<T> {
  /** FR-485: skip the state write when the fresh result equals what is already shown. */
  isSame?: (previous: T, next: T) => boolean;
  /** FR-485: a background reload that fails leaves the open diff alone instead of replacing it with an error. */
  keepOnError?: boolean;
}

export interface UseFileDiffResult<T = FileDiffResult> {
  state: FileDiffState<T>;
  /**
   * Fetch and display a file's diff. `key` identifies which file this load is for (e.g.
   * `"staged:src/a.ts"`) so callers can tell which row is currently selected/highlighted.
   * Stale responses from a superseded `load()` call (rapid file-to-file clicking) are dropped
   * rather than clobbering a newer selection's result.
   */
  load: (key: string, fetcher: () => Promise<IpcResult<T>>) => void;
  /**
   * specs/hunk-line-staging.md FR-454: re-fetch the same file's diff WITHOUT passing through the
   * "loading" state, so the rendered hunks (and their scroll position) stay mounted until the new
   * result swaps in. Resolves with the new result, or `null` if superseded or failed (a failure
   * still moves state to "error", like `load`). `isSame` (FR-485) lets a background reload skip the state
   * write when nothing changed, so a live-refresh tick never re-renders the open diff for no reason.
   */
  reload: (
    key: string,
    fetcher: () => Promise<IpcResult<T>>,
    options?: ReloadOptions<T>,
  ) => Promise<T | null>;
  /** The latest state, current even before React re-renders (see the implementation note). */
  getState: () => FileDiffState<T>;
  /** FR-453: synchronous optimistic edit of the ready result (the checkbox tick) before git answers. */
  mutate: (updater: (result: T) => T) => void;
  /** Deselect — returns to the idle "no file selected" state. */
  clear: () => void;
}

/**
 * FR-29: shared diff-loading state machine used by both the Changes panel (FR-28/FR-30) and the
 * commit DetailPanel (closing FR-13's deferred scope) — both need identical loading/ready/error
 * handling and race-safety, just against different `GitHydraApi` fetchers.
 */
export function useFileDiff<T = FileDiffResult>(): UseFileDiffResult<T> {
  const [state, setStateRaw] = useState<FileDiffState<T>>({ status: "idle" });
  // Written in the same call as every state change, so a caller chaining work after an awaited reload reads
  // the NEW state immediately instead of whatever the last render happened to capture.
  const stateRef = useRef<FileDiffState<T>>(state);
  const setState = useCallback((next: FileDiffState<T>) => {
    stateRef.current = next;
    setStateRaw(next);
  }, []);
  const generationRef = useRef(0);

  const load = useCallback((key: string, fetcher: () => Promise<IpcResult<T>>) => {
    const generation = ++generationRef.current;
    setState({ status: "loading", key });
    void (async () => {
      try {
        const result = unwrap(await fetcher());
        if (generation !== generationRef.current) return;
        setState({ status: "ready", key, result });
      } catch (err) {
        if (generation !== generationRef.current) return;
        setState({ status: "error", key, message: err instanceof Error ? err.message : String(err) });
      }
    })();
  }, []);

  const reload = useCallback(
    async (key: string, fetcher: () => Promise<IpcResult<T>>, options?: ReloadOptions<T>) => {
    const generation = ++generationRef.current;
    try {
      const result = unwrap(await fetcher());
      if (generation !== generationRef.current) return null;
      const current = stateRef.current;
      if (options?.isSame && current.status === "ready" && current.key === key && options.isSame(current.result, result)) {
        return result;
      }
      setState({ status: "ready", key, result });
      return result;
    } catch (err) {
      if (generation !== generationRef.current) return null;
      if (options?.keepOnError) return null;
      setState({ status: "error", key, message: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }, []);

  const mutate = useCallback((updater: (result: T) => T) => {
    const prev = stateRef.current;
    if (prev.status === "ready") setState({ ...prev, result: updater(prev.result) });
  }, [setState]);

  const getState = useCallback(() => stateRef.current, []);

  const clear = useCallback(() => {
    generationRef.current += 1;
    setState({ status: "idle" });
  }, []);

  return { state, getState, load, reload, mutate, clear };
}
