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
  /**
   * specs/multi-repo-tabs.md test support: additional repos, keyed by path, that `openRepo` (and
   * every subsequent call) switches to when opened at a path other than the default `repoPath`
   * above — lets one mock exercise two tabs pointed at genuinely different repos (different
   * commits/refs/branches/working-dir state) in the same test, mirroring `RepoSession`'s real
   * "exactly one open repo live at a time" semantics. Opening a path that's neither the default
   * `repoPath` nor a key of this map falls back to reusing the default repo's data (matching this
   * mock's original single-repo behavior, for every test that never sets this option at all).
   */
  reposByPath?: Record<string, Omit<MockGitHydraOptions, "reposByPath">>;
}

interface RepoRecord {
  repoState: RepositoryState;
  allCommits: CommitInfo[];
  filtered: CommitInfo[];
  offset: number;
  refs: RefInfo[];
  workingDirStatus: WorkingDirectoryStatus | null;
  upstreamShortName: string | null;
  fileDiff: FileDiffResult;
  changesState: WorkingDirectoryChanges | null;
  localBranchesState: LocalBranchInfo[];
  remoteBranchesState: RemoteBranchInfo[];
  currentBranchState: string | null;
  /**
   * specs/graph-head-indicator-and-refresh-alerting.md Problem 1: tracks HEAD moving via
   * switchBranch/switchToCommit/createBranch(switchToIt) the same way `currentBranchState`
   * already does, so `getState()` reflects the new `headSha` for tests asserting the graph
   * auto-selects/scrolls to it after checkout/branch-switch, without a full `openRepo` round-trip.
   */
  headShaState: string | null;
}

function buildRecord(path: string, opts: Omit<MockGitHydraOptions, "reposByPath">): RepoRecord {
  const repoState: RepositoryState = {
    gitDir: `${path}/.git`,
    commonGitDir: `${path}/.git`,
    workdir: path,
    isBare: false,
    isShallow: false,
    isWorktree: false,
    isEmpty: false,
    isUnbornHead: false,
    isDetachedHead: false,
    currentBranch: "main",
    headSha: opts.commits?.[0]?.sha ?? null,
    inProgressOperation: null,
    ...opts.repoState,
  };
  const allCommits = opts.commits ?? [];
  return {
    repoState,
    allCommits,
    filtered: allCommits,
    offset: 0,
    refs: opts.refs ?? [],
    workingDirStatus: opts.workingDirStatus ?? null,
    upstreamShortName: opts.upstreamShortName ?? null,
    fileDiff: opts.fileDiff ?? defaultFileDiff(),
    changesState: opts.workingDirectoryChanges ? cloneChanges(opts.workingDirectoryChanges) : null,
    localBranchesState: (opts.localBranches ?? []).map((b) => ({ ...b })),
    remoteBranchesState: (opts.remoteBranches ?? []).map((b) => ({ ...b })),
    currentBranchState: repoState.currentBranch,
    headShaState: repoState.headSha,
  };
}

/** A fully in-memory fake of `window.gitHydra` for tests that exercise the hook/App wiring
 * without a real Electron main process. */
