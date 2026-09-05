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
import { getGitHydraApi, unwrap, withGitLockRetry } from "./gitHydraClient";
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
 * Several independent read calls (`getState`/`getRefs`/`getUpstreamBranch`/
 * `getWorkingDirectoryChanges`/`listStashes`) are fired concurrently — here via `Promise.all`, and
 * fire-and-forget from the caller's own perspective (`refreshWorkingDirStatus`/`refreshRefsAndRows`
 * are themselves called as `void graph.refreshX()`) — right after a conflict resolve or
 * cherry-pick step settles. Several real `git`-equivalent child processes ending up spawned within
 * milliseconds of each other after the same event can transiently collide on Windows over
 * `.git/index` (or another git lock file) — see `isTransientGitLockError`'s doc comment in
 * `gitHydraClient.ts` for the two distinct error shapes observed directly (reproduced ~1 in 10-12
 * repeated runs of App.cherryPick.e2e.test.tsx's AC5/AC12, across TWO different failure surfaces: a
 * stuck "Continue is blocked" banner from a raced working-dir-status read, AND a stuck operation
 * banner after Continue actually completed, from a raced `getState`/`getRefs` — an earlier version
 * of this fix wrapped only the working-dir-status read and left the latter reproducing). Every read
 * in this module's `Promise.all` groups is wrapped in `withGitLockRetry` for that reason — any one
 * of them can be the one that transiently collides, and `unwrap()`ing an unretried failure here
 * throws synchronously (fire-and-forget callers never see it), leaving every piece of state this
 * function was about to refresh — not just the one that failed — stuck at its stale pre-refresh
 * value indefinitely, since nothing else is scheduled to correct it.
 *
 * ROADMAP.md tech-debt fix: this module used to *also* independently fetch the aggregate-counts
 * `WorkingDirectoryStatus` shape (`getWorkingDirStatus`, porcelain v1) here, back-to-back with
 * `useChangesPanel`'s own separate `getWorkingDirectoryChanges` fetch (porcelain v2, per-file
 * arrays) after every stage/unstage/discard/commit — two concurrent `git`-equivalent spawns for the
 * same underlying state, which is what actually caused the Windows lock collisions above (not just
 * a theoretical risk — reproduced directly). This hook is now the single owner of the per-file
 * fetch; `workingDirStatus` below is derived from it via `deriveWorkingDirStatus` (pure
 * `.length` derivation, proven equivalent by git-core-engineer — see that function's doc comment),
 * and `useChangesPanel` consumes the same fetched `WorkingDirectoryChanges` instead of fetching its
 * own.
 */
function getStateWithRetry(api: GitHydraApi) {
  return withGitLockRetry(() => api.getState());
}
function getRefsWithRetry(api: GitHydraApi) {
  return withGitLockRetry(() => api.getRefs());
}
function getUpstreamBranchWithRetry(api: GitHydraApi) {
  return withGitLockRetry(() => api.getUpstreamBranch());
}
function getWorkingDirectoryChangesWithRetry(api: GitHydraApi) {
  return withGitLockRetry(() => api.getWorkingDirectoryChanges());
}
function listStashesWithRetry(api: GitHydraApi) {
  return withGitLockRetry(() => api.listStashes());
}

/** True when a CommitLogFilter has no active restriction (the unfiltered/"baseline" view). */
function isEmptyFilter(filter: CommitLogFilter): boolean {
  return Object.values(filter).every((v) => (Array.isArray(v) ? v.length === 0 : !v));
}

/**
 * specs/stash.md FR-92/AC18: a cheap, order-sensitive fingerprint of `listStashes()`'s result —
 * `null` (bare repo) gets its own sentinel so it's never confused with "zero stashes". Comparing
 * this string is enough to detect any create/apply-that-drops/pop/drop anywhere in the list
 * without diffing structured objects field-by-field.
 */
function stashSignature(list: readonly { ref: string; sha: string }[] | null): string {
  if (list === null) return "\0bare";
  return list.map((s) => `${s.ref}:${s.sha}`).join(",");
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

/**
 * specs/repo-open-feedback.md FR-168: everything `openRepo` resets *synchronously*, before its
 * first `await`, captured right before that reset so a cancelled attempt can restore it exactly.
 * Deliberately does NOT include `repoPath`/`repoState`/`refs`/`upstreamShortName`/
 * `workingDirChanges`/`rows`/`hasMore`/`showAllRefs`/the log reader — `openRepo` never touches any
 * of those until AFTER it's confirmed the attempt actually settled (not cancelled), so on a
 * cancellation they're simply never disturbed in the first place and need no explicit restore (see
 * `openRepo`'s own implementation for where that "don't touch until settled" ordering happens).
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

/**
 * specs/graph-head-indicator-and-refresh-alerting.md Problem 2 (revises FR-59/AC11's original
 * silent-auto-refresh plan): set when the watcher detects an externally-caused change to
 * `inProgressOperation`/`inProgressOperationDetail` — an operation started, progressed, or ended
 * outside GitHydra. Unlike ordinary ref churn's `hasExternalChanges` (a plain boolean — any
 * banner copy for it is static), this needs to *name* the implicated operation, so it's carried
 * as its own small payload rather than another boolean.
 */
export interface OperationStateAlert {
  /** The operation the alert names: the newly-detected operation if one is now in progress,
   * otherwise the previously in-progress operation that just ended externally (e.g. an external
   * `abort`/`--continue` completing it) — see the watcher-change handler below for the derivation
   * and why at least one side is always non-null when this fires. */
  operation: Exclude<InProgressOperation, null>;
}

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
  /**
   * ROADMAP.md tech-debt fix: the full per-file working-directory data (Staged/Unstaged/
   * Untracked/Conflicted arrays) this hook fetches as the single owner of working-dir status —
   * `workingDirStatus` above is derived from this. Threaded down to `ChangesPanel`/
   * `useChangesPanel` so that hook no longer performs its own independent fetch of the same data;
   * `null` for a bare repository (no working directory), matching `workingDirStatus`'s convention.
   */
  workingDirChanges: WorkingDirectoryChanges | null;
  /** specs/stash.md FR-93: live count for the Toolbar's stash badge. `null` for a bare repo. */
  stashCount: number | null;
  selectedSha: string | null;
  selectCommit: (sha: string | null) => void;
  commitDetail: CommitDetailState;
  hasExternalChanges: boolean;
  /**
   * specs/graph-head-indicator-and-refresh-alerting.md Problem 2: non-null while an
   * externally-detected in-progress-operation change is unacknowledged — drives the distinct
   * operation-state alert banner (`StatusBanner`) and gates the conflict-resolution actions
   * (Continue/Abort/Accept Ours/Accept Theirs/Mark as resolved) until the user clicks that
   * banner's Refresh. Cleared by `refresh()`, same as `hasExternalChanges`.
   */
  operationStateAlert: OperationStateAlert | null;
  /**
   * `initialFilter` (specs/multi-repo-tabs.md Must-have 4): lets a caller reopen a repo directly
   * into a remembered non-empty filter (a tab switch replaying its remembered state) in one
   * reader creation, instead of opening unfiltered and immediately re-filtering — defaults to `{}`
   * (today's behavior) for every existing caller.
   *
   * specs/repo-open-feedback.md FR-168: resolves `true` if this specific attempt was canceled
   * (via `cancelOpen()`) — `false` for every other outcome (success, a genuine error, or this
   * attempt having been superseded by a newer `openRepo` call before it settled). Every existing
   * caller that doesn't care can keep ignoring the resolved value, same as before this was added;
   * `useRepoTabs.ts`'s call sites use it to roll back their own optimistic tab-bookkeeping (a new
   * tab entry, an in-place `repoPath` replacement) made before awaiting this call, which `graph`
   * itself has no visibility into and so can't roll back on the caller's behalf.
   *
   * `onSettled` (specs/repo-list.md AC6): see this function's own implementation doc comment on
   * the third parameter — an optional per-call "did this succeed or genuinely fail" hook for
   * callers that can't just poll `status` afterward.
   */
  openRepo: (
    path: string,
    initialFilter?: CommitLogFilter,
    onSettled?: (outcome: "opened" | "error") => void,
  ) => Promise<boolean>;
  openRepoViaDialog: () => Promise<void>;
  /**
   * specs/repo-open-feedback.md FR-167/FR-168: aborts whichever `openRepo` attempt is currently
   * in flight (a no-op if none is) — see `cancelOpen`'s own implementation doc comment. Every
   * `openRepo` entry point (native dialog, replace-tab, tab activation) funnels through this same
   * hook, so a caller never needs its own cancel wiring (FR-170).
   */
  cancelOpen: () => void;
  refresh: () => Promise<void>;
  /**
   * specs/multi-repo-tabs.md Must-have 8/AC9: tears down the live reader (same close path
   * `openRepo` uses) and resets every piece of state back to `"idle"` — for "no new repo is
   * replacing this one" cases: the last tab being closed, and (specs/repo-list.md, revised IA)
   * "+ New tab" deactivating the current tab to land on the idle landing screen.
   *
   * security review: also calls the `closeRepoSession` IPC channel, which closes every reader,
   * the ref-change file watcher, and clears the live `Repository` on the main-process side —
   * without this, that watcher stayed alive (firing `refsChangedEvent` for no live UI to act on)
   * for as long as the app sat idle afterward, since the only other place a watcher gets torn
   * down is the top of the *next* real `openRepo` call, or the whole window/app closing.
   */
  closeRepo: () => Promise<void>;
  /** Cheap re-fetch of just the working-directory status counts (FR-30/FR-32: keeps the
   * uncommitted-changes pseudo-node's counts and the Toolbar's Changes badge in sync after a
   * stage/unstage/discard/commit, without re-querying the whole commit log). */
  refreshWorkingDirStatus: () => Promise<void>;
  /** specs/stash.md FR-93/FR-101: cheap re-fetch of just the stash count (Toolbar badge), and the
   * watcher's own external-change baseline for it — call after any successful stash mutation. */
  refreshStashList: () => Promise<void>;
  /**
   * FR-56: cheap re-fetch of repo state + refs + upstream (current-branch indicator, ref chips,
   * HEAD decoration) after a branch create/switch/delete — deliberately does NOT reset the
   * already-loaded commit rows/scroll position/lane assignment the way `refresh()` does, since a
   * branch mutation never changes which commits exist, only which refs point at them (the
   * default, unfiltered view already includes every branch's commits — see `CommitLogFilter`'s
   * doc comment). Cheaper and less disruptive than a full `refresh()` for this specific case.
   */
  /**
   * `expected` (specs/self-write-refresh-suppression.md AC5 fix): when this call is closing an
   * in-flight mutation's gate (see `beginMutation`) and the caller knows the operation's real
   * outcome (e.g. `switchTo`/`checkoutCommit` passing their `SwitchResult.sha` + the branch name
   * they targeted), this is compared against the actual pre-to-post ref/HEAD diff — an exact match
   * is folded into the new baseline silently; any additional/unexpected change still sets
   * `hasExternalChanges`. Omitted for callers with no gate open (plain manual refresh) or no known
   * outcome (a failed mutation closing its gate via `onMutationSettled`, where "nothing should
   * have changed" is the correct expectation instead — see `refreshRefs`'s implementation).
   */
  refreshRefs: (expected?: ExpectedRefOutcome) => Promise<void>;
  /**
   * specs/cherry-pick.md FR-121 / self-write-refresh-suppression.md FR-6b: the settle path for an
   * app-initiated operation that both (a) closes a `beginMutation()` gate using the same FIFO
   * shift `refreshRefs` uses — but, when `expected` is omitted, diffing against
   * `hasUnexpectedRefChangeBeyondCurrentBranch` rather than `refreshRefs`'s `noChangeExpected`
   * fallback, since unlike `refreshRefs`'s callers, this one's always *do* change HEAD/refs on
   * success, just not by a predictable amount (see this function's own implementation comment for
   * the full reasoning, including why skipping the diff entirely — an earlier version's approach —
   * was a real AC5 false-negative, not just a simplification) — and (b) also reloads the
   * commit-row list in place, because unlike an ordinary branch switch, a
   * cherry-pick step (or a merge/rebase Continue) can create new commits the already-loaded rows
   * don't have. Deliberately does *not* go through `openRepo()`: it never
   * touches `status` (so `MainArea`'s `status === "opening"` branch never displaces the graph) or
   * `openSequence` (so no per-repo panel keyed on it — `ChangesPanel`, `DetailPanel` —
   * force-remounts). Row reload does still reset pagination to the first page and re-fetch from
   * the current HEAD, same as `refresh()` always has — only the "which React subtree survives"
   * behavior changes here, not the "how much history is loaded" behavior. Use this (not the
   * heavier `refresh()`) for any settle callback that can fire while the user may be mid-
   * interaction in a panel that key/condition on `openSequence`/`status` — a paused operation's
   * conflict view being the concrete case that surfaced this.
   */
  refreshRefsAndRows: (expected?: ExpectedRefOutcome) => Promise<void>;
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
   * specs/self-write-refresh-suppression.md FR-6b: call once, synchronously, at the moment an
   * app-initiated mutating git call (switchBranch, checkoutCommit, and similar) is *issued* —
   * before awaiting its result. Captures the current last-confirmed ref/HEAD snapshot as this
   * operation's pre-mutation baseline (queued, FIFO) so its eventual `refreshRefs()` call can diff
   * against it (AC5 fix — see `selfWriteGate.ts`) instead of blindly trusting the entire fresh
   * post-mutation read as self-caused. A watcher-fired fs event that lands anywhere in the
   * operation's lifecycle is simply ignored while the gate is open — `refreshRefs()`'s own diff is
   * always the decisive check once it resolves, so there's nothing useful for a watcher event to
   * do mid-flight. Every call must be eventually followed by a `refreshRefs()` call for the same
   * operation, or its gate never closes (and the queued baseline for any *later* operation is
   * skipped past it, not lost — see `refreshRefs`'s FIFO `shift()`).
   */
  beginMutation: () => void;
}

export interface UseRepositoryGraphOptions {
  /**
   * specs/repo-list.md Must-have 1: called once, synchronously, right after `status` is set to
   * `"ready"` for any `openRepo` attempt that actually succeeds — never for a cancelled attempt,
   * a genuine error, or an attempt superseded by a newer one before it settled (the same
   * `generation` guard every other post-settle side effect in `openRepo` already uses). Every open
   * entry point (native dialog, replace-active-tab, tab activate/switch, a recent-repo-list click)
   * funnels through this one `openRepo`, so this is the single place "a repo was successfully
   * opened" needs recording — callers that don't care (most existing tests) simply omit it.
   */
  onRepoOpened?: (path: string) => void;
}

export function useRepositoryGraph(options: UseRepositoryGraphOptions = {}): UseRepositoryGraphResult {
  const { onRepoOpened } = options;
  const api = useMemo(() => getGitHydraApi(), []);

  const [status, setStatus] = useState<RepoOpenStatus>("idle");
  const [openSequence, setOpenSequence] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [repoPath, setRepoPath] = useState<string | null>(null);
  const [repoState, setRepoState] = useState<RepositoryState | null>(null);
  const [refs, setRefs] = useState<RefInfo[]>([]);
  const [upstreamShortName, setUpstreamShortName] = useState<string | null>(null);
  // ROADMAP.md tech-debt fix: the single fetched source of truth for working-dir status — see
  // `getWorkingDirectoryChangesWithRetry`'s doc comment. `workingDirStatus` (the aggregate-counts
  // shape every existing consumer already expects) is derived from this via `useMemo` below rather
  // than kept as parallel state, so the two can never drift out of sync with each other.
  const [workingDirChanges, setWorkingDirChanges] = useState<WorkingDirectoryChanges | null>(null);
  const workingDirStatus = useMemo(() => deriveWorkingDirStatus(workingDirChanges), [workingDirChanges]);
  // specs/stash.md FR-93: cheap count for the Toolbar's stash badge — `null` for a bare
  // repository (no working directory, matching `workingDirStatus`'s own bare-repo convention),
  // fetched alongside the other cheap "confirmed read" data in `refreshAuxData` below.
  const [stashCount, setStashCount] = useState<number | null>(null);
  const [rows, setRows] = useState<LaidOutRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [filter, setFilter] = useState<CommitLogFilter>({});
  const [showAllRefs, setShowAllRefs] = useState(false);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [commitDetail, setCommitDetail] = useState<CommitDetailState>({ status: "idle" });
  const [hasExternalChanges, setHasExternalChanges] = useState(false);
  // specs/graph-head-indicator-and-refresh-alerting.md Problem 2 — see `OperationStateAlert`'s own
  // doc comment. Cleared by `refresh()`, same as `hasExternalChanges`.
  const [operationStateAlert, setOperationStateAlert] = useState<OperationStateAlert | null>(null);

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
  /**
   * specs/repo-open-feedback.md FR-167/FR-168: the `requestId` of the currently in-flight
   * `openRepoCancellable` attempt (the stringified `generation` that started it — already
   * unique-per-attempt, see `generationRef`), or `null` when no open is in flight. Set
   * synchronously the moment an attempt starts, cleared once it settles (success, error, or
   * cancelled) or is superseded by a newer attempt — `cancelOpen` below reads it to know what to
   * pass `api.cancelOpenRepo()`. Uniform across every caller (`openRepo` is the single funnel every
   * entry point — dialog, replace-tab, tab-switch/activate — goes through, FR-170), so there is
   * nothing for any individual caller to special-case.
   */
  const activeOpenRequestIdRef = useRef<string | null>(null);
  /** Separate counter for commit-detail selection races (rapid A -> B clicks), independent of
   * the repo-open/filter generation above. */
  const selectionGenerationRef = useRef(0);
  // --- specs/self-write-refresh-suppression.md FR-6a/FR-6b state (see selfWriteGate.ts for the
  // actual diff logic) ---
  /** FR-6a: the full ref/HEAD snapshot from the last read GitHydra itself performed and trusted —
   * its own `openRepo`/`refresh`/`refreshRefs` calls, *and* every watcher-triggered comparison
   * (match or mismatch — see that doc comment). Null only before the very first repo-open read has
   * landed. A watcher-fired comparison is always against this, never against React's (possibly
   * stale, possibly not-yet-committed) `repoState`/`refs` state. */
  const lastConfirmedRef = useRef<RefHeadSnapshot | null>(null);
  /**
   * Bumped every time `lastConfirmedRef.current` is written, anywhere. A security review of the
   * AC5 false-negative fix (specs/self-write-refresh-suppression.md) found that
   * `evaluateWatcherEvent`'s own re-check of `pendingMutationsRef.current.length` only proves "no
   * gate is open *right now*" — not "this function's own in-flight fetch is still current". A
   * watcher event can start its fetch while idle, and a *complete* self-caused mutation cycle
   * (`beginMutation` -> mutating call -> `refreshRefs`/`refreshRefsAndRows`) can start and finish
   * entirely within that fetch's flight time — closing the gate again before the watcher's fetch
   * resolves, so the gate-only re-check sees "empty" and wrongly treats the read as still current.
   * Every write to `lastConfirmedRef` (including `evaluateWatcherEvent`'s own) bumps this counter;
   * `evaluateWatcherEvent` captures it before dispatching its fetch and refuses to act on — or
   * overwrite `lastConfirmedRef` with — a result whose captured value has since gone stale.
   */
  const confirmedGenerationRef = useRef(0);
  /** FR-6b/AC5 fix: one entry per app-initiated mutation currently between "issued" and "its own
   * confirming `refreshRefs()` read resolved" — see `beginMutation`. Each entry is the pre-mutation
   * baseline (`lastConfirmedRef.current` at the moment `beginMutation` was called) that operation's
   * eventual `refreshRefs()` diffs its fresh read against. A FIFO queue (not just a counter) so
   * `refreshRefs()` has the actual snapshot to diff against, not just a count; operations are
   * effectively serialized by the UI's own row-level busy state, so FIFO order matches issue order
   * in practice, but the queue structurally tolerates overlap too. */
  const pendingMutationsRef = useRef<Array<{ pre: RefHeadSnapshot | null }>>([]);
  /**
   * specs/stash.md FR-92/AC18: `refs/stash` is deliberately excluded from `RefInfo`/`getRefs()`
   * (see git-core's `refs.ts`), so an app-initiated stash mutation never shows up in
   * `RefHeadSnapshot`'s ordinary ref/HEAD diff above — that diff alone can't detect a stash
   * change at all, self-caused or external. This is a parallel, independent "last confirmed"
   * baseline for exactly that: a cheap signature (`stashSignature` below) of the current stash
   * list, established by every confirmed read (`refreshAuxData`, `refreshStashList`,
   * `evaluateWatcherEvent`'s own confirming fetch) and diffed the same "alert, don't silently
   * apply" way idle ref churn already is. `null` only before the very first confirmed read of a
   * freshly-opened repo (never flags, same convention as `lastConfirmedRef`).
   */
  const lastConfirmedStashSigRef = useRef<string | null>(null);

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

  /** FR-6a: records a read GitHydra itself just performed/trusts as the new comparison baseline
   * for the next watcher-fired event. */
  const recordConfirmedSnapshot = useCallback((state: RepositoryState, freshRefs: RefInfo[]) => {
    lastConfirmedRef.current = { state, refs: freshRefs };
    confirmedGenerationRef.current += 1;
  }, []);

  const refreshAuxData = useCallback(
    async (generation: number, snapshotState?: RepositoryState) => {
      const [refsResult, upstreamResult, changesResult, stashResult] = await Promise.all([
        getRefsWithRetry(api),
        getUpstreamBranchWithRetry(api),
        getWorkingDirectoryChangesWithRetry(api),
        listStashesWithRetry(api),
      ]);
      if (generation !== generationRef.current) return;
      const freshRefs = unwrap(refsResult);
      setRefs(freshRefs);
      setUpstreamShortName(unwrap(upstreamResult));
      setWorkingDirChanges(unwrap(changesResult));
      // specs/stash.md FR-93/FR-92: fetched alongside the other cheap "confirmed read" data on
      // every repo open/full refresh, and recorded as the new watcher-comparison baseline the
      // same way `recordConfirmedSnapshot` does for refs/HEAD below.
      const freshStashList = unwrap(stashResult);
      setStashCount(freshStashList === null ? null : freshStashList.length);
      lastConfirmedStashSigRef.current = stashSignature(freshStashList);
      // `snapshotState` is only passed by `openRepo` (the one caller that also has a fresh
      // `RepositoryState` on hand, from `api.openRepo`'s own return value) — this is "GitHydra's
      // own confirmed read" for FR-6a purposes exactly as much as `refreshRefs`'s is.
      if (snapshotState) recordConfirmedSnapshot(snapshotState, freshRefs);
    },
    [api, recordConfirmedSnapshot],
  );

  /**
   * specs/stash.md FR-93/FR-101: cheap re-fetch of just the stash count, mirroring
   * `refreshWorkingDirStatus()` — called after any successful stash create/apply/pop/drop
   * (directly from that mutation's own result, per FR-92, never by way of the watcher) so the
   * Toolbar's badge and the watcher's own external-change baseline both stay current without a
   * full `refresh()`.
   */
  const refreshStashList = useCallback(async () => {
    const generation = generationRef.current;
    const result = await listStashesWithRetry(api);
    if (generation !== generationRef.current) return;
    const list = unwrap(result);
    setStashCount(list === null ? null : list.length);
    lastConfirmedStashSigRef.current = stashSignature(list);
  }, [api]);

  const openRepo = useCallback(
    async (
      path: string,
      initialFilter: CommitLogFilter = {},
      /**
       * specs/repo-list.md AC6: an optional per-call hook invoked once *this specific* attempt
       * settles into a real, non-cancelled outcome — `"opened"` on success, `"error"` on a
       * genuine failure (path deleted/moved/no longer a valid git repo). Never called for a
       * cancelled attempt (already distinguishable via this function's own boolean return value)
       * or one superseded by a newer attempt before settling. Exists for callers that need to know
       * "did this specific path actually fail to open" right after `await`ing this call — the
       * recent-repo-list click handlers in `useRepoTabs.ts` — without racing React's asynchronous
       * `status` state, which is not guaranteed to have re-rendered by the time the awaiting
       * caller's next line runs.
       */
      onSettled?: (outcome: "opened" | "error") => void,
    ) => {
      const generation = ++generationRef.current;
      // specs/repo-open-feedback.md FR-163/FR-167/FR-168: `requestId` correlates this attempt with
      // a later `cancelOpenRepo(requestId)` call — the stringified `generation` is already unique
      // per attempt for the app's lifetime, so it doubles as the id with no separate counter.
      const requestId = String(generation);
      activeOpenRequestIdRef.current = requestId;
      // FR-168: a snapshot of exactly what the synchronous reset below is about to overwrite — see
      // `OpenAttemptSnapshot`'s own doc comment for why nothing else needs capturing here (every
      // other piece of state is left untouched until the attempt is confirmed to have actually
      // settled, further down).
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
      };
      // Bumped unconditionally (success, failure, or cancelled) — see this field's doc comment: a
      // caller keying a per-repo panel on it must remount on every attempt, not just a successful
      // one. All of these synchronous resets (including `setFilter`) fire *before* the
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
      setOperationStateAlert(null);
      setFilter(initialFilter);
      // FR-6b: a fresh repo-open starts with a clean gate — nothing is in flight yet, and any
      // pre-mutation baseline queued against the *previous* repo's snapshot is meaningless once
      // it's gone.
      pendingMutationsRef.current = [];
      lastConfirmedRef.current = null;
      confirmedGenerationRef.current += 1;
      lastConfirmedStashSigRef.current = null;
      setStashCount(null);
      // Deliberately NOT closing the previous reader (or touching repoPath/repoState/refs/
      // upstreamShortName/workingDirChanges/rows/hasMore) yet — FR-168: if this attempt gets
      // cancelled, whatever repo/reader was live before it started must still be exactly as usable
      // as it was, not torn down out from under a "return to what was showing before" restore.
      const outcome: OpenRepoOutcome = await api.openRepoCancellable(path, requestId);
      // Superseded by a newer attempt — that attempt owns the UI/any bookkeeping now, so this one
      // reports "not cancelled" (nothing for a caller like `useRepoTabs` to roll back on its end;
      // rolling back here could stomp on the newer attempt's own in-flight changes).
      if (generation !== generationRef.current) return false;
      if (activeOpenRequestIdRef.current === requestId) activeOpenRequestIdRef.current = null;

      if (outcome.outcome === "cancelled") {
        // FR-168/FR-169: restore exactly what was showing before this attempt started — never the
        // canceled attempt's error or ready state. The reader/repoPath/repoState/refs/etc. above
        // were never touched, so only the synchronously-reset fields need putting back.
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
        // Lets a caller that made its own optimistic bookkeeping change before awaiting this call
        // (`useRepoTabs`'s tab-array/active-tab updates — a new tab entry, a replaced tab's
        // `repoPath`) roll that back too — see its own call sites for what each rolls back and why.
        return true;
      }

      await closeCurrentReader();
      try {
        const opened = unwrap(outcome.result);
        if (generation !== generationRef.current) return false;
        setRepoPath(opened.path);
        setRepoState(opened.state);
        await refreshAuxData(generation, opened.state);
        await startReader(initialFilter, generation);
        if (generation === generationRef.current) {
          setStatus("ready");
          onRepoOpened?.(opened.path);
          onSettled?.("opened");
        }
      } catch (err) {
        if (generation !== generationRef.current) return false;
        setStatus("error");
        setErrorMessage(err instanceof Error ? err.message : String(err));
        onSettled?.("error");
      }
      return false;
    },
    [
      api,
      closeCurrentReader,
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
    ],
  );

  const openRepoViaDialog = useCallback(async () => {
    const path = unwrap(await api.openRepoDialog());
    if (path) await openRepo(path);
  }, [api, openRepo]);

  /**
   * specs/repo-open-feedback.md FR-167/FR-168/AC9: the spinner's Cancel affordance — aborts the
   * currently in-flight `openRepo` attempt, if any. A no-op if nothing is in flight (e.g. the
   * attempt already settled a moment before the click landed), and safe to call more than once —
   * `api.cancelOpenRepo` is itself idempotent (see its own doc comment) — so this needs no
   * confirmation step and stays a single, instantly re-triggerable click.
   */
  const cancelOpen = useCallback(() => {
    const requestId = activeOpenRequestIdRef.current;
    if (!requestId) return;
    void api.cancelOpenRepo(requestId);
  }, [api]);

  const closeRepo = useCallback(async () => {
    generationRef.current += 1;
    setOpenSequence((n) => n + 1);
    // security review (specs/repo-list.md, revised IA): tear down the main-process session
    // (readers + the ref-change file watcher + the live `Repository`) *before* the rest of this
    // function's own async gap opens, so a watcher event already mid-flight for the repo being
    // abandoned has as small a window as possible to still fire — and once this resolves, there is
    // no live watcher left to fire at all. Awaited (not fire-and-forget) so a caller that awaits
    // `closeRepo()` itself (`useRepoTabs`'s `newTab()`/last-tab-close path) knows the real teardown
    // has actually happened, not just that this hook's own renderer-side state was reset.
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
    // FR-6b: same reasoning as `openRepo`'s reset — no repo open means nothing to gate.
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
    // specs/graph-head-indicator-and-refresh-alerting.md Problem 2 AC5: one click clears both
    // banner variants' staleness — `openRepo` below re-fetches repoState/refs/workingDirStatus/
    // rows from scratch, so whatever either flag was warning about is fully resolved by the same
    // refetch, not just dismissed.
    setHasExternalChanges(false);
    setOperationStateAlert(null);
    if (repoPath) await openRepo(repoPath);
  }, [openRepo, repoPath]);

  const refreshWorkingDirStatus = useCallback(async () => {
    const generation = generationRef.current;
    const result = await getWorkingDirectoryChangesWithRetry(api);
    if (generation !== generationRef.current) return;
    setWorkingDirChanges(unwrap(result));
  }, [api]);

  /**
   * FR-6a: the actual watcher-fired comparison — always a *fresh* read (never a reuse of
   * possibly-stale values captured when the watcher event originally fired), compared against the
   * last snapshot GitHydra itself confirmed. Only reachable while no mutation gate is open (see the
   * `onRefsChanged` effect below) — while one is open, `refreshRefs()`'s own diff against the
   * operation's actual expected outcome is the decisive check (AC5 fix), so a watcher event
   * arriving mid-flight has nothing useful to do here.
   *
   * Also folds in specs/merge-rebase-conflict-resolution.md FR-59/AC11's operation-state detection
   * (revised by specs/graph-head-indicator-and-refresh-alerting.md Problem 2 to alert rather than
   * silently apply — see `operationStateAlert`'s own doc comment for the full reasoning). The
   * watcher's own event carries no "which path" info, so this single fetch is what distinguishes
   * the two cases the underlying `watchRepositoryRefs` fires one debounced event for:
   *  1. Ordinary ref/commit-graph churn (a teammate pushed, a hook ran, a branch moved) — the
   *     self-write-suppression expected-diff comparison (`hasUnexpectedRefChange`) decides; a real
   *     mismatch sets `hasExternalChanges`, never touching `repoState`/`refs` (FR-6's "alert, don't
   *     silently apply" precedent).
   *  2. A change specifically to in-progress-operation state — surfaces `operationStateAlert`
   *     instead, deliberately *not* running the ordinary-churn diff (an operation starting/
   *     progressing/ending is expected to move refs too; that's not a "real" mismatch to alert
   *     on separately). `lastConfirmedRef` is still advanced so the *next* ordinary-churn
   *     comparison — once this alert is dismissed via Refresh — isn't comparing against
   *     pre-operation-change data.
   * Only one case's flag is set per fire.
   */
  const evaluateWatcherEvent = useCallback(async () => {
    const generation = generationRef.current;
    // A second security-review finding on the AC5 fix: the gate-openness re-check below only
    // proves "no mutation is in flight *right now*" — not "this function's own fetch, dispatched
    // moments ago, is still current". A *complete* self-caused mutation cycle (`beginMutation` ->
    // mutating call -> `refreshRefs`/`refreshRefsAndRows`) can start and finish entirely within
    // this fetch's flight time, closing the gate again and updating `lastConfirmedRef` before this
    // read resolves — the gate-only check would see "empty" and wrongly treat a now-stale read as
    // current. Captured before dispatch, checked after resolve, against `confirmedGenerationRef`
    // (bumped on every `lastConfirmedRef` write, including this function's own two below).
    const confirmedGenerationAtStart = confirmedGenerationRef.current;
    let nextState: RepositoryState;
    let nextRefs: RefInfo[];
    let nextStashList: StashInfo[] | null;
    try {
      // A security review of the git-lock-retry fix found this Promise.all still called the raw,
      // non-retrying API methods, unlike every other read in this file — a transient collision
      // here (this is exactly the "watcher-triggered comparison firing right as a just-settled
      // mutation's disk activity is still occurring" case the retry fix was for) became an
      // unhandled rejection instead of the graceful fallback below. Using the *WithRetry helpers
      // closes that gap; the `unwrap()`s are now inside this same try so a failure that survives
      // the one retry also degrades to "treat as ordinary churn" rather than throwing uncaught.
      const [stateResult, refsResult, stashResult] = await Promise.all([
        getStateWithRetry(api),
        getRefsWithRetry(api),
        listStashesWithRetry(api),
      ]);
      nextState = unwrap(stateResult);
      nextRefs = unwrap(refsResult);
      nextStashList = unwrap(stashResult);
    } catch {
      // Repo state became unreadable (e.g. the repo was deleted out from under us), or a
      // transient lock collision survived the one retry — treat as ordinary churn; the existing
      // banner + manual refresh remains the fallback, and `refresh()` will surface the real error
      // properly if the user clicks it.
      if (generation === generationRef.current) setHasExternalChanges(true);
      return;
    }
    if (generation !== generationRef.current) return;
    // A new `beginMutation()` can land while this function's own fetch was in flight — the guard
    // at this callback's registration site only checked the gate at the *instant the watcher event
    // fired*, not at the instant this async read actually resolves. Without this second check, a
    // watcher event for residual disk settling from an operation GitHydra itself just finished
    // (its own gate already closed) can still be mid-flight exactly when the *next* gated action
    // opens a new one — and finish afterward, misattributing that stale read to "changed outside
    // GitHydra" for an action GitHydra is now in the middle of causing itself. Once any gate is
    // open, this read's verdict is stale by definition: the operation now in flight has its own
    // `refreshRefs`/`refreshRefsAndRows` settle call coming, which will correctly account for
    // everything (including anything genuinely external that raced in) once it closes.
    if (pendingMutationsRef.current.length > 0) return;
    // The complementary check for the case above's own doc comment: no gate is open, but the
    // confirmed baseline has moved since this fetch was dispatched anyway (a full mutation cycle
    // completed within our flight time, or another `evaluateWatcherEvent` call already landed).
    if (confirmedGenerationRef.current !== confirmedGenerationAtStart) return;
    // specs/stash.md FR-91/AC18: `refs/stash` changes fire this same debounced watcher event
    // (FR-91) but are invisible to the ordinary ref/HEAD diff below (`refs/stash` is deliberately
    // excluded from `RefInfo` — see `stashSignature`'s doc comment) — compared separately here so
    // an external stash create/apply/pop/drop still surfaces the same generic banner, unchanged.
    const nextStashSig = stashSignature(nextStashList);

    // FR-59/AC11 (specs/merge-rebase-conflict-resolution.md): "the in-progress-operation identity
    // actually changed" needs `prev` to be GitHydra's own last-*confirmed* read, not React's
    // (possibly not-yet-committed) `repoState` state — reading `repoState` directly here would see
    // whatever value was live at this callback's *registration* time, and even a ref manually kept
    // in sync via a `useEffect([repoState])` still lags a real render+effect cycle behind
    // `setRepoState`, a gap a security review surfaced concretely: once `StatusBanner`'s
    // Continue/Abort started gating the watcher via `beginMutation`/`onMutationSettled`, a late
    // watcher event firing in the narrow window after `refreshRefsAndRows` calls `setRepoState`
    // but before that effect had actually flushed would read a stale `prev`, spuriously flagging
    // Abort's own operation-ending write as an external change. `lastConfirmedRef` doesn't have
    // this gap — every confirming read (`openRepo`/`refresh`/`refreshRefs`/`refreshRefsAndRows`)
    // updates it via `recordConfirmedSnapshot`, a plain synchronous ref write, not a state setter.
    const prev = lastConfirmedRef.current?.state ?? null;
    const operationChanged =
      !prev ||
      prev.inProgressOperation !== nextState.inProgressOperation ||
      JSON.stringify(prev.inProgressOperationDetail) !== JSON.stringify(nextState.inProgressOperationDetail);

    if (operationChanged) {
      // Name the operation for the alert copy: prefer the newly-detected one (an operation started
      // or progressed), falling back to the previous one when it just ended externally (nextState's
      // is now null but the user still needs to know *what* just changed).
      const operation = nextState.inProgressOperation ?? prev?.inProgressOperation ?? null;
      if (operation) {
        lastConfirmedRef.current = { state: nextState, refs: nextRefs };
        confirmedGenerationRef.current += 1;
        lastConfirmedStashSigRef.current = nextStashSig;
        setOperationStateAlert({ operation });
        return;
      }
      // Defensive fallback only — `operationChanged` should never be true with both sides null,
      // but if it ever is, fall through to the ordinary-churn path rather than leaving no signal.
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
   * FR-6b: call this at the moment an app-initiated mutating git call (switchBranch,
   * checkoutCommit, ...) is *issued*, before awaiting it — not after it resolves. The disk write
   * that trips the fs watcher happens during that call, not after, so the gate has to already be
   * open by then. Every `beginMutation()` must be paired with an eventual `refreshRefs()` call
   * (directly or via `App.tsx`'s `refreshAfterBranchOp`) or the gate never closes for that
   * operation (see `pendingMutationsRef`'s doc comment).
   */
  const beginMutation = useCallback(() => {
    pendingMutationsRef.current.push({ pre: lastConfirmedRef.current });
  }, []);

  /**
   * specs/self-write-refresh-suppression.md AC5 fix: `expected` — when provided — is the specific
   * operation's own known outcome (see `UseRepositoryGraphResult.refreshRefs`'s doc comment). This
   * *is* "GitHydra's own confirming read": it always records the fresh read as the new baseline
   * (so display and the next comparison both reflect current reality, matched or not), but it no
   * longer does so *blindly* when closing a mutation's gate — it first diffs the fresh read against
   * that operation's pre-mutation baseline and its expected outcome (falling back to "nothing
   * should have changed" when no outcome was given, e.g. a failed mutation's `onMutationSettled`
   * path). Any change beyond that still sets `hasExternalChanges`, exactly like a genuine external
   * change caught while idle — this is what closes the AC5 race: an external write that landed
   * during the operation's in-flight window can no longer be silently folded into the baseline.
   */
  const refreshRefs = useCallback(
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

      // specs/graph-head-indicator-and-refresh-alerting.md Addendum 2, Problem 1a: `rows`' per-row
      // `commit.refs` is captured once when each row is first loaded/paginated in (see
      // `loadMoreInternal`/`startReader`) and never otherwise kept in sync with `repoState`/`refs` —
      // without this, the *old* HEAD row can keep showing a leftover "HEAD (detached)" chip after a
      // checkout/branch-switch, contradicting the *new* row's live triangle marker (AC1/AC2). Only
      // the ref-decoration field is corrected here, on rows already in memory — no re-fetch of
      // commit objects, no change to how rows are decorated on initial load (both explicit
      // non-goals). Also covers the parked baseline snapshot (AC-10) so a stale chip doesn't
      // reappear after `clearFilter` restores it without a fresh query.
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

      // FIFO: this call may be closing an in-flight mutation's gate opened by `beginMutation` —
      // operations are effectively serialized by the UI's own row-level busy state, so issue order
      // matches resolution order in practice.
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
   * See this function's doc comment on `UseRepositoryGraphResult` for why it exists separately
   * from both `refreshRefs` (too light — never re-fetches rows, so a step that created new
   * commits wouldn't show them) and `refresh`/`openRepo` (too heavy — touches `status` and
   * `openSequence`, force-remounting any panel keyed/gated on either mid-interaction). Shares
   * `refreshRefs`'s FIFO-gate-close mechanics, but not its `expected`-or-`noChangeExpected`
   * fallback: `refreshRefs`'s callers either know their operation's exact outcome (switchTo/
   * checkoutCommit pass the target SHA) or are closing a gate after a *failed* mutation, where
   * "nothing should have changed" is the correct default. This function's callers (a cherry-pick
   * step settling, a merge/rebase Continue/Abort) are the opposite: they always *did* change
   * HEAD/refs on success, but by an outcome no caller here predicts in advance (an arbitrary
   * number of commits, an arbitrary conflict-resolution history) — `noChangeExpected` would flag
   * their own legitimate change as external on every single call (confirmed: this exact bug
   * briefly regressed AC1 and AC6 in `App.cherryPick.e2e.test.tsx` while this function still used
   * that fallback). The fix is not to skip the diff when `expected` is omitted — an earlier
   * version of this function did exactly that, and a security review correctly flagged it as an
   * AC5 false-negative (specs/self-write-refresh-suppression.md's "must not create false
   * negatives" non-goal): with no diff at all, an unrelated ref moved by a second process during
   * this exact settle window would be silently folded into the new trusted baseline, never
   * surfacing `hasExternalChanges`. Instead, an omitted `expected` falls back to
   * `hasUnexpectedRefChangeBeyondCurrentBranch` — every ref except the one this operation is
   * actually allowed to move (the currently-checked-out branch) must still match `pre` exactly;
   * only that one ref's movement is tolerated as unpredictable-but-expected. A caller that *does*
   * know its exact outcome can still pass `expected` for the stricter `hasUnexpectedRefChange`
   * check `refreshRefs` uses — no production caller currently does, but the option is preserved.
   */
  const refreshRefsAndRows = useCallback(
    async (expected?: ExpectedRefOutcome) => {
      const generation = generationRef.current;
      // Mirrors `refreshAuxData`'s full fetch set (refs/upstream/workingDirChanges/stashes), not
      // just `refreshRefs`'s narrower one — a settled cherry-pick/Continue/Abort can change the
      // conflicted-file count and stash list just as much as it changes refs, and the Toolbar's
      // "Changes, N pending" badge (and StashPanel's list) need this call to be the one thing that
      // keeps them current, same as `refresh()` always did.
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

      // FIFO: closes the gate like `refreshRefs` — always runs a diff (see this function's own
      // doc comment for why an omitted `expected` uses the looser current-branch-exempt check
      // rather than skipping verification).
      const pending = pendingMutationsRef.current.shift();
      if (pending) {
        const fresh: RefHeadSnapshot = { state: freshState, refs: freshRefs };
        const flagged = expected
          ? hasUnexpectedRefChange(pending.pre, fresh, expected)
          : hasUnexpectedRefChangeBeyondCurrentBranch(pending.pre, fresh);
        if (flagged) setHasExternalChanges(true);
      }

      recordConfirmedSnapshot(freshState, freshRefs);
    },
    [api, closeCurrentReader, startReader, filter, recordConfirmedSnapshot],
  );

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

  // Best-effort FR-6 auto-detect: surface a "history changed" banner (or, for an operation-state
  // change, the distinct `operationStateAlert`) rather than silently yanking the graph out from
  // under a mid-scroll/mid-selection/mid-conflict-resolution user. Manual refresh (always
  // available regardless of this) actually reloads. See `evaluateWatcherEvent`'s doc comment for
  // how the two cases are distinguished and why each is handled the way it is.
  //
  // specs/self-write-refresh-suppression.md FR-6a/FR-6b, AC5 fix: every fs-watch fire funnels
  // through here, but it no longer unconditionally alerts. While an app-initiated mutation is in
  // flight (`pendingMutationsRef` non-empty), the event is ignored outright — not deferred for a
  // later re-check — because that operation's own `refreshRefs()` call is guaranteed to run once
  // it resolves, and *that* diff (against the operation's actual expected outcome, per
  // `selfWriteGate.ts`) is always the decisive check; re-running a plain "did anything change"
  // comparison afterward against a baseline `refreshRefs()` had *already* updated is exactly the
  // bug this fix closes (it silently absorbed a concurrent external change into that same update).
  // While idle, a watcher event is evaluated immediately via `evaluateWatcherEvent`'s fresh
  // comparison, exactly as a genuine external change always was.
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
    workingDirChanges,
    stashCount,
    selectedSha,
    selectCommit,
    commitDetail,
    hasExternalChanges,
    operationStateAlert,
    openRepo,
    openRepoViaDialog,
    cancelOpen,
    closeRepo,
    refresh,
    refreshWorkingDirStatus,
    refreshStashList,
    refreshRefs,
    refreshRefsAndRows,
    beginMutation,
  };
}
