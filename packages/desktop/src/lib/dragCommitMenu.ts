// SPDX-License-Identifier: GPL-3.0-or-later
import type { CommitInfo, CommitPairRelationship, RepositoryState } from "@githydra/git-core";

/**
 * specs/drag-commit-menu.md FR-305/306: resolve a commit's display label for the drag menu's
 * header/item copy — its local branch name, else its remote-tracking branch name, else its tag
 * name (the first ref of the highest-priority type present), else its abbreviated SHA.
 *
 * `commit.refs` is already ordered local-branch-before-remote-branch-before-tag whenever more
 * than one type decorates the same commit (`git for-each-ref`'s own alphabetical
 * "refs/heads" < "refs/remotes" < "refs/tags" ordering, `packages/git-core/src/refs.ts`'s
 * `listRefs()`) — the same order `buildRefChips` (`lib/refChips.ts`) already renders its badges
 * in, per FR-305's "no new sort order invented" — so a plain first-match-per-type walk is
 * sufficient; no secondary sort is performed here.
 */
export function resolveDragCommitLabel(
  commit: Pick<CommitInfo, "refs" | "abbrevSha"> | undefined,
  fallbackSha: string,
): string {
  if (!commit) return fallbackSha.slice(0, 7);
  const local = commit.refs.find((r) => r.type === "local-branch");
  if (local) return local.name;
  const remote = commit.refs.find((r) => r.type === "remote-branch");
  if (remote) return remote.name;
  const tag = commit.refs.find((r) => r.type === "tag");
  if (tag) return tag.name;
  return commit.abbrevSha;
}

/** specs/drag-commit-menu.md FR-305's local-branch name specifically — used by FR-309's
 * checkout-if-needed to decide `git switch <name>` vs. `git switch --detach <sha>`. `null` when
 * `{B}` isn't a local branch tip at all (a remote-tracking branch, a tag, or nothing). */
export function localBranchNameOf(commit: Pick<CommitInfo, "refs"> | undefined): string | null {
  return commit?.refs.find((r) => r.type === "local-branch")?.name ?? null;
}

/**
 * specs/drag-commit-menu.md FR-307/FR-308: the exact disabled-with-reason state for Merge/Rebase,
 * mirroring `lib/cherryPickEligibility.ts`'s `computeCherryPickDisabledReason` convention (checked
 * client-side so this can never disagree with `mergeCommit()`/`rebaseCommitOnto()`'s own
 * server-side refusal). `relationship` is `"computing"` for the brief window between drop and the
 * FR-295 ancestry read resolving (AC1) and `"error"` on the rare case that read itself failed
 * (e.g. a transport error) — neither is one of FR-307's four real ancestry outcomes, so both are
 * handled up front rather than falling through into the table below.
 */
export function computeMergeOrRebaseDisabledReason(
  repoState: RepositoryState | null,
  relationship: CommitPairRelationship | "computing" | "error",
  busy: boolean,
  kind: "merge" | "rebase",
): string | null {
  if (relationship === "computing") return "Computing…";
  if (relationship === "error") return "Could not determine commit history — try again.";
  if (busy) return `A ${kind} is already running.`;
  if (!repoState) return "Repository state is still loading.";
  if (repoState.inProgressOperation) {
    return `${kind === "merge" ? "Merge" : "Rebase"} is disabled while another operation is already in progress.`;
  }
  if (repoState.isBare) {
    return `This is a bare repository — it has no working directory to ${kind === "merge" ? "merge into" : "rebase onto"}.`;
  }
  if (repoState.isUnbornHead) {
    return `This repository has no commits yet, so there is nothing to ${kind === "merge" ? "merge" : "rebase"}.`;
  }
  if (relationship === "a-ancestor-of-b") return kind === "merge" ? "Already up to date" : "Nothing to replay";
  if (relationship === "no-common-ancestor") return "No shared history between these commits";
  return null; // "b-ancestor-of-a" (fast-forward) or "diverged" — both enabled per FR-307's table.
}
