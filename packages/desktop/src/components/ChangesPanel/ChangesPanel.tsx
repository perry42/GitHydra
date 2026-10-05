// SPDX-License-Identifier: GPL-3.0-or-later
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type FocusEvent } from "react";
import type { WorkingDirectoryChanges, WorkingDirectoryFileChange } from "@githydra/git-core";
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
import { DiffView } from "../DiffView/DiffView";
import { FileStatusIcon } from "../FileStatusIcon/FileStatusIcon";
import { FilePath } from "./FilePath";
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
}

interface SectionConfig {
  category: DiffableCategory | "conflicted";
  label: string;
  entries: WorkingDirectoryFileChange[];
}

/** specs/hunk-line-staging.md FR-455: same "cannot be undone" wording as the file-level discard dialog. */
/** Icon shown in place of the text label when the row is narrow (container query in ChangesPanel.css). */
function ActionIcon({ kind }: { kind: "stage" | "unstage" | "discard" }) {
  const d = kind === "stage" ? "M8 3v10M3 8h10" : kind === "unstage" ? "M3 8h10" : "M4 4l8 8M12 4l-8 8";
  return (
    <svg className="gh-changes-panel__action-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
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
  // specs/blame.md FR-131: right-click state for a Staged/Unstaged/Untracked/Conflicted row's new
  // "Blame" context menu.
  // specs/hunk-line-staging.md FR-453: the diff's line/hunk context menu, reported up so it joins the
  // same "a menu is open" signal as `fileContextMenu` below.
  const [diffMenuOpen, setDiffMenuOpen] = useState(false);
  const [fileContextMenu, setFileContextMenu] = useState<{
    x: number;
    y: number;
    category: SectionConfig["category"];
    path: string;
  } | null>(null);

  // security-reviewer finding / test-agent finding: reports on every change — a plain
  // pass-through, not a duplicated computation — see `onDialogOpenChange`'s own doc comment on the
  // props type for why `fileContextMenu` is ORed in here alongside the two ConfirmDialogs.
  useEffect(() => {
    onDialogOpenChange?.(
      panel.pendingDiscard !== null ||
        panel.pendingPartialDiscard !== null ||
        panel.pendingAmendWarning ||
        fileContextMenu !== null ||
        diffMenuOpen,
    );
  }, [panel.pendingDiscard, panel.pendingPartialDiscard, panel.pendingAmendWarning, fileContextMenu, diffMenuOpen, onDialogOpenChange]);

  const fileContextMenuItems: ContextMenuItem[] = useMemo(() => {
    if (!fileContextMenu) return [];
    const { category, path } = fileContextMenu;
    if (category === "untracked") {
      return [{ label: "Blame", disabled: true, title: "Never committed — nothing to blame yet." }];
    }
    if (category === "conflicted") {
      return [{ label: "Blame", disabled: true, title: "Resolve this file's conflicts before blaming it." }];
    }
    // staged/unstaged: blames the working-tree content (revision: null), per FR-131.
    return [
      {
        label: "Blame",
        disabled: !onOpenBlame,
        title: onOpenBlame ? undefined : "Blame is unavailable here.",
        onSelect: onOpenBlame ? () => onOpenBlame(path, null) : undefined,
      },
    ];
  }, [fileContextMenu, onOpenBlame]);
  const selectDiffableFile = useCallback(
    (category: DiffableCategory, entry: WorkingDirectoryFileChange) => {
      setActiveConflictPath(null);
      panel.selectFile(category, entry);
    },
    [panel],
  );
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

  // FR-482/FR-488: an eligible partly staged file shows once, in Unstaged, with the mixed marker; its Staged
  // entry is hidden here (git-core's own list still reports both, FR-19).
  const mixedPaths = panel.mixedPaths;
  const sections: SectionConfig[] | null = panel.changes
    ? [
        { category: "staged", label: "Staged", entries: panel.changes.staged.filter((e) => !mixedPaths.has(e.path)) },
        { category: "unstaged", label: "Unstaged", entries: panel.changes.unstaged },
        { category: "untracked", label: "Untracked", entries: panel.changes.untracked },
        { category: "conflicted", label: "Conflicted", entries: panel.changes.conflicted },
      ]
    : null;

  // A checkbox-diff file appears once, so its row is "selected" whichever section it sits in right now
  // (a toggle can move it between Staged and Unstaged before the user clicks anything).
  const isRowSelected = (category: SectionConfig["category"], path: string) =>
    activeConflictPath === null &&
    panel.selected?.path === path &&
    (panel.selected.category === category || panel.combined?.path === path);

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

  const diffFileLabel = panel.selected?.path ?? "No file selected";
  // Must-have #4/#5: distinguish "nothing diffable at all" (e.g. a mid-merge working directory
  // with only Conflicted paths, AC5) from the generic "nothing selected yet" idle placeholder —
  // true once auto-select (in useChangesPanel) has had nothing to select.
  const hasDiffableFiles =
    (panel.changes?.staged.length ?? 0) + (panel.changes?.unstaged.length ?? 0) + (panel.changes?.untracked.length ?? 0) >
    0;

  return (
    <aside className="gh-changes-panel" aria-label="Changes" role="complementary" style={{ width: panelWidth.width }}>
      <ResizeHandle label="Resize Changes panel" {...panelWidth.separatorProps} onDoubleClick={panelWidth.reset} />
      <div className="gh-changes-panel__header">
        <h2 className="gh-changes-panel__title">Changes</h2>
        <button type="button" className="gh-changes-panel__close" onClick={onClose} aria-label="Close changes panel">
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
        <div className="gh-changes-panel__body gh-changes-panel__body--ready">
          <div className="gh-changes-panel__files" style={{ width: fileListWidth.width }}>
            {panel.actionError && (
              <p className="gh-changes-panel__status gh-changes-panel__status--error" role="alert">
                {panel.actionError}{" "}
                <button type="button" className="gh-changes-panel__dismiss" onClick={panel.dismissActionError}>
                  Dismiss
                </button>
              </p>
            )}

            <div className="gh-changes-panel__scroll">
            <div className="gh-changes-panel__bulk-actions">
              <button type="button" onClick={panel.stageAll} disabled={!canStageAll}>
                Stage all
              </button>
              <button type="button" onClick={panel.unstageAll} disabled={!canUnstageAll}>
                Unstage all
              </button>
            </div>

            {sections.map((section) => (
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
                <h3 className="gh-changes-panel__section-heading">
                  {section.label} ({section.entries.length})
                </h3>
                {section.entries.length > 0 && (
                  <ul className="gh-changes-panel__file-list">
                    {section.entries.map((entry) => (
                      <li
                        key={`${section.category}:${entry.path}`}
                        className="gh-changes-panel__file"
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setFileContextMenu({ x: e.clientX, y: e.clientY, category: section.category, path: entry.path });
                        }}
                      >
                        {section.category === "conflicted" ? (
                          // FR-72: a conflicted row is clickable — opens the resolution view in
                          // the diff column (superseding the previously non-interactive label).
                          <button
                            type="button"
                            className={`gh-changes-panel__file-label gh-changes-panel__file-label--button${
                              activeConflictPath === entry.path ? " gh-changes-panel__file-label--selected" : ""
                            }`}
                            aria-pressed={activeConflictPath === entry.path}
                            onClick={() => setActiveConflictPath(entry.path)}
                          >
                            <FileStatusIcon status={entry.status} />
                            <FilePath path={entry.path} />
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              className={`gh-changes-panel__file-label gh-changes-panel__file-label--button${
                                isRowSelected(section.category, entry.path) ? " gh-changes-panel__file-label--selected" : ""
                              }`}
                              aria-pressed={isRowSelected(section.category, entry.path)}
                              onClick={() => selectDiffableFile(section.category as DiffableCategory, entry)}
                            >
                              <FileStatusIcon status={entry.status} />
                              {section.category === "unstaged" && mixedPaths.has(entry.path) && (
                                <span
                                  className="gh-changes-panel__mixed"
                                  role="img"
                                  aria-label="Partly staged"
                                  title="Partly staged"
                                />
                              )}
                              <FilePath path={entry.path} oldPath={entry.oldPath} />
                            </button>
                            <span className="gh-changes-panel__file-actions">
                              {(section.category === "staged" ||
                                (section.category === "unstaged" && mixedPaths.has(entry.path))) && (
                                <button type="button" title="Unstage" onClick={() => panel.unstage(entry)}>
                                  <ActionIcon kind="unstage" />
                                  <span className="gh-changes-panel__action-text">Unstage</span>
                                </button>
                              )}
                              {(section.category === "unstaged" || section.category === "untracked") && (
                                <>
                                  <button
                                    type="button"
                                    title="Stage"
                                    onClick={() => panel.stage(entry, section.category as "unstaged" | "untracked")}
                                  >
                                    <ActionIcon kind="stage" />
                                    <span className="gh-changes-panel__action-text">Stage</span>
                                  </button>
                                  <button
                                    type="button"
                                    className="gh-changes-panel__discard"
                                    title="Discard"
                                    onClick={() =>
                                      panel.requestDiscard(section.category as "unstaged" | "untracked", entry.path)
                                    }
                                    aria-label={`Discard changes to ${entry.path}`}
                                  >
                                    <ActionIcon kind="discard" />
                                    <span className="gh-changes-panel__action-text">Discard</span>
                                  </button>
                                </>
                              )}
                            </span>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
            </div>

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

          <ResizeHandle label="Resize file list" {...fileListWidth.separatorProps} onDoubleClick={fileListWidth.reset} />

          <div className="gh-changes-panel__diff">
            {activeConflictPath ? (
              <ConflictResolutionView
                api={api}
                path={activeConflictPath}
                onClose={() => setActiveConflictPath(null)}
                onResolved={conflictResolved}
                onMutationStart={onMutationStart}
                onMutationSettled={onMutationSettled}
                blockActions={blockConflictActions}
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
              />
            )}
          </div>
        </div>
      )}

      {panel.pendingDiscard && (
        <ConfirmDialog
          title="Discard changes?"
          message={`Discard changes to "${panel.pendingDiscard.path}"? This cannot be undone.${
            panel.pendingDiscard.category === "unstaged" && mixedPaths.has(panel.pendingDiscard.path)
              ? " Only the unstaged part is discarded; your staged changes are kept."
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

      {fileContextMenu && (
        <ContextMenu
          x={fileContextMenu.x}
          y={fileContextMenu.y}
          sha={fileContextMenu.path}
          ariaLabel={`Actions for ${fileContextMenu.path}`}
          items={fileContextMenuItems}
          onClose={() => setFileContextMenu(null)}
        />
      )}
    </aside>
  );
});
