// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useLayoutEffect, useMemo, useState } from "react";
import type { ChangedFile } from "@githydra/git-core";
import type { CommitDetailState } from "../../hooks/useRepositoryGraph";
import { useFileDiff } from "../../hooks/useFileDiff";
import { useImageDiff } from "../../hooks/useImageDiff";
import { isImageEligibleChange } from "../../lib/imageDiffEligibility";
import { useResizableWidth } from "../../hooks/useResizableWidth";
import type { GitHydraApi } from "../../../shared/ipcContract";
import { formatAuthor, formatDate } from "../../lib/format";
import {
  DETAIL_FILE_LIST_DEFAULT_WIDTH,
  DETAIL_FILE_LIST_MIN_WIDTH,
  DETAIL_PANEL_DEFAULT_WIDTH,
  DETAIL_PANEL_MIN_WIDTH,
  eightyVw,
  RIGHT_PANEL_STORAGE_KEY,
} from "../../lib/layoutSizes";
import { ContextMenu, type ContextMenuItem } from "../ContextMenu/ContextMenu";
import { DiffView } from "../DiffView/DiffView";
import { FileStatusIcon } from "../FileStatusIcon/FileStatusIcon";
import { RefChip } from "../RefChip/RefChip";
import { ResizeHandle } from "../ResizeHandle/ResizeHandle";
import "./DetailPanel.css";

