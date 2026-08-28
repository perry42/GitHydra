import { useEffect, useId, useRef } from "react";
import "./ConfirmDialog.css";

export interface ConfirmDialogProps {
  title: string;
  /** Body copy — e.g. naming the file and stating the change is unrecoverable (FR-31). */
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** Rendered as the confirm button's visual/semantic emphasis for a destructive action. */
  destructive?: boolean;
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
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = useId();
  const messageId = useId();
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    confirmRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return (
    <div className="gh-confirm-dialog__overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        className="gh-confirm-dialog"
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
        <div className="gh-confirm-dialog__actions">
          <button type="button" className="gh-confirm-dialog__cancel" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            ref={confirmRef}
            className={`gh-confirm-dialog__confirm${destructive ? " gh-confirm-dialog__confirm--destructive" : ""}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
