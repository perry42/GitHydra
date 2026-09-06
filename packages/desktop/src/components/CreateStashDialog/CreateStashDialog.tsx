// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import type { WorkingDirectoryChanges, WorkingDirectoryFileChange } from "@githydra/git-core";
import type { GitHydraApi } from "../../../shared/ipcContract";
import { unwrap } from "../../hooks/gitHydraClient";
import { FileStatusIcon } from "../FileStatusIcon/FileStatusIcon";
import "./CreateStashDialog.css";

export interface CreateStashDialogProps {
  api: GitHydraApi;
  /** FR-100: a bare repository has no working directory to stash from at all. */
  isBare: boolean;
  /** FR-100/AC6: an unborn HEAD (zero commits) — `git stash` has no parent to create a stash
   * commit against. */
  isUnbornHead: boolean;
  onClose: () => void;
  /** Called after a successful create, before `onClose` — the caller runs FR-101's full refresh
   * contract. */
  onCreated: () => void;
  /**
   * specs/self-write-refresh-suppression.md FR-6b / specs/stash.md FR-92: called synchronously
   * right before issuing `createStash`, so the self-write gate is open before the write can trip
   * the fs watcher.
   */
  onMutationStart?: () => void;
  /** FR-92: closes the gate on a failed create — `onCreated` is deliberately not called then. */
  onMutationSettled?: () => void;
}

