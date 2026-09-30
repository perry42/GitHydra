// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ChangedFile,
  CommitInfo,
  CommitLogFilter,
  InProgressOperation,
  RefInfo,
  RepositoryState,
  StashInfo,
  WorkingDirectoryChanges,
} from "@githydra/git-core";
import type { OpenRepoOutcome, WorkingDirectoryStatus } from "../../shared/ipcContract";
import { LaneAssigner, type LaidOutRow } from "../lib/laneAssignment";
import { computeVisibleRefNames } from "../lib/refFiltering";
import { redecorateRows } from "../lib/refDecoration";
import { deriveWorkingDirStatus } from "../lib/workingDirStatus";
import { GitHydraIpcError, getGitHydraApi, unwrap, withGitLockRetry } from "./gitHydraClient";
import type { GitHydraApi } from "../../shared/ipcContract";
import {
  hasUnexpectedRefChange,
  hasUnexpectedRefChangeBeyondCurrentBranch,
  noChangeExpected,
  type ExpectedRefOutcome,
  type RefHeadSnapshot,
} from "./selfWriteGate";

export const PAGE_SIZE = 150;
/** How many of the most-recently-loaded commits count as "near HEAD" for FR-15's tag heuristic. */
const NEAR_HEAD_WINDOW = 300;

/**
 * Every read in this module's concurrent groups goes through `withGitLockRetry`: Windows can
 * transiently collide on `.git/index` when several git spawns land within ms of each other (see
 * `isTransientGitLockError` in gitHydraClient.ts). An unretried failure makes `unwrap()` throw in a
 * fire-and-forget caller and leaves all the state being refreshed stuck at its stale value.
 * `workingDirStatus` is derived from the single per-file fetch here (`deriveWorkingDirStatus`) so
 * `useChangesPanel` needn't spawn a second concurrent git call for the same data.
 */
function getStateWithRetry(api: GitHydraApi) {
  return withGitLockRetry(() => api.getState());
}
/**
 * specs/repo-open-feedback-fixes.md FR-197: `requestId` (only passed by `refreshAuxData` for an
 * in-flight cancellable open) makes the read abortable for that attempt.
 */
function getRefsWithRetry(api: GitHydraApi, requestId?: string) {
  return withGitLockRetry(() => api.getRefs(requestId));
}
function getUpstreamBranchWithRetry(api: GitHydraApi, requestId?: string) {
  return withGitLockRetry(() => api.getUpstreamBranch(requestId));
}
function getWorkingDirectoryChangesWithRetry(api: GitHydraApi, requestId?: string) {
  return withGitLockRetry(() => api.getWorkingDirectoryChanges(requestId));
}
function listStashesWithRetry(api: GitHydraApi, requestId?: string) {
  return withGitLockRetry(() => api.listStashes(requestId));
}

/** True when a CommitLogFilter has no active restriction (the unfiltered/"baseline" view). */
function isEmptyFilter(filter: CommitLogFilter): boolean {
  return Object.values(filter).every((v) => (Array.isArray(v) ? v.length === 0 : !v));
}

/** specs/refresh-without-teardown.md AC6: the sha a `CommitDetailState` is about; `null` only for "idle". */
function commitDetailSha(state: CommitDetailState): string | null {
  switch (state.status) {
    case "idle":
      return null;
    case "ready":
      return state.commit.sha;
    default:
      return state.sha;
  }
}

/**
 * specs/stash.md FR-92/AC18: order-sensitive fingerprint of `listStashes()`; `null` (bare repo) has
 * its own sentinel so it never equals "zero stashes".
 */
function stashSignature(list: readonly { ref: string; sha: string }[] | null): string {
  if (list === null) return "\0bare";
  return list.map((s) => `${s.ref}:${s.sha}`).join(",");
}

/**
 * specs/instant-tab-revisit.md FR-241/AC4: shared by `evaluateWatcherEvent` and `reactivateTab` so
 * "the operation changed" has one definition.
 */
function operationIdentityChanged(prev: RepositoryState, next: RepositoryState): boolean {
  return (
    prev.inProgressOperation !== next.inProgressOperation ||
    JSON.stringify(prev.inProgressOperationDetail) !== JSON.stringify(next.inProgressOperationDetail)
  );
}

/**
 * specs/instant-tab-revisit.md FR-239/FR-240: in-memory per-tab snapshot (never persisted) produced by
 * `captureTabCache()` (or `null` if ineligible) and consumed by `reactivateTab()`.
 */
export interface TabGraphCache {
  /**
   * FR-240: live rows/hasMore/lane state, capped at `PAGE_SIZE` rows by `captureTabCache()`.
   */
  rows: LaidOutRow[];
  hasMore: boolean;
  laneAssigner: LaneAssigner;
  /**
   * FR-240: parked unfiltered baseline (AC-10) if the tab was filtered; `null` otherwise. Also capped.
   */
  baseline: { rows: LaidOutRow[]; hasMore: boolean; laneAssigner: LaneAssigner } | null;
  /**
   * Kept on the cache so a hit is self-contained rather than relying on `RepoTabRemembered.filter`.
   */
  filter: CommitLogFilter;
  refs: RefInfo[];
  repoState: RepositoryState;
  workingDirChanges: WorkingDirectoryChanges | null;
  stashCount: number | null;
  upstreamShortName: string | null;
  /**
   * FR-241: last-confirmed ref/HEAD snapshot, diffed on reactivation with the functions the live watcher
   * uses (`selfWriteGate.ts`). Never null: no cache is produced before the first confirmed read.
   */
  lastConfirmed: RefHeadSnapshot;
  lastConfirmedStashSig: string | null;
  /**
   * FR-240: ready detail of the selected commit, applied on reactivation only if its sha still matches
   * the remembered selection.
   */
  commitDetail: { status: "ready"; commit: CommitInfo; files: ChangedFile[] } | null;
}

/**
 * AC-10: the unfiltered view's reader + rows/lane state, parked (not closed) while a filter is active so
 * `clearFilter` can restore it instantly.
 * specs/instant-tab-revisit.md FR-242/FR-245: `readerId` is `null` when restored from a `TabGraphCache` —
 * a cached id would name a reader `RepoSession.commitOpen()` already closed; `loadMoreInternal` lazily
 * creates one.
 */
interface BaselineSnapshot {
  readerId: string | null;
  rows: LaidOutRow[];
  hasMore: boolean;
  laneAssigner: LaneAssigner;
}

/**
 * specs/repo-open-feedback.md FR-168 / repo-open-feedback-fixes.md FR-199: everything `openRepo` may
 * overwrite before it settles (synchronous resets plus aux-data/reader writes), captured so a
 * cancellation in any phase restores the previous view exactly (see `restoreFromCancellation`).
 */
interface OpenAttemptSnapshot {
  status: RepoOpenStatus;
  errorMessage: string | null;
  selectedSha: string | null;
  commitDetail: CommitDetailState;
  hasExternalChanges: boolean;
  operationStateAlert: OperationStateAlert | null;
  filter: CommitLogFilter;
  stashCount: number | null;
  pendingMutations: Array<{ pre: RefHeadSnapshot | null }>;
  lastConfirmed: RefHeadSnapshot | null;
  confirmedGeneration: number;
  lastConfirmedStashSig: string | null;
  /** FR-199: identity/aux-data fields `refreshAuxData` may have committed before a cancellation. */
  repoPath: string | null;
  repoState: RepositoryState | null;
  refs: RefInfo[];
  upstreamShortName: string | null;
  workingDirChanges: WorkingDirectoryChanges | null;
  /**
   * FR-199: previous reader/row/lane state, restored verbatim; the old reader isn't closed until a successful commit.
   */
  rows: LaidOutRow[];
  hasMore: boolean;
  readerId: string | null;
  baseline: BaselineSnapshot | null;
  laneAssigner: LaneAssigner;
}

/**
 * specs/repo-open-feedback-fixes.md FR-197: detects a cancelled IPC call via the structured `.name`,
 * never the message string (FR-165).
 */
function isCancelledError(err: unknown): boolean {
  return err instanceof GitHydraIpcError && err.name === "OperationCancelledError";
}

export type GraphDisplayRow =
  | {
      kind: "uncommitted";
      lane: number;
      colorSlot: number;
      status: WorkingDirectoryStatus;
      /**
       * True only when HEAD's commit is the very next loaded row, so the canvas draws a connector, not a stub.
       */
      connectsDown: boolean;
    }
  | { kind: "commit"; laid: LaidOutRow };

export type CommitDetailState =
  | { status: "idle" }
  | { status: "loading"; sha: string }
  | { status: "ready"; commit: CommitInfo; files: ChangedFile[] }
  | { status: "error"; sha: string; message: string };

export type RepoOpenStatus = "idle" | "opening" | "ready" | "error";

/**
 * specs/graph-head-indicator-and-refresh-alerting.md Problem 2: set when the watcher sees an
 * externally-caused in-progress-operation change; carries the operation so the banner can name it.
 */
export interface OperationStateAlert {
  /**
   * The newly-detected operation, else the one that just ended externally; at least one is always non-null.
   */
  operation: Exclude<InProgressOperation, null>;
}

