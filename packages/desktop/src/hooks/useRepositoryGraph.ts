import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ChangedFile,
  CommitInfo,
  CommitLogFilter,
  RefInfo,
  RepositoryState,
} from "@githydra/git-core";
import type { WorkingDirectoryStatus } from "../../shared/ipcContract";
import { LaneAssigner, type LaidOutRow } from "../lib/laneAssignment";
import { computeVisibleRefNames } from "../lib/refFiltering";
import { getGitHydraApi, unwrap } from "./gitHydraClient";
import type { GitHydraApi } from "../../shared/ipcContract";

export const PAGE_SIZE = 150;
/** How many of the most-recently-loaded commits count as "near HEAD" for FR-15's tag heuristic. */
const NEAR_HEAD_WINDOW = 300;

/** True when a CommitLogFilter has no active restriction (the unfiltered/"baseline" view). */
function isEmptyFilter(filter: CommitLogFilter): boolean {
  return Object.values(filter).every((v) => (Array.isArray(v) ? v.length === 0 : !v));
}

/** AC-10: a snapshot of the unfiltered view's already-open reader + already-loaded rows/lane
 * state, parked (not closed) while the user is looking at a filtered view, so `clearFilter` can
 * restore it instantly instead of discarding everything and re-querying from scratch. */
interface BaselineSnapshot {
  readerId: string;
  rows: LaidOutRow[];
  hasMore: boolean;
  laneAssigner: LaneAssigner;
}

export type GraphDisplayRow =
  | {
      kind: "uncommitted";
      lane: number;
      colorSlot: number;
      status: WorkingDirectoryStatus;
      /** True only when HEAD's commit is the very next loaded row, so the canvas can draw a
       * connector down to it rather than an ambiguous stub (see useRepositoryGraph's notes). */
      connectsDown: boolean;
    }
  | { kind: "commit"; laid: LaidOutRow };

export type CommitDetailState =
  | { status: "idle" }
  | { status: "loading"; sha: string }
  | { status: "ready"; commit: CommitInfo; files: ChangedFile[] }
  | { status: "error"; sha: string; message: string };

export type RepoOpenStatus = "idle" | "opening" | "ready" | "error";

