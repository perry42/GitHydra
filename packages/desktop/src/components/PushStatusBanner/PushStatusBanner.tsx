// SPDX-License-Identifier: GPL-3.0-or-later
import type { FetchProgressEvent, PushOutcome } from "@githydra/git-core";
import { useElapsedSeconds } from "../../hooks/useElapsedSeconds";
// Reuses `.gh-fetch-banner*` verbatim for the "pushing" phase (see this component's own module doc
// comment) — imported explicitly here rather than relying on `FetchStatusBanner` happening to be
// mounted elsewhere first, the same convention `PullStatusBanner` already established.
import "../FetchStatusBanner/FetchStatusBanner.css";
import "./PushStatusBanner.css";

export interface PushStatusBannerProps {
  phase: "idle" | "pushing" | "done";
  pushSequence: number;
  latestProgress: FetchProgressEvent | null;
  outcome: PushOutcome | null;
  error: string | null;
  /** FR-346: true exactly when `error` came from a non-fast-forward rejection — renders the
   * specific "pull first" copy and points at Pull, never a retry-with-force affordance of any
   * kind. */
  isNonFastForwardRejection: boolean;
  /** FR-348: the classified error's raw (already credential-redacted) stderr, for the collapsible
   * "Details" disclosure — `null` when there's none to show. */
  rawStderr: string | null;
  onCancel: () => void;
  onDismiss: () => void;
}

/**
 * specs/online-sync-push.md FR-346/FR-348: Push's own status surface — reuses `StatusBanner`'s
 * existing `.gh-status-banner`/`.gh-status-banner-stack`/`.gh-status-banner__action` classes and the
 * "pushing" phase's elapsed-time/credential-prompt-hint/Cancel shape verbatim from
 * `FetchStatusBanner`/`PullStatusBanner` (a push's one network call reuses the exact same
 * `runNetworkGitProcess()` harness, so it can hang/prompt for credentials identically) — no parallel
 * implementation, per FR-348.
 *
 * The "done" phase's failure branch is what's genuinely new: FR-346's non-fast-forward rejection
 * gets its own distinct copy naming Pull by name (never a generic error line, and — the hard
 * non-goal — never any retry-with-force affordance, not even a hidden/advanced one) with the raw
 * stderr tucked behind the same collapsible "Details" `<details>` disclosure
 * `FetchStatusBanner`'s own per-remote error entries already use. Every other failure renders the
 * plain classified/verbatim message, same shape as `PullStatusBanner`'s own `error` branch.
 *
 * Renders nothing while `phase === "idle"`.
 */
export function PushStatusBanner({
  phase,
  pushSequence,
  latestProgress,
  outcome,
  error,
  isNonFastForwardRejection,
  rawStderr,
  onCancel,
  onDismiss,
}: PushStatusBannerProps) {
  const elapsedSeconds = useElapsedSeconds(phase === "pushing", pushSequence);

  if (phase === "idle") return null;

  if (phase === "pushing") {
    return (
      <div className="gh-status-banner-stack">
        <div className="gh-status-banner gh-status-banner--neutral gh-fetch-banner" role="status" aria-live="polite">
          <span className="gh-fetch-banner__label">
            <span aria-busy="true">Pushing…</span>{" "}
            <span
              className="gh-fetch-banner__elapsed gh-tabular"
              aria-label={`Elapsed time: ${elapsedSeconds} second${elapsedSeconds === 1 ? "" : "s"}`}
            >
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
            {/* Same on-brand judgment call `FetchStatusBanner`/`PullStatusBanner` already make for
                the identical situation (this network call reuses the exact same harness). */}
            {elapsedSeconds >= 5 && (
              <span className="gh-fetch-banner__hint">A sign-in prompt may be waiting behind GitHydra.</span>
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
  if (error) {
    if (isNonFastForwardRejection) {
      return (
        <div className="gh-status-banner-stack">
          <div className="gh-status-banner gh-status-banner--critical gh-push-banner__failure" role="alert">
            <div>
              <p className="gh-push-banner__message">
                The remote has commits you don&apos;t have — pull first, then push again. GitHydra
                never auto-retries a rejected push with any force option.
              </p>
              {rawStderr && (
                <details className="gh-fetch-banner__details">
                  <summary>Details</summary>
                  <pre className="gh-mono gh-fetch-banner__raw">{rawStderr}</pre>
                </details>
              )}
            </div>
            <button type="button" className="gh-status-banner__action" onClick={onDismiss}>
              Dismiss
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="gh-status-banner-stack">
        <div className="gh-status-banner gh-status-banner--critical gh-push-banner__failure" role="alert">
          <div>
            <span>Could not push: {error}</span>
            {rawStderr && (
              <details className="gh-fetch-banner__details">
                <summary>Details</summary>
                <pre className="gh-mono gh-fetch-banner__raw">{rawStderr}</pre>
              </details>
            )}
          </div>
          <button type="button" className="gh-status-banner__action" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  if (!outcome) return null;

  return (
    <div className="gh-status-banner-stack">
      <div className="gh-status-banner gh-status-banner--neutral" role="status">
        <span>{describePushOutcome(outcome)}</span>
        <button type="button" className="gh-status-banner__action" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

/** FR-344/FR-345: distinct copy per `PushOutcome` kind — a `"set-upstream"` publish is worth
 * calling out explicitly (a brand-new branch now has a real upstream), never folded into the same
 * generic line a plain tracked-branch push gets. */
function describePushOutcome(outcome: PushOutcome): string {
  const target = `${outcome.remoteName}/${outcome.remoteBranch}`;
  return outcome.kind === "set-upstream"
    ? `Published "${outcome.localBranch}" to ${target} and set it as the upstream.`
    : `Pushed "${outcome.localBranch}" to ${target}.`;
}
