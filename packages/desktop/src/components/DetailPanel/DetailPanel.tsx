import { useCallback, useLayoutEffect, useState } from "react";
import type { ChangedFile } from "@githydra/git-core";
import type { CommitDetailState } from "../../hooks/useRepositoryGraph";
import { useFileDiff } from "../../hooks/useFileDiff";
import type { GitHydraApi } from "../../../shared/ipcContract";
import { formatAuthor, formatDate } from "../../lib/format";
import { DiffView } from "../DiffView/DiffView";
import { FileStatusIcon } from "../FileStatusIcon/FileStatusIcon";
import { RefChip } from "../RefChip/RefChip";
import "./DetailPanel.css";

export interface DetailPanelProps {
  detail: CommitDetailState;
  /** Whether the repo's HEAD is currently detached (not the same as "this commit is HEAD") —
   * see refChips.ts's buildRefChips, whose isDetached logic this mirrors. */
  isRepoDetachedHead: boolean;
  api: GitHydraApi;
  onJumpToParent: (sha: string) => void;
  onClose: () => void;
}

/**
 * FR-13: full message, author/committer info + dates, clickable parent SHA(s), referencing
 * branches/tags, and a correctly-typed changed-file list with counts. FR-29 closes FR-13's
 * previously-deferred scope: clicking a changed file fetches and shows that file's diff for this
 * commit (via `getCommitFileDiff`). `specs/detailpanel-auto-diff.md`'s Must-have #1/#3/#5 extend
 * this further: the first file's diff auto-loads as soon as the commit is ready (no click
 * required), reselecting a commit never shows an interstitial "Select a file…" flash, and the
 * changed-file list + diff pane render as independently-scrolling regions below the commit
 * metadata, mirroring ChangesPanel's `__body--ready` layout. The metadata block is collapsed to a
 * single summary row by default (SHA + first message line) and expands on click, so it doesn't
 * compete with the file list/diff split for vertical space.
 */
