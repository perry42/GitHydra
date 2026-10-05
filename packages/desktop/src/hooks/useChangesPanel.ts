// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  CombinedDiffHunk,
  CombinedLineRef,
  FileDiffResult,
  PartialStagingIneligibleReason,
  WorkingDirectoryChanges,
  WorkingDirectoryFileChange,
} from "@githydra/git-core";
import type { GitHydraApi, IpcResult } from "../../shared/ipcContract";
import { unwrap } from "./gitHydraClient";
import { useFileDiff, type FileDiffState } from "./useFileDiff";
import { useMixedFilePaths } from "./useMixedFilePaths";
import { useImageDiff, type ImageDiffState } from "./useImageDiff";
import { summarizePartialFailure, type PartialFailure } from "../lib/partialStagingErrors";
import { isImageEligibleChange } from "../lib/imageDiffEligibility";
import {
  discardableRefs,
  fileStagingSummary,
  hunkChangedRefs,
  hunkStagedState,
  hunkWorktreeRange,
  layoutSignature,
  plural,
  withStaged,
} from "../lib/combinedDiff";
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
  /** The file changed since the dialog opened; confirm stays blocked (security review L4/H1). */
  stale?: boolean;
  /** The confirmed discard is running; Confirm is disabled so a double-click cannot run it twice (security review M2). */
  busy?: boolean;
  /** The guarded discard was refused or failed; shown in the dialog, Confirm stays disabled. */
  error?: string;
}

/** specs/hunk-line-staging.md FR-455/FR-478: a discard request awaiting the user's confirmation.
 * `fingerprint` is captured when the user clicked (what they saw), not at confirm time. */
export interface PendingPartialDiscard {
  path: string;
  fingerprint: string;
  lines: CombinedLineRef[];
  /** 1 when the request is a whole hunk (every changed line of it), else 0 - decides the dialog wording. */
  hunks: number;
  /** Changed-line count (what the confirmation names when `hunks` is 0). */
  count: number;
  /** Working-tree line range of a whole-hunk action, e.g. "27–37". */
  range?: string;
}

/** What the open file's diff is, once loaded: the checkbox (combined) view, or today's separate diff. */
export type TrackedDiff =
  | { mode: "combined"; hunks: CombinedDiffHunk[]; fingerprint: string }
  | { mode: "separate"; reason: PartialStagingIneligibleReason; diff: FileDiffResult };

export interface CombinedDiffView {
  path: string;
  hunks: CombinedDiffHunk[];
  fingerprint: string;
}

type QueuedOp =
  // `layout`: the diff shape the tick was clicked on (specs/live-refresh.md FR-493), compared again when it runs.
  | { kind: "toggle"; path: string; lines: CombinedLineRef[]; target: "stage" | "unstage"; noun: string; layout: string }
  | { kind: "discard"; path: string; fingerprint: string; lines: CombinedLineRef[]; noun: string };

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
  /** Self-write gate (specs/self-write-refresh-suppression.md FR-6b): opened before the commit/amend git call, closed by
   * `onCommitCreated`'s refresh on success or by `onCommitFailed` on failure, so the commit's own ref writes raise no banner. */
  onCommitStart?: () => void;
  onCommitFailed?: () => void;
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
  /**
   * specs/live-refresh.md FR-461: `useRepositoryGraph.workingTreeRevision`. Bumped by every completed working-dir
   * read, so an open diff re-checks its content even when the status list did not change. Omitted: only a changed
   * list triggers the re-check.
   */
  liveRevision?: number;
}

export interface UseChangesPanelResult {
  status: ChangesPanelStatus;
  changes: WorkingDirectoryChanges | null;

  actionError: string | null;
  dismissActionError: () => void;

  selected: SelectedFile | null;
  /** specs/live-refresh.md FR-461: the selected file lost all its changes; the pane says so and waits (no auto-select). */
  selectedGone: boolean;
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

