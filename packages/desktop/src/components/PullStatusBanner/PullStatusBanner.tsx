// SPDX-License-Identifier: GPL-3.0-or-later
import type { FetchProgressEvent, PullOutcome } from "@githydra/git-core";
import { useElapsedSeconds } from "../../hooks/useElapsedSeconds";
// Reuses `.gh-fetch-banner*` verbatim for the "pulling" phase (see this component's own module doc
// comment) — imported explicitly here rather than relying on `FetchStatusBanner` happening to be
// mounted elsewhere first.
import "../FetchStatusBanner/FetchStatusBanner.css";
import "./PullStatusBanner.css";

export interface PullStatusBannerProps {
  phase: "idle" | "pulling" | "done";
  pullSequence: number;
  latestProgress: FetchProgressEvent | null;
  outcome: PullOutcome | null;
  error: string | null;
  onCancel: () => void;
  onDismiss: () => void;
}

/**
 * specs/online-sync-pull.md FR-338/FR-339: Pull's own status surface — reuses `StatusBanner`'s
 * existing `.gh-status-banner`/`.gh-status-banner-stack`/`.gh-status-banner__action` classes
 * verbatim, the same way `FetchStatusBanner` already does (structurally one more status banner,
 * not a new visual language), and the "pulling" phase's elapsed-time/credential-prompt-hint/Cancel
 * shape is a deliberate, near-literal reuse of `FetchStatusBanner`'s own — a pull's one network
 * call IS a `fetchRemote()` call, so it can hang/prompt for credentials exactly the same way, and a
 * user who already knows what that banner means shouldn't have to learn a second one.
 *
 * The "done" phase is what's actually new here: distinguishes all three `PullOutcome` kinds
 * (FR-338's success-feedback requirement) with copy that reads differently for "nothing to do" vs.
 * "moved forward with no new commit" vs. "created a real merge/rebase result" — never a single
 * generic "Pull complete" line. A paused merge/rebase conflict is deliberately NOT a state this
 * banner ever renders (see `usePullAction`'s own doc comment) — `StatusBanner`'s existing
 * operation banner and `ChangesPanel`'s `ConflictResolutionView` take over instead, unchanged.
 *
 * Renders nothing while `phase === "idle"`.
 */
export function PullStatusBanner({
  phase,
  pullSequence,
  latestProgress,
  outcome,
  error,
  onCancel,
  onDismiss,
}: PullStatusBannerProps) {
  const elapsedSeconds = useElapsedSeconds(phase === "pulling", pullSequence);

  if (phase === "idle") return null;

  if (phase === "pulling") {
    return (
      <div className="gh-status-banner-stack">
        <div className="gh-status-banner gh-status-banner--neutral gh-fetch-banner" role="status" aria-live="polite">
          <span className="gh-fetch-banner__label">
            <span aria-busy="true">Pulling…</span>{" "}
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
            {/* Same on-brand judgment call `FetchStatusBanner` already makes for the identical
                situation (this network call IS a `fetchRemote()` call) — see that component's own
                doc comment. */}
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
    return (
      <div className="gh-status-banner-stack">
        <div className="gh-status-banner gh-status-banner--critical" role="alert">
          <span>Could not pull: {error}</span>
          <button type="button" className="gh-status-banner__action" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  if (!outcome) return null; // e.g. the attempt paused on a conflict instead — nothing to show here.

  return (
    <div className="gh-status-banner-stack">
      <div className="gh-status-banner gh-status-banner--neutral" role="status">
        <span>{describePullOutcome(outcome)}</span>
        <button type="button" className="gh-status-banner__action" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

/** FR-338: distinct copy per `PullOutcome` kind — never a single generic "Pull complete" line. */
function describePullOutcome(outcome: PullOutcome): string {
  switch (outcome.kind) {
    case "up-to-date":
      return "Already up to date — nothing to pull.";
    case "fast-forward":
      return `Fast-forwarded to ${outcome.toSha.slice(0, 7)} — no merge was needed.`;
    case "integrated":
      return outcome.strategy === "rebase"
        ? "Pulled — your branch was rebased onto the incoming changes."
        : "Pulled — a new merge commit was created.";
    default:
      return "Pull complete.";
  }
}
