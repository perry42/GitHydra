// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from "react";
import type { RepositoryState } from "@githydra/git-core";
import type { GitHydraApi } from "../../../shared/ipcContract";
import { useStashActions } from "../../hooks/useStashActions";
import { useStashDiff } from "../../hooks/useStashDiff";
import { useStashList } from "../../hooks/useStashList";
import { useResizableWidth } from "../../hooks/useResizableWidth";
import { formatDate, stashBranchCaption } from "../../lib/format";
import {
  eightyVw,
  RIGHT_PANEL_STORAGE_KEY,
  STASH_LIST_DEFAULT_WIDTH,
  STASH_LIST_MIN_WIDTH,
  STASH_PANEL_DEFAULT_WIDTH,
  STASH_PANEL_MIN_WIDTH,
} from "../../lib/layoutSizes";
import { ConfirmDialog } from "../ConfirmDialog/ConfirmDialog";
import { DiffView } from "../DiffView/DiffView";
import { FileStatusIcon } from "../FileStatusIcon/FileStatusIcon";
import { ResizeHandle } from "../ResizeHandle/ResizeHandle";
import "./StashPanel.css";

export interface StashPanelProps {
  api: GitHydraApi;
  repoState: RepositoryState | null;
  /** Bumped by App after any successful stash mutation, or after the ordinary external-change
   * alert is acknowledged (FR-91/AC7), so this panel's list stays correct. */
  reloadToken?: number;
  onClose: () => void;
  /** FR-99: opens the (App-owned) CreateStashDialog. */
  onRequestNewStash: () => void;
  /** FR-101: full refresh contract after a successful apply/pop/drop. */
  onMutated: () => void;
  onMutationStart: () => void;
  onMutationSettled: () => void;
  /** FR-98: a conflicting apply/pop — the caller opens ChangesPanel and shows the stash-specific
   * inline notice. */
  onConflict: (action: "apply" | "pop") => void;
  createDisabledReason: string | null;
}

/**
 * FR-94/95/96/97/98: the Stash panel — a two-region split (list of stashes | selected stash's
 * diff), following ChangesPanel/DetailPanel's convention (680px/80vw-capped default width,
 * resizable) rather than BranchesPanel's narrower single-list treatment, since this panel also
 * needs a file-list+diff split for FR-95's preview.
 */
