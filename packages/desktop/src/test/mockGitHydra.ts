// SPDX-License-Identifier: GPL-3.0-or-later
import { vi } from "vitest";
import type {
  ApplyIdentityProfileOptions,
  BlameResult,
  BulkDiscardCandidate,
  BulkDiscardResult,
  BulkDiscardRow,
  ChangedFile,
  CommitInfo,
  CommitLogFilter,
  CommitLogPage,
  CombinedFileDiffResult,
  CommitPairRelationship,
  ConflictedFileInfo,
  ConflictFileDiff,
  ConflictMarkerScanResult,
  ConflictSideLabels,
  ConflictSides,
  CreateBranchOptions,
  CreateBranchResult,
  OrphanedHeadResult,
  CreateCommitResult,
  CreateStashOptions,
  CreateStashResult,
  FetchRemoteOutcome,
  FileDiffResult,
  IdentityConfigConflictEntry,
  IdentityConfigState,
  IgnoreReport,
  ImageDiffResult,
  LocalBranchInfo,
  PullStrategy,
  RefInfo,
  RemoteBranchInfo,
  RemoveIdentityProfileResult,
  RepositoryState,
  ResetMode,
  StashApplyOutcome,
  StashDiffResult,
  StashInfo,
  SwitchResult,
  WorkingDirectoryChanges,
  WorkingDirectoryFileChange,
} from "@githydra/git-core";

/** specs/ignore-and-multiselect.md: a minimal `IgnoreReport` (root `.gitignore`, name/extension/directory rules). */
function mockIgnoreReport(req: { paths: string[]; scope: string; target: string }, applied: boolean): IgnoreReport {
  const file = req.target === "exclude" ? ".git/info/exclude" : ".gitignore";
  const rows = req.paths.map((path) => {
    const bare = path.replace(/\/$/, "");
    const base = bare.slice(bare.lastIndexOf("/") + 1);
    const rule =
      req.scope === "extension"
        ? `*${base.slice(base.lastIndexOf("."))}`
        : req.scope === "directory"
          ? `/${bare.includes("/") ? bare.slice(0, bare.lastIndexOf("/")) : bare}/`
          : `/${bare}${path.endsWith("/") ? "/" : ""}`;
    return { path, tracked: false, outcome: applied ? ("written" as const) : ("will-write" as const), rule, file };
  });
  return {
    rows,
    files: [{ file, created: false, rules: Array.from(new Set(rows.map((r) => r.rule))), alreadyPresent: [], sharedWithOtherWorktrees: false }],
    stopTracking: null,
    applied,
  };
}

function defaultFileDiff(): FileDiffResult {
  return { status: "ok", isBinary: false, hunks: [] };
}

/** specs/image-diff-preview.md: default seed for every `*ImageDiff` channel, unless overridden
 * via `MockGitHydraOptions.imageDiff` or per-test via `vi.mocked(api.get*ImageDiff)`. */
function defaultImageDiff(): ImageDiffResult {
  return { status: "ok", old: null, new: null };
}

function defaultConflictFileDiff(): ConflictFileDiff {
  return { baseToOurs: null, baseToTheirs: null, oursToTheirs: null };
}

/** specs/git-identity-profiles.md FR-335: default seed for `getIdentityConfigState` — nothing set
 * locally or globally, nothing GitHydra-managed. */
function defaultIdentityConfigState(): IdentityConfigState {
  const empty = { localValue: null, globalValue: null, managedByGitHydra: false };
  return { userName: { ...empty }, userEmail: { ...empty }, sshCommand: { ...empty } };
}

/** specs/stash.md: renumber a stash list's `index`/`ref` fields back into `stash@{0}`-first
 * contiguous order after a removal — mirrors real `git stash drop`/a clean `pop`'s own reflog
 * renumbering, which the mock's callers (`popStash`/`dropStash` below) rely on for realism. */
function renumberStashes(list: StashInfo[]): StashInfo[] {
  return list.map((s, i) => ({ ...s, index: i, ref: `stash@{${i}}` }));
}
import type { GitHydraApi, IpcResult, OpenRepoOutcome, WorkingDirectoryStatus } from "../../shared/ipcContract";
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

/**
 * ROADMAP.md tech-debt fix: `useRepositoryGraph` now derives `workingDirStatus` (aggregate counts)
 * from a `getWorkingDirectoryChanges()` (per-file) fetch instead of its own independent
 * `getWorkingDirStatus()` read — see `deriveWorkingDirStatus`'s doc comment for the (git-core-
 * engineer-proven) equivalence. Many existing tests only care about the aggregate counts and pass
 * `workingDirStatus` without a matching `workingDirectoryChanges`; this fabricates a per-file shape
 * whose `.length`s reproduce those counts exactly, so `buildRecord` can keep honoring the
 * `workingDirStatus` option for the mock's `getWorkingDirectoryChanges()` channel (the one
 * `useRepositoryGraph` actually calls now) without every such test needing to be rewritten with
 * realistic per-file data it never inspects. Exported so tests overriding a *specific* call (e.g.
 * `vi.mocked(api.getWorkingDirectoryChanges).mockResolvedValueOnce(...)`, simulating "the watcher's
 * fresh read now shows X") can build that override's payload the same way.
 */
