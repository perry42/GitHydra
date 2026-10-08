// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { FileDiffResult, ImageBlob, ImageDiffResult } from "@githydra/git-core";
import { hunkFirstWorkingLine, workingLineOf, type EditOpenTarget } from "../../lib/editFile";
import { IconLock, IconPencil } from "../Icon/Icon";
import { CombinedHunks, type CombinedDiffControls } from "./CombinedHunks";
import "./DiffView.css";

export type { CombinedDiffControls } from "./CombinedHunks";

/**
 * specs/edit-in-diff.md FR-467: the diff's way into the editor. Only the Changes panel passes it; commit diffs stay
 * read-only. DiffView resolves WHAT the user pointed at (hunk, line, column) and hands that to `onEdit`.
 */
export interface DiffEditControls {
  /** null: Edit is available. Otherwise the probe's reason, shown beside the disabled button (FR-468). */
  disabledReason: string | null;
  /** The eligibility probe has not answered yet. */
  pending?: boolean;
  hint: string;
  /** Hunk the cursor/focus is on, if the diff knows one (FR-539 for `E` and the button). */
  activeHunkIndex?: number | null;
  /** False when the diff's line numbers are not working-file lines (the separate Staged diff), so open at the top (FR-539). */
  workingLinesValid: boolean;
  onEdit: (target: EditOpenTarget) => void;
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
  /**
   * specs/hunk-line-staging.md FR-453/FR-479: the eligible file's checkbox (combined) diff. When set it is
   * rendered instead of `result`; omitted/`null`: exactly the pre-existing read-only diff.
   */
  combined?: CombinedDiffControls | null;
  /** FR-481: one neutral line beside a separate-mode diff (only for the "ambiguous" fallback). */
  separateNote?: string | null;
  /** specs/hunk-line-staging.md FR-454 / changes-panel-layout.md FR-490: stale-diff note, one collapsed line beside the diff. */
  notice?: { summary: string; details: string } | null;
  /** FR-454: a failed hunk/line action. Rendered beside the diff with role="alert"; `details` sits behind a disclosure. */
  error?: { summary: string; details: string } | null;
  onDismissError?: () => void;
  /** Outcome text for the polite live region ("Staged 3 lines", failure summary...). */
  announcement?: string | null;
  /** specs/edit-in-diff.md FR-467: Edit button, double-click and `E`. Omitted: the diff is read-only, exactly as before. */
  edit?: DiffEditControls | null;
}

const TEXT_INPUT = "input, textarea, select, [contenteditable=''], [contenteditable='true']";

/** Character offset within a content span at a screen point; 0 where the platform cannot say (jsdom). */
function columnAt(content: HTMLElement, x: number, y: number): number {
  const doc = content.ownerDocument as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  let node: Node | null = null;
  let offset = 0;
  if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(x, y);
    node = p?.offsetNode ?? null;
    offset = p?.offset ?? 0;
  } else if (doc.caretRangeFromPoint) {
    const r = doc.caretRangeFromPoint(x, y);
    node = r?.startContainer ?? null;
    offset = r?.startOffset ?? 0;
  }
  return node && content.contains(node) && node.nodeType === Node.TEXT_NODE ? offset : 0;
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
 * specs/changes-panel-layout.md FR-490: a failure or stale-diff note collapsed to one line beside the
 * diff; `details` opens on demand in a box capped at about four lines that scrolls inside. Detail
 * state resets whenever a new message arrives, so a fresh failure never opens pre-expanded.
 */
