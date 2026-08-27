import "./Toolbar.css";

export interface ToolbarProps {
  repoPath: string | null;
  onOpenRepo: () => void;
  onRefresh: () => void;
  canRefresh: boolean;
  theme: "light" | "dark";
  onToggleTheme: () => void;
}

export function Toolbar({ repoPath, onOpenRepo, onRefresh, canRefresh, theme, onToggleTheme }: ToolbarProps) {
  return (
    <header className="gh-toolbar">
      <span className="gh-toolbar__brand">GitHydra</span>
      <span className="gh-toolbar__repo-path gh-mono" title={repoPath ?? undefined}>
        {repoPath ?? "No repository open"}
      </span>
      <div className="gh-toolbar__actions">
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
