// SPDX-License-Identifier: GPL-3.0-or-later
import { useId, useRef, type ReactNode } from "react";
import { useDialogChrome } from "../../hooks/useDialogChrome";
import "./ConfirmDialog.css";

export interface ConfirmDialogProps {
  title: string;
  /** Body copy — e.g. naming the file and stating the change is unrecoverable (FR-31). */
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** Rendered as the confirm button's visual/semantic emphasis for a destructive action. */
  destructive?: boolean;
  /**
   * Which control takes initial focus. Default "confirm" (existing dialogs); irreversible actions opt into "cancel".
   * "content" focuses the first element in `children` marked `data-dialog-autofocus` (e.g. a type-to-confirm field), falling
   * back to Cancel so a destructive confirm is never the default.
   */
  initialFocus?: "confirm" | "cancel" | "content";
  /** Extra detail below the message (counts, a path list, a checkbox, a text field). Keep it keyboard-complete. */
  children?: ReactNode;
  /**
   * A second, non-cancel choice placed between Cancel and the confirm button (specs/ignore-and-multiselect.md D3: "Ignore only"
   * beside "Ignore and Stop Tracking").
   */
  secondaryAction?: { label: string; onClick: () => void; disabled?: boolean };
  /** Marks the dialog busy (an operation is running); the buttons stay but the screen reader hears it. */
  busy?: boolean;
  /** Blocks the confirm button; `notice` explains why (shown as an alert under the message). */
  confirmDisabled?: boolean;
  notice?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Generic modal confirmation dialog. FR-31 requires discard to go through exactly this kind of
 * explicit step — no single-click destructive path — but it's written generically (not
 * discard-specific) since any future destructive action can reuse it.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = false,
  initialFocus = "confirm",
  children,
  secondaryAction,
  busy = false,
  confirmDisabled = false,
  notice,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = useId();
  const messageId = useId();
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const { onOverlayMouseDown } = useDialogChrome({
    onEscape: onCancel,
    escapeDeps: [onCancel],
    refocusWithEscapeEffect: true,
    getFocusTarget: () =>
      initialFocus === "cancel"
        ? cancelRef.current
        : initialFocus === "content"
          ? (dialogRef.current?.querySelector<HTMLElement>("[data-dialog-autofocus]") ?? cancelRef.current)
          : confirmRef.current,
    onBackdropClick: onCancel,
  });

  return (
    <div className="gh-confirm-dialog__overlay" onMouseDown={onOverlayMouseDown}>
      <div
        ref={dialogRef}
        className="gh-confirm-dialog"
        aria-busy={busy || undefined}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
      >
        <h2 id={titleId} className="gh-confirm-dialog__title">
          {title}
        </h2>
        <p id={messageId} className="gh-confirm-dialog__message">
          {message}
        </p>
        {children}
        {notice && (
          <p role="alert" className="gh-confirm-dialog__message">
            {notice}
          </p>
        )}
        <div className="gh-confirm-dialog__actions">
          <button type="button" ref={cancelRef} className="gh-confirm-dialog__cancel" onClick={onCancel}>
            {cancelLabel}
          </button>
          {secondaryAction && (
            <button
              type="button"
              className="gh-confirm-dialog__cancel"
              disabled={secondaryAction.disabled}
              onClick={secondaryAction.onClick}
            >
              {secondaryAction.label}
            </button>
          )}
          <button
            type="button"
            ref={confirmRef}
            className={`gh-confirm-dialog__confirm${destructive ? " gh-confirm-dialog__confirm--destructive" : ""}`}
            disabled={confirmDisabled}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