export interface DetailPanelProps {
  detail: CommitDetailState;
  /** Whether the repo's HEAD is currently detached (not the same as "this commit is HEAD") —
   * see refChips.ts's buildRefChips, whose isDetached logic this mirrors. */
  isRepoDetachedHead: boolean;
  api: GitHydraApi;
  onJumpToParent: (sha: string) => void;
  onClose: () => void;
  /**
   * specs/blame.md FR-131: opens `BlamePanel` for a changed-file row, blamed as of THIS commit
   * (`revision: <this commit's sha>` — never the working tree's current content). Reached via
   * that row's new right-click "Blame" action. Optional so existing standalone-render test
   * harnesses don't need to pass a no-op — App.tsx always wires this in the real app.
   */
  onOpenBlame?: (path: string, revision: string) => void;
  /**
   * specs/remember-last-selected-file.md FR-217: a tab-activation-restored file path to try
   * selecting INSTEAD of `files[0]`, consulted at most once per real activation (see this
   * component's own auto-select `useLayoutEffect` for the exact one-shot mechanics — NOT once per
   * mount/render, since this component is not remounted on an ordinary tab switch). Ignored (falls
   * through to `files[0]`) if the referenced path isn't in the current commit's file list. Optional
   * — omitted/`null` behaves exactly like today (existing callers/tests unaffected).
   */
  initialFileHint?: string | null;
  /**
   * specs/remember-last-selected-file.md FR-219: called exactly once, the same moment
   * `initialFileHint` above is consulted (whether it matched or fell back) — signals the caller
   * (`App.tsx`'s `consumedFileRestoreSeqRef`) that this activation's hint has now been used, so a
   * LATER remount of this panel within the same tab session (e.g. toggling the right rail away and
   * back) is handed `null` instead of re-applying it, without needing to destroy the underlying
   * remembered value itself (which must survive for the next genuine activation, including across
   * a relaunch — AC6).
   */
  onRestoredFileConsumed?: () => void;
  /**
   * specs/remember-last-selected-file.md FR-216: fired on every file this panel loads — a manual
   * click, the ordinary `files[0]` auto-select, or the `initialFileHint` restore above — so the
   * caller can keep its own "what's currently selected" live value (`App.tsx`'s `selectedFile`
   * state, read by `useRepoTabs.ts`'s `snapshotActiveTab`) up to date.
   */
  onFileSelected?: (path: string) => void;
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
export function DetailPanel({
  detail,
  isRepoDetachedHead,
  api,
  onJumpToParent,
  onClose,
  onOpenBlame,
  initialFileHint = null,
  onRestoredFileConsumed,
  onFileSelected,
}: DetailPanelProps) {
  const diffHook = useFileDiff();
  const imageDiffHook = useImageDiff();
  // Collapsed by default so the metadata block doesn't eat the vertical space the file
  // list/diff split needs; a user who opens it once probably wants it open for the rest of
  // their session, so this deliberately does NOT reset per commit selection.
  const [metaExpanded, setMetaExpanded] = useState(false);
  // specs/blame.md FR-131: right-click state for a changed-file row's new "Blame" context menu.
  const [fileContextMenu, setFileContextMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const fileContextMenuItems: ContextMenuItem[] = useMemo(() => {
    if (!fileContextMenu || detail.status !== "ready") return [];
    const { path } = fileContextMenu;
    const sha = detail.commit.sha;
    return [
      {
        label: "Blame",
        disabled: !onOpenBlame,
        title: onOpenBlame ? undefined : "Blame is unavailable here.",
        onSelect: onOpenBlame ? () => onOpenBlame(path, sha) : undefined,
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileContextMenu, onOpenBlame, detail.status === "ready" ? detail.commit.sha : null]);

  // Must-have C13: same pattern as ChangesPanel — panel width (left edge) and the file-list/diff
  // divider inside the `__split` region.
  // Layout-persistence fix: shared with ChangesPanel/StashPanel/BlamePanel's own panelWidth call —
  // see RIGHT_PANEL_STORAGE_KEY's doc comment (lib/layoutSizes.ts) for why one storage key across
  // all four is safe despite each owning its own hook instance.
  const panelWidth = useResizableWidth({
    storageKey: RIGHT_PANEL_STORAGE_KEY,
    defaultWidth: DETAIL_PANEL_DEFAULT_WIDTH,
    min: DETAIL_PANEL_MIN_WIDTH,
    getMax: eightyVw,
    direction: -1,
  });
  const getFileListMax = useCallback(() => panelWidth.width * 0.5, [panelWidth.width]);
  const fileListWidth = useResizableWidth({
    storageKey: "githydra:layout:detailFileListWidth",
    defaultWidth: DETAIL_FILE_LIST_DEFAULT_WIDTH,
    min: DETAIL_FILE_LIST_MIN_WIDTH,
    getMax: getFileListMax,
    direction: 1,
  });

  const currentSha =
    detail.status === "loading" || detail.status === "error"
      ? detail.sha
      : detail.status === "ready"
        ? detail.commit.sha
        : null;

  const loadFileDiff = useCallback(
    (commit: { sha: string; parents: string[] }, file: ChangedFile) => {
      // specs/remember-last-selected-file.md FR-216: every file this panel ever loads — manual
      // click, auto-select, or a restored `initialFileHint` — funnels through here, so this is the
      // single point that keeps the caller's live "currently selected" value in sync.
      onFileSelected?.(file.path);
      // specs/image-diff-preview.md FR-144: image-eligible files (FR-139 — either side's
      // extension qualifying is enough for a rename) take the image-preview IPC path instead of
      // the text-diff loader; the other hook is always explicitly cleared so DiffView's
      // `result`/`imageResult` props are never simultaneously non-null.
      if (isImageEligibleChange(file.path, file.oldPath)) {
        diffHook.clear();
        imageDiffHook.load(file.path, () =>
          api.getCommitImageDiff({ sha: commit.sha, parents: commit.parents }, { path: file.path, oldPath: file.oldPath }),
        );
        return;
      }
      imageDiffHook.clear();
      diffHook.load(file.path, () =>
        api.getCommitFileDiff({ sha: commit.sha, parents: commit.parents }, { path: file.path, oldPath: file.oldPath }),
      );
    },
    [api, diffHook, imageDiffHook, onFileSelected],
  );

  // AC1/AC3/AC9: whenever the selected commit's identity changes, or its `detail` transitions
  // between loading/ready/error for the *same* sha (so this also fires on the initial
  // loading -> ready transition, not just on a sha change), drop any previously-loaded file diff
  // and — if the commit is ready with >=1 changed file — immediately load a file's diff, exactly as
  // if the user had clicked it. Reselecting a commit (including reselecting the same commit) always
  // re-picks fresh; no previously-manually-clicked file is remembered across an ordinary same-tab
  // reselection (Non-goals, unchanged by specs/remember-last-selected-file.md — see that spec's own
  // Non-goals). useLayoutEffect (not useEffect) so the "clear" and the load both land before the
  // browser paints — DiffView's idle placeholder is never shown as a visible interstitial frame
  // between two commits that each have files (AC3).
  //
  // specs/remember-last-selected-file.md FR-217/FR-219: `initialFileHint` (read directly here, NOT
  // added to this effect's own dependency array — see below) is consulted on whichever firing of
  // THIS effect happens to be current when it's read, and `onRestoredFileConsumed` is called that
  // same instant so `App.tsx` records that this activation's hint has now been used
  // (`consumedFileRestoreSeqRef`, keyed off `graph.openSequence`). Deliberately NOT keyed to a
  // per-mount ref/flag here: this component is not remounted on an ordinary tab switch (unlike
  // `ChangesPanel`, which App.tsx remounts via `key={graph.openSequence}`) — a real activation
  // instead re-fires THIS effect because it changes `currentSha` (the tab's remembered
  // `selectedSha` gets replayed via `graph.selectCommit`), so `initialFileHint` only ever needs
  // consulting when that happens to be non-null at the moment. Once consumed, `App.tsx` starts
  // handing this prop down as `null` on every later render — for every subsequent same-tab commit
  // navigation and for any later remount of this same tab's panel (e.g. toggling the right rail
  // away and back) — without needing to destroy the underlying remembered value (which must
  // survive for the next genuine activation, including across a relaunch — AC6). Never added to
  // the deps array below because reacting to the prop flipping to `null` on its own (with
  // `currentSha` unchanged) would incorrectly redo the selection that same flip is a side effect of
  // having already made.
  useLayoutEffect(() => {
    if (detail.status === "ready" && detail.files.length > 0) {
      let fileToLoad = detail.files[0]!;
      if (initialFileHint !== null) {
        onRestoredFileConsumed?.();
        const match = detail.files.find((f) => f.path === initialFileHint);
        if (match) fileToLoad = match;
      }
      loadFileDiff({ sha: detail.commit.sha, parents: detail.commit.parents }, fileToLoad);
    } else {
      diffHook.clear();
      imageDiffHook.clear();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSha, detail.status]);

  if (detail.status === "idle") return null;

  const selectFile = (commit: { sha: string; parents: string[] }, file: ChangedFile) => {
    loadFileDiff(commit, file);
  };

  return (
    <aside className="gh-detail-panel" aria-label="Commit details" role="complementary" style={{ width: panelWidth.width }}>
      <ResizeHandle label="Resize commit details panel" {...panelWidth.separatorProps} />
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
            <div className="gh-detail-panel__files" style={{ width: fileListWidth.width }}>
              <h3 className="gh-detail-panel__files-heading">Changed files ({detail.files.length})</h3>
              {detail.files.length === 0 ? (
                <p className="gh-detail-panel__no-files">No files changed.</p>
              ) : (
                <ul className="gh-detail-panel__file-list">
                  {detail.files.map((file) => {
                    // specs/image-diff-preview.md FR-144: an image-eligible file's diff lives in
                    // `imageDiffHook` instead of `diffHook` (see `loadFileDiff`), so "selected"
                    // must check whichever of the two is actually loaded for this path.
                    const isSelected =
                      (diffHook.state.status !== "idle" && diffHook.state.key === file.path) ||
                      (imageDiffHook.state.status !== "idle" && imageDiffHook.state.key === file.path);
                    return (
                      <li
                        key={`${file.oldPath ?? ""}->${file.path}`}
                        className="gh-detail-panel__file"
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setFileContextMenu({ x: e.clientX, y: e.clientY, path: file.path });
                        }}
                      >
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

            <ResizeHandle label="Resize file list" {...fileListWidth.separatorProps} />

            <div className="gh-detail-panel__diff">
              <DiffView
                fileLabel={
                  diffHook.state.status !== "idle"
                    ? diffHook.state.key
                    : imageDiffHook.state.status !== "idle"
                      ? imageDiffHook.state.key
                      : "No file selected"
                }
                loading={diffHook.state.status === "loading" || imageDiffHook.state.status === "loading"}
                errorMessage={
                  diffHook.state.status === "error"
                    ? diffHook.state.message
                    : imageDiffHook.state.status === "error"
                      ? imageDiffHook.state.message
                      : null
                }
                result={diffHook.state.status === "ready" ? diffHook.state.result : null}
                imageResult={imageDiffHook.state.status === "ready" ? imageDiffHook.state.result : null}
                emptyMessage={detail.files.length === 0 ? "No diff found for this commit." : undefined}
              />
            </div>
          </div>
        </div>
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
}
