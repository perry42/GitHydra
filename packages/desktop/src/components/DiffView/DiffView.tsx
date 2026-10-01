// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FileDiffResult, ImageBlob, ImageDiffResult } from "@githydra/git-core";
import { PartialStagingHunks, type FocusHint, type PartialStagingControls } from "./PartialStagingHunks";
import "./DiffView.css";

export type { PartialStagingControls } from "./PartialStagingHunks";

// Per-viewer (not per-repo) dismissal of the one-line discoverability hint; storage may be unavailable.
const HINT_KEY = "githydra:hint:partialStagingGutter";
function readHintDismissed(): boolean {
  try {
    return window.localStorage.getItem(HINT_KEY) === "1";
  } catch {
    return false;
  }
}

export interface DiffViewProps {
  /** Path (or "oldPath -> path" for a rename/copy) shown as the diff's heading. */
  fileLabel: string;
  loading: boolean;
  errorMessage: string | null;
  /** `null` while idle (nothing selected yet) — distinct from a `FileDiffResult`, which is
   * always one of "ok"/"binary"/"too-large" once a load has completed. */
  result: FileDiffResult | null;
  /**
   * specs/image-diff-preview.md FR-144: set (non-null) instead of `result` when the selected
   * file is image-eligible (`isImageEligiblePath()`) — the caller's loader decides which of
   * `result`/`imageResult` to populate per load, and always clears the other, so at most one is
   * ever non-null at a time. `undefined`/`null` (every existing caller that predates this spec)
   * behaves exactly as before — this prop is purely additive.
   */
  imageResult?: ImageDiffResult | null;
  /**
   * Overrides the generic "Select a file to view its diff." idle text shown when `result` is
   * `null` and nothing is loading/erroring. Callers pass this (spec's detailpanel-auto-diff
   * Must-have #4) when there is genuinely no file to select — an empty commit, or a working
   * directory with changes but nothing diffable (all Conflicted) — an explicit, distinct state
   * rather than the generic placeholder or a blank pane.
   */
  emptyMessage?: string;
  /** See `PartialStagingControls`. Omitted: exactly the pre-existing read-only diff. */
  partialStaging?: PartialStagingControls;
  /** specs/hunk-line-staging.md FR-454: transient status line above the hunks, e.g. "File changed. Diff reloaded." */
  notice?: string | null;
  /** FR-454: a failed hunk/line action. Rendered beside the diff with role="alert"; `details` sits behind a disclosure. */
  error?: { summary: string; details: string } | null;
  onDismissError?: () => void;
  /** Outcome text for the polite live region ("Staged 3 lines", failure summary...). */
  announcement?: string | null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * specs/image-diff-preview.md FR-144/FR-145: one side of an image diff — a real `<img>` via a
 * `data:` URI built from `mimeType`+`base64` (the actual point of the feature, not a filename/size
 * label), captioned with its byte size (`formatBytes`, reused from the text-diff too-large state
 * above). Using `<img src="data:...">` rather than `dangerouslySetInnerHTML` means even a
 * malformed/hostile `.svg` is rendered as a flat raster-like image, never as script-capable inline
 * markup — see the spec's "Edge cases & constraints".
 */
function ImageDiffSlot({ label, blob, fileLabel }: { label: string; blob: ImageBlob; fileLabel: string }) {
  return (
    <figure className="gh-diff-view__image-slot">
      <figcaption className="gh-diff-view__image-caption">
        {label} · {formatBytes(blob.byteSize)}
      </figcaption>
      <img
        className="gh-diff-view__image"
        src={`data:${blob.mimeType};base64,${blob.base64}`}
        alt={`${label} version of ${fileLabel}`}
      />
    </figure>
  );
}

/**
 * FR-29: line-numbered unified diff — add/remove/context coloring via DESIGN.md's status tokens
 * (good/critical), monospace per DESIGN.md's typography convention, plus explicit binary
 * (FR-21) and too-large (FR-22) states. Shared by the Changes panel and the commit DetailPanel.
 * specs/image-diff-preview.md FR-144 extends this with an image-preview branch (`imageResult`),
 * checked ahead of the text-diff branches below — the caller's loader already decided which of
 * `result`/`imageResult` to populate, so this component just renders whichever is non-null.
 */
export function DiffView({
  fileLabel,
  loading,
  errorMessage,
  result,
  imageResult,
  emptyMessage,
  partialStaging,
  notice,
  error,
  onDismissError,
  announcement,
}: DiffViewProps) {
  const rootRef = useRef<HTMLElement | null>(null);
  const focusHintRef = useRef<FocusHint | null>(null);
  const [live, setLive] = useState("");
  const [hintDismissed, setHintDismissed] = useState(readHintDismissed);
  const [detailsOpen, setDetailsOpen] = useState(false);

  useEffect(() => {
    if (announcement) setLive(announcement);
  }, [announcement]);
  useEffect(() => setDetailsOpen(false), [error]);
  const announce = useCallback((message: string) => setLive(message), []);
  const dismissHint = () => {
    setHintDismissed(true);
    try {
      window.localStorage.setItem(HINT_KEY, "1");
    } catch {
      /* remembered for this session only */
    }
  };

  // Must-have #8 (specs/layout-and-view-polish.md): the diff column's scroll position starts at
  // the top on every fresh file selection — DiffView itself isn't the scroll container (both
  // callers, ChangesPanel/DetailPanel, put it inside their own `overflow-y: auto` wrapper column,
  // per DESIGN.md's two-region split pattern), so this reaches up to that immediate parent rather
  // than assuming DiffView owns its own scrolling. useLayoutEffect so the reset lands before the
  // browser paints the new content at the previous scroll offset.
  useLayoutEffect(() => {
    const scrollParent = rootRef.current?.parentElement;
    if (scrollParent) scrollParent.scrollTop = 0;
    focusHintRef.current = null; // a pending focus-restore never crosses to a different file
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileLabel]);

  return (
    <section className="gh-diff-view" aria-label={`Diff for ${fileLabel}`} ref={rootRef}>
      <h3 className="gh-diff-view__heading gh-mono">{fileLabel}</h3>

      {/* FR-453: always mounted (when staging is offered) so text changes are announced, not mount events. */}
      {partialStaging && (
        <div className="gh-visually-hidden" role="status" aria-live="polite" aria-atomic="true">
          {live}
        </div>
      )}

      {!loading && !errorMessage && partialStaging && result?.status === "ok" && result.partialStaging?.eligible && result.hunks.length > 0 && !hintDismissed && (
        <p className="gh-diff-view__hint">
          <span>Select lines in the gutter to stage part of a hunk</span>
          <button type="button" className="gh-diff-view__hint-dismiss" aria-label="Dismiss hint" onClick={dismissHint}>
            ×
          </button>
        </p>
      )}

      {error && !loading && (
        <div className="gh-diff-view__status gh-diff-view__status--error gh-diff-view__failure" role="alert">
          <p className="gh-diff-view__failure-summary">{error.summary}</p>
          <div className="gh-diff-view__failure-actions">
            {error.details && (
              <button
                type="button"
                className="gh-diff-view__link-btn"
                aria-expanded={detailsOpen}
                onClick={() => setDetailsOpen((o) => !o)}
              >
                {detailsOpen ? "Hide details" : "Show details"}
              </button>
            )}
            <button type="button" className="gh-diff-view__link-btn" onClick={onDismissError}>
              Dismiss
            </button>
          </div>
          {detailsOpen && <pre className="gh-diff-view__failure-details">{error.details}</pre>}
        </div>
      )}

      {notice && !loading && (
        <p className="gh-diff-view__status gh-diff-view__notice" role="status">
          {notice}
        </p>
      )}

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

      {!loading && !errorMessage && result === null && !imageResult && (
        <p className="gh-diff-view__status">{emptyMessage ?? "Select a file to view its diff."}</p>
      )}

      {/* specs/image-diff-preview.md FR-146: an image "too-large" result reuses this exact
       * text/pattern — no new visual state, just no byte-count parenthetical (an oversized image
       * side is refused before its size is ever read into a caption-worthy value). */}
      {!loading && !errorMessage && imageResult?.status === "too-large" && (
        <p className="gh-diff-view__status">Diff too large to display inline.</p>
      )}

      {/* FR-144: Added (new only) / Deleted (old only) / Modified-or-renamed (both, Before/After)
       * — static side-by-side only, no slider (see spec's Non-goals). */}
      {!loading && !errorMessage && imageResult?.status === "ok" && (
        <>
          {imageResult.old === null && imageResult.new === null && (
            <p className="gh-diff-view__status">No changes to show.</p>
          )}
          {imageResult.old === null && imageResult.new !== null && (
            <div className="gh-diff-view__image-region">
              <ImageDiffSlot label="Added" blob={imageResult.new} fileLabel={fileLabel} />
            </div>
          )}
          {imageResult.new === null && imageResult.old !== null && (
            <div className="gh-diff-view__image-region">
              <ImageDiffSlot label="Deleted" blob={imageResult.old} fileLabel={fileLabel} />
            </div>
          )}
          {imageResult.old !== null && imageResult.new !== null && (
            <div className="gh-diff-view__image-region">
              <ImageDiffSlot label="Before" blob={imageResult.old} fileLabel={fileLabel} />
              <ImageDiffSlot label="After" blob={imageResult.new} fileLabel={fileLabel} />
            </div>
          )}
        </>
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
        // Bugfix (test-agent, follow-up to 0caf066): an invisible, flex-grown wrapper around the
        // bordered hunks box — it, not `.gh-diff-view__hunks` itself, absorbs the space left over
        // after the heading, so the hunks box's `max-height: min(70vh, 100%)` (DiffView.css)
        // resolves against the diff column's *actual remaining* height rather than its full
        // height (which previously ignored the heading's own height, letting a long diff overflow
        // the diff column itself — a nested double-scrollbar — instead of being fully absorbed by
        // the hunks box's own internal scroll). The wrapper has no visible styling, so a short
        // diff still renders at its natural height with no visible "stretched empty box" (Must-
        // have 9) even though the wrapper itself grows to fill the leftover space.
        <div className="gh-diff-view__hunks-region">
          <div className="gh-diff-view__hunks gh-mono">
            {partialStaging && result.partialStaging?.eligible && result.fingerprint ? (
              // Keyed by fingerprint so a reloaded (changed) diff drops any stale line selection.
              <PartialStagingHunks
                key={result.fingerprint}
                hunks={result.hunks}
                controls={partialStaging}
                announce={announce}
                focusHintRef={focusHintRef}
              />
            ) : (
              result.hunks.map((hunk, hunkIndex) => (
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
              ))
            )}
          </div>
        </div>
      )}
    </section>
  );
}
