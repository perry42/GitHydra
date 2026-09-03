import { useCallback, useRef, useState } from "react";
import type { ImageDiffResult } from "@githydra/git-core";
import type { IpcResult } from "../../shared/ipcContract";
import { unwrap } from "./gitHydraClient";

export type ImageDiffState =
  | { status: "idle" }
  | { status: "loading"; key: string }
  | { status: "ready"; key: string; result: ImageDiffResult }
  | { status: "error"; key: string; message: string };

export interface UseImageDiffResult {
  state: ImageDiffState;
  /**
   * Fetch and display an image-eligible file's diff. `key` identifies which file this load is
   * for, same convention as `useFileDiff`'s `load()`. Stale responses from a superseded `load()`
   * call are dropped rather than clobbering a newer selection's result.
   */
  load: (key: string, fetcher: () => Promise<IpcResult<ImageDiffResult>>) => void;
  /** Deselect — returns to the idle "nothing loaded" state. */
  clear: () => void;
}

/**
 * specs/image-diff-preview.md FR-144: image-diff counterpart to `useFileDiff` — identical
 * race-safe loading/ready/error state machine, just against the FR-142 image-diff IPC methods
 * instead of the text-diff ones. Kept as its own hook (rather than genericizing `useFileDiff`)
 * so each caller (`useChangesPanel`, `DetailPanel`) holds two independent instances — one text,
 * one image — and always knows exactly which one is "live" for the current selection: whichever
 * kind a selection resolves to (`isImageEligibleChange`) is loaded, and the OTHER hook is always
 * explicitly `clear()`-ed in the same action, so `DiffView`'s `result`/`imageResult` props are
 * never simultaneously non-null.
 */
export function useImageDiff(): UseImageDiffResult {
  const [state, setState] = useState<ImageDiffState>({ status: "idle" });
  const generationRef = useRef(0);

  const load = useCallback((key: string, fetcher: () => Promise<IpcResult<ImageDiffResult>>) => {
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
