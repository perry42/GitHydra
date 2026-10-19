// SPDX-License-Identifier: GPL-3.0-or-later
import {
  runGit,
  runGitAllowingExitCodes,
  spawnGit,
  runGitBufferWithInput,
  withFsmonitorNeutralized,
  type GitChildProcess,
  type RunOptions,
  type RunResult,
  type RunBufferResult,
} from "./gitProcess";
import { GitCommandError, GitCommandTimeoutError, WorktreeOperationError, type WorktreeFailureReason, type WorktreeOperation } from "./errors";
import { isErrnoException } from "./pathSafety";
import { parseGitVersionString, type GitVersion } from "./gitVersion";

/**
 * The single seam every worktree module spawns git through (specs/worktrees.md FR-638): cached absolute git path and
 * `safeEnv()` come from `gitProcess`, `-c core.fsmonitor=false` is prepended HERE so no call site can forget it, inherited GIT_DIR-style variables are dropped (FR-652), and
 * tests can swap the runner to record every argv (AC2) or stub a git version.
 */
export interface WorktreeRunner {
  run(args: readonly string[], opts: RunOptions): Promise<RunResult>;
  runAllowing(args: readonly string[], opts: RunOptions, allowed: readonly number[]): Promise<RunResult & { exitCode: number }>;
  /** Streaming spawn for capped reads (specs/worktree-copy-ignored.md FR-626); optional so older test runners keep working. */
  spawn?(args: readonly string[], opts: RunOptions): GitChildProcess;
  /** Run with bytes on stdin (`check-ignore --stdin -z`); optional so older test runners keep working. */
  runInput?(args: readonly string[], opts: RunOptions, input: Buffer): Promise<RunBufferResult>;
}

const defaultRunner: WorktreeRunner = { run: runGit, runAllowing: runGitAllowingExitCodes, spawn: spawnGit, runInput: runGitBufferWithInput };
let runner: WorktreeRunner = defaultRunner;

/** Test-only: replace (or with `null` restore) the runner. */
export function _setWorktreeRunnerForTests(next: WorktreeRunner | null): void {
  runner = next ?? defaultRunner;
}

export interface WtRunOptions {
  /** Routes through the global mutation queue; leave unset inside `runInMutationQueue`. */
  mutatesRepository?: boolean;
  timeoutMs?: number;
  /** Narrow overrides merged over the safe environment (never to loosen it). */
  extraEnv?: Readonly<Record<string, string>>;
}

export function wtRun(args: readonly string[], cwd: string, opts: WtRunOptions = {}): Promise<RunResult> {
  return runner.run(withFsmonitorNeutralized(args), { cwd, scrubRepoEnv: true, ...opts });
}

export function wtRunAllowing(
  args: readonly string[],
  cwd: string,
  allowed: readonly number[],
  opts: WtRunOptions = {},
): Promise<RunResult & { exitCode: number }> {
  return runner.runAllowing(withFsmonitorNeutralized(args), { cwd, scrubRepoEnv: true, ...opts }, allowed);
}

export function wtRunInput(args: readonly string[], cwd: string, input: Buffer, opts: WtRunOptions = {}): Promise<RunBufferResult> {
  return (runner.runInput ?? runGitBufferWithInput)(withFsmonitorNeutralized(args), { cwd, scrubRepoEnv: true, ...opts }, input);
}

/** The caller owns the child: it must cap output and kill it (whole tree on Windows). */
export function wtSpawn(args: readonly string[], cwd: string): GitChildProcess {
  return (runner.spawn ?? spawnGit)(withFsmonitorNeutralized(args), { cwd, scrubRepoEnv: true });
}

/** Map a git failure to the redacted typed error; cancellation and timeout errors keep their own types. */
export function toWorktreeError(operation: WorktreeOperation, err: unknown): unknown {
  // A timeout error carries the argv (with -c values) and a filesystem error carries paths: neither may escape raw.
  if (err instanceof GitCommandTimeoutError) return new WorktreeOperationError(operation, "timeout");
  if (isErrnoException(err)) return new WorktreeOperationError(operation, "io-failed");
  if (!(err instanceof GitCommandError)) return err;
  const reason: WorktreeFailureReason = /dubious ownership|safe\.directory/i.test(err.stderr) ? "dubious-ownership" : "git-failed";
  return new WorktreeOperationError(operation, reason, err.exitCode);
}

let versionOverride: GitVersion | null | undefined;
let cachedVersion: Promise<GitVersion | null> | null = null;

/** Test-only: pin the version the worktree modules see (`undefined` restores real detection). */
export function _setWorktreeGitVersionForTests(v: GitVersion | null | undefined): void {
  versionOverride = v;
  cachedVersion = null;
}

/** Detected once per process (a git upgrade needs an app restart anyway); unparseable output yields null, i.e. the conservative old-git paths. */
export function getWorktreeGitVersion(cwd: string): Promise<GitVersion | null> {
  if (versionOverride !== undefined) return Promise.resolve(versionOverride);
  cachedVersion ??= wtRun(["--version"], cwd).then(
    (r) => parseGitVersionString(r.stdout),
    (err) => {
      cachedVersion = null;
      throw toWorktreeError("inspect", err);
    },
  );
  return cachedVersion;
}

/**
 * Public entry points run inside this: any raw `GitCommandError` (argv, `-c` values, stderr) that was not turned into a
 * typed refusal becomes the redacted `WorktreeOperationError`. Cancellation, timeouts and other typed errors pass through.
 */
export async function wrapGit<T>(operation: WorktreeOperation, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toWorktreeError(operation, err);
  }
}
