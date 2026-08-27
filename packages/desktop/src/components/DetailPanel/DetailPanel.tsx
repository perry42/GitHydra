import type { CommitDetailState } from "../../hooks/useRepositoryGraph";
import { changedFileStatusColorVar, changedFileStatusLabel, formatAuthor, formatDate } from "../../lib/format";
import { RefChip } from "../RefChip/RefChip";
import "./DetailPanel.css";

export interface DetailPanelProps {
  detail: CommitDetailState;
  /** Whether the repo's HEAD is currently detached (not the same as "this commit is HEAD") —
   * see refChips.ts's buildRefChips, whose isDetached logic this mirrors. */
  isRepoDetachedHead: boolean;
  onJumpToParent: (sha: string) => void;
  onClose: () => void;
}

/**
 * FR-13: full message, author/committer info + dates, clickable parent SHA(s), referencing
 * branches/tags, and a correctly-typed changed-file list with counts. Deliberately does not show
 * diff content (explicit non-goal — see the stage/unstage + diff spec).
 */
export function DetailPanel({ detail, isRepoDetachedHead, onJumpToParent, onClose }: DetailPanelProps) {
  if (detail.status === "idle") return null;

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
        <div className="gh-detail-panel__body">
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

          <h3 className="gh-detail-panel__files-heading">Changed files ({detail.files.length})</h3>
          {detail.files.length === 0 ? (
            <p className="gh-detail-panel__no-files">No files changed.</p>
          ) : (
            <ul className="gh-detail-panel__files">
              {detail.files.map((file) => (
                <li key={`${file.oldPath ?? ""}->${file.path}`} className="gh-detail-panel__file">
                  <span
                    className="gh-detail-panel__file-status"
                    style={{ color: changedFileStatusColorVar(file.status) }}
                    aria-hidden="true"
                  >
                    {file.status[0]!.toUpperCase()}
                  </span>
                  <span className="gh-visually-hidden">{changedFileStatusLabel(file.status)}:</span>
                  <span className="gh-mono gh-detail-panel__file-path">
                    {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                  </span>
                  {file.similarity != null && (
                    <span className="gh-detail-panel__file-similarity">{file.similarity}%</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </aside>
  );
}