export interface UseRepositoryGraphResult {
  /** The same `window.gitHydra` bridge instance this hook uses internally — shared with
   * `ChangesPanel`/`DetailPanel` so they don't each create/require their own reference and so
   * component tests can stub a single mock (see `test/mockGitHydra.ts`). */
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
  selectedSha: string | null;
  selectCommit: (sha: string | null) => void;
  commitDetail: CommitDetailState;
  hasExternalChanges: boolean;
  /**
   * `initialFilter` (specs/multi-repo-tabs.md Must-have 4): lets a caller reopen a repo directly
   * into a remembered non-empty filter (a tab switch replaying its remembered state) in one
   * reader creation, instead of opening unfiltered and immediately re-filtering — defaults to `{}`
   * (today's behavior) for every existing caller.
   */
  openRepo: (path: string, initialFilter?: CommitLogFilter) => Promise<void>;
  openRepoViaDialog: () => Promise<void>;
  refresh: () => Promise<void>;
  /**
   * specs/multi-repo-tabs.md Must-have 8/AC9: tears down the live reader (same close path
   * `openRepo` uses) and resets every piece of state back to `"idle"` — for "the last tab was
   * closed" only. Does not call any new IPC channel; the Electron-side `Repository`/watcher
   * this session had open has no "close without opening a new one" channel to call (deliberately
   * out of scope per the spec's "no IPC contract change" constraint) and is simply left orphaned
   * until a subsequent `openRepo` tears it down the normal way.
   */
  closeRepo: () => Promise<void>;
  /** Cheap re-fetch of just the working-directory status counts (FR-30/FR-32: keeps the
   * uncommitted-changes pseudo-node's counts and the Toolbar's Changes badge in sync after a
   * stage/unstage/discard/commit, without re-querying the whole commit log). */
  refreshWorkingDirStatus: () => Promise<void>;
  /**
   * FR-56: cheap re-fetch of repo state + refs + upstream (current-branch indicator, ref chips,
   * HEAD decoration) after a branch create/switch/delete — deliberately does NOT reset the
   * already-loaded commit rows/scroll position/lane assignment the way `refresh()` does, since a
   * branch mutation never changes which commits exist, only which refs point at them (the
   * default, unfiltered view already includes every branch's commits — see `CommitLogFilter`'s
   * doc comment). Cheaper and less disruptive than a full `refresh()` for this specific case.
   */
  refreshRefs: () => Promise<void>;
  /**
   * specs/multi-repo-tabs.md: bumped once per real "repo identity changed" event (every
   * `openRepo`/`closeRepo` call — including a same-path reopen, AC10 — but never a filter change,
   * which doesn't change *which* repo is open). React's automatic batching can coalesce the
   * `"opening"` -> `"ready"` transition into a single commit when every underlying IPC call
   * resolves within the same microtask tick (observed with this repo's own mocked-IPC test
   * doubles, not just a theoretical concern) — a component that only fetches its own repo-scoped
   * data on mount (`ChangesPanel`/`DetailPanel`/`BranchesPanel`) can then silently keep showing
   * the *previous* repo's stale data instead of the new one's, since it may never actually
   * unmount. Callers that render one of those per-repo panels should key it on this value (not on
   * `repoPath`, which is identical for two tabs pointing at the same path) to force a real
   * remount — and therefore a real re-fetch — on every open, deterministically, regardless of how
   * fast the underlying IPC round-trip happens to resolve.
   */
  openSequence: number;
  /**
   * FR-59/AC11 follow-up: bumped every time this hook silently applies a watcher-detected
   * in-progress-operation change (see the field's own doc comment on the implementation below for
   * the full reasoning). A caller that owns a component with its own operation-state-dependent
   * data this hook doesn't know about — currently `App`, for the Changes panel's conflicted-file
   * list via `useChangesPanel`'s `reloadToken` — should diff this against its own last-seen value
   * and trigger its own refresh when it changes, the same "diff against last-seen ref" pattern
   * `openSequence` callers already use.
   */
  operationStateChangeSequence: number;
}

