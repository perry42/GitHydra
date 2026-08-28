import { vi } from "vitest";
import type {
  CommitInfo,
  CommitLogFilter,
  CommitLogPage,
  CreateBranchOptions,
  CreateBranchResult,
  CreateCommitResult,
  FileDiffResult,
  LocalBranchInfo,
  RefInfo,
  RemoteBranchInfo,
  RepositoryState,
  SwitchResult,
  WorkingDirectoryChanges,
} from "@githydra/git-core";

function defaultFileDiff(): FileDiffResult {
  return { status: "ok", isBinary: false, hunks: [] };
}
import type { GitHydraApi, IpcResult, WorkingDirectoryStatus } from "../../shared/ipcContract";
import {
  optimisticStage,
  optimisticStageAll,
  optimisticUnstage,
  optimisticUnstageAll,
} from "../lib/workingDirOptimism";

function ok<T>(data: T): Promise<IpcResult<T>> {
  return Promise.resolve({ ok: true, data });
}

function cloneChanges(changes: WorkingDirectoryChanges): WorkingDirectoryChanges {
  return {
    staged: changes.staged.map((e) => ({ ...e })),
    unstaged: changes.unstaged.map((e) => ({ ...e })),
    untracked: changes.untracked.map((e) => ({ ...e })),
    conflicted: changes.conflicted.map((e) => ({ ...e })),
  };
}

export interface MockGitHydraOptions {
  repoPath?: string;
  repoState?: Partial<RepositoryState>;
  refs?: RefInfo[];
  commits?: CommitInfo[];
  workingDirStatus?: WorkingDirectoryStatus | null;
  upstreamShortName?: string | null;
  /** FR-19/FR-28: seed for `getWorkingDirectoryChanges`. `null` (default) matches the bare-repo
   * convention; pass an explicit `WorkingDirectoryChanges` shape to exercise the Changes panel. */
  workingDirectoryChanges?: WorkingDirectoryChanges | null;
  /** FR-20/FR-29: canned diff result returned for every diff-fetching method, unless overridden
   * per-test via `vi.mocked(api.getUnstagedFileDiff).mockResolvedValueOnce(...)` etc. */
  fileDiff?: FileDiffResult;
  /** FR-33: seed for `listBranches`. */
  localBranches?: LocalBranchInfo[];
  /** FR-34: seed for `listRemoteBranches`. */
  remoteBranches?: RemoteBranchInfo[];
}

/** A fully in-memory fake of `window.gitHydra` for tests that exercise the hook/App wiring
 * without a real Electron main process. */
