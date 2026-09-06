// SPDX-License-Identifier: GPL-3.0-or-later
import type { WorkingDirectoryChanges } from "@githydra/git-core";
import type { WorkingDirectoryStatus } from "../../shared/ipcContract";

/**
 * ROADMAP.md tech-debt fix ("redundant working-dir-status fetch"): `useRepositoryGraph` used to
 * fetch `WorkingDirectoryStatus` (porcelain v1, aggregate counts) independently from
 * `useChangesPanel`'s own `WorkingDirectoryChanges` fetch (porcelain v2, per-file arrays) — two
 * separate `git`-equivalent spawns for the same underlying state on every stage/unstage/discard/
 * commit, which is what caused real Windows `.git/index` lock collisions. `useRepositoryGraph` is
 * now the single owner of the per-file fetch; this pure function derives the aggregate-counts shape
 * every existing caller of `workingDirStatus` (Toolbar badge, StatusBanner, the graph's
 * uncommitted-changes pseudo-node, `computeCreateStashDisabledReason`) still expects, so none of
 * them need to change.
 *
 * Proven field-for-field equivalent to a real `getWorkingDirStatus()` read by git-core-engineer's
 * `packages/git-core/tests/statusCountEquivalence.test.ts` (14 scenarios, including rename/rename
 * conflicts, submodule gitlinks, mixed staged+unstaged-same-path, and no-commits-yet repos) — treat
 * that as ground truth; this module only does the (trivial) `.length` derivation, not re-verifies
 * the equivalence itself.
 */
export function deriveWorkingDirStatus(changes: WorkingDirectoryChanges | null): WorkingDirectoryStatus | null {
  if (changes === null) return null;
  const { staged, unstaged, untracked, conflicted } = changes;
  const total = staged.length + unstaged.length + untracked.length + conflicted.length;
  return {
    hasChanges: total > 0,
    staged: staged.length,
    unstaged: unstaged.length,
    untracked: untracked.length,
    conflicted: conflicted.length,
  };
}
