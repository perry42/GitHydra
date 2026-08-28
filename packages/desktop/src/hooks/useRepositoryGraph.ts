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
  openRepo: (path: string) => Promise<void>;
  openRepoViaDialog: () => Promise<void>;
  refresh: () => Promise<void>;
  /** Cheap re-fetch of just the working-directory status counts (FR-30/FR-32: keeps the
   * uncommitted-changes pseudo-node's counts and the Toolbar's Changes badge in sync after a
   * stage/unstage/discard/commit, without re-querying the whole commit log). */
  refreshWorkingDirStatus: () => Promise<void>;
}

export function useRepositoryGraph(): UseRepositoryGraphResult {
  const api = useMemo(() => getGitHydraApi(), []);

  const [status, setStatus] = useState<RepoOpenStatus>("idle");
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
    async (path: string) => {
      const generation = ++generationRef.current;
      await closeCurrentReader();
      setStatus("opening");
      setErrorMessage(null);
      setSelectedSha(null);
      setCommitDetail({ status: "idle" });
      setHasExternalChanges(false);
      setFilter({});
      try {
        const opened = unwrap(await api.openRepo(path));
        if (generation !== generationRef.current) return;
        setRepoPath(opened.path);
        setRepoState(opened.state);
        await refreshAuxData(generation);
        await startReader({}, generation);
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

  // Best-effort FR-6 auto-detect: surface a "history changed" banner rather than silently
  // yanking the graph out from under a mid-scroll/mid-selection user. Manual refresh (always
  // available regardless of this) actually reloads.
  useEffect(() => {
    if (status !== "ready") return;
    return api.onRefsChanged(() => setHasExternalChanges(true));
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
    openRepo,
    openRepoViaDialog,
    refresh,
    refreshWorkingDirStatus,
  };
}
