import { useCallback, useEffect, useRef, useState } from "react";
import type { StashDiffFile } from "@githydra/git-core";
import type { GitHydraApi } from "../../shared/ipcContract";
import { unwrap } from "./gitHydraClient";

export type StashDiffStatus = "idle" | "loading" | "ready" | "error";

export interface UseStashDiffResult {
  status: StashDiffStatus;
  errorMessage: string | null;
  /** FR-83: every file the selected stash would change, including any captured untracked files —
   * each already carries its own precomputed diff (no separate per-file fetch needed). */
  files: StashDiffFile[];
  selectedPath: string | null;
  selectFile: (path: string) => void;
  reload: () => void;
}

/**
 * FR-83/FR-95: fetches one stash's full diff (`getStashDiff`) whenever `index` changes, and tracks
 * which of its files is currently shown in the diff column — auto-selecting the first file the
 * same way ChangesPanel/DetailPanel auto-select their own first diffable entry. Read-only: never
 * touches the working tree or index (matches `getStashDiff`'s own contract).
 */
export function useStashDiff(api: GitHydraApi, index: number | null): UseStashDiffResult {
  const [status, setStatus] = useState<StashDiffStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [files, setFiles] = useState<StashDiffFile[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const generationRef = useRef(0);

  const load = useCallback(() => {
    if (index === null) {
      generationRef.current += 1;
      setStatus("idle");
      setFiles([]);
      setSelectedPath(null);
      setErrorMessage(null);
      return;
    }
    const generation = ++generationRef.current;
    setStatus("loading");
    setErrorMessage(null);
    setSelectedPath(null);
    void (async () => {
      try {
        const result = unwrap(await api.getStashDiff(index));
        if (generation !== generationRef.current) return;
        if (result === null) {
          // Defensive only — StashPanel never reaches this while `hasWorkdir` is false, but
          // `getStashDiff` is typed to match `listStashes()`'s bare-repo `null` convention.
          setStatus("error");
          setErrorMessage("This repository has no working directory.");
          return;
        }
        setFiles(result.files);
        setSelectedPath(result.files[0]?.path ?? null);
        setStatus("ready");
      } catch (err) {
        if (generation !== generationRef.current) return;
        setStatus("error");
        setErrorMessage(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [api, index]);

  useEffect(() => {
    load();
  }, [load]);

  return {
    status,
    errorMessage,
    files,
    selectedPath,
    selectFile: setSelectedPath,
    reload: load,
  };
}
