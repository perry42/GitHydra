import type { CommitInfo, RepositoryState } from "@githydra/git-core";
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
    ...overrides,
  };
}
