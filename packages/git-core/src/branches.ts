import * as path from "node:path";
import { runGit, withEndOfOptions, withFsmonitorNeutralized } from "./gitProcess";
import { getRepositoryState } from "./repository";
import {
  GitCommandError,
  InvalidArgumentError,
  BranchCheckedOutError,
  BranchNotFullyMergedError,
  BranchSwitchConflictError,
  InvalidRefNameError,
} from "./errors";
import type { CreateBranchOptions, CreateBranchResult, LocalBranchInfo, RemoteBranchInfo, SwitchResult } from "./types";

/**
 * Defense-in-depth for every branch name / start-point / commit-ish this module hands to
 * `git branch` or `git switch`: reject anything starting with `-` *before* it ever reaches
 * argv, rather than relying solely on `--end-of-options` to stop it being reinterpreted as a
 * flag.
 *
 * This isn't redundant belt-and-suspenders — it's load-bearing. Empirically verified (git
 * 2.31.1, i.e. a version *above* this project's 2.24 floor, so this isn't a legacy-only
 * concern): `git switch -c <name> <start-point>` does NOT honor `--end-of-options` (nor a
 * plain `--`) placed before `<name>` — git instead consumes the marker itself as the literal
 * new-branch-name token and shifts `<start-point>` into the name slot, producing a confusing
 * failure rather than the intended protection. `git check-ref-format --branch <name>` doesn't
 * accept `--end-of-options` either (it errors with a usage message). Plain `git branch
 * <name> [<start-point>]`, `git branch -d/-D <name>`, `git switch <branch>`, and
 * `git switch --detach <commit-ish>` all DO honor `--end-of-options` correctly and still use
 * it below as a second layer — but `git switch -c` (the create-and-switch path, FR-36) cannot
 * rely on it at all, which is exactly the call this guard protects. No legitimate branch
 * name, tag, remote-tracking branch, or commit SHA ever starts with `-` (git's own ref-name
 * rules already forbid it for real refs; a hex SHA never does), so this closes the gap with
 * no loss of legitimate functionality other than the `-`/`@{-1}` "previous branch" shorthand,
 * which this module doesn't need to support for these inputs.
 */
function assertSafeRevisionArg(value: string, label: string): void {
  if (value.startsWith("-")) {
    throw new InvalidArgumentError(`${label} must not start with '-': ${JSON.stringify(value)}`);
  }
}

const FS = "\x1f"; // ASCII unit separator, same convention as refs.ts.

// Field order must match the destructuring in listBranches() below.
const LOCAL_BRANCH_FORMAT = [
  "%(refname)",
  "%(objectname)",
  "%(contents:subject)",
  "%(authorname)",
  "%(authoremail:trim)",
  "%(authordate:iso-strict)",
  "%(committerdate:iso-strict)",
  "%(upstream:short)",
  "%(upstream:track)",
].join(FS);

// Field order must match the destructuring in listRemoteBranches() below.
const REMOTE_BRANCH_FORMAT = [
  "%(refname)",
  "%(objectname)",
  "%(contents:subject)",
  "%(authorname)",
  "%(authoremail:trim)",
  "%(authordate:iso-strict)",
  "%(committerdate:iso-strict)",
  "%(symref)",
].join(FS);

/**
 * Parse for-each-ref's `%(upstream:track)` output (e.g. "[ahead 1, behind 2]", "[ahead 3]",
 * "[behind 1]", "[gone]", or "" when up to date) into counts. Returns null for "[gone]" — the
 * configured upstream ref no longer exists on disk, so ahead/behind cannot be computed.
 * Entirely local (reads only refs already on disk); never triggers a fetch (FR-45).
 */
function parseAheadBehind(track: string): { ahead: number; behind: number } | null {
  if (track.includes("gone")) return null;
  const aheadMatch = track.match(/ahead (\d+)/);
  const behindMatch = track.match(/behind (\d+)/);
  return {
    ahead: aheadMatch ? Number(aheadMatch[1]) : 0,
    behind: behindMatch ? Number(behindMatch[1]) : 0,
  };
}

/**
 * FR-33: local branches, one batched `for-each-ref` call (not N+1), with ahead/behind computed
 * from `%(upstream:track)` — itself a single-pass, purely local ref-database computation, never
 * a per-branch `rev-list` invocation and never a network call (FR-45). Cross-referenced against
 * `git worktree list --porcelain` (one more call, independent of branch count) to flag a branch
 * checked out in a *different* worktree from the one `repoPath` resolves to.
 */
