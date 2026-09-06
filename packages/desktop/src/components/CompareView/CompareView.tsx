// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useLayoutEffect } from "react";
import type { ChangedFile, CommitInfo } from "@githydra/git-core";
import type { GitHydraApi } from "../../../shared/ipcContract";
import { type CompareTarget, useCompareDetail } from "../../hooks/useCompare";
import { useFileDiff } from "../../hooks/useFileDiff";
import { useResizableWidth } from "../../hooks/useResizableWidth";
import {
  COMPARE_LIST_DEFAULT_WIDTH,
  COMPARE_LIST_MIN_WIDTH,
  COMPARE_PANEL_DEFAULT_WIDTH,
  COMPARE_PANEL_MIN_WIDTH,
  eightyVw,
  RIGHT_PANEL_STORAGE_KEY,
} from "../../lib/layoutSizes";
import { DiffView } from "../DiffView/DiffView";
import { FileStatusIcon } from "../FileStatusIcon/FileStatusIcon";
import { ResizeHandle } from "../ResizeHandle/ResizeHandle";
import "./CompareView.css";

export interface CompareViewProps {
  api: GitHydraApi;
  target: CompareTarget;
  onClose: () => void;
  /** FR-193: flips which of the two commits is currently labeled "base" vs. "target" and reloads
   * the file list/diff accordingly — the caller (App.tsx) just swaps `target`'s two fields. */
  onSwap: () => void;
}

function firstLine(message: string): string {
  return (message || "(empty commit message)").split("\n")[0]!;
}

/** One side of the header's base/target identification (FR-190): abbreviated SHA + first message
 * line, explicitly labeled which side it is. */
function CommitSummary({ role, commit }: { role: "Base" | "Target"; commit: CommitInfo }) {
  return (
    <div className="gh-compare-view__commit">
      <span className="gh-compare-view__commit-role">{role}</span>
      <span className="gh-mono gh-compare-view__commit-sha">{commit.abbrevSha}</span>
      <span className="gh-compare-view__commit-summary">{firstLine(commit.message)}</span>
    </div>
  );
}

/**
 * specs/compare-commits.md FR-188 through FR-196: a changed-file list + `DiffView` split
 * structurally mirroring `DetailPanel`'s already-shipped pattern (`specs/detailpanel-auto-diff.md`),
 * pointed at an arbitrary two-commit comparison instead of a commit-vs-parent diff. The header
 * unambiguously names both compared commits (FR-190) and offers a Swap control (FR-193). App.tsx
 * owns `target`'s identity/lifecycle (FR-189/194/195/196's panel-precedence and multi-select-
 * highlight rules) — this component only renders whatever `target` it's given.
 */
