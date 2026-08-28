import type { LocalBranchInfo, RemoteBranchInfo, RepositoryState } from "@githydra/git-core";
import type { GitHydraApi } from "../../../shared/ipcContract";
import type { UseBranchActionsResult } from "../../hooks/useBranchActions";
import { useBranchList } from "../../hooks/useBranchList";
import { useResizableWidth } from "../../hooks/useResizableWidth";
import { formatAuthor, formatDate, truncate } from "../../lib/format";
import { BRANCHES_PANEL_DEFAULT_WIDTH, BRANCHES_PANEL_MIN_WIDTH, eightyVw } from "../../lib/layoutSizes";
import { ResizeHandle } from "../ResizeHandle/ResizeHandle";
import "./BranchesPanel.css";

export interface BranchesPanelProps {
  api: GitHydraApi;
  repoState: RepositoryState | null;
  /** Shared with the graph's ref-chip context menu (App owns the single instance) so Checkout/
   * Delete behave identically everywhere they appear (FR-55/AC15). */
  actions: UseBranchActionsResult;
  /** Bumped by App after a branch mutation triggered from *outside* this panel (the graph's
   * context menus) so the list here stays correct without a direct hook reference (FR-56). */
  reloadToken?: number;
  onClose: () => void;
  onRequestNewBranch: () => void;
}

function aheadBehindLabel(branch: LocalBranchInfo): string | null {
  if (!branch.upstreamName) return null;
  if (branch.upstreamGone) return `${branch.upstreamName} (gone)`;
  const parts: string[] = [];
  if (branch.ahead) parts.push(`↑${branch.ahead}`);
  if (branch.behind) parts.push(`↓${branch.behind}`);
  return parts.length > 0 ? `${parts.join(" ")} ${branch.upstreamName}` : branch.upstreamName;
}

/**
 * FR-47/48/50: the Branches panel — local + remote-tracking branches (grouped by remote),
 * independent of the graph's ref-filter state, with a name-substring search box. All data-
 * fetching/search logic lives in `useBranchList`; all mutation logic (Checkout/Delete/checkout-
 * remote, plus the delete-escalation state machine) is shared via the `actions` prop so this
 * component and the graph's ref-chip menu can never drift apart (AC15).
 */
