// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { GitHydraApi } from "../../../shared/ipcContract";
import { unwrap } from "../../hooks/gitHydraClient";
import { useCloneAction } from "../../hooks/useCloneAction";
import { useElapsedSeconds } from "../../hooks/useElapsedSeconds";
import { deriveRepoNameFromUrl, isAbsoluteDestinationPath, joinDestinationPath } from "../../lib/cloneDestination";
// Reuses `.gh-fetch-banner*`/`.gh-status-banner*` verbatim for the in-progress/error states — same
// explicit-import convention `PushStatusBanner.tsx` already established for the identical reason
// (this dialog's progress/cancel/credential-failure chrome must not fork from Phase 1's own,
// FR-354/FR-357).
import "../FetchStatusBanner/FetchStatusBanner.css";
import "../StatusBanner/StatusBanner.css";
import "./CloneDialog.css";

export interface CloneDialogProps {
  api: GitHydraApi;
  onClose: () => void;
  /** specs/online-sync-clone.md FR-356: called with the resolved destination path once `clone()`
   * genuinely succeeds — the caller opens it as a new tab / adds it to Recent Repositories via the
   * app's existing open-tab flow and is expected to unmount this dialog in response (this component
   * never closes itself on success; `App.tsx` owns that so the same call also drives the new tab). */
  onCloned: (path: string) => void;
}

/**
 * specs/online-sync-clone.md FR-351/FR-354/FR-356/FR-357: activates the landing screen's
 * previously reserved-but-inert "Clone a repository" slot — a URL field, a destination field with
 * a native-folder-picker-assisted "Browse…" button (FR-358: no host-browsing UI, just these two
 * fields, matching git-core's own non-goals), and Phase 1's exact progress/cancel/credential-
 * failure chrome reused verbatim (no parallel implementation, per FR-354/FR-357). Reuses
 * `NewBranchDialog`'s modal shell/CSS shape (`ConfirmDialog`-precedent form-as-dialog) rather than
 * inventing a new one.
 */