export async function listBranches(repoPath: string): Promise<LocalBranchInfo[]> {
  const [forEachRef, worktreeList, state] = await Promise.all([
    runGit(["for-each-ref", "--sort=-committerdate", `--format=${LOCAL_BRANCH_FORMAT}`, "refs/heads"], { cwd: repoPath }),
    // `git worktree list` cross-references per-worktree HEAD state — routed through the same
    // fsmonitor guard as other working-tree-consulting calls (FR-43).
    runGit(withFsmonitorNeutralized(["worktree", "list", "--porcelain"]), { cwd: repoPath }),
    getRepositoryState(repoPath),
  ]);

  const worktreeEntries = parseWorktreeListPorcelain(worktreeList.stdout);
  const selfPath = state.workdir ?? state.gitDir;
  const elsewhereByBranch = worktreesByBranch(worktreeEntries, selfPath);

  const branches: LocalBranchInfo[] = [];
  for (const line of forEachRef.stdout.split("\n")) {
    if (!line) continue;
    const [fullName, sha, subject, authorName, authorEmail, authorDate, committerDate, upstreamShort, upstreamTrackRaw] =
      line.split(FS);
    if (!fullName || !sha) continue;

    const name = fullName.slice("refs/heads/".length);
    const upstreamName = upstreamShort ? upstreamShort : null;
    const aheadBehind = upstreamName ? parseAheadBehind(upstreamTrackRaw ?? "") : null;

    branches.push({
      name,
      fullName,
      tipSha: sha,
      tipSubject: subject ?? "",
      tipAuthorName: authorName ?? "",
      tipAuthorEmail: authorEmail ?? "",
      tipAuthorDate: authorDate ?? "",
      tipCommitterDate: committerDate ?? "",
      isCurrent: state.currentBranch === name,
      checkedOutInWorktree: elsewhereByBranch.get(fullName) ?? null,
      upstreamName,
      upstreamGone: upstreamName !== null && aheadBehind === null,
      ahead: aheadBehind?.ahead ?? null,
      behind: aheadBehind?.behind ?? null,
    });
  }
  return branches;
}

/**
 * FR-34: remote-tracking branches, one batched `for-each-ref` call, grouped implicitly via each
 * entry's `remoteName` field (same convention `refs.ts`'s `RefInfo.remoteName` already uses) —
 * callers that want a "grouped by remote" view can bucket on that field. A remote's symbolic
 * `HEAD` pointer (e.g. `refs/remotes/origin/HEAD -> origin/main`) is excluded: it's an alias,
 * not a real branch, and would otherwise show up as a spurious duplicate create/checkout target.
 */
export async function listRemoteBranches(repoPath: string): Promise<RemoteBranchInfo[]> {
  const { stdout } = await runGit(
    ["for-each-ref", "--sort=-committerdate", `--format=${REMOTE_BRANCH_FORMAT}`, "refs/remotes"],
    { cwd: repoPath },
  );

  const branches: RemoteBranchInfo[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const [fullName, sha, subject, authorName, authorEmail, authorDate, committerDate, symref] = line.split(FS);
    if (!fullName || !sha) continue;
    if (symref) continue; // e.g. refs/remotes/origin/HEAD — an alias, not a real remote branch.

    const rest = fullName.slice("refs/remotes/".length);
    const slashIndex = rest.indexOf("/");
    if (slashIndex === -1) continue; // malformed/unexpected — skip rather than mis-parse.
    const remoteName = rest.slice(0, slashIndex);
    const name = rest.slice(slashIndex + 1);

    branches.push({
      name,
      fullName,
      remoteName,
      tipSha: sha,
      tipSubject: subject ?? "",
      tipAuthorName: authorName ?? "",
      tipAuthorEmail: authorEmail ?? "",
      tipAuthorDate: authorDate ?? "",
      tipCommitterDate: committerDate ?? "",
    });
  }
  return branches;
}

interface WorktreeEntry {
  path: string;
  branchFullName: string | null;
  isBare: boolean;
}

/** Parse `git worktree list --porcelain` output into structured entries. */
function parseWorktreeListPorcelain(stdout: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> | null = null;

  const flush = () => {
    if (current?.path) {
      entries.push({
        path: current.path,
        branchFullName: current.branchFullName ?? null,
        isBare: current.isBare ?? false,
      });
    }
    current = null;
  };

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trimEnd();
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      flush();
      current = { path: line.slice("worktree ".length) };
    } else if (current) {
      if (line.startsWith("branch ")) current.branchFullName = line.slice("branch ".length);
      else if (line === "bare") current.isBare = true;
      else if (line === "detached") current.branchFullName = null;
      // "HEAD <sha>", "locked [reason]", "prunable [reason]" — not needed here, ignored.
    }
  }
  flush();
  return entries;
}

