// SPDX-License-Identifier: GPL-3.0-or-later
import type { BlameCommitInfo, BlameLine } from "@githydra/git-core";

/** One contiguous run of `BlameLine`s attributed to the same commit (FR-132: "contiguous lines
 * from the same commit are visually banded as one block, with commit metadata shown once per
 * block, not repeated per line"). Grouping is purely positional (contiguous run in the blamed
 * file's line order) — two non-adjacent runs from the same commit are always two separate
 * blocks, never merged, since that's what "contiguous" means and what a reader visually scanning
 * top-to-bottom expects. */
export interface BlameBlock {
  commit: BlameCommitInfo;
  lines: BlameLine[];
}

/** Groups a flat `BlameLine[]` (as returned by `getFileBlame`'s `"ok"` result, in file line
 * order) into contiguous same-commit blocks. Exported for direct unit testing, mirroring this
 * codebase's `parsePorcelainBlame()`/`conflictClassification.ts` precedent of keeping pure
 * grouping/classification logic separately testable from the component that renders it. */
export function groupBlameLines(lines: readonly BlameLine[]): BlameBlock[] {
  const blocks: BlameBlock[] = [];
  for (const line of lines) {
    const last = blocks[blocks.length - 1];
    if (last && last.commit.sha === line.commit.sha) {
      last.lines.push(line);
    } else {
      blocks.push({ commit: line.commit, lines: [line] });
    }
  }
  return blocks;
}