export function DetailPanel({ detail, isRepoDetachedHead, api, onJumpToParent, onClose }: DetailPanelProps) {
  const diffHook = useFileDiff();
  // Collapsed by default so the metadata block doesn't eat the vertical space the file
  // list/diff split needs; a user who opens it once probably wants it open for the rest of
  // their session, so this deliberately does NOT reset per commit selection.
  const [metaExpanded, setMetaExpanded] = useState(false);
  const currentSha =
    detail.status === "loading" || detail.status === "error"
      ? detail.sha
      : detail.status === "ready"
        ? detail.commit.sha
        : null;

  const loadFileDiff = useCallback(
    (commit: { sha: string; parents: string[] }, file: ChangedFile) => {
      diffHook.load(file.path, () =>
        api.getCommitFileDiff({ sha: commit.sha, parents: commit.parents }, { path: file.path, oldPath: file.oldPath }),
      );
    },
    [api, diffHook],
  );

  // AC1/AC3/AC9: whenever the selected commit's identity changes, or its `detail` transitions
  // between loading/ready/error for the *same* sha (so this also fires on the initial
  // loading -> ready transition, not just on a sha change), drop any previously-loaded file diff
  // and — if the commit is ready with >=1 changed file — immediately load its first file's diff,
  // exactly as if the user had clicked it. Reselecting a commit (including reselecting the same
  // commit) always re-picks files[0] fresh; no previously-manually-clicked file is remembered
  // (Non-goals). useLayoutEffect (not useEffect) so the "clear" and the auto-select "load" both
  // land before the browser paints — DiffView's idle placeholder is never shown as a visible
  // interstitial frame between two commits that each have files (AC3).
  useLayoutEffect(() => {
    if (detail.status === "ready" && detail.files.length > 0) {
      loadFileDiff({ sha: detail.commit.sha, parents: detail.commit.parents }, detail.files[0]!);
    } else {
      diffHook.clear();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSha, detail.status]);

  if (detail.status === "idle") return null;

  const selectFile = (commit: { sha: string; parents: string[] }, file: ChangedFile) => {
    loadFileDiff(commit, file);
  };

  return (
    <aside className="gh-detail-panel" aria-label="Commit details" role="complementary">
      <div className="gh-detail-panel__header">
        <h2 className="gh-detail-panel__title">Commit details</h2>
        <button type="button" className="gh-detail-panel__close" onClick={onClose} aria-label="Close commit details">
          ×
        </button>
      </div>

      {detail.status === "loading" && (
        <div className="gh-detail-panel__body" aria-busy="true">
          <p className="gh-detail-panel__loading">Loading {detail.sha.slice(0, 10)}…</p>
        </div>
      )}

      {detail.status === "error" && (
        <div className="gh-detail-panel__body">
          <p className="gh-detail-panel__error" role="alert">
            Could not load commit {detail.sha.slice(0, 10)}: {detail.message}
          </p>
        </div>
      )}

      {detail.status === "ready" && (
        <div className="gh-detail-panel__body gh-detail-panel__body--ready">
          <div className="gh-detail-panel__meta-region">
            <button
              type="button"
              className="gh-detail-panel__meta-toggle"
              aria-expanded={metaExpanded}
              aria-label={metaExpanded ? "Collapse commit metadata" : "Expand commit metadata"}
              onClick={() => setMetaExpanded((expanded) => !expanded)}
            >
              <span className="gh-detail-panel__meta-toggle-chevron" aria-hidden="true">
                {metaExpanded ? "▾" : "▸"}
              </span>
              <span className="gh-mono gh-detail-panel__meta-toggle-sha">{detail.commit.sha.slice(0, 10)}</span>
              <span className="gh-detail-panel__meta-toggle-summary">
                {(detail.commit.message || "(empty commit message)").split("\n")[0]}
              </span>
            </button>

            {metaExpanded && (
              <div className="gh-detail-panel__meta-content">
                <p className="gh-detail-panel__sha gh-mono">{detail.commit.sha}</p>

                {detail.commit.refs.length > 0 && (
                  <div className="gh-detail-panel__refs">
                    {detail.commit.refs.map((decoration, i) => (
                      <RefChip
                        key={`${decoration.fullName ?? "HEAD"}-${i}`}
                        decoration={decoration}
                        laneColor="var(--gh-ink-secondary)"
                        detached={decoration.type === "head" && isRepoDetachedHead}
                      />
                    ))}
                  </div>
                )}

                <p className="gh-detail-panel__message">{detail.commit.message || "(empty commit message)"}</p>

                <dl className="gh-detail-panel__meta">
                  <dt>Author</dt>
                  <dd>{formatAuthor(detail.commit.authorName, detail.commit.authorEmail)}</dd>
                  <dt>Author date</dt>
                  <dd className="gh-tabular">{formatDate(detail.commit.authorDate)}</dd>
                  <dt>Committer</dt>
                  <dd>{formatAuthor(detail.commit.committerName, detail.commit.committerEmail)}</dd>
                  <dt>Committer date</dt>
                  <dd className="gh-tabular">{formatDate(detail.commit.committerDate)}</dd>
                  <dt>Parents</dt>
                  <dd>
                    {detail.commit.parents.length === 0 ? (
                      <span className="gh-detail-panel__no-parents">
                        {detail.commit.isHistoryBoundary ? "History unavailable beyond this point" : "None (root commit)"}
                      </span>
                    ) : (
                      <ul className="gh-detail-panel__parents">
                        {detail.commit.parents.map((sha) => (
                          <li key={sha}>
                            <button type="button" className="gh-detail-panel__parent-link gh-mono" onClick={() => onJumpToParent(sha)}>
                              {sha.slice(0, 10)}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </dd>
                </dl>
              </div>
            )}
          </div>

          <div className="gh-detail-panel__split">
            <div className="gh-detail-panel__files">
              <h3 className="gh-detail-panel__files-heading">Changed files ({detail.files.length})</h3>
              {detail.files.length === 0 ? (
                <p className="gh-detail-panel__no-files">No files changed.</p>
              ) : (
                <ul className="gh-detail-panel__file-list">
                  {detail.files.map((file) => {
                    const isSelected = diffHook.state.status !== "idle" && diffHook.state.key === file.path;
                    return (
                      <li key={`${file.oldPath ?? ""}->${file.path}`} className="gh-detail-panel__file">
                        <button
                          type="button"
                          className={`gh-detail-panel__file-button${isSelected ? " gh-detail-panel__file-button--selected" : ""}`}
                          aria-pressed={isSelected}
                          onClick={() => selectFile({ sha: detail.commit.sha, parents: detail.commit.parents }, file)}
                        >
                          <FileStatusIcon status={file.status} />
                          <span className="gh-mono gh-detail-panel__file-path">
                            {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                          </span>
                          {file.similarity != null && (
                            <span className="gh-detail-panel__file-similarity">{file.similarity}%</span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="gh-detail-panel__diff">
              <DiffView
                fileLabel={diffHook.state.status !== "idle" ? diffHook.state.key : "No file selected"}
                loading={diffHook.state.status === "loading"}
                errorMessage={diffHook.state.status === "error" ? diffHook.state.message : null}
                result={diffHook.state.status === "ready" ? diffHook.state.result : null}
                emptyMessage={detail.files.length === 0 ? "No diff found for this commit." : undefined}
              />
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
