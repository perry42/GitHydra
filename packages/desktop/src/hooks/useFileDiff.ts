// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useRef, useState } from "react";
import type { FileDiffResult } from "@githydra/git-core";
import type { IpcResult } from "../../shared/ipcContract";
import { unwrap } from "./gitHydraClient";

export type FileDiffState =
  | { status: "idle" }
  | { status: "loading"; key: string }
  | { status: "ready"; key: string; result: FileDiffResult }
  | { status: "error"; key: string; message: string };

export interface UseFileDiffResult {
  state: FileDiffState;
  /**
   * Fetch and display a file's diff. `key` identifies which file this load is for (e.g.
   * `"staged:src/a.ts"`) so callers can tell which row is currently selected/highlighted.
   * Stale responses from a superseded `load()` call (rapid file-to-file clicking) are dropped
   * rather than clobbering a newer selection's result.
   */
  load: (key: string, fetcher: () => Promise<IpcResult<FileDiffResult>>) => void;
  /** Deselect — returns to the idle "no file selected" state. */
  clear: () => void;
}

/**
 * FR-29: shared diff-loading state machine used by both the Changes panel (FR-28/FR-30) and the
 * commit DetailPanel (closing FR-13's deferred scope) — both need identical loading/ready/error
 * handling and race-safety, just against different `GitHydraApi` fetchers.
 */
export function useFileDiff(): UseFileDiffResult {
  const [state, setState] = useState<FileDiffState>({ status: "idle" });
  const generationRef = useRef(0);

  const load = useCallback((key: string, fetcher: () => Promise<IpcResult<FileDiffResult>>) => {
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

  const clear = useCallback(() => {
    generationRef.current += 1;
    setState({ status: "idle" });
  }, []);

  return { state, load, clear };
}