export function makeMockGitHydra(options: MockGitHydraOptions = {}): GitHydraApi {
  const defaultPath = options.repoPath ?? "/repo";
  const records = new Map<string, RepoRecord>();
  records.set(defaultPath, buildRecord(defaultPath, options));
  for (const [path, repoOptions] of Object.entries(options.reposByPath ?? {})) {
    records.set(path, buildRecord(path, repoOptions));
  }

  let activePath = defaultPath;
  const active = (): RepoRecord => records.get(activePath)!;

  const api: GitHydraApi = {
    openRepoDialog: vi.fn(() => ok(defaultPath)),
    openRepo: vi.fn((path: string) => {
      if (!records.has(path)) records.set(path, records.get(defaultPath)!);
      activePath = path;
      return ok({ path, state: active().repoState });
    }),
    // FR-56: reflects the active record's `currentBranchState` (mutated by switchBranch/
    // switchToCommit/createBranch's switchToIt below) rather than a frozen snapshot, so a test
    // can assert the Toolbar/graph refreshes after a mock switch without a full `openRepo`
    // round-trip.
    getState: vi.fn(() => {
      const record = active();
      return ok({
        ...record.repoState,
        currentBranch: record.currentBranchState,
        isDetachedHead: record.currentBranchState === null,
        headSha: record.headShaState,
      });
    }),
    getRefs: vi.fn(() => ok(active().refs)),
    // Minimal author-substring emulation (enough to exercise FR-14's "narrows results" and
    // "no matching commits" paths in tests) — not a full CommitLogFilter implementation.
    createLogReader: vi.fn((filter?: CommitLogFilter) => {
      const record = active();
      record.offset = 0;
      record.filtered = filter?.author
        ? record.allCommits.filter((c) => c.authorName.toLowerCase().includes(filter.author!.toLowerCase()))
        : record.allCommits;
      return ok("reader-1");
    }),
    readPage: vi.fn((_readerId: string, count: number) => {
      const record = active();
      const slice = record.filtered.slice(record.offset, record.offset + count);
      record.offset += slice.length;
      const page: CommitLogPage = { commits: slice, done: record.offset >= record.filtered.length };
      return ok(page);
    }),
    closeReader: vi.fn(() => ok(undefined)),
    getCommit: vi.fn((sha: string) => ok(active().allCommits.find((c) => c.sha === sha) ?? null)),
    getChangedFiles: vi.fn(() => ok([])),
    getWorkingDirStatus: vi.fn(() => ok(active().workingDirStatus)),
    getUpstreamBranch: vi.fn(() => ok(active().upstreamShortName)),
    onRefsChanged: vi.fn(() => () => {}),

    getWorkingDirectoryChanges: vi.fn(() => {
      const { changesState } = active();
      return ok(changesState ? cloneChanges(changesState) : null);
    }),
    getUnstagedFileDiff: vi.fn(() => ok(active().fileDiff)),
    getStagedFileDiff: vi.fn(() => ok(active().fileDiff)),
    getUntrackedFileDiff: vi.fn(() => ok(active().fileDiff)),
    getCommitFileDiff: vi.fn(() => ok(active().fileDiff)),

    stageFile: vi.fn((path: string) => {
      const record = active();
      if (record.changesState) {
        const from = record.changesState.unstaged.some((e) => e.path === path) ? "unstaged" : "untracked";
        record.changesState = optimisticStage(record.changesState, path, from);
      }
      return ok(undefined);
    }),
    unstageFile: vi.fn((path: string) => {
      const record = active();
      if (record.changesState) record.changesState = optimisticUnstage(record.changesState, path);
      return ok(undefined);
    }),
    stageAllFiles: vi.fn(() => {
      const record = active();
      if (record.changesState) record.changesState = optimisticStageAll(record.changesState);
      return ok(undefined);
    }),
    unstageAllFiles: vi.fn(() => {
      const record = active();
      if (record.changesState) record.changesState = optimisticUnstageAll(record.changesState);
      return ok(undefined);
    }),

    discardTrackedFileChanges: vi.fn((path: string) => {
      const record = active();
      if (record.changesState) {
        record.changesState = { ...record.changesState, unstaged: record.changesState.unstaged.filter((e) => e.path !== path) };
      }
      return ok(undefined);
    }),
    discardUntrackedFile: vi.fn((path: string) => {
      const record = active();
      if (record.changesState) {
        record.changesState = { ...record.changesState, untracked: record.changesState.untracked.filter((e) => e.path !== path) };
      }
      return ok(undefined);
    }),

    createCommit: vi.fn(() => {
      // A real commit clears the index — every staged file is now part of history.
      const record = active();
      if (record.changesState) record.changesState = { ...record.changesState, staged: [] };
      return ok<CreateCommitResult>({ sha: "newcommitsha" });
    }),

    listBranches: vi.fn(() => {
      const record = active();
      return ok(record.localBranchesState.map((b) => ({ ...b, isCurrent: b.name === record.currentBranchState })));
    }),
    listRemoteBranches: vi.fn(() => ok(active().remoteBranchesState.map((b) => ({ ...b })))),
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
      const record = active();
      const name = branchOptions.name.trim();
      const sha = record.allCommits[0]?.sha ?? "0000000000000000000000000000000000000000";
      record.localBranchesState = [
        ...record.localBranchesState,
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
      if (branchOptions.switchToIt) {
        record.currentBranchState = name;
        record.headShaState = sha;
      }
      return ok<CreateBranchResult>({ name, fullName: `refs/heads/${name}`, sha, switched: Boolean(branchOptions.switchToIt) });
    }),
    switchBranch: vi.fn((branchName: string) => {
      const record = active();
      record.currentBranchState = branchName;
      const sha = record.localBranchesState.find((b) => b.name === branchName)?.tipSha ?? "0000000000000000000000000000000000000000";
      record.headShaState = sha;
      return ok<SwitchResult>({ sha });
    }),
    switchToCommit: vi.fn((commitish: string) => {
      const record = active();
      record.currentBranchState = null;
      record.headShaState = commitish;
      return ok<SwitchResult>({ sha: commitish });
    }),
    deleteBranch: vi.fn((branchName: string) => {
      const record = active();
      record.localBranchesState = record.localBranchesState.filter((b) => b.name !== branchName);
      return ok(undefined);
    }),
    forceDeleteBranch: vi.fn((branchName: string) => {
      const record = active();
      record.localBranchesState = record.localBranchesState.filter((b) => b.name !== branchName);
      return ok(undefined);
    }),
  };
  return api;
}
