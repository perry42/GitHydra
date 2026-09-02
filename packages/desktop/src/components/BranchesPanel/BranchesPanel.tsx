import type { KeyboardEvent } from "react";
import type { LocalBranchInfo, RemoteBranchInfo, RepositoryState } from "@githydra/git-core";
import type { GitHydraApi } from "../../../shared/ipcContract";
import type { UseBranchActionsResult } from "../../hooks/useBranchActions";
import { useBranchList } from "../../hooks/useBranchList";
import { useResizableWidth } from "../../hooks/useResizableWidth";
import { formatAuthor, formatDate, formatRelativeDate, truncate } from "../../lib/format";
import { BRANCHES_PANEL_DEFAULT_WIDTH, BRANCHES_PANEL_MIN_WIDTH, eightyVw } from "../../lib/layoutSizes";
import { IconCheckout, IconDelete, IconNewBranch } from "../Icon/Icon";
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
  onRequestNewBranch: () => void;
  /**
   * design-pass "Branches panel relocation": true when the sidebar is collapsed to its slim
   * rail. Owned by App (persisted, see `useLayoutPreferences.ts`'s sidebar-collapsed helpers) —
   * this component only renders whichever state it's told.
   */
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /**
   * design-pass "Branches panel relocation": scrolls/selects a branch's tip commit in the commit
   * graph — the exact same jump mechanism `App.tsx`'s `jumpToSha` already uses for
   * specs/blame.md FR-134's "jump to commit" action (apply the graph's existing sha filter only
   * if the target isn't already reachable in the loaded page, then select it; `CommitGraph`'s own
   * follow effect does the actual scroll/auto-page-load). Never a second, bespoke scroll
   * mechanism — reused verbatim so this panel's performance characteristics are identical to an
   * already-shipped, already-tested code path.
   */
  onLocateBranch: (sha: string) => void;
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
 *
 * design-pass "Branches panel relocation": this is now rendered as a persistent left sidebar
 * (`App.tsx`, unconditionally while a repo is open — not one of the mutually-exclusive right-hand
 * rails `rightPanel` tracks), collapsible to a slim rail rather than closeable, with a search that
 * also jumps the graph to a matched branch's tip commit (`onLocateBranch`, FR-50 extended). Future
 * left-sidebar content (V1.1's repo list, per ROADMAP.md's sequencing note) is expected to become
 * a sibling `<aside>`/section alongside this one rather than requiring this component to be torn
 * down and rebuilt — deliberately not generalized into a multi-section container ahead of that
 * actually being built, to avoid speculative abstraction for a single current section.
 */
