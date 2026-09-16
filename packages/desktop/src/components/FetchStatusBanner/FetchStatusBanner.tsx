// SPDX-License-Identifier: GPL-3.0-or-later
import type { FetchProgressEvent, FetchRemoteOutcome } from "@githydra/git-core";
import { useElapsedSeconds } from "../../hooks/useElapsedSeconds";
import "./FetchStatusBanner.css";

export interface FetchStatusBannerProps {
  phase: "idle" | "fetching" | "done";
  fetchSequence: number;
  latestProgress: FetchProgressEvent | null;
  outcomes: FetchRemoteOutcome[] | null;
  topLevelError: string | null;
  onCancel: () => void;
  onDismiss: () => void;
}

/**
 * specs/online-sync-fetch.md FR-322/FR-323/FR-327: the Fetch action's own status surface —
 * reuses `StatusBanner`'s existing `.gh-status-banner`/`.gh-status-banner-stack`/
 * `.gh-status-banner__action` classes and tokens verbatim (this is structurally one more status
 * banner, not a new visual language) rather than a bespoke dialog, extending
 * `specs/repo-open-feedback.md`'s elapsed-time/cancel pattern to this app's first network
 * operation instead of inventing a second one.
 *
 * Renders nothing while `phase === "idle"`.
 */
export function FetchStatusBanner({
  phase,
  fetchSequence,
  latestProgress,
  outcomes,
  topLevelError,
  onCancel,
  onDismiss,
}: FetchStatusBannerProps) {
  const elapsedSeconds = useElapsedSeconds(phase === "fetching", fetchSequence);

  if (phase === "idle") return null;

  if (phase === "fetching") {
    return (
      <div className="gh-status-banner-stack">
        <div className="gh-status-banner gh-status-banner--neutral gh-fetch-banner" role="status" aria-live="polite">
          <span className="gh-fetch-banner__label">
            <span aria-busy="true">Fetching remotes…</span>{" "}
            <span className="gh-fetch-banner__elapsed gh-tabular" aria-label={`Elapsed time: ${elapsedSeconds} second${elapsedSeconds === 1 ? "" : "s"}`}>
              {elapsedSeconds}s
            </span>
            {latestProgress && (
              <span className="gh-fetch-banner__progress gh-mono">
                {" — "}
                {latestProgress.remoteName}
                {latestProgress.stage ? `: ${latestProgress.stage}` : ""}
                {latestProgress.percent != null ? ` ${latestProgress.percent}%` : ""}
              </span>
            )}
            {/*
              specs/online-sync-fetch.md, "Three things that will bite you" #2: a fetch against a
              private remote can legitimately pause on the OS's own credential-prompt GUI (e.g. Git
              Credential Manager) — this is not a hang. Shown only once the wait is long enough that
              a user might otherwise start to worry (an ordinary local/fast fetch never reaches this),
              an on-brand judgment call (assumption flagged in this feature's own report) rather than
              a spec-mandated threshold.
            */}
            {elapsedSeconds >= 5 && (
              <span className="gh-fetch-banner__hint">
                {" "}
                — this can pause on a credential prompt from your system (e.g. Git Credential Manager)
                if a remote needs authentication. Check for a popup if it seems stuck.
              </span>
            )}
          </span>
          <button type="button" className="gh-status-banner__action" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // phase === "done"
  if (topLevelError) {
    return (
      <div className="gh-status-banner-stack">
        <div className="gh-status-banner gh-status-banner--critical" role="alert">
          <span>Could not fetch: {topLevelError}</span>
          <button type="button" className="gh-status-banner__action" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  const list = outcomes ?? [];
  if (list.length === 0) {
    return (
      <div className="gh-status-banner-stack">
        <div className="gh-status-banner gh-status-banner--neutral" role="status">
          <span>No remotes configured — nothing to fetch.</span>
          <button type="button" className="gh-status-banner__action" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="gh-status-banner-stack">
      <div className="gh-status-banner gh-status-banner--neutral gh-fetch-banner gh-fetch-banner--result" role="status">
        <ul className="gh-fetch-banner__outcomes">
          {list.map((outcome) => (
            <li key={outcome.remoteName} className="gh-fetch-banner__outcome">
              {outcome.status === "ok" ? (
                <span className="gh-fetch-banner__outcome-ok">
                  <span className="gh-mono">{outcome.remoteName}</span>: fetched successfully
                </span>
              ) : (
                <div className="gh-fetch-banner__outcome-error">
                  <span>
                    <span className="gh-mono">{outcome.remoteName}</span>: {outcome.error.message}
                  </span>
                  {/* FR-323: the friendly message is always shown; the raw stderr is available but
                      never dumped inline — a native <details> disclosure, this system's one
                      collapsible-copy pattern (see DESIGN.md's landing-page install-caveat entry,
                      the same element/idiom applied here to the in-app surface). */}
                  <details className="gh-fetch-banner__details">
                    <summary>Details</summary>
                    <pre className="gh-mono gh-fetch-banner__raw">{outcome.error.rawStderr || "(no further output)"}</pre>
                  </details>
                </div>
              )}
            </li>
          ))}
        </ul>
        <button type="button" className="gh-status-banner__action" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
