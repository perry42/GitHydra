import { useCallback, useState } from "react";
import type { WorkingDirectoryFileChange } from "@githydra/git-core";
import type { GitHydraApi } from "../../../shared/ipcContract";
import { useChangesPanel, type DiffableCategory } from "../../hooks/useChangesPanel";
import { useResizableWidth } from "../../hooks/useResizableWidth";
import {
  CHANGES_FILE_LIST_DEFAULT_WIDTH,
  CHANGES_FILE_LIST_MIN_WIDTH,
  CHANGES_PANEL_DEFAULT_WIDTH,
  CHANGES_PANEL_MIN_WIDTH,
  eightyVw,
} from "../../lib/layoutSizes";
import { ConflictResolutionView } from "../ConflictResolutionView/ConflictResolutionView";
import { ConfirmDialog } from "../ConfirmDialog/ConfirmDialog";
import { DiffView } from "../DiffView/DiffView";
import { FileStatusIcon } from "../FileStatusIcon/FileStatusIcon";
import { ResizeHandle } from "../ResizeHandle/ResizeHandle";
import "./ChangesPanel.css";

export interface ChangesPanelProps {
  api: GitHydraApi;
  onClose: () => void;
  /** FR-30: refresh the cheap working-dir-status counts shown elsewhere (Toolbar badge, the
   * graph's uncommitted-changes pseudo-node) after any successful mutation. */
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
}

interface SectionConfig {
  category: DiffableCategory | "conflicted";
  label: string;
  entries: WorkingDirectoryFileChange[];
}

/**
 * FR-28/FR-29/FR-30/FR-31/FR-32: the Changes panel — Staged/Unstaged/Untracked/Conflicted
 * sections with counts and stage/unstage/discard controls, a diff view for the selected file,
 * and the commit composer. All state/mutation logic lives in `useChangesPanel`; this component
 * is presentational.
 */