export function BranchesPanel({
  api,
  repoState,
  actions,
  reloadToken,
  onRequestNewBranch,
  collapsed,
  onToggleCollapsed,
  onLocateBranch,
}: BranchesPanelProps) {
  const list = useBranchList({ api, reloadToken });
  const hasWorkdir = Boolean(repoState && !repoState.isBare && repoState.workdir);
  const bareReason = "Switching requires a working directory — this is a bare repository.";

  // Must-have C13: same pattern as ChangesPanel/DetailPanel's panel-width handle. `direction: 1`
  // (not the right-hand panels' `-1`) since this sidebar sits on the *left* now — its resize
  // handle is on its own right edge, so dragging the pointer right grows it, same convention the
  // file-list/diff dividers already use for a left-hand column.
  const panelWidth = useResizableWidth({
    storageKey: "githydra:layout:branchesPanelWidth",
    defaultWidth: BRANCHES_PANEL_DEFAULT_WIDTH,
    min: BRANCHES_PANEL_MIN_WIDTH,
    getMax: eightyVw,
    direction: 1,
  });

  // specs/branch-management.md FR-50, extended: Enter in the search box jumps the graph straight
  // to the top match's tip commit (local branches take priority over remote-tracking ones, since
  // FR-47's own list ordering already puts Local first) — the fastest path from "search" to
  // "look at it in the graph" without an extra click, on top of the row-level jump every match
  // already offers below.
  const handleSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    const top = list.localBranches[0] ?? list.remoteBranches[0];
    if (top) onLocateBranch(top.tipSha);
  };

  if (collapsed) {
    return (
      <aside className="gh-branches-panel gh-branches-panel--collapsed" aria-label="Branches sidebar (collapsed)" role="complementary">
        <button
          type="button"
          className="gh-branches-panel__expand"
          onClick={onToggleCollapsed}
          aria-label="Expand branches sidebar"
          title="Expand branches sidebar"
        >
          <span aria-hidden="true">»</span>
        </button>
        <span className="gh-branches-panel__rail-label" aria-hidden="true">
          Branches
        </span>
      </aside>
    );
  }

  return (
    <aside className="gh-branches-panel" aria-label="Branches" role="complementary" style={{ width: panelWidth.width }}>
      <div className="gh-branches-panel__header">
        <h2 className="gh-branches-panel__title">Branches</h2>
        <button
          type="button"
          className="gh-branches-panel__collapse"
          onClick={onToggleCollapsed}
          aria-label="Collapse branches sidebar"
          title="Collapse branches sidebar"
        >
          «
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
          onKeyDown={handleSearchKeyDown}
        />
        <button type="button" className="gh-branches-panel__new" onClick={onRequestNewBranch}>
          <IconNewBranch />
          New Branch
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
                    onLocate={() => onLocateBranch(branch.tipSha)}
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
                      onLocate={() => onLocateBranch(branch.tipSha)}
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
      <ResizeHandle label="Resize Branches sidebar" {...panelWidth.separatorProps} />
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
  onLocate,
}: {
  branch: LocalBranchInfo;
  hasWorkdir: boolean;
  bareReason: string;
  busy: boolean;
  onCheckout: () => void;
  onDelete: () => void;
  onLocate: () => void;
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
        <button
          type="button"
          className="gh-mono gh-branches-panel__name"
          onClick={onLocate}
          title="Jump to this branch's tip commit in the graph"
          aria-label={`Jump to ${branch.name} in the commit graph`}
        >
          {branch.name}
        </button>
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
          title={`${aheadBehind} — reflects the last-known state as of the last fetch performed outside GitHydra, not live.`}
        >
          {aheadBehind}
        </span>
      )}
      <span className="gh-branches-panel__commit">
        {truncate(branch.tipSubject || "(no message)", 72)} — {formatAuthor(branch.tipAuthorName, branch.tipAuthorEmail)}
      </span>
      <div className="gh-branches-panel__row-actions">
        <button type="button" onClick={onCheckout} disabled={checkoutDisabled} title={checkoutTitle}>
          <IconCheckout />
          {busy ? "Working…" : "Checkout"}
        </button>
        <button
          type="button"
          className="gh-branches-panel__delete"
          onClick={onDelete}
          disabled={deleteDisabled}
          title={branch.isCurrent ? "Cannot delete the current branch." : checkedOutElsewhere ? checkoutTitle : undefined}
        >
          <IconDelete />
          Delete
        </button>
      </div>
      <span className="gh-branches-panel__relative-time gh-mono" title={formatDate(branch.tipAuthorDate)}>
        {formatRelativeDate(branch.tipAuthorDate)}
      </span>
    </li>
  );
}

function RemoteBranchRow({
  branch,
  hasWorkdir,
  bareReason,
  busy,
  onCheckout,
  onLocate,
}: {
  branch: RemoteBranchInfo;
  hasWorkdir: boolean;
  bareReason: string;
  busy: boolean;
  onCheckout: () => void;
  onLocate: () => void;
}) {
  return (
    <li className="gh-branches-panel__row">
      <div className="gh-branches-panel__row-main">
        <button
          type="button"
          className="gh-mono gh-branches-panel__name"
          onClick={onLocate}
          title="Jump to this branch's tip commit in the graph"
          aria-label={`Jump to ${branch.remoteName}/${branch.name} in the commit graph`}
        >
          {branch.remoteName}/{branch.name}
        </button>
      </div>
      <span className="gh-branches-panel__commit">
        {truncate(branch.tipSubject || "(no message)", 72)} — {formatAuthor(branch.tipAuthorName, branch.tipAuthorEmail)}
      </span>
      <div className="gh-branches-panel__row-actions">
        <button type="button" onClick={onCheckout} disabled={!hasWorkdir || busy} title={!hasWorkdir ? bareReason : undefined}>
          <IconCheckout />
          {busy ? "Working…" : "Checkout"}
        </button>
      </div>
      <span className="gh-branches-panel__relative-time gh-mono" title={formatDate(branch.tipAuthorDate)}>
        {formatRelativeDate(branch.tipAuthorDate)}
      </span>
    </li>
  );
}
