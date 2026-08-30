import { useEffect, useMemo, useState } from "react";
import type { FileDiffResult } from "@githydra/git-core";
import type { GitHydraApi } from "../../../shared/ipcContract";
import { useConflictResolution } from "../../hooks/useConflictResolution";
import { useConflictProgress } from "../../hooks/useConflictProgress";
import { acceptActionLabel, classifyConflictRender } from "../../lib/conflictClassification";
import { DiffView } from "../DiffView/DiffView";
import "./ConflictResolutionView.css";

export interface ConflictResolutionViewProps {
  api: GitHydraApi;
  /** The conflicted file being resolved. */
  path: string;
  /** FR-72: returns to the normal Changes-panel diff view. */
  onClose: () => void;
  /** Called after any successful resolve action so the caller can refresh its own conflicted-file
   * list / working-directory status (ChangesPanel's list, the Toolbar badge, the graph's
   * uncommitted-changes pseudo-node). */
  onResolved: () => void;
  /**
   * specs/graph-head-indicator-and-refresh-alerting.md Problem 2 AC4: true while an
   * externally-detected operation-state alert is unacknowledged — disables Accept Ours/Accept
   * Theirs/Mark as resolved (the same gate `StatusBanner` applies to Continue/Abort) so the user
   * can't act on conflict data this window already knows is possibly stale, until they click that
   * banner's Refresh. "Open in external editor" is left enabled — it's a read/inspect action, not
   * a resolve action that commits this window's possibly-stale view of the conflict.
   */
  blockActions?: boolean;
}

type DiffTabKey = "oursToTheirs" | "baseToOurs" | "baseToTheirs";

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * specs/merge-rebase-conflict-resolution.md FR-64/65/72: the file-level conflict resolution view
 * — opened by clicking a Conflicted row in the Changes panel (superseding that row's prior
 * non-interactive "no diff" treatment). Renders FR-63/76-80's per-classification body (text/
 * rename/delete-modify/add-only/binary/submodule) and offers file-level Accept Ours/Accept
 * Theirs/Mark as resolved/Open in external editor — never hunk-level editing (FR-65's explicit
 * v1 scope line).
 */