export function ChangesPanel({
  api,
  onClose,
  onWorkingDirChanged,
  onCommitCreated,
  reloadToken,
  blockConflictActions = false,
}: ChangesPanelProps) {
  const panel = useChangesPanel({ api, onWorkingDirChanged, onCommitCreated, reloadToken });

  // specs/merge-rebase-conflict-resolution.md FR-72: which Conflicted-section row (if any) has
  // its resolution view open in the diff column, replacing DiffView — separate from
  // `panel.selected` since useChangesPanel's own selection deliberately excludes Conflicted
  // entries (FR-27: no plain stage/unstage/diff control for them). Selecting a normal diffable
  // file clears this (see `selectDiffableFile` below) and vice versa, so the diff column only
  // ever shows one or the other.
  const [activeConflictPath, setActiveConflictPath] = useState<string | null>(null);
  const selectDiffableFile = useCallback(
    (category: DiffableCategory, entry: WorkingDirectoryFileChange) => {
      setActiveConflictPath(null);
      panel.selectFile(category, entry);
    },
    [panel],
  );
  const conflictResolved = useCallback(() => {
    panel.reload();
    onWorkingDirChanged();
  }, [panel, onWorkingDirChanged]);

  // Must-have C13: panel width (left edge — dragging left grows it, since the panel sits to the
  // right of its own handle) and the file-list/diff divider (dragging right grows the file list).
  const panelWidth = useResizableWidth({
    storageKey: "githydra:layout:changesPanelWidth",
    defaultWidth: CHANGES_PANEL_DEFAULT_WIDTH,
    min: CHANGES_PANEL_MIN_WIDTH,
    getMax: eightyVw,
    direction: -1,
  });
  const getFileListMax = useCallback(() => panelWidth.width * 0.5, [panelWidth.width]);
  const fileListWidth = useResizableWidth({
    storageKey: "githydra:layout:changesFileListWidth",
    defaultWidth: CHANGES_FILE_LIST_DEFAULT_WIDTH,
    min: CHANGES_FILE_LIST_MIN_WIDTH,
    getMax: getFileListMax,
    direction: 1,
  });

  const sections: SectionConfig[] | null = panel.changes
    ? [
        { category: "staged", label: "Staged", entries: panel.changes.staged },
        { category: "unstaged", label: "Unstaged", entries: panel.changes.unstaged },
        { category: "untracked", label: "Untracked", entries: panel.changes.untracked },
        { category: "conflicted", label: "Conflicted", entries: panel.changes.conflicted },
      ]
    : null;

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
      <ResizeHandle label="Resize Changes panel" {...panelWidth.separatorProps} />
      <div className="gh-changes-panel__header">
        <h2 className="gh-changes-panel__title">Changes</h2>
        <button type="button" className="gh-changes-panel__close" onClick={onClose} aria-label="Close changes panel">
          ×
        </button>
      </div>

      {panel.status === "loading" && (
        <div className="gh-changes-panel__body" aria-busy="true">
          <p className="gh-changes-panel__status" role="status">
            Loading changes…
          </p>
        </div>
      )}

      {panel.status === "error" && (
        <div className="gh-changes-panel__body">
          <p className="gh-changes-panel__status gh-changes-panel__status--error" role="alert">
            Could not load changes: {panel.loadErrorMessage}
          </p>
          <button type="button" className="gh-changes-panel__retry" onClick={panel.reload}>
            Retry
          </button>
        </div>
      )}

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
                <h3 className="gh-changes-panel__section-heading">
                  {section.label} ({section.entries.length})
                </h3>
                {section.entries.length > 0 && (
                  <ul className="gh-changes-panel__file-list">
                    {section.entries.map((entry) => (
                      <li key={`${section.category}:${entry.path}`} className="gh-changes-panel__file">
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
                            <span className="gh-mono gh-changes-panel__file-path">{entry.path}</span>
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              className={`gh-changes-panel__file-label gh-changes-panel__file-label--button${
                                panel.selected?.category === section.category &&
                                panel.selected.path === entry.path &&
                                activeConflictPath === null
                                  ? " gh-changes-panel__file-label--selected"
                                  : ""
                              }`}
                              aria-pressed={
                                panel.selected?.category === section.category &&
                                panel.selected.path === entry.path &&
                                activeConflictPath === null
                              }
                              onClick={() => selectDiffableFile(section.category as DiffableCategory, entry)}
                            >
                              <FileStatusIcon status={entry.status} />
                              <span className="gh-mono gh-changes-panel__file-path">
                                {entry.oldPath ? `${entry.oldPath} → ${entry.path}` : entry.path}
                              </span>
                            </button>
                            <span className="gh-changes-panel__file-actions">
                              {section.category === "staged" && (
                                <button type="button" onClick={() => panel.unstage(entry)}>
                                  Unstage
                                </button>
                              )}
                              {(section.category === "unstaged" || section.category === "untracked") && (
                                <>
                                  <button type="button" onClick={() => panel.stage(entry, section.category as "unstaged" | "untracked")}>
                                    Stage
                                  </button>
                                  <button
                                    type="button"
                                    className="gh-changes-panel__discard"
                                    onClick={() =>
                                      panel.requestDiscard(section.category as "unstaged" | "untracked", entry.path)
                                    }
                                    aria-label={`Discard changes to ${entry.path}`}
                                  >
                                    Discard
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

            <form
              className="gh-changes-panel__composer"
              onSubmit={(e) => {
                e.preventDefault();
                panel.submitCommit();
              }}
            >
              <h3 className="gh-changes-panel__section-heading">Commit</h3>
              <label className="gh-changes-panel__field" htmlFor="gh-commit-subject">
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
              <label className="gh-changes-panel__field" htmlFor="gh-commit-body">
                Body (optional)
              </label>
              <textarea
                id="gh-commit-body"
                value={panel.body}
                onChange={(e) => panel.setBody(e.target.value)}
                rows={4}
              />
              {panel.commitError && (
                <p className="gh-changes-panel__status gh-changes-panel__status--error" role="alert">
                  {panel.commitError}
                </p>
              )}
              <button type="submit" className="gh-changes-panel__commit" disabled={!panel.canCommit}>
                {panel.isCommitting ? "Committing…" : "Commit"}
              </button>
            </form>
          </div>

          <ResizeHandle label="Resize file list" {...fileListWidth.separatorProps} />

          <div className="gh-changes-panel__diff">
            {activeConflictPath ? (
              <ConflictResolutionView
                api={api}
                path={activeConflictPath}
                onClose={() => setActiveConflictPath(null)}
                onResolved={conflictResolved}
                blockActions={blockConflictActions}
              />
            ) : (
              <DiffView
                fileLabel={diffFileLabel}
                loading={panel.diff.status === "loading"}
                errorMessage={panel.diff.status === "error" ? panel.diff.message : null}
                result={panel.diff.status === "ready" ? panel.diff.result : null}
                emptyMessage={hasDiffableFiles ? undefined : "No diff found."}
              />
            )}
          </div>
        </div>
      )}

      {panel.pendingDiscard && (
        <ConfirmDialog
          title="Discard changes?"
          message={`Discard changes to "${panel.pendingDiscard.path}"? This cannot be undone.`}
          confirmLabel="Discard"
          destructive
          onConfirm={panel.confirmDiscard}
          onCancel={panel.cancelDiscard}
        />
      )}
    </aside>
  );
}