function normalizeForCompare(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Map each branch (by full ref name) to the *other* worktree path it's checked out in, if any. */
function worktreesByBranch(entries: readonly WorktreeEntry[], selfPath: string): Map<string, string> {
  const selfNorm = normalizeForCompare(selfPath);
  const map = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.branchFullName) continue;
    if (normalizeForCompare(entry.path) === selfNorm) continue; // this is the caller's own worktree.
    map.set(entry.branchFullName, entry.path);
  }
  return map;
}

/**
 * FR-35: validate a proposed branch name with `git check-ref-format --branch <name>` before any
 * mutating call is attempted. Never a raw crash / raw `GitCommandError`: throws
 * `InvalidArgumentError` for a leading `-` (via the shared `assertSafeRevisionArg` guard — see
 * its doc comment) or `InvalidRefNameError` for any other `check-ref-format` rejection (empty,
 * spaces, trailing `.lock`, etc.), so the caller can always render a specific, actionable
 * message either way.
 */
export async function validateBranchName(repoPath: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new InvalidRefNameError(name, "must not be empty");
  }
  // Reuse the same leading-dash guard every other revision-like input in this module goes
  // through, rather than re-implementing it here. Note this means a leading-dash name throws
  // `InvalidArgumentError` (from `assertSafeRevisionArg`), not `InvalidRefNameError` — see this
  // function's doc comment. (`check-ref-format` doesn't accept `--end-of-options` either — it
  // errors with a usage message — but that's moot here since this guard runs first.)
  assertSafeRevisionArg(trimmed, "Branch name");
  try {
    await runGit(["check-ref-format", "--branch", trimmed], { cwd: repoPath });
  } catch (err) {
    if (err instanceof GitCommandError) {
      throw new InvalidRefNameError(trimmed, err.stderr.trim() || "not a valid branch name");
    }
    throw err;
  }
}

/**
 * Resolve a revision to a string via `git rev-parse`. Deliberately does NOT use
 * `withEndOfOptions()`: unlike `log`/`diff`/`branch`/`switch`, `rev-parse` doesn't actually
 * consume `--end-of-options` as an options terminator — it falls into `rev-parse`'s own
 * "unrecognized flag-shaped argument" scripting behavior and gets echoed back verbatim as an
 * extra output line instead, which would corrupt parsing here. Every caller of this function
 * already only ever passes either the literal constant `"HEAD"`, or a value that has already
 * passed `assertSafeRevisionArg`/`validateBranchName` (guaranteed not to start with `-`), so no
 * option-injection surface is opened by passing it unwrapped.
 */
async function revParse(repoPath: string, rev: string): Promise<string> {
  const { stdout } = await runGit(["rev-parse", rev], { cwd: repoPath });
  return stdout.trim();
}

/**
 * True if `ref` (as given by the caller — short or full form) resolves to a ref under
 * `refs/remotes/`. Used to auto-decide tracking (FR-37) deterministically, rather than relying
 * on the user's ambient `branch.autoSetupMerge` config, which may be disabled. A ref that fails
 * to resolve at all (bad start point) resolves to `false` here; the actual create/switch call
 * that follows will surface git's own "not a valid ref" failure. `git rev-parse` has no
 * dangerous (side-effecting) flags, so passing `ref` to it directly — even before the caller's
 * own `assertSafeRevisionArg` guard runs — carries no injection risk beyond a possible
 * mis-resolution, which the leading-dash check below also short-circuits anyway.
 */
async function isRemoteTrackingRef(repoPath: string, ref: string): Promise<boolean> {
  if (ref.startsWith("-")) return false;
  try {
    const { stdout } = await runGit(
      ["rev-parse", "--symbolic-full-name", "--verify", "-q", ref],
      { cwd: repoPath },
    );
    return stdout.trim().startsWith("refs/remotes/");
  } catch {
    return false;
  }
}

async function resolveTrackDecision(
  repoPath: string,
  startPoint: string | undefined,
  explicit: boolean | undefined,
): Promise<boolean | undefined> {
  if (explicit !== undefined) return explicit;
  if (!startPoint) return undefined;
  return (await isRemoteTrackingRef(repoPath, startPoint)) ? true : undefined;
}

const OVERWRITE_MESSAGE_RE = /would be overwritten by (?:checkout|merge)/;