export function StashPanel({
  api,
  repoState,
  reloadToken,
  onClose,
  onRequestNewStash,
  onMutated,
  onMutationStart,
  onMutationSettled,
  onConflict,
  createDisabledReason,
}: StashPanelProps) {
  const list = useStashList({ api, reloadToken });
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  // Must-have (mirrors ChangesPanel/DetailPanel's own first-entry auto-select): once the list is
  // ready, default to previewing stash@{0} — but never override a selection the user already made,
  // and clear it if the previously-selected stash no longer exists (e.g. it was just dropped).
  useEffect(() => {
    if (list.status !== "ready") return;
    if (selectedIndex !== null && list.stashes.some((s) => s.index === selectedIndex)) return;
    setSelectedIndex(list.stashes[0]?.index ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.status, list.stashes]);

  const diff = useStashDiff(api, selectedIndex);
  const selectedFile = diff.files.find((f) => f.path === diff.selectedPath) ?? null;

  const actions = useStashActions({
    api,
    onMutated: () => {
      list.reload();
      onMutated();
    },
    onMutationStart,
    onMutationSettled,
    onConflict,
  });

  const hasWorkdir = Boolean(repoState && !repoState.isBare && repoState.workdir);

  // Layout-persistence fix: shared with ChangesPanel/DetailPanel/BlamePanel's own panelWidth call —
  // see RIGHT_PANEL_STORAGE_KEY's doc comment (lib/layoutSizes.ts) for why one storage key across
  // all four is safe despite each owning its own hook instance.
  const panelWidth = useResizableWidth({
    storageKey: RIGHT_PANEL_STORAGE_KEY,
    defaultWidth: STASH_PANEL_DEFAULT_WIDTH,
    min: STASH_PANEL_MIN_WIDTH,
    getMax: eightyVw,
    direction: -1,
  });
  const getListMax = () => panelWidth.width * 0.5;
  const listWidth = useResizableWidth({
    storageKey: "githydra:layout:stashListWidth",
    defaultWidth: STASH_LIST_DEFAULT_WIDTH,
    min: STASH_LIST_MIN_WIDTH,
    getMax: getListMax,
    direction: 1,
  });

  return (
    <aside className="gh-stash-panel" aria-label="Stashes" role="complementary" style={{ width: panelWidth.width }}>
      <ResizeHandle label="Resize Stash panel" {...panelWidth.separatorProps} />
      <div className="gh-stash-panel__header">
        <h2 className="gh-stash-panel__title">Stashes</h2>
        <div className="gh-stash-panel__header-actions">
          <button
            type="button"
            className="gh-stash-panel__new"
            onClick={onRequestNewStash}
            disabled={createDisabledReason !== null}
            title={createDisabledReason ?? undefined}
          >
            + New Stash…
          </button>
          <button type="button" className="gh-stash-panel__close" onClick={onClose} aria-label="Close stashes panel">
            ×
          </button>
        </div>
      </div>

      {!hasWorkdir && (
        <div className="gh-stash-panel__body">
          <p className="gh-stash-panel__status">
            This is a bare repository — it has no working directory, so there is nothing to stash.
          </p>
        </div>
      )}

      {hasWorkdir && list.status === "loading" && (
        <div className="gh-stash-panel__body">
          <p className="gh-stash-panel__status" role="status" aria-live="polite" aria-busy="true">
            Loading stashes…
          </p>
        </div>
      )}

      {hasWorkdir && list.status === "error" && (
        <div className="gh-stash-panel__body">
          <p className="gh-stash-panel__status gh-stash-panel__status--error" role="alert">
            Could not load stashes: {list.errorMessage}
          </p>
          <button type="button" className="gh-stash-panel__dismiss" onClick={list.reload}>
            Retry
          </button>
        </div>
      )}

      {hasWorkdir && list.status === "bare" && (
        <div className="gh-stash-panel__body">
          <p className="gh-stash-panel__status">
            This is a bare repository — it has no working directory, so there is nothing to stash.
          </p>
        </div>
      )}

      {hasWorkdir && list.status === "ready" && (
        <div className="gh-stash-panel__body gh-stash-panel__body--ready">
          <div className="gh-stash-panel__list-col" style={{ width: listWidth.width }}>
            {actions.error && (
              <p className="gh-stash-panel__status gh-stash-panel__status--error" role="alert">
                {actions.error}{" "}
                <button type="button" className="gh-stash-panel__dismiss" onClick={actions.dismissError}>
                  Dismiss
                </button>
              </p>
            )}
            {list.stashes.length === 0 ? (
              <p className="gh-stash-panel__empty">No stashes yet.</p>
            ) : (
              <ul className="gh-stash-panel__list">
                {list.stashes.map((stash) => {
                  const busy = actions.busyIndex === stash.index;
                  const selected = selectedIndex === stash.index;
                  return (
                    <li key={stash.ref} className={`gh-stash-panel__row${selected ? " gh-stash-panel__row--selected" : ""}`}>
                      <button
                        type="button"
                        className="gh-stash-panel__row-select"
                        aria-pressed={selected}
                        onClick={() => setSelectedIndex(stash.index)}
                      >
                        <span className="gh-stash-panel__row-message">{stash.message}</span>
                        <span className="gh-stash-panel__row-meta">
                          <span className="gh-mono">{stashBranchCaption(stash)}</span>
                          <span className="gh-tabular">{formatDate(stash.date)}</span>
                        </span>
                      </button>
                      <div className="gh-stash-panel__row-actions">
                        <button
                          type="button"
                          onClick={() => actions.applyStash(stash.index)}
                          disabled={busy}
                          title="Apply this stash's changes, keep it in the list."
                        >
                          {busy ? "Working…" : "Apply"}
                        </button>
                        <button
                          type="button"
                          onClick={() => actions.popStash(stash.index)}
                          disabled={busy}
                          title="Apply this stash's changes and remove it from the list."
                        >
                          {busy ? "Working…" : "Pop"}
                        </button>
                        <button
                          type="button"
                          className="gh-stash-panel__drop"
                          onClick={() => actions.requestDrop(stash.index, stash.message)}
                          disabled={busy}
                        >
                          Drop
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <ResizeHandle label="Resize stash list" {...listWidth.separatorProps} />

          <div className="gh-stash-panel__diff-col">
            {selectedIndex === null ? (
              <p className="gh-stash-panel__status">Select a stash to preview its diff.</p>
            ) : (
              <>
                <div className="gh-stash-panel__diff-files">
                  {diff.status === "loading" && (
                    <p className="gh-stash-panel__status" role="status" aria-live="polite" aria-busy="true">
                      Loading files…
                    </p>
                  )}
                  {diff.status === "error" && (
                    <p className="gh-stash-panel__status gh-stash-panel__status--error" role="alert">
                      Could not load diff: {diff.errorMessage}
                    </p>
                  )}
                  {diff.status === "ready" && diff.files.length === 0 && (
                    <p className="gh-stash-panel__status">No files changed.</p>
                  )}
                  {diff.status === "ready" && diff.files.length > 0 && (
                    <ul className="gh-stash-panel__diff-file-list">
                      {diff.files.map((file) => (
                        <li key={`${file.oldPath ?? ""}->${file.path}`}>
                          <button
                            type="button"
                            className={`gh-stash-panel__diff-file-button${diff.selectedPath === file.path ? " gh-stash-panel__diff-file-button--selected" : ""}`}
                            aria-pressed={diff.selectedPath === file.path}
                            onClick={() => diff.selectFile(file.path)}
                          >
                            <FileStatusIcon status={file.status} />
                            <span className="gh-mono gh-stash-panel__diff-file-path">
                              {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                              {file.isUntracked ? " (untracked)" : ""}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="gh-stash-panel__diff-view">
                  <DiffView
                    fileLabel={
                      selectedFile ? (selectedFile.oldPath ? `${selectedFile.oldPath} → ${selectedFile.path}` : selectedFile.path) : "No file selected"
                    }
                    loading={diff.status === "loading"}
                    errorMessage={diff.status === "error" ? diff.errorMessage : null}
                    result={selectedFile ? selectedFile.diff : null}
                    emptyMessage={diff.status === "ready" && diff.files.length === 0 ? "No diff found for this stash." : undefined}
                  />
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {actions.pendingDrop && (
        <ConfirmDialog
          title="Drop stash?"
          message={`Drop "${actions.pendingDrop.message}"? This cannot be undone.`}
          confirmLabel="Drop"
          destructive
          onConfirm={actions.confirmDrop}
          onCancel={actions.cancelDrop}
        />
      )}
    </aside>
  );
}
