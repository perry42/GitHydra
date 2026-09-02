import { IconBranches, IconChanges, IconOpenRepo, IconRefresh, IconStashes, IconMoon, IconSun } from "../Icon/Icon";
import "./Toolbar.css";

export interface ToolbarProps {
  repoPath: string | null;
  onOpenRepo: () => void;
  onRefresh: () => void;
  canRefresh: boolean;
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
}

/**
 * design-pass fix #1 ("Toolbar has no visual hierarchy"): three role clusters, separated by a
 * hairline divider, instead of six identical gray-bordered rectangles —
 *   1. Panel-toggle chips (Branches/Changes/Stashes) — unchanged bordered-chip treatment
 *      (`gh-toolbar__button`/`--active`), now each carrying its icon-vocabulary glyph.
 *   2. Dialog-launcher (Open repository…) — kept bordered (it opens a native dialog, a heavier
 *      action than a toggle), now with an icon.
 *   3. Utility actions (Refresh, theme toggle) — demoted to icon-only ghost buttons
 *      (`gh-toolbar__icon-button`): no border until hover/focus, no visible label text (the icon
 *      is unambiguous and a `title` tooltip plus `aria-label` cover the rest), so they read as
 *      lower-weight than the panel toggles rather than competing with them.
 * There is deliberately no single "hero" button here — the commit graph is the primary surface
 * (DESIGN.md's FIRST VIEWPORT) — this is about demoting utilities and grouping toggles, not
 * picking one dominant action.
 */
export function Toolbar({
  repoPath,
  onOpenRepo,
  onRefresh,
  canRefresh,
  theme,
  onToggleTheme,
  showChangesToggle = false,
  changesCount = null,
  changesOpen = false,
  onToggleChanges,
  showBranchesToggle = false,
  currentBranchLabel = null,
  branchesOpen = false,
  onToggleBranches,
  showStashToggle = false,
  stashCount = null,
  stashOpen = false,
  onToggleStash,
  stashDisabledReason = null,
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
                aria-label={currentBranchLabel ? `Branches — current branch ${currentBranchLabel}` : "Branches"}
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

        <div className="gh-toolbar__group gh-toolbar__group--launcher">
          <button type="button" onClick={onOpenRepo} className="gh-toolbar__button">
            <IconOpenRepo />
            Open repository…
          </button>
        </div>

        <span className="gh-toolbar__divider" aria-hidden="true" />

        <div className="gh-toolbar__group gh-toolbar__group--utility">
          <button
            type="button"
            onClick={onRefresh}
            disabled={!canRefresh}
            className="gh-toolbar__icon-button"
            aria-label="Refresh commit graph"
            title="Refresh (manual — always available regardless of auto-detect)"
          >
            <IconRefresh />
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
        </div>
      </div>
    </header>
  );
}
