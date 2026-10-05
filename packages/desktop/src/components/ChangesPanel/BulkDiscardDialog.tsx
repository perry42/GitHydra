// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useId, useRef } from "react";
import { ConfirmDialog } from "../ConfirmDialog/ConfirmDialog";
import { bulkDiscardCount, bulkDiscardNeedsTyping, type PendingBulkDiscard } from "../../hooks/useBulkDiscard";
import { DISCARD_CONFIRM_WORD, pathSample, plural } from "../../lib/fileSelection";
import "./BulkDialogs.css";

export interface BulkDiscardDialogProps {
  state: PendingBulkDiscard;
  canConfirm: boolean;
  onIncludeUntracked: (value: boolean) => void;
  onTyped: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

function namedList(paths: readonly string[], limit = 5): string {
  const { shown, more } = pathSample(paths, limit);
  return shown.join(", ") + (more > 0 ? ` and ${more} more` : "");
}

/**
 * specs/ignore-and-multiselect.md FR-508/FR-509 (D6, D7): confirmation for discarding several files at once. Counts and a path
 * sample are shown, Discard is never the default-focused control (Cancel, or the type-to-confirm field above 20 files),
 * and a STALE_DIFF refusal names the files that changed.
 */
export function BulkDiscardDialog({ state, canConfirm, onIncludeUntracked, onTyped, onConfirm, onCancel }: BulkDiscardDialogProps) {
  const typedId = useId();
  const typedRef = useRef<HTMLInputElement | null>(null);
  // Focus the type-to-confirm field once the snapshot arrives (it does not exist while loading). Only on that transition, so
  // ticking the untracked checkbox never pulls focus away from it.
  useEffect(() => {
    if (state.phase === "ready" && bulkDiscardNeedsTyping(state)) typedRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase]);
  const all = state.mode === "all";
  const count = bulkDiscardCount(state);
  const needsTyping = bulkDiscardNeedsTyping(state);
  const includesUntracked = !all || state.includeUntracked;
  const mixed = state.tracked.filter((r) => r.section === "mixed").length;
  const sampledPaths = [...state.tracked.map((r) => r.path), ...(includesUntracked ? state.untracked.map((r) => r.path) : [])];
  const sample = pathSample(sampledPaths);

  const title = all
    ? "Discard all changes?"
    : state.phase === "loading"
      ? "Discard changes?"
      : `Discard changes to ${plural(state.tracked.length + state.untracked.length, "file")}?`;
  let message: string;
  if (state.phase === "loading") message = "Reading the current changes…";
  else if (state.phase === "stale") {
    message = `These files changed since you opened this: ${namedList(state.stalePaths)}. Nothing was discarded. Cancel and review the changes again.`;
  } else if (count === 0 && state.phase !== "error") {
    message = "There is nothing to discard.";
  } else {
    message = all
      ? `This discards your uncommitted changes in ${plural(state.tracked.length, "tracked file")}${
          state.includeUntracked ? ` and permanently deletes ${plural(state.untracked.length, "untracked file")}` : ""
        }. Staged content is not touched. This cannot be undone.`
      : `This discards your uncommitted changes in ${plural(state.tracked.length, "tracked file")}${
          state.untracked.length > 0 ? ` and permanently deletes ${plural(state.untracked.length, "untracked file")} from disk` : ""
        }. This cannot be undone.`;
  }

  const showDetails = state.phase === "ready" || state.phase === "running";
  const skippedReasons = Array.from(new Set(state.skipped.map((s) => s.reason))).slice(0, 2).join(" ");

  return (
    <ConfirmDialog
      title={title}
      message={message}
      confirmLabel={count > 0 ? `Discard ${plural(count, "file")}` : "Discard"}
      destructive
      initialFocus="cancel"
      confirmDisabled={!canConfirm}
      busy={state.phase === "running"}
      notice={state.phase === "error" ? (state.error ?? "Discard failed.") : undefined}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      {showDetails && count > 0 && (
        <div className="gh-bulk-dialog__details">
          {mixed > 0 && (
            <p className="gh-bulk-dialog__line">
              {plural(mixed, "partly staged file")} keep their staged changes; only the unstaged part is discarded.
            </p>
          )}
          <ul className="gh-bulk-dialog__paths gh-mono" aria-label="Files to discard">
            {sample.shown.map((p) => (
              <li key={p}>{p}</li>
            ))}
            {sample.more > 0 && <li className="gh-bulk-dialog__more">and {sample.more} more</li>}
          </ul>
          {state.skipped.length > 0 && (
            <p className="gh-bulk-dialog__line">
              {state.skipped.length} skipped. {skippedReasons}
            </p>
          )}
          {all && state.untracked.length > 0 && (
            <label className="gh-bulk-dialog__check">
              <input
                type="checkbox"
                checked={state.includeUntracked}
                disabled={state.phase !== "ready"}
                onChange={(e) => onIncludeUntracked(e.target.checked)}
              />
              Also delete {plural(state.untracked.length, "untracked file")}
            </label>
          )}
          {needsTyping && (
            <div className="gh-bulk-dialog__typing">
              <label htmlFor={typedId}>
                Type <strong>{DISCARD_CONFIRM_WORD}</strong> to confirm
              </label>
              <input
                id={typedId}
                type="text"
                ref={typedRef}
                autoComplete="off"
                spellCheck={false}
                value={state.typed}
                disabled={state.phase !== "ready"}
                onChange={(e) => onTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (canConfirm) onConfirm();
                  }
                }}
              />
            </div>
          )}
        </div>
      )}
      {state.phase === "ready" && state.skipped.length > 0 && count === 0 && (
        <p className="gh-bulk-dialog__line">
          {state.skipped.length} skipped. {skippedReasons}
        </p>
      )}
    </ConfirmDialog>
  );
}
