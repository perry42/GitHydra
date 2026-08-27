import { vi } from "vitest";
import type { CommitInfo, CommitLogFilter, CommitLogPage, RefInfo, RepositoryState } from "@githydra/git-core";
import type { GitHydraApi, IpcResult, WorkingDirectoryStatus } from "../../shared/ipcContract";

function ok<T>(data: T): Promise<IpcResult<T>> {
  return Promise.resolve({ ok: true, data });
}

export interface MockGitHydraOptions {
  repoPath?: string;
  repoState?: Partial<RepositoryState>;
  refs?: RefInfo[];
  commits?: CommitInfo[];
  workingDirStatus?: WorkingDirectoryStatus | null;
  upstreamShortName?: string | null;
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

  const api: GitHydraApi = {
    openRepoDialog: vi.fn(() => ok(repoPath)),
    openRepo: vi.fn(() => ok({ path: repoPath, state: repoState })),
    getState: vi.fn(() => ok(repoState)),
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
  };
  return api;
}
