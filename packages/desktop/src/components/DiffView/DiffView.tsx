import { useLayoutEffect, useRef } from "react";
import type { FileDiffResult } from "@githydra/git-core";
import "./DiffView.css";

export interface DiffViewProps {
  /** Path (or "oldPath -> path" for a rename/copy) shown as the diff's heading. */
  fileLabel: string;
  loading: boolean;
  errorMessage: string | null;
  /** `null` while idle (nothing selected yet) — distinct from a `FileDiffResult`, which is
   * always one of "ok"/"binary"/"too-large" once a load has completed. */
  result: FileDiffResult | null;
  /**
   * Overrides the generic "Select a file to view its diff." idle text shown when `result` is
   * `null` and nothing is loading/erroring. Callers pass this (spec's detailpanel-auto-diff
   * Must-have #4) when there is genuinely no file to select — an empty commit, or a working
   * directory with changes but nothing diffable (all Conflicted) — an explicit, distinct state
   * rather than the generic placeholder or a blank pane.
   */
  emptyMessage?: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * FR-29: line-numbered unified diff — add/remove/context coloring via DESIGN.md's status tokens
 * (good/critical), monospace per DESIGN.md's typography convention, plus explicit binary
 * (FR-21) and too-large (FR-22) states. Shared by the Changes panel and the commit DetailPanel.
 */
export function DiffView({ fileLabel, loading, errorMessage, result, emptyMessage }: DiffViewProps) {
  const rootRef = useRef<HTMLElement | null>(null);

  // Must-have #8 (specs/layout-and-view-polish.md): the diff column's scroll position starts at
  // the top on every fresh file selection — DiffView itself isn't the scroll container (both
  // callers, ChangesPanel/DetailPanel, put it inside their own `overflow-y: auto` wrapper column,
  // per DESIGN.md's two-region split pattern), so this reaches up to that immediate parent rather
  // than assuming DiffView owns its own scrolling. useLayoutEffect so the reset lands before the
  // browser paints the new content at the previous scroll offset.
  useLayoutEffect(() => {
    const scrollParent = rootRef.current?.parentElement;
    if (scrollParent) scrollParent.scrollTop = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileLabel]);

  return (
    <section className="gh-diff-view" aria-label={`Diff for ${fileLabel}`} ref={rootRef}>
      <h3 className="gh-diff-view__heading gh-mono">{fileLabel}</h3>

      {loading && (
        <p className="gh-diff-view__status" role="status" aria-live="polite" aria-busy="true">
          Loading diff…
        </p>
      )}

      {!loading && errorMessage && (
        <p className="gh-diff-view__status gh-diff-view__status--error" role="alert">
          Could not load diff: {errorMessage}
        </p>
      )}

      {!loading && !errorMessage && result === null && (
        <p className="gh-diff-view__status">{emptyMessage ?? "Select a file to view its diff."}</p>
      )}

      {!loading && !errorMessage && result?.status === "binary" && (
        <p className="gh-diff-view__status">Binary file — content not shown.</p>
      )}

      {!loading && !errorMessage && result?.status === "too-large" && (
        <p className="gh-diff-view__status">
          Diff too large to display inline
          {result.reason === "changed-lines" && result.changedLineCount != null
            ? ` (${result.changedLineCount.toLocaleString()} changed lines).`
            : result.reason === "file-size" && result.fileSizeBytes != null
              ? ` (${formatBytes(result.fileSizeBytes)}).`
              : "."}
        </p>
      )}

      {!loading && !errorMessage && result?.status === "ok" && result.hunks.length === 0 && (
        <p className="gh-diff-view__status">No changes to show.</p>
      )}

      {!loading && !errorMessage && result?.status === "ok" && result.hunks.length > 0 && (
        <div className="gh-diff-view__hunks gh-mono">
          {result.hunks.map((hunk, hunkIndex) => (
            <div className="gh-diff-view__hunk" key={hunkIndex}>
              <div className="gh-diff-view__hunk-header">{hunk.header}</div>
              {hunk.lines.map((line, lineIndex) => (
                <div
                  key={lineIndex}
                  className={`gh-diff-view__line gh-diff-view__line--${line.type}`}
                >
                  <span className="gh-diff-view__line-no" aria-hidden="true">
                    {line.oldLineNumber ?? ""}
                  </span>
                  <span className="gh-diff-view__line-no" aria-hidden="true">
                    {line.newLineNumber ?? ""}
                  </span>
                  <span className="gh-diff-view__line-marker" aria-hidden="true">
                    {line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}
                  </span>
                  <span className="gh-visually-hidden">
                    {line.type === "add" ? "Added: " : line.type === "remove" ? "Removed: " : ""}
                  </span>
                  <span className="gh-diff-view__line-content">{line.content}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
