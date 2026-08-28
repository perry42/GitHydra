import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { WorkingDirectoryChanges, WorkingDirectoryFileChange } from "@githydra/git-core";
import type { GitHydraApi } from "../../shared/ipcContract";
import { unwrap } from "./gitHydraClient";
import { useFileDiff, type FileDiffState } from "./useFileDiff";
import {
  optimisticStage,
  optimisticStageAll,
  optimisticUnstage,
  optimisticUnstageAll,
} from "../lib/workingDirOptimism";

export type ChangesPanelStatus = "loading" | "ready" | "bare" | "error";

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
  /** Called after any successful stage/unstage/discard/commit so the caller can refresh the
   * cheap working-dir-status counts shown elsewhere (e.g. the Toolbar badge, the graph's
   * uncommitted-changes pseudo-node). */
  onWorkingDirChanged: () => void;
  /** Called after a successful commit only — a new commit now exists, so the caller should
   * refresh whatever shows commit history (FR-32). */
  onCommitCreated: () => void;
  /**
   * Bumped by the caller (App, in response to re-clicking the graph's uncommitted-changes
   * "checkpoint" pseudo-node while the Changes panel is already the visible right panel) to force
   * a fresh reload of working-directory changes and a fresh auto-reselect of the first diffable
   * file, without unmounting the panel (spec's detailpanel-auto-diff Must-have #2/#3). Ignored on
   * the initial mount/first render — the panel already loads once on mount.
   */
  reloadToken?: number;
}

export interface UseChangesPanelResult {
  status: ChangesPanelStatus;
  loadErrorMessage: string | null;
  changes: WorkingDirectoryChanges | null;
  reload: () => void;

  actionError: string | null;
  dismissActionError: () => void;