export function fakeWorkingDirectoryChanges(status: WorkingDirectoryStatus): WorkingDirectoryChanges {
  const make = (count: number, category: WorkingDirectoryFileChange["category"]): WorkingDirectoryFileChange[] =>
    Array.from({ length: count }, (_, i) => ({
      path: `__synthesized-${category}-${i}.txt`,
      status: category === "untracked" ? "added" : category === "conflicted" ? "unmerged" : "modified",
      category,
    }));
  return {
    staged: make(status.staged, "staged"),
    unstaged: make(status.unstaged, "unstaged"),
    untracked: make(status.untracked, "untracked"),
    conflicted: make(status.conflicted, "conflicted"),
  };
}

export interface MockGitHydraOptions {
  repoPath?: string;
  repoState?: Partial<RepositoryState>;
  refs?: RefInfo[];
  commits?: CommitInfo[];
  /** Seed for the `getWorkingDirStatus` channel (unused by `useRepositoryGraph` since the
   * ROADMAP.md tech-debt fix, but the channel itself still exists on the real API — see
   * `getWorkingDirStatus`'s doc comment in `ipcContract.ts`). When `workingDirectoryChanges` below
   * is omitted, this is also used to fabricate a per-file `getWorkingDirectoryChanges()` result
   * with matching aggregate counts (`fakeWorkingDirectoryChanges`), so existing tests that only
   * care about aggregate counts don't need real per-file data to exercise
   * `useRepositoryGraph`'s (now sole) fetch path. */
  workingDirStatus?: WorkingDirectoryStatus | null;
  upstreamShortName?: string | null;
  /** FR-19/FR-28: seed for `getWorkingDirectoryChanges`. `null` (default) matches the bare-repo
   * convention; pass an explicit `WorkingDirectoryChanges` shape to exercise the Changes panel. */
  workingDirectoryChanges?: WorkingDirectoryChanges | null;
  /** FR-20/FR-29: canned diff result returned for every diff-fetching method, unless overridden
   * per-test via `vi.mocked(api.getUnstagedFileDiff).mockResolvedValueOnce(...)` etc. */
  fileDiff?: FileDiffResult;
  /** specs/hunk-line-staging.md FR-479: canned `getCombinedFileDiff` result. Default is the separate-diff
   * fallback, so every pre-existing Changes-panel test keeps seeing the plain diff it always did. */
  combinedFileDiff?: CombinedFileDiffResult;
  /** specs/image-diff-preview.md FR-142: canned diff result returned for every `*ImageDiff`
   * method, unless overridden per-test via `vi.mocked(api.getUnstagedImageDiff).mockResolvedValueOnce(...)`
   * etc. Defaults to `{ status: "ok", old: null, new: null }` (an empty, non-representative
   * result) since most tests never select an image-eligible file at all. */
  imageDiff?: ImageDiffResult;
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
  /** specs/edit-in-diff.md FR-559: seed for `readConflictSides`. */
  conflictSides?: ConflictSides | null;
  /** specs/edit-in-diff.md FR-566: seed for `isConflictFileUntouched` (default true). */
  conflictFileUntouched?: boolean | null;
  /** specs/stash.md FR-81: seed for `listStashes`. `null` simulates a bare repository (no working
   * directory); omitted defaults to `[]` (no stashes), matching the real empty-list convention. */
  stashes?: StashInfo[] | null;
  /** specs/stash.md FR-83: per-stash diff results, keyed by the stash's `index`. Falls back to
   * `{ files: [] }` for any index not present here. */
  stashDiffs?: Record<number, StashDiffResult>;
  /** specs/blame.md FR-124: canned result returned by `getFileBlame`, unless overridden per-test
   * via `vi.mocked(api.getFileBlame).mockResolvedValueOnce(...)`. Defaults to an empty `"ok"`
   * result (no lines) — most tests care about the state transitions, not real blame content. */
  blameResult?: BlameResult;
  /** specs/blame.md FR-129: seed for `createFileHistoryReader`'s paged commit list — every test
   * repo's file history is this same fixed list regardless of `path`/`revision` requested (this
   * mock doesn't model per-file history). Defaults to `[]`. */
  fileHistoryCommits?: CommitInfo[];
  /** specs/drag-commit-menu.md FR-295: seed for `computeCommitPairRelationship`, regardless of
   * which pair is asked about (this mock doesn't model real ancestry) — override per-test via
   * `vi.mocked(api.computeCommitPairRelationship).mockResolvedValueOnce(...)` for a specific pair.
   * Defaults to `"diverged"` (every menu item enabled), the most permissive/least-surprising
   * default for tests that don't care about FR-307's ancestry table specifically. */
  commitPairRelationship?: CommitPairRelationship;
  /** specs/compare-commits.md FR-182: seed for `getChangedFilesBetween`, regardless of which two
   * SHAs are requested (this mock doesn't model real tree diffing). Defaults to `[]`. */
  compareChangedFiles?: ChangedFile[];
  /** specs/online-sync-fetch.md FR-321: seed for `fetchAllRemotes`'s per-remote outcomes, returned
   * verbatim on every call (this mock doesn't model real network transport) unless overridden
   * per-test via `vi.mocked(api.fetchAllRemotes).mockResolvedValueOnce(...)`. Defaults to `[]` — a
   * repo with no configured remotes, matching FR-321's own "nothing to fetch, not a failure"
   * convention. */
  fetchOutcomes?: FetchRemoteOutcome[];
  /** specs/online-sync-push.md FR-345: seed for `listConfiguredRemotes` — every remote name `git
   * remote` currently lists, in order. Defaults to `[]` (no remotes configured), matching this
   * mock's "nothing configured" default elsewhere (`fetchOutcomes`). */
  remotes?: string[];
  /** specs/reset-to-here.md FR-364: seed for `countCommitsExclusiveToHead`, regardless of which
   * pair is asked about (this mock doesn't model real ancestry/`rev-list` counting) — override
   * per-test via `vi.mocked(api.countCommitsExclusiveToHead).mockResolvedValueOnce(...)` for a
   * specific pair. Defaults to `1`. */
  resetImpactCount?: number | null;
  /** specs/git-identity-profiles.md FR-335: seed for `getIdentityConfigState`. Defaults to nothing
   * set locally/globally/managed — override per-test via `vi.mocked(api.getIdentityConfigState)
   * .mockResolvedValueOnce(...)`, or set this to seed the record `applyIdentityProfile`/
   * `removeIdentityProfileApplication` below then mutate in place. */
  identityConfigState?: IdentityConfigState;
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
  combinedFileDiff: CombinedFileDiffResult | undefined;
  imageDiff: ImageDiffResult;
  changesState: WorkingDirectoryChanges | null;
  localBranchesState: LocalBranchInfo[];
  remoteBranchesState: RemoteBranchInfo[];
  currentBranchState: string | null;
  conflictedFilesState: ConflictedFileInfo[];
  conflictFileDiff: ConflictFileDiff;
  conflictSideLabels: ConflictSideLabels | null;
  conflictMarkerScan: ConflictMarkerScanResult;
  conflictSides: ConflictSides | null;
  conflictFileUntouched: boolean | null;
  /** specs/stash.md: `null` simulates a bare repository, matching `listStashes()`'s real
   * bare-repo convention. */
  stashesState: StashInfo[] | null;
  stashDiffs: Record<number, StashDiffResult>;
  blameResult: BlameResult;
  fileHistoryCommits: CommitInfo[];
  /** specs/drag-commit-menu.md FR-295: seed for `computeCommitPairRelationship`. */
  commitPairRelationship: CommitPairRelationship;
  /** specs/compare-commits.md FR-182: seed for `getChangedFilesBetween`. */
  compareChangedFiles: ChangedFile[];
  /** specs/online-sync-fetch.md FR-321: seed for `fetchAllRemotes`. */
  fetchOutcomes: FetchRemoteOutcome[];
  /** specs/online-sync-push.md FR-345: seed for `listConfiguredRemotes`. */
  remotesState: string[];
  /** specs/reset-to-here.md FR-364: seed for `countCommitsExclusiveToHead`. */
  resetImpactCount: number | null;
  /** specs/git-identity-profiles.md FR-335: mutable in place by `applyIdentityProfile`/
   * `removeIdentityProfileApplication` below, mirroring how `localBranchesState` etc. are mutated
   * by their own mock handlers. */
  identityConfigState: IdentityConfigState;
  /** True once `applyIdentityProfile` has written this record's identity state; see
   * `getIdentityConfigState` below for how that gates the `knownApplication` trust check. */
  identityAppliedViaApi: boolean;
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
    combinedFileDiff: opts.combinedFileDiff,
    imageDiff: opts.imageDiff ?? defaultImageDiff(),
    changesState: opts.workingDirectoryChanges
      ? cloneChanges(opts.workingDirectoryChanges)
      : opts.workingDirStatus
        ? fakeWorkingDirectoryChanges(opts.workingDirStatus)
        : null,
    localBranchesState: (opts.localBranches ?? []).map((b) => ({ ...b })),
    remoteBranchesState: (opts.remoteBranches ?? []).map((b) => ({ ...b })),
    currentBranchState: repoState.currentBranch,
    conflictedFilesState: (opts.conflictedFiles ?? []).map((f) => ({ ...f })),
    conflictFileDiff: opts.conflictFileDiff ?? defaultConflictFileDiff(),
    conflictSideLabels: opts.conflictSideLabels ?? null,
    conflictMarkerScan: opts.conflictMarkerScan ?? { hasMarkers: false, markerLines: [] },
    conflictSides: opts.conflictSides ?? null,
    conflictFileUntouched: opts.conflictFileUntouched === undefined ? true : opts.conflictFileUntouched,
    stashesState: opts.stashes === undefined ? [] : opts.stashes === null ? null : opts.stashes.map((s) => ({ ...s })),
    stashDiffs: opts.stashDiffs ?? {},
    blameResult: opts.blameResult ?? { status: "ok", lines: [] },
    fileHistoryCommits: opts.fileHistoryCommits ?? [],
    commitPairRelationship: opts.commitPairRelationship ?? "diverged",
    compareChangedFiles: opts.compareChangedFiles ?? [],
    fetchOutcomes: opts.fetchOutcomes ?? [],
    remotesState: opts.remotes ?? [],
    resetImpactCount: opts.resetImpactCount === undefined ? 1 : opts.resetImpactCount,
    identityConfigState: opts.identityConfigState ?? defaultIdentityConfigState(),
    identityAppliedViaApi: false,
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

