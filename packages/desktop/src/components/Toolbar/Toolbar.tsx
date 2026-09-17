// SPDX-License-Identifier: GPL-3.0-or-later
import { IconBranches, IconChanges, IconFetch, IconFind, IconIdentity, IconPull, IconRefresh, IconStashes, IconMoon, IconSun } from "../Icon/Icon";
import { keyComboLabel } from "../../lib/platform";
import type { PullStrategyChoice } from "../../hooks/usePullAction";
import "./Toolbar.css";

export interface ToolbarProps {
  repoPath: string | null;
  onRefresh: () => void;
  canRefresh: boolean;
  /**
   * specs/refresh-without-teardown.md: true while a manual refresh (`graph.refresh()`) is
   * in-flight — independent of `canRefresh`/`graph.status`, since a manual refresh no longer moves
   * `status` away from `"ready"` at all (see `useRepositoryGraph`'s `refresh` doc comment). Drives
   * the button's `aria-busy`, a spinning icon, and disabling it for the duration (prevents piling
   * up overlapping refreshes from a double-click) — defaults to `false` for callers that don't
   * pass it.
   */
  isRefreshing?: boolean;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  /** FR-28: whether the Changes toggle should be shown at all (a repo is open and past the
   * opening/error states) — independent of whether there happen to be any changes right now, so
   * a bare repo or a clean working tree can still reach the panel's explicit empty states. */
  showChangesToggle?: boolean;
  /** Total pending change count (staged+unstaged+untracked+conflicted), or `null` for a bare
   * repo (no working directory to count) — shown as a badge on the toggle. */
  changesCount?: number | null;
  changesOpen?: boolean;
  onToggleChanges?: () => void;
  /** FR-56: whether the Branches toggle should be shown — a repo is open and past opening/error. */
  showBranchesToggle?: boolean;
  /** FR-56: current-branch indicator, refreshed after any successful branch operation. `null`
   * for detached HEAD, unborn HEAD, or a bare repo, rendered as a neutral "Branches" label
   * rather than a blank/misleading branch name in those cases. */
  currentBranchLabel?: string | null;
  /**
   * specs/online-sync-fetch.md FR-326: "fetched 3m ago" / "never fetched this session", appended
   * to the current-branch button's `title` tooltip — the same text-carried-caveat convention
   * DESIGN.md's "Ahead/behind 'last-known' captioning" already established (never color-only),
   * now backed by a real per-session timestamp instead of a permanently-static caveat (FR-57's
   * text this supersedes). `null`/omitted renders no caption at all (e.g. no repo open yet).
   */
  lastFetchedLabel?: string | null;
  /**
   * design-pass "Branches panel relocation": the Branches panel is now a persistent left sidebar
   * (always rendered while a repo is open) rather than one of the toggleable right-hand rails —
   * this button no longer opens/closes it, it expands/collapses it. `branchesOpen` /
   * `onToggleBranches` keep their original names (the button's visible label/position and the
   * "current branch at a glance" purpose are unchanged) but now mean "sidebar expanded" / "toggle
   * the sidebar's collapsed state".
   */
  branchesOpen?: boolean;
  onToggleBranches?: () => void;
  /** specs/stash.md FR-93: whether the Stash toggle should be shown — a repo is open and past
   * opening/error. */
  showStashToggle?: boolean;
  /** FR-93: live `git stash list` count, or `null` for a bare repo (no working directory). */
  stashCount?: number | null;
  stashOpen?: boolean;
  onToggleStash?: () => void;
  /** Edge cases: disables the toggle itself (not just the panel body) on a bare repository,
   * naming the reason — stash is entirely inapplicable with no working directory. */
  stashDisabledReason?: string | null;
  /**
   * specs/find-commits-overlay.md FR-258: whether the "Find commits" icon button is shown at all
   * — the exact gate the retired `FilterBar` rendered under (`graph.status === "ready" &&
   * graph.repoState && !graph.repoState.isEmpty && !graph.repoState.isUnbornHead`), not just
   * `showChangesToggle`/`showBranchesToggle`'s looser "repo open" gate.
   */
  showFindCommitsButton?: boolean;
  /**
   * FR-259/FR-263: a single click handler — App owns whether this opens or closes-and-clears
   * (re-clicking while the overlay is already open is one of FR-263's remaining explicit close
   * triggers), so this button, like Refresh, carries no pressed/active visual state of its own.
   */
  onFindCommits?: () => void;
  /**
   * FR-263 revision: whether a commit filter is currently applied, independent of whether the
   * overlay itself is visible — clicking outside the overlay now only hides it (the filter can
   * outlive that), so this button needs its own active-state signal or an applied-but-hidden
   * filter would be silently invisible. Mirrors the retired `FilterBar`'s collapsed-toggle dot:
   * a small filled indicator plus visually-hidden text, never color-only.
   */
  findCommitsActive?: boolean;
  /**
   * specs/online-sync-fetch.md FR-327: whether the Fetch action is shown at all — a repo is open
   * and past the opening/error states, same gate `showChangesToggle`/`showBranchesToggle` use.
   */
  showFetchButton?: boolean;
  /** FR-327: triggers `fetchAllRemotes()` for the active tab's repo. */
  onFetch?: () => void;
  /** FR-322: true while a fetch is already in flight — disables the button and shows a spinning
   * icon, the same treatment Refresh's own `isRefreshing` already established, so a double-click
   * can't pile up a second overlapping attempt. */
  isFetching?: boolean;
  /**
   * specs/online-sync-pull.md FR-343: whether the Pull action is shown at all — the same
   * "repo is open, past the opening/error states" gate `showFetchButton` uses.
   */
  showPullButton?: boolean;
  /** FR-343: null when Pull is eligible; otherwise the exact reason it's disabled right now (no
   * configured upstream, a bare repo, an unborn HEAD, or an operation already in progress) —
   * rendered as the button's `title`/part of its `aria-label`, the same disabled-with-reason
   * convention `stashDisabledReason` already established. */
  pullDisabledReason?: string | null;
  /** FR-339: triggers `pull()` for the active tab's repo, using `pullStrategy`. */
  onPull?: () => void;
  /** FR-322-mirrored: true while a pull is already in flight. */
  isPulling?: boolean;
  /** FR-339: the current per-pull strategy override — `"auto"` (no override; git-core resolves the
   * repo's own config) by default. */
  pullStrategy?: PullStrategyChoice;
  onPullStrategyChange?: (strategy: PullStrategyChoice) => void;
  /**
   * specs/git-identity-profiles.md: opens the Git Identity Profiles dialog — always shown,
   * independent of repo state (FR-329's profile library is fully usable with no repo open at
   * all), so this carries no `show*`/gating prop of its own, matching the theme toggle's own
   * always-visible utility-button convention.
   */
  onOpenIdentityProfiles?: () => void;
}