export function CloneDialog({ api, onClose, onCloned }: CloneDialogProps) {
  const titleId = useId();
  const urlId = useId();
  const destinationId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const [url, setUrl] = useState("");
  const [destination, setDestination] = useState("");
  const [destinationTouched, setDestinationTouched] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  // ROADMAP.md "Clone: minor rough edges" — set on a failed submit attempt when a manually-typed
  // (not Browse-picked) destination is relative; a Browse-picked destination is always absolute
  // already, so this can only ever fire for a hand-typed value. Cleared on the next edit so a
  // stale message never survives past the fix that resolves it.
  const [destinationPathError, setDestinationPathError] = useState<string | null>(null);

  const clone = useCloneAction({ api, onCloned });
  const elapsedSeconds = useElapsedSeconds(clone.phase === "cloning", clone.cloneSequence);

  // Mount-only: focuses the first control once, exactly like `NewBranchDialog`'s identical effect.
  // Deliberately a SEPARATE effect from the Escape-key listener below — `useCloneAction`'s returned
  // object is a fresh reference on every render (it's a plain object literal, not memoized), so a
  // single combined effect depending on it would re-run (and re-steal focus back to this first
  // control) on every keystroke into either field, exactly the input-stealing bug this split fixes.
  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>("input,button")?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // FR-354: an in-flight clone is never silently orphaned by Escape — cancel it (same as the
      // dialog's own Cancel button in that phase) rather than closing over a still-running attempt
      // the user would have no further way to see or stop.
      if (clone.phase === "cloning") clone.cancelClone();
      else onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // `clone.cancelClone` is itself stable (`useCallback([api])`) — only `clone.phase` (a
    // primitive) needs to be a real dependency here, never the whole `clone` object (see the
    // mount-only effect above for why).
  }, [onClose, clone.phase, clone.cancelClone]);

  async function handleBrowse() {
    setBrowseError(null);
    try {
      const picked = unwrap(await api.openRepoDialog());
      if (!picked) return; // user cancelled the native dialog — no-op.
      setDestinationTouched(true);
      setDestinationPathError(null);
      setDestination(joinDestinationPath(picked, deriveRepoNameFromUrl(url)));
    } catch (err) {
      setBrowseError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmedUrl = url.trim();
    const trimmedDestination = destination.trim();
    if (!trimmedUrl || !trimmedDestination || clone.isCloning) return;
    // ROADMAP.md "Clone: minor rough edges": a manually-typed relative destination would
    // otherwise resolve against git-core's `clone()`'s own implicit cwd (the Electron main
    // process's cwd) — a location the user has no visibility into. Deliberately checked only
    // here (URL field is untouched: a relative git URL is between the user and their own
    // filesystem/shell conventions, not GitHydra's ambiguity to fix).
    if (!isAbsoluteDestinationPath(trimmedDestination)) {
      setDestinationPathError(
        "Enter an absolute path here, e.g. C:\\Users\\you\\projects\\repo or /home/you/projects/repo — or use Browse… to pick a folder.",
      );
      return;
    }
    setDestinationPathError(null);
    clone.runClone(trimmedUrl, trimmedDestination);
  }

  const canSubmit = url.trim().length > 0 && destination.trim().length > 0 && !clone.isCloning;

  return (
    <div className="gh-clone-dialog__overlay" onMouseDown={(e) => e.target === e.currentTarget && clone.phase !== "cloning" && onClose()}>
      <div ref={dialogRef} className="gh-clone-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId} className="gh-clone-dialog__title">
          Clone a repository
        </h2>

        {clone.phase === "cloning" ? (
          <div className="gh-status-banner-stack">
            <div className="gh-status-banner gh-status-banner--neutral gh-fetch-banner" role="status" aria-live="polite">
              <span className="gh-fetch-banner__label">
                <span aria-busy="true">Cloning…</span>{" "}
                <span className="gh-fetch-banner__elapsed gh-tabular" aria-label={`Elapsed time: ${elapsedSeconds} second${elapsedSeconds === 1 ? "" : "s"}`}>
                  {elapsedSeconds}s
                </span>
                {clone.latestProgress && (
                  <span className="gh-fetch-banner__progress gh-mono">
                    {" — "}
                    {clone.latestProgress.stage ? `${clone.latestProgress.stage}` : "receiving"}
                    {clone.latestProgress.percent != null ? ` ${clone.latestProgress.percent}%` : ""}
                  </span>
                )}
                {/* Same on-brand judgment call `FetchStatusBanner`/`PushStatusBanner` already make
                    for the identical situation (clone reuses the exact same network harness). */}
                {elapsedSeconds >= 5 && (
                  <span className="gh-fetch-banner__hint">A sign-in prompt may be waiting behind GitHydra.</span>
                )}
              </span>
              <button type="button" className="gh-status-banner__action" onClick={clone.cancelClone}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <label className="gh-clone-dialog__label" htmlFor={urlId}>
              Repository URL
            </label>
            <input
              id={urlId}
              type="text"
              className="gh-mono gh-clone-dialog__input"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/owner/repo.git, git@host:owner/repo.git, or a local path"
              autoFocus
              required
            />

            <label className="gh-clone-dialog__label" htmlFor={destinationId}>
              Destination folder
            </label>
            <div className="gh-clone-dialog__destination-row">
              <input
                id={destinationId}
                type="text"
                className="gh-mono gh-clone-dialog__input gh-clone-dialog__destination-input"
                value={destination}
                onChange={(e) => {
                  setDestination(e.target.value);
                  setDestinationTouched(true);
                  setDestinationPathError(null);
                }}
                placeholder="Where the new repository folder will be created"
                required
              />
              <button type="button" className="gh-clone-dialog__browse" onClick={() => void handleBrowse()}>
                Browse…
              </button>
            </div>
            <p className="gh-clone-dialog__hint">
              {destinationTouched
                ? "This exact folder is created for the clone — it must not already contain files."
                : "Pick the parent folder — GitHydra creates a new folder for the repository inside it."}
            </p>
            {browseError && (
              <p className="gh-clone-dialog__error" role="alert">
                {browseError}
              </p>
            )}
            {destinationPathError && (
              <p className="gh-clone-dialog__error" role="alert">
                {destinationPathError}
              </p>
            )}

            {clone.error && (
              <div className="gh-status-banner-stack">
                <div className="gh-status-banner gh-status-banner--critical gh-clone-dialog__failure" role="alert">
                  <div>
                    <span>Could not clone: {clone.error}</span>
                    {clone.rawStderr && (
                      <details className="gh-fetch-banner__details">
                        <summary>Details</summary>
                        <pre className="gh-mono gh-fetch-banner__raw">{clone.rawStderr}</pre>
                      </details>
                    )}
                  </div>
                  <button type="button" className="gh-status-banner__action" onClick={clone.dismiss}>
                    Dismiss
                  </button>
                </div>
              </div>
            )}

            <div className="gh-clone-dialog__actions">
              <button type="button" className="gh-clone-dialog__cancel" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="gh-clone-dialog__submit" disabled={!canSubmit}>
                Clone
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
