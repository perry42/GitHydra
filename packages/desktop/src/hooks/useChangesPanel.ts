import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { WorkingDirectoryChanges, WorkingDirectoryFileChange } from "@githydra/git-core";
import type { GitHydraApi } from "../../shared/ipcContract";
import { unwrap } from "./gitHydraClient";
import { useFileDiff, type FileDiffState } from "./useFileDiff";
import { useImageDiff, type ImageDiffState } from "./useImageDiff";
import { isImageEligibleChange } from "../lib/imageDiffEligibility";
import {
  optimisticStage,
  optimisticStageAll,
  optimisticUnstage,
  optimisticUnstageAll,
} from "../lib/workingDirOptimism";

/**
 * ROADMAP.md tech-debt fix ("redundant working-dir-status fetch"): only two reachable states now
 * that this hook no longer performs its own `getWorkingDirectoryChanges()` fetch (see the
 * `changes` option's doc comment) — there is nothing left for this hook to fail *at* independently,
 * so the former `"loading"`/`"error"` states (and their own Retry button) are gone along with the
 * fetch they were reporting on. A failure fetching the shared data is now `useRepositoryGraph`'s
 * concern (surfaces as `graph.status === "error"`, same as any other repo-open read failing today).
 */
export type ChangesPanelStatus = "ready" | "bare";

/** A diffable working-directory file category — Conflicted is deliberately excluded (FR-27:
 * listed only, no plain stage/unstage/diff control offered here). */
export type DiffableCategory = "staged" | "unstaged" | "untracked";

export interface SelectedFile {
  category: DiffableCategory;
  path: string;
}

export interface PendingDiscard {
  /** Which destructive method to call: a tracked file's working-tree changes, or an untracked
   * file's removal — kept as separate, explicitly-named categories per FR-24. */
  category: "unstaged" | "untracked";
  path: string;
}

export interface UseChangesPanelOptions {
  api: GitHydraApi;
  /**
   * ROADMAP.md tech-debt fix: the current working-directory changes, fetched and owned by
   * `useRepositoryGraph` (the single spawner of the underlying git status read — see that hook's
   * `getWorkingDirectoryChangesWithRetry` doc comment) and threaded down through `ChangesPanel`.
   * This hook keeps its own local "overlay" copy (seeded from, and re-synced to, this value — see
   * the hook body) so stage/unstage/discard/commit can still update the UI optimistically before
   * their git call resolves and revert on failure, exactly as before; it just never fetches this
   * data itself. `null` means a bare repository (no working directory) — by the time a caller
   * renders this hook, `graph.status === "ready"` already guarantees the initial fetch has
   * resolved, so `null` here is never "not loaded yet."
   */
  changes: WorkingDirectoryChanges | null;
  /** Called after any successful stage/unstage/discard/commit so the caller can refresh the
   * shared working-dir data (which also flows back into this hook's own `changes` option) —
   * e.g. the Toolbar badge, the graph's uncommitted-changes pseudo-node, and this panel's own
   * eventual-consistency correction for anything the optimistic overlay only approximated (e.g.
   * renames — see `lib/workingDirOptimism.ts`). */
  onWorkingDirChanged: () => void;
  /** Called after a successful commit only — a new commit now exists, so the caller should
   * refresh whatever shows commit history (FR-32). */
  onCommitCreated: () => void;
  /**
   * Bumped by the caller (App, in response to re-clicking the graph's uncommitted-changes
   * "checkpoint" pseudo-node while the Changes panel is already the visible right panel) to force
   * a fresh auto-reselect of the first diffable file, without unmounting the panel (spec's
   * detailpanel-auto-diff Must-have #2/#3). Data freshness itself is the caller's responsibility —
   * `App.tsx`'s handler for this also triggers `useRepositoryGraph`'s shared refresh, the same
   * single fetch path every other mutation uses. Ignored on the initial mount/first render — the
   * panel already reflects `changes` from its very first render.
   */
  reloadToken?: number;
}

export interface UseChangesPanelResult {
  status: ChangesPanelStatus;
  changes: WorkingDirectoryChanges | null;

  actionError: string | null;
  dismissActionError: () => void;

  selected: SelectedFile | null;
  diff: FileDiffState;
  /** specs/image-diff-preview.md FR-144: populated instead of `diff` when the selected file is
   * image-eligible (`isImageEligibleChange`) — at most one of `diff`/`imageDiff` is ever non-idle
   * at a time, since `selectFile` always clears whichever one it isn't loading. */
  imageDiff: ImageDiffState;
  selectFile: (category: DiffableCategory, entry: WorkingDirectoryFileChange) => void;

  stage: (entry: WorkingDirectoryFileChange, from: "unstaged" | "untracked") => void;
  unstage: (entry: WorkingDirectoryFileChange) => void;
  stageAll: () => void;
  unstageAll: () => void;

  pendingDiscard: PendingDiscard | null;
  requestDiscard: (category: "unstaged" | "untracked", path: string) => void;
  confirmDiscard: () => void;
  cancelDiscard: () => void;