/**
 * design-pass fix #1 ("Toolbar has no visual hierarchy"): two role clusters, separated by a
 * hairline divider, instead of six identical gray-bordered rectangles —
 *   1. Panel-toggle chips (Branches/Changes/Stashes) — unchanged bordered-chip treatment
 *      (`gh-toolbar__button`/`--active`), now each carrying its icon-vocabulary glyph.
 *   2. Utility actions (Refresh, theme toggle) — demoted to icon-only ghost buttons
 *      (`gh-toolbar__icon-button`): no border until hover/focus, no visible label text (the icon
 *      is unambiguous and a `title` tooltip plus `aria-label` cover the rest), so they read as
 *      lower-weight than the panel toggles rather than competing with them.
 * There is deliberately no single "hero" button here — the commit graph is the primary surface
 * (DESIGN.md's FIRST VIEWPORT) — this is about demoting utilities and grouping toggles, not
 * picking one dominant action.
 *
 * specs/repo-list.md (revised IA): the "Open repository…" dialog-launcher this cluster used to
 * carry a third role for is gone entirely — opening a repo now only happens from the landing
 * screen (`EmptyState`), reached via `TabBar`'s "+ New tab" — see that spec's Must-have 2/AC10.
 */
export function Toolbar({
  repoPath,
  onRefresh,
  canRefresh,
  isRefreshing = false,
  theme,
  onToggleTheme,
  showChangesToggle = false,
  changesCount = null,
  changesOpen = false,
  onToggleChanges,
  showBranchesToggle = false,
  currentBranchLabel = null,
  lastFetchedLabel = null,
  branchesOpen = false,
  onToggleBranches,
  showStashToggle = false,
  stashCount = null,
  stashOpen = false,
  onToggleStash,
  stashDisabledReason = null,
  showFindCommitsButton = false,
  onFindCommits,
  findCommitsActive = false,
  showFetchButton = false,
  onFetch,
  isFetching = false,
  showPullButton = false,
  pullDisabledReason = null,
  onPull,
  isPulling = false,
  pullStrategy = "auto",
  onPullStrategyChange,
  onOpenIdentityProfiles,
}: ToolbarProps) {
  const showToggleGroup = showBranchesToggle || showChangesToggle || showStashToggle;

  return (
    <header className="gh-toolbar">
      <span className="gh-toolbar__brand">GitHydra</span>
      <span className="gh-toolbar__repo-path gh-mono" title={repoPath ?? undefined}>
        {repoPath ?? "No repository open"}
      </span>
      <div className="gh-toolbar__actions">
        {showToggleGroup && (
          <div className="gh-toolbar__group gh-toolbar__group--toggles">
            {showBranchesToggle && (
              <button
                type="button"
                onClick={onToggleBranches}
                className={`gh-toolbar__button gh-toolbar__branch${branchesOpen ? " gh-toolbar__button--active" : ""}`}
                aria-pressed={branchesOpen}
                aria-label={
                  currentBranchLabel
                    ? `Branches — current branch ${currentBranchLabel}${lastFetchedLabel ? `, ${lastFetchedLabel}` : ""}`
                    : "Branches"
                }
                title={lastFetchedLabel ?? undefined}
              >
                <IconBranches />
                <span className="gh-mono">{currentBranchLabel ?? "Branches"}</span>
              </button>
            )}
            {showChangesToggle && (
              <button
                type="button"
                onClick={onToggleChanges}
                className={`gh-toolbar__button${changesOpen ? " gh-toolbar__button--active" : ""}`}
                aria-pressed={changesOpen}
                aria-label={changesCount ? `Changes, ${changesCount} pending` : "Changes"}
              >
                <IconChanges />
                Changes{changesCount ? <span className="gh-toolbar__badge gh-tabular">{changesCount}</span> : null}
              </button>
            )}
            {showStashToggle && (
              <button
                type="button"
                onClick={onToggleStash}
                disabled={stashDisabledReason !== null}
                title={stashDisabledReason ?? undefined}
                className={`gh-toolbar__button${stashOpen ? " gh-toolbar__button--active" : ""}`}
                aria-pressed={stashOpen}
                aria-label={stashCount ? `Stashes, ${stashCount}` : "Stashes"}
              >
                <IconStashes />
                Stashes{stashCount ? <span className="gh-toolbar__badge gh-tabular">{stashCount}</span> : null}
              </button>
            )}
          </div>
        )}

        {showToggleGroup && <span className="gh-toolbar__divider" aria-hidden="true" />}

        <div className="gh-toolbar__group gh-toolbar__group--utility">
          {showFindCommitsButton && (
            <button
              type="button"
              onClick={onFindCommits}
              // specs/find-commits-overlay.md FR-263: identifies this specific button to
              // `FindCommitsOverlay`'s own click-outside listener so it's excluded from the
              // generic "closed on any outside click" check — this button's own `onClick`
              // (`App.tsx`'s toggle wrapper) is the single, race-free owner of the "re-click while
              // open closes it" behavior. Without this, a real browser/user-event's separate
              // mousedown-then-click sequence lets the click-outside listener close the overlay on
              // mousedown, after which the click event (now reading fresh, already-closed state)
              // reopens it — a flicker-closed-then-reopen bug, not a close.
              data-find-commits-trigger="true"
              className="gh-toolbar__icon-button"
              // security-reviewer finding: an explicit aria-label overrides the button's subtree
              // for accessible-name computation, so a visually-hidden span inside it is never
              // folded into what a screen reader announces — the label itself must carry the
              // active-filter state, not a hidden text sibling the label silently suppresses.
              aria-label={findCommitsActive ? "Find commits (a commit filter is currently applied)" : "Find commits"}
              title={`Find commits (${keyComboLabel({ key: "f", mod: true, shift: true })})`}
            >
              <IconFind />
              {/* FR-263 revision: a filter can now stay applied with the overlay hidden (a
                  click-outside dismissal no longer clears it) — this dot is the sighted-only
                  signal that's true; the aria-label above carries the same state for assistive
                  tech, mirroring the retired FilterBar's collapsed-toggle dot's intent. */}
              {findCommitsActive && <span className="gh-toolbar__icon-button-indicator" aria-hidden="true" />}
            </button>
          )}
          {showFetchButton && (
            <button
              type="button"
              onClick={onFetch}
              disabled={isFetching}
              aria-busy={isFetching}
              className="gh-toolbar__icon-button"
              aria-label={isFetching ? "Fetching remotes…" : "Fetch all remotes"}
              title="Fetch all remotes — pulls down remote-tracking refs (does not merge or change your working directory)"
            >
              <IconFetch className={isFetching ? "gh-toolbar__icon--pulse" : undefined} />
            </button>
          )}
          {showPullButton && (
            <div className="gh-toolbar__pull-group">
              {/* FR-339: an explicit per-pull override — "Auto" (the default) makes no choice the
                  user didn't ask to make (git-core resolves the repo's own config, exactly as real
                  `git pull` would); Merge/Rebase force that one pull's strategy without ever
                  writing config. A native <select> — this app's existing accessible-control
                  baseline (see FilterBar's own date inputs) — rather than a custom dropdown, for a
                  three-item choice that doesn't need one. */}
              <select
                className="gh-toolbar__pull-strategy gh-mono"
                aria-label="Pull strategy"
                title="Pull strategy for this pull — Auto follows this repository's own git config"
                value={pullStrategy}
                disabled={isPulling}
                onChange={(e) => onPullStrategyChange?.(e.target.value as PullStrategyChoice)}
              >
                <option value="auto">Auto</option>
                <option value="merge">Merge</option>
                <option value="rebase">Rebase</option>
              </select>
              <button
                type="button"
                onClick={onPull}
                disabled={pullDisabledReason !== null}
                aria-busy={isPulling}
                className="gh-toolbar__icon-button"
                aria-label={isPulling ? "Pulling…" : pullDisabledReason ? `Pull (${pullDisabledReason})` : "Pull"}
                title={
                  pullDisabledReason ??
                  "Pull — fetch and bring your current branch up to date with its upstream"
                }
              >
                <IconPull className={isPulling ? "gh-toolbar__icon--pulse" : undefined} />
              </button>
            </div>
          )}
          <button
            type="button"
            onClick={onRefresh}
            disabled={!canRefresh || isRefreshing}
            aria-busy={isRefreshing}
            className="gh-toolbar__icon-button"
            aria-label={isRefreshing ? "Refreshing commit graph…" : "Refresh commit graph"}
            title="Refresh (manual — always available regardless of auto-detect)"
          >
            <IconRefresh className={isRefreshing ? "gh-toolbar__icon--spin" : undefined} />
          </button>
          <button
            type="button"
            onClick={onToggleTheme}
            className="gh-toolbar__icon-button"
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          >
            {theme === "dark" ? <IconSun /> : <IconMoon />}
          </button>
          <button
            type="button"
            onClick={onOpenIdentityProfiles}
            className="gh-toolbar__icon-button"
            aria-label="Git identity profiles"
            title="Git identity profiles — manage per-repo commit identity and SSH key profiles"
          >
            <IconIdentity />
          </button>
        </div>
      </div>
    </header>
  );
}
