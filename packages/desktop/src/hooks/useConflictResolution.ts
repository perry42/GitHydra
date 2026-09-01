import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ConflictedFileInfo,
  ConflictFileDiff,
  ConflictMarkerScanResult,
  ConflictSideLabels,
} from "@githydra/git-core";
import type { GitHydraApi } from "../../shared/ipcContract";
import { unwrap } from "./gitHydraClient";

export interface UseConflictResolutionOptions {
  api: GitHydraApi;
  /** The conflicted file this view is showing — re-fetches everything (FR-62/FR-74: always read
   * fresh, never cached) whenever this changes. */
  path: string;
  /** Called after any successful resolve action (Accept Ours/Theirs, Mark as resolved) so the
   * caller can refresh whatever else shows conflict/working-directory state — the ChangesPanel's
   * own file list, the Toolbar badge, the graph's uncommitted-changes pseudo-node. */
  onResolved: () => void;
  /**
   * specs/self-write-refresh-suppression.md FR-6b: called synchronously right before issuing
   * `acceptConflictSide`/`markConflictResolved` — the same pattern `useBranchActions`/
   * `useStashActions`/`useCherryPickActions` already use around their own mutating calls — so
   * `useRepositoryGraph`'s self-write gate is already open before that call's disk writes (a
   * `checkout --ours/--theirs` followed by `git add`) can trip the fs watcher. Without this, a
   * conflict resolved mid a paused multi-step operation (e.g. a multi-commit cherry-pick) can
   * misfire a spurious "changed outside GitHydra" alert. Optional only so existing/other test
   * harnesses constructing this hook without wiring the full graph don't need to pass a no-op.
   */
  onMutationStart?: () => void;
  /**
   * specs/self-write-refresh-suppression.md FR-6b: called when a resolve action genuinely fails —
   * `onResolved` is deliberately not called then (nothing succeeded to refresh), but the gate
   * `onMutationStart` opened still needs a confirming read to close it. The success path's gate
   * close is the caller's own responsibility inside its `onResolved` callback (mirroring
   * `useBranchActions`'s `onChanged`/`useStashActions`'s `onMutated`, whose own refresh call is
   * what closes the gate there too).
   */
  onMutationSettled?: () => void;
}

export type ConflictResolutionStatus = "loading" | "ready" | "not-found" | "error";
export type ConflictDiffStatus = "idle" | "loading" | "ready" | "error";

