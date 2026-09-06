// SPDX-License-Identifier: GPL-3.0-or-later
import type { GraphDisplayRow } from "../hooks/useRepositoryGraph";

/**
 * specs/cherry-pick.md FR-114: sort a multi-commit selection into the currently-loaded graph's own
 * oldest/most-ancestral-first order, regardless of the order the user happened to click them in —
 * `cherryPick()`'s own argv order is the caller's contract to uphold (git-core trusts it verbatim,
 * see `cherryPick.ts`'s doc comment).
 *
 * `displayRows` is newest-first (row 0 is HEAD/the most recent commit; a larger index is older —
 * see `CommitGraph.tsx`'s own row-ordering convention), so "oldest first" is the exact reverse of
 * a sha's position in that array: the sha with the LARGEST index sorts first.
 *
 * A sha not found in `displayRows` is defensive-only (the selection only ever comes from rendered
 * rows) — it sorts after every resolvable sha, in its original relative order, rather than
 * throwing or silently dropping it.
 */
export function sortShasInGraphOrder(
  shas: readonly string[],
  displayRows: readonly GraphDisplayRow[],
): string[] {
  const indexOf = new Map<string, number>();
  displayRows.forEach((row, i) => {
    if (row.kind === "commit") indexOf.set(row.laid.commit.sha, i);
  });
  return [...shas].sort((a, b) => {
    const ai = indexOf.get(a);
    const bi = indexOf.get(b);
    if (ai === undefined && bi === undefined) return 0;
    if (ai === undefined) return 1;
    if (bi === undefined) return -1;
    return bi - ai; // Larger row index (older/more ancestral) sorts first.
  });
}
