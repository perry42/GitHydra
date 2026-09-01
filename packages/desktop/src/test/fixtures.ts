import type { CommitInfo, LocalBranchInfo, RemoteBranchInfo, RepositoryState } from "@githydra/git-core";
import { LaneAssigner, type LaidOutRow } from "../lib/laneAssignment";
import type { GraphDisplayRow } from "../hooks/useRepositoryGraph";

export function makeCommit(sha: string, parents: string[] = [], overrides: Partial<CommitInfo> = {}): CommitInfo {
  return {
    sha,
    abbrevSha: sha.slice(0, 7),
    parents,
    authorName: "Ada Lovelace",
    authorEmail: "ada@example.com",
    authorDate: "2024-03-01T12:00:00+00:00",
    committerName: "Ada Lovelace",
    committerEmail: "ada@example.com",
    committerDate: "2024-03-01T12:00:00+00:00",
    subject: `Commit ${sha}`,
    body: "",
    message: `Commit ${sha}`,
    refs: [],
    isHistoryBoundary: false,
    ...overrides,
  };
}

export function layOut(commits: CommitInfo[]): LaidOutRow[] {
  const assigner = new LaneAssigner();
  return commits.map((c) => assigner.next(c));
}

export function makeDisplayRows(commits: CommitInfo[]): GraphDisplayRow[] {
  return layOut(commits).map((laid) => ({ kind: "commit" as const, laid }));
}

export function makeLocalBranch(name: string, overrides: Partial<LocalBranchInfo> = {}): LocalBranchInfo {
  return {
    name,
    fullName: `refs/heads/${name}`,
    tipSha: "abc1234abc1234abc1234abc1234abc1234abc1",
    tipSubject: `Tip of ${name}`,
    tipAuthorName: "Ada Lovelace",
    tipAuthorEmail: "ada@example.com",
    tipAuthorDate: "2024-03-01T12:00:00+00:00",
    tipCommitterDate: "2024-03-01T12:00:00+00:00",
    isCurrent: false,
    checkedOutInWorktree: null,
    upstreamName: null,
    upstreamGone: false,
    ahead: null,
    behind: null,
    ...overrides,
  };
}

export function makeRemoteBranch(
  remoteName: string,
  name: string,
  overrides: Partial<RemoteBranchInfo> = {},
): RemoteBranchInfo {
  return {
    name,
    fullName: `refs/remotes/${remoteName}/${name}`,
    remoteName,
    tipSha: "def5678def5678def5678def5678def5678def5",
    tipSubject: `Tip of ${remoteName}/${name}`,
    tipAuthorName: "Ada Lovelace",
    tipAuthorEmail: "ada@example.com",
    tipAuthorDate: "2024-03-01T12:00:00+00:00",
    tipCommitterDate: "2024-03-01T12:00:00+00:00",
    ...overrides,
  };
}

export function makeRepoState(overrides: Partial<RepositoryState> = {}): RepositoryState {
  return {
    gitDir: "/repo/.git",
    commonGitDir: "/repo/.git",
    workdir: "/repo",
    isBare: false,
    isShallow: false,
    isWorktree: false,
    isEmpty: false,
    isUnbornHead: false,
    isDetachedHead: false,
    currentBranch: "main",
    headSha: null,
    inProgressOperation: null,
    // specs/merge-rebase-conflict-resolution.md FR-58: null (no in-progress operation) by
    // default; pass an explicit detail object matching `inProgressOperation`'s kind to exercise
    // the operation banner's rich per-operation copy.
    inProgressOperationDetail: null,
    ...overrides,
  };
}

/** specs/stash.md FR-81: a `StashInfo` fixture defaulting to git's own "WIP on ..." shape. */
export function makeStash(
  index: number,
  overrides: Partial<import("@githydra/git-core").StashInfo> = {},
): import("@githydra/git-core").StashInfo {
  return {
    index,
    ref: `stash@{${index}}`,
    sha: `stash${index}0000000000000000000000000000000000`.slice(0, 40),
    message: `WIP on main: abc1234 Commit ${index}`,
    branch: "main",
    date: "2024-03-01T12:00:00+00:00",
    parentSha: "abc1234abc1234abc1234abc1234abc1234abc1",
    ...overrides,
  };
}

/** specs/merge-rebase-conflict-resolution.md: a `ConflictedFileInfo` fixture defaulting to the
 * common "both-modified" text-conflict shape — override individual fields for the FR-63/76-80
 * edge-case classifications (added/deleted-by-*, rename, binary, submodule). */
export function makeConflictedFile(
  path: string,
  overrides: Partial<import("@githydra/git-core").ConflictedFileInfo> = {},
): import("@githydra/git-core").ConflictedFileInfo {
  return {
    path,
    stageCombination: "both-modified",
    isSubmodule: false,
    isBinary: false,
    rename: null,
    base: { sha: "base0000000000000000000000000000000000", mode: "100644" },
    ours: { sha: "ours0000000000000000000000000000000000", mode: "100644" },
    theirs: { sha: "thei0000000000000000000000000000000000", mode: "100644" },
    ...overrides,
  };
}
