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
  /**
   * specs/graph-head-indicator-and-refresh-alerting.md Problem 1: true when this row's commit is
   * the repo's current HEAD position, independent of `isSelected` — driven purely by
   * `repoState.headSha`, so it stays visually marked "at all times, not just on selection"
   * (commit-graph.md FR-17) even after the user clicks away to inspect a different commit.
   */
  isCurrent: boolean;
  style: CSSProperties;
  onSelect: (sha: string) => void;
  /** Must-have #2 (specs/detailpanel-auto-diff.md): activating the uncommitted-changes
   * "checkpoint" pseudo-row opens the Changes panel and auto-selects its first diffable file —
   * distinct from `onSelect`, which is only ever called with a real commit sha. */
  onSelectCheckpoint: () => void;
  onContextMenu: (event: MouseEvent, sha: string) => void;
  /** FR-55: right-click on a local-branch ref chip — never called for remote-branch/tag/HEAD
   * chips (those have no Checkout/Delete affordance from the graph). */
  onRefChipContextMenu?: (event: MouseEvent, branchName: string) => void;
}

export function CommitRow({
  id,
  row,
  graphWidth,
  visibleRefNames,
  repoState,
  isSelected,
  isActive,
  isCurrent,
  style,
  onSelect,
  onSelectCheckpoint,
  onContextMenu,
  onRefChipContextMenu,
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
        className={`gh-commit-row gh-commit-row--pseudo${isActive ? " gh-commit-row--active" : ""}`}
        style={{ ...style, height: ROW_HEIGHT, paddingLeft: graphWidth }}
        title="Uncommitted working-directory changes — click to review them in the Changes panel"
        onClick={onSelectCheckpoint}
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
  // buildRefChips already renders an unambiguous "HEAD (detached)" chip for the detached case
  // (AC4/AC6) — this dedicated marker only needs to cover the attached case, where HEAD is today
  // implied solely by the filled branch chip's color, which is exactly the ambiguity Problem 1
  // calls out. Guarding on `chips` (rather than `repoState?.isDetachedHead`) keeps this correct
  // even if that chip is ever hidden by ref-visibility filtering for some other reason.
  const showHeadMarker = isCurrent && !chips.some((chip) => chip.decoration.type === "head");

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
      {showHeadMarker && (
        <span className="gh-commit-row__head-marker">
          <RefChip decoration={{ name: "HEAD", fullName: null, type: "head" }} laneColor="var(--gh-accent)" filled />
        </span>
      )}
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
              onContextMenu={
                chip.decoration.type === "local-branch" && onRefChipContextMenu
                  ? (e) => {
                      e.preventDefault();
                      // Without this, the event bubbles up to the row's own onContextMenu below
                      // and opens the *commit's* context menu at the same time/position (caught
                      // in manual testing against the real app — two overlapping menus).
                      e.stopPropagation();
                      onRefChipContextMenu(e, chip.decoration.name);
                    }
                  : undefined
              }
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
