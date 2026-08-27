import type { CSSProperties, MouseEvent } from "react";
import type { RepositoryState } from "@githydra/git-core";
import type { GraphDisplayRow } from "../../hooks/useRepositoryGraph";
import { buildRefChips } from "../../lib/refChips";
import { formatAuthor, formatDate } from "../../lib/format";
import { laneColorVar } from "../../lib/laneAssignment";
import { RefChip } from "../RefChip/RefChip";
import { ROW_HEIGHT } from "./graphGeometry";

export interface CommitRowProps {
  id: string;
  row: GraphDisplayRow;
  graphWidth: number;
  visibleRefNames: ReadonlySet<string>;
  repoState: RepositoryState | null;
  isSelected: boolean;
  isActive: boolean;
  style: CSSProperties;
  onSelect: (sha: string) => void;
  onContextMenu: (event: MouseEvent, sha: string) => void;
}

export function CommitRow({
  id,
  row,
  graphWidth,
  visibleRefNames,
  repoState,
  isSelected,
  isActive,
  style,
  onSelect,
  onContextMenu,
}: CommitRowProps) {
  if (row.kind === "uncommitted") {
    const { status } = row;
    const parts: string[] = [];
    if (status.staged) parts.push(`${status.staged} staged`);
    if (status.unstaged) parts.push(`${status.unstaged} unstaged`);
    if (status.untracked) parts.push(`${status.untracked} untracked`);
    if (status.conflicted) parts.push(`${status.conflicted} conflicted`);
    return (
      <div
        id={id}
        role="option"
        aria-selected={false}
        aria-disabled="true"
        className="gh-commit-row gh-commit-row--pseudo"
        style={{ ...style, height: ROW_HEIGHT, paddingLeft: graphWidth }}
        title="Uncommitted working-directory changes — not a real commit"
      >
        <span className="gh-commit-row__subject gh-commit-row__subject--pseudo">
          Uncommitted changes{parts.length > 0 ? ` (${parts.join(", ")})` : ""}
        </span>
      </div>
    );
  }

  const { laid } = row;
  const commit = laid.commit;
  const chips = buildRefChips(commit, visibleRefNames, repoState);

  return (
    <div
      id={id}
      role="option"
      aria-selected={isSelected}
      className={`gh-commit-row${isSelected ? " gh-commit-row--selected" : ""}${isActive ? " gh-commit-row--active" : ""}`}
      style={{ ...style, height: ROW_HEIGHT, paddingLeft: graphWidth }}
      onClick={() => onSelect(commit.sha)}
      onContextMenu={(e) => onContextMenu(e, commit.sha)}
    >
      <span className="gh-commit-row__sha gh-mono gh-tabular">{commit.abbrevSha}</span>
      {chips.length > 0 && (
        <span className="gh-commit-row__chips">
          {chips.map((chip, i) => (
            <RefChip
              key={`${chip.decoration.fullName ?? "HEAD"}-${i}`}
              decoration={chip.decoration}
              laneColor={laneColorVar(laid.colorSlot)}
              filled={chip.filled}
              detached={chip.detached}
            />
          ))}
        </span>
      )}
      {commit.isHistoryBoundary && (
        <span className="gh-commit-row__boundary" title="History unavailable beyond this point (shallow clone / grafted history)">
          History boundary
        </span>
      )}
      <span className="gh-commit-row__subject">{commit.subject || "(empty commit message)"}</span>
      <span className="gh-commit-row__author">{formatAuthor(commit.authorName, commit.authorEmail)}</span>
      <span className="gh-commit-row__date gh-tabular">{formatDate(commit.authorDate)}</span>
    </div>
  );
}
