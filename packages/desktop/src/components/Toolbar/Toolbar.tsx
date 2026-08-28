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
}

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
}: ToolbarProps) {
  return (
    <header className="gh-toolbar">
      <span className="gh-toolbar__brand">GitHydra</span>
      <span className="gh-toolbar__repo-path gh-mono" title={repoPath ?? undefined}>
        {repoPath ?? "No repository open"}
      </span>
      <div className="gh-toolbar__actions">
        {showChangesToggle && (
          <button
            type="button"
            onClick={onToggleChanges}
            className={`gh-toolbar__button${changesOpen ? " gh-toolbar__button--active" : ""}`}
            aria-pressed={changesOpen}
            aria-label={changesCount ? `Changes, ${changesCount} pending` : "Changes"}
          >
            Changes{changesCount ? <span className="gh-toolbar__badge gh-tabular">{changesCount}</span> : null}
          </button>
        )}
        <button type="button" onClick={onOpenRepo} className="gh-toolbar__button">
          Open repository…
        </button>
        <button
          type="button"
          onClick={onRefresh}
          disabled={!canRefresh}
          className="gh-toolbar__button"
          aria-label="Refresh commit graph"
          title="Refresh (manual — always available regardless of auto-detect)"
        >
          Refresh
        </button>
        <button
          type="button"
          onClick={onToggleTheme}
          className="gh-toolbar__button"
          aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        >
          {theme === "dark" ? "Light mode" : "Dark mode"}
        </button>
      </div>
    </header>
  );
}