  // specs/blame.md FR-129: a separate, dedicated in-memory reader registry for
  // `createFileHistoryReader`'s paged commits, keyed by its own id namespace
  // (`file-history-reader-N`) so it never collides with `createLogReader`'s single shared
  // `record.filtered`/`offset` cursor (which `readPage`/`closeReader` below still serve first).
  let fileHistorySeq = 0;
  const fileHistoryReaders = new Map<string, { commits: CommitInfo[]; offset: number }>();

  const api: GitHydraApi = {
    openRepoDialog: vi.fn(() => ok(defaultPath)),
    openRepo: vi.fn((path: string) => {
      if (!records.has(path)) records.set(path, records.get(defaultPath)!);
      activePath = path;
      // specs/repo-open-feedback-fixes.md FR-202/FR-203: this in-memory mock doesn't model a
      // real subfolder-of-a-repo resolution — `path`/`pickedPath` are the same value here; tests
      // exercising the divergence override `path` per-call (see `App.test.tsx`'s "subfolder"
      // fixtures) or use `realGitHydraApi.ts` for real resolution behavior.
      return ok({ path, pickedPath: path, state: active().repoState });
    }),
    // specs/repo-open-feedback.md FR-163/FR-164/FR-165: default behavior mirrors `openRepo` above
    // (immediate, never-cancelled "settled" outcome) — a test exercising the actual cancel race
    // overrides this per-call via `vi.mocked(api.openRepoCancellable).mockImplementationOnce(...)`
    // with a deferred/controllable promise, same convention as this file's other per-test overrides.
    openRepoCancellable: vi.fn(async (path: string, _requestId: string): Promise<OpenRepoOutcome> => {
      if (!records.has(path)) records.set(path, records.get(defaultPath)!);
      activePath = path;
      return { outcome: "settled", result: { ok: true, data: { path, pickedPath: path, state: active().repoState } } };
    }),
    cancelOpenRepo: vi.fn(async (_requestId: string) => {}),
    // specs/repo-open-feedback-fixes.md FR-197/FR-199: default behavior always "succeeds" (this
    // in-memory mock has no real pending/committed distinction to model) — a test exercising the
    // real commit/rollback plumbing uses `realGitHydraApi.ts` instead, same convention as
    // `openRepoCancellable`'s own doc comment above.
    commitOpenRepo: vi.fn((_requestId: string) => ok(undefined)),
    endOpenAttempt: vi.fn(async (_requestId: string) => {}),
    // security review (specs/repo-list.md, revised IA): a pure in-memory mock has no real watcher
    // to close — the main-process teardown this channel triggers is covered by `repoSession.test.ts`
    // and `main.test.ts`; this mock only needs to exist so callers (`useRepositoryGraph.closeRepo`)
    // have something to await.
    closeRepoSession: vi.fn(() => ok(undefined)),
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
    getRefs: vi.fn((_requestId?: string) => ok(active().refs.map((r) => ({ ...r })))),
    // Minimal author-substring emulation (enough to exercise FR-14's "narrows results" and
    // "no matching commits" paths in tests) — not a full CommitLogFilter implementation.
    createLogReader: vi.fn((filter?: CommitLogFilter, _requestId?: string) => {
      const record = active();
      record.offset = 0;
      record.filtered = filter?.author
        ? record.allCommits.filter((c) => c.authorName.toLowerCase().includes(filter.author!.toLowerCase()))
        : record.allCommits;
      return ok("reader-1");
    }),
    readPage: vi.fn((readerId: string, count: number) => {
      const fileHistoryReader = fileHistoryReaders.get(readerId);
      if (fileHistoryReader) {
        const slice = fileHistoryReader.commits.slice(fileHistoryReader.offset, fileHistoryReader.offset + count);
        fileHistoryReader.offset += slice.length;
        const page: CommitLogPage = { commits: slice, done: fileHistoryReader.offset >= fileHistoryReader.commits.length };
        return ok(page);
      }
      const record = active();
      const slice = record.filtered.slice(record.offset, record.offset + count);
      record.offset += slice.length;
      const page: CommitLogPage = { commits: slice, done: record.offset >= record.filtered.length };
      return ok(page);
    }),
    closeReader: vi.fn((readerId: string) => {
      fileHistoryReaders.delete(readerId);
      return ok(undefined);
    }),
    getCommit: vi.fn((sha: string) => ok(active().allCommits.find((c) => c.sha === sha) ?? null)),
    getChangedFiles: vi.fn(() => ok([])),
    // specs/compare-commits.md FR-182
    getChangedFilesBetween: vi.fn((_baseSha: string, _targetSha: string) => ok(active().compareChangedFiles)),
    getWorkingDirStatus: vi.fn(() => ok(active().workingDirStatus)),
    getUpstreamBranch: vi.fn((_requestId?: string) => ok(active().upstreamShortName)),
    onRefsChanged: vi.fn(() => () => {}),
    // specs/live-refresh.md FR-458: tests drive it via the registered listener, like onRefsChanged.
    onWorktreeChanged: vi.fn(() => () => {}),
    // specs/edit-in-diff.md FR-535: tests grab the listener from `.mock.calls` to simulate main's close request.
    setEditDirty: vi.fn((_dirty: boolean) => ok(undefined)),
    onCloseRequested: vi.fn((_listener: () => void) => () => {}),
    confirmClose: vi.fn((_reply: string) => ok(undefined)),

    getWorkingDirectoryChanges: vi.fn((_requestId?: string) => {
      const { changesState } = active();
      return ok(changesState ? cloneChanges(changesState) : null);
    }),
    getUnstagedFileDiff: vi.fn(() => ok(active().fileDiff)),
    getStagedFileDiff: vi.fn(() => ok(active().fileDiff)),
    getUntrackedFileDiff: vi.fn(() => ok(active().fileDiff)),
    getCommitFileDiff: vi.fn(() => ok(active().fileDiff)),
    // specs/compare-commits.md FR-181
    getCommitRangeFileDiff: vi.fn(() => ok(active().fileDiff)),

    // specs/image-diff-preview.md FR-142/FR-144
    getUnstagedImageDiff: vi.fn(() => ok(active().imageDiff)),
    getStagedImageDiff: vi.fn(() => ok(active().imageDiff)),
    getUntrackedImageDiff: vi.fn(() => ok(active().imageDiff)),
    getCommitImageDiff: vi.fn(() => ok(active().imageDiff)),

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

    getDiscardFingerprint: vi.fn((_path: string, _kind: "tracked" | "untracked") => ok("fp-default")),
    discardTrackedFileChanges: vi.fn((path: string, _expectedFingerprint?: string) => {
      const record = active();
      if (record.changesState) {
        record.changesState = { ...record.changesState, unstaged: record.changesState.unstaged.filter((e) => e.path !== path) };
      }
      return ok(undefined);
    }),
    discardUntrackedFile: vi.fn((path: string, _expectedFingerprint?: string) => {
      const record = active();
      if (record.changesState) {
        record.changesState = { ...record.changesState, untracked: record.changesState.untracked.filter((e) => e.path !== path) };
      }
      return ok(undefined);
    }),

    // specs/hunk-line-staging.md FR-453: no-op by default; tests override per-case (they don't
    // simulate index state - see git-core's own partialStaging tests for that).
    // FR-479/FR-480/FR-478: the combined-diff trio; tests override per-case, like the selection mocks above.
    getCombinedFileDiff: vi.fn(
      () => ok(active().combinedFileDiff ?? ({ mode: "separate", reason: "no-changes" } as CombinedFileDiffResult)),
    ),
    toggleCombinedLines: vi.fn(() => ok(undefined)),
    discardCombinedLines: vi.fn(() => ok(undefined)),

    // specs/ignore-and-multiselect.md: emulate git-core's results over `changesState`; tests override per case via vi.mocked().
    planIgnore: vi.fn((req: { paths: string[]; scope: string; target: string }) => ok(mockIgnoreReport(req, false))),
    ignorePaths: vi.fn((req: { paths: string[]; scope: string; target: string }) => {
      const record = active();
      if (record.changesState) {
        const gone = new Set(req.paths.map((p) => p.replace(/\/$/, "")));
        record.changesState = { ...record.changesState, untracked: record.changesState.untracked.filter((e) => !gone.has(e.path)) };
      }
      return ok(mockIgnoreReport(req, true));
    }),
    ignoreAndStopTracking: vi.fn((req: { paths: string[]; scope: string; target: string }) => ok(mockIgnoreReport(req, true))),
    stagePaths: vi.fn((rows: { path: string; section: string }[]) => {
      const record = active();
      const changed: string[] = [];
      const skipped: { path: string; reason: string }[] = [];
      for (const r of rows) {
        if (!record.changesState || r.section === "conflicted" || r.section === "staged") {
          skipped.push({ path: r.path, reason: "Not an unstaged or untracked row." });
          continue;
        }
        const from = record.changesState.unstaged.some((e) => e.path === r.path) ? "unstaged" : "untracked";
        record.changesState = optimisticStage(record.changesState, r.path, from);
        changed.push(r.path);
      }
      return ok({ changed, unchanged: [], skipped });
    }),
    unstagePaths: vi.fn((rows: { path: string; section: string }[]) => {
      const record = active();
      const changed: string[] = [];
      const skipped: { path: string; reason: string }[] = [];
      for (const r of rows) {
        if (!record.changesState || r.section !== "staged") {
          skipped.push({ path: r.path, reason: "Not a staged row." });
          continue;
        }
        record.changesState = optimisticUnstage(record.changesState, r.path);
        changed.push(r.path);
      }
      return ok({ changed, unchanged: [], skipped });
    }),
    getBulkDiscardFingerprints: vi.fn((rows: BulkDiscardCandidate[]) =>
      ok(rows.map((r) => ({ path: r.path, section: r.section, expectedFingerprint: `fp:${r.path}` }))),
    ),
    bulkDiscard: vi.fn((rows: BulkDiscardRow[]) => {
      const record = active();
      const gone = new Set(rows.map((r) => r.path));
      if (record.changesState) {
        record.changesState = {
          ...record.changesState,
          unstaged: record.changesState.unstaged.filter((e) => !gone.has(e.path)),
          untracked: record.changesState.untracked.filter((e) => !gone.has(e.path)),
        };
      }
      return ok<BulkDiscardResult>({ status: "complete", discarded: rows.map((r) => r.path), skipped: [], failed: null, notAttempted: [], backups: [] });
    }),
    planDiscardAll: vi.fn(() => {
      const c = active().changesState;
      const tracked = (c?.unstaged ?? []).map((e) => ({
        path: e.path,
        section: c?.staged.some((s) => s.path === e.path) ? ("mixed" as const) : ("unstaged" as const),
        expectedFingerprint: `fp:${e.path}`,
      }));
      const untracked = (c?.untracked ?? [])
        .filter((e) => !e.path.endsWith("/"))
        .map((e) => ({ path: e.path, section: "untracked" as const, expectedFingerprint: `fp:${e.path}` }));
      const skipped = (c?.conflicted ?? []).map((e) => ({ path: e.path, reason: "Conflicted files cannot be discarded here." }));
      return ok({ tracked, untracked, skipped, counts: { trackedReset: tracked.length, untrackedDeleted: untracked.length } });
    }),
    getDiscardPreview: vi.fn((paths: string[]) =>
      ok(paths.map((p) => ({ path: p, status: "modified", added: 3, removed: 1, binary: false }))),
    ),
    discardAllChanges: vi.fn((rows: BulkDiscardRow[], includeUntracked: boolean) => {
      const kept = rows.filter((r) => includeUntracked || r.section !== "untracked");
      const record = active();
      const gone = new Set(kept.map((r) => r.path));
      if (record.changesState) {
        record.changesState = {
          ...record.changesState,
          unstaged: record.changesState.unstaged.filter((e) => !gone.has(e.path)),
          untracked: record.changesState.untracked.filter((e) => !gone.has(e.path)),
        };
      }
      return ok<BulkDiscardResult>({ status: "complete", discarded: kept.map((r) => r.path), skipped: [], failed: null, notAttempted: [], backups: [] });
    }),

    createCommit: vi.fn(() => {
      // A real commit clears the index — every staged file is now part of history.
      const record = active();
      if (record.changesState) record.changesState = { ...record.changesState, staged: [] };
      return ok<CreateCommitResult>({ sha: "newcommitsha" });
    }),
    // specs/amend-last-commit.md FR-148/FR-154: like `createCommit`, folds whatever is currently
    // staged into the (amended) commit and clears the index; a distinct resulting SHA (never
    // `"newcommitsha"`) so tests can tell a real amend happened rather than a plain commit.
    amendCommit: vi.fn(() => {
      const record = active();
      if (record.changesState) record.changesState = { ...record.changesState, staged: [] };
      return ok<CreateCommitResult>({ sha: "amendedcommitsha" });
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
    // specs/branch-panel-drag-merge.md FR-430: default mock reports nothing to guard; tests that
    // need the orphan dialog override this with mockResolvedValue.
    getOrphanedHeadCommits: vi.fn(() =>
      ok<OrphanedHeadResult>({ status: "none", reason: "attached", headSha: null, total: 0, totalIsCapped: false, shown: [] }),
    ),
    createBranchAtCommit: vi.fn((name: string, sha: string) =>
      ok<CreateBranchResult>({ name, fullName: `refs/heads/${name}`, sha, switched: false }),
    ),
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
    readConflictSides: vi.fn((_filePath: string) => ok(active().conflictSides)),
    isConflictFileUntouched: vi.fn((_filePath: string) => ok(active().conflictFileUntouched)),
    acceptConflictSide: vi.fn((filePath: string, _side?: "ours" | "theirs", _confirmedOverwrite?: boolean) => {
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
    // specs/edit-in-diff.md FR-468/FR-471: defaults are an eligible empty file; tests override per call with mockResolvedValueOnce.
    probeEditableFile: vi.fn((_path: string) =>
      Promise.resolve({ ok: true as const, data: { eligible: true as const, hasStagedContent: false, isNew: false, isUntracked: false, conflicted: false, size: 0, mtimeMs: 0, mode: 0o644 } }),
    ),
    readEditableFile: vi.fn((_path: string) =>
      Promise.resolve({
        ok: true as const,
        data: {
          eligible: true as const, hasStagedContent: false, isNew: false, isUntracked: false, conflicted: false, size: 0, mtimeMs: 0, mode: 0o644,
          content: "", eol: "lf" as const, hasBom: false, finalNewline: false, contentHash: "0".repeat(64),
        },
      }),
    ),
    writeEditedFile: vi.fn((_path: string, _content: string, _options: unknown) =>
      Promise.resolve({ ok: true as const, data: { status: "written" as const, contentHash: "1".repeat(64), mtimeMs: 1, size: 0 } }),
    ),
    // specs/edit-recovery-draft.md FR-554: default to "no drafts"; tests override per case.
    writeDraft: vi.fn((_repo: string, _path: string, _draft: unknown) =>
      Promise.resolve({ ok: true as const, data: { status: "saved" as const, savedAt: 1 } }),
    ),
    readDraft: vi.fn((_repo: string, _path: string) => Promise.resolve({ ok: true as const, data: null })),
    deleteDraft: vi.fn((_repo: string, _path: string) => Promise.resolve({ ok: true as const, data: undefined })),
    listDrafts: vi.fn((_repo: string) => Promise.resolve({ ok: true as const, data: [] })),
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
    listStashes: vi.fn((_requestId?: string) => {
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

    // specs/blame.md, FR-123 through FR-130.
    getFileBlame: vi.fn((_path: string, _revision: string | null) => ok(active().blameResult)),
    createFileHistoryReader: vi.fn((_revision: string, _path: string) => {
      const id = `file-history-reader-${++fileHistorySeq}`;
      fileHistoryReaders.set(id, { commits: active().fileHistoryCommits, offset: 0 });
      return ok(id);
    }),

    // specs/drag-commit-menu.md, FR-295 through FR-319.
    computeCommitPairRelationship: vi.fn((_shaA: string, _shaB: string) => ok(active().commitPairRelationship)),
    mergeCommit: vi.fn((_otherSha: string) => ok(undefined)),
    rebaseCommitOnto: vi.fn((_newBaseSha: string) => ok(undefined)),

    // specs/online-sync-fetch.md, FR-320 through FR-328. Default behavior mirrors
    // `openRepoCancellable`'s own doc comment convention above: an immediate, never-cancelled
    // "settled" outcome carrying `fetchOutcomes` verbatim — a test exercising the actual cancel
    // race, a live progress stream, or a genuine top-level transport failure overrides these
    // per-call via `vi.mocked(api.fetchAllRemotes).mockImplementationOnce(...)`/
    // `vi.mocked(api.onFetchProgress).mockImplementation(...)`, same convention as every other
    // per-test override in this file.
    fetchAllRemotes: vi.fn(async (_requestId: string) => ({
      outcome: "settled" as const,
      result: { ok: true as const, data: { outcomes: active().fetchOutcomes } },
    })),
    cancelFetch: vi.fn(async (_requestId: string) => {}),
    onFetchProgress: vi.fn(() => () => {}),

    // specs/online-sync-pull.md, FR-338 through FR-343. Default behavior mirrors
    // `mergeCommit`/`rebaseCommitOnto`'s own convention above (an immediate, always-succeeding
    // no-op) rather than `fetchAllRemotes`'s per-repo-record seed — a test exercising a specific
    // outcome (fast-forward, integrated, a conflict pause, a genuine `NoUpstreamConfiguredError`
    // refusal) overrides this per-call via `vi.mocked(api.pull).mockResolvedValueOnce(...)` /
    // `mockRejectedValueOnce(...)`, same convention as every other per-test override in this file.
    // Defaults to `{ kind: "up-to-date" }` — the least surprising outcome for a test that doesn't
    // care what Pull actually did.
    pull: vi.fn(async (_requestId: string, _options?: { strategy?: PullStrategy }) => ({
      outcome: "settled" as const,
      result: { ok: true as const, data: { kind: "up-to-date" as const } },
    })),
    cancelPull: vi.fn(async (_requestId: string) => {}),
    onPullProgress: vi.fn(() => () => {}),

    // specs/online-sync-push.md, FR-344 through FR-350. Default behavior mirrors `pull`'s own
    // convention above (an immediate, never-cancelled "settled" success) — a test exercising a
    // non-fast-forward rejection, a genuine transport failure, a cancel race, or a live progress
    // stream overrides these per-call via `vi.mocked(api.push).mockResolvedValueOnce(...)` /
    // `mockRejectedValueOnce(...)` / `vi.mocked(api.onPushProgress).mockImplementation(...)`, same
    // convention as every other per-test override in this file. Defaults to a `"pushed"` outcome
    // (not `"set-upstream"`) — the least surprising default for a test that doesn't care which path
    // `push()` actually took.
    listConfiguredRemotes: vi.fn(() => ok(active().remotesState)),
    push: vi.fn(async (_requestId: string, remoteName: string, localBranchName: string) => ({
      outcome: "settled" as const,
      result: {
        ok: true as const,
        data: {
          kind: "pushed" as const,
          remoteName,
          localBranch: localBranchName,
          remoteBranch: localBranchName,
          sha: active().headShaState ?? "0000000000000000000000000000000000000000",
        },
      },
    })),
    cancelPush: vi.fn(async (_requestId: string) => {}),
    onPushProgress: vi.fn(() => () => {}),

    // specs/online-sync-clone.md, FR-351 through FR-358. Default behavior mirrors `push`'s own
    // convention above (an immediate, never-cancelled "settled" success) — a test exercising a
    // destination-not-empty refusal, a credential failure, a cancel race, or a live progress
    // stream overrides these per-call via `vi.mocked(api.clone).mockResolvedValueOnce(...)` /
    // `mockRejectedValueOnce(...)` / `vi.mocked(api.onCloneProgress).mockImplementation(...)`, same
    // convention as every other per-test override in this file. `destination` is echoed back
    // verbatim as `result.data.path` — the least surprising default for a test that doesn't care
    // about relative-vs-resolved-path normalization.
    clone: vi.fn(async (_requestId: string, _url: string, destination: string) => ({
      outcome: "settled" as const,
      result: { ok: true as const, data: { path: destination } },
    })),
    cancelClone: vi.fn(async (_requestId: string) => {}),
    onCloneProgress: vi.fn(() => () => {}),

    // specs/reset-to-here.md, FR-359 through FR-377.
    resetCurrentBranch: vi.fn((targetSha: string, _mode: ResetMode) => {
      const record = active();
      // Mirrors `switchToCommit`'s own `headShaState`/`repoState.headSha` update — a real `git
      // reset` moves HEAD (and, when attached, the current branch ref implicitly follows it)
      // directly to `targetSha`, with no separate branch-name change to model (unlike
      // `switchBranch`, this never changes WHICH branch is checked out, only where it points).
      record.headShaState = targetSha;
      record.repoState = { ...record.repoState, headSha: targetSha };
      return ok(undefined);
    }),
    countCommitsExclusiveToHead: vi.fn((_targetSha: string, _headSha: string) => ok(active().resetImpactCount)),

    // specs/git-identity-profiles.md, FR-329 through FR-337. Like the real `getIdentityConfigState`
    // (see identityProfile.ts's module doc comment), a key only reports `managedByGitHydra: true`
    // when the caller passes a non-null `knownApplication` (the security-reviewer-mandated trust
    // source) -- the per-record `managedByGitHydra` flag below is only the "GitHydra wrote this"
    // ground truth. This makes a caller that fetches with a stale/null `knownApplication` visible
    // in jsdom (found via the post-apply `reload()` stale-closure bug). It does not compare values
    // against `knownApplication`; that finer check is git-core's own, covered by its own tests.
    getIdentityConfigState: vi.fn((knownApplication: unknown) => {
      const s = active().identityConfigState;
      // Only state written through this mock's own `applyIdentityProfile` is subject to the trust
      // check; state seeded directly via the `identityConfigState` option keeps reporting its seeded
      // `managedByGitHydra` as-is (many older tests seed that without a matching app-storage record).
      const trusted = knownApplication != null || !active().identityAppliedViaApi;
      return ok<IdentityConfigState>({
        userName: { ...s.userName, managedByGitHydra: trusted && s.userName.managedByGitHydra },
        userEmail: { ...s.userEmail, managedByGitHydra: trusted && s.userEmail.managedByGitHydra },
        sshCommand: { ...s.sshCommand, managedByGitHydra: trusted && s.sshCommand.managedByGitHydra },
      });
    }),
    applyIdentityProfile: vi.fn((options: ApplyIdentityProfileOptions) => {
      const record = active();
      const state = record.identityConfigState;
      const settingSsh = options.sshIdentityFilePath != null;

      // Mirrors `applyIdentityProfile`'s own FR-334 conflict computation (git-core's
      // `identityProfile.ts`) closely enough for this mock's callers to exercise the confirm-then-
      // force flow without a real repo: any of user.name/user.email always considered, plus
      // core.sshCommand only when this call would actually write it.
      const conflicts: IdentityConfigConflictEntry[] = [];
      if (state.userName.localValue !== null && !state.userName.managedByGitHydra) {
        conflicts.push({ key: "user.name", currentValue: state.userName.localValue });
      }
      if (state.userEmail.localValue !== null && !state.userEmail.managedByGitHydra) {
        conflicts.push({ key: "user.email", currentValue: state.userEmail.localValue });
      }
      if (settingSsh && state.sshCommand.localValue !== null && !state.sshCommand.managedByGitHydra) {
        conflicts.push({ key: "core.sshCommand", currentValue: state.sshCommand.localValue });
      }
      if (conflicts.length > 0 && !options.force) {
        return Promise.resolve({
          ok: false as const,
          error: {
            name: "UnmanagedIdentityConfigConflictError",
            message:
              `Applying this profile would overwrite ${conflicts.length === 1 ? "a value" : "values"} already ` +
              `configured locally that GitHydra did not itself set: ` +
              conflicts.map((c) => `${c.key}=${JSON.stringify(c.currentValue)}`).join(", ") +
              `. Confirm to overwrite.`,
          },
        });
      }

      record.identityAppliedViaApi = true;
      record.identityConfigState = {
        userName: { localValue: options.userName, globalValue: state.userName.globalValue, managedByGitHydra: true },
        userEmail: { localValue: options.userEmail, globalValue: state.userEmail.globalValue, managedByGitHydra: true },
        sshCommand: settingSsh
          ? {
              localValue: `ssh -i '${options.sshIdentityFilePath}' -o IdentitiesOnly=yes`,
              globalValue: state.sshCommand.globalValue,
              managedByGitHydra: true,
            }
          : state.sshCommand.managedByGitHydra
            // See identityProfile.ts's own doc comment: applying a profile with no SSH key clears a
            // previously-applied, GitHydra-managed core.sshCommand rather than leaving it in place.
            ? { localValue: null, globalValue: state.sshCommand.globalValue, managedByGitHydra: false }
            : state.sshCommand,
      };
      return ok(undefined);
    }),
    removeIdentityProfileApplication: vi.fn((_knownApplication: unknown) => {
      const record = active();
      const state = record.identityConfigState;
      const removedKeys: Array<"user.name" | "user.email" | "core.sshCommand"> = [];
      const next = { ...state };
      if (state.userName.managedByGitHydra) {
        removedKeys.push("user.name");
        next.userName = { localValue: null, globalValue: state.userName.globalValue, managedByGitHydra: false };
      }
      if (state.userEmail.managedByGitHydra) {
        removedKeys.push("user.email");
        next.userEmail = { localValue: null, globalValue: state.userEmail.globalValue, managedByGitHydra: false };
      }
      if (state.sshCommand.managedByGitHydra) {
        removedKeys.push("core.sshCommand");
        next.sshCommand = { localValue: null, globalValue: state.sshCommand.globalValue, managedByGitHydra: false };
      }
      record.identityConfigState = next;
      return ok<RemoveIdentityProfileResult>({ removedKeys });
    }),
    // FR-332: a fixed, plausible-looking path — this mock never opens a real OS dialog. A test
    // exercising "user cancelled" overrides this per-call via
    // `vi.mocked(api.pickSshIdentityFile).mockResolvedValueOnce({ ok: true, data: null })`.
    pickSshIdentityFile: vi.fn(() => ok<string | null>("/home/mock-user/.ssh/id_ed25519")),
  };
  return api;
}