  subject: string;
  setSubject: (value: string) => void;
  body: string;
  setBody: (value: string) => void;
  isCommitting: boolean;
  commitError: string | null;
  canCommit: boolean;
  submitCommit: () => void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Must-have #2: first diffable entry in Staged -> Unstaged -> Untracked order (Conflicted is
 * never diffable — FR-27). `null` when nothing in those three sections is diffable, including
 * when the working directory has only Conflicted entries (Must-have #4/#5's "no diff" case). */
function firstDiffableEntry(
  changes: WorkingDirectoryChanges,
): { category: DiffableCategory; entry: WorkingDirectoryFileChange } | null {
  if (changes.staged.length > 0) return { category: "staged", entry: changes.staged[0]! };
  if (changes.unstaged.length > 0) return { category: "unstaged", entry: changes.unstaged[0]! };
  if (changes.untracked.length > 0) return { category: "untracked", entry: changes.untracked[0]! };
  return null;
}

/**
 * FR-28/FR-30/FR-31/FR-32: owns the Changes panel's local UI state (selection, diff, discard
 * confirmation, commit composer) and every mutating action it offers. The underlying working-dir
 * data itself (`options.changes`) is owned by `useRepositoryGraph`, not this hook — see the
 * `changes` option's doc comment for why (ROADMAP.md tech-debt fix). `changes` returned here is a
 * local "overlay" copy: seeded from `options.changes`, optimistically transformed in place by
 * stage/unstage (see `lib/workingDirOptimism.ts`) so the UI updates instantly instead of waiting on
 * the round trip, reverted to its pre-action snapshot on a failed git call (FR-30), and re-synced
 * to `options.changes` whenever that shared value changes (the caller's own follow-up fetch,
 * triggered by this hook's `onWorkingDirChanged()` call on success, silently corrects anything the
 * optimistic transform only approximated — e.g. renames).
 */
export function useChangesPanel({
  api,
  changes: sharedChanges,
  onWorkingDirChanged,
  onCommitCreated,
  reloadToken,
}: UseChangesPanelOptions): UseChangesPanelResult {
  const [changes, setChanges] = useState<WorkingDirectoryChanges | null>(sharedChanges);
  const changesRef = useRef<WorkingDirectoryChanges | null>(changes);
  changesRef.current = changes;

  // Re-sync the local overlay whenever the shared, graph-owned data changes — this is this hook's
  // equivalent of the old `reconcile()` background refetch, just driven by a prop update instead
  // of a fetch this hook performs itself.
  useEffect(() => {
    setChanges(sharedChanges);
  }, [sharedChanges]);

  const status: ChangesPanelStatus = changes === null ? "bare" : "ready";

  const [actionError, setActionError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SelectedFile | null>(null);
  const diffHook = useFileDiff();
  const imageDiffHook = useImageDiff();

  const [pendingDiscard, setPendingDiscard] = useState<PendingDiscard | null>(null);

  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [isCommitting, setIsCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);

  const selectFile = useCallback(
    (category: DiffableCategory, entry: WorkingDirectoryFileChange) => {
      setSelected({ category, path: entry.path });
      const key = `${category}:${entry.path}`;
      // specs/image-diff-preview.md FR-144: an image-eligible file (extension check only, FR-139
      // — either side's extension qualifying is enough for a rename) takes the image-preview IPC
      // path instead of the text-diff loader; the other hook is always explicitly cleared so
      // DiffView's `result`/`imageResult` props are never simultaneously non-null.
      if (isImageEligibleChange(entry.path, entry.oldPath)) {
        diffHook.clear();
        if (category === "staged") imageDiffHook.load(key, () => api.getStagedImageDiff(entry.path));
        else if (category === "unstaged") imageDiffHook.load(key, () => api.getUnstagedImageDiff(entry.path));
        else imageDiffHook.load(key, () => api.getUntrackedImageDiff(entry.path));
        return;
      }
      imageDiffHook.clear();
      if (category === "staged") diffHook.load(key, () => api.getStagedFileDiff(entry.path));
      else if (category === "unstaged") diffHook.load(key, () => api.getUnstagedFileDiff(entry.path));
      else diffHook.load(key, () => api.getUntrackedFileDiff(entry.path));
    },
    [api, diffHook, imageDiffHook],
  );

  // Must-have #2: whenever the panel has fresh, ready working-directory data and nothing is
  // currently selected (initial render, or after a forced reselect below), auto-select the first
  // diffable file in Staged -> Unstaged -> Untracked order — the same load path a manual click
  // uses (AC2). useLayoutEffect (not useEffect) so this lands before the browser paints the
  // transient "ready, nothing selected" frame — DiffView's placeholder is never shown as a
  // visible interstitial frame when there is a diffable file to auto-select (Must-have #3).
  useLayoutEffect(() => {
    if (status !== "ready" || !changes || selected !== null) return;
    const first = firstDiffableEntry(changes);
    if (first) selectFile(first.category, first.entry);
  }, [status, changes, selected, selectFile]);

  // Must-have #2/#3: re-clicking the checkpoint node while the Changes panel is already open
  // (signaled by the caller bumping `reloadToken`) clears the current selection so the layout
  // effect above re-auto-selects the first diffable file fresh, without unmounting the panel.
  // Ignored on the initial mount. Data freshness itself is the caller's responsibility (see
  // `reloadToken`'s own doc comment) — this hook only owns re-selecting against whatever `changes`
  // is current at the moment it's called.
  const prevReloadTokenRef = useRef(reloadToken);
  useEffect(() => {
    if (reloadToken === undefined || reloadToken === prevReloadTokenRef.current) return;
    prevReloadTokenRef.current = reloadToken;
    setSelected(null);
    diffHook.clear();
    imageDiffHook.clear();
  }, [reloadToken, diffHook, imageDiffHook]);

  const stage = useCallback(
    (entry: WorkingDirectoryFileChange, from: "unstaged" | "untracked") => {
      const snapshot = changesRef.current;
      if (!snapshot) return;
      setActionError(null);
      setChanges(optimisticStage(snapshot, entry.path, from));
      void (async () => {
        try {
          unwrap(await api.stageFile(entry.path));
          onWorkingDirChanged();
        } catch (err) {
          setChanges(snapshot);
          setActionError(errorMessage(err));
        }
      })();
    },
    [api, onWorkingDirChanged],
  );

  const unstage = useCallback(
    (entry: WorkingDirectoryFileChange) => {
      const snapshot = changesRef.current;
      if (!snapshot) return;
      setActionError(null);
      setChanges(optimisticUnstage(snapshot, entry.path));
      void (async () => {
        try {
          unwrap(await api.unstageFile(entry.path));
          onWorkingDirChanged();
        } catch (err) {
          setChanges(snapshot);
          setActionError(errorMessage(err));
        }
      })();
    },
    [api, onWorkingDirChanged],
  );

  const stageAll = useCallback(() => {
    const snapshot = changesRef.current;
    if (!snapshot) return;
    setActionError(null);
    setChanges(optimisticStageAll(snapshot));
    void (async () => {
      try {
        unwrap(await api.stageAllFiles());
        onWorkingDirChanged();
      } catch (err) {
        setChanges(snapshot);
        setActionError(errorMessage(err));
      }
    })();
  }, [api, onWorkingDirChanged]);

  const unstageAll = useCallback(() => {
    const snapshot = changesRef.current;
    if (!snapshot) return;
    setActionError(null);
    setChanges(optimisticUnstageAll(snapshot));
    void (async () => {
      try {
        unwrap(await api.unstageAllFiles());
        onWorkingDirChanged();
      } catch (err) {
        setChanges(snapshot);
        setActionError(errorMessage(err));
      }
    })();
  }, [api, onWorkingDirChanged]);

  const requestDiscard = useCallback((category: "unstaged" | "untracked", path: string) => {
    setPendingDiscard({ category, path });
  }, []);

  const cancelDiscard = useCallback(() => setPendingDiscard(null), []);

  const confirmDiscard = useCallback(() => {
    const pending = pendingDiscard;
    if (!pending) return;
    setPendingDiscard(null);
    setActionError(null);
    void (async () => {
      try {
        if (pending.category === "unstaged") {
          unwrap(await api.discardTrackedFileChanges(pending.path));
        } else {
          unwrap(await api.discardUntrackedFile(pending.path));
        }
        if (selected?.path === pending.path && selected.category !== "staged") {
          setSelected(null);
          diffHook.clear();
          imageDiffHook.clear();
        }
        onWorkingDirChanged();
      } catch (err) {
        setActionError(errorMessage(err));
      }
    })();
  }, [api, diffHook, imageDiffHook, onWorkingDirChanged, pendingDiscard, selected]);

  const stagedCount = changes?.staged.length ?? 0;
  const canCommit = !isCommitting && subject.trim().length > 0 && stagedCount > 0;

  const submitCommit = useCallback(() => {
    if (!canCommit) return;
    setIsCommitting(true);
    setCommitError(null);
    void (async () => {
      try {
        unwrap(await api.createCommit({ subject: subject.trim(), body: body.trim() || undefined }));
        setSubject("");
        setBody("");
        setSelected(null);
        diffHook.clear();
        imageDiffHook.clear();
        onWorkingDirChanged();
        onCommitCreated();
      } catch (err) {
        setCommitError(errorMessage(err));
      } finally {
        setIsCommitting(false);
      }
    })();
  }, [api, body, canCommit, diffHook, imageDiffHook, onCommitCreated, onWorkingDirChanged, subject]);

  return {
    status,
    changes,
    actionError,
    dismissActionError: () => setActionError(null),
    selected,
    diff: diffHook.state,
    imageDiff: imageDiffHook.state,
    selectFile,
    stage,
    unstage,
    stageAll,
    unstageAll,
    pendingDiscard,
    requestDiscard,
    confirmDiscard,
    cancelDiscard,
    subject,
    setSubject,
    body,
    setBody,
    isCommitting,
    commitError,
    canCommit,
    submitCommit,
  };
}
