// SPDX-License-Identifier: GPL-3.0-or-later
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent } from "react";
import type { InProgressOperation, WorkingDirectoryChanges, WorkingDirectoryFileChange } from "@githydra/git-core";
import type { ContinueOperation } from "../../hooks/useContinueOperation";
import type { GitHydraApi } from "../../../shared/ipcContract";
import { useChangesPanel, type DiffableCategory, type SelectedFile } from "../../hooks/useChangesPanel";
import { useResizableWidth } from "../../hooks/useResizableWidth";
import {
  CHANGES_DIFF_MIN_WIDTH,
  CHANGES_FILE_LIST_DEFAULT_WIDTH,
  CHANGES_FILE_LIST_MIN_WIDTH,
  CHANGES_PANEL_MIN_WIDTH,
  CHANGES_PANEL_STORAGE_KEY,
  changesPanelDefaultWidth,
  eightyVw,
} from "../../lib/layoutSizes";
import { discardableRefs, hunkChangedRefs } from "../../lib/combinedDiff";
import { ConflictResolutionView } from "../ConflictResolutionView/ConflictResolutionView";
import { ConfirmDialog } from "../ConfirmDialog/ConfirmDialog";
import { ContextMenu, type ContextMenuItem } from "../ContextMenu/ContextMenu";
import { DiffView, type DiffEditControls } from "../DiffView/DiffView";
import { BLOCKED_REASON, EditorPane, type ConflictFlow } from "../EditorPane/EditorPane";
import { FileStatusIcon } from "../FileStatusIcon/FileStatusIcon";
import { FilePath } from "./FilePath";
import { ActionIcon } from "./ActionIcon";
import { BulkBar } from "./BulkBar";
import { BulkDiscardDialog } from "./BulkDiscardDialog";
import { IgnorePopover } from "./IgnorePopover";
import { useFileSelection } from "../../hooks/useFileSelection";
import { useListWindowing } from "../../hooks/useListWindowing";
import { useBulkDiscard, type BulkDiscardOutcome } from "../../hooks/useBulkDiscard";
import { useIgnoreFlow, type PopoverAnchor } from "../../hooks/useIgnoreFlow";
import { useEditEligibility } from "../../hooks/useEditEligibility";
import { useDirtyLeaveGuard } from "../../hooks/useDirtyLeaveGuard";
import {
  ALREADY_EDITING_REASON,
  CHECKING_FILE_REASON,
  DIRTY_ROW_REASON,
  NO_EDITOR_REASON,
  NO_CONFLICT_REASON,
  NO_CONFLICTED_FILES_REASON,
  NO_OPERATION_REASON,
  NO_EDITS_REASON,
  NO_FILE_TO_EDIT_REASON,
  type EditCommandReasons,
  type EditOpenTarget,
  type EditorCommandState,
  type EditorCommands,
  type RestoreDraft,
} from "../../lib/editFile";
import { buildRows, eligibility, partlyStagedPaths, pathSample, plural, uniquePathCount, type BulkAction, type FileRow, type RowSection } from "../../lib/fileSelection";
import { scopeImpact, type IgnoreNotice } from "../../lib/ignoreMessages";
import { computeSelectionCommands, sameReasons, type SelectionCommandReasons } from "../../lib/selectionCommands";
import { ResizeHandle } from "../ResizeHandle/ResizeHandle";
import "./ChangesPanel.css";

export interface ChangesPanelProps {
  api: GitHydraApi;
  /**
   * ROADMAP.md tech-debt fix: the current working-directory changes, fetched and owned by
   * `useRepositoryGraph` (see that hook's `getWorkingDirectoryChangesWithRetry` doc comment) and
   * passed straight through to `useChangesPanel` — this component/hook pair no longer performs its
   * own independent fetch of the same data. `null` for a bare repository.
   */
  changes: WorkingDirectoryChanges | null;
  onClose: () => void;
  /** FR-30: refresh the shared working-dir data (Toolbar badge, the graph's uncommitted-changes
   * pseudo-node, and this panel's own `changes` prop above) after any successful mutation. */
  onWorkingDirChanged: () => void;
  /** FR-32: refresh the commit graph after a successful commit. */
  onCommitCreated: () => void;
  /** See `useChangesPanel`'s `reloadToken` option — bumped by App when the checkpoint pseudo-node
   * is clicked again while this panel is already open (spec's detailpanel-auto-diff Must-have
   * #2/#3). */
  reloadToken?: number;
  /**
   * specs/graph-head-indicator-and-refresh-alerting.md Problem 2 AC4: true while an
   * externally-detected operation-state alert is unacknowledged — forwarded to
   * `ConflictResolutionView` to disable Accept Ours/Accept Theirs/Mark as resolved until the user
   * clicks that banner's Refresh, same gate `StatusBanner` applies to Continue/Abort.
   */
  blockConflictActions?: boolean;
  /** specs/edit-in-diff.md FR-569: App's single Continue handler (shared with StatusBanner) and the operation it continues. */
  continueOp?: ContinueOperation;
  operationLabel?: InProgressOperation;
  /**
   * FR-98: set by App after a conflicting stash apply/pop — a distinct, non-blocking notice
   * (worded per whether Apply or Pop was invoked) shown above the Conflicted section, pointing at
   * the newly-populated conflicts. Deliberately not a `StatusBanner`-style operation banner: stash
   * apply/pop conflicts produce no in-progress-operation state (no Continue/Abort makes sense).
   */
  stashConflictNotice?: { action: "apply" | "pop" } | null;
  onDismissStashConflictNotice?: () => void;
  /**
   * specs/self-write-refresh-suppression.md FR-6b: forwarded to `ConflictResolutionView` so
   * Accept Ours/Accept Theirs/Mark as resolved open the same self-write gate every other
   * mutating action in the app already uses — see `useConflictResolution`'s own doc comment for
   * why. Optional only so existing/other test harnesses rendering this panel standalone don't
   * need to pass a no-op.
   */
  onMutationStart?: () => void;
  /** specs/self-write-refresh-suppression.md FR-6b: called both when a resolve action fails
   * (forwarded straight through to `ConflictResolutionView`) AND on success (from `conflictResolved`
   * below) — a resolve action never moves HEAD/refs, so closing the gate is a plain confirming
   * read either way, exactly like `useStashActions`'s own success-and-failure gate close. */
  onMutationSettled?: () => void;
  /**
   * specs/blame.md FR-131: opens `BlamePanel` for a Staged/Unstaged row's working-tree content
   * (`revision: null`), reached via that row's new right-click "Blame" action. Optional (like
   * other optional callbacks) so existing standalone-render test harnesses don't need to pass a
   * no-op — when absent, the Blame item is disabled with a generic reason rather than omitted
   * (FR-131's "never hidden" policy applies to real app usage, where App.tsx always wires this).
   */
  onOpenBlame?: (path: string, revision: string | null) => void;
  /**
   * specs/amend-last-commit.md FR-156: HEAD's current commit sha, threaded straight through to
   * `useChangesPanel` — see that hook's `headSha` option doc comment. `null` for a bare repository
   * or unborn HEAD.
   */
  headSha?: string | null;
  /**
   * specs/amend-last-commit.md FR-155: disabled reason for the "Amend last commit" checkbox —
   * non-null disables it with this exact `title` tooltip. `null`/omitted means eligible (existing
   * callers/tests that don't pass this see no behavior change — the checkbox is simply enabled
   * whenever a repo with a working directory is open).
   */
  amendDisabledReason?: string | null;
  /** specs/remember-last-selected-file.md FR-218 — see `useChangesPanel`'s option of the same
   * name for the exact one-shot-consultation contract this is forwarded straight through to. */
  initialSelectedFile?: SelectedFile | null;
  /** specs/remember-last-selected-file.md FR-219 — forwarded straight through to
   * `useChangesPanel`'s option of the same name. */
  onRestoredFileConsumed?: () => void;
  /** specs/remember-last-selected-file.md FR-216 — forwarded straight through to
   * `useChangesPanel`'s option of the same name. */
  onFileSelected?: (file: SelectedFile) => void;
  /**
   * specs/keyboard-shortcuts-command-palette.md FR-224/FR-230: reports the composer's own
   * `canCommit` (non-empty message + the panel's existing staged-file/amend rules) to the caller
   * on every change — `App.tsx` reads this to build the "Commit staged changes" command's
   * `isAvailable`/keybinding-guard state (FR-225/AC6) without duplicating `useChangesPanel`'s
   * eligibility logic. Optional — existing/other callers that don't pass this see no behavior
   * change (the value simply isn't reported anywhere).
   */
  onCommitAvailabilityChange?: (canCommit: boolean) => void;
  /**
   * security-reviewer finding (High, keyboard-shortcuts-command-palette.md FR-221/AC10 gap):
   * reports whether either of this panel's own locally-owned `ConfirmDialog`s — the discard
   * confirmation (`panel.pendingDiscard`) or the amend-a-possibly-shared-commit warning
   * (`panel.pendingAmendWarning`) — is currently open, on every change. `App.tsx` folds this into
   * `anyModalDialogOpen` the same way it already folds in `onCommitAvailabilityChange` above, so
   * the global keybinding layer (`useGlobalKeybindings`) suspends Ctrl/Cmd+Enter etc. while either
   * dialog is up — closing the gap where `setIsCommitting(false)` alongside
   * `setPendingAmendWarning(true)` (in `useChangesPanel`'s amend flow) flips `canCommit` back to
   * `true` while the warning is still on screen, letting Ctrl/Cmd+Enter re-invoke `submitCommit()`
   * and race the exact amend attempt the warning exists to gate.
   *
   * test-agent finding (keyboard-shortcuts-command-palette.md FR-221's own text, which explicitly
   * names `ContextMenu` alongside the three dialogs as a component the global keybinding layer
   * must defer to): also ORs in whether this panel's own file-row `ContextMenu`
   * (`fileContextMenu` below) is open, so right-clicking a Staged/Unstaged/Untracked/Conflicted row
   * and then pressing Ctrl+K doesn't stack the palette on top of it. Reusing this same prop (rather
   * than adding a second one) keeps `App.tsx`'s fold-in a single boolean per panel, matching the
   * established shape.
   *
   * Optional — existing/other callers that don't pass this see no behavior change.
   */
  onDialogOpenChange?: (open: boolean) => void;
  /**
   * specs/hunk-line-staging.md FR-483: whether the "Stage/Unstage current hunk" and "Discard hunk" commands
   * can act right now (an eligible checkbox diff is open and a hunk has the cursor). `App.tsx` folds this into
   * the command registry's `isAvailable`, the same pass-through as `onCommitAvailabilityChange`.
   */
  onHunkCommandsChange?: (state: { toggle: boolean; discard: boolean }) => void;
  /** specs/live-refresh.md FR-461 - forwarded to `useChangesPanel`'s `liveRevision`. */
  liveRevision?: number;
  /**
   * specs/live-refresh.md FR-465: what makes this panel "busy" for the idle gate. The composer counts while focused
   * or holding a draft (the same condition that keeps it expanded, FR-489); the conflict view while one is open;
   * `mutationBusy` while a stage/commit/hunk apply is in flight. Cleared on unmount.
   */
  onInteractionChange?: (state: { composerBusy: boolean; conflictViewOpen: boolean; mutationBusy: boolean }) => void;
  /**
   * specs/ignore-and-multiselect.md D2: the repository this panel shows, used only to remember the last "Add to" choice per
   * repo in localStorage. Omitted: the choice is not remembered.
   */
  repoKey?: string | null;
  /** specs/ignore-and-multiselect.md FR-504: what each selection command can do now (null = can run, string = why not). */
  onSelectionCommandsChange?: (reasons: SelectionCommandReasons) => void;
  /** specs/edit-in-diff.md FR-533: what the Command Palette's Edit file / Save / Save and stage can do now. */
  onEditCommandsChange?: (reasons: EditCommandReasons) => void;
  /** specs/edit-recovery-draft.md FR-550: a confirmed Restore; open that file's editor with the draft as the dirty buffer. */
  restoreRequest?: { id: number; path: string; draft: RestoreDraft } | null;
  onRestoreRequestHandled?: (id: number) => void;
}