/** Best-effort parse of the indented file list git prints under its "would be overwritten" error. */
function parseOverwrittenPaths(stderr: string): string[] {
  const lines = stderr.split("\n");
  const paths: string[] = [];
  let capturing = false;
  for (const line of lines) {
    if (OVERWRITE_MESSAGE_RE.test(line)) {
      capturing = true;
      continue;
    }
    if (!capturing) continue;
    if (/^\s+\S/.test(line)) {
      paths.push(line.trim());
    } else {
      capturing = false;
    }
  }
  return paths;
}

/** Re-throw a failed `git switch` as a typed `BranchSwitchConflictError` when it's the
 * uncommitted-changes-would-be-overwritten refusal (FR-38); otherwise re-throw unchanged so the
 * caller still sees git's real reason (e.g. mid-rebase, invalid start point) verbatim. */
function translateSwitchError(err: unknown, target: string): never {
  if (err instanceof GitCommandError && OVERWRITE_MESSAGE_RE.test(err.stderr)) {
    throw new BranchSwitchConflictError(target, parseOverwrittenPaths(err.stderr), err.stderr);
  }
  throw err;
}

/**
 * FR-35/36/37: create a new local branch (`git branch <name> [<start-point>]`), or create-and-
 * switch in one atomic call (`git switch -c <name> [<start-point>]`) when `switchToIt` is set.
 * `name` is validated first (FR-35, via `validateBranchName`, which itself runs
 * `assertSafeRevisionArg`); `startPoint` is separately run through `assertSafeRevisionArg`
 * before reaching argv, in addition to `withEndOfOptions()` for the plain (non-switch)
 * `git branch` call — the create-and-switch path relies on `assertSafeRevisionArg` alone for
 * both `name` and `startPoint`, since `git switch -c` does not reliably honor
 * `--end-of-options` (see that function's doc comment for why). For the switch-c path, `name`
 * must additionally be positioned as the argv entry immediately following `-c` (it takes a
 * mandatory bound value, like `-b`/`-B` on `checkout`) — trackFlags and `startPoint` come after.
 *
 * Throws:
 *  - `InvalidArgumentError` — `name` or `startPoint` starts with `-` (see `assertSafeRevisionArg`).
 *  - `InvalidRefNameError` — `name` fails `check-ref-format --branch` for any other reason.
 *  - `BranchSwitchConflictError` — (switchToIt only) uncommitted changes would be overwritten.
 *  - `GitCommandError` — any other failure (bad start point, unborn HEAD with no start point
 *    given, mid-rebase/merge refusing a switch, etc.), with git's raw stderr attached.
 */
export async function createBranch(repoPath: string, options: CreateBranchOptions): Promise<CreateBranchResult> {
  const name = options.name.trim();
  await validateBranchName(repoPath, name);

  const startPoint = options.startPoint?.trim() || undefined;
  if (startPoint) assertSafeRevisionArg(startPoint, "Start point");
  const track = await resolveTrackDecision(repoPath, startPoint, options.track);
  const trackFlags = track === true ? ["--track"] : track === false ? ["--no-track"] : [];
  const positional = startPoint ? [name, startPoint] : [name];

  if (options.switchToIt) {
    try {
      // `-c` takes a mandatory bound value (like `-b`/`-B` on `checkout`): whatever token comes
      // immediately after it is consumed as the new branch name. `name` MUST be the very next
      // argv entry after `-c` — trackFlags/startPoint come after, never between. (Confirmed by
      // reproduction: `switch -c --track name startpoint` binds `-c`'s value to the literal
      // string "--track" and then fails on the leftover positionals with "only one reference
      // expected".) Deliberately NOT wrapped in `withEndOfOptions()` — see
      // `assertSafeRevisionArg`'s doc comment. `name`/`startPoint` are already guaranteed safe
      // by the guards above.
      await runGit(
        withFsmonitorNeutralized(["switch", "-c", name, ...trackFlags, ...(startPoint ? [startPoint] : [])]),
        { cwd: repoPath, mutatesRepository: true },
      );
    } catch (err) {
      translateSwitchError(err, name);
    }
    const sha = await revParse(repoPath, "HEAD");
    return { name, fullName: `refs/heads/${name}`, sha, switched: true };
  }

  // `git branch` create never touches the working tree/index — no fsmonitor guard needed (FR-43).
  // Still a repository mutation (creates a ref) — serialized like every other mutating call.
  await runGit(["branch", ...trackFlags, ...withEndOfOptions(positional)], {
    cwd: repoPath,
    mutatesRepository: true,
  });
  const sha = await revParse(repoPath, `refs/heads/${name}`);
  return { name, fullName: `refs/heads/${name}`, sha, switched: false };
}