export function useRepositoryGraph(): UseRepositoryGraphResult {
  const api = useMemo(() => getGitHydraApi(), []);

  const [status, setStatus] = useState<RepoOpenStatus>("idle");
  const [openSequence, setOpenSequence] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [repoPath, setRepoPath] = useState<string | null>(null);
  const [repoState, setRepoState] = useState<RepositoryState | null>(null);
  const [refs, setRefs] = useState<RefInfo[]>([]);
  const [upstreamShortName, setUpstreamShortName] = useState<string | null>(null);
  const [workingDirStatus, setWorkingDirStatus] = useState<WorkingDirectoryStatus | null>(null);
  const [rows, setRows] = useState<LaidOutRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [filter, setFilter] = useState<CommitLogFilter>({});
  const [showAllRefs, setShowAllRefs] = useState(false);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [commitDetail, setCommitDetail] = useState<CommitDetailState>({ status: "idle" });
  const [hasExternalChanges, setHasExternalChanges] = useState(false);
  /**
   * FR-59/AC11 follow-up: bumped once every time the watcher-change handler below detects a real
   * in-progress-operation change (case 2 in that handler's doc comment) and silently applies the
   * `repoState`/`workingDirStatus` refresh — i.e. exactly the moments a stale conflict-resolution
   * banner would otherwise linger. This hook has no idea the Changes panel's own per-file
   * "Conflicted" list exists (that's `useChangesPanel`'s, owned by `ChangesPanel`), so it can't
   * refresh that list itself — this counter is the surfaced signal a caller (`App`) uses to bump
   * `useChangesPanel`'s own `reloadToken` at the same moment, closing the other half of AC11 ("the
   * conflicted-file list" must also auto-update, not just the banner). Deliberately never reset —
   * a caller should diff it against its own last-seen value (the same `reloadToken` convention
   * already used for the checkpoint-node reclick), not compare it across repo opens.
   */
  const [operationStateChangeSequence, setOperationStateChangeSequence] = useState(0);

  const readerIdRef = useRef<string | null>(null);
  const laneAssignerRef = useRef(new LaneAssigner());
  /** Mirrors the `rows`/`hasMore` state synchronously (state updates are async/batched) so
   * startReader/clearFilter can snapshot "what's currently loaded" without depending on React
   * state in their own useCallback deps. */
  const rowsRef = useRef<LaidOutRow[]>([]);
  const hasMoreRef = useRef(false);
  /** AC-10: set while the user is viewing a filtered result — holds the parked baseline
   * (unfiltered) reader + its already-loaded rows so clearFilter can restore them without a
   * fresh query. Null while the baseline view itself is the live one. */
  const baselineRef = useRef<BaselineSnapshot | null>(null);
  /** Bumped on every open/filter change so stale async responses from a superseded reader are
   * dropped instead of corrupting the (freshly reset) lane-assignment state. */
  const generationRef = useRef(0);
  /** Separate counter for commit-detail selection races (rapid A -> B clicks), independent of
   * the repo-open/filter generation above. */
  const selectionGenerationRef = useRef(0);
  /**
   * FR-59/AC11 (specs/merge-rebase-conflict-resolution.md): mirrors `repoState` synchronously so
   * the watcher-change handler below can tell "the in-progress-operation identity actually
   * changed" apart from "some unrelated ref moved" — see that handler's comment for why this
   * distinction matters. Kept as a ref (not read from `repoState` state directly) because the
   * handler is an async callback registered once per `status` transition to `"ready"`; reading
   * closed-over `repoState` state there would see whatever value was live at subscribe time, not
   * the latest one.
   */
  const repoStateRef = useRef<RepositoryState | null>(null);

  const closeCurrentReader = useCallback(async () => {
    const toClose = new Set<string>();
    if (readerIdRef.current) toClose.add(readerIdRef.current);
    if (baselineRef.current) toClose.add(baselineRef.current.readerId);
    readerIdRef.current = null;
    baselineRef.current = null;
    await Promise.all([...toClose].map((id) => api.closeReader(id).catch(() => {})));
  }, [api]);

  const loadMoreInternal = useCallback(
    async (generation: number) => {
      const readerId = readerIdRef.current;
      if (!readerId) return;
      setIsLoadingMore(true);
      try {
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
    async (nextFilter: CommitLogFilter, generation: number) => {
      if (!isEmptyFilter(nextFilter)) {
        if (baselineRef.current === null && readerIdRef.current) {
          // First time navigating away from the live unfiltered baseline into a filtered view:
          // park its reader (kept open, not closed) plus what's already loaded, for AC-10.
          baselineRef.current = {
            readerId: readerIdRef.current,
            rows: rowsRef.current,
            hasMore: hasMoreRef.current,
            laneAssigner: laneAssignerRef.current,
          };
        } else if (readerIdRef.current && readerIdRef.current !== baselineRef.current?.readerId) {
          // Re-filtering while already on a filtered view — the previous filtered reader isn't
          // cached anywhere else, so close it before replacing it.
          await api.closeReader(readerIdRef.current).catch(() => {});
        }
      }
      // nextFilter empty only happens from openRepo's very first load; clearFilter restores
      // from the baseline snapshot directly and never calls startReader.

      const readerResult = unwrap(await api.createLogReader(nextFilter));
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

  const refreshAuxData = useCallback(
    async (generation: number) => {
      const [refsResult, upstreamResult, statusResult] = await Promise.all([
        api.getRefs(),
        api.getUpstreamBranch(),
        api.getWorkingDirStatus(),
      ]);
      if (generation !== generationRef.current) return;
      setRefs(unwrap(refsResult));
      setUpstreamShortName(unwrap(upstreamResult));
      setWorkingDirStatus(unwrap(statusResult));
    },
    [api],
  );

  const openRepo = useCallback(
    async (path: string, initialFilter: CommitLogFilter = {}) => {
      const generation = ++generationRef.current;
      // Bumped unconditionally (success or failure) — see this field's doc comment: a caller
      // keying a per-repo panel on it must remount on every attempt, not just a successful one.
      // All of these synchronous resets (including `setFilter`) fire *before* the
      // `closeCurrentReader()` await below, deliberately — React only batches state updates that
      // happen within the same tick, and `closeCurrentReader()` is a real async IPC round trip.
      // A caller like `FilterBar` that resets its own local state off `openSequence` changing
      // (specs/multi-repo-tabs.md's Bug 2 fix) needs `filter` to have already landed by the same
      // render `openSequence` does, or it reads a stale value.
      setOpenSequence((n) => n + 1);
      setStatus("opening");
      setErrorMessage(null);
      setSelectedSha(null);
      setCommitDetail({ status: "idle" });
      setHasExternalChanges(false);
      setFilter(initialFilter);
      await closeCurrentReader();
      try {
        const opened = unwrap(await api.openRepo(path));
        if (generation !== generationRef.current) return;
        setRepoPath(opened.path);
        setRepoState(opened.state);
        await refreshAuxData(generation);
        await startReader(initialFilter, generation);
        if (generation === generationRef.current) setStatus("ready");
      } catch (err) {
        if (generation !== generationRef.current) return;
        setStatus("error");
        setErrorMessage(err instanceof Error ? err.message : String(err));
      }
    },
    [api, closeCurrentReader, refreshAuxData, startReader],
  );

  const openRepoViaDialog = useCallback(async () => {
    const path = unwrap(await api.openRepoDialog());
    if (path) await openRepo(path);
  }, [api, openRepo]);

  const closeRepo = useCallback(async () => {
    generationRef.current += 1;
    setOpenSequence((n) => n + 1);
    await closeCurrentReader();
    setStatus("idle");
    setErrorMessage(null);
    setRepoPath(null);
    setRepoState(null);
    setRefs([]);
    setUpstreamShortName(null);
    setWorkingDirStatus(null);
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
  }, [closeCurrentReader]);

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
      // No parked baseline to restore (e.g. the very first filter applied hasn't resolved yet,
      // or this is somehow called with nothing loaded) — fall back to a normal filtered fetch.
      applyFilter({});
      return;
    }
    // AC-10: restore the previously-loaded unfiltered view instead of reloading from scratch —
    // no new createLogReader call, no reset of already-loaded rows/scroll position.
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

  const refresh = useCallback(async () => {
    setHasExternalChanges(false);
    if (repoPath) await openRepo(repoPath);
  }, [openRepo, repoPath]);

  const refreshWorkingDirStatus = useCallback(async () => {
    const generation = generationRef.current;
    const result = await api.getWorkingDirStatus();
    if (generation !== generationRef.current) return;
    setWorkingDirStatus(unwrap(result));
  }, [api]);

  const refreshRefs = useCallback(async () => {
    const generation = generationRef.current;
    const [stateResult, refsResult, upstreamResult] = await Promise.all([
      api.getState(),
      api.getRefs(),
      api.getUpstreamBranch(),
    ]);
    if (generation !== generationRef.current) return;
    setRepoState(unwrap(stateResult));
    setRefs(unwrap(refsResult));
    setUpstreamShortName(unwrap(upstreamResult));
  }, [api]);

  const selectCommit = useCallback(
    (sha: string | null) => {
      setSelectedSha(sha);
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

  useEffect(() => {
    repoStateRef.current = repoState;
  }, [repoState]);

  // Best-effort FR-6 auto-detect, extended by FR-59/AC11 (specs/merge-rebase-conflict-
  // resolution.md) to distinguish two cases the underlying watcher (`watchRepositoryRefs` in
  // git-core, which fires one debounced `onChange` for both HEAD/refs/packed-refs churn *and*
  // MERGE_HEAD/CHERRY_PICK_HEAD/REVERT_HEAD/rebase-merge/rebase-apply churn — see its doc comment)
  // cannot itself tell apart, since its callback carries no payload identifying which path
  // triggered it:
  //  1. Ordinary ref/commit-graph churn (a teammate pushed, a hook ran, a branch moved) — surface
  //     the "History changed outside GitHydra. [Refresh]" banner rather than silently yanking the
  //     graph out from under a mid-scroll/mid-selection user. Manual refresh (always available
  //     regardless of this) actually reloads. Unchanged from the original FR-6 behavior.
  //  2. A change specifically to in-progress-operation state — this must auto-refresh silently,
  //     no manual click required, since a stale conflict-resolution banner is actively dangerous
  //     (a user could act on wrong information about what state the repo is in), unlike stale
  //     graph decoration, which is merely inconvenient.
  // Since the watcher's own event carries no "which path" info, case 2 is detected here instead by
  // re-reading `RepositoryState` (cheap — every git-core read is live off disk, no caching layer)
  // on every debounced fire and comparing its `inProgressOperation`/`inProgressOperationDetail`
  // against the last known snapshot (`repoStateRef`, synced above). A real difference there means
  // an operation started, progressed (e.g. `rebase --continue` advancing a step), or ended — apply
  // it (plus a working-dir-status re-fetch, for the conflicted-file count) immediately and
  // silently. No difference there means this fire was ordinary ref churn — fall back to case 1's
  // existing banner, without touching `repoState`/`workingDirStatus` (deliberately not
  // reconciling those here, to keep this path's behavior byte-for-byte what it was before FR-59).
  useEffect(() => {
    if (status !== "ready") return;
    return api.onRefsChanged(() => {
      const generation = generationRef.current;
      void (async () => {
        let nextState: RepositoryState;
        try {
          nextState = unwrap(await api.getState());
        } catch {
          // Repo state became unreadable (e.g. the repo was deleted out from under us) — treat
          // as ordinary churn; the existing banner + manual refresh remains the fallback, and
          // `refresh()` will surface the real error properly if the user clicks it.
          if (generation === generationRef.current) setHasExternalChanges(true);
          return;
        }
        if (generation !== generationRef.current) return; // superseded by a newer openRepo/close.

        const prev = repoStateRef.current;
        const operationChanged =
          !prev ||
          prev.inProgressOperation !== nextState.inProgressOperation ||
          JSON.stringify(prev.inProgressOperationDetail) !== JSON.stringify(nextState.inProgressOperationDetail);

        if (!operationChanged) {
          setHasExternalChanges(true);
          return;
        }

        setRepoState(nextState);
        // AC11: surface this operation-state change to callers so they can refresh anything else
        // that's operation-state-dependent but not owned by this hook (the Changes panel's own
        // conflicted-file list) — see this field's doc comment. Bumped regardless of whether the
        // working-dir-status re-fetch below succeeds; the list refresh it triggers is best-effort
        // in the same way that re-fetch already is.
        setOperationStateChangeSequence((n) => n + 1);
        try {
          const statusResult = await api.getWorkingDirStatus();
          if (generation !== generationRef.current) return;
          setWorkingDirStatus(unwrap(statusResult));
        } catch {
          // Best-effort: the operation-state banner itself already updated (the part FR-59/AC11
          // requires); a failed conflicted-count re-fetch just leaves that count as of the last
          // successful read rather than blocking the banner update on it.
        }
      })();
    });
  }, [api, status]);

  useEffect(() => {
    return () => {
      void closeCurrentReader();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    selectedSha,
    selectCommit,
    commitDetail,
    hasExternalChanges,
    operationStateChangeSequence,
    openRepo,
    openRepoViaDialog,
    closeRepo,
    refresh,
    refreshWorkingDirStatus,
    refreshRefs,
  };
}
