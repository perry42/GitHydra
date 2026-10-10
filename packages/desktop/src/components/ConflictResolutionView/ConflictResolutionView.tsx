// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FileDiffResult } from "@githydra/git-core";
import type { GitHydraApi } from "../../../shared/ipcContract";
import { useConflictResolution } from "../../hooks/useConflictResolution";
import { useConflictProgress } from "../../hooks/useConflictProgress";
import { classifyConflictRender, whyNoBlockEditor } from "../../lib/conflictClassification";
import { sideNamesFromLabels, takeSideLabel } from "../../lib/conflictModel";
import { ConfirmDialog } from "../ConfirmDialog/ConfirmDialog";
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
   * specs/self-write-refresh-suppression.md FR-6b: forwarded straight through to
   * `useConflictResolution` — see its own doc comment. Optional only so existing/other test
   * harnesses rendering this view standalone don't need to pass a no-op.
   */
  onMutationStart?: () => void;
  /** specs/self-write-refresh-suppression.md FR-6b: forwarded straight through to
   * `useConflictResolution` — see its own doc comment. */
  onMutationSettled?: () => void;
  /**
   * specs/graph-head-indicator-and-refresh-alerting.md Problem 2 AC4: true while an
   * externally-detected operation-state alert is unacknowledged — disables Accept Ours/Accept
   * Theirs/Mark as resolved (the same gate `StatusBanner` applies to Continue/Abort) so the user
   * can't act on conflict data this window already knows is possibly stale, until they click that
   * banner's Refresh. "Open in external editor" is left enabled — it's a read/inspect action, not
   * a resolve action that commits this window's possibly-stale view of the conflict.
   */
  blockActions?: boolean;
  /**
   * specs/edit-in-diff.md FR-556: opens the conflict block editor on this file. Offered only for a text conflict
   * (both modified / both added); the editor re-checks eligibility itself and explains why when it cannot open.
   */
  onResolveInEditor?: () => void;
  /** A modal inside the view is open; the global keybinding layer stands down (FR-221). */
  onDialogOpenChange?: (open: boolean) => void;
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
  onMutationStart,
  onMutationSettled,
  blockActions = false,
  onResolveInEditor,
  onDialogOpenChange,
}: ConflictResolutionViewProps) {
  const resolution = useConflictResolution({ api, path, onResolved, onMutationStart, onMutationSettled });
  const progress = useConflictProgress(resolution.totalConflicts, resolution.status !== "not-found");

  const [activeTab, setActiveTab] = useState<DiffTabKey | null>(null);
  useEffect(() => {
    setActiveTab(null);
  }, [path]);

  // specs/edit-in-diff.md FR-556: `undefined` = still asking; `null` = the block editor can open this file; else why it cannot.
  const [editorProbe, setEditorProbe] = useState<{ eligible: boolean; message: string | null } | undefined>(undefined);
  useEffect(() => {
    let stale = false;
    setEditorProbe(undefined);
    void (async () => {
      let value: { eligible: boolean; message: string | null };
      try {
        const r = await api.probeEditableFile(path);
        value = !r.ok ? { eligible: false, message: r.message } : r.data.eligible ? { eligible: true, message: null } : { eligible: false, message: r.data.message };
      } catch (e) {
        value = { eligible: false, message: e instanceof Error ? e.message : null };
      }
      if (!stale) setEditorProbe(value);
    })();
    return () => {
      stale = true;
    };
  }, [api, path, resolution.status]);

  // FR-566: Take <side> asks only when the working file differs from what git left (unknown counts as different).
  const [pendingTake, setPendingTake] = useState<"ours" | "theirs" | null>(null);
  useEffect(() => {
    onDialogOpenChange?.(pendingTake !== null);
  }, [pendingTake, onDialogOpenChange]);
  const requestTake = useCallback(
    (side: "ours" | "theirs") => {
      void (async () => {
        let untouched = false;
        try {
          const r = await api.isConflictFileUntouched(path);
          untouched = r.ok && r.data === true;
        } catch {
          untouched = false;
        }
        if (untouched) (side === "ours" ? resolution.acceptOurs : resolution.acceptTheirs)(true);
        else setPendingTake(side);
      })();
    },
    [api, path, resolution.acceptOurs, resolution.acceptTheirs],
  );
  const names = useMemo(() => sideNamesFromLabels(resolution.sideLabels), [resolution.sideLabels]);

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
          {progress.resolved} of {progress.total} file{progress.total === 1 ? "" : "s"} resolved
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

      {editorProbe && !editorProbe.eligible && (
        <p className="gh-conflict-view__status" role="note" data-testid="no-editor-reason">
          The block editor is not offered for this file. {whyNoBlockEditor(file, editorProbe.message)}
        </p>
      )}

      <div className="gh-conflict-view__actions">
        {onResolveInEditor && editorProbe?.eligible && (
          <button type="button" className="gh-conflict-view__accept gh-conflict-view__editor" onClick={onResolveInEditor} disabled={resolution.isResolving || blockActions}>
            Resolve in editor
          </button>
        )}
        {editorProbe && !editorProbe.eligible && (
          <>
            <button type="button" className="gh-conflict-view__accept" onClick={() => requestTake("ours")} disabled={resolution.isResolving || blockActions}>
              {takeSideLabel(names, "ours", file.ours !== null)}
            </button>
            <button type="button" className="gh-conflict-view__accept" onClick={() => requestTake("theirs")} disabled={resolution.isResolving || blockActions}>
              {takeSideLabel(names, "theirs", file.theirs !== null)}
            </button>
          </>
        )}
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
      {pendingTake && (
        <ConfirmDialog
          title="Replace the working file?"
          message={`The working file differs from what git left, so it was edited here or by another program. ${takeSideLabel(names, pendingTake, (pendingTake === "ours" ? file.ours : file.theirs) !== null)} replaces it with that side and stages the result. This cannot be undone.`}
          confirmLabel="Take it"
          destructive
          initialFocus="cancel"
          onConfirm={() => {
            const side = pendingTake;
            setPendingTake(null);
            (side === "ours" ? resolution.acceptOurs : resolution.acceptTheirs)(true);
          }}
          onCancel={() => setPendingTake(null)}
        />
      )}
      {resolution.externalEditorError && (
        <p className="gh-conflict-view__status gh-conflict-view__status--error" role="alert">
          {resolution.externalEditorError}
        </p>
      )}
    </section>
  );
}