/**
 * FR-38: switch the current worktree's HEAD to an existing local branch (`git switch <branch>`,
 * never `git checkout`). Never force-discards or auto-stashes: if git refuses because the
 * switch would overwrite uncommitted changes, throws `BranchSwitchConflictError` carrying git's
 * real file list/reason; any other refusal (mid-merge/rebase, etc.) surfaces as `GitCommandError`
 * unchanged. Routed through `withFsmonitorNeutralized()` (FR-43): `git switch` consults
 * working-tree/index state.
 */
export async function switchBranch(repoPath: string, branchName: string): Promise<SwitchResult> {
  assertSafeRevisionArg(branchName, "Branch name");
  try {
    await runGit(withFsmonitorNeutralized(["switch", ...withEndOfOptions([branchName])]), {
      cwd: repoPath,
      mutatesRepository: true,
    });
  } catch (err) {
    translateSwitchError(err, branchName);
  }
  const sha = await revParse(repoPath, "HEAD");
  return { sha };
}

/**
 * FR-39: detached-HEAD checkout of an arbitrary commit-ish (`git switch --detach <commit-ish>`)
 * — backs the graph's "Checkout" context-menu action for a non-branch-tip commit. Same
 * no-force/no-auto-stash and fsmonitor-guard behavior as `switchBranch`.
 */
export async function switchToCommit(repoPath: string, commitish: string): Promise<SwitchResult> {
  assertSafeRevisionArg(commitish, "Commit-ish");
  try {
    await runGit(
      withFsmonitorNeutralized(["switch", "--detach", ...withEndOfOptions([commitish])]),
      { cwd: repoPath, mutatesRepository: true },
    );
  } catch (err) {
    translateSwitchError(err, commitish);
  }
  const sha = await revParse(repoPath, "HEAD");
  return { sha };
}

/** git names the conflicting worktree path (when it has one) in a single quoted-path clause. */
function parseCheckedOutWorktreePath(stderr: string): string | null {
  const m = stderr.match(/(?:used by worktree at|checked out at) '([^']+)'/);
  return m?.[1] ?? null;
}

const CHECKED_OUT_RE = /checked out at|used by worktree|is currently checked out|currently on/i;
const NOT_FULLY_MERGED_RE = /not fully merged/i;

/**
 * FR-40: safe-delete a local branch (`git branch -d <name>`). Does not touch the working tree —
 * no fsmonitor guard needed (FR-43).
 *
 * Throws:
 *  - `BranchCheckedOutError` — the branch is checked out here or in a different worktree (FR-42).
 *  - `BranchNotFullyMergedError` — git refused because the branch has unmerged commits (FR-40);
 *    distinguishable from every other failure so the UI can offer a distinct force-delete escalation.
 *  - `GitCommandError` — any other failure (e.g. branch doesn't exist).
 */
export async function deleteBranch(repoPath: string, branchName: string): Promise<void> {
  assertSafeRevisionArg(branchName, "Branch name");
  try {
    await runGit(["branch", "-d", ...withEndOfOptions([branchName])], {
      cwd: repoPath,
      mutatesRepository: true,
    });
  } catch (err) {
    throw translateDeleteError(err, branchName, { allowNotFullyMerged: true });
  }
}

/**
 * FR-41: force-delete a local branch (`git branch -D <name>`), discarding unmerged commits.
 * Deliberately its own explicitly-named, separately-exported function — not reachable through
 * `deleteBranch`'s code path — the same separation `discardTrackedFileChanges` keeps from
 * `unstageFile` in `staging.ts`, so a caller can't reach this destructive path by accident.
 *
 * Throws `BranchCheckedOutError` (FR-42) or `GitCommandError`, same as `deleteBranch` (force
 * delete bypasses the "not fully merged" refusal entirely, so that error never applies here).
 */
export async function forceDeleteBranch(repoPath: string, branchName: string): Promise<void> {
  assertSafeRevisionArg(branchName, "Branch name");
  try {
    await runGit(["branch", "-D", ...withEndOfOptions([branchName])], {
      cwd: repoPath,
      mutatesRepository: true,
    });
  } catch (err) {
    throw translateDeleteError(err, branchName, { allowNotFullyMerged: false });
  }
}

function translateDeleteError(
  err: unknown,
  branchName: string,
  opts: { allowNotFullyMerged: boolean },
): Error {
  if (err instanceof GitCommandError) {
    if (CHECKED_OUT_RE.test(err.stderr)) {
      return new BranchCheckedOutError(branchName, parseCheckedOutWorktreePath(err.stderr), err.stderr);
    }
    if (opts.allowNotFullyMerged && NOT_FULLY_MERGED_RE.test(err.stderr)) {
      return new BranchNotFullyMergedError(branchName, err.stderr);
    }
  }
  return err as Error;
}
