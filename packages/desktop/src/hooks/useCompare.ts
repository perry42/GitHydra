// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import type { ChangedFile, CommitInfo } from "@githydra/git-core";
import type { GitHydraApi } from "../../shared/ipcContract";
import { unwrap } from "./gitHydraClient";

/**
 * specs/compare-commits.md FR-189: which two commits `CompareView` is currently comparing —
 * mirrors `BlameTarget`'s (useBlame.ts) role as a small, App-owned, non-persisted panel-target
 * value. `baseSha` is the graph-order-older commit by default (FR-187, `sortShasInGraphOrder`),
 * but FR-193's Swap control can flip which SHA is labeled which without changing this shape.
 */
export interface CompareTarget {
  baseSha: string;
  targetSha: string;
}

export type CompareDetailState =
  | { status: "loading" }
  | { status: "ready"; base: CommitInfo; target: CommitInfo; files: ChangedFile[] }
  | { status: "error"; message: string };

/**
 * FR-188/190: fetches both endpoint commits' summaries (for the panel header's abbreviated-SHA +
 * first-message-line labels) plus the FR-182 changed-file list between them, whenever `target`'s
 * identity changes (including FR-193's Swap, which flips `baseSha`/`targetSha`, and FR-195's
 * "replace in place" while already open). Race-safe the same way `useBlame`/`useFileDiff` already
 * are — a superseded in-flight fetch's response is dropped, never clobbers a newer target's result.
 */
export function useCompareDetail(api: GitHydraApi, target: CompareTarget): CompareDetailState {
  const [state, setState] = useState<CompareDetailState>({ status: "loading" });
  const generationRef = useRef(0);

  useEffect(() => {
    const generation = ++generationRef.current;
    setState({ status: "loading" });
    void (async () => {
      try {
        const [baseResult, targetResult] = await Promise.all([
          api.getCommit(target.baseSha),
          api.getCommit(target.targetSha),
        ]);
        if (generation !== generationRef.current) return;
        const base = unwrap(baseResult);
        const targetCommit = unwrap(targetResult);
        if (!base || !targetCommit) {
          setState({ status: "error", message: "One or both compared commits could not be found." });
          return;
        }
        const files = unwrap(await api.getChangedFilesBetween(target.baseSha, target.targetSha));
        if (generation !== generationRef.current) return;
        setState({ status: "ready", base, target: targetCommit, files });
      } catch (err) {
        if (generation !== generationRef.current) return;
        setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
      }
    })();
  }, [api, target.baseSha, target.targetSha]);

  return state;
}