export interface UseConflictResolutionResult {
  status: ConflictResolutionStatus;
  loadErrorMessage: string | null;
  /** The matching entry from `getConflictedFiles()`, or `null` while loading/not-found. */
  file: ConflictedFileInfo | null;
  /** FR-67: `getConflictedFiles()`'s live length as of the most recent load — the caller pairs
   * this with `useConflictProgress` for an "N of M resolved" display, never a client-tracked
   * per-file resolved flag. */
  totalConflicts: number;
  /** FR-61: concrete labels for this operation — never render the bare words "ours"/"theirs". */
  sideLabels: ConflictSideLabels | null;
  /** FR-64: three-way comparison content. Never fetched for a submodule gitlink (FR-77: no
   * attempted text diff). */
  diffStatus: ConflictDiffStatus;
  diff: ConflictFileDiff | null;
  diffErrorMessage: string | null;
  /** FR-66: null while loading/not applicable (binary, submodule — no marker-based resolution
   * path exists for either, FR-77/FR-80). */
  markerScan: ConflictMarkerScanResult | null;
  isResolving: boolean;
  actionError: string | null;
  dismissActionError: () => void;
  acceptOurs: () => void;
  acceptTheirs: () => void;
  markResolved: () => void;
  openInExternalEditor: () => void;
  externalEditorError: string | null;
  reload: () => void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * specs/merge-rebase-conflict-resolution.md FR-62 through FR-80: owns one conflicted file's
 * resolution-view data and every resolve action it offers. Nothing here is cached across a
 * `path` change or a successful action beyond what's needed for the current render — every
 * reload re-reads git's actual on-disk/index state (FR-62/FR-74), so a crash or external edit
 * (FR-75) is never papered over by stale in-memory state.
 */
export function useConflictResolution({
  api,
  path,
  onResolved,
  onMutationStart,
  onMutationSettled,
}: UseConflictResolutionOptions): UseConflictResolutionResult {
  const [status, setStatus] = useState<ConflictResolutionStatus>("loading");
  const [loadErrorMessage, setLoadErrorMessage] = useState<string | null>(null);
  const [file, setFile] = useState<ConflictedFileInfo | null>(null);
  const [totalConflicts, setTotalConflicts] = useState(0);
  const [sideLabels, setSideLabels] = useState<ConflictSideLabels | null>(null);
  const [diffStatus, setDiffStatus] = useState<ConflictDiffStatus>("idle");
  const [diff, setDiff] = useState<ConflictFileDiff | null>(null);
  const [diffErrorMessage, setDiffErrorMessage] = useState<string | null>(null);
  const [markerScan, setMarkerScan] = useState<ConflictMarkerScanResult | null>(null);
  const [isResolving, setIsResolving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [externalEditorError, setExternalEditorError] = useState<string | null>(null);

  const generationRef = useRef(0);

  const load = useCallback(() => {
    const generation = ++generationRef.current;
    setStatus("loading");
    setLoadErrorMessage(null);
    setDiffStatus("idle");
    setDiff(null);
    setDiffErrorMessage(null);
    setMarkerScan(null);
    setActionError(null);
    setExternalEditorError(null);
    void (async () => {
      try {
        const [files, labels] = await Promise.all([
          unwrap(await api.getConflictedFiles()),
          unwrap(await api.getConflictSideLabels()),
        ]);
        if (generation !== generationRef.current) return;
        setSideLabels(labels);
        setTotalConflicts((files ?? []).length);
        const match = (files ?? []).find((f) => f.path === path) ?? null;
        if (!match) {
          // Already resolved (or never conflicted) — an explicit state, not an error, since this
          // is the expected outcome right after a successful resolve action.
          setFile(null);
          setStatus("not-found");
          return;
        }
        setFile(match);
        setStatus("ready");

        // FR-77/FR-80: no attempted text diff for a submodule gitlink; binary still gets a diff
        // fetch so DiffView's own "Binary file" state renders (git-core's diff guard, not a
        // client-side skip) rather than this hook inventing a second binary code path.
        if (!match.isSubmodule) {
          setDiffStatus("loading");
          void (async () => {
            try {
              const diffResult = unwrap(await api.getConflictFileDiff(match));
              if (generation !== generationRef.current) return;
              setDiff(diffResult);
              setDiffStatus("ready");
            } catch (err) {
              if (generation !== generationRef.current) return;
              setDiffErrorMessage(errorMessage(err));
              setDiffStatus("error");
            }
          })();
        }

        // FR-66: no marker-based resolution path exists for binary/submodule content — skip the
        // scan entirely rather than running it against content it can't meaningfully apply to.
        if (!match.isSubmodule && !match.isBinary) {
          void (async () => {
            try {
              const scan = unwrap(await api.scanConflictMarkers(path));
              if (generation !== generationRef.current) return;
              setMarkerScan(scan);
            } catch {
              // Best-effort only — the resolve actions below re-check server-side (FR-66) via
              // ConflictMarkersRemainError regardless, so a failed scan here just leaves "Mark as
              // resolved" enabled rather than incorrectly blocked.
            }
          })();
        }
      } catch (err) {
        if (generation !== generationRef.current) return;
        setStatus("error");
        setLoadErrorMessage(errorMessage(err));
      }
    })();
  }, [api, path]);

  useEffect(() => {
    load();
  }, [load]);

  const runAction = useCallback(
    (action: () => Promise<unknown>) => {
      setIsResolving(true);
      setActionError(null);
      // FR-6b: open the self-write gate before the mutating call, not after — the disk write (and
      // therefore the fs watcher's earliest possible fire) happens during `action()`, not once its
      // promise resolves. Runs synchronously (no `await` before it), matching `useBranchActions`.
      onMutationStart?.();
      void (async () => {
        try {
          await action();
          onResolved();
          load();
        } catch (err) {
          setActionError(errorMessage(err));
          onMutationSettled?.(); // FR-6b: still close the gate `onMutationStart` opened above.
        } finally {
          setIsResolving(false);
        }
      })();
    },
    [load, onResolved, onMutationStart, onMutationSettled],
  );

  const acceptOurs = useCallback(() => runAction(() => api.acceptConflictSide(path, "ours").then(unwrap)), [
    api,
    path,
    runAction,
  ]);
  const acceptTheirs = useCallback(() => runAction(() => api.acceptConflictSide(path, "theirs").then(unwrap)), [
    api,
    path,
    runAction,
  ]);
  const markResolved = useCallback(() => runAction(() => api.markConflictResolved(path).then(unwrap)), [
    api,
    path,
    runAction,
  ]);

  const openInExternalEditor = useCallback(() => {
    setExternalEditorError(null);
    void (async () => {
      try {
        unwrap(await api.openPathInExternalEditor(path));
      } catch (err) {
        setExternalEditorError(errorMessage(err));
      }
    })();
  }, [api, path]);

  return {
    status,
    loadErrorMessage,
    file,
    totalConflicts,
    sideLabels,
    diffStatus,
    diff,
    diffErrorMessage,
    markerScan,
    isResolving,
    actionError,
    dismissActionError: () => setActionError(null),
    acceptOurs,
    acceptTheirs,
    markResolved,
    openInExternalEditor,
    externalEditorError,
    reload: load,
  };
}
