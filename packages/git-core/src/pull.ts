// SPDX-License-Identifier: GPL-3.0-or-later
import {
  runGit,
  runGitAllowingExitCodes,
  withEndOfOptions,
  withFsmonitorNeutralized,
} from "./gitProcess";
import { InvalidArgumentError, NoUpstreamConfiguredError, OperationAlreadyInProgressError } from "./errors";
import { detectInProgressOperation, resolveRepositoryPaths } from "./repository";
import { fetchRemote } from "./fetch";
import { mergeCommit } from "./merge";
import { rebaseCommitOnto } from "./rebase";
import type { FetchProgressEvent } from "./types";

/**
 * specs/online-sync-pull.md — git-core surface for FR-338 through FR-343: `pull()`, composed
 * entirely from Phase 1's `fetchRemote()` (`fetch.ts`) plus the already-shipped
 * `mergeCommit()`/`rebaseCommitOnto()` (`merge.ts`/`rebase.ts`, `drag-commit-menu.md` FR-297/298)
 * — never a literal `git pull` subprocess call (FR-338). This guarantees a pull-triggered conflict
 * reaches the identical, already-tested conflict-resolution flow those two functions already power
 * for a manual merge/rebase, with zero new conflict-handling code.
 *
 * The ONE genuinely new git invocation this module adds is a plain `git merge --ff-only` for
 * FR-340's fast-forward case (see `attemptFastForward()` below) — deliberately NOT routed through
 * `mergeCommit()`/`rebaseCommitOnto()`, since `--ff-only` is structurally incapable of ever pausing
 * on a conflict (it refuses outright instead), matching FR-340's "zero conflict UI" requirement by
 * construction rather than by convention. Every other outcome (a real merge commit, a real rebase
 * replay, a paused conflict) goes through the exact same composed primitives FR-338 requires.
 */

/** The only two integrate strategies this module ever runs — matching the spec's explicit
 * non-goal ("no squash-pull or any non-default integrate strategy"). A runtime allow-list, not
 * just a compile-time union — mirrors `reset.ts`'s `RESET_MODES` precedent (security review
 * finding: a compile-time-only union does not survive the IPC boundary once this is wired up by
 * ui-graphics, since `contextBridge` makes the renderer able to call in with any string). */
export const PULL_STRATEGIES = ["merge", "rebase"] as const;
export type PullStrategy = (typeof PULL_STRATEGIES)[number];

export interface PullOptions {
  /**
   * FR-339: explicit override of the merge-vs-rebase strategy for this one pull only. When
   * omitted, the strategy is resolved from the repository's own `branch.<name>.rebase` /
   * `pull.rebase` config, exactly as `git pull` itself would (see `resolveConfiguredStrategy()`)
   * — this module never imposes a GitHydra-chosen default and never writes either config key.
   */
  strategy?: PullStrategy;
  /** Cancels the fetch phase — the same `AbortSignal` mechanism `fetchRemote()` already supports.
   * Once the fetch has completed, the merge/rebase/fast-forward phase that follows is a purely
   * local, fast operation and is not itself separately cancellable (matching
   * `mergeCommit()`/`rebaseCommitOnto()`, neither of which accept a signal either). */
  signal?: AbortSignal;
  /** FR-322's progress reporting, forwarded as-is to the one `fetchRemote()` call this makes. */
  onProgress?: (event: FetchProgressEvent) => void;
}

export type PullOutcome =
  | { kind: "up-to-date" }
  | { kind: "fast-forward"; fromSha: string; toSha: string }
  | { kind: "integrated"; strategy: PullStrategy };

/**
 * Refuses (making no `git` call at all) when a merge/rebase/cherry-pick/revert/am/bisect is
 * already in progress. Mirrors `merge.ts`'s/`rebase.ts`'s/`reset.ts`'s identically-shaped private
 * helper.
 */
async function assertNoOperationInProgress(cwd: string): Promise<void> {
  const { gitDir } = await resolveRepositoryPaths(cwd);
  const operation = await detectInProgressOperation(gitDir);
  if (operation !== null) {
    throw new OperationAlreadyInProgressError(operation, "pull");
  }
}

/** `git symbolic-ref -q --short HEAD` — the attached branch's short name, or `null` for a
 * detached (or otherwise ref-less) `HEAD`. Mirrors `repository.ts`'s `readHeadState()` own
 * identical attempt/catch shape; not reused directly since that function also resolves
 * `headSha`/`isUnbornHead`, neither of which `pull()` needs at this point (FR-341 only cares
 * whether there IS a current branch to act on; unborn-vs-born is decided later by whether a
 * fast-forward or a real merge/rebase applies, exactly like `resetCurrentBranch()`'s own
 * "bare/unborn gating is the UI layer's job" precedent). */