export function BranchesPanel({ api, repoState, actions, reloadToken, onClose, onRequestNewBranch }: BranchesPanelProps) {
  const list = useBranchList({ api, reloadToken });
  const hasWorkdir = Boolean(repoState && !repoState.isBare && repoState.workdir);
  const bareReason = "Switching requires a working directory — this is a bare repository.";

  // Must-have C13: same pattern as ChangesPanel/DetailPanel's panel-width handle.
  const panelWidth = useResizableWidth({
    storageKey: "githydra:layout:branchesPanelWidth",
    defaultWidth: BRANCHES_PANEL_DEFAULT_WIDTH,
    min: BRANCHES_PANEL_MIN_WIDTH,
    getMax: eightyVw,
    direction: -1,
  });

  return (
    <aside className="gh-branches-panel" aria-label="Branches" role="complementary" style={{ width: panelWidth.width }}>
      <ResizeHandle label="Resize Branches panel" {...panelWidth.separatorProps} />
      <div className="gh-branches-panel__header">
        <h2 className="gh-branches-panel__title">Branches</h2>
        <button type="button" className="gh-branches-panel__close" onClick={onClose} aria-label="Close branches panel">
          ×
        </button>
      </div>

      <div className="gh-branches-panel__toolbar">
        <input
          type="search"
          className="gh-branches-panel__search"
          placeholder="Search branches…"
          aria-label="Search branches"
          value={list.search}
          onChange={(e) => list.setSearch(e.target.value)}
        />
        <button type="button" className="gh-branches-panel__new" onClick={onRequestNewBranch}>
          + New Branch
        </button>
      </div>

      {actions.error && (
        <p className="gh-branches-panel__status gh-branches-panel__status--error" role="alert">
          {actions.error}{" "}
          <button type="button" className="gh-branches-panel__dismiss" onClick={actions.dismissError}>
            Dismiss
          </button>
        </p>
      )}

      <div className="gh-branches-panel__body">
        {list.status === "loading" && (
          <p className="gh-branches-panel__status" role="status" aria-live="polite" aria-busy="true">
            Loading branches…
          </p>
        )}

        {list.status === "error" && (
          <div>
            <p className="gh-branches-panel__status gh-branches-panel__status--error" role="alert">
              Could not load branches: {list.errorMessage}
            </p>
            <button type="button" className="gh-branches-panel__dismiss" onClick={list.reload}>
              Retry
            </button>
          </div>
        )}

        {list.status === "ready" && (
          <>
            <section className="gh-branches-panel__section">
              <h3 className="gh-branches-panel__section-heading">Local ({list.localBranches.length})</h3>
              {list.localBranches.length === 0 && (
                <p className="gh-branches-panel__empty">No local branches match.</p>
              )}
              <ul className="gh-branches-panel__list">
                {list.localBranches.map((branch) => (
                  <LocalBranchRow
                    key={branch.fullName}
                    branch={branch}
                    hasWorkdir={hasWorkdir}
                    bareReason={bareReason}
                    busy={actions.busyBranch === branch.name}
                    onCheckout={() => void actions.switchTo(branch.name)}
                    onDelete={() => actions.requestDelete(branch.name)}
                  />
                ))}
              </ul>
            </section>

            {[...list.remoteBranchesByRemote.entries()].map(([remoteName, branches]) => (
              <section key={remoteName} className="gh-branches-panel__section">
                <h3 className="gh-branches-panel__section-heading">
                  {remoteName} ({branches.length})
                </h3>
                <ul className="gh-branches-panel__list">
                  {branches.map((branch) => (
                    <RemoteBranchRow
                      key={branch.fullName}
                      branch={branch}
                      hasWorkdir={hasWorkdir}
                      bareReason={bareReason}
                      busy={actions.busyBranch === branch.fullName}
                      onCheckout={() => void actions.checkoutRemote(branch)}
                    />
                  ))}
                </ul>
              </section>
            ))}

            {list.localBranches.length === 0 && list.remoteBranchesByRemote.size === 0 && (
              <p className="gh-branches-panel__empty">No branches match "{list.search}".</p>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

function LocalBranchRow({
  branch,
  hasWorkdir,
  bareReason,
  busy,
  onCheckout,
  onDelete,
}: {
  branch: LocalBranchInfo;
  hasWorkdir: boolean;
  bareReason: string;
  busy: boolean;
  onCheckout: () => void;
  onDelete: () => void;
}) {
  const aheadBehind = aheadBehindLabel(branch);
  const checkedOutElsewhere = branch.checkedOutInWorktree;
  const checkoutDisabled = branch.isCurrent || Boolean(checkedOutElsewhere) || !hasWorkdir || busy;
  const deleteDisabled = branch.isCurrent || Boolean(checkedOutElsewhere) || busy;

  let checkoutTitle: string | undefined;
  if (branch.isCurrent) checkoutTitle = "This is the current branch.";
  else if (checkedOutElsewhere) checkoutTitle = `Checked out in another worktree: ${checkedOutElsewhere}`;
  else if (!hasWorkdir) checkoutTitle = bareReason;

  return (
    <li className="gh-branches-panel__row">
      <div className="gh-branches-panel__row-main">
        <span className="gh-mono gh-branches-panel__name">{branch.name}</span>
        {branch.isCurrent && <span className="gh-branches-panel__badge">Current</span>}
        {checkedOutElsewhere && (
          <span className="gh-branches-panel__badge gh-branches-panel__badge--worktree" title={`Checked out at ${checkedOutElsewhere}`}>
            Checked out elsewhere
          </span>
        )}
      </div>
      {aheadBehind && (
        <span
          className="gh-branches-panel__upstream gh-mono"
          title="Ahead/behind and upstream reflect the last-known state as of the last fetch performed outside GitHydra — not live."
        >
          {aheadBehind}
        </span>
      )}
      <span className="gh-branches-panel__commit">
        {truncate(branch.tipSubject || "(no message)", 72)} — {formatAuthor(branch.tipAuthorName, branch.tipAuthorEmail)},{" "}
        {formatDate(branch.tipAuthorDate)}
      </span>
      <div className="gh-branches-panel__row-actions">
        <button type="button" onClick={onCheckout} disabled={checkoutDisabled} title={checkoutTitle}>
          {busy ? "Working…" : "Checkout"}
        </button>
        <button
          type="button"
          className="gh-branches-panel__delete"
          onClick={onDelete}
          disabled={deleteDisabled}
          title={branch.isCurrent ? "Cannot delete the current branch." : checkedOutElsewhere ? checkoutTitle : undefined}
        >
          Delete
        </button>
      </div>
    </li>
  );
}

function RemoteBranchRow({
  branch,
  hasWorkdir,
  bareReason,
  busy,
  onCheckout,
}: {
  branch: RemoteBranchInfo;
  hasWorkdir: boolean;
  bareReason: string;
  busy: boolean;
  onCheckout: () => void;
}) {
  return (
    <li className="gh-branches-panel__row">
      <div className="gh-branches-panel__row-main">
        <span className="gh-mono gh-branches-panel__name">
          {branch.remoteName}/{branch.name}
        </span>
      </div>
      <span className="gh-branches-panel__commit">
        {truncate(branch.tipSubject || "(no message)", 72)} — {formatAuthor(branch.tipAuthorName, branch.tipAuthorEmail)},{" "}
        {formatDate(branch.tipAuthorDate)}
      </span>
      <div className="gh-branches-panel__row-actions">
        <button type="button" onClick={onCheckout} disabled={!hasWorkdir || busy} title={!hasWorkdir ? bareReason : undefined}>
          {busy ? "Working…" : "Checkout"}
        </button>
      </div>
    </li>
  );
}