export function ConflictResolutionView({
  api,
  path,
  onClose,
  onResolved,
  blockActions = false,
}: ConflictResolutionViewProps) {
  const resolution = useConflictResolution({ api, path, onResolved });
  const progress = useConflictProgress(resolution.totalConflicts, resolution.status !== "not-found");

  const [activeTab, setActiveTab] = useState<DiffTabKey | null>(null);
  useEffect(() => {
    setActiveTab(null);
  }, [path]);

  const oursLabel = resolution.sideLabels?.ours.label ?? "Your branch";
  const theirsLabel = resolution.sideLabels?.theirs.label ?? "Incoming";

  const tabs = useMemo(() => {
    const list: { key: DiffTabKey; label: string; result: FileDiffResult }[] = [];
    if (resolution.diff?.oursToTheirs) {
      list.push({ key: "oursToTheirs", label: `${oursLabel} vs ${theirsLabel}`, result: resolution.diff.oursToTheirs });
    }
    if (resolution.diff?.baseToOurs) {
      list.push({ key: "baseToOurs", label: `Base vs ${oursLabel}`, result: resolution.diff.baseToOurs });
    }
    if (resolution.diff?.baseToTheirs) {
      list.push({ key: "baseToTheirs", label: `Base vs ${theirsLabel}`, result: resolution.diff.baseToTheirs });
    }
    return list;
  }, [resolution.diff, oursLabel, theirsLabel]);

  const selectedTab = tabs.find((t) => t.key === activeTab) ?? tabs[0] ?? null;

  if (resolution.status === "loading") {
    return (
      <section className="gh-conflict-view" aria-label={`Resolve conflict in ${path}`}>
        <p className="gh-conflict-view__status" role="status" aria-live="polite" aria-busy="true">
          Loading conflict…
        </p>
      </section>
    );
  }

  if (resolution.status === "error") {
    return (
      <section className="gh-conflict-view" aria-label={`Resolve conflict in ${path}`}>
        <p className="gh-conflict-view__status gh-conflict-view__status--error" role="alert">
          Could not load this conflict: {resolution.loadErrorMessage}
        </p>
      </section>
    );
  }

  if (resolution.status === "not-found") {
    return (
      <section className="gh-conflict-view" aria-label={`Resolve conflict in ${path}`}>
        <p className="gh-conflict-view__status">This file is resolved.</p>
        <button type="button" className="gh-conflict-view__back" onClick={onClose}>
          Back to changes
        </button>
      </section>
    );
  }

  const file = resolution.file;
  if (!file) return null;
  const render = classifyConflictRender(file);

  return (
    <section className="gh-conflict-view" aria-label={`Resolve conflict in ${path}`}>
      <header className="gh-conflict-view__header">
        <h3 className="gh-conflict-view__heading gh-mono">{path}</h3>
        <span className="gh-conflict-view__progress gh-tabular">
          {progress.resolved} of {progress.total} conflict{progress.total === 1 ? "" : "s"} resolved
        </span>
      </header>

      {file.rename && file.rename.length > 0 && (
        <div className="gh-conflict-view__rename" role="note">
          <h4 className="gh-conflict-view__section-heading">Rename conflict</h4>
          <ul className="gh-conflict-view__rename-list">
            {file.rename.map((r) => (
              <li key={`${r.side}:${r.oldPath}`} className="gh-mono">
                {r.side === "ours" ? oursLabel : theirsLabel}: {r.oldPath} → {r.newPath}
              </li>
            ))}
          </ul>
        </div>
      )}

      {render.mode === "submodule" && (
        <div className="gh-conflict-view__submodule">
          <p className="gh-conflict-view__status">
            Submodule conflict — GitHydra resolves the recorded commit pointer only; open this
            submodule's own repository to resolve conflicts inside it.
          </p>
          <dl className="gh-conflict-view__submodule-list">
            <dt>Base</dt>
            <dd className="gh-mono">{file.base ? shortSha(file.base.sha) : "(none)"}</dd>
            <dt>{oursLabel}</dt>
            <dd className="gh-mono">{file.ours ? shortSha(file.ours.sha) : "(deleted)"}</dd>
            <dt>{theirsLabel}</dt>
            <dd className="gh-mono">{file.theirs ? shortSha(file.theirs.sha) : "(deleted)"}</dd>
          </dl>
        </div>
      )}

      {render.mode === "delete-modify" && (
        <p className="gh-conflict-view__status">
          Deleted in {render.deletedSide === "ours" ? oursLabel : theirsLabel}, modified in{" "}
          {render.deletedSide === "ours" ? theirsLabel : oursLabel}.
        </p>
      )}

      {render.mode === "add-only" && (
        <p className="gh-conflict-view__status">
          Only present in {file.ours ? oursLabel : theirsLabel} — no common ancestor and no content
          on the other side.
        </p>
      )}

      {render.mode === "both-added" && (
        <p className="gh-conflict-view__status">
          Added independently on both sides with different content (no common ancestor).
        </p>
      )}

      {(render.mode === "text" || render.mode === "both-added" || render.mode === "binary") && (
        <div className="gh-conflict-view__diff-region">
          {tabs.length > 1 && (
            <div className="gh-conflict-view__tabs" role="tablist" aria-label="Comparison">
              {tabs.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  role="tab"
                  aria-selected={selectedTab?.key === tab.key}
                  className={`gh-conflict-view__tab${selectedTab?.key === tab.key ? " gh-conflict-view__tab--active" : ""}`}
                  onClick={() => setActiveTab(tab.key)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          )}
          <DiffView
            fileLabel={selectedTab?.label ?? path}
            loading={resolution.diffStatus === "loading"}
            errorMessage={resolution.diffStatus === "error" ? resolution.diffErrorMessage : null}
            result={selectedTab?.result ?? null}
            emptyMessage="No content to compare."
          />
        </div>
      )}

      {resolution.actionError && (
        <p className="gh-conflict-view__status gh-conflict-view__status--error" role="alert">
          {resolution.actionError}{" "}
          <button type="button" className="gh-conflict-view__dismiss" onClick={resolution.dismissActionError}>
            Dismiss
          </button>
        </p>
      )}

      {blockActions && (
        <p className="gh-conflict-view__status gh-conflict-view__status--error" role="alert">
          This operation changed outside GitHydra — click Refresh above before resolving conflicts.
        </p>
      )}

      <div className="gh-conflict-view__actions">
        <button
          type="button"
          className="gh-conflict-view__accept"
          onClick={resolution.acceptOurs}
          disabled={resolution.isResolving || blockActions}
        >
          {acceptActionLabel("ours", file.ours !== null, resolution.sideLabels)}
        </button>
        <button
          type="button"
          className="gh-conflict-view__accept"
          onClick={resolution.acceptTheirs}
          disabled={resolution.isResolving || blockActions}
        >
          {acceptActionLabel("theirs", file.theirs !== null, resolution.sideLabels)}
        </button>
        {render.mode !== "submodule" && render.mode !== "binary" && (
          <button
            type="button"
            onClick={resolution.markResolved}
            disabled={resolution.isResolving || resolution.markerScan?.hasMarkers === true || blockActions}
            title={
              blockActions
                ? "This operation changed outside GitHydra — click Refresh above before continuing."
                : resolution.markerScan?.hasMarkers
                  ? `Conflict markers still present (line${resolution.markerScan.markerLines.length === 1 ? "" : "s"} ${resolution.markerScan.markerLines.join(", ")}) — remove them before marking this file resolved.`
                  : undefined
            }
          >
            Mark as resolved
          </button>
        )}
        <button type="button" onClick={resolution.openInExternalEditor}>
          Open in external editor
        </button>
      </div>
      {resolution.externalEditorError && (
        <p className="gh-conflict-view__status gh-conflict-view__status--error" role="alert">
          {resolution.externalEditorError}
        </p>
      )}
    </section>
  );
}
