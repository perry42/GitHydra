import { vi } from "vitest";
import type {
  CommitInfo,
  CommitLogFilter,
  CommitLogPage,
  ConflictedFileInfo,
  ConflictFileDiff,
  ConflictMarkerScanResult,
  ConflictSideLabels,
  CreateBranchOptions,
  CreateBranchResult,
  CreateCommitResult,
  CreateStashOptions,
  CreateStashResult,
  FileDiffResult,
  LocalBranchInfo,
  RefInfo,
  RemoteBranchInfo,
  RepositoryState,
  StashApplyOutcome,
  StashDiffResult,
  StashInfo,
  SwitchResult,
  WorkingDirectoryChanges,
} from "@githydra/git-core";

function defaultFileDiff(): FileDiffResult {
  return { status: "ok", isBinary: false, hunks: [] };
}

function defaultConflictFileDiff(): ConflictFileDiff {
  return { baseToOurs: null, baseToTheirs: null, oursToTheirs: null };
}

/** specs/stash.md: renumber a stash list's `index`/`ref` fields back into `stash@{0}`-first
 * contiguous order after a removal — mirrors real `git stash drop`/a clean `pop`'s own reflog
 * renumbering, which the mock's callers (`popStash`/`dropStash` below) rely on for realism. */
function renumberStashes(list: StashInfo[]): StashInfo[] {
  return list.map((s, i) => ({ ...s, index: i, ref: `stash@{${i}}` }));
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
  /** specs/merge-rebase-conflict-resolution.md FR-62/FR-63: seed for `getConflictedFiles`. */
  conflictedFiles?: ConflictedFileInfo[];
  /** FR-64: canned diff returned by `getConflictFileDiff` for every conflicted file, unless
   * overridden per-test via `vi.mocked(api.getConflictFileDiff).mockResolvedValueOnce(...)`. */
  conflictFileDiff?: ConflictFileDiff;
  /** FR-61: seed for `getConflictSideLabels`. */
  conflictSideLabels?: ConflictSideLabels | null;
  /** FR-66: seed for `scanConflictMarkers` — defaults to "no markers found". */
  conflictMarkerScan?: ConflictMarkerScanResult;
  /** specs/stash.md FR-81: seed for `listStashes`. `null` simulates a bare repository (no working
   * directory); omitted defaults to `[]` (no stashes), matching the real empty-list convention. */
  stashes?: StashInfo[] | null;
  /** specs/stash.md FR-83: per-stash diff results, keyed by the stash's `index`. Falls back to
   * `{ files: [] }` for any index not present here. */
  stashDiffs?: Record<number, StashDiffResult>;
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
  conflictedFilesState: ConflictedFileInfo[];
  conflictFileDiff: ConflictFileDiff;
  conflictSideLabels: ConflictSideLabels | null;
  conflictMarkerScan: ConflictMarkerScanResult;
  /** specs/stash.md: `null` simulates a bare repository, matching `listStashes()`'s real
   * bare-repo convention. */
  stashesState: StashInfo[] | null;
  stashDiffs: Record<number, StashDiffResult>;
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
    inProgressOperationDetail: null,
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
    conflictedFilesState: (opts.conflictedFiles ?? []).map((f) => ({ ...f })),
    conflictFileDiff: opts.conflictFileDiff ?? defaultConflictFileDiff(),
    conflictSideLabels: opts.conflictSideLabels ?? null,
    conflictMarkerScan: opts.conflictMarkerScan ?? { hasMarkers: false, markerLines: [] },
    stashesState: opts.stashes === undefined ? [] : opts.stashes === null ? null : opts.stashes.map((s) => ({ ...s })),
    stashDiffs: opts.stashDiffs ?? {},
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
    // A real IPC round trip always hands the renderer an independent, structured-clone copy — a
    // caller that captures this array (e.g. specs/self-write-refresh-suppression.md's pre-mutation
    // baseline) must not see it retroactively change if `active().refs` is mutated afterward.
    // Cloning here (element-wise, not just the outer array) matches that real-world semantic.
    getRefs: vi.fn(() => ok(active().refs.map((r) => ({ ...r })))),
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
        record.repoState = { ...record.repoState, headSha: sha };
      }
      return ok<CreateBranchResult>({ name, fullName: `refs/heads/${name}`, sha, switched: Boolean(branchOptions.switchToIt) });
    }),
    switchBranch: vi.fn((branchName: string) => {
      const record = active();
      record.currentBranchState = branchName;
      const sha = record.localBranchesState.find((b) => b.name === branchName)?.tipSha ?? "0000000000000000000000000000000000000000";
      // Real `git switch` moves HEAD to the target branch's tip — reflect that in both `getState()`
      // (via `headShaState`, per specs/graph-head-indicator-and-refresh-alerting.md) and
      // `repoState.headSha` directly, since `openRepo()` below returns `active().repoState` as-is,
      // bypassing `getState()`'s override (specs/self-write-refresh-suppression.md's AC5 fix diffs
      // against the real HEAD sha, so a mock that left either one stale would falsely look like an
      // "unexpected" change, or miss one, depending which accessor a test happens to use).
      record.headShaState = sha;
      record.repoState = { ...record.repoState, headSha: sha };
      return ok<SwitchResult>({ sha });
    }),
    switchToCommit: vi.fn((commitish: string) => {
      const record = active();
      record.currentBranchState = null;
      record.headShaState = commitish;
      record.repoState = { ...record.repoState, headSha: commitish };
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

    // specs/merge-rebase-conflict-resolution.md, FR-58 through FR-80.
    getConflictedFiles: vi.fn(() => ok(active().conflictedFilesState.map((f) => ({ ...f })))),
    getConflictFileDiff: vi.fn(() => ok(active().conflictFileDiff)),
    getConflictSideLabels: vi.fn(() => ok(active().conflictSideLabels)),
    scanConflictMarkers: vi.fn(() => ok(active().conflictMarkerScan)),
    acceptConflictSide: vi.fn((filePath: string) => {
      const record = active();
      if (record.conflictMarkerScan.hasMarkers) {
        return Promise.resolve({
          ok: false as const,
          error: {
            name: "ConflictMarkersRemainError",
            message: `Cannot mark "${filePath}" as resolved: conflict markers still present in this file.`,
          },
        });
      }
      record.conflictedFilesState = record.conflictedFilesState.filter((f) => f.path !== filePath);
      return ok(undefined);
    }),
    markConflictResolved: vi.fn((filePath: string) => {
      const record = active();
      if (record.conflictMarkerScan.hasMarkers) {
        return Promise.resolve({
          ok: false as const,
          error: {
            name: "ConflictMarkersRemainError",
            message: `Cannot mark "${filePath}" as resolved: conflict markers still present in this file.`,
          },
        });
      }
      record.conflictedFilesState = record.conflictedFilesState.filter((f) => f.path !== filePath);
      return ok(undefined);
    }),
    abortInProgressOperation: vi.fn(() => ok(undefined)),
    continueInProgressOperation: vi.fn(() => {
      const record = active();
      if (record.conflictedFilesState.length > 0) {
        return Promise.resolve({
          ok: false as const,
          error: {
            name: "ContinueBlockedError",
            message: `Cannot continue: unresolved conflict(s) remain in ${record.conflictedFilesState
              .map((f) => f.path)
              .join(", ")}.`,
          },
        });
      }
      return ok(undefined);
    }),
    openPathInExternalEditor: vi.fn(() => ok(undefined)),

    // specs/stash.md, FR-81 through FR-90.
    listStashes: vi.fn(() => {
      const { stashesState } = active();
      return ok(stashesState ? stashesState.map((s) => ({ ...s })) : null);
    }),
    getStashDiff: vi.fn((index: number) => ok(active().stashDiffs[index] ?? { files: [] })),
    createStash: vi.fn((options?: CreateStashOptions) => {
      const record = active();
      if (record.stashesState === null) {
        return Promise.resolve({
          ok: false as const,
          error: { name: "InvalidArgumentError", message: "Cannot create a stash: this repository has no working directory." },
        });
      }
      const sha = `0000newstash${record.stashesState.length}`.padEnd(40, "0").slice(0, 40);
      const message = options?.message?.trim()
        ? options.message.trim()
        : `WIP on ${record.currentBranchState ?? "(no branch)"}: ${(record.headShaState ?? "0000000").slice(0, 7)} mock commit`;
      const entry: StashInfo = {
        index: 0,
        ref: "stash@{0}",
        sha,
        message,
        branch: options?.message?.trim() ? null : record.currentBranchState,
        date: new Date().toISOString(),
        parentSha: record.headShaState,
      };
      record.stashesState = [entry, ...renumberStashes(record.stashesState).map((s) => ({ ...s, index: s.index + 1, ref: `stash@{${s.index + 1}}` }))];
      // A real `git stash push` clears whatever it stashed out of the working tree/index —
      // approximate that here so a create -> re-check-changes round trip in a test looks real.
      if (record.changesState) record.changesState = { staged: [], unstaged: [], untracked: [], conflicted: record.changesState.conflicted };
      return ok<CreateStashResult>({ ref: "stash@{0}", sha });
    }),
    applyStash: vi.fn((_index: number) => ok<StashApplyOutcome>({ status: "applied" })),
    popStash: vi.fn((index: number) => {
      const record = active();
      if (record.stashesState) {
        record.stashesState = renumberStashes(record.stashesState.filter((s) => s.index !== index));
      }
      return ok<StashApplyOutcome>({ status: "applied" });
    }),
    dropStash: vi.fn((index: number) => {
      const record = active();
      if (record.stashesState) {
        record.stashesState = renumberStashes(record.stashesState.filter((s) => s.index !== index));
      }
      return ok(undefined);
    }),

    // specs/cherry-pick.md, FR-103 through FR-110. Default behavior is a clean, successful
    // apply/skip/commit-empty — tests exercising a conflict/empty-result pause or a genuine
    // refusal override these per-call via `vi.mocked(api.cherryPick).mockResolvedValueOnce(...)`
    // (and, since this hook's own error/pause distinction re-reads `getState()`, typically also
    // override `getState` for that same call to reflect the resulting `inProgressOperation`/
    // `inProgressOperationDetail`) — mirroring `useStashActions.test.ts`'s own override pattern.
    cherryPick: vi.fn((_shas: readonly string[]) => ok(undefined)),
    skipCherryPickCommit: vi.fn(() => ok(undefined)),
    commitEmptyCherryPick: vi.fn(() => ok(undefined)),
  };
  return api;
}