  selected: SelectedFile | null;
  diff: FileDiffState;
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
 * FR-28/FR-30/FR-31/FR-32: owns the Changes panel's data and every mutating action it offers.
 * `changes` is kept optimistically up to date on stage/unstage (see `lib/workingDirOptimism.ts`)
 * and reverted with `actionError` set on a failed git call (FR-30); a background reconcile
 * (silent re-fetch) follows every successful mutation to correct anything the optimistic
 * transform approximated (e.g. renames — see that module's doc comments).
 */
export function useChangesPanel({
  api,
  onWorkingDirChanged,
  onCommitCreated,
  reloadToken,
}: UseChangesPanelOptions): UseChangesPanelResult {
  const [status, setStatus] = useState<ChangesPanelStatus>("loading");
  const [loadErrorMessage, setLoadErrorMessage] = useState<string | null>(null);
  const [changes, setChanges] = useState<WorkingDirectoryChanges | null>(null);
  const changesRef = useRef<WorkingDirectoryChanges | null>(null);
  changesRef.current = changes;

  const [actionError, setActionError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SelectedFile | null>(null);
  const diffHook = useFileDiff();

  const [pendingDiscard, setPendingDiscard] = useState<PendingDiscard | null>(null);

  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [isCommitting, setIsCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);

  const generationRef = useRef(0);

  const load = useCallback(() => {
    const generation = ++generationRef.current;
    setStatus("loading");
    setLoadErrorMessage(null);
    void (async () => {
      try {
        const result = unwrap(await api.getWorkingDirectoryChanges());
        if (generation !== generationRef.current) return;
        if (result === null) {
          // AC10: a bare repository has no working directory — an explicit state, not an error.
          setStatus("bare");
          setChanges(null);
          return;
        }
        setChanges(result);
        setStatus("ready");
      } catch (err) {
        if (generation !== generationRef.current) return;
        setStatus("error");
        setLoadErrorMessage(errorMessage(err));
      }
    })();
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  /** Silent background refetch after a successful mutation — replaces `changes` without
   * flipping `status` back to "loading" (the optimistic state already looks right). */
  const reconcile = useCallback(async () => {
    const generation = generationRef.current;
    try {
      const result = unwrap(await api.getWorkingDirectoryChanges());
      if (generation !== generationRef.current) return;
      if (result !== null) setChanges(result);
    } catch {
      // Best-effort only — the optimistic state (already applied) stands; the next manual
      // reload/panel reopen will pick up the true state.
    }
  }, [api]);

  const selectFile = useCallback(
    (category: DiffableCategory, entry: WorkingDirectoryFileChange) => {
      setSelected({ category, path: entry.path });
      const key = `${category}:${entry.path}`;
      if (category === "staged") diffHook.load(key, () => api.getStagedFileDiff(entry.path));
      else if (category === "unstaged") diffHook.load(key, () => api.getUnstagedFileDiff(entry.path));
      else diffHook.load(key, () => api.getUntrackedFileDiff(entry.path));
    },
    [api, diffHook],
  );

  // Must-have #2: whenever the panel has fresh, ready working-directory data and nothing is
  // currently selected (initial load, or after a forced reselect below), auto-select the first
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
  // (signaled by the caller bumping `reloadToken`) forces a fresh reload of working-directory
  // changes and clears the current selection so the layout effect above re-auto-selects the
  // first diffable file fresh, without unmounting the panel. Ignored on the initial mount (the
  // panel's own mount effect already loads once).
  const prevReloadTokenRef = useRef(reloadToken);
  useEffect(() => {
    if (reloadToken === undefined || reloadToken === prevReloadTokenRef.current) return;
    prevReloadTokenRef.current = reloadToken;
    setSelected(null);
    diffHook.clear();
    load();
  }, [reloadToken, load, diffHook]);

  const stage = useCallback(
    (entry: WorkingDirectoryFileChange, from: "unstaged" | "untracked") => {
      const snapshot = changesRef.current;
      if (!snapshot) return;
      setActionError(null);
      setChanges(optimisticStage(snapshot, entry.path, from));
      void (async () => {
        try {
          unwrap(await api.stageFile(entry.path));
          await reconcile();
          onWorkingDirChanged();
        } catch (err) {
          setChanges(snapshot);
          setActionError(errorMessage(err));
        }
      })();
    },
    [api, onWorkingDirChanged, reconcile],
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
          await reconcile();
          onWorkingDirChanged();
        } catch (err) {
          setChanges(snapshot);
          setActionError(errorMessage(err));
        }
      })();
    },
    [api, onWorkingDirChanged, reconcile],
  );

  const stageAll = useCallback(() => {
    const snapshot = changesRef.current;
    if (!snapshot) return;
    setActionError(null);
    setChanges(optimisticStageAll(snapshot));
    void (async () => {
      try {
        unwrap(await api.stageAllFiles());
        await reconcile();
        onWorkingDirChanged();
      } catch (err) {
        setChanges(snapshot);
        setActionError(errorMessage(err));
      }
    })();
  }, [api, onWorkingDirChanged, reconcile]);

  const unstageAll = useCallback(() => {
    const snapshot = changesRef.current;
    if (!snapshot) return;
    setActionError(null);
    setChanges(optimisticUnstageAll(snapshot));
    void (async () => {
      try {
        unwrap(await api.unstageAllFiles());
        await reconcile();
        onWorkingDirChanged();
      } catch (err) {
        setChanges(snapshot);
        setActionError(errorMessage(err));
      }
    })();
  }, [api, onWorkingDirChanged, reconcile]);

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
        }
        await reconcile();
        onWorkingDirChanged();
      } catch (err) {
        setActionError(errorMessage(err));
      }
    })();
  }, [api, diffHook, onWorkingDirChanged, pendingDiscard, reconcile, selected]);

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
        await reconcile();
        onWorkingDirChanged();
        onCommitCreated();
      } catch (err) {
        setCommitError(errorMessage(err));
      } finally {
        setIsCommitting(false);
      }
    })();
  }, [api, body, canCommit, diffHook, onCommitCreated, onWorkingDirChanged, reconcile, subject]);

  return {
    status,
    loadErrorMessage,
    changes,
    reload: load,
    actionError,
    dismissActionError: () => setActionError(null),
    selected,
    diff: diffHook.state,
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