function DiffAlert({
  role,
  tone,
  message,
  onDismiss,
}: {
  role: "alert" | "status";
  tone: "error" | "notice";
  message: { summary: string; details: string };
  onDismiss?: () => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [message]);
  return (
    <div
      className={`gh-diff-view__status gh-diff-view__failure gh-diff-view__${tone === "error" ? "status--error" : "notice"}`}
      role={role}
    >
      <div className="gh-diff-view__failure-line">
        <p className="gh-diff-view__failure-summary" title={message.summary}>
          {message.summary}
        </p>
        <div className="gh-diff-view__failure-actions">
          {message.details && (
            <button type="button" className="gh-diff-view__link-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              {open ? "Hide details" : "Show details"}
            </button>
          )}
          {onDismiss && (
            <button type="button" className="gh-diff-view__link-btn" onClick={onDismiss}>
              Dismiss
            </button>
          )}
        </div>
      </div>
      {open && <pre className="gh-diff-view__failure-details">{message.details}</pre>}
    </div>
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
  combined,
  separateNote,
  notice,
  error,
  onDismissError,
  announcement,
  edit,
}: DiffViewProps) {
  const rootRef = useRef<HTMLElement | null>(null);
  const reasonId = useId();
  const [live, setLive] = useState("");
  const [flash, setFlash] = useState(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (flashTimer.current && clearTimeout(flashTimer.current)), []);
  const separateMessage = useMemo(() => ({ summary: separateNote ?? "", details: "" }), [separateNote]);

  // An identical repeat message ("Staged 1 line" twice) would not change the region's text and so would
  // stay silent; a trailing no-break space makes the second one a real change.
  useEffect(() => {
    setLive((prev) => (announcement ? (prev === announcement ? `${announcement} ` : announcement) : ""));
  }, [announcement]);

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

  const hunkList = combined ? combined.hunks : result?.status === "ok" ? result.hunks : [];
  const hunkCount = hunkList.length;

  // FR-467/FR-468: an ineligible file gets a brief non-modal reason (flashed and announced), never an editor.
  const refuse = () => {
    if (!edit?.disabledReason) return;
    setFlash(true);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(false), 1200);
    const text = `Edit unavailable: ${edit.disabledReason}`;
    setLive((prev) => (prev === text ? `${text} ` : text));
  };

  // FR-539: the hunk the user came from: focus inside a hunk, else the diff's cursor hunk, else the first one in view.
  const hunkInFocus = (): number => {
    const focused = document.activeElement as HTMLElement | null;
    const header = focused?.closest?.("[data-hunk-header]") as HTMLElement | null;
    if (header) return Number(header.dataset.hunkHeader);
    if (edit?.activeHunkIndex != null && edit.activeHunkIndex < hunkCount) return edit.activeHunkIndex;
    const box = rootRef.current?.querySelector<HTMLElement>(".gh-diff-view__hunks");
    if (box) {
      const top = box.getBoundingClientRect().top + 4;
      const hunks = Array.from(box.querySelectorAll<HTMLElement>(".gh-diff-view__hunk"));
      const i = hunks.findIndex((el) => el.getBoundingClientRect().bottom > top);
      if (i > 0) return i;
    }
    return 0;
  };
  const targetForHunk = (): EditOpenTarget => {
    if (!edit?.workingLinesValid || hunkCount === 0) return {};
    const hunk = hunkList[hunkInFocus()];
    return hunk ? { line: hunkFirstWorkingLine(hunk) } : {};
  };
  const startEdit = () => {
    if (!edit) return;
    if (edit.disabledReason) return refuse();
    if (edit.pending) return;
    edit.onEdit(targetForHunk());
  };

  const onDiffKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (!edit || e.code !== "KeyE" || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.nativeEvent.isComposing) return;
    if ((e.target as HTMLElement).closest?.(TEXT_INPUT)) return;
    e.preventDefault();
    startEdit();
  };

  // FR-467: only a diff row's text starts an edit. The gutter (checkboxes, line numbers), hunk header and its buttons, and
  // any button never do, and a double-click on text toggles nothing because only the gutter carries a checkbox.
  const onDiffDoubleClick = (e: MouseEvent<HTMLElement>) => {
    if (!edit) return;
    const target = e.target as HTMLElement;
    if (target.closest("button, a, input, select, textarea")) return;
    const content = target.closest<HTMLElement>(".gh-diff-view__line-content");
    if (!content) return;
    if (edit.disabledReason) return refuse();
    if (edit.pending) return;
    window.getSelection()?.removeAllRanges();
    const row = content.closest<HTMLElement>("[data-line-index]");
    const h = Number(row?.dataset.hunkIndex);
    const i = Number(row?.dataset.lineIndex);
    const lines = Number.isFinite(h) ? hunkList[h]?.lines : undefined;
    const line = edit.workingLinesValid && lines && Number.isFinite(i) ? workingLineOf(lines, i) : null;
    if (line === null) return edit.onEdit({});
    const onRemoved = lines![i]!.type === "remove";
    edit.onEdit({ line, column: onRemoved ? 0 : columnAt(content, e.clientX, e.clientY) });
  };

  return (
    <section
      className="gh-diff-view"
      aria-label={`Diff for ${fileLabel}`}
      ref={rootRef}
      onKeyDown={edit ? onDiffKeyDown : undefined}
      onDoubleClick={edit ? onDiffDoubleClick : undefined}
    >
      <div className="gh-diff-view__head">
        <h3 className="gh-diff-view__heading gh-mono">{fileLabel}</h3>
        {edit && (
          <button
            type="button"
            className="gh-diff-view__edit"
            data-edit-button=""
            aria-disabled={edit.disabledReason || edit.pending ? true : undefined}
            aria-describedby={edit.disabledReason ? reasonId : undefined}
            title={edit.disabledReason ? `Edit unavailable: ${edit.disabledReason}` : edit.pending ? "Checking whether this file can be edited…" : edit.hint}
            onClick={startEdit}
          >
            {edit.disabledReason ? <IconLock /> : <IconPencil />} Edit
          </button>
        )}
      </div>
      {edit?.disabledReason && (
        <p id={reasonId} className={`gh-diff-view__edit-reason${flash ? " gh-diff-view__edit-reason--flash" : ""}`}>
          <IconLock /> Edit unavailable: {edit.disabledReason}
        </p>
      )}

      {/* FR-453: always mounted (when staging is offered) so text changes are announced, not mount events. */}
      {(combined || announcement || edit) && (
        <div className="gh-visually-hidden" role="status" aria-live="polite" aria-atomic="true">
          {live}
        </div>
      )}

      {error && !loading && (
        <DiffAlert role="alert" tone="error" message={error} onDismiss={onDismissError} />
      )}

      {notice && !loading && <DiffAlert role="status" tone="notice" message={notice} />}

      {/* FR-481: the one place the ambiguous fallback is explained; same one-line pattern as the notices above. */}
      {separateNote && !loading && !errorMessage && result?.status === "ok" && (
        <DiffAlert role="status" tone="notice" message={separateMessage} />
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

      {!loading && !errorMessage && result === null && !imageResult && !combined && (
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

      {!loading && !errorMessage && combined && (
        <div className="gh-diff-view__hunks-region">
          <div className="gh-diff-view__hunks gh-mono">
            {/* Keyed by file so the cursor and Shift anchor reset on a different file but survive a reload. */}
            <CombinedHunks key={fileLabel} controls={combined} />
          </div>
        </div>
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
          <div
            className="gh-diff-view__hunks gh-mono"
            {...(edit ? { tabIndex: 0, role: "region", "aria-label": `Diff of ${fileLabel}${edit.disabledReason ? "" : ". Press E to edit the working copy."}` } : {})}
          >
            {result.hunks.map((hunk, hunkIndex) => (
              <div className="gh-diff-view__hunk" key={hunkIndex}>
                <div className="gh-diff-view__hunk-header">{hunk.header}</div>
                {hunk.lines.map((line, lineIndex) => (
                  <div
                    key={lineIndex}
                    className={`gh-diff-view__line gh-diff-view__line--${line.type}`}
                    data-hunk-index={hunkIndex}
                    data-line-index={lineIndex}
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
        </div>
      )}
    </section>
  );
}