async function resolveCurrentBranchName(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(["symbolic-ref", "-q", "--short", "HEAD"], { cwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** `git rev-parse --verify -q HEAD` — the current commit `HEAD` points at, or `null` for an
 * unborn branch (no commits yet). */
async function resolveHeadSha(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(["rev-parse", "--verify", "-q", "HEAD"], { cwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** `git rev-parse --verify -q @{u}` — the current branch's configured upstream's SHA, re-read
 * AFTER `fetchRemote()` has updated the relevant remote-tracking ref(s), so this reflects
 * FR-338's "freshly-fetched upstream ref" rather than a possibly-stale value from before this
 * pull started. `null` when `@{u}` still doesn't resolve (e.g. the tracked branch was deleted on
 * the remote) — a real, if unusual, outcome, not a crash. */
async function resolveUpstreamSha(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(["rev-parse", "--verify", "-q", "@{u}"], { cwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * `git config --get <key>`, degrading "not set" (exit 1) to `null` rather than throwing — the
 * normal, expected outcome for a key nobody has configured. Deliberately reads EFFECTIVE config
 * (no `--local`/`--global` scope restriction), matching FR-339's "exactly as real `git pull`
 * would" requirement: a real `git pull` also resolves `branch.<name>.remote`/
 * `branch.<name>.merge`/`branch.<name>.rebase`/`pull.rebase` from whatever the user's own
 * local/global/system config resolves to, not from a scope this module gets to pick. Never
 * writes anything — this module has no counterpart write function, unlike `identityProfile.ts`'s
 * `writeLocalConfigValue()`, precisely because FR-339 forbids ever writing these keys.
 *
 * `key` is always either a fully-hardcoded literal (`"pull.rebase"`) or built with a fixed
 * `"branch."`/`.".rebase"`/`".remote"`/`".merge"` literal prefix/suffix around the current
 * branch's own name (`buildBranchConfigKey()` below) — the leading `"branch."` guarantees the
 * resulting argv token can never itself begin with `-`, so it cannot be misparsed as a flag
 * regardless of what the branch is named (the same "a hardcoded literal prefix makes the whole
 * token safe" reasoning `resetCurrentBranch()`'s own doc comment already documents for a
 * different flag/value pairing). `--end-of-options` is still added ahead of it anyway, purely for
 * consistency with this package's blanket convention on config-key arguments (see
 * `identityProfile.ts`'s `readScopedValue()`, which does the same for its own always-safe
 * hardcoded keys).
 *
 * Exported (originally private to this module) so `push.ts`'s `push()` can reuse it directly to
 * read `branch.<name>.remote`/`branch.<name>.merge` (FR-344/FR-345's "is this branch already
 * tracked for this remote" check) rather than a second, parallel config-reading implementation.
 */
export async function readConfigValue(cwd: string, key: string): Promise<string | null> {
  const { exitCode, stdout } = await runGitAllowingExitCodes(
    ["config", "--get", "--end-of-options", key],
    { cwd },
    [0, 1],
  );
  return exitCode === 0 ? stdout.replace(/\r?\n$/, "") : null;
}

/** Builds `branch.<branchName>.<field>` — always prefixed with the hardcoded literal `"branch."`
 * (see `readConfigValue()`'s own doc comment for why that makes the whole token safe regardless
 * of `branchName`'s content). `branchName` here is always a value this module itself already
 * resolved via `git symbolic-ref` (`resolveCurrentBranchName()`) — i.e. a name git itself already
 * accepted as a real ref, never arbitrary free-form caller input.
 *
 * Exported (originally private) for `push.ts`'s reuse — see `readConfigValue()`'s doc comment
 * above. `push()`'s `localBranchName` is validated (`validateBranchName()`, `branches.ts`) before
 * ever reaching this function, same "already a name git itself accepted" precondition. */
export function buildBranchConfigKey(branchName: string, field: "remote" | "merge" | "rebase"): string {
  return `branch.${branchName}.${field}`;
}

/**
 * Git's own boolean-ish vocabulary for `pull.rebase`/`branch.<name>.rebase`, PLUS the three named
 * non-default rebase-backend spellings (`"merges"`, `"interactive"`, `"preserve"`) real git also
 * accepts for these two keys specifically (verified empirically, 2026-09-17: `git config
 * --type=bool --get` rejects `"merges"` outright with `fatal: bad boolean config value`, so a
 * plain boolean-typed read cannot be used here — this module reads the raw string value instead
 * and classifies it itself). Every one of those non-default spellings maps to this module's own
 * plain `rebaseCommitOnto()` (never a different rebase backend — the spec's own non-goal, "no
 * squash-pull or any non-default integrate strategy," applies here too: this module has only ONE
 * rebase primitive, so any request for git's `rebase`-family behavior gets that one primitive,
 * matching real git's own plain, non-`--rebase=merges`/`--rebase=interactive` rebase for the
 * common case). An unrecognized value degrades to `null` ("not usably configured") rather than
 * throwing — this module never blocks a pull over a config value it can't confidently classify;
 * the next-lower-precedence source (or git's own "merge" default) is used instead.
 */
function parseRebasePreference(raw: string | null): boolean | null {
  if (raw === null) return null;
  const v = raw.trim().toLowerCase();
  if (["true", "1", "yes", "on", "merges", "interactive", "preserve"].includes(v)) return true;
  if (["false", "0", "no", "off", ""].includes(v)) return false;
  return null;
}

/**
 * FR-339: resolve the merge-vs-rebase strategy from the repository's own config, in exactly the
 * precedence order real `git pull` uses: `branch.<name>.rebase` (this branch's own explicit
 * preference) takes priority over `pull.rebase` (the repo-/user-/machine-wide default), which
 * takes priority over git's own built-in default (`"merge"`, when neither key is set anywhere).
 * Never called at all when the caller already supplied an explicit `options.strategy` override —
 * see `pull()`'s own call site.
 */
async function resolveConfiguredStrategy(cwd: string, branchName: string): Promise<PullStrategy> {
  const branchPref = parseRebasePreference(
    await readConfigValue(cwd, buildBranchConfigKey(branchName, "rebase")),
  );
  if (branchPref !== null) return branchPref ? "rebase" : "merge";

  const globalPref = parseRebasePreference(await readConfigValue(cwd, "pull.rebase"));
  if (globalPref !== null) return globalPref ? "rebase" : "merge";

  return "merge";
}

/**
 * `git merge-base --is-ancestor <ancestorSha> <descendantSha>` — true (exit 0) when `ancestorSha`
 * is `descendantSha` itself or a proper ancestor of it, false (exit 1) otherwise. Both SHAs are
 * always full, already-resolved hex SHAs by the time this is called (`resolveHeadSha()`/
 * `resolveUpstreamSha()`'s own output) — never raw caller input — so `--end-of-options` here is
 * the same blanket-convention defense-in-depth every other revision-taking call in this package
 * applies, not a load-bearing guard against a specific attack this callsite is uniquely exposed
 * to.
 */
async function isAncestor(cwd: string, ancestorSha: string, descendantSha: string): Promise<boolean> {
  const { exitCode } = await runGitAllowingExitCodes(
    ["merge-base", "--is-ancestor", ...withEndOfOptions([ancestorSha, descendantSha])],
    { cwd },
    [0, 1],
  );
  return exitCode === 0;
}

/**
 * FR-340: `git merge --ff-only <upstreamSha>` — deliberately NOT `mergeCommit()`/
 * `rebaseCommitOnto()`. `--ff-only` can never create a merge commit and can never pause on a
 * conflict (it refuses outright, non-zero exit, if a fast-forward genuinely isn't possible — which
 * this function's own caller has already verified IS possible via `isAncestor()` before calling
 * this, so that refusal path is not expected to be hit in practice, but is still safe if it
 * somehow were: it surfaces as a plain `GitCommandError`, leaving `HEAD` exactly where it was,
 * same "never partially apply" guarantee every other call in this module has). This is what makes
 * FR-340's "zero conflict UI" true BY CONSTRUCTION rather than by the caller's own care: there is
 * no git-level code path from `--ff-only` into `MERGE_HEAD`/conflict state at all. Routed through
 * `withFsmonitorNeutralized()` like every other call in this package that refreshes the working
 * tree/index against a possibly-untrusted repo's local `core.fsmonitor` config.
 */
async function fastForwardTo(cwd: string, upstreamSha: string): Promise<void> {
  await runGit(
    withFsmonitorNeutralized(["merge", "--ff-only", ...withEndOfOptions([upstreamSha])]),
    { cwd, mutatesRepository: true },
  );
}

/**
 * FR-338 through FR-343: bring the current branch up to date with its own configured upstream —
 * fetch, then integrate via a plain fast-forward (FR-340) or the configured/overridden
 * merge/rebase strategy (FR-339), never a literal `git pull` subprocess call.
 *
 * Refuses up front, making no `git` call at all, when:
 *  - a merge/rebase/cherry-pick/revert/am/bisect is already in progress
 *    (`OperationAlreadyInProgressError`, `requestedAction: "pull"`);
 *  - `options.strategy` is supplied but isn't one of `PULL_STRATEGIES` (`InvalidArgumentError`,
 *    the same runtime-allow-list defense `resetCurrentBranch()`'s `mode` parameter already has —
 *    see `PULL_STRATEGIES`'s own doc comment for why a compile-time union alone isn't enough);
 *  - `HEAD` is detached, or the current branch has no `branch.<name>.remote`/
 *    `branch.<name>.merge` configured (FR-341, `NoUpstreamConfiguredError`).
 *
 * Makes exactly one network call: `fetchRemote()` against `branch.<name>.remote` (AC7 — no
 * incidental second fetch, no push, ever). If the configured upstream ref still doesn't resolve
 * AFTER that fetch (e.g. the tracked branch was deleted on the remote), also throws
 * `NoUpstreamConfiguredError` — there is nothing left to integrate.
 *
 * Returns `{ kind: "up-to-date" }` with no further git call at all when the freshly-fetched
 * upstream SHA already equals `HEAD` (including the trivial unborn-`HEAD`-with-no-upstream-
 * commits-either case, though that can only happen if `HEAD` somehow already matched a would-be
 * root commit — practically unreachable, listed for completeness). Returns `{ kind:
 * "fast-forward", fromSha, toSha }` for FR-340's plain-ref-update path. Returns `{ kind:
 * "integrated", strategy }` once a real `mergeCommit()`/`rebaseCommitOnto()` call completes
 * without pausing.
 *
 * A paused conflict is NOT a `PullOutcome` — exactly like `mergeCommit()`/`rebaseCommitOnto()`
 * themselves, this call instead REJECTS (with whatever `GitCommandError` the underlying
 * `git merge`/`git rebase` produced), and the caller discovers the pause the same way any other
 * merge/rebase caller already does: by re-reading `RepositoryState`/`inProgressOperationDetail`
 * afterward (FR-338 — this is precisely how a pull-triggered conflict reaches the exact same,
 * already-tested `ConflictResolutionView`/operation-banner/Continue/Abort flow with zero new
 * code). FR-342's "never discards local commits" guarantee is therefore inherited unmodified from
 * those two functions' own existing abort/continue contract — this module adds no code of its own
 * that could violate it, and the one path this module DOES add on top (`fastForwardTo()`) can, by
 * construction, only ever succeed cleanly or fail with `HEAD` untouched (see its own doc comment).
 */
export async function pull(cwd: string, options: PullOptions = {}): Promise<PullOutcome> {
  if (options.strategy !== undefined && !PULL_STRATEGIES.includes(options.strategy)) {
    throw new InvalidArgumentError(`Not a valid pull strategy: ${JSON.stringify(options.strategy)}`);
  }

  await assertNoOperationInProgress(cwd);

  const branchName = await resolveCurrentBranchName(cwd);
  if (!branchName) {
    // Detached HEAD: FR-341 — there is no "current branch" for this to act on.
    throw new NoUpstreamConfiguredError();
  }

  const remoteName = await readConfigValue(cwd, buildBranchConfigKey(branchName, "remote"));
  const mergeRef = await readConfigValue(cwd, buildBranchConfigKey(branchName, "merge"));
  if (!remoteName || !mergeRef) {
    throw new NoUpstreamConfiguredError();
  }

  const preHeadSha = await resolveHeadSha(cwd);

  // The one and only network call this function ever makes (AC7).
  await fetchRemote(cwd, remoteName, { signal: options.signal, onProgress: options.onProgress });

  const upstreamSha = await resolveUpstreamSha(cwd);
  if (!upstreamSha) {
    throw new NoUpstreamConfiguredError();
  }

  if (preHeadSha === upstreamSha) {
    return { kind: "up-to-date" };
  }

  const canFastForward = preHeadSha === null ? true : await isAncestor(cwd, preHeadSha, upstreamSha);
  if (canFastForward) {
    await fastForwardTo(cwd, upstreamSha);
    return { kind: "fast-forward", fromSha: preHeadSha ?? upstreamSha, toSha: upstreamSha };
  }

  const strategy = options.strategy ?? (await resolveConfiguredStrategy(cwd, branchName));
  if (strategy === "rebase") {
    await rebaseCommitOnto(cwd, upstreamSha);
  } else {
    await mergeCommit(cwd, upstreamSha);
  }
  return { kind: "integrated", strategy };
}