/**
 * specs/keyboard-shortcuts-command-palette.md FR-224: the imperative surface `App.tsx` uses to
 * invoke the composer's existing commit action from the "Commit staged changes" command — a thin
 * pass-through to `useChangesPanel`'s own `submitCommit` (already gated by its own `canCommit`
 * check), not new business logic.
 */
export interface ChangesPanelHandle {
  requestCommit: () => void;
  /** FR-483: the Command Palette's "Stage/Unstage current hunk" - the hunk checkbox's own action. */
  toggleCurrentHunk: () => void;
  /** FR-483/FR-478: "Discard hunk" - opens the same confirmation as the hunk header's Discard. */
  discardCurrentHunk: () => void;
  /** specs/ignore-and-multiselect.md FR-504: the Command Palette's selection commands; each is a no-op when it cannot apply. */
  stageSelected: () => void;
  unstageSelected: () => void;
  /** Opens the same confirmation as the bulk bar's Discard. */
  discardSelected: () => void;
  /** "Discard all changes...": opens the D6/D7 confirmation. */
  discardAll: () => void;
  /** Opens the Ignore popover for the selected rows. */
  ignoreSelected: () => void;
  /** Ctrl/Cmd+A: selects the section the focused (else open) row is in. */
  selectAllInSection: () => void;
  /** specs/edit-in-diff.md FR-533: the Command Palette's Edit file / Save / Save and stage; each is a no-op when its reason is non-null. */
  editFile: () => void;
  saveEdit: () => void;
  saveAndStageEdit: () => void;
  /** specs/edit-in-diff.md FR-562: next/previous conflict block while a conflicted file is open in the editor. */
  nextConflict: () => void;
  prevConflict: () => void;
  /** specs/edit-in-diff.md FR-569/FR-572: Mark as resolved, Next conflicted file, Continue, Resolve in editor. */
  markResolved: () => void;
  nextConflictedFile: () => void;
  continueOperation: () => void;
  resolveInEditor: () => void;
}

// Must equal `.gh-changes-panel__file`'s height in ChangesPanel.css: the windowing maths assumes fixed-height rows.
const FILE_ROW_HEIGHT = 28;
// FR-532: the rail's hover overlay; the drawer's squeeze rule would otherwise cap it at the 160px column minimum in a small window.
const RAIL_OVERLAY_MIN_WIDTH = 260;

type PanelNotice = IgnoreNotice | { text: string; tone: "error" };

interface SectionConfig {
  category: DiffableCategory | "conflicted";
  label: string;
  entries: WorkingDirectoryFileChange[];
}

function listPadding(w: { start: number; end: number }, count: number): { paddingTop: number; paddingBottom: number } | undefined {
  return w.start === 0 && w.end === count ? undefined : { paddingTop: w.start * FILE_ROW_HEIGHT, paddingBottom: (count - w.end) * FILE_ROW_HEIGHT };
}

function partialDiscardMessage(p: { path: string; hunks: number; count: number; range?: string }): string {
  const what =
    p.hunks > 0
      ? `${p.hunks} hunk${p.hunks === 1 ? "" : "s"}${p.range ? ` (lines ${p.range})` : ""}`
      : `${p.count} line${p.count === 1 ? "" : "s"}`;
  return `Discard ${what} from ${p.path}? This permanently removes the change from your working tree. This cannot be undone.`;
}

/**
 * FR-28/FR-29/FR-30/FR-31/FR-32: the Changes panel — Staged/Unstaged/Untracked/Conflicted
 * sections with counts and stage/unstage/discard controls, a diff view for the selected file,
 * and the commit composer. All state/mutation logic lives in `useChangesPanel`; this component
 * is presentational.
 *
 * specs/keyboard-shortcuts-command-palette.md FR-224: wrapped in `forwardRef` so `App.tsx` can
 * invoke the composer's commit action from outside (the "Commit staged changes" command/Ctrl-Cmd+
 * Enter binding) via `ChangesPanelHandle.requestCommit` — existing callers that don't pass a `ref`
 * are unaffected.
 */
