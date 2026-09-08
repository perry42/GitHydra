// SPDX-License-Identifier: GPL-3.0-or-later
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
  /**
   * specs/amend-last-commit.md FR-156: HEAD's current commit sha, used to fetch its exact
   * subject/body (the same `CommitInfo` shape/`getCommit` call already used to populate
   * DetailPanel) the moment "Amend last commit" is checked. `null` for a bare repository or an
   * unborn HEAD — the checkbox is already disabled then (see `amendDisabledReason`), so this is
   * never read in that state.
   */
  headSha: string | null;
  /**
   * specs/amend-last-commit.md FR-155: disabled reason for the "Amend last commit" checkbox —
   * non-null (unborn HEAD or an operation in progress) disables checking it, with this exact text
   * as its tooltip; `null` means eligible. Computed by the caller from `RepositoryState`
   * (`lib/amendEligibility.ts`) — this hook only consults it as a guard, never re-derives it.
   */
  amendDisabledReason: string | null;
  /**
   * specs/remember-last-selected-file.md FR-218: a tab-activation-restored file to try selecting
   * INSTEAD of the ordinary first-diffable-entry auto-select, consulted at most once per mount (the
   * very first time this hook has fresh, ready `changes` data with nothing selected yet — guarded
   * by `consumedInitialRef` below, independent of `reloadToken`-forced reselects later in the same
   * mount). `App.tsx` remounts `ChangesPanel` via `key={graph.openSequence}` on every real tab
   * activation, but the SAME element can also remount for an unrelated reason (toggling the right
   * rail away and back, same `openSequence`) — `App.tsx`'s own `consumedFileRestoreSeqRef` is what
   * keeps THIS prop itself `null` on that second kind of remount, so this hook's own
   * `consumedInitialRef` guard only ever needs to handle "don't re-consult within one mount," never
   * "was this actually a real activation." Ignored (falls through to the ordinary auto-select) if
   * the referenced file isn't present in that category's list. Optional — omitted/`null` behaves
   * exactly like today (existing callers/tests unaffected).
   */
  initialSelectedFile?: SelectedFile | null;
  /**
   * specs/remember-last-selected-file.md FR-219: called exactly once, the same moment
   * `initialSelectedFile` above is consulted (whether it matched or fell back) — signals the
   * caller (`App.tsx`'s `consumedFileRestoreSeqRef`) that this activation's hint has now been
   * used, so any later remount of a panel within the same tab session is handed `null` instead of
   * re-applying it, without needing to destroy the underlying remembered value itself (which must
   * survive for the next genuine activation, including across a relaunch — AC6).
   */
  onRestoredFileConsumed?: () => void;
  /**
   * specs/remember-last-selected-file.md FR-216: fired on every selection this hook makes — a
   * manual click, the ordinary first-diffable-entry auto-select, or the `initialSelectedFile`
   * restore above — so the caller can keep its own "what's currently selected" live value
   * (`App.tsx`'s `selectedFile` state, read by `useRepoTabs.ts`'s `snapshotActiveTab`) up to date.
   */
  onFileSelected?: (file: SelectedFile) => void;
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

  /** specs/amend-last-commit.md FR-155/156/157: "Amend last commit" checkbox state. */
  amend: boolean;
  /** Checks/unchecks the box — captures/restores the Subject/Body draft (FR-156) and is a no-op
   * (no state change, no git call) when checking while `amendDisabledReason` is non-null. */
  setAmend: (checked: boolean) => void;
  /** FR-158/159: true while the pushed-commit confirmation warning is showing — a confirm-or-cancel
   * step, not a block (mirrors `pendingDiscard`'s shape/naming above). */
  pendingAmendWarning: boolean;
  /** Proceeds with the amend that triggered the warning. */
  confirmAmendWarning: () => void;
  /** Makes no git call and leaves the composer exactly as it was (FR-159). */
  cancelAmendWarning: () => void;
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
  headSha,
  amendDisabledReason,
  initialSelectedFile = null,
  onRestoredFileConsumed,
  onFileSelected,
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

  // specs/amend-last-commit.md FR-155/156/157/158/159
  const [amend, setAmendState] = useState(false);
  const [amendDraft, setAmendDraft] = useState<{ subject: string; body: string } | null>(null);
  const [pendingAmendWarning, setPendingAmendWarning] = useState(false);
  // Invalidates an in-flight `getCommit(headSha)` preload (FR-156) if the box is unchecked (or
  // re-checked) again before it resolves — the same stale-response guard pattern `selectCommit`
  // uses in useRepositoryGraph.ts, just local to this one preload instead of a ref shared across
  // the whole hook.
  const amendGenerationRef = useRef(0);

  const selectFile = useCallback(
    (category: DiffableCategory, entry: WorkingDirectoryFileChange) => {
      setSelected({ category, path: entry.path });
      // specs/remember-last-selected-file.md FR-216: every selection this hook makes — manual,
      // auto-selected, or a restored one below — funnels through here, so this is the single point
      // that keeps the caller's live "currently selected" value in sync.
      onFileSelected?.({ category, path: entry.path });
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
    [api, diffHook, imageDiffHook, onFileSelected],
  );

  // specs/remember-last-selected-file.md FR-218/FR-219: guards the ONE-TIME restore-hint
  // consultation below so it only ever runs once per mount — a later `reloadToken`-forced reselect
  // (the `selected === null` reset just above) must keep falling back to the ordinary
  // first-diffable-entry auto-select every time, exactly like it did before this feature
  // (`detailpanel-auto-diff.md`'s Non-goals precedent for the same same-tab-reselection case).
  const consumedInitialRef = useRef(false);

  // Must-have #2: whenever the panel has fresh, ready working-directory data and nothing is
  // currently selected (initial render, or after a forced reselect below), auto-select the first
  // diffable file in Staged -> Unstaged -> Untracked order — the same load path a manual click
  // uses (AC2). useLayoutEffect (not useEffect) so this lands before the browser paints the
  // transient "ready, nothing selected" frame — DiffView's placeholder is never shown as a
  // visible interstitial frame when there is a diffable file to auto-select (Must-have #3).
  useLayoutEffect(() => {
    if (status !== "ready" || !changes || selected !== null) return;
    if (!consumedInitialRef.current) {
      consumedInitialRef.current = true;
      if (initialSelectedFile) {
        onRestoredFileConsumed?.();
        const match = changes[initialSelectedFile.category].find((e) => e.path === initialSelectedFile.path);
        if (match) {
          selectFile(initialSelectedFile.category, match);
          return;
        }
      }
    }
    const first = firstDiffableEntry(changes);
    if (first) selectFile(first.category, first.entry);
  }, [status, changes, selected, selectFile, initialSelectedFile, onRestoredFileConsumed]);

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
  // FR-157: while amending, a message-only change (nothing staged) is a valid single-commit
  // outcome — the `stagedCount > 0` requirement only applies to a plain (non-amend) commit.
  const canCommit = !isCommitting && subject.trim().length > 0 && (amend || stagedCount > 0);

  // FR-156: checking the box captures the in-progress draft, then preloads HEAD's exact current
  // message over it; unchecking restores that draft verbatim (including empty), discarding
  // whatever HEAD's message overwrote. A no-op if already in the requested state, or if checking
  // while the checkbox should be disabled (defensive — the rendered checkbox is also disabled
  // then, so this only guards a caller that ignores that).
  const setAmend = useCallback(
    (checked: boolean) => {
      if (checked === amend) return;
      if (checked) {
        if (amendDisabledReason) return;
        setAmendDraft({ subject, body });
        setAmendState(true);
        const generation = ++amendGenerationRef.current;
        if (headSha) {
          void (async () => {
            try {
              const commit = unwrap(await api.getCommit(headSha));
              if (generation !== amendGenerationRef.current) return; // unchecked/rechecked meanwhile
              if (commit) {
                setSubject(commit.subject);
                setBody(commit.body);
              }
            } catch {
              // Best-effort preload only — no commit was attempted, so `commitError` (which reports
              // a failed *submit*) isn't the right surface for this; leave Subject/Body as
              // whatever the draft-capture above already set them to.
            }
          })();
        }
      } else {
        amendGenerationRef.current++; // invalidate any still-in-flight preload above
        setAmendState(false);
        if (amendDraft) {
          setSubject(amendDraft.subject);
          setBody(amendDraft.body);
        }
        setAmendDraft(null);
      }
    },
    [amend, amendDisabledReason, amendDraft, api, body, headSha, subject],
  );

  const resetComposer = useCallback(() => {
    setSubject("");
    setBody("");
    setAmendState(false);
    setAmendDraft(null);
    setSelected(null);
    diffHook.clear();
    imageDiffHook.clear();
  }, [diffHook, imageDiffHook]);

  // FR-148/154/160/161: the actual amend git call, shared by the no-warning-needed path and the
  // warning dialog's "confirm" action.
  const performAmend = useCallback(async () => {
    setIsCommitting(true);
    setCommitError(null);
    try {
      unwrap(await api.amendCommit({ subject: subject.trim(), body: body.trim() || undefined }));
      resetComposer();
      onWorkingDirChanged();
      onCommitCreated();
    } catch (err) {
      setCommitError(errorMessage(err));
    } finally {
      setIsCommitting(false);
    }
  }, [api, body, onCommitCreated, onWorkingDirChanged, resetComposer, subject]);

  const confirmAmendWarning = useCallback(() => {
    setPendingAmendWarning(false);
    void performAmend();
  }, [performAmend]);

  const cancelAmendWarning = useCallback(() => {
    setPendingAmendWarning(false);
  }, []);

  const submitCommit = useCallback(() => {
    if (!canCommit) return;

    if (!amend) {
      setIsCommitting(true);
      setCommitError(null);
      void (async () => {
        try {
          unwrap(await api.createCommit({ subject: subject.trim(), body: body.trim() || undefined }));
          resetComposer();
          onWorkingDirChanged();
          onCommitCreated();
        } catch (err) {
          setCommitError(errorMessage(err));
        } finally {
          setIsCommitting(false);
        }
      })();
      return;
    }

    // FR-158/159: an amend first checks (cheap, local-only — no new git-core call beyond
    // `listBranches()`, already used by the Branches panel) whether the current branch looks
    // already-shared (a present, non-gone upstream with nothing of HEAD unpushed yet); if so, a
    // confirm-or-cancel warning is shown before the actual `amendCommit` call. Isn't gated behind
    // `isCommitting` while this check itself runs, since it's read-only and no git-mutating call
    // has happened yet — but the button is still disabled the whole time via `canCommit`'s
    // `!isCommitting` clause below, since `isCommitting` is set for the duration.
    setIsCommitting(true);
    setCommitError(null);
    void (async () => {
      let potentiallyShared = false;
      try {
        const branches = unwrap(await api.listBranches());
        const current = branches.find((b) => b.isCurrent);
        potentiallyShared = Boolean(
          current && current.upstreamName !== null && !current.upstreamGone && current.ahead === 0,
        );
      } catch {
        // This pre-flight check is purely informational (FR-158's warning, not a git-core guard) —
        // if it fails, fail open and proceed with the amend rather than blocking a would-otherwise-
        // succeed amend on an ancillary read. amendCommit's own real checks (FR-149/150/151/152)
        // still apply regardless.
      }
      if (potentiallyShared) {
        setIsCommitting(false);
        setPendingAmendWarning(true);
        return;
      }
      await performAmend();
    })();
  }, [amend, api, canCommit, onCommitCreated, onWorkingDirChanged, performAmend, resetComposer, subject, body]);

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
    amend,
    setAmend,
    pendingAmendWarning,
    confirmAmendWarning,
    cancelAmendWarning,
  };
}
