// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useId, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { OrphanedHeadResult } from "@githydra/git-core";
import "../ConfirmDialog/ConfirmDialog.css";
import "./OrphanedCommitsDialog.css";

export interface OrphanedCommitsDialogProps {
  result: OrphanedHeadResult;
  /** Drag/palette context sentence, e.g. "Merging A into B needs to check out B first." (text only). */
  description: string | null;
  /** True when the previous dialog was invalidated by a HeadMovedError. */
  headMoved: boolean;
  onCreateBranch: () => void;
  onLeave: () => void;
  onCancel: () => void;
}

/** "1 commit" / "N commits" / "1000+ commits" (git-core caps the count). */
export function orphanCountLabel(total: number, capped: boolean): string {
  if (capped) return `${total}+ commits`;
  return total === 1 ? "1 commit" : `${total} commits`;
}

/**
 * specs/branch-panel-drag-merge.md FR-430: asked before ANY GitHydra-initiated checkout leaves a
 * detached HEAD whose commits no branch/tag/remote reaches (or when that could not be determined -
 * `unknown` is treated exactly like `orphaned`, minus the commit list). Reuses ConfirmDialog's
 * shell/overlay. Cancel gets initial focus and is the Escape/backdrop action; Tab order is Create,
 * Leave, Cancel and focus is trapped inside the panel. Commit subjects are React text nodes in
 * dir="auto"/unicode-bidi:isolate containers (git-core already strips control/bidi characters).
 */
export function OrphanedCommitsDialog({
  result,
  description,
  headMoved,
  onCreateBranch,
  onLeave,
  onCancel,
}: OrphanedCommitsDialogProps) {
  const titleId = useId();
  const messageId = useId();
  const createRef = useRef<HTMLButtonElement | null>(null);
  const leaveRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  const unknown = result.status !== "orphaned";
  const canCreate = result.headSha !== null;
  const hiddenCount = result.total - result.shown.length;

  useEffect(() => {
    cancelRef.current?.focus(); // safe default: the initial focus is never a destructive action.
    // Capture phase + stopPropagation so an underlying dialog's own Escape handler (e.g. New Branch)
    // does not also close.
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onCancelRef.current();
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, []);

  function onPanelKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Tab") return;
    const order = [canCreate ? createRef.current : null, leaveRef.current, cancelRef.current].filter(
      (el): el is HTMLButtonElement => el !== null,
    );
    const idx = order.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.shiftKey ? (idx <= 0 ? order.length - 1 : idx - 1) : idx === -1 || idx === order.length - 1 ? 0 : idx + 1;
    e.preventDefault();
    order[next]?.focus();
  }

  return (
    <div
      className="gh-confirm-dialog__overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="gh-confirm-dialog gh-orphan-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        onKeyDown={onPanelKeyDown}
      >
        <h2 id={titleId} className="gh-confirm-dialog__title">
          {unknown ? "Couldn't check whether this HEAD has unsaved commits" : "This HEAD has commits not saved on any branch"}
        </h2>

        <div id={messageId} className="gh-confirm-dialog__message" dir="auto">
          {headMoved && (
            <p className="gh-orphan-dialog__notice" role="alert">
              Heads up: HEAD changed while the dialog was open. Nothing was changed; please review again.
            </p>
          )}
          {description && <p dir="auto">{description}</p>}
          {unknown ? (
            <p>
              You are on a detached HEAD. If it has commits that no branch, tag, or remote reaches, leaving it will make
              them hard to find again.
            </p>
          ) : (
            <p>
              <span className="gh-orphan-dialog__count">{orphanCountLabel(result.total, result.totalIsCapped)}</span>{" "}
              would be left behind: no branch, tag, or remote points at them.
            </p>
          )}
          <p>They stay recoverable through the reflog for a limited time, but will no longer appear in the graph.</p>
        </div>

        {!unknown && result.shown.length > 0 && (
          <div>
            <ul className="gh-orphan-dialog__list" aria-label="Commits that would be left behind">
              {result.shown.map((c) => (
                <li key={c.sha} className="gh-orphan-dialog__row">
                  <span className="gh-mono gh-orphan-dialog__sha">{c.shortSha}</span>
                  <span className="gh-orphan-dialog__subject" dir="auto">
                    {c.subject}
                  </span>
                </li>
              ))}
            </ul>
            {hiddenCount > 0 && (
              <div className="gh-orphan-dialog__more">
                and {hiddenCount}
                {result.totalIsCapped ? "+" : ""} more
              </div>
            )}
          </div>
        )}

        <div className="gh-confirm-dialog__actions gh-orphan-dialog__actions">
          {canCreate && (
            <button
              type="button"
              ref={createRef}
              className="gh-confirm-dialog__confirm gh-orphan-dialog__action"
              onClick={onCreateBranch}
            >
              Create branch here…
            </button>
          )}
          <button
            type="button"
            ref={leaveRef}
            className="gh-confirm-dialog__cancel gh-orphan-dialog__action gh-orphan-dialog__leave"
            onClick={onLeave}
          >
            Leave commits behind
          </button>
          <button
            type="button"
            ref={cancelRef}
            className="gh-confirm-dialog__cancel gh-orphan-dialog__action"
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
