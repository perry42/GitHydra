// SPDX-License-Identifier: GPL-3.0-or-later
import type { CSSProperties, MouseEvent } from "react";
import type { RepositoryState } from "@githydra/git-core";
import type { GraphDisplayRow } from "../../hooks/useRepositoryGraph";
import { buildRefChips } from "../../lib/refChips";
import { formatAuthor, formatDate } from "../../lib/format";
import { RefChip } from "../RefChip/RefChip";
import { REF_GUTTER_WIDTH, ROW_HEIGHT } from "./graphGeometry";

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
  /**
   * specs/cherry-pick.md FR-111: true when this row is part of the graph's ctrl/shift-click
   * multi-selection — entirely independent of `isSelected` (a row can be multi-selected without
   * being the single `DetailPanel`-driving selection, and vice versa).
   */
  isMultiSelected: boolean;
  style: CSSProperties;
  /** FR-111: the raw click event is forwarded so `CommitGraph` can inspect ctrl/cmd/shift
   * modifiers to decide plain-select vs. toggle-into-multi-select vs. range-select — this row
   * component stays a dumb forwarder, all the interaction logic lives in `CommitGraph`. */
  onSelect: (sha: string, event: MouseEvent<HTMLDivElement>) => void;
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
  isMultiSelected,
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
        style={{ ...style, height: ROW_HEIGHT, paddingLeft: REF_GUTTER_WIDTH + graphWidth }}
        title="Uncommitted working-directory changes — click to review them in the Changes panel"
        onClick={onSelectCheckpoint}
      >
        {/* The uncommitted-changes pseudo-row has no refs, but still reserves the same gutter
            column width as every real commit row — an empty column, not a placeholder element,
            per DESIGN.md's "Ref chip" gutter revision — so the subject text below stays aligned
            with every other row's subject column regardless of ref presence. */}
        <span className="gh-commit-row__refgutter" style={{ width: REF_GUTTER_WIDTH }} aria-hidden="true" />
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
      aria-selected={isSelected || isMultiSelected}
      className={`gh-commit-row${isSelected ? " gh-commit-row--selected" : ""}${isActive ? " gh-commit-row--active" : ""}${isMultiSelected ? " gh-commit-row--multi-selected" : ""}`}
      style={{ ...style, height: ROW_HEIGHT, paddingLeft: REF_GUTTER_WIDTH + graphWidth }}
      onClick={(e) => onSelect(commit.sha, e)}
      onContextMenu={(e) => onContextMenu(e, commit.sha)}
    >
      {/* DESIGN.md "Ref chip" gutter revision: a persistent column before the graph canvas,
          present (as reserved space) on every row — `showHeadMarker`/`chips` decide what renders
          inside it, never whether the column itself exists. Absolutely positioned against this
          row (which is itself `position: absolute` for virtualization) at `left: 0`, the same
          overlay idiom `GraphCanvas` already uses relative to the row grid, rather than folding
          gutter width into the row's own flex flow. */}
      <span className="gh-commit-row__refgutter" style={{ width: REF_GUTTER_WIDTH }}>
        {showHeadMarker && (
          <RefChip decoration={{ name: "HEAD", fullName: null, type: "head" }} filled />
        )}
        {chips.map((chip, i) => (
          <RefChip
            key={`${chip.decoration.fullName ?? "HEAD"}-${i}`}
            decoration={chip.decoration}
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
      {isMultiSelected && (
        // specs/cherry-pick.md FR-111/FR-122: a visible, non-color-only marker (paired with
        // `aria-selected` above for assistive tech) — never relies on the background tint alone to
        // convey "this row is part of the cherry-pick selection".
        <span className="gh-commit-row__multi-marker" title="Selected for cherry-pick" aria-hidden="true">
          ✓
        </span>
      )}
      <span className="gh-commit-row__sha gh-mono gh-tabular">{commit.abbrevSha}</span>
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