export interface UseRepositoryGraphResult {
  /**
   * The shared `window.gitHydra` bridge, so panels and component tests use one instance.
   */
  api: GitHydraApi;
  status: RepoOpenStatus;
  errorMessage: string | null;
  repoPath: string | null;
  repoState: RepositoryState | null;
  refs: RefInfo[];
  visibleRefNames: Set<string>;
  showAllRefs: boolean;
  setShowAllRefs: (value: boolean) => void;
  displayRows: GraphDisplayRow[];
  maxLaneIndexSeen: number;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => void;
  filter: CommitLogFilter;
  applyFilter: (filter: CommitLogFilter) => void;
  clearFilter: () => void;
  workingDirStatus: WorkingDirectoryStatus | null;
  /**
   * Per-file working-dir data: the single fetch `workingDirStatus` is derived from and `useChangesPanel` consumes; `null` for a bare repo.
   */
  workingDirChanges: WorkingDirectoryChanges | null;
  /** specs/stash.md FR-93: live count for the Toolbar's stash badge. `null` for a bare repo. */
  stashCount: number | null;
  selectedSha: string | null;
  selectCommit: (sha: string | null) => void;
  /**
   * specs/graph-head-indicator-and-refresh-alerting.md Addendum 3: like `selectCommit` but never bumps
   * `followSignal` (for `useRepoTabs.ts` tab/relaunch selection replay).
   */
  restoreSelection: (sha: string | null) => void;
  /**
   * Addendum 3: monotonic counter bumped only by `selectCommit`; CommitGraph's auto-follow keys off it,
   * not `selectedSha`, so replays never scroll.
   */
  followSignal: number;
  commitDetail: CommitDetailState;
  hasExternalChanges: boolean;
  /**
   * specs/graph-head-indicator-and-refresh-alerting.md Problem 2: non-null while an external
   * operation-state change is unacknowledged; gates conflict actions until `refresh()` clears it.
   */
  operationStateAlert: OperationStateAlert | null;
  /**
   * `initialFilter` (specs/multi-repo-tabs.md Must-have 4): open straight into a remembered filter in
   * one reader creation.
   * Resolves `true` only if this attempt was canceled via `cancelOpen()` (specs/repo-open-feedback.md
   * FR-168), `false` for success/error/supersession, so callers can roll back their own optimistic
   * bookkeeping.
   * `onSettled` (specs/repo-list.md AC6): per-call "opened"/"error" hook for callers that can't poll
   * `status`; on "opened" it also gets git's resolved toplevel path (specs/repo-open-feedback-fixes.md
   * FR-203), `undefined` for "error".
   */
  openRepo: (
    path: string,
    initialFilter?: CommitLogFilter,
    onSettled?: (outcome: "opened" | "error", resolvedPath?: string) => void,
  ) => Promise<boolean>;
  openRepoViaDialog: () => Promise<void>;
  /**
   * specs/repo-open-feedback.md FR-167/FR-168: aborts the in-flight `openRepo` attempt; no-op if none.
   */
  cancelOpen: () => void;
  refresh: () => Promise<void>;
  /**
   * specs/multi-repo-tabs.md Must-have 8/AC9: tears down the reader and resets all state to "idle".
   * Also closes the main-process session (readers, ref watcher, `Repository`) so the watcher doesn't
   * keep firing with no UI (security review).
   */
  closeRepo: () => Promise<void>;
  /**
   * specs/refresh-without-teardown.md: true only during a manual `refresh()`; use this, not `status`
   * (which refresh never touches), for busy UI.
   */
  isRefreshing: boolean;
  /**
   * FR-30/FR-32: cheap re-fetch of working-dir data for the pseudo-node counts and Changes badge, without re-querying the log.
   */
  refreshWorkingDirStatus: () => Promise<void>;
  /**
   * Same as `refreshWorkingDirStatus` but never rejects, so it is safe fire-and-forget (CLAUDE.md "Known pitfalls").
   */
  refreshWorkingDirStatusInBackground: () => Promise<void>;
  /** specs/stash.md FR-93/FR-101: cheap re-fetch of just the stash count (Toolbar badge), and the
   * watcher's own external-change baseline for it — call after any successful stash mutation. */
  refreshStashList: () => Promise<void>;
  /**
   * FR-56: cheap re-fetch of repo state + refs + upstream after a branch create/switch/delete; does NOT
   * reset loaded rows/scroll/lanes like `refresh()`.
   * `expected` (specs/self-write-refresh-suppression.md AC5): the operation's known outcome, compared
   * against the pre-to-post ref/HEAD diff when closing a `beginMutation` gate; an exact match is folded
   * in silently, anything else sets `hasExternalChanges`. Omit for no-gate or failed-mutation callers
   * ("nothing should have changed").
   * Never rejects: every production caller is fire-and-forget, so a stale-generation failure is a silent
   * no-op and a genuine one logs (CLAUDE.md "Known pitfalls"; see `refreshRefsAndRowsInBackground`).
   */
  refreshRefs: (expected?: ExpectedRefOutcome) => Promise<void>;
  /**
  /**
   * specs/cherry-pick.md FR-121 / self-write-refresh-suppression.md FR-6b: settle path for an
   * app-initiated operation that closes a `beginMutation()` gate (FIFO) and reloads the commit rows in
   * place (cherry-pick steps / Continue can create commits).
   * With `expected` omitted it diffs via `hasUnexpectedRefChangeBeyondCurrentBranch`, not
   * `noChangeExpected`: these callers always move HEAD/refs on success, and skipping the diff was an AC5
   * false negative.
   * Never goes through `openRepo()`, so `status`/`openSequence` are untouched and keyed panels don't
   * remount; pagination does reset to page one.
   * `opts.closesGate` (default `true`): `refresh()` passes `false` — a manual refresh can run any time,
   * so it must not `shift()` a FIFO entry a real gated mutation still needs.
   */
  refreshRefsAndRows: (expected?: ExpectedRefOutcome, opts?: { closesGate?: boolean }) => Promise<void>;
  /**
   * Same as `refreshRefsAndRows` but never rejects, for fire-and-forget callers (CLAUDE.md "Known
   * pitfalls"); `refreshRefsAndRows` keeps its throw because `refresh()` depends on it.
   */
  refreshRefsAndRowsInBackground: (
    expected?: ExpectedRefOutcome,
    opts?: { closesGate?: boolean },
  ) => Promise<void>;
  /**
   * specs/multi-repo-tabs.md: bumped on every `openRepo`/`closeRepo` (even a same-path reopen, AC10),
   * never on filter changes. Key per-repo panels (ChangesPanel/DetailPanel/BranchesPanel) on this, not
   * `repoPath`, so React batching can't leave them showing the previous repo's data.
   */
  openSequence: number;
  /**
   * Synchronous repo-identity epoch (bumped on openRepo/reactivateTab/closeRepo, not filter changes).
   * Capture before a slow await and compare after to detect a closed/replaced repo (e.g. drag merge/rebase).
   */
  getOpenSequence: () => number;
  /**
   * specs/self-write-refresh-suppression.md FR-6b: call synchronously when an app-initiated mutating git
   * call is issued; queues the pre-mutation baseline (FIFO) for its eventual `refreshRefs()` to diff
   * against (AC5). Watcher events are ignored while the gate is open. Every call must be followed by a
   * `refreshRefs()` or the gate never closes.
   */
  beginMutation: () => void;
  /** specs/instant-tab-revisit.md FR-239/FR-240: see `TabGraphCache`; called wherever `useRepoTabs.ts` calls `snapshotActiveTab()`. */
  captureTabCache: () => TabGraphCache | null;
  /** FR-241/FR-242/FR-243: used by `useRepoTabs.ts` instead of `openRepo()` when reactivating an open tab. */
  reactivateTab: (
    path: string,
    target: { filter: CommitLogFilter; selectedSha: string | null },
    cache: TabGraphCache | null,
    onSettled?: (outcome: "opened" | "error", resolvedPath?: string) => void,
  ) => Promise<{ cancelled: boolean; selectionRestored: boolean }>;
}

export interface UseRepositoryGraphOptions {
  /**
   * specs/repo-list.md Must-have 1: called once after `status` becomes "ready" for a successful open
   * (not cancelled, errored, or superseded).
   * specs/repo-open-feedback-fixes.md FR-202/FR-203/FR-204: `path` is git's resolved repo root;
   * `pickedPath` is the caller's original path (equal when they don't diverge).
   */
  onRepoOpened?: (path: string, pickedPath: string) => void;
}

