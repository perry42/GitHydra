// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from "react";
import type { LocalBranchInfo, RemoteBranchInfo, RepositoryState, WorktreeEntry } from "@githydra/git-core";
import type { GitHydraApi } from "../../../shared/ipcContract";
import type { UseBranchActionsResult } from "../../hooks/useBranchActions";
import { useBranchDrag, type BranchDragSession } from "../../hooks/useBranchDragSession";
import { useBranchList } from "../../hooks/useBranchList";
import { useResizableWidth } from "../../hooks/useResizableWidth";
import { formatAuthor, formatDate, formatLastFetchedLabel, formatRelativeDate, truncate } from "../../lib/format";
import { BRANCHES_PANEL_DEFAULT_WIDTH, BRANCHES_PANEL_MIN_WIDTH, eightyVw } from "../../lib/layoutSizes";
import { branchWorktreeMenuAction, visibleText } from "../../lib/worktrees";
import type { UseWorktreesResult } from "../../hooks/useWorktrees";
import type { WorktreeNotice } from "../../lib/worktreeNotices";
import { ContextMenu, type ContextMenuItem } from "../ContextMenu/ContextMenu";
import { IconCheckout, IconDelete, IconNewBranch, IconWorktree, IconWorktreeMain } from "../Icon/Icon";
import { ResizeHandle } from "../ResizeHandle/ResizeHandle";
import { WorktreeNotices } from "../WorktreeNotices/WorktreeNotices";
import { WorktreesSection } from "../WorktreesSection/WorktreesSection";
import "./BranchesPanel.css";

/** specs/worktrees.md FR-607/FR-613: the Worktrees section, its notices and the branch-card worktree actions. Omitted: no worktree UI. */
export interface BranchesPanelWorktrees {
  state: UseWorktreesResult;
  isOpenAsTab: (entry: WorktreeEntry) => boolean;
  notices: readonly WorktreeNotice[];
  onDismissNotice: (id: number) => void;
  onOpenBranches: () => void;
  /** specs/external-programs.md FR-622: "Manage programs" on a failed launch banner. */
  onManagePrograms?: () => void;
  onOpen: (entry: WorktreeEntry) => void;
  /**
   * specs/external-programs.md FR-617: builds the "Open worktree" accordion item. `wrap` marks an item as chosen so the focus is not
   * pulled back to the card. Omitted (standalone tests): the plain item that opens the GitHydra tab.
   */
  openItem?: (entry: WorktreeEntry, opts: { contextLine?: string; wrap: (fn: () => void) => () => void }) => ContextMenuItem;
  onRemove: (entry: WorktreeEntry, deleteBranch: boolean) => void;
  onCleanUp: (entry: WorktreeEntry) => void;
  /** The section's "+" and the palette entry: a new branch in a new worktree, starting at HEAD. */
  onCreateNew: () => void;
  onCreateForBranch: (branch: string) => void;
  onCreateForRemote: (remote: string, branch: string) => void;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onMenuOpenChange: (open: boolean) => void;
}

