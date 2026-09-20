// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import type { GitHydraApi } from "../../shared/ipcContract";
import { unwrap } from "./gitHydraClient";

export interface UsePushTargetOptions {
  api: GitHydraApi;
  /** Only reads while a repo is genuinely, fully open — the same `graph.status === "ready"` gate
   * `useCurrentBranchUpstream`/`useDivergedBranches` already use. */
  enabled: boolean;
  /** The current branch's short name, or `null` for a bare repo/detached HEAD/unborn branch. */
  currentBranch: string | null;
  /** Bumped whenever branch/ref state might have changed — the same `reloadToken` convention
   * `useCurrentBranchUpstream`/`useDivergedBranches` already established. */
  reloadToken?: number;
}

export interface UsePushTargetResult {
  /** specs/online-sync-push.md FR-345: every remote name `git remote` currently lists, in git's
   * own order. `"loading"` before the first read resolves. */
  remotes: readonly string[] | "loading";
  /** FR-345: whether the remote picker should render at all — more than one remote configured. A
   * single-remote (or zero-remote) repo has nothing to pick between. */
  showRemotePicker: boolean;
  /** The remote a push currently targets. Defaults to the current branch's already-configured
   * upstream remote when one is known (so a plain click on Push preserves whatever remote the
   * branch already tracks, never silently re-points it to an arbitrary "first" remote), falling
   * back to the first configured remote otherwise. `null` only while still loading or when there
   * are no remotes at all. */
  selectedRemote: string | null;
  /** FR-345: an explicit user choice from the picker — persists across reloads until the user
   * picks again or the previously-selected remote stops being configured (at which point the
   * default above takes back over). */
  setSelectedRemote: (remoteName: string) => void;
  /** specs/online-sync-push.md FR-347: the current branch's own `behind` count against ITS
   * CONFIGURED upstream (from `listBranches()`), or `null` when unknown/not applicable (no
   * upstream, still loading). Only meaningful for a push to `trackedRemoteName` specifically — a
   * push to a different remote isn't known to be behind anything from this data. */
  behind: number | null;
  /**
   * toolbar-action-row redesign: the current branch's own `ahead` count, from the exact same
   * `listBranches()` read `behind` above already makes — no new git-core call/IPC, just exposing a
   * field that call already returns. Drives the Toolbar's Push segment's ahead-count pill, the
   * mirror of `behind` driving Pull's. Same "only meaningful against the actually-tracked remote"
   * caveat as `behind`. */
  ahead: number | null;
  /** The remote name the current branch is actually configured to track (parsed from
   * `LocalBranchInfo.upstreamName`), or `null` if untracked/unknown. */
  trackedRemoteName: string | null;
}

/** Splits `"origin/feature-x"` into `["origin", "feature-x"]` against a known remotes list, since a
 * remote name could theoretically itself contain a `/` — matches the longest configured remote name
 * that is an exact prefix component of `upstreamName`, rather than naively splitting on the first
 * `/`. Returns `null` if no configured remote matches. */
function remoteNameFromUpstream(upstreamName: string | null, remotes: readonly string[]): string | null {
  if (!upstreamName) return null;
  return remotes.find((r) => upstreamName === r || upstreamName.startsWith(`${r}/`)) ?? null;
}

/**
 * specs/online-sync-push.md FR-345/FR-347: the Push action's own data dependency — every configured
 * remote (for the picker), plus the current branch's tracked remote and `behind` count (to default
 * the picker sensibly and to gate FR-347's pre-attempt "you're behind" warning). Its own small,
 * independent `listConfiguredRemotes()`/`listBranches()` read, following this codebase's
 * established "each consumer fetches what it needs independently" convention
 * (`useDivergedBranches`/`useCurrentBranchUpstream`'s own doc comments).
 */
export function usePushTarget({ api, enabled, currentBranch, reloadToken }: UsePushTargetOptions): UsePushTargetResult {
  const [remotes, setRemotes] = useState<readonly string[] | "loading">("loading");
  const [behind, setBehind] = useState<number | null>(null);
  const [ahead, setAhead] = useState<number | null>(null);
  const [trackedRemoteName, setTrackedRemoteName] = useState<string | null>(null);
  const [userSelectedRemote, setUserSelectedRemote] = useState<string | null>(null);
  const generationRef = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setRemotes("loading");
      setBehind(null);
      setAhead(null);
      setTrackedRemoteName(null);
      return;
    }
    const generation = ++generationRef.current;
    void (async () => {
      try {
        const [remotesResult, branchesResult] = await Promise.all([
          api.listConfiguredRemotes(),
          api.listBranches(),
        ]);
        const remoteNames = unwrap(remotesResult);
        const branches = unwrap(branchesResult);
        if (generation !== generationRef.current) return;
        setRemotes(remoteNames);
        const match = currentBranch ? branches.find((b) => b.name === currentBranch) : undefined;
        setBehind(match?.behind ?? null);
        setAhead(match?.ahead ?? null);
        setTrackedRemoteName(remoteNameFromUpstream(match?.upstreamName ?? null, remoteNames));
      } catch {
        // Best-effort only — a failed read here just means the picker/warning stay in their
        // "loading"/unknown state a moment longer, never a user-visible error of their own (the
        // Branches panel's own independent reads are what surface a real failure).
        if (generation === generationRef.current) {
          setRemotes("loading");
          setBehind(null);
          setAhead(null);
          setTrackedRemoteName(null);
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, enabled, currentBranch, reloadToken]);

  const resolvedRemotes = remotes === "loading" ? [] : remotes;
  const defaultRemote = trackedRemoteName ?? resolvedRemotes[0] ?? null;
  const selectedRemote =
    userSelectedRemote && resolvedRemotes.includes(userSelectedRemote) ? userSelectedRemote : defaultRemote;

  return {
    remotes,
    showRemotePicker: resolvedRemotes.length > 1,
    selectedRemote,
    setSelectedRemote: setUserSelectedRemote,
    behind,
    ahead,
    trackedRemoteName,
  };
}