interface Row {
  category: "staged" | "unstaged" | "untracked";
  entry: WorkingDirectoryFileChange;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** FR-84/FR-99: Conflicted paths are never listed here — `getWorkingDirectoryChanges()` already
 * reports them in their own separate `conflicted` category, structurally excluded from this
 * flattened checklist (mirrors `createStash()`'s own "never touch conflicted paths" rule). */
function flatten(changes: WorkingDirectoryChanges): Row[] {
  return [
    ...changes.staged.map((entry) => ({ category: "staged" as const, entry })),
    ...changes.unstaged.map((entry) => ({ category: "unstaged" as const, entry })),
    ...changes.untracked.map((entry) => ({ category: "untracked" as const, entry })),
  ];
}

const SECTIONS: { category: Row["category"]; label: string }[] = [
  { category: "staged", label: "Staged" },
  { category: "unstaged", label: "Unstaged" },
  { category: "untracked", label: "Untracked" },
];

/**
 * FR-99: reuses `ConfirmDialog`'s modal shell/overlay treatment as a form (matching
 * `NewBranchDialog`'s precedent) — an optional message field, a file checklist defaulting to all
 * checked, and an "Include untracked files" checkbox defaulting unchecked (git's own default).
 * Reachable from both `StashPanel`'s header and `ChangesPanel`'s secondary entry point; one
 * instance handles both since neither passes anything caller-specific beyond `onClose`/`onCreated`.
 */
export function CreateStashDialog({
  api,
  isBare,
  isUnbornHead,
  onClose,
  onCreated,
  onMutationStart,
  onMutationSettled,
}: CreateStashDialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const [loadStatus, setLoadStatus] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [changes, setChanges] = useState<WorkingDirectoryChanges | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("");
  const [includeUntracked, setIncludeUntracked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (isBare || isUnbornHead) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = unwrap(await api.getWorkingDirectoryChanges());
        if (cancelled) return;
        if (result === null) {
          setLoadStatus("error");
          setLoadError("This repository has no working directory.");
          return;
        }
        setChanges(result);
        setChecked(new Set(flatten(result).map((r) => `${r.category}:${r.entry.path}`)));
        setLoadStatus("ready");
      } catch (err) {
        if (cancelled) return;
        setLoadStatus("error");
        setLoadError(messageOf(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, isBare, isUnbornHead]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    dialogRef.current?.querySelector<HTMLElement>("input,textarea,button")?.focus();
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const rows = useMemo(() => (changes ? flatten(changes) : []), [changes]);

  function toggle(key: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // FR-99: an untracked file's checklist entry only actually counts toward the create call while
  // "Include untracked files" is on (matching git's own `--include-untracked` semantics) — kept
  // visually unchecked+disabled while the master toggle is off, without discarding the user's
  // underlying per-file selection, so re-enabling the toggle restores it.
  const selectedPaths = rows
    .filter((r) => checked.has(`${r.category}:${r.entry.path}`) && (r.category !== "untracked" || includeUntracked))
    .map((r) => r.entry.path);
  const canSubmit = !submitting && selectedPaths.length > 0;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    onMutationStart?.();
    try {
      unwrap(
        await api.createStash({
          message: message.trim() || undefined,
          paths: selectedPaths,
          includeUntracked,
        }),
      );
      onCreated();
      onClose();
    } catch (err) {
      setSubmitError(messageOf(err));
      onMutationSettled?.();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="gh-create-stash__overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialogRef} className="gh-create-stash" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId} className="gh-create-stash__title">
          New Stash
        </h2>

        {isBare && (
          <>
            {/* Edge cases: a bare repository has no working directory — an explicit message
                rather than a broken form, matching NewBranchDialog's unborn-HEAD treatment. */}
            <p className="gh-create-stash__empty">
              This is a bare repository — it has no working directory, so there is nothing to
              stash.
            </p>
            <div className="gh-create-stash__actions">
              <button type="button" className="gh-create-stash__cancel" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}

        {!isBare && isUnbornHead && (
          <>
            <p className="gh-create-stash__empty">
              This repository has no commits yet, so there is nothing to stash against. Make the
              first commit, then create a stash.
            </p>
            <div className="gh-create-stash__actions">
              <button type="button" className="gh-create-stash__cancel" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}

        {!isBare && !isUnbornHead && loadStatus === "loading" && (
          <p className="gh-create-stash__status" role="status" aria-live="polite" aria-busy="true">
            Loading changes…
          </p>
        )}

        {!isBare && !isUnbornHead && loadStatus === "error" && (
          <>
            <p className="gh-create-stash__error" role="alert">
              {loadError}
            </p>
            <div className="gh-create-stash__actions">
              <button type="button" className="gh-create-stash__cancel" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}

        {!isBare && !isUnbornHead && loadStatus === "ready" && rows.length === 0 && (
          <>
            <p className="gh-create-stash__empty">There are no changes to stash.</p>
            <div className="gh-create-stash__actions">
              <button type="button" className="gh-create-stash__cancel" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}

        {!isBare && !isUnbornHead && loadStatus === "ready" && rows.length > 0 && (
          <form onSubmit={(e) => void handleSubmit(e)}>
            <label className="gh-create-stash__label" htmlFor="gh-stash-message">
              Message (optional)
            </label>
            <input
              id="gh-stash-message"
              type="text"
              className="gh-create-stash__input"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Leave blank to use git's default message"
            />

            <label className="gh-create-stash__checkbox">
              <input type="checkbox" checked={includeUntracked} onChange={(e) => setIncludeUntracked(e.target.checked)} />
              Include untracked files
            </label>

            <div className="gh-create-stash__files">
              {SECTIONS.map((section) => {
                const sectionRows = rows.filter((r) => r.category === section.category);
                if (sectionRows.length === 0) return null;
                return (
                  <div key={section.category} className="gh-create-stash__section">
                    <h3 className="gh-create-stash__section-heading">
                      {section.label} ({sectionRows.length})
                    </h3>
                    <ul className="gh-create-stash__file-list">
                      {sectionRows.map((row) => {
                        const key = `${row.category}:${row.entry.path}`;
                        const disabled = row.category === "untracked" && !includeUntracked;
                        return (
                          <li key={key} className="gh-create-stash__file">
                            <label className="gh-create-stash__file-label">
                              <input
                                type="checkbox"
                                checked={checked.has(key) && !disabled}
                                disabled={disabled}
                                onChange={() => toggle(key)}
                              />
                              <FileStatusIcon status={row.entry.status} />
                              <span className="gh-mono gh-create-stash__file-path">
                                {row.entry.oldPath ? `${row.entry.oldPath} → ${row.entry.path}` : row.entry.path}
                              </span>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
            </div>

            {submitError && (
              <p className="gh-create-stash__error" role="alert">
                {submitError}
              </p>
            )}

            <div className="gh-create-stash__actions">
              <button type="button" className="gh-create-stash__cancel" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="gh-create-stash__submit" disabled={!canSubmit}>
                {submitting ? "Creating…" : "Create stash"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