export interface BranchesPanelProps {
  worktrees?: BranchesPanelWorktrees;
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
  /**
   * specs/find-commits-overlay.md FR-267: bumped by `App.tsx` on `Ctrl/Cmd+F` — moves DOM focus
   * into (and selects any existing text in) the search box below, expanding the sidebar first if
   * it was collapsed. Same bump-a-counter-prop convention this component already uses for
   * `reloadToken` above, rather than a new mechanism.
   */
  focusSearchToken?: number;
  /**
   * specs/online-sync-fetch.md FR-326: when the active repo's remotes were last fetched from
   * inside GitHydra this session, or `null` if never — rendered on every row (FR-326's own text),
   * superseding FR-57's permanently-static "last-known" caveat now that a real fetch can actually
   * refresh this data. One repo-level timestamp (not per-branch/per-remote): `fetchAllRemotes()`
   * always fetches every configured remote in one attempt, so every row shares the same answer to
   * "when was this last refreshed."
   */
  lastFetchedAt: Date | null;
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
  worktrees,
  api,
  repoState,
  actions,
  reloadToken,
  onRequestNewBranch,
  collapsed,
  onToggleCollapsed,
  onLocateBranch,
  focusSearchToken,
  lastFetchedAt,
}: BranchesPanelProps) {
  const list = useBranchList({ api, reloadToken });
  // specs/branch-panel-drag-merge.md FR-418: the shared branch-drag session (null outside `App`,
  // e.g. standalone tests — cards then simply don't drag). Only local cards use it (FR-421).
  const branchDrag = useBranchDrag();
  const lastFetchedLabel = formatLastFetchedLabel(lastFetchedAt);
  // FR-607: one menu for local and remote cards; its single worktree item comes from the worktree list.
  const [cardMenu, setCardMenu] = useState<{ x: number; y: number; items: ContextMenuItem[]; label: string; returnTo: HTMLElement | null } | null>(null);
  const onWorktreeMenuChange = worktrees?.onMenuOpenChange;
  useEffect(() => {
    onWorktreeMenuChange?.(cardMenu !== null);
  }, [cardMenu, onWorktreeMenuChange]);
  // Once an item is chosen its action (a dialog, a switch) owns the focus; only Esc / outside click returns it to the card.
  const cardMenuChosen = useRef(false);
  const closeCardMenu = () => {
    const back = cardMenu?.returnTo;
    const skip = cardMenuChosen.current;
    cardMenuChosen.current = false;
    setCardMenu(null);
    if (!skip && back && back.isConnected) queueMicrotask(() => back.focus());
  };
  const chooseCard = (fn: () => void) => () => {
    cardMenuChosen.current = true;
    fn();
  };
  const worktreeUnavailable = worktrees?.state.list?.untrustedReason === "network-path";
  const hasWorkdir = Boolean(repoState && !repoState.isBare && repoState.workdir);
  const bareReason = "Switching requires a working directory — this is a bare repository.";

  // specs/find-commits-overlay.md FR-267: focuses (and selects any existing text in) the search
  // box whenever `focusSearchToken` genuinely changes — never on mount with its initial value, the
  // same "only react to a real bump, not the first render" guard `reloadToken`-style props don't
  // need (they refetch idempotently) but a focus side effect does. By the time this effect runs,
  // `collapsed` has already landed (App bumps this token in the same state-update batch as
  // un-collapsing the sidebar, see App.tsx), so the search input is already in the DOM even if the
  // sidebar was collapsed the instant this fired.
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const lastFocusTokenRef = useRef(focusSearchToken);
  useEffect(() => {
    if (focusSearchToken === undefined) return;
    if (focusSearchToken === lastFocusTokenRef.current) return;
    lastFocusTokenRef.current = focusSearchToken;
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  }, [focusSearchToken]);

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

  // FR-607 / AC12: exactly ONE worktree item per branch menu; none at all when worktree info is unavailable (FR-601).
  const worktreeMenuItems = (branchName: string, unavailable: boolean, remote?: string): ContextMenuItem[] => {
    if (!worktrees) return [];
    const action = branchWorktreeMenuAction(branchName, worktrees.state.index, !unavailable && !worktreeUnavailable);
    if (!action) return [];
    if (action.kind === "open") {
      if (worktrees.openItem) return [worktrees.openItem(action.entry, { contextLine: action.description, wrap: chooseCard })];
      return [{ label: action.label, description: action.description, onSelect: chooseCard(() => worktrees.onOpen(action.entry)) }];
    }
    return [
      {
        label: action.label,
        onSelect: chooseCard(() => (remote ? worktrees.onCreateForRemote(remote, branchName) : worktrees.onCreateForBranch(branchName))),
      },
    ];
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
          ref={searchInputRef}
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

      {worktrees && (
        <WorktreeNotices
          notices={worktrees.notices}
          onDismiss={worktrees.onDismissNotice}
          onOpenBranches={worktrees.onOpenBranches}
          onManagePrograms={worktrees.onManagePrograms}
        />
      )}

      <div className="gh-branches-panel__body">
        {worktrees && (
          <WorktreesSection
            status={worktrees.state.status}
            list={worktrees.state.list}
            errorMessage={worktrees.state.errorMessage}
            unavailable={worktreeUnavailable || list.localBranches.some((b) => b.worktreeInfoUnavailable)}
            isOpenAsTab={worktrees.isOpenAsTab}
            onOpen={worktrees.onOpen}
            openItem={worktrees.openItem}
            onRemove={worktrees.onRemove}
            onCleanUp={worktrees.onCleanUp}
            onCreate={worktrees.onCreateNew}
            headingRef={worktrees.headingRef}
            onMenuOpenChange={worktrees.onMenuOpenChange}
          />
        )}
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
              <h3 id="gh-branches-local-heading" tabIndex={-1} className="gh-branches-panel__section-heading">
                Local ({list.localBranches.length})
              </h3>
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
                    lastFetchedLabel={lastFetchedLabel}
                    branchDrag={branchDrag}
                    worktreeEntry={worktrees?.state.index.byBranch.get(branch.name) ?? null}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      const items: ContextMenuItem[] = [
                        {
                          label: "Checkout",
                          disabled: branch.isCurrent || Boolean(branch.checkedOutInWorktree) || !hasWorkdir,
                          title: branch.isCurrent
                            ? "This is the current branch."
                            : branch.checkedOutInWorktree
                              ? `Checked out in another worktree: ${visibleText(branch.checkedOutInWorktree)}`
                              : !hasWorkdir
                                ? bareReason
                                : undefined,
                          onSelect: chooseCard(() => void actions.switchTo(branch.name)),
                        },
                        {
                          label: "Delete…",
                          disabled: branch.isCurrent || Boolean(branch.checkedOutInWorktree),
                          title: branch.isCurrent ? "Cannot delete the current branch." : undefined,
                          onSelect: chooseCard(() => actions.requestDelete(branch.name)),
                        },
                        ...worktreeMenuItems(branch.name, Boolean(branch.worktreeInfoUnavailable)),
                      ];
                      setCardMenu({ ...menuPoint(e), items, label: `Actions for branch ${branch.name}`, returnTo: e.currentTarget.querySelector("button") });
                    }}
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
                      lastFetchedLabel={lastFetchedLabel}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        const items: ContextMenuItem[] = [
                          { label: "Checkout", disabled: !hasWorkdir, title: !hasWorkdir ? bareReason : undefined, onSelect: chooseCard(() => void actions.checkoutRemote(branch)) },
                          ...worktreeMenuItems(branch.name, list.localBranches.some((b) => b.worktreeInfoUnavailable), branch.remoteName),
                        ];
                        setCardMenu({ ...menuPoint(e), items, label: `Actions for branch ${branch.remoteName}/${branch.name}`, returnTo: e.currentTarget.querySelector("button") });
                      }}
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
      {cardMenu && <ContextMenu x={cardMenu.x} y={cardMenu.y} ariaLabel={cardMenu.label} items={cardMenu.items} onClose={closeCardMenu} />}
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
  lastFetchedLabel,
  branchDrag,
  worktreeEntry,
  onContextMenu,
}: {
  branch: LocalBranchInfo;
  /** FR-613: the worktree this branch is checked out in (for the glyph), when the worktree list knows it. */
  worktreeEntry: WorktreeEntry | null;
  onContextMenu: (e: MouseEvent<HTMLLIElement>) => void;
  /** FR-418: the shared drag session; `null` renders a plain, non-draggable card. */
  branchDrag: BranchDragSession | null;
  hasWorkdir: boolean;
  bareReason: string;
  busy: boolean;
  onCheckout: () => void;
  onDelete: () => void;
  onLocate: () => void;
  /** specs/online-sync-fetch.md FR-326 */
  lastFetchedLabel: string;
}) {
  const aheadBehind = aheadBehindLabel(branch);
  const checkedOutElsewhere = branch.checkedOutInWorktree;
  const checkoutDisabled = branch.isCurrent || Boolean(checkedOutElsewhere) || !hasWorkdir || busy;
  const deleteDisabled = branch.isCurrent || Boolean(checkedOutElsewhere) || busy;

  let checkoutTitle: string | undefined;
  if (branch.isCurrent) checkoutTitle = "This is the current branch.";
  else if (checkedOutElsewhere) checkoutTitle = `Checked out in another worktree: ${visibleText(checkedOutElsewhere)}`;
  else if (!hasWorkdir) checkoutTitle = bareReason;

  // FR-420/423/439: every local card is a drag source AND a drop target (whole-card highlight);
  // the same `data-ref-branch`/`data-ref-sha` attributes graph chips carry make it one identity.
  const drag = branchDrag?.drag ?? null;
  const dragClass = !drag
    ? ""
    : drag.sourceBranch === branch.name
      ? drag.hoverBranch === branch.name
        ? " gh-branches-panel__row--drag-reject"
        : " gh-branches-panel__row--drag-source"
      : drag.hoverBranch === branch.name
        ? " gh-branches-panel__row--drag-target"
        : "";

  return (
    <li
      className={`gh-branches-panel__row${branchDrag ? " gh-branches-panel__row--draggable" : ""}${dragClass}`}
      data-ref-branch={branchDrag ? branch.name : undefined}
      data-ref-sha={branchDrag ? branch.tipSha : undefined}
      onContextMenu={onContextMenu}
      onDragStart={branchDrag ? (e) => e.preventDefault() : undefined}
      onPointerDown={
        branchDrag
          ? (e) => {
              // FR-422: pressing directly on Checkout/Delete never starts a drag.
              if ((e.target as Element).closest(".gh-branches-panel__row-actions")) return;
              branchDrag.begin(e, { branch: branch.name, sha: branch.tipSha });
            }
          : undefined
      }
    >
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
          // FR-613: the worktree glyph replaces the "Checked out elsewhere" text in the same footprint; the path stays in the tooltip and the accessible name.
          <span
            className="gh-branches-panel__badge gh-branches-panel__badge--worktree"
            title={`Checked out at ${visibleText(checkedOutElsewhere)}`}
            role="img"
            aria-label={`Checked out at ${visibleText(checkedOutElsewhere)}`}
          >
            {worktreeEntry?.isMain ? <IconWorktreeMain size={12} /> : <IconWorktree size={12} />}
            In worktree
          </span>
        )}
      </div>
      {aheadBehind && (
        <span className="gh-branches-panel__upstream gh-mono" title={`${aheadBehind} — as of the last fetch (${lastFetchedLabel}).`}>
          {aheadBehind}
        </span>
      )}
      <span className="gh-branches-panel__commit">
        {truncate(branch.tipSubject || "(no message)", 72)} — {formatAuthor(branch.tipAuthorName, branch.tipAuthorEmail)}
      </span>
      {/* specs/online-sync-fetch.md FR-326: a real, visible per-session fetch timestamp —
          supersedes FR-57's permanently-static "last-known" caveat now that a fetch triggered
          from inside GitHydra can actually refresh this data. */}
      <span className="gh-branches-panel__last-fetched gh-mono">{lastFetchedLabel}</span>
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
  lastFetchedLabel,
  onContextMenu,
}: {
  branch: RemoteBranchInfo;
  onContextMenu: (e: MouseEvent<HTMLLIElement>) => void;
  hasWorkdir: boolean;
  bareReason: string;
  busy: boolean;
  onCheckout: () => void;
  onLocate: () => void;
  /** specs/online-sync-fetch.md FR-326 */
  lastFetchedLabel: string;
}) {
  return (
    <li className="gh-branches-panel__row" onContextMenu={onContextMenu}>
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
      <span className="gh-branches-panel__last-fetched gh-mono">{lastFetchedLabel}</span>
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

/** A keyboard-invoked contextmenu event (Shift+F10, the menu key) carries no pointer position: anchor to the card itself. */
function menuPoint(e: MouseEvent<HTMLElement>): { x: number; y: number } {
  if (e.clientX === 0 && e.clientY === 0) {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: r.left + 24, y: r.top + 24 };
  }
  return { x: e.clientX, y: e.clientY };
}