export function CompareView({ api, target, onClose, onSwap }: CompareViewProps) {
  const detail = useCompareDetail(api, target);
  const diffHook = useFileDiff();

  // Must-have C13 precedent (DetailPanel/ChangesPanel/StashPanel/BlamePanel): shares
  // `RIGHT_PANEL_STORAGE_KEY` — see layoutSizes.ts's doc comment for why this is safe despite five
  // independent `useResizableWidth` instances now existing across the mutually-exclusive panels.
  const panelWidth = useResizableWidth({
    storageKey: RIGHT_PANEL_STORAGE_KEY,
    defaultWidth: COMPARE_PANEL_DEFAULT_WIDTH,
    min: COMPARE_PANEL_MIN_WIDTH,
    getMax: eightyVw,
    direction: -1,
  });
  const getFileListMax = useCallback(() => panelWidth.width * 0.5, [panelWidth.width]);
  const fileListWidth = useResizableWidth({
    storageKey: "githydra:layout:compareFileListWidth",
    defaultWidth: COMPARE_LIST_DEFAULT_WIDTH,
    min: COMPARE_LIST_MIN_WIDTH,
    getMax: getFileListMax,
    direction: 1,
  });

  const loadFileDiff = useCallback(
    (file: ChangedFile) => {
      diffHook.load(file.path, () =>
        api.getCommitRangeFileDiff(target.baseSha, target.targetSha, { path: file.path, oldPath: file.oldPath }),
      );
    },
    [api, diffHook, target.baseSha, target.targetSha],
  );

  // FR-188/AC6: mirrors DetailPanel's auto-load-first-file behavior exactly — whenever the
  // comparison becomes ready (including a fresh pair via FR-195's "replace in place", or FR-193's
  // Swap), immediately load `files[0]`'s diff with no click required and no interstitial "Select a
  // file" flash. `useLayoutEffect`, not `useEffect`, for the same before-paint reason DetailPanel's
  // own version documents.
  useLayoutEffect(() => {
    if (detail.status === "ready" && detail.files.length > 0) {
      loadFileDiff(detail.files[0]!);
    } else {
      diffHook.clear();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.baseSha, target.targetSha, detail.status]);

  return (
    <aside className="gh-compare-view" aria-label="Compare commits" role="complementary" style={{ width: panelWidth.width }}>
      <ResizeHandle label="Resize compare panel" {...panelWidth.separatorProps} />
      <div className="gh-compare-view__header">
        <div className="gh-compare-view__heading">
          <h2 className="gh-compare-view__title">Compare commits</h2>
          {detail.status === "ready" && (
            <div className="gh-compare-view__commits">
              <CommitSummary role="Base" commit={detail.base} />
              <button type="button" className="gh-compare-view__swap" onClick={onSwap}>
                Swap
              </button>
              <CommitSummary role="Target" commit={detail.target} />
            </div>
          )}
        </div>
        <button type="button" className="gh-compare-view__close" onClick={onClose} aria-label="Close compare view">
          ×
        </button>
      </div>

      {detail.status === "loading" && (
        <div className="gh-compare-view__body" aria-busy="true">
          <p className="gh-compare-view__status" role="status" aria-live="polite" aria-busy="true">
            Loading comparison…
          </p>
        </div>
      )}

      {detail.status === "error" && (
        <div className="gh-compare-view__body">
          <p className="gh-compare-view__status gh-compare-view__status--error" role="alert">
            Could not load this comparison: {detail.message}
          </p>
        </div>
      )}

      {detail.status === "ready" && (
        <div className="gh-compare-view__split">
          <div className="gh-compare-view__files" style={{ width: fileListWidth.width }}>
            <h3 className="gh-compare-view__files-heading">Changed files ({detail.files.length})</h3>
            {detail.files.length === 0 ? (
              <p className="gh-compare-view__no-files">No files changed.</p>
            ) : (
              <ul className="gh-compare-view__file-list">
                {detail.files.map((file) => {
                  const isSelected = diffHook.state.status !== "idle" && diffHook.state.key === file.path;
                  return (
                    <li key={`${file.oldPath ?? ""}->${file.path}`} className="gh-compare-view__file">
                      <button
                        type="button"
                        className={`gh-compare-view__file-button${isSelected ? " gh-compare-view__file-button--selected" : ""}`}
                        aria-pressed={isSelected}
                        onClick={() => loadFileDiff(file)}
                      >
                        <FileStatusIcon status={file.status} />
                        <span className="gh-mono gh-compare-view__file-path">
                          {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                        </span>
                        {file.similarity != null && (
                          <span className="gh-compare-view__file-similarity">{file.similarity}%</span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <ResizeHandle label="Resize file list" {...fileListWidth.separatorProps} />

          <div className="gh-compare-view__diff">
            <DiffView
              fileLabel={diffHook.state.status !== "idle" ? diffHook.state.key : "No file selected"}
              loading={diffHook.state.status === "loading"}
              errorMessage={diffHook.state.status === "error" ? diffHook.state.message : null}
              result={diffHook.state.status === "ready" ? diffHook.state.result : null}
              emptyMessage={detail.files.length === 0 ? "No diff to show — these two commits have no differences." : undefined}
            />
          </div>
        </div>
      )}
    </aside>
  );
}
