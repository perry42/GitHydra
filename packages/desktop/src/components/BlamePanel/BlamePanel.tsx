// SPDX-License-Identifier: GPL-3.0-or-later
import { useState } from "react";
import type { GitHydraApi } from "../../../shared/ipcContract";
import { type BlameTarget, useBlame, useFileHistory } from "../../hooks/useBlame";
import { formatAuthor, formatRelativeDate } from "../../lib/format";
import { groupBlameLines } from "../../lib/blameBlocks";
import { useResizableWidth } from "../../hooks/useResizableWidth";
import {
  BLAME_PANEL_DEFAULT_WIDTH,
  BLAME_PANEL_MIN_WIDTH,
  eightyVw,
  RIGHT_PANEL_STORAGE_KEY,
} from "../../lib/layoutSizes";
import { ResizeHandle } from "../ResizeHandle/ResizeHandle";
import "./BlamePanel.css";

export interface BlamePanelProps {
  api: GitHydraApi;
  target: BlameTarget;
  onClose: () => void;
  /** FR-133: selecting a file-history row re-blames this same panel in place against that
   * commit, rather than opening a second view. */
  onReblame: (revision: string) => void;
  /** FR-134: clicking a real (non-uncommitted) blamed block's commit metadata — never called for
   * the uncommitted-lines block (FR-135: no jump-to-commit affordance exists for it). */
  onJumpToCommit: (sha: string) => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * FR-132/133/134/135/136: the Blame panel — a right-edge, resizable panel (following
 * BranchesPanel's single-column precedent rather than ChangesPanel/DetailPanel/StashPanel's
 * list+diff split, since blame has no second per-item list to split against). Primary region
 * bands contiguous same-commit lines into one block each (FR-132, `groupBlameLines`), with
 * commit metadata shown once per block — tabular-nums line numbers and monospace content,
 * matching `DiffView`'s established conventions. FR-124's binary/too-large/not-found/empty
 * results each render as an explicit named state (never a blank pane), mirroring `DiffView`'s own
 * non-diff-state pattern. A collapsible "File history" region (FR-133) reuses `DetailPanel`'s
 * metadata-block collapsed-disclosure pattern.
 */
export function BlamePanel({ api, target, onClose, onReblame, onJumpToCommit }: BlamePanelProps) {
  const blame = useBlame(api, target);
  const history = useFileHistory(api, target);
  const [historyExpanded, setHistoryExpanded] = useState(false);

  // Layout-persistence fix: shared with ChangesPanel/StashPanel/DetailPanel's own panelWidth call —
  // see RIGHT_PANEL_STORAGE_KEY's doc comment (lib/layoutSizes.ts) for why one storage key across
  // all four is safe despite each owning its own hook instance.
  const panelWidth = useResizableWidth({
    storageKey: RIGHT_PANEL_STORAGE_KEY,
    defaultWidth: BLAME_PANEL_DEFAULT_WIDTH,
    min: BLAME_PANEL_MIN_WIDTH,
    getMax: eightyVw,
    direction: -1,
  });

  const revisionLabel = target.revision ? target.revision.slice(0, 10) : "working tree";

  return (
    <aside className="gh-blame-panel" aria-label="Blame" role="complementary" style={{ width: panelWidth.width }}>
      <ResizeHandle label="Resize Blame panel" {...panelWidth.separatorProps} />
      <div className="gh-blame-panel__header">
        <div className="gh-blame-panel__heading">
          <h2 className="gh-blame-panel__title">Blame</h2>
          <p className="gh-blame-panel__subtitle gh-mono" title={target.path}>
            {target.path} <span className="gh-blame-panel__revision">@ {revisionLabel}</span>
          </p>
        </div>
        <button type="button" className="gh-blame-panel__close" onClick={onClose} aria-label="Close blame panel">
          ×
        </button>
      </div>

      <div className="gh-blame-panel__body">
        {blame.status === "loading" && (
          <p className="gh-blame-panel__status" role="status" aria-live="polite" aria-busy="true">
            Loading blame…
          </p>
        )}

        {blame.status === "error" && (
          <p className="gh-blame-panel__status gh-blame-panel__status--error" role="alert">
            Could not load blame: {blame.message}
          </p>
        )}

        {blame.status === "ready" && blame.result.status === "not-found" && (
          <p className="gh-blame-panel__status">
            {target.revision
              ? "This file does not exist at this revision."
              : "This file does not exist in the working tree."}
          </p>
        )}

        {blame.status === "ready" && blame.result.status === "empty" && (
          <p className="gh-blame-panel__status">This file is empty — there is nothing to blame.</p>
        )}

        {blame.status === "ready" && blame.result.status === "binary" && (
          <p className="gh-blame-panel__status">Binary file — content not shown.</p>
        )}

        {blame.status === "ready" && blame.result.status === "too-large" && (
          <p className="gh-blame-panel__status">
            File too large to blame inline ({formatBytes(blame.result.fileSizeBytes)}).
          </p>
        )}

        {blame.status === "ready" && blame.result.status === "ok" && blame.result.lines.length === 0 && (
          <p className="gh-blame-panel__status">No lines to show.</p>
        )}

        {blame.status === "ready" && blame.result.status === "ok" && blame.result.lines.length > 0 && (
          <div className="gh-blame-panel__content" aria-label={`Blame for ${target.path}`}>
            {groupBlameLines(blame.result.lines).map((block, blockIndex) => (
              <div
                key={`${block.commit.sha}-${block.lines[0]!.lineNumber}`}
                className={`gh-blame-panel__block${block.commit.isUncommitted ? " gh-blame-panel__block--uncommitted" : ""}${blockIndex > 0 ? " gh-blame-panel__block--divider" : ""}`}
              >
                {/* FR-135: the uncommitted-lines block is never a button — no jump-to-commit
                    affordance exists for a line with no real commit. FR-136: distinguished by
                    real text (git's own literal "Not Committed Yet"/"not.committed.yet"), not
                    color alone. */}
                {block.commit.isUncommitted ? (
                  <div className="gh-blame-panel__block-meta gh-blame-panel__block-meta--uncommitted">
                    <span className="gh-blame-panel__block-author">{block.commit.authorName}</span>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="gh-blame-panel__block-meta"
                    onClick={() => onJumpToCommit(block.commit.sha)}
                    title={`Select commit ${block.commit.abbrevSha} and open its details`}
                  >
                    <span className="gh-blame-panel__block-sha gh-mono gh-tabular">{block.commit.abbrevSha}</span>
                    <span className="gh-blame-panel__block-author">
                      {formatAuthor(block.commit.authorName, block.commit.authorEmail)}
                    </span>
                    <span className="gh-blame-panel__block-date gh-tabular">
                      {formatRelativeDate(block.commit.authorDate)}
                    </span>
                    {block.commit.isBoundary && (
                      <span
                        className="gh-blame-panel__block-boundary"
                        title="History unavailable beyond this point (shallow clone / grafted history)"
                      >
                        History boundary
                      </span>
                    )}
                    <span className="gh-blame-panel__block-summary">
                      {block.commit.summary || "(empty commit message)"}
                    </span>
                  </button>
                )}
                <div className="gh-blame-panel__lines gh-mono">
                  {block.lines.map((line) => (
                    <div key={line.lineNumber} className="gh-blame-panel__line">
                      <span className="gh-blame-panel__line-no gh-tabular" aria-hidden="true">
                        {line.lineNumber}
                      </span>
                      <span className="gh-blame-panel__line-content">{line.content}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="gh-blame-panel__history">
        <button
          type="button"
          className="gh-blame-panel__history-toggle"
          aria-expanded={historyExpanded}
          onClick={() => setHistoryExpanded((e) => !e)}
        >
          <span className="gh-blame-panel__history-toggle-chevron" aria-hidden="true">
            {historyExpanded ? "▾" : "▸"}
          </span>
          File history
        </button>

        {historyExpanded && (
          <div className="gh-blame-panel__history-body">
            {history.status === "loading" && (
              <p className="gh-blame-panel__status" role="status" aria-live="polite" aria-busy="true">
                Loading file history…
              </p>
            )}
            {history.status === "error" && (
              <p className="gh-blame-panel__status gh-blame-panel__status--error" role="alert">
                Could not load file history: {history.errorMessage}
              </p>
            )}
            {history.status === "ready" && history.commits.length === 0 && (
              <p className="gh-blame-panel__status">No history found for this file.</p>
            )}
            {history.status === "ready" && history.commits.length > 0 && (
              <>
                <ul className="gh-blame-panel__history-list">
                  {history.commits.map((commit) => {
                    const isCurrent = target.revision === commit.sha;
                    return (
                      <li key={commit.sha}>
                        <button
                          type="button"
                          className={`gh-blame-panel__history-row${isCurrent ? " gh-blame-panel__history-row--selected" : ""}`}
                          aria-pressed={isCurrent}
                          onClick={() => onReblame(commit.sha)}
                        >
                          <span className="gh-blame-panel__history-row-subject">
                            {commit.subject || "(empty commit message)"}
                          </span>
                          <span className="gh-blame-panel__history-row-meta">
                            <span className="gh-mono">{commit.abbrevSha}</span>
                            <span>{formatAuthor(commit.authorName, commit.authorEmail)}</span>
                            <span className="gh-tabular">{formatRelativeDate(commit.authorDate)}</span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {history.hasMore && (
                  <button
                    type="button"
                    className="gh-blame-panel__history-load-more"
                    onClick={history.loadMore}
                    disabled={history.isLoadingMore}
                  >
                    {history.isLoadingMore ? "Loading…" : "Load more"}
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