export function useRepositoryGraph(options: UseRepositoryGraphOptions = {}): UseRepositoryGraphResult {
  const { onRepoOpened } = options;
  const api = useMemo(() => getGitHydraApi(), []);

  const [status, setStatus] = useState<RepoOpenStatus>("idle");
  const [openSequence, setOpenSequence] = useState(0);
  // Synchronous repo-identity epoch, bumped beside every `generationRef` bump that swaps/closes the repo
  // (not filter changes); unlike `openSequence` state it never lags a render.
  const repoEpochRef = useRef(0);
  const getOpenSequence = useCallback(() => repoEpochRef.current, []);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [repoPath, setRepoPath] = useState<string | null>(null);
  const [repoState, setRepoState] = useState<RepositoryState | null>(null);
  const [refs, setRefs] = useState<RefInfo[]>([]);
  const [upstreamShortName, setUpstreamShortName] = useState<string | null>(null);
  // Single fetched source for working-dir status; `workingDirStatus` is derived so the two can't drift.
  const [workingDirChanges, setWorkingDirChanges] = useState<WorkingDirectoryChanges | null>(null);
  const workingDirStatus = useMemo(() => deriveWorkingDirStatus(workingDirChanges), [workingDirChanges]);
  // specs/stash.md FR-93: Toolbar stash badge count; `null` for a bare repo.
  const [stashCount, setStashCount] = useState<number | null>(null);
  const [rows, setRows] = useState<LaidOutRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [filter, setFilter] = useState<CommitLogFilter>({});
  const [showAllRefs, setShowAllRefs] = useState(false);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  // specs/graph-head-indicator-and-refresh-alerting.md Addendum 3: bumped only by `selectCommit()`, not
  // by `restoreSelection()` or this hook's internal resets, so CommitGraph's auto-follow never scrolls
  // on tab/relaunch replay.
  const [followSignal, setFollowSignal] = useState(0);
  const [commitDetail, setCommitDetail] = useState<CommitDetailState>({ status: "idle" });
  const [hasExternalChanges, setHasExternalChanges] = useState(false);
  // Problem 2: see `OperationStateAlert`; cleared by `refresh()`.
  const [operationStateAlert, setOperationStateAlert] = useState<OperationStateAlert | null>(null);
  // specs/refresh-without-teardown.md: true only during a manual `refresh()`, which never touches `status`.
  const [isRefreshing, setIsRefreshing] = useState(false);

  const readerIdRef = useRef<string | null>(null);
  const laneAssignerRef = useRef(new LaneAssigner());
  /**
   * Synchronous mirror of rows/hasMore so startReader/clearFilter can snapshot them without state deps.
   */
  const rowsRef = useRef<LaidOutRow[]>([]);
  const hasMoreRef = useRef(false);
  /** AC-10: parked unfiltered baseline while a filtered view is live; null otherwise. */
  const baselineRef = useRef<BaselineSnapshot | null>(null);
  /** Bumped on every open/filter change so stale async responses are dropped. */
  const generationRef = useRef(0);
  /**
   * specs/repo-open-feedback.md FR-167/FR-168/FR-198: requestId (stringified generation) of the in-flight
   * open, set on start and cleared only when it settles; `cancelOpen` reads it.
   */
  const activeOpenRequestIdRef = useRef<string | null>(null);
  /** Commit-detail selection races (rapid A -> B clicks), independent of `generationRef`. */
  const selectionGenerationRef = useRef(0);
  // specs/self-write-refresh-suppression.md FR-6a/FR-6b state; diff logic lives in selfWriteGate.ts.
  /**
   * FR-6a: snapshot from the last read GitHydra trusted (own reads and watcher comparisons); null before
   * the first open read. Watcher comparisons use this, never React state.
   */
  const lastConfirmedRef = useRef<RefHeadSnapshot | null>(null);
  /**
   * Bumped on every `lastConfirmedRef` write. `evaluateWatcherEvent` captures it before its fetch and
   * discards the result if it moved: a full mutation cycle can start and finish within the fetch, so the
   * gate-empty re-check alone would accept a stale read (AC5 security review).
   */
  const confirmedGenerationRef = useRef(0);
  /**
   * FR-6b/AC5: one pre-mutation baseline per in-flight app mutation (see `beginMutation`); FIFO, relying
   * on the UI's row-level busy state to serialize in issue order.
   */
  const pendingMutationsRef = useRef<Array<{ pre: RefHeadSnapshot | null }>>([]);
  /**
   * specs/stash.md FR-92/AC18: `refs/stash` is excluded from `RefInfo`, so stash changes never show in
   * the ref/HEAD diff; this parallel baseline (`stashSignature`) is set by every confirmed read and
   * diffed like idle ref churn. `null` before the first confirmed read.
   */
  const lastConfirmedStashSigRef = useRef<string | null>(null);
  /**
   * specs/instant-tab-revisit.md FR-245: mirrors `filter` (via effect) so `loadMoreInternal`, memoized on
   * `[api]`, reads the current value without a dependency.
   */
  const filterRef = useRef<CommitLogFilter>({});
  /**
   * FR-245 security-review fix: mirrors `hasExternalChanges`/`operationStateAlert` like `filterRef`
   * (`loadMoreInternal` is memoized on `[api]`, so it would otherwise read stale values). Only a cheap
   * best-effort early-out; the `lastConfirmedRef` re-check in `loadMoreInternal` closes the gap.
   */
  const hasExternalChangesRef = useRef(false);
  const operationStateAlertRef = useRef<OperationStateAlert | null>(null);
  /**
   * FR-245 security-review fix: ref-bridge to the latest `refreshRefsAndRows`; `loadMoreInternal` can't
   * depend on it directly (`refreshRefsAndRows` -> `startReader` -> `loadMoreInternal` is circular).
   * Kept current by the effect after `refreshRefsAndRows`.
   */
  const refreshRefsAndRowsRef = useRef<
    ((expected?: ExpectedRefOutcome, opts?: { closesGate?: boolean }) => Promise<void>) | null
  >(null);

  const closeCurrentReader = useCallback(async () => {
    const toClose = new Set<string>();
    if (readerIdRef.current) toClose.add(readerIdRef.current);
    if (baselineRef.current?.readerId) toClose.add(baselineRef.current.readerId);
    readerIdRef.current = null;
    baselineRef.current = null;
    await Promise.all([...toClose].map((id) => api.closeReader(id).catch(() => {})));
  }, [api]);

  const loadMoreInternal = useCallback(
    async (generation: number) => {
      setIsLoadingMore(true);
      try {
        let readerId = readerIdRef.current;
        if (!readerId) {
          // specs/instant-tab-revisit.md FR-245: a fast-path reactivation (FR-242) has no live reader. Create
          // one and skip past the rows already shown, keeping `readPage` sequential-only (no offset param, see
          // packages/git-core/README.md).
          // That skip is only valid if history is unchanged, which was checked at reactivation but not since
          // (security-review fix): a commit landing on HEAD later would cause duplicate rows or gaps.

          // Cheap early-out: the watcher already flagged drift. Not sufficient alone, since its confirming read
          // is async and may lag HEAD moving; the re-check below closes that gap.
          if (hasExternalChangesRef.current || operationStateAlertRef.current) {
            // `refreshRefsAndRows` (via `startReader`) already resets rows/hasMore.
            await refreshRefsAndRowsRef.current?.(undefined, { closesGate: false });
            return;
          }

          // Re-read and compare against `lastConfirmedRef` (what reactivateTab's hit confirmed) with the shared
          // `hasUnexpectedRefChange`/`noChangeExpected`. A null `pre` means nothing was ever confirmed, so there
          // is nothing to diff: proceed rather than false-positive.
          const pre = lastConfirmedRef.current;
          let driftDetected = false;
          if (pre) {
            try {
              const [stateResult, refsResult] = await Promise.all([
                getStateWithRetry(api),
                getRefsWithRetry(api),
              ]);
              if (generation !== generationRef.current) return;
              const freshState = unwrap(stateResult);
              const freshRefs = unwrap(refsResult);
              driftDetected = hasUnexpectedRefChange(
                pre,
                { state: freshState, refs: freshRefs },
                noChangeExpected(pre),
              );
            } catch {
              // Couldn't confirm safety (lock collision past the retry, unreadable repo): fail safe as drift
              // rather than risk a corrupt fast-forward.
              driftDetected = true;
            }
          }

          if (driftDetected) {
            // History changed since the cache was confirmed: abandon the lazy fast-forward (no reader was
            // created, so nothing leaks) and fully reload. `closesGate: false` because no `beginMutation()`
            // pairs with this and it must not consume a real FIFO entry.
            await refreshRefsAndRowsRef.current?.(undefined, { closesGate: false });
            return;
          }

          const created = unwrap(await api.createLogReader(filterRef.current));
          if (generation !== generationRef.current) {
            await api.closeReader(created).catch(() => {});
            return;
          }
          readerIdRef.current = created;
          readerId = created;
          const skipCount = rowsRef.current.length;
          if (skipCount > 0) {
            unwrap(await api.readPage(readerId, skipCount));
            if (generation !== generationRef.current) return;
          }
        }
        const page = unwrap(await api.readPage(readerId, PAGE_SIZE));
        if (generation !== generationRef.current) return;
        const laidOut = page.commits.map((c) => laneAssignerRef.current.next(c));
        const nextRows = rowsRef.current.concat(laidOut);
        rowsRef.current = nextRows;
        hasMoreRef.current = !page.done;
        setRows(nextRows);
        setHasMore(!page.done);
      } finally {
        if (generation === generationRef.current) setIsLoadingMore(false);
      }
    },
    [api],
  );

  const startReader = useCallback(
    async (nextFilter: CommitLogFilter, generation: number, requestId?: string) => {
      if (!isEmptyFilter(nextFilter)) {
        if (baselineRef.current === null && readerIdRef.current) {
          // First move into a filtered view: park the unfiltered reader + loaded rows for AC-10.
          baselineRef.current = {
            readerId: readerIdRef.current,
            rows: rowsRef.current,
            hasMore: hasMoreRef.current,
            laneAssigner: laneAssignerRef.current,
          };
        } else if (readerIdRef.current && readerIdRef.current !== baselineRef.current?.readerId) {
          // Re-filtering a filtered view: the previous filtered reader isn't cached elsewhere, so close it.
          await api.closeReader(readerIdRef.current).catch(() => {});
        }
      }
      // nextFilter is empty only on openRepo's first load; clearFilter restores the baseline directly.

      // specs/repo-open-feedback-fixes.md FR-197: `requestId` (only from `openRepo`) makes reader creation and
      // the first `readPage` abortable for the whole attempt.
      const readerResult = unwrap(await api.createLogReader(nextFilter, requestId));
      if (generation !== generationRef.current) {
        await api.closeReader(readerResult).catch(() => {});
        return;
      }
      readerIdRef.current = readerResult;
      laneAssignerRef.current = new LaneAssigner();
      rowsRef.current = [];
      hasMoreRef.current = true;
      setRows([]);
      setHasMore(true);
      await loadMoreInternal(generation);
    },
    [api, loadMoreInternal],
  );

  const loadMore = useCallback(() => {
    if (isLoadingMore || !hasMore) return;
    void loadMoreInternal(generationRef.current);
  }, [hasMore, isLoadingMore, loadMoreInternal]);

  /** FR-6a: records a read GitHydra performed/trusts as the next watcher-comparison baseline. */
  const recordConfirmedSnapshot = useCallback((state: RepositoryState, freshRefs: RefInfo[]) => {
    lastConfirmedRef.current = { state, refs: freshRefs };
    confirmedGenerationRef.current += 1;
  }, []);

  const refreshAuxData = useCallback(
    async (generation: number, snapshotState?: RepositoryState, requestId?: string) => {
      // specs/repo-open-feedback-fixes.md FR-197: `requestId` (only from `openRepo`) makes these reads
      // abortable; a cancellation surfaces as an "OperationCancelledError" (`isCancelledError`) that
      // `openRepo` handles.
      const [refsResult, upstreamResult, changesResult, stashResult] = await Promise.all([
        getRefsWithRetry(api, requestId),
        getUpstreamBranchWithRetry(api, requestId),
        getWorkingDirectoryChangesWithRetry(api, requestId),
        listStashesWithRetry(api, requestId),
      ]);
      if (generation !== generationRef.current) return;
      const freshRefs = unwrap(refsResult);
      setRefs(freshRefs);
      setUpstreamShortName(unwrap(upstreamResult));
      setWorkingDirChanges(unwrap(changesResult));
      // specs/stash.md FR-92/FR-93: stash count + signature, recorded as the watcher baseline like refs/HEAD.
      const freshStashList = unwrap(stashResult);
      setStashCount(freshStashList === null ? null : freshStashList.length);
      lastConfirmedStashSigRef.current = stashSignature(freshStashList);
      // Only `openRepo` passes `snapshotState` (from `api.openRepo`'s result); it counts as a confirmed read (FR-6a).
      if (snapshotState) recordConfirmedSnapshot(snapshotState, freshRefs);
    },
    [api, recordConfirmedSnapshot],
  );

  /**
   * specs/stash.md FR-93/FR-101: cheap stash-count re-fetch after a stash mutation (FR-92), keeping the
   * badge and watcher baseline current without a full `refresh()`.
   */
  const refreshStashList = useCallback(async () => {
    const generation = generationRef.current;
    const result = await listStashesWithRetry(api);
    if (generation !== generationRef.current) return;
    const list = unwrap(result);
    setStashCount(list === null ? null : list.length);
    lastConfirmedStashSigRef.current = stashSignature(list);
  }, [api]);

  /**
   * specs/instant-tab-revisit.md FR-239/FR-240: snapshot of live state for `useRepoTabs.ts`'s
   * `snapshotActiveTab()`, or `null` when ineligible:
   *  - no repo ready;
   *  - rows (live or parked baseline) exceed `PAGE_SIZE` (FR-240/AC8);
   *  - `hasExternalChanges`/`operationStateAlert` set (AC5): the watcher already advanced
   *    `lastConfirmedRef` past rows that predate the drift, so a later compare would wrongly report a hit;
   *  - no confirmed read yet (nothing to diff against).
   */
  const captureTabCache = useCallback((): TabGraphCache | null => {
    if (status !== "ready" || !repoState) return null;
    if (hasExternalChanges || operationStateAlert !== null) return null;
    if (rowsRef.current.length > PAGE_SIZE) return null;
    const baseline = baselineRef.current;
    if (baseline && baseline.rows.length > PAGE_SIZE) return null;
    const lastConfirmed = lastConfirmedRef.current;
    if (!lastConfirmed) return null;
    return {
      rows: rowsRef.current,
      hasMore: hasMoreRef.current,
      laneAssigner: laneAssignerRef.current,
      baseline: baseline ? { rows: baseline.rows, hasMore: baseline.hasMore, laneAssigner: baseline.laneAssigner } : null,
      filter,
      refs,
      repoState,
      workingDirChanges,
      stashCount,
      upstreamShortName,
      lastConfirmed,
      lastConfirmedStashSig: lastConfirmedStashSigRef.current,
      commitDetail: commitDetail.status === "ready" ? commitDetail : null,
    };
  }, [
    status,
    hasExternalChanges,
    operationStateAlert,
    filter,
    refs,
    repoState,
    workingDirChanges,
    stashCount,
    upstreamShortName,
    commitDetail,
  ]);

  const openRepo = useCallback(
    async (
      path: string,
      initialFilter: CommitLogFilter = {},
      /**
       * specs/repo-list.md AC6: fires once for a real "opened"/"error" outcome (not cancelled or
       * superseded), for callers that can't rely on React's async `status`.
       */
      onSettled?: (outcome: "opened" | "error", resolvedPath?: string) => void,
    ) => {
      const generation = ++generationRef.current;
      repoEpochRef.current += 1;
      // specs/repo-open-feedback.md FR-163/FR-167: the stringified generation is unique per attempt, so it
      // doubles as the `cancelOpenRepo` requestId. FR-197/FR-198: `activeOpenRequestIdRef` stays set through
      // the aux-data/reader phases and clears only in the final `finally`, so Cancel works throughout.
      const requestId = String(generation);
      activeOpenRequestIdRef.current = requestId;
      // FR-168/FR-199: everything this attempt may overwrite before settling (see `OpenAttemptSnapshot`).
      const priorSnapshot: OpenAttemptSnapshot = {
        status,
        errorMessage,
        selectedSha,
        commitDetail,
        hasExternalChanges,
        operationStateAlert,
        filter,
        stashCount,
        pendingMutations: pendingMutationsRef.current,
        lastConfirmed: lastConfirmedRef.current,
        confirmedGeneration: confirmedGenerationRef.current,
        lastConfirmedStashSig: lastConfirmedStashSigRef.current,
        repoPath,
        repoState,
        refs,
        upstreamShortName,
        workingDirChanges,
        rows: rowsRef.current,
        hasMore: hasMoreRef.current,
        readerId: readerIdRef.current,
        baseline: baselineRef.current,
        laneAssigner: laneAssignerRef.current,
      };
      /**
       * FR-199: restores every field a cancelled attempt may have overwritten; restoring an untouched field
       * is a harmless no-op. Nothing to undo main-side: `RepoSession.open()` only stages until
       * `commitOpenRepo`, and this attempt's own readers are released by the `finally`'s `endOpenAttempt`.
       */
      const restoreFromCancellation = () => {
        setStatus(priorSnapshot.status);
        setErrorMessage(priorSnapshot.errorMessage);
        setSelectedSha(priorSnapshot.selectedSha);
        setCommitDetail(priorSnapshot.commitDetail);
        setHasExternalChanges(priorSnapshot.hasExternalChanges);
        setOperationStateAlert(priorSnapshot.operationStateAlert);
        setFilter(priorSnapshot.filter);
        setStashCount(priorSnapshot.stashCount);
        pendingMutationsRef.current = priorSnapshot.pendingMutations;
        lastConfirmedRef.current = priorSnapshot.lastConfirmed;
        confirmedGenerationRef.current = priorSnapshot.confirmedGeneration;
        lastConfirmedStashSigRef.current = priorSnapshot.lastConfirmedStashSig;
        setRepoPath(priorSnapshot.repoPath);
        setRepoState(priorSnapshot.repoState);
        setRefs(priorSnapshot.refs);
        setUpstreamShortName(priorSnapshot.upstreamShortName);
        setWorkingDirChanges(priorSnapshot.workingDirChanges);
        rowsRef.current = priorSnapshot.rows;
        setRows(priorSnapshot.rows);
        hasMoreRef.current = priorSnapshot.hasMore;
        setHasMore(priorSnapshot.hasMore);
        readerIdRef.current = priorSnapshot.readerId;
        baselineRef.current = priorSnapshot.baseline;
        laneAssignerRef.current = priorSnapshot.laneAssigner;
      };
      // Bumped on every attempt (even failed/cancelled) so keyed panels remount. The resets below (incl.
      // `setFilter`) must precede the first `await` so they batch with `openSequence`: consumers that reset
      // off it (FindCommitsOverlay, specs/find-commits-overlay.md FR-265) would otherwise read a stale filter.
      setOpenSequence((n) => n + 1);
      setStatus("opening");
      setErrorMessage(null);
      setSelectedSha(null);
      setCommitDetail({ status: "idle" });
      setHasExternalChanges(false);
      setOperationStateAlert(null);
      setFilter(initialFilter);
      // FR-6b: a fresh open starts with a clean gate; baselines queued against the previous repo are meaningless.
      pendingMutationsRef.current = [];
      lastConfirmedRef.current = null;
      confirmedGenerationRef.current += 1;
      lastConfirmedStashSigRef.current = null;
      setStashCount(null);
      // Deliberately don't close the previous reader or touch repo/rows state here (FR-168/FR-199): a cancel
      // at any phase must leave the prior repo fully usable. `RepoSession.open()` mirrors this by only
      // staging until `commitOpenRepo` below.
      try {
        const outcome: OpenRepoOutcome = await api.openRepoCancellable(path, requestId);
        // Superseded: the newer attempt owns the UI and rolling back here could stomp it, so report "not cancelled".
        if (generation !== generationRef.current) return false;

        if (outcome.outcome === "cancelled") {
          // FR-168/FR-169: restore what was showing before, never the canceled attempt's state.
          restoreFromCancellation();
          // Returning true lets `useRepoTabs` roll back its own optimistic tab bookkeeping.
          return true;
        }

        const opened = unwrap(outcome.result);
        if (generation !== generationRef.current) return false;
        setRepoPath(opened.path);
        setRepoState(opened.state);
        // specs/repo-open-feedback-fixes.md FR-197: `requestId` makes these calls abortable; a cancel rejects
        // with "OperationCancelledError" (`isCancelledError`), caught below.
        await refreshAuxData(generation, opened.state, requestId);
        if (generation !== generationRef.current) return false;
        await startReader(initialFilter, generation, requestId);
        if (generation !== generationRef.current) return false;
        // FR-199: commit only after the ENTIRE sequence succeeded — main-side `commitOpenRepo` promotes the
        // new repo and closes the previous one's readers/watcher (`RepoSession.commitOpen()`). Clear any parked
        // baseline from the previous repo (AC-10 bookkeeping only).
        baselineRef.current = null;
        await api.commitOpenRepo(requestId);
        if (generation !== generationRef.current) return false;
        setStatus("ready");
        onRepoOpened?.(opened.path, opened.pickedPath);
        onSettled?.("opened", opened.path);
        return false;
      } catch (err) {
        if (generation !== generationRef.current) return false;
        if (isCancelledError(err)) {
          // FR-199: cancellation during aux-data/reader phases, same contract as phase one.
          restoreFromCancellation();
          return true;
        }
        setStatus("error");
        setErrorMessage(err instanceof Error ? err.message : String(err));
        onSettled?.("error");
        return false;
      } finally {
        // FR-197/FR-198: settled for any reason — release the cancel flag and main-side per-requestId state
        // (a no-op if `commitOpenRepo` already consumed it).
        if (activeOpenRequestIdRef.current === requestId) activeOpenRequestIdRef.current = null;
        void api.endOpenAttempt(requestId);
      }
    },
    [
      api,
      refreshAuxData,
      startReader,
      onRepoOpened,
      status,
      errorMessage,
      selectedSha,
      commitDetail,
      hasExternalChanges,
      operationStateAlert,
      filter,
      stashCount,
      repoPath,
      repoState,
      refs,
      upstreamShortName,
      workingDirChanges,
    ],
  );

  /**
   * specs/instant-tab-revisit.md FR-241/FR-242/FR-243: cache-aware `openRepo` for reactivating a tab. A
   * `null` `cache` delegates straight to `openRepo()` (FR-243, AC13).
   * Otherwise it does one cheap fresh read (repoint the session via `openRepoCancellable`, FR-244;
   * refs/upstream/changes/stashes as in `refreshAuxData`) and compares against `cache.lastConfirmed`/
   * `lastConfirmedStashSig` with the same `hasUnexpectedRefChange`/`noChangeExpected`/stash-signature
   * checks the watcher uses, plus `operationIdentityChanged` (AC4: an external merge/rebase start/end is
   * invisible to a ref diff).
   * Clean (FR-242): applies cached rows/lanes/baseline with no `createLogReader`/`readPage`; repo state,
   * refs etc. always come from the FRESH read. `status` is never touched; `openSequence` bumps once.
   * Any mismatch or mid-read error (FR-243) falls back to `openRepo()`, releasing the staged attempt in
   * `finally`.
   * `selectionRestored` tells the caller `cache.commitDetail` was applied, so it should skip its own
   * `selectCommit()` (which would flash "loading").
   */
  const reactivateTab = useCallback(
    async (
      path: string,
      target: { filter: CommitLogFilter; selectedSha: string | null },
      cache: TabGraphCache | null,
      onSettled?: (outcome: "opened" | "error", resolvedPath?: string) => void,
    ): Promise<{ cancelled: boolean; selectionRestored: boolean }> => {
      if (!cache) {
        const cancelled = await openRepo(path, target.filter, onSettled);
        return { cancelled, selectionRestored: false };
      }

      const generation = ++generationRef.current;
      repoEpochRef.current += 1;
      const requestId = String(generation);
      activeOpenRequestIdRef.current = requestId;

      try {
        const outcome: OpenRepoOutcome = await api.openRepoCancellable(path, requestId);
        if (generation !== generationRef.current) return { cancelled: false, selectionRestored: false };
        if (outcome.outcome === "cancelled") return { cancelled: true, selectionRestored: false };

        const opened = unwrap(outcome.result);
        if (generation !== generationRef.current) return { cancelled: false, selectionRestored: false };

        const [refsResult, upstreamResult, changesResult, stashResult] = await Promise.all([
          getRefsWithRetry(api, requestId),
          getUpstreamBranchWithRetry(api, requestId),
          getWorkingDirectoryChangesWithRetry(api, requestId),
          listStashesWithRetry(api, requestId),
        ]);
        if (generation !== generationRef.current) return { cancelled: false, selectionRestored: false };

        const freshState = opened.state;
        const freshRefs = unwrap(refsResult);
        const freshUpstream = unwrap(upstreamResult);
        const freshWorkingDirChanges = unwrap(changesResult);
        const freshStashList = unwrap(stashResult);
        const freshStashSig = stashSignature(freshStashList);
        const fresh: RefHeadSnapshot = { state: freshState, refs: freshRefs };

        const refsChanged = hasUnexpectedRefChange(cache.lastConfirmed, fresh, noChangeExpected(cache.lastConfirmed));
        const stashChanged = cache.lastConfirmedStashSig !== freshStashSig;
        const operationChanged = operationIdentityChanged(cache.lastConfirmed.state, freshState);

        if (!refsChanged && !stashChanged && !operationChanged) {
          // FR-242: cache hit.
          await api.commitOpenRepo(requestId);
          if (generation !== generationRef.current) return { cancelled: false, selectionRestored: false };

          setOpenSequence((n) => n + 1);
          setStatus("ready");
          setErrorMessage(null);
          setRepoPath(opened.path);
          setRepoState(freshState);
          setRefs(freshRefs);
          setUpstreamShortName(freshUpstream);
          setWorkingDirChanges(freshWorkingDirChanges);
          setStashCount(freshStashList === null ? null : freshStashList.length);

          readerIdRef.current = null;
          laneAssignerRef.current = cache.laneAssigner;
          rowsRef.current = cache.rows;
          hasMoreRef.current = cache.hasMore;
          baselineRef.current = cache.baseline ? { readerId: null, ...cache.baseline } : null;
          setRows(cache.rows);
          setHasMore(cache.hasMore);
          setIsLoadingMore(false);

          setFilter(cache.filter);
          setSelectedSha(null);
          setCommitDetail({ status: "idle" });
          setHasExternalChanges(false);
          setOperationStateAlert(null);

          pendingMutationsRef.current = [];
          lastConfirmedRef.current = fresh;
          confirmedGenerationRef.current += 1;
          lastConfirmedStashSigRef.current = freshStashSig;

          let selectionRestored = false;
          if (target.selectedSha && cache.commitDetail && cache.commitDetail.commit.sha === target.selectedSha) {
            setSelectedSha(target.selectedSha);
            setCommitDetail(cache.commitDetail);
            selectionRestored = true;
          }

          onRepoOpened?.(opened.path, opened.pickedPath);
          onSettled?.("opened", opened.path);
          return { cancelled: false, selectionRestored };
        }

        // FR-243: something changed — abandon this staged attempt (released by `finally`) and fully reopen.
        return { cancelled: await openRepo(path, target.filter, onSettled), selectionRestored: false };
      } catch (err) {
        if (generation !== generationRef.current) return { cancelled: false, selectionRestored: false };
        if (isCancelledError(err)) return { cancelled: true, selectionRestored: false };
        // Cheap read failed (e.g. repo inaccessible): `openRepo()` owns the error UI, so fail the same way a
        // full reopen would.
        return { cancelled: await openRepo(path, target.filter, onSettled), selectionRestored: false };
      } finally {
        if (activeOpenRequestIdRef.current === requestId) activeOpenRequestIdRef.current = null;
        void api.endOpenAttempt(requestId);
      }
    },
    [api, openRepo, onRepoOpened],
  );

  const openRepoViaDialog = useCallback(async () => {
    const path = unwrap(await api.openRepoDialog());
    if (path) await openRepo(path);
  }, [api, openRepo]);

  /**
   * specs/repo-open-feedback.md FR-167/FR-168/AC9: aborts the in-flight open, if any; safe to repeat since
   * `api.cancelOpenRepo` is idempotent.
   */
  const cancelOpen = useCallback(() => {
    const requestId = activeOpenRequestIdRef.current;
    if (!requestId) return;
    void api.cancelOpenRepo(requestId);
  }, [api]);

  const closeRepo = useCallback(async () => {
    generationRef.current += 1;
    repoEpochRef.current += 1;
    setOpenSequence((n) => n + 1);
    // security review (specs/repo-list.md): tear down the main-process session (readers, watcher,
    // `Repository`) first, to shrink the window for in-flight watcher events. Awaited so callers like
    // `useRepoTabs`'s `newTab()` know teardown actually happened.
    await api.closeRepoSession().catch(() => {});
    await closeCurrentReader();
    setStatus("idle");
    setErrorMessage(null);
    setRepoPath(null);
    setRepoState(null);
    setRefs([]);
    setUpstreamShortName(null);
    setWorkingDirChanges(null);
    rowsRef.current = [];
    setRows([]);
    hasMoreRef.current = false;
    setHasMore(false);
    setIsLoadingMore(false);
    setFilter({});
    setShowAllRefs(false);
    setSelectedSha(null);
    setCommitDetail({ status: "idle" });
    setHasExternalChanges(false);
    setOperationStateAlert(null);
    // FR-6b: same as `openRepo`'s reset.
    pendingMutationsRef.current = [];
    lastConfirmedRef.current = null;
    confirmedGenerationRef.current += 1;
    lastConfirmedStashSigRef.current = null;
    setStashCount(null);
  }, [api, closeCurrentReader]);

  const applyFilter = useCallback(
    (nextFilter: CommitLogFilter) => {
      const generation = ++generationRef.current;
      setFilter(nextFilter);
      setSelectedSha(null);
      setCommitDetail({ status: "idle" });
      void startReader(nextFilter, generation);
    },
    [startReader],
  );

  const clearFilter = useCallback(() => {
    const baseline = baselineRef.current;
    if (!baseline) {
      // No parked baseline (e.g. the first filter hasn't resolved yet): fall back to a normal fetch.
      applyFilter({});
      return;
    }
    // AC-10: restore the parked unfiltered view with no new reader or row reset.
    generationRef.current += 1;
    setSelectedSha(null);
    setCommitDetail({ status: "idle" });
    setFilter({});
    if (readerIdRef.current && readerIdRef.current !== baseline.readerId) {
      void api.closeReader(readerIdRef.current).catch(() => {});
    }
    readerIdRef.current = baseline.readerId;
    laneAssignerRef.current = baseline.laneAssigner;
    rowsRef.current = baseline.rows;
    hasMoreRef.current = baseline.hasMore;
    setRows(baseline.rows);
    setHasMore(baseline.hasMore);
    setIsLoadingMore(false);
    baselineRef.current = null;
  }, [api, applyFilter]);

  const refreshWorkingDirStatus = useCallback(async () => {
    const generation = generationRef.current;
    const result = await getWorkingDirectoryChangesWithRetry(api);
    if (generation !== generationRef.current) return;
    setWorkingDirChanges(unwrap(result));
  }, [api]);

  /**
   * CLAUDE.md "Known pitfalls": same bug class as `refreshRefsAndRowsInBackground`. Every production
   * caller is fire-and-forget, but `refreshWorkingDirStatus` `unwrap()`s and throws; if the repo closes
   * mid-flight that becomes an unhandled rejection. This wrapper never rejects: a stale-generation
   * failure is a silent no-op, anything else logs.
   */
  const refreshWorkingDirStatusInBackground = useCallback(async (): Promise<void> => {
    const generation = generationRef.current;
    try {
      await refreshWorkingDirStatus();
    } catch (err) {
      if (generation !== generationRef.current) return;
      // eslint-disable-next-line no-console -- deliberate: the only surface this failure gets.
      console.error("GitHydra: background working-directory status refresh failed", err);
    }
  }, [refreshWorkingDirStatus]);

  /**
   * FR-6a: the watcher-fired comparison — always a fresh read, compared against the last snapshot
   * GitHydra confirmed. Only reached with no mutation gate open (see the `onRefsChanged` effect);
   * otherwise `refreshRefs()`'s own diff is decisive (AC5).
   * Also does specs/merge-rebase-conflict-resolution.md FR-59/AC11 operation-state detection, revised by
   * specs/graph-head-indicator-and-refresh-alerting.md Problem 2 to alert rather than silently apply.
   * One debounced event covers two cases; only one flag is set per fire:
   *  1. Ordinary ref churn — `hasUnexpectedRefChange` decides; a mismatch sets `hasExternalChanges`
   *     without touching `repoState`/`refs` (alert, don't silently apply).
   *  2. In-progress-operation change — sets `operationStateAlert` and skips the churn diff (operations
   *     move refs too). `lastConfirmedRef` still advances so the next churn comparison isn't against
   *     pre-change data.
   */
  const evaluateWatcherEvent = useCallback(async () => {
    const generation = generationRef.current;
    // Security review (AC5): gate-openness alone doesn't prove this fetch is still current — a whole
    // self-caused mutation cycle can finish within its flight time. Capture `confirmedGenerationRef` now
    // and compare after (bumped on every `lastConfirmedRef` write, including this function's own).
    const confirmedGenerationAtStart = confirmedGenerationRef.current;
    let nextState: RepositoryState;
    let nextRefs: RefInfo[];
    let nextStashList: StashInfo[] | null;
    try {
      // Retrying helpers (security review): a raw collision here became an unhandled rejection. The
      // `unwrap()`s sit inside the try so a failure surviving the retry degrades to "ordinary churn".
      const [stateResult, refsResult, stashResult] = await Promise.all([
        getStateWithRetry(api),
        getRefsWithRetry(api),
        listStashesWithRetry(api),
      ]);
      nextState = unwrap(stateResult);
      nextRefs = unwrap(refsResult);
      nextStashList = unwrap(stashResult);
    } catch {
      // Unreadable repo or lock collision past the retry: treat as ordinary churn; manual `refresh()` surfaces the real error.
      if (generation === generationRef.current) setHasExternalChanges(true);
      return;
    }
    if (generation !== generationRef.current) return;
    // A `beginMutation()` may have landed while this fetch was in flight (the registration-site guard only
    // checked when the event fired). The verdict is stale once any gate is open; that operation's own
    // `refreshRefs`/`refreshRefsAndRows` settle accounts for everything.
    if (pendingMutationsRef.current.length > 0) return;
    // No gate open, but the baseline moved since dispatch (a full mutation cycle or another watcher evaluation landed).
    if (confirmedGenerationRef.current !== confirmedGenerationAtStart) return;
    // specs/stash.md FR-91/AC18: stash changes fire the same watcher event but are invisible to the ref diff
    // (excluded from `RefInfo`), so compare signatures separately.
    const nextStashSig = stashSignature(nextStashList);

    // FR-59/AC11: `prev` must be `lastConfirmedRef`, not React's `repoState`: even an effect-synced ref lags
    // a render+effect behind `setRepoState`, so a late watcher event could read a stale `prev` and flag
    // Abort's own operation-ending write as external (security review). `recordConfirmedSnapshot` is a
    // plain synchronous ref write with no such gap.
    const prev = lastConfirmedRef.current?.state ?? null;
    const operationChanged = !prev || operationIdentityChanged(prev, nextState);

    if (operationChanged) {
      // Prefer the newly-detected operation; if it just ended externally, name the previous one.
      const operation = nextState.inProgressOperation ?? prev?.inProgressOperation ?? null;
      if (operation) {
        lastConfirmedRef.current = { state: nextState, refs: nextRefs };
        confirmedGenerationRef.current += 1;
        lastConfirmedStashSigRef.current = nextStashSig;
        setOperationStateAlert({ operation });
        return;
      }
      // Defensive: `operationChanged` with both sides null shouldn't happen; fall through to ordinary churn.
    }

    const fresh: RefHeadSnapshot = { state: nextState, refs: nextRefs };
    const pre = lastConfirmedRef.current;
    const isMismatch = pre !== null && hasUnexpectedRefChange(pre, fresh, noChangeExpected(pre));
    lastConfirmedRef.current = fresh;
    confirmedGenerationRef.current += 1;

    const preStashSig = lastConfirmedStashSigRef.current;
    const stashMismatch = preStashSig !== null && preStashSig !== nextStashSig;
    lastConfirmedStashSigRef.current = nextStashSig;

    if (isMismatch || stashMismatch) setHasExternalChanges(true);
  }, [api]);

  /**
   * FR-6b: call when an app-initiated mutating git call is issued, before awaiting it — the disk write that
   * trips the watcher happens during the call. Must be paired with a `refreshRefs()` (directly or via
   * `refreshAfterBranchOp`) or the gate never closes (`pendingMutationsRef`).
   */
  const beginMutation = useCallback(() => {
    pendingMutationsRef.current.push({ pre: lastConfirmedRef.current });
  }, []);

  /**
   * specs/self-write-refresh-suppression.md AC5: GitHydra's own confirming read. It always records the
   * fresh read as the new baseline, but when closing a mutation's gate it first diffs against the
   * pre-mutation baseline and `expected` (default: nothing should have changed, e.g. a failed mutation);
   * any extra change sets `hasExternalChanges`, so an external write during the operation's window can't
   * be folded in silently.
   * Throwing inner implementation; `refreshRefs` below wraps it to never reject.
   */
  const refreshRefsCore = useCallback(
    async (expected?: ExpectedRefOutcome) => {
      const generation = generationRef.current;
      const [stateResult, refsResult, upstreamResult] = await Promise.all([
        getStateWithRetry(api),
        getRefsWithRetry(api),
        getUpstreamBranchWithRetry(api),
      ]);
      if (generation !== generationRef.current) return;
      const freshState = unwrap(stateResult);
      const freshRefs = unwrap(refsResult);
      setRepoState(freshState);
      setRefs(freshRefs);
      setUpstreamShortName(unwrap(upstreamResult));

      // Addendum 2 Problem 1a: loaded rows' `commit.refs` are captured at load time, so after a checkout the
      // old HEAD row kept a stale "HEAD (detached)" chip. Re-decorate in memory only (no re-fetch), including
      // the parked baseline so `clearFilter` doesn't resurrect it.
      const nextRows = redecorateRows(rowsRef.current, freshRefs, freshState.headSha);
      if (nextRows !== rowsRef.current) {
        rowsRef.current = nextRows;
        setRows(nextRows);
      }
      if (baselineRef.current) {
        const nextBaselineRows = redecorateRows(baselineRef.current.rows, freshRefs, freshState.headSha);
        if (nextBaselineRows !== baselineRef.current.rows) {
          baselineRef.current = { ...baselineRef.current, rows: nextBaselineRows };
        }
      }

      // FIFO: may close a `beginMutation` gate; issue order matches resolution order because the UI serializes via row-level busy state.
      const pending = pendingMutationsRef.current.shift();
      if (pending) {
        const fresh: RefHeadSnapshot = { state: freshState, refs: freshRefs };
        const expectedOutcome = expected ?? (pending.pre ? noChangeExpected(pending.pre) : null);
        if (expectedOutcome && hasUnexpectedRefChange(pending.pre, fresh, expectedOutcome)) {
          setHasExternalChanges(true);
        }
      }

      recordConfirmedSnapshot(freshState, freshRefs);
    },
    [api, recordConfirmedSnapshot],
  );

  /**
   * CLAUDE.md "Known pitfalls": same bug class as `refreshRefsAndRowsInBackground`. Every production
   * caller is fire-and-forget (`void graph.refreshRefs(...)`, `onMutationSettled` typed `() => void`),
   * and `refreshRefsCore` throws on failure — an unhandled rejection if the repo closed mid-flight.
   * Nothing depends on this one throwing (unlike `refreshRefsAndRows`), so it is itself the safe wrapper:
   * a stale-generation failure is a silent no-op, otherwise it logs.
   */
  const refreshRefs = useCallback(
    async (expected?: ExpectedRefOutcome): Promise<void> => {
      const generation = generationRef.current;
      try {
        await refreshRefsCore(expected);
      } catch (err) {
        if (generation !== generationRef.current) return;
        // eslint-disable-next-line no-console -- deliberate: the only surface this failure gets.
        console.error("GitHydra: background ref refresh failed", err);
      }
    },
    [refreshRefsCore],
  );

  /**
   * Why this exists beside `refreshRefs` (too light: never re-fetches rows) and `refresh`/`openRepo` (too
   * heavy: touch `status`/`openSequence`, remounting panels mid-interaction).
   * Gate-closing is FIFO like `refreshRefs`, but an omitted `expected` uses
   * `hasUnexpectedRefChangeBeyondCurrentBranch` instead of `noChangeExpected`: callers (cherry-pick step,
   * Continue/Abort) always legitimately move HEAD/refs. Skipping the diff entirely was an AC5 false
   * negative (specs/self-write-refresh-suppression.md): a second process's ref move in the settle window
   * would be folded into the baseline, so only the current branch's movement is tolerated.
   * `closesGate = false` (security review): skip the FIFO `shift()`/diff block. `refresh()` is reachable
   * any time, including while a real gated mutation is in flight; consuming its entry would make its
   * settle call skip its diff (the AC5 false negative `selfWriteGate.ts` exists to prevent).
   */
  const refreshRefsAndRowsBody = useCallback(
    async (
      expected: ExpectedRefOutcome | undefined,
      closesGate: boolean,
      generation: number,
      progress: { gateShifted: boolean },
    ) => {
      // Same fetch set as `refreshAuxData`: a settled cherry-pick/Continue/Abort also changes the
      // conflicted-file count and stash list (Changes badge, StashPanel).
      const [stateResult, refsResult, upstreamResult, changesResult, stashResult] = await Promise.all([
        getStateWithRetry(api),
        getRefsWithRetry(api),
        getUpstreamBranchWithRetry(api),
        getWorkingDirectoryChangesWithRetry(api),
        listStashesWithRetry(api),
      ]);
      if (generation !== generationRef.current) return;
      const freshState = unwrap(stateResult);
      const freshRefs = unwrap(refsResult);
      setRepoState(freshState);
      setRefs(freshRefs);
      setUpstreamShortName(unwrap(upstreamResult));
      setWorkingDirChanges(unwrap(changesResult));
      const freshStashList = unwrap(stashResult);
      setStashCount(freshStashList === null ? null : freshStashList.length);
      lastConfirmedStashSigRef.current = stashSignature(freshStashList);

      await closeCurrentReader();
      if (generation !== generationRef.current) return;
      await startReader(filter, generation);
      if (generation !== generationRef.current) return;

      // FIFO gate close, like `refreshRefs`; always diffs (see doc). Skipped when `closesGate` is false so the
      // queue front stays for its owning mutation.
      if (closesGate) {
        const pending = pendingMutationsRef.current.shift();
        progress.gateShifted = true;
        if (pending) {
          const fresh: RefHeadSnapshot = { state: freshState, refs: freshRefs };
          const flagged = expected
            ? hasUnexpectedRefChange(pending.pre, fresh, expected)
            : hasUnexpectedRefChangeBeyondCurrentBranch(pending.pre, fresh);
          if (flagged) setHasExternalChanges(true);
        }
      }

      recordConfirmedSnapshot(freshState, freshRefs);
    },
    [api, closeCurrentReader, startReader, filter, recordConfirmedSnapshot],
  );

  const refreshRefsAndRows = useCallback(
    async (expected?: ExpectedRefOutcome, opts?: { closesGate?: boolean }) => {
      const closesGate = opts?.closesGate ?? true;
      const generation = generationRef.current;
      const progress = { gateShifted: false };
      try {
        await refreshRefsAndRowsBody(expected, closesGate, generation, progress);
      } catch (err) {
        // A failed confirming read must not leak this gate entry (it would suppress the watcher for the
        // session). Fail toward the banner, not a silent false negative — unless the repo was closed/replaced,
        // where the queue was already reset.
        if (closesGate && !progress.gateShifted && generation === generationRef.current) {
          if (pendingMutationsRef.current.shift()) setHasExternalChanges(true);
        }
        throw err;
      }
    },
    [refreshRefsAndRowsBody],
  );

  // FR-245: keeps the ref-bridge current (see `refreshRefsAndRowsRef`).
  useEffect(() => {
    refreshRefsAndRowsRef.current = refreshRefsAndRows;
  }, [refreshRefsAndRows]);

  /**
   * CLAUDE.md "Known pitfalls": a fire-and-forget `refreshRefsAndRows()` (`cherryPickActions`'
   * `onSettled`, `StatusBanner`'s `onOperationChanged`) must use this wrapper. `refreshRefsAndRows`
   * deliberately still throws because `refresh()` needs that to restore `hasExternalChanges`/
   * `operationStateAlert`; those call sites have no `catch`, so a throw (e.g. "No repository is open"
   * after tab close / "+ New tab") became an unhandled rejection.
   * Never rejects. A failure after `generationRef` has moved on (closeRepo/openRepo/applyFilter/
   * clearFilter bump it) means the repo is gone or replaced — a silent no-op; any other failure (e.g. a
   * lock collision past the retry) logs a diagnostic.
   */
  const refreshRefsAndRowsInBackground = useCallback(
    async (expected?: ExpectedRefOutcome, opts?: { closesGate?: boolean }): Promise<void> => {
      const generation = generationRef.current;
      try {
        await refreshRefsAndRows(expected, opts);
      } catch (err) {
        if (generation !== generationRef.current) return;
        // eslint-disable-next-line no-console -- deliberate: the only surface this failure gets.
        console.error("GitHydra: background refresh failed", err);
      }
    },
    [refreshRefsAndRows],
  );

  /**
   * specs/refresh-without-teardown.md: manual refresh reuses `refreshRefsAndRows()` instead of
   * `openRepo()`, which flips `status` to "opening" (MainArea unmounts the graph for the spinner) and bumps
   * `openSequence` (remounts keyed panels, clearing selection/scroll). `isRefreshing` is the busy flag,
   * independent of `status`.
   * Never rejects: call sites are fire-and-forget (`void graph.refresh()`), and `openRepo` used to turn
   * failures into state. A failure is logged, not surfaced (AC1 forbids moving `status`); prior data
   * stays on screen.
   * Security review: a failed refresh restores `hasExternalChanges`/`operationStateAlert` rather than
   * leaving them cleared — `operationStateAlert` gates Continue/Abort/Accept/Mark-resolved in
   * `App.tsx`'s `blockConflictActions`, and an unconfirmed refetch must not unblock them. The restore is
   * a functional update so it applies only if nothing raced in: the watcher isn't gated by
   * `isRefreshing` and may set a genuinely new alert during the await, which must not be clobbered.
   * Passes `{ closesGate: false }` so it never consumes a gated mutation's FIFO entry.
   * AC6: a selected commit that no longer exists (external rebase/amend/force-push) must have its
   * selection cleared, else DetailPanel shows stale detail forever. Scoped to `refresh()`, not
   * `refreshRefsAndRows`, whose other callers have their own selection handling (HEAD auto-follow). The
   * check uses `api.getCommit`, not membership in reloaded rows, since the reload only fetches page one
   * and would wrongly clear a valid deeper selection.
   */
  const refresh = useCallback(async () => {
    const priorHasExternalChanges = hasExternalChanges;
    const priorOperationStateAlert = operationStateAlert;
    // Problem 2 AC5: one click clears both banner flags; the refetch below resolves what they warned about.
    // Must precede the await since `closesGate: false` never re-sets `hasExternalChanges`. On failure the
    // `catch` restores them unless the watcher set a newer value.
    setHasExternalChanges(false);
    setOperationStateAlert(null);
    setIsRefreshing(true);
    try {
      // `closesGate: false`: a manual refresh must not consume a gated mutation's FIFO entry.
      await refreshRefsAndRows(undefined, { closesGate: false });

      // AC6: verify the selection still exists (a real check, not membership in reloaded rows).
      const shaToVerify = selectedSha;
      if (shaToVerify) {
        try {
          const commit = unwrap(await api.getCommit(shaToVerify));
          if (commit === null) {
            // Functional update: clear only if selection is still the verified-gone sha; newer state wins.
            setSelectedSha((current) => (current === shaToVerify ? null : current));
            setCommitDetail((current) => (commitDetailSha(current) === shaToVerify ? { status: "idle" } : current));
          }
        } catch {
          // A failed check must not clear a real selection.
        }
      }
    } catch (err) {
      // Contained, not rethrown (see doc), but not treated as success: restore only if nothing raced in during the await.
      setHasExternalChanges((current) => (current === false ? priorHasExternalChanges : current));
      setOperationStateAlert((current) => (current === null ? priorOperationStateAlert : current));
      // eslint-disable-next-line no-console -- deliberate: the only surface this failure gets.
      console.error("GitHydra: manual refresh failed", err);
    } finally {
      setIsRefreshing(false);
    }
  }, [refreshRefsAndRows, hasExternalChanges, operationStateAlert, selectedSha, api]);

  // Addendum 3: shared body for `selectCommit()` (bumps `followSignal`) and `restoreSelection()` (doesn't);
  // detail fetching is identical so DetailPanel/ChangesPanel replay still works (AC3).
  const applySelection = useCallback(
    (sha: string | null, { follow }: { follow: boolean }) => {
      setSelectedSha(sha);
      if (follow) setFollowSignal((n) => n + 1);
      if (!sha) {
        setCommitDetail({ status: "idle" });
        return;
      }
      setCommitDetail({ status: "loading", sha });
      const generation = generationRef.current;
      const selectionGeneration = ++selectionGenerationRef.current;
      const stale = () =>
        generation !== generationRef.current || selectionGeneration !== selectionGenerationRef.current;
      void (async () => {
        try {
          const commit = unwrap(await api.getCommit(sha));
          if (stale()) return;
          if (!commit) {
            setCommitDetail({ status: "error", sha, message: "Commit not found." });
            return;
          }
          const files = unwrap(await api.getChangedFiles({ sha: commit.sha, parents: commit.parents }));
          if (stale()) return;
          setCommitDetail({ status: "ready", commit, files });
        } catch (err) {
          if (stale()) return;
          setCommitDetail({ status: "error", sha, message: err instanceof Error ? err.message : String(err) });
        }
      })();
    },
    [api],
  );

  const selectCommit = useCallback((sha: string | null) => applySelection(sha, { follow: true }), [applySelection]);

  /**
   * Addendum 3: replays a remembered selection (tab reactivation, relaunch) without bumping
   * `followSignal` — those specs promise no scroll restoration. Details load identically to `selectCommit`.
   */
  const restoreSelection = useCallback(
    (sha: string | null) => applySelection(sha, { follow: false }),
    [applySelection],
  );

  // Best-effort FR-6 auto-detect: surface a banner (or `operationStateAlert`) rather than yanking the graph
  // from under a mid-scroll/mid-conflict user; manual refresh does the actual reload.
  // specs/self-write-refresh-suppression.md FR-6a/FR-6b (AC5): while a mutation gate is open the event is
  // ignored outright, not deferred — that operation's own `refreshRefs()` diff is decisive, and a later
  // plain comparison against a baseline it already updated would absorb a concurrent external change.
  // While idle, `evaluateWatcherEvent` runs immediately.
  useEffect(() => {
    if (status !== "ready") return;
    return api.onRefsChanged(() => {
      if (pendingMutationsRef.current.length > 0) return;
      void evaluateWatcherEvent();
    });
  }, [api, status, evaluateWatcherEvent]);

  useEffect(() => {
    return () => {
      void closeCurrentReader();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // specs/instant-tab-revisit.md FR-245: see `filterRef`'s own doc comment.
  useEffect(() => {
    filterRef.current = filter;
  }, [filter]);

  // specs/instant-tab-revisit.md FR-245 security-review fix: see `hasExternalChangesRef`'s/
  // `operationStateAlertRef`'s own doc comment.
  useEffect(() => {
    hasExternalChangesRef.current = hasExternalChanges;
  }, [hasExternalChanges]);
  useEffect(() => {
    operationStateAlertRef.current = operationStateAlert;
  }, [operationStateAlert]);

  const nearHeadShas = useMemo(() => {
    const shas = new Set<string>();
    for (const row of rows.slice(0, NEAR_HEAD_WINDOW)) shas.add(row.commit.sha);
    return shas;
  }, [rows]);

  const visibleRefNames = useMemo(
    () =>
      computeVisibleRefNames(
        refs,
        {
          currentBranch: repoState?.currentBranch ?? null,
          upstreamShortName,
          nearHeadShas,
        },
        showAllRefs,
      ),
    [refs, repoState, upstreamShortName, nearHeadShas, showAllRefs],
  );

  const displayRows = useMemo<GraphDisplayRow[]>(() => {
    const commitRows: GraphDisplayRow[] = rows.map((laid) => ({ kind: "commit", laid }));
    if (!workingDirStatus?.hasChanges || !repoState?.headSha) return commitRows;
    const headRow = rows.find((r) => r.commit.sha === repoState.headSha);
    const lane = headRow?.lane ?? 0;
    const colorSlot = headRow?.colorSlot ?? 0;
    const connectsDown = rows.length > 0 && rows[0]!.commit.sha === repoState.headSha;
    return [
      { kind: "uncommitted", lane, colorSlot, status: workingDirStatus, connectsDown },
      ...commitRows,
    ];
  }, [rows, workingDirStatus, repoState]);

  return {
    api,
    status,
    openSequence,
    getOpenSequence,
    errorMessage,
    repoPath,
    repoState,
    refs,
    visibleRefNames,
    showAllRefs,
    setShowAllRefs,
    displayRows,
    maxLaneIndexSeen: laneAssignerRef.current.maxLaneIndexSeen,
    hasMore,
    isLoadingMore,
    loadMore,
    filter,
    applyFilter,
    clearFilter,
    workingDirStatus,
    workingDirChanges,
    stashCount,
    selectedSha,
    selectCommit,
    restoreSelection,
    followSignal,
    commitDetail,
    hasExternalChanges,
    operationStateAlert,
    openRepo,
    openRepoViaDialog,
    cancelOpen,
    closeRepo,
    refresh,
    isRefreshing,
    refreshWorkingDirStatus,
    refreshWorkingDirStatusInBackground,
    refreshStashList,
    refreshRefs,
    refreshRefsAndRows,
    refreshRefsAndRowsInBackground,
    beginMutation,
    captureTabCache,
    reactivateTab,
  };
}