export const ChangesPanel = forwardRef<ChangesPanelHandle, ChangesPanelProps>(function ChangesPanel(
  {
    api,
    changes,
    onClose,
    onWorkingDirChanged,
    onCommitCreated,
    reloadToken,
    blockConflictActions = false,
    continueOp,
    operationLabel = null,
    stashConflictNotice = null,
    onDismissStashConflictNotice,
    onMutationStart,
    onMutationSettled,
    onOpenBlame,
    headSha = null,
    amendDisabledReason = null,
    initialSelectedFile = null,
    onRestoredFileConsumed,
    onFileSelected,
    onCommitAvailabilityChange,
    onDialogOpenChange,
    onHunkCommandsChange,
    liveRevision,
    onInteractionChange,
    repoKey = null,
    onSelectionCommandsChange,
    onEditCommandsChange,
    restoreRequest = null,
    onRestoreRequestHandled,
  },
  ref,
) {
  const panel = useChangesPanel({
    api,
    changes,
    onWorkingDirChanged,
    onCommitCreated,
    onCommitStart: onMutationStart,
    onCommitFailed: onMutationSettled,
    reloadToken,
    headSha,
    amendDisabledReason,
    initialSelectedFile,
    onRestoredFileConsumed,
    onFileSelected,
    liveRevision,
  });

  // FR-224/FR-230: reports `canCommit` on every change — a plain pass-through, not a duplicated
  // eligibility computation (see `onCommitAvailabilityChange`'s own doc comment on the props type).
  useEffect(() => {
    onCommitAvailabilityChange?.(panel.canCommit);
  }, [panel.canCommit, onCommitAvailabilityChange]);

  // FR-483: the hunk with the cursor (or focused checkbox), reported by the diff. The Command Palette's hunk
  // commands act on it, so it deliberately survives the diff losing DOM focus when the palette opens.
  const [activeHunk, setActiveHunk] = useState<number | null>(null);
  const activeHunkData = panel.combined && activeHunk !== null ? panel.combined.hunks[activeHunk] : undefined;
  const canToggleHunk = activeHunkData !== undefined;
  const canDiscardHunk =
    activeHunkData !== undefined &&
    !panel.partialBusy &&
    discardableRefs(panel.combined!.hunks, hunkChangedRefs(activeHunkData, activeHunk!)).length > 0;
  useEffect(() => {
    onHunkCommandsChange?.({ toggle: canToggleHunk, discard: canDiscardHunk });
  }, [canToggleHunk, canDiscardHunk, onHunkCommandsChange]);

  useImperativeHandle(
    ref,
    () => ({
      requestCommit: () => panel.submitCommit(),
      toggleCurrentHunk: () => {
        if (activeHunk !== null) panel.toggleHunk(activeHunk);
      },
      discardCurrentHunk: () => {
        if (activeHunk !== null) panel.requestDiscardHunk(activeHunk);
      },
      stageSelected: () => bulkActionsRef.current.stageSelected(),
      unstageSelected: () => bulkActionsRef.current.unstageSelected(),
      discardSelected: () => bulkActionsRef.current.discardSelected(),
      discardAll: () => bulkActionsRef.current.discardAll(),
      ignoreSelected: () => bulkActionsRef.current.ignoreSelected(),
      selectAllInSection: () => bulkActionsRef.current.selectAllInSection(),
      editFile: () => editCommandsRef.current.edit(),
      saveEdit: () => editorCommandsRef.current?.save(),
      saveAndStageEdit: () => editorCommandsRef.current?.saveAndStage(),
      nextConflict: () => editorCommandsRef.current?.nextConflict(),
      prevConflict: () => editorCommandsRef.current?.prevConflict(),
      markResolved: () => editorCommandsRef.current?.saveAndStage(),
      nextConflictedFile: () => conflictFlowRef.current.openNext(),
      continueOperation: () => conflictFlowRef.current.continueNow(),
      resolveInEditor: () => conflictFlowRef.current.resolveInEditor(),
    }),
    [panel.submitCommit, panel.toggleHunk, panel.requestDiscardHunk, activeHunk],
  );

  // specs/merge-rebase-conflict-resolution.md FR-72: which Conflicted-section row (if any) has
  // its resolution view open in the diff column, replacing DiffView — separate from
  // `panel.selected` since useChangesPanel's own selection deliberately excludes Conflicted
  // entries (FR-27: no plain stage/unstage/diff control for them). Selecting a normal diffable
  // file clears this (see `selectDiffableFile` below) and vice versa, so the diff column only
  // ever shows one or the other.
  const [activeConflictPath, setActiveConflictPath] = useState<string | null>(null);
  // specs/edit-in-diff.md FR-532: the editor is keyed by file PATH, not by the selected row, so it outlives a Changes-list
  // change (the saved file moving between sections or dropping out of the list).
  const [editing, setEditing] = useState<{ path: string; open: EditOpenTarget } | null>(null);
  const [editDirty, setEditDirty] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [conflictDialogOpen, setConflictDialogOpen] = useState(false);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  // FR-533: the open editor's own Save / Save and stage, and what it can do right now.
  const editorCommandsRef = useRef<EditorCommands | null>(null);
  const [editorCommandState, setEditorCommandState] = useState<EditorCommandState | null>(null);
  const editCommandsRef = useRef({ edit: () => {} });
  const conflictFlowRef = useRef({ openNext: () => {}, continueNow: () => {}, resolveInEditor: () => {} });
  const guard = useDirtyLeaveGuard();
  // FR-538: leaving by choice returns focus to the Edit button; navigation away leaves focus on what the user clicked.
  const refocusEditRef = useRef(false);
  const diffColumnRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!refocusEditRef.current || editing) return;
    const btn = diffColumnRef.current?.querySelector<HTMLElement>("[data-edit-button]");
    if (btn) {
      refocusEditRef.current = false;
      btn.focus();
    }
  });
  const leaveEditorThen = useCallback(
    (proceed: () => void) => {
      if (!editingRef.current) return proceed();
      void guard.confirmLeave().then((ok) => {
        if (!ok) return;
        setEditing(null);
        proceed();
      });
    },
    [guard],
  );
  const closeEditor = useCallback((opts: { returnFocus: boolean }) => {
    refocusEditRef.current = opts.returnFocus;
    setEditing(null);
  }, []);
  // specs/blame.md FR-131: right-click state for a Staged/Unstaged/Untracked/Conflicted row's new
  // "Blame" context menu.
  // specs/hunk-line-staging.md FR-453: the diff's line/hunk context menu, reported up so it joins the
  // same "a menu is open" signal as `fileContextMenu` below.
  const [diffMenuOpen, setDiffMenuOpen] = useState(false);
  // specs/ignore-and-multiselect.md D5: `rows` are the rows the menu acts on (the whole selection when the clicked row
  // is part of a multi-selection).
  const [fileContextMenu, setFileContextMenu] = useState<{ x: number; y: number; rows: FileRow[] } | null>(null);
  // The Unstaged header's overflow menu (FR-518a): Discard all lives here and is never relabelled by a selection.
  const [headerMenu, setHeaderMenu] = useState<{ x: number; y: number } | null>(null);
  // FR-534: eligibility of the right-clicked file, probed when its menu opens (the open-file probe only covers the open diff).
  const [menuEditVerdict, setMenuEditVerdict] = useState<{ path: string; reason: string | null | "pending" } | null>(null);
  const menuOpenTokenRef = useRef(0);
  useEffect(() => () => void (menuOpenTokenRef.current += 1), []);
  const bulkActionsRef = useRef({
    stageSelected: () => {},
    unstageSelected: () => {},
    discardSelected: () => {},
    discardAll: () => {},
    ignoreSelected: () => {},
    selectAllInSection: () => {},
  });

  // specs/ignore-and-multiselect.md FR-465/FR-511: the bulk-discard and ignore dialogs are modals for the idle gate
  // and the global keybinding layer, like the other two confirmations.
  const [panelNotice, setPanelNotice] = useState<PanelNotice | null>(null);
  const [liveMessage, setLiveMessage] = useState("");
  const dismissPanelNotice = useCallback(() => setPanelNotice(null), []);

  const onDiscardFinished = useCallback(
    (outcome: BulkDiscardOutcome) => {
      onWorkingDirChanged();
      if (!outcome.ok) return; // the dialog stays open and shows the error itself
      const r = outcome.result;
      const skipped = r.skipped.length > 0 ? ` ${r.skipped.length} skipped: ${r.skipped[0]!.reason}` : "";
      if (r.status === "complete") {
        setPanelNotice({ text: `Discarded ${plural(r.discarded.length, "file")}.${skipped}`, tone: r.skipped.length > 0 ? "warn" : "ok" });
        return;
      }
      const left = pathSample(r.notAttempted, 3);
      setPanelNotice({
        text:
          `Discarded ${r.discarded.length} of ${r.discarded.length + 1 + r.notAttempted.length} files, then stopped at ${r.failed?.path ?? "a file"}` +
          ` (${r.failed?.message ?? "unknown error"}). Not discarded: ${[r.failed?.path, ...left.shown].filter(Boolean).join(", ")}${left.more > 0 ? ` and ${left.more} more` : ""}.${skipped}`,
        tone: "error",
      });
    },
    [onWorkingDirChanged],
  );
  const bulkDiscard = useBulkDiscard({ api, onFinished: onDiscardFinished });
  const onIgnoreResult = useCallback((notice: IgnoreNotice) => setPanelNotice(notice), []);
  const ignore = useIgnoreFlow({ api, repoKey, onChanged: onWorkingDirChanged, onResult: onIgnoreResult });

  // security-reviewer finding / test-agent finding: reports on every change — a plain
  // pass-through, not a duplicated computation — see `onDialogOpenChange`'s own doc comment on the
  // props type for why `fileContextMenu` is ORed in here alongside the ConfirmDialogs.
  useEffect(() => {
    onDialogOpenChange?.(
      panel.pendingDiscard !== null ||
        panel.pendingPartialDiscard !== null ||
        panel.pendingAmendWarning ||
        fileContextMenu !== null ||
        headerMenu !== null ||
        diffMenuOpen ||
        bulkDiscard.pending !== null ||
        ignore.pending !== null ||
        editDialogOpen ||
        conflictDialogOpen,
    );
  }, [
    editDialogOpen,
    conflictDialogOpen,
    panel.pendingDiscard,
    panel.pendingPartialDiscard,
    panel.pendingAmendWarning,
    fileContextMenu,
    headerMenu,
    diffMenuOpen,
    bulkDiscard.pending,
    ignore.pending,
    onDialogOpenChange,
  ]);

  const closeFileMenu = useCallback(() => setFileContextMenu(null), []);

  const menuRow = fileContextMenu && uniquePathCount(fileContextMenu.rows) === 1 ? fileContextMenu.rows[0]! : null;
  const menuRowPath = menuRow?.path ?? null;
  const menuRowIsDir = menuRow?.isDir ?? false;
  useEffect(() => {
    if (menuRowPath === null) return setMenuEditVerdict(null);
    if (menuRowIsDir) return setMenuEditVerdict({ path: menuRowPath, reason: "This is a folder, not a file." });
    let stale = false;
    setMenuEditVerdict({ path: menuRowPath, reason: "pending" });
    void (async () => {
      let reason: string | null;
      try {
        const r = await api.probeEditableFile(menuRowPath);
        reason = !r.ok ? r.message : r.data.eligible ? null : r.data.message;
      } catch (e) {
        reason = e instanceof Error ? e.message : "Could not check this file";
      }
      if (!stale) setMenuEditVerdict({ path: menuRowPath, reason });
    })();
    return () => {
      stale = true;
    };
  }, [api, menuRowPath, menuRowIsDir]);

  const selectDiffableFile = useCallback(
    (category: DiffableCategory, entry: WorkingDirectoryFileChange) => {
      setActiveConflictPath(null);
      panel.selectFile(category, entry);
    },
    [panel],
  );
  // specs/edit-in-diff.md FR-556/FR-567: one entry for row click, Enter, the menu and the palette. An eligible text conflict opens
  // the block editor; anything else keeps the file-level view, which states why. Opening the editor always clears the file view.
  const conflictOpenToken = useRef(0);
  const openConflictFile = useCallback(
    async (path: string) => {
      const token = ++conflictOpenToken.current;
      let eligible = false;
      try {
        const r = await api.probeEditableFile(path);
        eligible = r.ok && r.data.eligible;
      } catch {
        eligible = false;
      }
      if (token !== conflictOpenToken.current) return;
      if (eligible) {
        setActiveConflictPath(null);
        setEditing({ path, open: {} });
      } else setActiveConflictPath(path);
    },
    [api],
  );
  // FR-550: the file may be in no Changes section any more (committed or reverted outside); the editor is keyed by path, so it opens anyway.
  const handledRestoreRef = useRef<number | null>(null);
  useEffect(() => {
    if (!restoreRequest || panel.status !== "ready" || handledRestoreRef.current === restoreRequest.id) return;
    handledRestoreRef.current = restoreRequest.id;
    const { id, path, draft } = restoreRequest;
    let found: { category: DiffableCategory; entry: WorkingDirectoryFileChange } | null = null;
    for (const category of ["unstaged", "untracked", "staged"] as const) {
      const entry = panel.changes?.[category].find((f) => f.path === path);
      if (entry && !found) found = { category, entry };
    }
    leaveEditorThen(() => {
      if (found) selectDiffableFile(found.category, found.entry);
      setActiveConflictPath(null);
      setEditing({ path, open: { restore: draft } });
    });
    onRestoreRequestHandled?.(id);
  });
  const conflictResolved = useCallback(() => {
    // ROADMAP.md tech-debt fix: `onWorkingDirChanged()` alone is now the correction path — it
    // triggers `useRepositoryGraph`'s single shared working-dir fetch, whose result flows back
    // down as this component's own `changes` prop and re-syncs `useChangesPanel`'s overlay (see
    // that hook's doc comment). There is no separate `reconcile()` to call anymore: unlike the old
    // `reload()`, this was never at risk of unmounting `ConflictResolutionView` mid-interaction —
    // that risk was specific to `reload`'s `status -> "loading"` transition, which no longer exists.
    onWorkingDirChanged();
    // FR-6b: a successful resolve action never reaches `useConflictResolution`'s own
    // `onMutationSettled` (that path is failure-only, mirroring `useStashActions`) — this is the
    // success-side confirming read that closes the gate `onMutationStart` opened, exactly like
    // `useBranchActions`'s `onChanged`/`useStashActions`'s `onMutated` closing it via their own
    // refresh call.
    onMutationSettled?.();
  }, [onWorkingDirChanged, onMutationSettled]);

  // FR-486 (specs/changes-panel-layout.md): the drawer owns its width (default ~60% of the window,
  // its own storage key — the other right-slot panels keep sharing RIGHT_PANEL_STORAGE_KEY).
  // Dragging left grows it, since it sits to the right of its own handle.
  const panelWidth = useResizableWidth({
    storageKey: CHANGES_PANEL_STORAGE_KEY,
    defaultWidth: changesPanelDefaultWidth(),
    min: CHANGES_PANEL_MIN_WIDTH,
    getMax: eightyVw,
    direction: -1,
    // FR-532: transient; leaving edit mode restores the stored width untouched.
    override: editing ? eightyVw : null,
  });
  // FR-486: the diff keeps >= CHANGES_DIFF_MIN_WIDTH; in a drawer too small for that, the hook's
  // own min wins and the file column simply sits at its minimum.
  const getFileListMax = useCallback(() => panelWidth.width - CHANGES_DIFF_MIN_WIDTH, [panelWidth.width]);
  const fileListWidth = useResizableWidth({
    storageKey: "githydra:layout:changesFileListWidth",
    defaultWidth: CHANGES_FILE_LIST_DEFAULT_WIDTH,
    min: CHANGES_FILE_LIST_MIN_WIDTH,
    getMax: getFileListMax,
    direction: 1,
  });

  // FR-489: the body/Amend row opens while the form has focus and stays open while it holds text or
  // Amend is checked, so collapsing can never hide (or lose) anything the user entered.
  const [composerFocused, setComposerFocused] = useState(false);
  const pointerInComposer = useRef(false);
  const composerExpanded = composerFocused || panel.body !== "" || panel.amend;
  const composerBusy = composerExpanded || panel.subject !== "";
  const conflictViewOpen = activeConflictPath !== null;
  const mutationBusy = panel.partialBusy || panel.isCommitting;
  useEffect(() => {
    onInteractionChange?.({ composerBusy, conflictViewOpen, mutationBusy });
  }, [composerBusy, conflictViewOpen, mutationBusy, onInteractionChange]);
  // Unmount only: a changing callback identity must not read as "went idle" for an instant.
  const onInteractionChangeRef = useRef(onInteractionChange);
  onInteractionChangeRef.current = onInteractionChange;
  useEffect(
    () => () => onInteractionChangeRef.current?.({ composerBusy: false, conflictViewOpen: false, mutationBusy: false }),
    [],
  );
  const onComposerBlur = (e: FocusEvent<HTMLFormElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    // A click on a non-focusable part of the form (some platforms never focus a checkbox on click)
    // reports a null relatedTarget; collapsing then would swallow the click.
    if (pointerInComposer.current) return;
    setComposerFocused(false);
  };

  // FR-482/FR-488: a partly staged file is a row in Staged AND in Unstaged straight from the FR-19 data; the
  // eligibility verdict only decides the marker.
  const sections: SectionConfig[] | null = panel.changes
    ? [
        { category: "staged", label: "Staged", entries: panel.changes.staged },
        { category: "unstaged", label: "Unstaged", entries: panel.changes.unstaged },
        { category: "untracked", label: "Untracked", entries: panel.changes.untracked },
        { category: "conflicted", label: "Conflicted", entries: panel.changes.conflicted },
      ]
    : null;

  // --- specs/ignore-and-multiselect.md: selection model (FR-505), bulk actions (FR-506..FR-510), ignore (FR-494..FR-503) ---
  const rows = useMemo(() => buildRows(panel.changes, panel.mixedPaths), [panel.changes, panel.mixedPaths]);
  const partlyStaged = useMemo(() => partlyStagedPaths(panel.changes), [panel.changes]);
  const rowByKey = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows]);
  const entryByPath = useMemo(() => new Map(rows.map((r) => [r.path, r.entry])), [rows]);
  const selection = useFileSelection(rows);
  const selectedRows = selection.selectedRows;
  // FR-482: "N selected" counts files, so a partly staged file selected on both rows is one.
  const selectedCount = useMemo(() => uniquePathCount(selectedRows), [selectedRows]);
  const bulkEligibility = useMemo(
    () => ({
      stage: eligibility("stage", selectedRows),
      unstage: eligibility("unstage", selectedRows),
      discard: eligibility("discard", selectedRows),
      ignore: eligibility("ignore", selectedRows),
    }),
    [selectedRows],
  );
  const filesRootRef = useRef<HTMLDivElement | null>(null);
  const windowing = useListWindowing(
    filesRootRef,
    useMemo(() => Object.fromEntries((sections ?? []).map((sec) => [sec.category, sec.entries.length])), [sections]),
    FILE_ROW_HEIGHT,
  );
  const indexInSection = useMemo(() => {
    const seen: Partial<Record<RowSection, number>> = {};
    const m = new Map<string, number>();
    for (const r of rows) {
      const i = seen[r.section] ?? 0;
      m.set(r.key, i);
      seen[r.section] = i + 1;
    }
    return m;
  }, [rows]);
  // An off-screen row is not in the DOM: scroll it into the window, then focus it once it has mounted.
  const pendingFocusKeyRef = useRef<string | null>(null);
  const focusRow = (key: string) => {
    const el = rowButton(key);
    if (el) {
      el.focus();
      return;
    }
    const row = rowByKey.get(key);
    if (!row) return;
    pendingFocusKeyRef.current = key;
    windowing.scrollToRow(row.section, indexInSection.get(key) ?? 0);
  };
  useLayoutEffect(() => {
    const key = pendingFocusKeyRef.current;
    if (!key) return;
    const el = rowButton(key);
    if (!el) return;
    pendingFocusKeyRef.current = null;
    el.focus();
  });
  const rowButton = (key: string): HTMLElement | null =>
    Array.from(filesRootRef.current?.querySelectorAll<HTMLElement>("[data-row-key]") ?? []).find((el) => el.dataset.rowKey === key) ?? null;
  const rowKeyOfFocus = (): string | null => {
    const li = (document.activeElement as HTMLElement | null)?.closest?.(".gh-changes-panel__file");
    return li?.querySelector<HTMLElement>("[data-row-key]")?.dataset.rowKey ?? null;
  };
  // The open diff row, as the selection origin before the user has selected anything themselves.
  const openRowKey = panel.selected
    ? (rowByKey.get(`${panel.selected.category}:${panel.selected.path}`) ?? rows.find((r) => r.path === panel.selected!.path && r.section !== "conflicted"))?.key ?? null
    : null;

  // FR-511: after an action (or a dialog), focus falls to the surviving row for the same path, else the nearest row by index,
  // never to <body>. Nothing is stolen while an overlay or another control holds focus.
  const focusRestoreRef = useRef<{ path: string; index: number; invoker: HTMLElement | null } | null>(null);
  // specs/ignore-and-multiselect.md FR-513: the invoking button (when given) gets focus back before the row label does.
  const rememberFocus = (invoker: HTMLElement | null = null) => {
    const key = rowKeyOfFocus();
    const index = key ? rows.findIndex((r) => r.key === key) : -1;
    if (index >= 0) focusRestoreRef.current = { path: rows[index]!.path, index, invoker };
    else if (invoker) focusRestoreRef.current = { path: "", index: 0, invoker };
  };
  const overlayOpen =
    fileContextMenu !== null || headerMenu !== null || bulkDiscard.pending !== null || ignore.pending !== null || panel.pendingDiscard !== null;
  useEffect(() => {
    const want = focusRestoreRef.current;
    if (!want || overlayOpen) return;
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body && active.isConnected) {
      // Focus still on the remembered row (a menu is about to open from it): keep the memory for when the overlay closes.
      const focusedKey = rowKeyOfFocus();
      if (!(focusedKey && rowByKey.get(focusedKey)?.path === want.path)) focusRestoreRef.current = null;
      return;
    }
    if (want.invoker?.isConnected) {
      want.invoker.focus();
      focusRestoreRef.current = null;
      return;
    }
    const target = rows.find((r) => r.path === want.path) ?? rows[Math.min(want.index, rows.length - 1)];
    if (target) {
      focusRow(target.key);
      // Kept briefly: the refresh that follows an action can remove this very row, and focus must then fall to its neighbour.
      const kept = focusRestoreRef.current;
      setTimeout(() => {
        if (focusRestoreRef.current === kept) focusRestoreRef.current = null;
      }, 2000);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, overlayOpen]);

  // FR-513: the live region announces counts (multi-selection only; a plain click is not news) and results.
  const prevSelectedCountRef = useRef(0);
  const prevSelectedRowsRef = useRef(0);
  useEffect(() => {
    const n = selectedCount;
    const prev = prevSelectedCountRef.current;
    const prevRows = prevSelectedRowsRef.current;
    prevSelectedRowsRef.current = selectedRows.length;
    // Both rows of one partly staged file selected is still one file (FR-482).
    if (n === prev) {
      if (n === 1 && selectedRows.length >= 2 && prevRows < 2) setLiveMessage("1 file selected");
      return;
    }
    prevSelectedCountRef.current = n;
    if (n >= 2) {
      const st = eligibility("stage", selectedRows).eligible.length;
      const un = eligibility("unstage", selectedRows).eligible.length;
      setLiveMessage(`${n} files selected${st > 0 ? `. Stage ${st} selected available` : ""}${un > 0 ? `. Unstage ${un} selected available` : ""}`);
    }
    else if (prev >= 2) setLiveMessage(n === 1 ? "1 file selected" : "Selection cleared");
  }, [selectedCount, selectedRows.length]);

  const runBulkStage = async (action: "stage" | "unstage", targets: readonly FileRow[]) => {
    const e = eligibility(action, targets);
    if (e.eligible.length === 0) return;
    rememberFocus();
    setPanelNotice(null);
    const out = await panel.bulkStageRows(e.eligible, action);
    if (!out.ok) return; // the failure is shown by the panel's own error line
    const skipped = e.skipped.length + out.skipped;
    setPanelNotice({
      text:
        `${action === "stage" ? "Staged" : "Unstaged"} ${plural(out.changed, "file")}` +
        (skipped > 0 ? `, ${skipped} skipped` : "") +
        (out.unchanged > 0 ? `. ${plural(out.unchanged, "file")} did not change` : "") +
        ".",
      tone: out.unchanged > 0 ? "warn" : "ok",
    });
  };
  const openBulkDiscard = (targets: readonly FileRow[]) => {
    const e = eligibility("discard", targets);
    if (e.eligible.length === 0) return;
    rememberFocus();
    setPanelNotice(null);
    bulkDiscard.openSelected(
      e.eligible,
      e.skipped.map((s) => ({ path: s.row.path, reason: s.reason })),
    );
  };
  const openDiscardAll = () => {
    rememberFocus();
    setPanelNotice(null);
    bulkDiscard.openAll();
  };
  const openIgnore = (targets: readonly FileRow[], anchor: PopoverAnchor, invoker: HTMLElement | null = null) => {
    const e = eligibility("ignore", targets);
    if (e.eligible.length === 0) return;
    rememberFocus(invoker);
    setPanelNotice(null);
    ignore.begin(e.eligible, anchor);
  };
  const anchorOf = (el: Element | null | undefined): PopoverAnchor => {
    const rect = (el ?? filesRootRef.current)?.getBoundingClientRect();
    return { x: rect?.left ?? 0, y: rect?.bottom ?? 0, yAbove: rect?.top ?? 0 };
  };
  const sectionOfFocus = (): RowSection | null => {
    const key = rowKeyOfFocus();
    return (key ? rowByKey.get(key)?.section : undefined) ?? (openRowKey ? rowByKey.get(openRowKey)?.section : undefined) ?? rows[0]?.section ?? null;
  };
  bulkActionsRef.current = {
    stageSelected: () => void runBulkStage("stage", selectedRows),
    unstageSelected: () => void runBulkStage("unstage", selectedRows),
    discardSelected: () => openBulkDiscard(selectedRows),
    discardAll: openDiscardAll,
    ignoreSelected: () => {
      const invoker = selectedRows[0] ? rowButton(selectedRows[0].key) : null;
      openIgnore(selectedRows, anchorOf(invoker), invoker);
    },
    selectAllInSection: () => {
      const section = sectionOfFocus();
      if (section) selection.selectAllIn(section);
    },
  };

  // "+N files" per scope for the open Ignore popover; the rows are the live list, the targets are the popover's own snapshot.
  const ignoreRows = ignore.pending?.rows;
  const ignoreImpact = useMemo(
    () =>
      ignoreRows
        ? {
            name: scopeImpact(rows, ignoreRows, "name"),
            extension: scopeImpact(rows, ignoreRows, "extension"),
            directory: scopeImpact(rows, ignoreRows, "directory"),
          }
        : null,
    [rows, ignoreRows],
  );

  const commandReasons = useMemo(
    () => computeSelectionCommands(rows, selectedRows, panel.status === "ready"),
    [rows, selectedRows, panel.status],
  );
  const reportedReasonsRef = useRef<SelectionCommandReasons | null>(null);
  useEffect(() => {
    if (reportedReasonsRef.current && sameReasons(reportedReasonsRef.current, commandReasons)) return;
    reportedReasonsRef.current = commandReasons;
    onSelectionCommandsChange?.(commandReasons);
  }, [commandReasons, onSelectionCommandsChange]);

  const onRowClick = (e: MouseEvent<HTMLElement>, row: FileRow) => {
    if (e.shiftKey) {
      e.currentTarget.focus();
      selection.extendTo(row.key, e.ctrlKey || e.metaKey, openRowKey ?? undefined);
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      e.currentTarget.focus();
      // The open diff row counts as the first selected row when the user starts multi-selecting from it.
      if (selectedRows.length === 0 && openRowKey && openRowKey !== row.key) selection.only(openRowKey);
      selection.toggle(row.key);
      return;
    }
    selection.only(row.key);
    const go = () => {
      if (row.section === "conflicted") void openConflictFile(row.path);
      else selectDiffableFile(row.section, row.entry);
    };
    // The other row of the file being edited keeps the editor (FR-532); any other row asks first when dirty (FR-535).
    if (editing && row.path !== editing.path) leaveEditorThen(go);
    else go();
  };

  const onRowContextMenu = (e: MouseEvent<HTMLElement>, row: FileRow) => {
    e.preventDefault();
    rememberFocus();
    let targets: FileRow[];
    if (selection.isSelected(row.key) && selectedCount > 1) targets = selectedRows;
    else {
      targets = [row];
      selection.only(row.key);
    }
    const menu = { x: e.clientX, y: e.clientY, view: "main" as const, rows: targets };
    if (selectedCount < 2 || uniquePathCount(targets) > 1) {
      menuOpenTokenRef.current += 1;
      setFileContextMenu(menu);
      return;
    }
    // Collapsing a multi-selection unmounts the bulk bar; the list's scroller grows, clamps its scrollTop and fires a
    // scroll event one frame later, which ContextMenu would take for the user scrolling (FR-316) and close at once.
    // Opening after two frames lets that settle first.
    const token = ++menuOpenTokenRef.current;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (token === menuOpenTokenRef.current) setFileContextMenu(menu);
      }),
    );
  };

  // FR-505: the roving behaviour lives on the row's label button; everything else (Tab, row actions, Enter) is native.
  const onListKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const target = e.target as HTMLElement;
    const key = target.dataset?.rowKey;
    if (!key) return;
    const index = rows.findIndex((r) => r.key === key);
    if (index < 0) return;
    const mod = e.ctrlKey || e.metaKey;
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !mod && !e.altKey) {
      e.preventDefault();
      const next = rows[index + (e.key === "ArrowDown" ? 1 : -1)];
      if (!next) return;
      focusRow(next.key);
      if (e.shiftKey) selection.extendTo(next.key, false, key);
    } else if ((e.key === "Home" || e.key === "End") && !mod && !e.shiftKey) {
      e.preventDefault();
      const edge = e.key === "Home" ? rows[0] : rows[rows.length - 1];
      if (edge) focusRow(edge.key);
    } else if (e.key === " " && !mod) {
      e.preventDefault();
      selection.toggle(key);
    } else if ((e.key === "a" || e.key === "A") && mod) {
      e.preventDefault();
      selection.selectAllIn(rows[index]!.section);
    } else if (e.key === "Escape" && selectedRows.length > 0) {
      e.preventDefault();
      e.stopPropagation();
      selection.clear();
    }
  };
  // A button clicks on Space's keyup; Space only toggles selection here (FR-505).
  const onListKeyUp = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === " " && (e.target as HTMLElement).dataset?.rowKey) e.preventDefault();
  };

  const fileContextMenuItems: ContextMenuItem[] = useMemo(() => {
    if (!fileContextMenu) return [];
    const targets = fileContextMenu.rows;
    // The popover opens where the menu was, so the eye does not travel.
    const at: PopoverAnchor = { x: fileContextMenu.x, y: fileContextMenu.y, yAbove: fileContextMenu.y };
    if (uniquePathCount(targets) > 1) {
      const entry = (action: BulkAction, verb: string, ellipsis: boolean, run: () => void): ContextMenuItem => {
        const e = eligibility(action, targets);
        const skippedNote = e.skipped.length > 0 ? `${e.skipped.length} skipped: ${e.skipped[0]!.reason}` : undefined;
        return {
          label: `${verb} ${plural(e.eligible.length, "file")}${ellipsis ? "…" : ""}`,
          disabled: e.eligible.length === 0,
          title: e.eligible.length === 0 ? e.skipped[0]?.reason : skippedNote,
          onSelect: run,
        };
      };
      return [
        entry("stage", "Stage", false, () => void runBulkStage("stage", targets)),
        entry("unstage", "Unstage", false, () => void runBulkStage("unstage", targets)),
        entry("discard", "Discard", true, () => openBulkDiscard(targets)),
        entry("ignore", "Ignore", true, () => openIgnore(targets, at)),
      ];
    }
    const row = targets[0]!;
    const blame: ContextMenuItem =
      row.section === "untracked"
        ? { label: "Blame", disabled: true, title: "Never committed — nothing to blame yet." }
        : row.section === "conflicted"
          ? { label: "Blame", disabled: true, title: "Resolve this file's conflicts before blaming it." }
          : {
              // staged/unstaged: blames the working-tree content (revision: null), per FR-131.
              label: "Blame",
              disabled: !onOpenBlame,
              title: onOpenBlame ? undefined : "Blame is unavailable here.",
              onSelect: onOpenBlame ? () => onOpenBlame(row.path, null) : undefined,
            };
    const ignoreReason = eligibility("ignore", [row]).skipped[0]?.reason;
    const verdict = menuEditVerdict?.path === row.path ? menuEditVerdict.reason : "pending";
    const editReason = editing?.path === row.path ? ALREADY_EDITING_REASON : verdict === "pending" ? CHECKING_FILE_REASON : verdict;
    const edit: ContextMenuItem = editReason
      ? { label: "Edit file", disabled: true, title: editReason }
      : {
          label: "Edit file",
          onSelect: () => {
            const go = () => {
              if (row.section !== "conflicted") selectDiffableFile(row.section, row.entry);
              setActiveConflictPath(null);
              setEditing({ path: row.path, open: {} });
            };
            if (editing) leaveEditorThen(go);
            else go();
          },
        };
    return [
      edit,
      blame,
      ignoreReason
        ? { label: "Ignore…", disabled: true, title: ignoreReason }
        : { label: "Ignore…", onSelect: () => openIgnore([row], at) },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileContextMenu, onOpenBlame, ignore.begin, menuEditVerdict, editing]);

  // The open diff's row is the one in the diff's own section; if a toggle just emptied that section the file's
  // remaining row takes over (FR-482), so a checkbox-diff file never reads as having no open row.
  const isRowSelected = (category: SectionConfig["category"], path: string) =>
    activeConflictPath === null &&
    panel.selected?.path === path &&
    (panel.selected.category === category || (panel.combined?.path === path && !rowByKey.has(`${panel.selected.category}:${path}`)));

  const combinedControls = useMemo(
    () =>
      panel.combined
        ? {
            hunks: panel.combined.hunks,
            busy: panel.partialBusy,
            onToggleLines: panel.toggleLines,
            onToggleHunk: panel.toggleHunk,
            onDiscardLines: panel.requestDiscardLines,
            onDiscardHunk: panel.requestDiscardHunk,
            onActiveHunkChange: setActiveHunk,
            onContextMenuOpenChange: setDiffMenuOpen,
          }
        : null,
    [panel.combined, panel.partialBusy, panel.toggleLines, panel.toggleHunk, panel.requestDiscardLines, panel.requestDiscardHunk],
  );

  const canStageAll = (panel.changes?.unstaged.length ?? 0) + (panel.changes?.untracked.length ?? 0) > 0;
  const canUnstageAll = (panel.changes?.staged.length ?? 0) > 0;
  // A plain click selects one row (it only opens its diff), so section buttons re-label from two selected rows, like the bulk bar.
  const multi = selectedCount >= 2;
  const stageSel = multi && bulkEligibility.stage.eligible.length > 0;
  const unstageSel = multi && bulkEligibility.unstage.eligible.length > 0;


  // --- specs/edit-in-diff.md: eligibility (FR-468), entry (FR-467), row locks (FR-531) ---
  const openPath = activeConflictPath === null && !panel.selectedGone ? (panel.selected?.path ?? null) : null;
  // The file-level conflict view is also probed, so the palette's Edit file can open the editor from it (FR-556).
  const eligibility_ = useEditEligibility(api, activeConflictPath ?? openPath, liveRevision);
  const editControls: DiffEditControls | null =
    openPath === null || panel.selected === null
      ? null
      : {
          disabledReason: eligibility_.status === "ineligible" ? eligibility_.reason : null,
          pending: eligibility_.status === "pending" || eligibility_.status === "none",
          hint:
            panel.selected.category === "staged" && eligibility_.status === "eligible" && eligibility_.hasStagedContent
              ? "Edit the working copy (opens the combined diff first). Your staged version is not changed. Also: E."
              : "Edit this file. Also: E, or double-click a line.",
          activeHunkIndex: activeHunk,
          // The separate Staged diff numbers INDEX lines; only the combined diff and the Unstaged/Untracked diffs are in working-file lines.
          workingLinesValid: !(panel.selected.category === "staged" && !panel.combined),
          onEdit: (open) => setEditing({ path: openPath, open }),
        };
  editCommandsRef.current.edit = () => {
    if (editing) return;
    if (activeConflictPath !== null) {
      if (eligibility_.status !== "eligible") return;
      const path = activeConflictPath;
      setActiveConflictPath(null);
      setEditing({ path, open: {} });
      return;
    }
    if (!editControls || editControls.pending || editControls.disabledReason) return;
    editControls.onEdit({});
  };
  // specs/edit-in-diff.md FR-569: Changes-list order of the unmerged files, remembered while one is open so "next" still
  // means "the file after this one" once the resolved file has left the list.
  const conflictedPaths = useMemo(() => (panel.changes?.conflicted ?? []).map((f) => f.path), [panel.changes]);
  const conflictOrderRef = useRef<string[]>([]);
  if (editing && conflictedPaths.includes(editing.path)) conflictOrderRef.current = conflictedPaths;
  const currentConflictPath = editing?.path ?? activeConflictPath;
  const nextConflictPath = (() => {
    const rest = conflictedPaths.filter((p) => p !== currentConflictPath);
    if (rest.length === 0) return null;
    const at = currentConflictPath ? conflictOrderRef.current.indexOf(currentConflictPath) : -1;
    if (at >= 0) for (const p of conflictOrderRef.current.slice(at + 1)) if (rest.includes(p)) return p;
    return rest[0]!;
  })();
  const noopContinue = useMemo<ContinueOperation>(() => ({ run: () => {}, isContinuing: false, error: null, clearError: () => {} }), []);
  const flowContinue = continueOp ?? noopContinue;
  const openNextConflict = () => {
    const next = nextConflictPath;
    if (next) leaveEditorThen(() => void openConflictFile(next));
  };
  conflictFlowRef.current = {
    openNext: () => {
      if (nextConflictPath && (editing || activeConflictPath)) openNextConflict();
    },
    continueNow: () => {
      if (operationLabel && conflictedPaths.length === 0 && !blockConflictActions) flowContinue.run();
    },
    resolveInEditor: () => {
      const target = activeConflictPath ?? conflictedPaths[0];
      if (!target || (editing && editing.path === target)) return;
      leaveEditorThen(() => void openConflictFile(target));
    },
  };
  const conflictFlow: ConflictFlow = {
    conflictedPaths,
    operation: operationLabel,
    nextPath: nextConflictPath,
    onOpenNext: openNextConflict,
    continueOp: flowContinue,
  };
  const editCommandReasons: EditCommandReasons = useMemo(() => {
    const ec = editorCommandState;
    const edit = editing
      ? ALREADY_EDITING_REASON
      : activeConflictPath !== null
        ? eligibility_.status === "eligible"
          ? null
          : eligibility_.status === "ineligible"
            ? eligibility_.reason
            : CHECKING_FILE_REASON
        : editControls === null
        ? NO_FILE_TO_EDIT_REASON
        : editControls.pending
          ? CHECKING_FILE_REASON
          : editControls.disabledReason;
    const save = !editing ? NO_EDITOR_REASON : !ec?.ready ? "The file is still loading." : ec.canSave ? null : NO_EDITS_REASON;
    const saveAndStage = !editing
      ? NO_EDITOR_REASON
      : !ec?.ready
        ? "The file is still loading."
        : ec.canSaveAndStage
          ? null
          : ec.conflict
            ? (ec.stageBlockedReason ?? "Saving, or resolve the change on disk first.")
            : ec.dirty
              ? "Saving, or resolve the change on disk first."
              : NO_EDITS_REASON;
    const conflictNav = !editing || !ec?.ready || !ec.conflict ? NO_CONFLICT_REASON : ec.conflictCount === 0 ? "No conflicts left in this file." : null;
    const markResolved = editing && ec?.conflict ? saveAndStage : NO_CONFLICT_REASON;
    const here = editing?.path ?? activeConflictPath;
    const otherConflicted = conflictedPaths.filter((p) => p !== here).length;
    const nextConflictedFile = conflictedPaths.length === 0 ? NO_CONFLICTED_FILES_REASON : otherConflicted === 0 ? "No other conflicted files." : null;
    const continueOperation = !operationLabel
      ? NO_OPERATION_REASON
      : conflictedPaths.length > 0
        ? `${plural(conflictedPaths.length, "conflicted file")} still unresolved.`
        : blockConflictActions
          ? BLOCKED_REASON
          : null;
    const resolveInEditor =
      conflictedPaths.length === 0
        ? NO_CONFLICTED_FILES_REASON
        : editing && ec?.conflict && conflictedPaths.includes(editing.path)
          ? "Already resolving this file."
          : null;
    return {
      edit,
      save,
      saveAndStage,
      stagedContent: ec?.stagedContent ?? false,
      conflict: ec?.conflict ?? false,
      nextConflict: conflictNav,
      prevConflict: conflictNav,
      markResolved,
      nextConflictedFile,
      continueOperation,
      resolveInEditor,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, editorCommandState, editControls?.pending, editControls?.disabledReason, editControls === null, activeConflictPath, eligibility_, conflictedPaths.join("|"), operationLabel, blockConflictActions]);
  const reportedEditRef = useRef<EditCommandReasons | null>(null);
  useEffect(() => {
    const prev = reportedEditRef.current;
    if (
      prev &&
      prev.edit === editCommandReasons.edit &&
      prev.save === editCommandReasons.save &&
      prev.saveAndStage === editCommandReasons.saveAndStage &&
      prev.stagedContent === editCommandReasons.stagedContent &&
      prev.conflict === editCommandReasons.conflict &&
      prev.nextConflict === editCommandReasons.nextConflict &&
      prev.markResolved === editCommandReasons.markResolved &&
      prev.nextConflictedFile === editCommandReasons.nextConflictedFile &&
      prev.continueOperation === editCommandReasons.continueOperation &&
      prev.resolveInEditor === editCommandReasons.resolveInEditor
    )
      return;
    reportedEditRef.current = editCommandReasons;
    onEditCommandsChange?.(editCommandReasons);
  }, [editCommandReasons, onEditCommandsChange]);
  const dirtyPath = editing && editDirty ? editing.path : null;
  const blockedMessage = () => setLiveMessage(DIRTY_ROW_REASON);
  const indexDiffers =
    editing !== null &&
    ((panel.changes?.unstaged.some((f) => f.path === editing.path) ?? false) || (panel.changes?.untracked.some((f) => f.path === editing.path) ?? false));
  const afterEditSaved = useCallback(() => onWorkingDirChanged(), [onWorkingDirChanged]);

  const diffFileLabel = panel.selected?.path ?? "No file selected";
  // Must-have #4/#5: distinguish "nothing diffable at all" (e.g. a mid-merge working directory
  // with only Conflicted paths, AC5) from the generic "nothing selected yet" idle placeholder —
  // true once auto-select (in useChangesPanel) has had nothing to select.
  const hasDiffableFiles =
    (panel.changes?.staged.length ?? 0) + (panel.changes?.unstaged.length ?? 0) + (panel.changes?.untracked.length ?? 0) >
    0;

  return (
    <aside
      className={`gh-changes-panel${editing ? " gh-changes-panel--editing" : ""}`}
      aria-label="Changes"
      role="complementary"
      style={{ width: panelWidth.width }}
    >
      <ResizeHandle label="Resize Changes panel" {...panelWidth.separatorProps} onDoubleClick={panelWidth.reset} />
      <div className="gh-changes-panel__header">
        <h2 className="gh-changes-panel__title">Changes</h2>
        <button
          type="button"
          className="gh-changes-panel__close"
          onClick={() => leaveEditorThen(onClose)}
          aria-label="Close changes panel"
        >
          ×
        </button>
      </div>

      {/* ROADMAP.md tech-debt fix: `useChangesPanel` no longer fetches its own data (see its doc
          comment), so there is no independent "loading"/"error" state left to render here — the
          `changes` prop it's fed is owned by `useRepositoryGraph`, and a failure fetching it
          surfaces as `graph.status === "error"` (this component isn't even mounted then; see the
          `graph.status === "ready"` render gate in App.tsx). */}
      {panel.status === "bare" && (
        <div className="gh-changes-panel__body">
          {/* AC10: a bare repo has no working directory — an explicit state, not an error or a
              blank panel. */}
          <p className="gh-changes-panel__status">
            This is a bare repository — it has no working directory, so there are no changes to
            stage, unstage, or commit.
          </p>
        </div>
      )}

      {panel.status === "ready" && sections && (
        <div
          className="gh-changes-panel__body gh-changes-panel__body--ready"
          style={{ ["--gh-files-w" as string]: `${editing ? Math.max(fileListWidth.width, RAIL_OVERLAY_MIN_WIDTH) : fileListWidth.width}px` }}
        >
          {/* FR-532: while editing this column is a 44px rail by WIDTH ONLY (CSS); it stays mounted and laid out. */}
          <div
            className="gh-changes-panel__files"
            style={editing ? undefined : { width: fileListWidth.width }}
            aria-label={editing ? "Changed files" : undefined}
            role={editing ? "region" : undefined}
          >
            {panel.actionError && (
              <p className="gh-changes-panel__status gh-changes-panel__status--error" role="alert">
                {panel.actionError}{" "}
                <button type="button" className="gh-changes-panel__dismiss" onClick={panel.dismissActionError}>
                  Dismiss
                </button>
              </p>
            )}

            <div className="gh-changes-panel__scroll" ref={filesRootRef} onKeyDown={onListKeyDown} onKeyUp={onListKeyUp}>
            {sections.map((section) => {
              const win = windowing.windowFor(section.category, section.entries.length);
              return (
              <section key={section.category} className="gh-changes-panel__section">
                {section.category === "conflicted" && stashConflictNotice && (
                  <p className="gh-changes-panel__status gh-changes-panel__stash-notice" role="status">
                    {stashConflictNotice.action === "apply"
                      ? "Applying stash left conflicts to resolve — the stash was not removed from the list."
                      : "Popping stash left conflicts to resolve — the stash was not removed from the list."}{" "}
                    <button
                      type="button"
                      className="gh-changes-panel__dismiss"
                      onClick={onDismissStashConflictNotice}
                    >
                      Dismiss
                    </button>
                  </p>
                )}
                <div className="gh-changes-panel__section-head">
                  <h3
                    className="gh-changes-panel__section-heading"
                    title={
                      partlyStaged.size === 0
                        ? undefined
                        : section.category === "staged"
                          ? "A partly staged file also appears under Unstaged."
                          : section.category === "unstaged"
                            ? "A partly staged file also appears under Staged."
                            : undefined
                    }
                  >
                    {section.label} ({section.entries.length})
                  </h3>
                  {section.category === "staged" && (
                    <button
                      type="button"
                      className={`gh-changes-panel__head-btn${unstageSel ? " gh-changes-panel__head-btn--sel" : ""}`}
                      onClick={() => (unstageSel ? void runBulkStage("unstage", selectedRows) : panel.unstageAll())}
                      disabled={!canUnstageAll}
                      aria-label={unstageSel ? `Unstage ${bulkEligibility.unstage.eligible.length} selected` : undefined}
                      title={unstageSel ? `Unstage ${bulkEligibility.unstage.eligible.length} selected` : undefined}
                    >
                      {unstageSel ? `Unstage ${bulkEligibility.unstage.eligible.length}` : "Unstage all"}
                    </button>
                  )}
                  {section.category === "unstaged" && (
                    <>
                      <button
                        type="button"
                        className={`gh-changes-panel__head-btn${stageSel ? " gh-changes-panel__head-btn--sel" : ""}`}
                        onClick={() => (stageSel ? void runBulkStage("stage", selectedRows) : panel.stageAll())}
                        disabled={!canStageAll}
                        aria-label={stageSel ? `Stage ${bulkEligibility.stage.eligible.length} selected` : undefined}
                        title={stageSel ? `Stage ${bulkEligibility.stage.eligible.length} selected` : "Stage all changes, including untracked files"}
                      >
                        {stageSel ? `Stage ${bulkEligibility.stage.eligible.length}` : "Stage all"}
                      </button>
                      <button
                        type="button"
                        className="gh-changes-panel__head-btn gh-changes-panel__head-btn--icon"
                        aria-label="Unstaged section actions"
                        aria-haspopup="menu"
                        title="Unstaged section actions"
                        onClick={(e) => {
                          const r = e.currentTarget.getBoundingClientRect();
                          rememberFocus(e.currentTarget);
                          setHeaderMenu({ x: Math.max(8, r.right - 220), y: r.bottom + 2 });
                        }}
                      >
                        <span aria-hidden="true">⋯</span>
                      </button>
                    </>
                  )}
                </div>
                {section.entries.length > 0 && (
                  <ul
                    ref={windowing.listRef(section.category)}
                    className="gh-changes-panel__file-list"
                    role="grid"
                    aria-multiselectable="true"
                    aria-label={`${section.label} files`}
                    aria-rowcount={section.entries.length}
                    style={listPadding(win, section.entries.length)}
                  >
                    {section.entries.slice(win.start, win.end).map((entry, offset) => {
                      const rowIndex = win.start + offset + 1;
                      const row = rowByKey.get(`${section.category}:${entry.path}`)!;
                      const selected = selection.isSelected(row.key);
                      return (
                        <li
                          key={row.key}
                          role="row"
                          aria-rowindex={rowIndex}
                          aria-selected={selected}
                          data-actions={section.category === "conflicted" ? 0 : section.category === "staged" || row.isDir ? 1 : 2}
                          className={`gh-changes-panel__file${selected ? " gh-changes-panel__file--selected" : ""}`}
                          onContextMenu={(e) => onRowContextMenu(e, row)}
                        >
                          {/* FR-513: selection is a drawn check (CSS ::before) plus a bar, never colour alone. */}
                          {section.category === "conflicted" ? (
                            // FR-72: a conflicted row is clickable — opens the resolution view in
                            // the diff column (superseding the previously non-interactive label).
                            <span role="gridcell" className="gh-changes-panel__cell">
                              <button
                                type="button"
                                data-row-key={row.key}
                                className={`gh-changes-panel__file-label gh-changes-panel__file-label--button${
                                  activeConflictPath === entry.path || editing?.path === entry.path ? " gh-changes-panel__file-label--selected" : ""
                                }`}
                                aria-pressed={activeConflictPath === entry.path || editing?.path === entry.path}
                                onMouseDown={(e) => e.shiftKey && e.preventDefault()}
                                onClick={(e) => onRowClick(e, row)}
                              >
                                <FileStatusIcon status={entry.status} />
                                <FilePath path={entry.path} />
                              </button>
                            </span>
                          ) : (
                            <>
                              <span role="gridcell" className="gh-changes-panel__cell">
                                <button
                                  type="button"
                                  data-row-key={row.key}
                                  className={`gh-changes-panel__file-label gh-changes-panel__file-label--button${
                                    isRowSelected(section.category, entry.path) ? " gh-changes-panel__file-label--selected" : ""
                                  }`}
                                  aria-pressed={isRowSelected(section.category, entry.path)}
                                  onMouseDown={(e) => e.shiftKey && e.preventDefault()}
                                  onClick={(e) => onRowClick(e, row)}
                                >
                                  <FileStatusIcon status={entry.status} />
                                  {row.mixed && (
                                    <span
                                      className="gh-changes-panel__mixed"
                                      role="img"
                                      aria-label={`Partly staged: ${section.category === "staged" ? "staged" : "unstaged"} part`}
                                      title={`Partly staged: ${section.category === "staged" ? "staged" : "unstaged"} part`}
                                    />
                                  )}
                                  {dirtyPath === entry.path && (
                                    <span className="gh-changes-panel__unsaved">
                                      <span className="gh-changes-panel__unsaved-dot" aria-hidden="true" />
                                      <span className="gh-visually-hidden">Unsaved changes</span>
                                    </span>
                                  )}
                                  <FilePath path={entry.path} oldPath={entry.oldPath} />
                                </button>
                              </span>
                              <span
                                role="gridcell"
                                className={`gh-changes-panel__file-actions${dirtyPath === entry.path ? " gh-changes-panel__file-actions--blocked" : ""}`}
                              >
                                {section.category === "staged" && (
                                  <button
                                    type="button"
                                    title={dirtyPath === entry.path ? DIRTY_ROW_REASON : `Unstage ${entry.path}`}
                                    aria-disabled={dirtyPath === entry.path || undefined}
                                    onClick={() => (dirtyPath === entry.path ? blockedMessage() : panel.unstage(entry))}
                                  >
                                    <ActionIcon kind="unstage" />
                                    <span className="gh-visually-hidden">Unstage{dirtyPath === entry.path ? `. ${DIRTY_ROW_REASON}` : ""}</span>
                                  </button>
                                )}
                                {(section.category === "unstaged" || section.category === "untracked") && (
                                  <>
                                    <button
                                      type="button"
                                      title={
                                        dirtyPath === entry.path
                                          ? DIRTY_ROW_REASON
                                          : row.partlyStaged
                                            ? `Stage the rest of ${entry.path}`
                                            : `Stage ${entry.path}`
                                      }
                                      aria-disabled={dirtyPath === entry.path || undefined}
                                      onClick={() =>
                                        dirtyPath === entry.path
                                          ? blockedMessage()
                                          : panel.stage(entry, section.category as "unstaged" | "untracked")
                                      }
                                    >
                                      <ActionIcon kind="stage" />
                                      <span className="gh-visually-hidden">Stage{dirtyPath === entry.path ? `. ${DIRTY_ROW_REASON}` : ""}</span>
                                    </button>
                                    {!row.isDir && (
                                    <button
                                      type="button"
                                      className="gh-changes-panel__discard"
                                      title={
                                        dirtyPath === entry.path
                                          ? DIRTY_ROW_REASON
                                          : row.partlyStaged
                                            ? `Discard unstaged changes to ${entry.path}`
                                            : `Discard ${entry.path}`
                                      }
                                      aria-disabled={dirtyPath === entry.path || undefined}
                                      onClick={() =>
                                        dirtyPath === entry.path
                                          ? blockedMessage()
                                          : panel.requestDiscard(section.category as "unstaged" | "untracked", entry.path)
                                      }
                                      aria-label={
                                        dirtyPath === entry.path
                                          ? `Discard changes to ${entry.path}. ${DIRTY_ROW_REASON}`
                                          : row.partlyStaged
                                            ? `Discard unstaged changes to ${entry.path}`
                                            : `Discard changes to ${entry.path}`
                                      }
                                    >
                                      <ActionIcon kind="discard" />
                                    </button>
                                    )}
                                  </>
                                )}
                              </span>
                            </>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
              );
            })}
            </div>

            {selectedCount >= 2 && (
              <BulkBar
                selectedCount={selectedCount}
                eligibility={bulkEligibility}
                busy={panel.partialBusy}
                onDiscard={() => openBulkDiscard(selectedRows)}
                onIgnore={(anchor) => openIgnore(selectedRows, anchorOf(anchor), anchor)}
                onClear={selection.clear}
              />
            )}

            {/* FR-489: pinned below the scrolling list, so the subject stays visible with any number of files. */}
            <form
              className="gh-changes-panel__composer"
              onSubmit={(e) => {
                e.preventDefault();
                panel.submitCommit();
              }}
              onFocus={() => setComposerFocused(true)}
              onBlur={onComposerBlur}
              onPointerDown={() => {
                pointerInComposer.current = true;
              }}
              onPointerUp={() => {
                pointerInComposer.current = false;
              }}
              onPointerCancel={() => {
                pointerInComposer.current = false;
              }}
            >
              <label className="gh-visually-hidden" htmlFor="gh-commit-subject">
                Subject
              </label>
              <input
                id="gh-commit-subject"
                type="text"
                value={panel.subject}
                onChange={(e) => panel.setSubject(e.target.value)}
                onKeyDown={(e) => {
                  // A single-line text input inside a <form> submits on plain Enter by default
                  // (HTML's implicit-submission behavior) — that would create a real commit
                  // without the user ever clicking "Commit". Require the explicit click instead.
                  if (e.key === "Enter") e.preventDefault();
                }}
                placeholder="Summarize this commit"
                required
              />
              <div className="gh-changes-panel__composer-more" hidden={!composerExpanded}>
                <label className="gh-visually-hidden" htmlFor="gh-commit-body">
                  Body (optional)
                </label>
                <textarea
                  id="gh-commit-body"
                  value={panel.body}
                  onChange={(e) => panel.setBody(e.target.value)}
                  placeholder="Body (optional)"
                  rows={3}
                />
                {/* specs/amend-last-commit.md FR-155/156/157 */}
                <label className="gh-changes-panel__amend" title={amendDisabledReason ?? undefined}>
                  <input
                    type="checkbox"
                    checked={panel.amend}
                    disabled={amendDisabledReason !== null}
                    onChange={(e) => panel.setAmend(e.target.checked)}
                  />
                  Amend last commit
                </label>
              </div>
              {panel.commitError && (
                <p className="gh-changes-panel__status gh-changes-panel__status--error" role="alert">
                  {panel.commitError}
                </p>
              )}
              <button type="submit" className="gh-changes-panel__commit" disabled={!panel.canCommit}>
                {panel.isCommitting
                  ? panel.amend
                    ? "Amending…"
                    : "Committing…"
                  : panel.amend
                    ? "Amend Commit"
                    : "Commit"}
              </button>
            </form>
          </div>

          {!editing && <ResizeHandle label="Resize file list" {...fileListWidth.separatorProps} onDoubleClick={fileListWidth.reset} />}

          <div ref={diffColumnRef} className={`gh-changes-panel__diff${editing ? " gh-changes-panel__diff--editing" : ""}`}>
            {/* D9/FR-502: one line beside the diff, announced politely (assertively for a failure); no undo. */}
            {panelNotice && (
              <p
                className={`gh-changes-panel__notice gh-changes-panel__notice--${panelNotice.tone}`}
                role={panelNotice.tone === "error" ? "alert" : "status"}
              >
                <span>{panelNotice.text}</span>{" "}
                <button type="button" className="gh-changes-panel__dismiss" onClick={dismissPanelNotice}>
                  Dismiss
                </button>
              </p>
            )}
            {editing ? (
              <EditorPane
                key={editing.open.restore ? `${editing.path}:restore` : editing.path}
                api={api}
                path={editing.path}
                open={editing.open}
                guard={guard}
                liveRevision={liveRevision}
                indexDiffersFromWorkingCopy={indexDiffers}
                lineWasStaged={panel.separateReason === "ambiguous" && panel.selected?.path === editing.path}
                onClose={closeEditor}
                onSaved={afterEditSaved}
                onResolved={conflictResolved}
                onMutationStart={onMutationStart}
                onMutationSettled={onMutationSettled}
                blockActions={blockConflictActions}
                conflictFlow={conflictFlow}
                onDirtyChange={setEditDirty}
                commandsRef={editorCommandsRef}
                onCommandStateChange={setEditorCommandState}
                onDialogOpenChange={setEditDialogOpen}
                repoPath={repoKey}
              />
            ) : activeConflictPath ? (
              <ConflictResolutionView
                api={api}
                path={activeConflictPath}
                onClose={() => setActiveConflictPath(null)}
                onResolved={conflictResolved}
                onMutationStart={onMutationStart}
                onMutationSettled={onMutationSettled}
                blockActions={blockConflictActions}
                onResolveInEditor={() => void openConflictFile(activeConflictPath)}
                onDialogOpenChange={setConflictDialogOpen}
              />
            ) : (
              <DiffView
                fileLabel={diffFileLabel}
                loading={panel.diff.status === "loading" || panel.imageDiff.status === "loading"}
                errorMessage={
                  panel.diff.status === "error"
                    ? panel.diff.message
                    : panel.imageDiff.status === "error"
                      ? panel.imageDiff.message
                      : null
                }
                result={panel.diff.status === "ready" ? panel.diff.result : null}
                imageResult={panel.imageDiff.status === "ready" ? panel.imageDiff.result : null}
                emptyMessage={
                  panel.selectedGone ? "This file no longer has changes." : hasDiffableFiles ? undefined : "No diff found."
                }
                notice={panel.diffNotice}
                error={panel.partialError}
                onDismissError={panel.dismissPartialError}
                announcement={panel.partialAnnouncement}
                combined={combinedControls}
                separateNote={panel.separateReason === "ambiguous" ? "Line-level staging unavailable for this file." : null}
                edit={editControls}
              />
            )}
          </div>
        </div>
      )}

      <p className="gh-visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {liveMessage}
      </p>

      {bulkDiscard.pending && (
        <BulkDiscardDialog
          state={bulkDiscard.pending}
          api={api}
          entries={entryByPath}
          canConfirm={bulkDiscard.canConfirm}
          onIncludeUntracked={bulkDiscard.setIncludeUntracked}
          onTyped={bulkDiscard.setTyped}
          onConfirm={bulkDiscard.confirm}
          onCancel={bulkDiscard.cancel}
        />
      )}

      {ignore.pending && ignoreImpact && (
        <IgnorePopover
          state={ignore.pending}
          impact={ignoreImpact}
          onScope={ignore.setScope}
          onTarget={ignore.setTarget}
          onApply={ignore.apply}
          onCancel={ignore.cancel}
        />
      )}

      {panel.pendingDiscard && (
        <ConfirmDialog
          title="Discard changes?"
          message={`Discard changes to "${panel.pendingDiscard.path}"? This cannot be undone.${
            panel.pendingDiscard.category === "unstaged" && partlyStaged.has(panel.pendingDiscard.path)
              ? " Only the unstaged part is discarded; the staged part is untouched."
              : ""
          }`}
          confirmLabel="Discard"
          destructive
          confirmDisabled={Boolean(panel.pendingDiscard.stale || panel.pendingDiscard.busy || panel.pendingDiscard.error)}
          notice={
            panel.pendingDiscard.stale
              ? "This file changed since you opened this. Cancel and review again."
              : panel.pendingDiscard.error
          }
          onConfirm={panel.confirmDiscard}
          onCancel={panel.cancelDiscard}
        />
      )}

      {/* specs/hunk-line-staging.md FR-455: names the file and the count, says it's unrecoverable; reuses
          FR-31's dialog so there is no single-click destructive path. */}
      {panel.pendingPartialDiscard && (
        <ConfirmDialog
          title="Discard changes?"
          message={partialDiscardMessage(panel.pendingPartialDiscard)}
          confirmLabel={
            panel.pendingPartialDiscard.hunks > 0
              ? `Discard ${panel.pendingPartialDiscard.hunks === 1 ? "hunk" : `${panel.pendingPartialDiscard.hunks} hunks`}`
              : `Discard ${panel.pendingPartialDiscard.count} line${panel.pendingPartialDiscard.count === 1 ? "" : "s"}`
          }
          destructive
          initialFocus="cancel"
          onConfirm={panel.confirmPartialDiscard}
          onCancel={panel.cancelPartialDiscard}
        />
      )}

      {/* specs/amend-last-commit.md FR-158/159: shown instead of submitting immediately when the
          current branch has a present, non-gone upstream with nothing of HEAD unpushed yet — purely
          informational (no push automation exists here), mirrors FR-31's discard-confirmation
          pattern (an explicit step, never a silent refusal, never a silent auto-proceed). */}
      {panel.pendingAmendWarning && (
        <ConfirmDialog
          title="Amend a possibly-shared commit?"
          message="The current commit appears to already be pushed to its upstream. Amending it will replace it with a new commit SHA, which can cause problems for anyone who has already fetched it."
          confirmLabel="Amend Anyway"
          destructive
          onConfirm={panel.confirmAmendWarning}
          onCancel={panel.cancelAmendWarning}
        />
      )}

      {headerMenu && (
        <ContextMenu
          x={headerMenu.x}
          y={headerMenu.y}
          ariaLabel="Unstaged section actions"
          items={[
            {
              label: "Discard all changes…",
              disabled: commandReasons.discardAll !== null,
              title: commandReasons.discardAll ?? undefined,
              onSelect: openDiscardAll,
            },
          ]}
          onClose={() => setHeaderMenu(null)}
        />
      )}

      {fileContextMenu && (
        <ContextMenu
          x={fileContextMenu.x}
          y={fileContextMenu.y}
          ariaLabel={
            fileContextMenu.rows.length > 1
              ? `Actions for ${plural(fileContextMenu.rows.length, "selected file")}`
              : `Actions for ${fileContextMenu.rows[0]?.path ?? "file"}`
          }
          items={fileContextMenuItems}
          onClose={closeFileMenu}
        />
      )}
    </aside>
  );
});