export function makeMockGitHydra(options: MockGitHydraOptions = {}): GitHydraApi {
  const repoPath = options.repoPath ?? "/repo";
  const repoState: RepositoryState = {
    gitDir: `${repoPath}/.git`,
    commonGitDir: `${repoPath}/.git`,
    workdir: repoPath,
    isBare: false,
    isShallow: false,
    isWorktree: false,
    isEmpty: false,
    isUnbornHead: false,
    isDetachedHead: false,
    currentBranch: "main",
    headSha: options.commits?.[0]?.sha ?? null,
    inProgressOperation: null,
    ...options.repoState,
  };
  const allCommits = options.commits ?? [];
  let filtered = allCommits;
  let offset = 0;
  // FR-19/FR-28/FR-30/FR-31/FR-32: a real, mutating in-memory model (not a static snapshot) so
  // stage/unstage/discard/commit calls are reflected the next time `getWorkingDirectoryChanges`
  // is read — mirrors the `createLogReader`/`readPage` pattern above. `null` (the default)
  // matches the bare-repo convention.
  let changesState: WorkingDirectoryChanges | null = options.workingDirectoryChanges
    ? cloneChanges(options.workingDirectoryChanges)
    : null;
  // FR-33/34/35/36/37/38/39/40/41: a real, mutating in-memory model — same convention as
  // `changesState` above — so create/switch/delete calls are reflected on the next `listBranches`.
  let localBranchesState: LocalBranchInfo[] = (options.localBranches ?? []).map((b) => ({ ...b }));
  const remoteBranchesState: RemoteBranchInfo[] = (options.remoteBranches ?? []).map((b) => ({ ...b }));
  let currentBranchState = repoState.currentBranch;

  const api: GitHydraApi = {
    openRepoDialog: vi.fn(() => ok(repoPath)),
    openRepo: vi.fn(() => ok({ path: repoPath, state: repoState })),
    // FR-56: reflects `currentBranchState` (mutated by switchBranch/switchToCommit/createBranch's
    // switchToIt below) rather than the frozen `repoState` snapshot, so a test can assert the
    // Toolbar/graph refreshes after a mock switch without a full `openRepo` round-trip.
    getState: vi.fn(() =>
      ok({
        ...repoState,
        currentBranch: currentBranchState,
        isDetachedHead: currentBranchState === null,
      }),
    ),
    getRefs: vi.fn(() => ok(options.refs ?? [])),
    // Minimal author-substring emulation (enough to exercise FR-14's "narrows results" and
    // "no matching commits" paths in tests) — not a full CommitLogFilter implementation.
    createLogReader: vi.fn((filter?: CommitLogFilter) => {
      offset = 0;
      filtered = filter?.author
        ? allCommits.filter((c) => c.authorName.toLowerCase().includes(filter.author!.toLowerCase()))
        : allCommits;
      return ok("reader-1");
    }),
    readPage: vi.fn((_readerId: string, count: number) => {
      const slice = filtered.slice(offset, offset + count);
      offset += slice.length;
      const page: CommitLogPage = { commits: slice, done: offset >= filtered.length };
      return ok(page);
    }),
    closeReader: vi.fn(() => ok(undefined)),
    getCommit: vi.fn((sha: string) => ok(allCommits.find((c) => c.sha === sha) ?? null)),
    getChangedFiles: vi.fn(() => ok([])),
    getWorkingDirStatus: vi.fn(() => ok(options.workingDirStatus ?? null)),
    getUpstreamBranch: vi.fn(() => ok(options.upstreamShortName ?? null)),
    onRefsChanged: vi.fn(() => () => {}),

    getWorkingDirectoryChanges: vi.fn(() => ok(changesState ? cloneChanges(changesState) : null)),
    getUnstagedFileDiff: vi.fn(() => ok(options.fileDiff ?? defaultFileDiff())),
    getStagedFileDiff: vi.fn(() => ok(options.fileDiff ?? defaultFileDiff())),
    getUntrackedFileDiff: vi.fn(() => ok(options.fileDiff ?? defaultFileDiff())),
    getCommitFileDiff: vi.fn(() => ok(options.fileDiff ?? defaultFileDiff())),

    stageFile: vi.fn((path: string) => {
      if (changesState) {
        const from = changesState.unstaged.some((e) => e.path === path) ? "unstaged" : "untracked";
        changesState = optimisticStage(changesState, path, from);
      }
      return ok(undefined);
    }),
    unstageFile: vi.fn((path: string) => {
      if (changesState) changesState = optimisticUnstage(changesState, path);
      return ok(undefined);
    }),
    stageAllFiles: vi.fn(() => {
      if (changesState) changesState = optimisticStageAll(changesState);
      return ok(undefined);
    }),
    unstageAllFiles: vi.fn(() => {
      if (changesState) changesState = optimisticUnstageAll(changesState);
      return ok(undefined);
    }),

    discardTrackedFileChanges: vi.fn((path: string) => {
      if (changesState) changesState = { ...changesState, unstaged: changesState.unstaged.filter((e) => e.path !== path) };
      return ok(undefined);
    }),
    discardUntrackedFile: vi.fn((path: string) => {
      if (changesState) changesState = { ...changesState, untracked: changesState.untracked.filter((e) => e.path !== path) };
      return ok(undefined);
    }),

    createCommit: vi.fn(() => {
      // A real commit clears the index — every staged file is now part of history.
      if (changesState) changesState = { ...changesState, staged: [] };
      return ok<CreateCommitResult>({ sha: "newcommitsha" });
    }),

    listBranches: vi.fn(() => ok(localBranchesState.map((b) => ({ ...b, isCurrent: b.name === currentBranchState })))),
    listRemoteBranches: vi.fn(() => ok(remoteBranchesState.map((b) => ({ ...b })))),
    validateBranchName: vi.fn((name: string) => {
      if (!name.trim() || /[\s~^:?*[\\]|\.lock$/.test(name)) {
        return Promise.resolve({
          ok: false as const,
          error: { name: "InvalidRefNameError", message: `"${name}" is not a valid branch name` },
        });
      }
      return ok(undefined);
    }),
    createBranch: vi.fn((branchOptions: CreateBranchOptions) => {
      const name = branchOptions.name.trim();
      const sha = options.commits?.[0]?.sha ?? "0000000000000000000000000000000000000000";
      localBranchesState = [
        ...localBranchesState,
        {
          name,
          fullName: `refs/heads/${name}`,
          tipSha: sha,
          tipSubject: "",
          tipAuthorName: "",
          tipAuthorEmail: "",
          tipAuthorDate: "",
          tipCommitterDate: "",
          isCurrent: Boolean(branchOptions.switchToIt),
          checkedOutInWorktree: null,
          upstreamName: branchOptions.track ? (branchOptions.startPoint ?? null) : null,
          upstreamGone: false,
          ahead: branchOptions.track ? 0 : null,
          behind: branchOptions.track ? 0 : null,
        },
      ];
      if (branchOptions.switchToIt) currentBranchState = name;
      return ok<CreateBranchResult>({ name, fullName: `refs/heads/${name}`, sha, switched: Boolean(branchOptions.switchToIt) });
    }),
    switchBranch: vi.fn((branchName: string) => {
      currentBranchState = branchName;
      const sha = localBranchesState.find((b) => b.name === branchName)?.tipSha ?? "0000000000000000000000000000000000000000";
      return ok<SwitchResult>({ sha });
    }),
    switchToCommit: vi.fn((commitish: string) => {
      currentBranchState = null;
      return ok<SwitchResult>({ sha: commitish });
    }),
    deleteBranch: vi.fn((branchName: string) => {
      localBranchesState = localBranchesState.filter((b) => b.name !== branchName);
      return ok(undefined);
    }),
    forceDeleteBranch: vi.fn((branchName: string) => {
      localBranchesState = localBranchesState.filter((b) => b.name !== branchName);
      return ok(undefined);
    }),
  };
  return api;
}