  /**
   * specs/hunk-line-staging.md FR-453/FR-479: non-null when the open Staged/Unstaged file is eligible and
   * its checkbox (combined) diff is on screen. Staged flags are optimistic until git answers.
   */
  combined: CombinedDiffView | null;
  /** FR-481: why the open tracked file fell back to the separate diff; only "ambiguous" gets a note. */
  separateReason: PartialStagingIneligibleReason | null;
  /** FR-453/FR-480: tick or untick `lines` as ONE atomic operation. `noun` names them for the live region. */
  toggleLines: (lines: CombinedLineRef[], target: "stage" | "unstage", noun: string) => void;
  /** FR-477: stage the whole hunk unless it is fully staged, then unstage it. */
  toggleHunk: (hunkIndex: number) => void;
  /** FR-478: open the discard confirmation for the unstaged lines among `lines` (staged ones are dropped). */
  requestDiscardLines: (lines: CombinedLineRef[]) => void;
  requestDiscardHunk: (hunkIndex: number) => void;
  /** True while a toggle/discard (or its diff reload) is in flight. Clicks still queue; this is for aria-busy. */
  partialBusy: boolean;
  /** FR-454: stale-diff explanation after a STALE_DIFF refusal; cleared by the next action/selection. */
  diffNotice: PartialFailure | null;
  /** FR-454: a failed hunk/line action (summary + full stderr); shown beside the diff, not in the file list. */
  partialError: PartialFailure | null;
  dismissPartialError: () => void;
  /** Screen-reader text for the last action's outcome ("Staged 3 lines", failure summary...). */
  partialAnnouncement: string | null;
  /** FR-482: eligible partly staged files; shown once, in Unstaged, with the mixed marker. */
  mixedPaths: ReadonlySet<string>;
  pendingPartialDiscard: PendingPartialDiscard | null;
  confirmPartialDiscard: () => void;
  cancelPartialDiscard: () => void;

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

/** specs/live-refresh.md FR-461: "same" means nothing visible changed, so the open diff keeps its DOM. */
function sameTrackedDiff(a: TrackedDiff, b: TrackedDiff): boolean {
  if (a.mode === "combined") return b.mode === "combined" && a.fingerprint === b.fingerprint;
  return b.mode === "separate" && a.reason === b.reason && JSON.stringify(a.diff) === JSON.stringify(b.diff);
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
  onCommitStart,
  onCommitFailed,
  reloadToken,
  headSha,
  amendDisabledReason,
  initialSelectedFile = null,
  onRestoredFileConsumed,
  onFileSelected,
  liveRevision,
}: UseChangesPanelOptions): UseChangesPanelResult {
  const [changes, setChanges] = useState<WorkingDirectoryChanges | null>(sharedChanges);
  const changesRef = useRef<WorkingDirectoryChanges | null>(changes);
  changesRef.current = changes;
  // Stage/unstage calls in flight: a live read taken mid-call must not undo their optimistic update.
  const ownOpsRef = useRef(0);

  // Re-sync the local overlay whenever the shared, graph-owned data changes — this is this hook's
  // equivalent of the old `reconcile()` background refetch, just driven by a prop update instead
  // of a fetch this hook performs itself. `liveRevision` re-runs it after the op's own follow-up read, even when
  // that read deduped to the same list (specs/live-refresh.md FR-462).
  useEffect(() => {
    if (ownOpsRef.current > 0) return;
    setChanges(sharedChanges);
  }, [sharedChanges, liveRevision]);

  const status: ChangesPanelStatus = changes === null ? "bare" : "ready";

  const [actionError, setActionError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SelectedFile | null>(null);
  const [goneState, setGoneState] = useState(false);
  const diffHook = useFileDiff(); // untracked files only; tracked files go through `trackedHook`
  const trackedHook = useFileDiff<TrackedDiff>();
  const imageDiffHook = useImageDiff();
  const {
    load: loadTracked,
    reload: reloadTrackedState,
    mutate: mutateTracked,
    clear: clearTracked,
    getState: getTrackedState,
  } = trackedHook;
  const { reload: reloadUntrackedState } = diffHook;

  const [pendingDiscard, setPendingDiscard] = useState<PendingDiscard | null>(null);
  const discardBaselineRef = useRef<{ entry: string; fingerprint: string; path: string; category: "unstaged" | "untracked"; kind: "tracked" | "untracked" } | null>(null);
  const discardInFlightRef = useRef(false);
  const [pendingPartialDiscard, setPendingPartialDiscard] = useState<PendingPartialDiscard | null>(null);
  const [partialBusy, setPartialBusy] = useState(false);
  // FR-453: clicks made while an operation is in flight queue behind it (their tick is already optimistic)
  // and run with the fresh fingerprint once the previous one has reloaded.
  const queueRef = useRef<QueuedOp[]>([]);
  // The op whose git call is in flight: a background reload that lands meanwhile must not un-tick it.
  const inflightRef = useRef<QueuedOp | null>(null);
  // A Discard clicked while an operation is still settling opens its confirmation once that has finished,
  // against the settled diff's fingerprint, instead of being dropped.
  const deferredDiscardRef = useRef<(() => void) | null>(null);
  const drainingRef = useRef(false);
  // FR-493: a live reload that arrives while a toggle/range apply is in flight runs once it resolves.
  const liveReloadDeferredRef = useRef(false);
  const syncOpenFileRef = useRef<() => void>(() => {});
  const [diffNotice, setDiffNotice] = useState<PartialFailure | null>(null);
  const [partialError, setPartialError] = useState<PartialFailure | null>(null);
  const [partialAnnouncement, setPartialAnnouncement] = useState<string | null>(null);
  const selectedRef = useRef<SelectedFile | null>(null);
  selectedRef.current = selected;
  const sharedChangesRef = useRef(sharedChanges);
  sharedChangesRef.current = sharedChanges;

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

  // FR-481: a failed combined read falls back to the plain diff (never hide a viewable diff behind it).
  const fetchTracked = useCallback(
    async (category: "staged" | "unstaged", path: string): Promise<IpcResult<TrackedDiff>> => {
      const combined = await api.getCombinedFileDiff(path);
      if (combined.ok && combined.data.mode === "combined") {
        return { ok: true, data: { mode: "combined", hunks: combined.data.hunks, fingerprint: combined.data.fingerprint } };
      }
      const reason: PartialStagingIneligibleReason =
        combined.ok && combined.data.mode === "separate" ? combined.data.reason : "no-changes";
      const separate = await (category === "staged" ? api.getStagedFileDiff(path) : api.getUnstagedFileDiff(path));
      if (!separate.ok) return separate;
      return { ok: true, data: { mode: "separate", reason, diff: separate.data } };
    },
    [api],
  );

  const selectFile = useCallback(
    (category: DiffableCategory, entry: WorkingDirectoryFileChange) => {
      setDiffNotice(null);
      setPartialError(null);
      setPartialAnnouncement(null);
      setGoneState(false);
      setSelected({ category, path: entry.path });
      // specs/remember-last-selected-file.md FR-216: every selection this hook makes — manual,
      // auto-selected, or a restored one below — funnels through here, so this is the single point
      // that keeps the caller's live "currently selected" value in sync.
      onFileSelected?.({ category, path: entry.path });
      queueRef.current = []; // a queued tick never crosses to a different file
      deferredDiscardRef.current = null;
      const key = `${category}:${entry.path}`;
      // specs/image-diff-preview.md FR-144: an image-eligible file (extension check only, FR-139
      // — either side's extension qualifying is enough for a rename) takes the image-preview IPC
      // path instead of the text-diff loader; the other hooks are always explicitly cleared so
      // DiffView's `result`/`imageResult`/`combined` props are never simultaneously non-null.
      if (isImageEligibleChange(entry.path, entry.oldPath)) {
        diffHook.clear();
        clearTracked();
        if (category === "staged") imageDiffHook.load(key, () => api.getStagedImageDiff(entry.path));
        else if (category === "unstaged") imageDiffHook.load(key, () => api.getUnstagedImageDiff(entry.path));
        else imageDiffHook.load(key, () => api.getUntrackedImageDiff(entry.path));
        return;
      }
      imageDiffHook.clear();
      if (category === "untracked") {
        clearTracked();
        diffHook.load(key, () => api.getUntrackedFileDiff(entry.path));
      } else {
        // FR-479/FR-481: ask for the combined (checkbox) view first; anything but "combined" falls back
        // to the separate Staged/Unstaged diff exactly as before.
        diffHook.clear();
        loadTracked(key, () => fetchTracked(category, entry.path));
      }
    },
    [api, diffHook, imageDiffHook, onFileSelected, clearTracked, loadTracked, fetchTracked],
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
    clearTracked();
    imageDiffHook.clear();
  }, [reloadToken, diffHook, imageDiffHook, clearTracked]);

  const stage = useCallback(
    (entry: WorkingDirectoryFileChange, from: "unstaged" | "untracked") => {
      const snapshot = changesRef.current;
      if (!snapshot) return;
      setActionError(null);
      setChanges(optimisticStage(snapshot, entry.path, from));
      ownOpsRef.current += 1;
      void (async () => {
        try {
          unwrap(await api.stageFile(entry.path));
          onWorkingDirChanged();
        } catch (err) {
          setChanges(snapshot);
          setActionError(errorMessage(err));
        } finally {
          ownOpsRef.current -= 1;
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
      ownOpsRef.current += 1;
      void (async () => {
        try {
          unwrap(await api.unstageFile(entry.path));
          onWorkingDirChanged();
        } catch (err) {
          setChanges(snapshot);
          setActionError(errorMessage(err));
        } finally {
          ownOpsRef.current -= 1;
        }
      })();
    },
    [api, onWorkingDirChanged],
  );

  // FR-454/FR-485: reloads the open file's diff in place (no loading flash, so scroll survives). Resolves with
  // the fresh result so a queued follow-up can use its new fingerprint without waiting for a render. A file
  // that is now clean drops the selection; otherwise whatever git says (combined or separate) is shown.
  const reloadTracked = useCallback(
    async (target: SelectedFile, background = false): Promise<TrackedDiff | null> => {
      if (target.category === "untracked") return null;
      const category = target.category;
      const fetcher = async (): Promise<IpcResult<TrackedDiff>> => {
        const r = await fetchTracked(category, target.path);
        if (!r.ok || r.data.mode !== "combined") return r;
        // Ticks clicked while this reload was in flight stay ticked: re-apply them over git's answer.
        let hunks = r.data.hunks;
        const pending = inflightRef.current ? [inflightRef.current, ...queueRef.current] : queueRef.current;
        const layout = layoutSignature(hunks);
        for (const op of pending) {
          // A tick whose rows moved (the file was edited) must not be re-applied to different lines.
          if (op.kind === "toggle" && op.path === target.path && op.layout === layout) {
            hunks = withStaged(hunks, op.lines, op.target === "stage");
          }
        }
        return { ok: true, data: { ...r.data, hunks } };
      };
      const result = await reloadTrackedState(`${category}:${target.path}`, fetcher, {
        isSame: background ? sameTrackedDiff : undefined,
        keepOnError: background,
      });
      const current = selectedRef.current;
      if (!result || current?.path !== target.path || current.category !== target.category) return result;
      const clean =
        result.mode === "combined"
          ? result.hunks.length === 0
          : result.reason === "no-changes" && result.diff.status === "ok" && result.diff.hunks.length === 0;
      if (clean) {
        // FR-461: a live reload never picks another file for the user; the pane says so and waits.
        // An action's own reload keeps the old behaviour (nothing left, so the next file is selected).
        if (background) setGoneState(true);
        else setSelected(null);
        clearTracked();
      }
      return result;
    },
    [clearTracked, fetchTracked, reloadTrackedState],
  );

  // FR-453/FR-454/FR-455: one queue, one worker. Every op carries the fingerprint of the diff it was made
  // against (toggles take the latest one when they run); the combined diff's line indexes do not move when
  // staging changes, so a queued op's refs stay valid across the reloads between them.
  const drain = useCallback(async () => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    setPartialBusy(true);
    try {
      const first = getTrackedState();
      let fingerprint = first.status === "ready" && first.result.mode === "combined" ? first.result.fingerprint : null;
      while (queueRef.current.length > 0) {
        const op = queueRef.current.shift()!;
        const target = selectedRef.current;
        if (!target || target.path !== op.path || fingerprint === null) {
          queueRef.current = [];
          break;
        }
        if (op.kind === "toggle") {
          // FR-493: refuse rather than apply a tick to rows that moved under it.
          const st = getTrackedState();
          if (st.status !== "ready" || st.result.mode !== "combined" || layoutSignature(st.result.hunks) !== op.layout) {
            queueRef.current = [];
            setDiffNotice({
              summary: "The file changed on disk, so nothing was " + (op.target === "stage" ? "staged" : "unstaged") + ".",
              details: "The diff was reloaded to show what is on disk now. Try again; nothing is retried automatically.",
            });
            setPartialAnnouncement("File changed. Diff reloaded; try again.");
            await reloadTracked(target);
            onWorkingDirChanged();
            break;
          }
        }
        const verb = op.kind === "discard" ? "discard" : op.target;
        const past = op.kind === "discard" ? "Discarded" : op.target === "stage" ? "Staged" : "Unstaged";
        setActionError(null);
        setDiffNotice(null);
        setPartialError(null);
        try {
          inflightRef.current = op;
          try {
            if (op.kind === "toggle") unwrap(await api.toggleCombinedLines(op.path, fingerprint, op.lines, op.target));
            else unwrap(await api.discardCombinedLines(op.path, op.fingerprint, op.lines));
          } finally {
            inflightRef.current = null; // git has answered either way: the reload below is the truth
          }
          setPartialAnnouncement(`${past} ${op.noun}`);
          const fresh = await reloadTracked(target);
          fingerprint = fresh?.mode === "combined" ? fresh.fingerprint : null;
          onWorkingDirChanged(); // after the reload, so the list never shows a half-updated state
        } catch (err) {
          queueRef.current = []; // later ticks were built on this one; never apply them on a different base
          // FR-454: STALE_DIFF is a normal race, not an error - nothing changed, show what's true now and
          // let the user try again; never auto-retry. Every other failure shows git's own message.
          if (err instanceof Error && err.name === "StaleDiffError") {
            const done = op.kind === "discard" ? "discarded" : op.target === "stage" ? "staged" : "unstaged";
            const notice = {
              summary: `The file changed on disk, so nothing was ${done}.`,
              details: "The diff was reloaded to show what is on disk now. Try again; nothing is retried automatically.",
            };
            setDiffNotice(notice);
            setPartialAnnouncement(`${notice.summary} Diff reloaded; try again.`);
          } else {
            const failure = summarizePartialFailure(verb, errorMessage(err));
            setPartialError(failure);
            setPartialAnnouncement(failure.summary);
          }
          await reloadTracked(target); // git's truth replaces the optimistic tick (the revert)
          if (queueRef.current.length > 0) {
            // Ticks clicked during the failure handling were built on the failed state: drop them and re-show truth.
            queueRef.current = [];
            await reloadTracked(target);
          }
          onWorkingDirChanged();
          break;
        }
      }
    } finally {
      drainingRef.current = false;
      setPartialBusy(false);
      const deferred = deferredDiscardRef.current;
      deferredDiscardRef.current = null;
      deferred?.();
      if (liveReloadDeferredRef.current) {
        liveReloadDeferredRef.current = false;
        syncOpenFileRef.current();
      }
    }
  }, [api, onWorkingDirChanged, reloadTracked]);

  const currentCombined = (): { path: string; hunks: CombinedDiffHunk[]; fingerprint: string } | null => {
    const sel = selectedRef.current;
    const st = getTrackedState();
    if (!sel || sel.category === "untracked" || st.status !== "ready" || st.result.mode !== "combined") return null;
    return { path: sel.path, hunks: st.result.hunks, fingerprint: st.result.fingerprint };
  };

  const toggleLines = useCallback(
    (lines: CombinedLineRef[], target: "stage" | "unstage", noun: string) => {
      const cur = currentCombined();
      if (!cur || lines.length === 0) return;
      mutateTracked((t) => (t.mode === "combined" ? { ...t, hunks: withStaged(t.hunks, lines, target === "stage") } : t));
      // Announce at click time (optimistic); the result is announced again when git answers. DiffView re-announces repeats.
      setPartialAnnouncement(`${target === "stage" ? "Ticked" : "Unticked"} ${noun}`);
      queueRef.current.push({ kind: "toggle", path: cur.path, lines, target, noun, layout: layoutSignature(cur.hunks) });
      void drain();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drain, mutateTracked],
  );

  const toggleHunk = useCallback(
    (hunkIndex: number) => {
      const cur = currentCombined();
      const hunk = cur?.hunks[hunkIndex];
      if (!cur || !hunk) return;
      toggleLines(hunkChangedRefs(hunk, hunkIndex), hunkStagedState(hunk) === "all" ? "unstage" : "stage", `hunk ${hunkIndex + 1}`);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [toggleLines],
  );

  type DiscardPick = Pick<PendingPartialDiscard, "lines" | "hunks" | "count" | "range">;
  // `pick` is re-run against the settled hunks, so a request made mid-operation reflects the final state.
  const requestPartialDiscard = useCallback((pick: (hunks: CombinedDiffHunk[]) => DiscardPick | null) => {
    if (drainingRef.current) {
      deferredDiscardRef.current = () => requestPartialDiscard(pick);
      return;
    }
    const cur = currentCombined();
    if (!cur) return;
    const picked = pick(cur.hunks);
    if (!picked) return;
    setPendingPartialDiscard({ path: cur.path, fingerprint: cur.fingerprint, ...picked });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const requestDiscardLines = useCallback(
    (lines: CombinedLineRef[]) =>
      requestPartialDiscard((hunks) => {
        const refs = discardableRefs(hunks, lines);
        return refs.length === 0 ? null : { lines: refs, hunks: 0, count: refs.length };
      }),
    [requestPartialDiscard],
  );

  const requestDiscardHunk = useCallback(
    (hunkIndex: number) =>
      requestPartialDiscard((hunks) => {
        const hunk = hunks[hunkIndex];
        if (!hunk) return null;
        const all = hunkChangedRefs(hunk, hunkIndex);
        const refs = discardableRefs(hunks, all);
        if (refs.length === 0) return null;
        const whole = refs.length === all.length;
        return {
          lines: refs,
          hunks: whole ? 1 : 0,
          count: refs.length,
          range: whole ? hunkWorktreeRange(hunk.header) : undefined,
        };
      }),
    [requestPartialDiscard],
  );

  const confirmPartialDiscard = useCallback(() => {
    const pending = pendingPartialDiscard;
    if (!pending) return;
    setPendingPartialDiscard(null);
    queueRef.current.push({
      kind: "discard",
      path: pending.path,
      fingerprint: pending.fingerprint,
      lines: pending.lines,
      noun: pending.hunks > 0 ? "hunk" : plural(pending.count, "line"),
    });
    void drain();
  }, [drain, pendingPartialDiscard]);

  const cancelPartialDiscard = useCallback(() => setPendingPartialDiscard(null), []);

  // specs/live-refresh.md FR-460/FR-461/FR-493 (and hunk-line-staging.md FR-485): after any working-directory read,
  // keep the open file in step with disk. The selection follows its path across sections, a file with no changes
  // left shows "no longer has changes" and waits, and otherwise the diff is re-read and swapped in only when its
  // content differs, so scroll, cursor and DOM survive an unchanged read. Not run mid-apply: it runs when the
  // apply resolves, so a reload can never change which rows a pending toggle hits.
  const goneRef = useRef(false);
  goneRef.current = goneState;
  const syncOpenFile = useCallback(() => {
    const sel = selectedRef.current;
    const shared = sharedChangesRef.current;
    if (!sel || !shared) return;
    if (drainingRef.current) {
      liveReloadDeferredRef.current = true;
      return;
    }
    const entryIn = (category: DiffableCategory) => shared[category].find((e) => e.path === sel.path);
    if (goneRef.current) {
      const back = (["unstaged", "staged", "untracked"] as const).find((c) => entryIn(c));
      if (back) selectFile(back, entryIn(back)!);
      return;
    }
    if (!entryIn(sel.category)) {
      const order: DiffableCategory[] =
        sel.category === "staged" ? ["unstaged", "untracked"] : sel.category === "unstaged" ? ["staged", "untracked"] : ["unstaged", "staged"];
      const moved = order.find((c) => entryIn(c));
      if (!moved) {
        setGoneState(true);
        queueRef.current = [];
        deferredDiscardRef.current = null;
        setPendingPartialDiscard(null);
        clearTracked();
        diffHook.clear();
        imageDiffHook.clear();
        return;
      }
      const entry = entryIn(moved)!;
      if (sel.category === "untracked" || moved === "untracked" || isImageEligibleChange(entry.path, entry.oldPath)) {
        selectFile(moved, entry);
        return;
      }
      const next: SelectedFile = { category: moved, path: sel.path };
      selectedRef.current = next;
      setSelected(next);
      onFileSelected?.(next);
      void reloadTracked(next, true);
      return;
    }
    if (sel.category === "untracked") {
      const st = diffHook.getState();
      if (st.status !== "ready") return;
      void reloadUntrackedState(`untracked:${sel.path}`, () => api.getUntrackedFileDiff(sel.path), {
        isSame: (a, b) => JSON.stringify(a) === JSON.stringify(b),
        keepOnError: true,
      });
      return;
    }
    if (getTrackedState().status === "ready") void reloadTracked(sel, true);
  }, [api, clearTracked, diffHook, getTrackedState, imageDiffHook, onFileSelected, reloadTracked, reloadUntrackedState, selectFile]);
  syncOpenFileRef.current = syncOpenFile;
  useEffect(() => {
    syncOpenFileRef.current();
  }, [sharedChanges, liveRevision]);

  const stageAll = useCallback(() => {
    const snapshot = changesRef.current;
    if (!snapshot) return;
    setActionError(null);
    setChanges(optimisticStageAll(snapshot));
    ownOpsRef.current += 1;
    void (async () => {
      try {
        unwrap(await api.stageAllFiles());
        onWorkingDirChanged();
      } catch (err) {
        setChanges(snapshot);
        setActionError(errorMessage(err));
      } finally {
        ownOpsRef.current -= 1;
      }
    })();
  }, [api, onWorkingDirChanged]);

  const unstageAll = useCallback(() => {
    const snapshot = changesRef.current;
    if (!snapshot) return;
    setActionError(null);
    setChanges(optimisticUnstageAll(snapshot));
    ownOpsRef.current += 1;
    void (async () => {
      try {
        unwrap(await api.unstageAllFiles());
        onWorkingDirChanged();
      } catch (err) {
        setChanges(snapshot);
        setActionError(errorMessage(err));
      } finally {
        ownOpsRef.current -= 1;
      }
    })();
  }, [api, onWorkingDirChanged]);

  // Status-entry signature: category, status, and whether the path is also staged (mixed wording).
  const discardEntrySignature = (c: WorkingDirectoryChanges | null, category: "unstaged" | "untracked", path: string) => {
    const e = c?.[category].find((f) => f.path === path);
    return e ? `${category}|${e.status}|${c?.staged.some((f) => f.path === path) ? "mixed" : "plain"}` : "gone";
  };
  // Security review H1/M1: the baseline is git-core's fingerprint read at click time, passed back verbatim as
  // `expectedFingerprint` so the check happens inside git-core's mutation queue. A failed read opens no dialog.
  const discardRequestSeqRef = useRef(0);
  const requestDiscard = useCallback(
    (category: "unstaged" | "untracked", path: string) => {
      if (discardInFlightRef.current) return;
      discardBaselineRef.current = null;
      // A new request supersedes an open dialog (its baseline is gone); an error for this one then shows on its own.
      setPendingDiscard(null);
      const seq = ++discardRequestSeqRef.current;
      const entry = discardEntrySignature(changesRef.current, category, path);
      void (async () => {
        try {
          const kind = category === "unstaged" ? "tracked" : "untracked";
          const fingerprint = unwrap(await api.getDiscardFingerprint(path, kind));
          if (seq !== discardRequestSeqRef.current) return;
          discardBaselineRef.current = { entry, fingerprint, path, category, kind };
          setActionError(null);
          setPendingDiscard({ category, path, stale: discardEntrySignature(changesRef.current, category, path) !== entry });
        } catch (err) {
          if (seq === discardRequestSeqRef.current) setActionError(errorMessage(err));
        }
      })();
    },
    [api],
  );

  // specs/live-refresh.md: a live refresh can change the file under an open dialog; block the confirm.
  useEffect(() => {
    setPendingDiscard((cur) => {
      const base = discardBaselineRef.current;
      if (!cur || !base || cur.stale) return cur;
      return discardEntrySignature(changes, cur.category, cur.path) === base.entry ? cur : { ...cur, stale: true };
    });
  }, [changes]);

  const cancelDiscard = useCallback(() => {
    discardRequestSeqRef.current += 1;
    discardBaselineRef.current = null;
    setPendingDiscard(null);
  }, []);

  // M2: baseline nulled, in-flight set and token taken synchronously; every later UI step re-checks the token.
  const confirmDiscard = useCallback(() => {
    const pending = pendingDiscard;
    const base = discardBaselineRef.current;
    if (discardInFlightRef.current || !pending || pending.stale || pending.busy || pending.error || !base) return;
    // A stale closure for another file must never use this baseline (security review L-A).
    if (base.path !== pending.path || base.category !== pending.category) return;
    discardInFlightRef.current = true;
    discardBaselineRef.current = null;
    const token = ++discardRequestSeqRef.current;
    setActionError(null);
    setPendingDiscard({ ...pending, busy: true });
    void (async () => {
      try {
        if (discardEntrySignature(changesRef.current, pending.category, pending.path) !== base.entry) {
          if (token === discardRequestSeqRef.current) setPendingDiscard({ ...pending, stale: true });
          return;
        }
        if (pending.category === "unstaged") {
          unwrap(await api.discardTrackedFileChanges(base.path, base.fingerprint));
        } else {
          unwrap(await api.discardUntrackedFile(base.path, base.fingerprint));
        }
        onWorkingDirChanged();
        if (token !== discardRequestSeqRef.current) return;
        setPendingDiscard(null);
        if (selected?.path === pending.path) {
          const st = getTrackedState();
          if (st.status === "ready" && st.result.mode === "combined") {
            // FR-482: a mixed file keeps its staged part, so reload instead of dropping the selection.
            void reloadTracked(selected);
          } else if (selected.category !== "staged") {
            setSelected(null);
            diffHook.clear();
            clearTracked();
            imageDiffHook.clear();
          }
        }
      } catch (err) {
        if (token !== discardRequestSeqRef.current) return;
        if (err instanceof Error && err.name === "StaleDiffError") setPendingDiscard({ ...pending, stale: true });
        else setPendingDiscard({ ...pending, error: errorMessage(err) });
      } finally {
        discardInFlightRef.current = false;
      }
    })();
  }, [api, clearTracked, diffHook, imageDiffHook, onWorkingDirChanged, pendingDiscard, reloadTracked, selected]);

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
    clearTracked();
    imageDiffHook.clear();
  }, [diffHook, imageDiffHook, clearTracked]);

  // FR-148/154/160/161: the actual amend git call, shared by the no-warning-needed path and the
  // warning dialog's "confirm" action.
  const performAmend = useCallback(async () => {
    setIsCommitting(true);
    setCommitError(null);
    onCommitStart?.();
    try {
      unwrap(await api.amendCommit({ subject: subject.trim(), body: body.trim() || undefined }));
      resetComposer();
      onWorkingDirChanged();
      onCommitCreated();
    } catch (err) {
      onCommitFailed?.();
      setCommitError(errorMessage(err));
    } finally {
      setIsCommitting(false);
    }
  }, [api, body, onCommitCreated, onCommitFailed, onCommitStart, onWorkingDirChanged, resetComposer, subject]);

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
        onCommitStart?.();
        try {
          unwrap(await api.createCommit({ subject: subject.trim(), body: body.trim() || undefined }));
          resetComposer();
          onWorkingDirChanged();
          onCommitCreated();
        } catch (err) {
          onCommitFailed?.();
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
  }, [amend, api, canCommit, onCommitCreated, onCommitFailed, onCommitStart, onWorkingDirChanged, performAmend, resetComposer, subject, body]);

  const trackedState = trackedHook.state;
  const combined = useMemo<CombinedDiffView | null>(
    () =>
      selected && trackedState.status === "ready" && trackedState.result.mode === "combined"
        ? { path: selected.path, hunks: trackedState.result.hunks, fingerprint: trackedState.result.fingerprint }
        : null,
    [selected, trackedState],
  );
  const separateReason =
    trackedState.status === "ready" && trackedState.result.mode === "separate" ? trackedState.result.reason : null;
  // Tracked files report loading/error/separate through the same `diff` shape every caller already renders;
  // a combined result reports idle here because it is rendered through `combined` instead.
  const diff = useMemo<FileDiffState>(() => {
    if (trackedState.status === "loading" || trackedState.status === "error") return trackedState;
    if (trackedState.status === "ready") {
      return trackedState.result.mode === "separate"
        ? { status: "ready", key: trackedState.key, result: trackedState.result.diff }
        : { status: "idle" };
    }
    return diffHook.state;
  }, [trackedState, diffHook.state]);

  const mixedKnown = useMemo(() => {
    // An open file git-core already called "separate" splits back into both sections at once (FR-482).
    if (!combined) return selected && selected.category !== "untracked" && separateReason !== null ? { path: selected.path, mixed: false } : null;
    const summary = fileStagingSummary(combined.hunks);
    return { path: combined.path, mixed: summary.anyStaged && summary.anyUnstaged };
  }, [combined, selected, separateReason]);
  const mixedPaths = useMixedFilePaths(api, changes, mixedKnown);

  return {
    status,
    changes,
    actionError,
    dismissActionError: () => setActionError(null),
    selected,
    selectedGone: goneState && selected !== null,
    diff,
    imageDiff: imageDiffHook.state,
    selectFile,
    stage,
    unstage,
    stageAll,
    unstageAll,
    combined,
    separateReason,
    toggleLines,
    toggleHunk,
    requestDiscardLines,
    requestDiscardHunk,
    mixedPaths,
    partialBusy,
    diffNotice,
    partialError,
    dismissPartialError: () => setPartialError(null),
    partialAnnouncement,
    pendingPartialDiscard,
    confirmPartialDiscard,
    cancelPartialDiscard,
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
