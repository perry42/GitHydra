// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  GitCommandError,
  GitCommandTimeoutError,
  GitNotFoundError,
  OperationCancelledError,
  UnsupportedGitVersionError,
} from "./errors";

/** The shape of every child process we spawn: stdin ignored, stdout/stderr piped. */
export type GitChildProcess = ChildProcessByStdio<null, Readable, Readable>;

/**
 * All git-core process execution goes through here: argv arrays only with `shell: false` (no shell
 * ever sees repo/user strings); user-controlled revisions go through `withEndOfOptions()` (git >=
 * 2.24; a ref named `--upload-pack=...` must not parse as an option); path filters follow a literal
 * `--`; no pager and no interactive credential prompts (FR-9 backstop against hangs).
 */

export const MIN_GIT_VERSION = "2.24.0";

export interface RunOptions {
  cwd: string;
  /** Abort an in-flight command, e.g. if the caller closed the repository. */
  signal?: AbortSignal;
  /**
   * True for any call that mutates the index, a ref, or the working tree; routes it through the
   * single FIFO queue (see `enqueueGitTask`) so concurrent mutations don't race for
   * `.git/index.lock`. Leave unset for pure reads.
   */
  mutatesRepository?: boolean;
  /** Override `DEFAULT_GIT_TIMEOUT_MS` for one call; ignored when `signal` is supplied (see `armTimeout()`). Test-oriented. */
  timeoutMs?: number;
  /**
   * Merged over `safeEnv()` for narrow overrides only, never to loosen its safety defaults. FR-70
   * (`conflicts.ts` `continueInProgressOperation`) sets `GIT_EDITOR=true`: no TTY to host an editor.
   */
  extraEnv?: Readonly<Record<string, string>>;
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

function safeEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Never prompt for credentials/host keys; fail fast instead of hanging.
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    // Never page output — we're reading stdout programmatically.
    GIT_PAGER: "cat",
    PAGER: "cat",
    // Make output parsing locale-independent.
    LC_ALL: "C",
    // Literal pathspecs: otherwise a name like `pages/[id].tsx` is parsed as a glob and a destructive
    // discard could hit a different file.
    GIT_LITERAL_PATHSPECS: "1",
  };
}

/**
 * Prepend to git calls that read/refresh working-tree state (`status`, worktree `diff`, `add`,
 * `restore`, `clean`, `commit`): these honor a repo-local `core.fsmonitor` and execute it as a hook,
 * an RCE risk for any non-fresh-clone repo (zip, tarball, worktree). `-c` beats `.git/config`.
 * Regression test: tests/workingDirStatus.test.ts.
 */
export const NEUTRALIZE_LOCAL_HOOK_CONFIG = ["-c", "core.fsmonitor=false"] as const;

/** Every `git diff` must carry these: repo config `diff.external`/`diff.<driver>.textconv` would otherwise execute programs. */
export const SAFE_DIFF_FLAGS = ["--no-ext-diff", "--no-textconv"] as const;

/** Prepend `NEUTRALIZE_LOCAL_HOOK_CONFIG` to an argv array. */
export function withFsmonitorNeutralized(args: readonly string[]): string[] {
  return [...NEUTRALIZE_LOCAL_HOOK_CONFIG, ...args];
}

/**
 * For read-only status/diff reads: `--no-optional-locks` stops git rewriting `.git/index` to refresh
 * stat data, so a live refresh never races a concurrent writer or wakes the `.git` watcher
 * (specs/live-refresh.md, FR-459, AC10).
 */
export function withReadOnlyIndex(args: readonly string[]): string[] {
  return ["--no-optional-locks", ...withFsmonitorNeutralized(args)];
}

/**
 * Deliberately absent: a `credential.helper=` neutralizer for network calls. It was removed (FR-325,
 * specs/online-sync-fetch.md) because it blocked the system credential helper and so broke private
 * HTTPS repos; the "hang" that motivated it was a GUI credential prompt awaiting a human. Waits stay
 * bounded by `DEFAULT_GIT_TIMEOUT_MS` and FR-322 cancellation.
 */

/**
 * Blocks `ext::`/`fd::` pseudo-transports for one call. A repo's `.git/config` can set
 * `remote.origin.url = ext::sh -c '<payload>'`, which git runs on a plain fetch; GitHydra opens
 * untrusted repos and Fetch never shows the user the URL. Supported transports (file, git, http,
 * https, ssh) are unaffected; `-c` overrides repo config.
 */
export const BLOCK_COMMAND_EXECUTING_TRANSPORTS = [
  "-c",
  "protocol.ext.allow=never",
  "-c",
  "protocol.fd.allow=never",
] as const;

/** Prepend `BLOCK_COMMAND_EXECUTING_TRANSPORTS` to an argv array. */
export function withDangerousTransportsBlocked(args: readonly string[]): string[] {
  return [...BLOCK_COMMAND_EXECUTING_TRANSPORTS, ...args];
}

/**
 * Forces `core.sshCommand=ssh` for `clone()` only. Its cwd is the destination's parent, which may sit
 * inside an unrelated repo whose local `core.sshCommand` git would otherwise apply and execute (RCE;
 * specs/online-sync-security-flags.md #3). `fetchRemote()`/`push()` deliberately inherit the open
 * repo's own `core.sshCommand` (FR-334, specs/git-identity-profiles.md).
 */
export const NEUTRALIZE_AMBIENT_SSH_COMMAND = ["-c", "core.sshCommand=ssh"] as const;

/** Prepend `NEUTRALIZE_AMBIENT_SSH_COMMAND` to an argv array; `clone()` only. */
export function withAmbientSshCommandNeutralized(args: readonly string[]): string[] {
  return [...NEUTRALIZE_AMBIENT_SSH_COMMAND, ...args];
}

let cachedGitExecutable: string | null = null;

/** Windows extension search order for an unqualified command name. Mirrors PATHEXT/cmd.exe. */
function candidateExtensions(): readonly string[] {
  if (process.platform !== "win32") return [""];
  const pathext = process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD";
  return pathext.split(";").filter(Boolean);
}

function isExecutableFile(candidate: string): boolean {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return false;
    if (process.platform === "win32") {
      // Extension already constrained by candidateExtensions(); Windows has no separate
      // executable-bit concept for us to check here.
      return true;
    }
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve `git` to an absolute path once per process and cache it, rather than relying on spawn's
 * PATH search (defense in depth; also fixes which git runs when several are on PATH). Order:
 * `GIT_EXEC_PATH`'s `<prefix>/bin`, then each `PATH` directory.
 */
function resolveGitExecutablePath(): string {
  if (cachedGitExecutable) return cachedGitExecutable;

  const candidateDirs: string[] = [];

  const gitExecPath = process.env.GIT_EXEC_PATH;
  if (gitExecPath) {
    candidateDirs.push(path.join(gitExecPath, "..", "..", "bin"));
    candidateDirs.push(path.join(gitExecPath, "..", ".."));
  }

  // On Windows the PATH variable's name isn't guaranteed to be spelled "PATH" in
  // process.env (case-insensitive filesystem, case-sensitive JS object keys).
  const pathEnvName = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH");
  const pathEnv = (pathEnvName ? process.env[pathEnvName] : undefined) ?? "";
  candidateDirs.push(...pathEnv.split(path.delimiter).filter(Boolean));

  const exts = candidateExtensions();
  for (const dir of candidateDirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, `git${ext}`);
      if (isExecutableFile(candidate)) {
        cachedGitExecutable = candidate;
        return candidate;
      }
    }
  }

  throw new GitNotFoundError();
}

/** Test-only: reset the cached resolved git executable path. */
export function _resetGitExecutablePathCacheForTests(): void {
  cachedGitExecutable = null;
}

/** Test-only: run resolution and return the absolute path (or throw), without spawning git. */
export function _resolveGitExecutablePathForTests(): string {
  return resolveGitExecutablePath();
}

let spawnCount = 0;

/** Test-only: number of git processes this module has spawned (latency benchmark, specs/hunk-line-staging.md FR-479). */
export function _getSpawnCountForTests(): number {
  return spawnCount;
}

function spawnGitRaw(args: readonly string[], opts: RunOptions): GitChildProcess {
  spawnCount++;
  const gitExecutable = resolveGitExecutablePath();
  return spawn(gitExecutable, args as string[], {
    cwd: opts.cwd,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...safeEnv(), ...opts.extraEnv },
    signal: opts.signal,
  });
}

/**
 * Serializes calls opted in via `RunOptions.mutatesRepository` through one process-wide FIFO queue,
 * so concurrent mutations (e.g. stage + stash apply) wait instead of one failing on
 * `.git/index.lock`.
 *
 * Opt-in, not uniform: commands that only optionally refresh the index (`status`, `diff`) still
 * succeed when the lock is held (verified), and queuing reads serialized the codebase's
 * `Promise.all` read patterns and slowed tests. An explicit per-call flag also avoids a central
 * "is this argv a write" heuristic.
 *
 * Global, not per-repo: one `Repository` is open at a time, and call sites pass different but
 * equivalent `cwd`s (`workdir` vs `this.path` for a subdirectory open) that a cwd-keyed queue would
 * fail to serialize. If several repos ever open at once, key by resolved `gitDir`.
 *
 * Not applied to `spawnGit()`: long-lived streaming reads (`git log`) never touch the index.
 */
let gitQueueTail: Promise<void> = Promise.resolve();

function enqueueGitTask<T>(task: () => Promise<T>): Promise<T> {
  const runTask = (): Promise<T> => task();
  const result = gitQueueTail.then(runTask, runTask);
  // Advance even on failure so one failed call can't wedge later ones; `result` still carries the rejection.
  gitQueueTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * Run a multi-step task as ONE entry in the mutation queue (see `enqueueGitTask`), so a
 * check-then-act sequence (e.g. "re-verify HEAD, then switch") cannot be interleaved with another
 * queued mutation. Every `runGit` call made INSIDE `task` MUST omit `mutatesRepository` — it is
 * already holding the queue, and a nested queued call would wait on itself forever.
 */
export function runInMutationQueue<T>(task: () => Promise<T>): Promise<T> {
  return enqueueGitTask(task);
}

/** Test-only: reset the queue, in case a prior test left a rejected tail unresolved. */
export function _resetGitQueueForTests(): void {
  gitQueueTail = Promise.resolve();
}

/** Test-only: exercise the same FIFO queue `runGit`/etc. use, with an arbitrary async task
 * instead of a real git invocation — lets tests assert strict ordering deterministically,
 * without depending on real process-scheduling timing. */
export function _enqueueGitTaskForTests<T>(task: () => Promise<T>): Promise<T> {
  return enqueueGitTask(task);
}

/**
 * Ceiling for any BOUNDED invocation (`runGit`, `runGitAllowingExitCodes`, `runGitWithInput`)
 * before it is killed and rejects with `GitCommandTimeoutError`; not applied to `spawnGit()`.
 *
 * Why: a call that never settles would wedge the whole mutation queue, and untrusted repos' hooks
 * and filter drivers (even on plain `diff`/`show`) can hang, so reads are bounded too. 2 minutes
 * outlasts slow legitimate local work (large `git add`, real hooks) yet caps head-of-line blocking.
 *
 * Known residual risk: if the killed process held `.git/index.lock`, the lock stays behind (Windows
 * kill is always forceful) and later mutations fail fast with a clear `GitCommandError`. We never
 * auto-delete it: it can't be told apart from a live external git's lock, and unlinking that risks
 * corruption. A user-confirmed "clear stale lock" UI is the safe follow-up.
 */
export const DEFAULT_GIT_TIMEOUT_MS = 120_000;

/**
 * POSIX backstop: grace period after a timeout/cancel abort before SIGKILL, since a hostile hook can
 * trap the default signal. Effectively a no-op on Windows (kill is always forceful). Doesn't gate the
 * queue: the task rejects as soon as the timeout fires.
 */
const TIMEOUT_SIGKILL_GRACE_MS = 5_000;

/** Test-only: expose the real grace period so tests can wait it out without hardcoding (and
 * risking silently drifting from) the same magic number here. */
export function _timeoutSigkillGraceMsForTests(): number {
  return TIMEOUT_SIGKILL_GRACE_MS;
}

/** The subset of `ChildProcess` `armTimeout()` needs. Keyed off `"exit"`, not `.killed` (see `armTimeout`). */
export interface BoundChild {
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: () => void): unknown;
}

/**
 * Exported (FR-322, specs/online-sync-fetch.md) so `fetch.ts`'s streaming `spawnGit` process reuses
 * this timeout/cancel/SIGKILL-escalation shape instead of a second implementation.
 */
export interface TimeoutHandle {
  /** Pass this as the `signal` given to `spawnGitRaw`/`spawn`. */
  readonly signal: AbortSignal | undefined;
  /** True once this handle's own timer (not any caller-supplied `signal`) has fired. */
  wasTimeout(): boolean;
  /** FR-163/FR-165 (specs/repo-open-feedback.md): true once the abort source was the caller's `RunOptions.signal`; mutually exclusive with `wasTimeout()`. */
  wasCancelled(): boolean;
  /** Register the just-spawned child so a fired timeout/cancellation can escalate to SIGKILL if needed. */
  bindChild(child: BoundChild): void;
  /** Must be called exactly once the task settles, for any reason — clears all pending timers. */
  clear(): void;
}

/**
 * SIGTERM, then `TIMEOUT_SIGKILL_GRACE_MS`, then SIGKILL escalation for an aborting `signal` (FR-164).
 * Covers caller cancellation as well as timeouts, since `spawn({signal})` only sends the primary kill.
 *
 * `clear()` must NEVER `clearTimeout()` an escalation timer already armed: `child_process` emits
 * `"error"` synchronously inside the same `abort()` dispatch (after `onAbort` armed the timer, even
 * if the process ignored the signal), and callers call `clear()` from that handler, which would cancel
 * the SIGKILL check in the same tick for every cancelled call. `clear()` only removes the listener; an
 * armed timer re-checks `isProcessExited()` before SIGKILL, so it is a harmless `unref()`'d no-op
 * after a normal exit.
 */
export function armEscalation(
  signal: AbortSignal,
  getBoundChild: () => BoundChild | null,
  isProcessExited: () => boolean,
): { clear: () => void } {
  const onAbort = () => {
    const escalationTimer = setTimeout(() => {
      const child = getBoundChild();
      if (child && !isProcessExited()) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* process already gone by the time we got here — nothing left to kill */
        }
      }
    }, TIMEOUT_SIGKILL_GRACE_MS);
    escalationTimer.unref?.();
  };
  if (signal.aborted) {
    // Already aborted: the "abort" event won't fire again, so arm now.
    onAbort();
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    // Must not clearTimeout an already-armed escalation timer; see doc comment.
    clear: () => signal.removeEventListener("abort", onAbort),
  };
}

/**
 * Arms a timeout for one bounded call, reusing `RunOptions.signal`'s plumbing: with no caller
 * `signal` it creates one and aborts it on a timer; with one it defers entirely (an explicit
 * cancellation policy such as FR-163's is trusted, no extra timeout). Both branches get
 * `armEscalation()`. See `DEFAULT_GIT_TIMEOUT_MS`.
 */
export function armTimeout(opts: RunOptions): TimeoutHandle {
  let boundChild: BoundChild | null = null;
  // Set from the child's `"exit"` event, not `child.killed`: `killed` flips on signal delivery, so a
  // hook that traps SIGTERM would make the SIGKILL escalation a no-op.
  let processExited = false;
  const bindChild = (child: BoundChild): void => {
    boundChild = child;
    // Registered at bind time so no exit can be missed before the escalation check.
    child.once("exit", () => {
      processExited = true;
    });
  };

  if (opts.signal) {
    const signal = opts.signal;
    const escalation = armEscalation(signal, () => boundChild, () => processExited);
    return {
      signal,
      wasTimeout: () => false,
      wasCancelled: () => signal.aborted,
      bindChild,
      clear: () => escalation.clear(),
    };
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const escalation = armEscalation(controller.signal, () => boundChild, () => processExited);

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref?.();

  return {
    signal: controller.signal,
    wasTimeout: () => timedOut,
    wasCancelled: () => false,
    bindChild,
    clear: () => {
      clearTimeout(timer);
      escalation.clear();
    },
  };
}

/** Run a git command to completion and buffer its output. For small/bounded output only. */
export function runGit(args: readonly string[], opts: RunOptions): Promise<RunResult> {
  return opts.mutatesRepository ? enqueueGitTask(() => runGitTask(args, opts)) : runGitTask(args, opts);
}

function runGitTask(args: readonly string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const timeoutHandle = armTimeout(opts);

    let child: GitChildProcess;
    try {
      child = spawnGitRaw(args, { ...opts, signal: timeoutHandle.signal });
    } catch (err) {
      timeoutHandle.clear();
      if (timeoutHandle.wasCancelled()) {
        reject(new OperationCancelledError(args));
        return;
      }
      reject(
        new GitCommandError(
          `Failed to start git: ${(err as Error).message}`,
          args,
          null,
          "",
        ),
      );
      return;
    }
    timeoutHandle.bindChild(child);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", (err) => {
      timeoutHandle.clear();
      if (timeoutHandle.wasTimeout()) {
        reject(new GitCommandTimeoutError(args, opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS));
        return;
      }
      // FR-163/FR-165 (specs/repo-open-feedback.md): caller cancellation is a distinct outcome, not a GitCommandError.
      if (timeoutHandle.wasCancelled()) {
        reject(new OperationCancelledError(args));
        return;
      }
      reject(
        new GitCommandError(`Failed to run git: ${err.message}`, args, null, ""),
      );
    });

    child.on("close", (code) => {
      timeoutHandle.clear();
      if (timeoutHandle.wasTimeout()) {
        // Belt-and-suspenders against event ordering: `close` with the timeout flag set must not look like a plain non-zero exit.
        reject(new GitCommandTimeoutError(args, opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS));
        return;
      }
      // Same, for caller cancellation.
      if (timeoutHandle.wasCancelled()) {
        reject(new OperationCancelledError(args));
        return;
      }
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code !== 0) {
        reject(
          new GitCommandError(
            `git ${args.join(" ")} exited with code ${code}: ${stderr.trim()}`,
            args,
            code,
            stderr,
          ),
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Spawn a long-lived git process for streaming output (e.g. `git log` over a huge history).
 * Caller owns the returned process and is responsible for reading/pausing stdout and killing it.
 */
export function spawnGit(args: readonly string[], opts: RunOptions): GitChildProcess {
  return spawnGitRaw(args, opts);
}

export interface RunBufferResult {
  stdout: Buffer;
  stderr: string;
}

/**
 * Like `runGit` but returns raw `Buffer` stdout, for binary output (e.g. `cat-file -p` of an image
 * blob, FR-140) that UTF-8 decoding would corrupt.
 */
export function runGitBuffer(args: readonly string[], opts: RunOptions): Promise<RunBufferResult> {
  return opts.mutatesRepository
    ? enqueueGitTask(() => runGitBufferTask(args, opts))
    : runGitBufferTask(args, opts);
}

function runGitBufferTask(args: readonly string[], opts: RunOptions): Promise<RunBufferResult> {
  return new Promise((resolve, reject) => {
    const timeoutHandle = armTimeout(opts);

    let child: GitChildProcess;
    try {
      child = spawnGitRaw(args, { ...opts, signal: timeoutHandle.signal });
    } catch (err) {
      timeoutHandle.clear();
      if (timeoutHandle.wasCancelled()) {
        reject(new OperationCancelledError(args));
        return;
      }
      reject(new GitCommandError(`Failed to start git: ${(err as Error).message}`, args, null, ""));
      return;
    }
    timeoutHandle.bindChild(child);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", (err) => {
      timeoutHandle.clear();
      if (timeoutHandle.wasTimeout()) {
        reject(new GitCommandTimeoutError(args, opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS));
        return;
      }
      if (timeoutHandle.wasCancelled()) {
        reject(new OperationCancelledError(args));
        return;
      }
      reject(new GitCommandError(`Failed to run git: ${err.message}`, args, null, ""));
    });

    child.on("close", (code) => {
      timeoutHandle.clear();
      if (timeoutHandle.wasTimeout()) {
        reject(new GitCommandTimeoutError(args, opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS));
        return;
      }
      if (timeoutHandle.wasCancelled()) {
        reject(new OperationCancelledError(args));
        return;
      }
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code !== 0) {
        reject(
          new GitCommandError(
            `git ${args.join(" ")} exited with code ${code}: ${stderr.trim()}`,
            args,
            code,
            stderr,
          ),
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Like `runGit`, but exit codes in `allowedExitCodes` count as success, for commands where non-zero
 * is a result: `git diff --no-index` exits 1 on differences (FR-20(c)); `git diff --cached --quiet`
 * exits 1 when something is staged (FR-25). Other codes still reject with `GitCommandError`.
 */
export function runGitAllowingExitCodes(
  args: readonly string[],
  opts: RunOptions,
  allowedExitCodes: readonly number[],
): Promise<RunResult & { exitCode: number }> {
  return opts.mutatesRepository
    ? enqueueGitTask(() => runGitAllowingExitCodesTask(args, opts, allowedExitCodes))
    : runGitAllowingExitCodesTask(args, opts, allowedExitCodes);
}

function runGitAllowingExitCodesTask(
  args: readonly string[],
  opts: RunOptions,
  allowedExitCodes: readonly number[],
): Promise<RunResult & { exitCode: number }> {
  return new Promise((resolve, reject) => {
    const timeoutHandle = armTimeout(opts);

    let child: GitChildProcess;
    try {
      child = spawnGitRaw(args, { ...opts, signal: timeoutHandle.signal });
    } catch (err) {
      timeoutHandle.clear();
      if (timeoutHandle.wasCancelled()) {
        reject(new OperationCancelledError(args));
        return;
      }
      reject(
        new GitCommandError(`Failed to start git: ${(err as Error).message}`, args, null, ""),
      );
      return;
    }
    timeoutHandle.bindChild(child);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", (err) => {
      timeoutHandle.clear();
      if (timeoutHandle.wasTimeout()) {
        reject(new GitCommandTimeoutError(args, opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS));
        return;
      }
      if (timeoutHandle.wasCancelled()) {
        reject(new OperationCancelledError(args));
        return;
      }
      reject(new GitCommandError(`Failed to run git: ${err.message}`, args, null, ""));
    });

    child.on("close", (code) => {
      timeoutHandle.clear();
      if (timeoutHandle.wasTimeout()) {
        reject(new GitCommandTimeoutError(args, opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS));
        return;
      }
      if (timeoutHandle.wasCancelled()) {
        reject(new OperationCancelledError(args));
        return;
      }
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      const exitCode = code ?? -1;
      if (!allowedExitCodes.includes(exitCode)) {
        reject(
          new GitCommandError(
            `git ${args.join(" ")} exited with code ${exitCode}: ${stderr.trim()}`,
            args,
            code,
            stderr,
          ),
        );
        return;
      }
      resolve({ stdout, stderr, exitCode });
    });
  });
}

/**
 * Like `runGit`, but pipes `input` to stdin. Used for `git commit -F -` (FR-25) so a message starting
 * with `-` is never parsed as an option. A `Buffer` is written byte-exact (specs/hunk-line-staging.md FR-450).
 */
export function runGitWithInput(
  args: readonly string[],
  opts: RunOptions,
  input: string | Buffer,
): Promise<RunResult> {
  return opts.mutatesRepository
    ? enqueueGitTask(() => runGitWithInputTask(args, opts, input))
    : runGitWithInputTask(args, opts, input);
}

/** Like `runGitWithInput` but returns raw stdout bytes, for `cat-file --batch` blob reads (FR-479). */
export function runGitBufferWithInput(args: readonly string[], opts: RunOptions, input: string | Buffer): Promise<RunBufferResult> {
  return opts.mutatesRepository
    ? enqueueGitTask(() => runGitInputRaw(args, opts, input))
    : runGitInputRaw(args, opts, input);
}

function runGitWithInputTask(args: readonly string[], opts: RunOptions, input: string | Buffer): Promise<RunResult> {
  return runGitInputRaw(args, opts, input).then((r) => ({ stdout: r.stdout.toString("utf8"), stderr: r.stderr }));
}

function runGitInputRaw(
  args: readonly string[],
  opts: RunOptions,
  input: string | Buffer,
): Promise<RunBufferResult> {
  return new Promise((resolve, reject) => {
    const timeoutHandle = armTimeout(opts);
    spawnCount++;
    const gitExecutable = resolveGitExecutablePath();
    let child: ChildProcessByStdio<import("node:stream").Writable, Readable, Readable>;
    try {
      child = spawn(gitExecutable, args as string[], {
        cwd: opts.cwd,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...safeEnv(), ...opts.extraEnv },
        signal: timeoutHandle.signal,
      });
    } catch (err) {
      timeoutHandle.clear();
      if (timeoutHandle.wasCancelled()) {
        reject(new OperationCancelledError(args));
        return;
      }
      reject(
        new GitCommandError(`Failed to start git: ${(err as Error).message}`, args, null, ""),
      );
      return;
    }
    timeoutHandle.bindChild(child);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", (err) => {
      timeoutHandle.clear();
      if (timeoutHandle.wasTimeout()) {
        reject(new GitCommandTimeoutError(args, opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS));
        return;
      }
      if (timeoutHandle.wasCancelled()) {
        reject(new OperationCancelledError(args));
        return;
      }
      reject(new GitCommandError(`Failed to run git: ${err.message}`, args, null, ""));
    });

    child.on("close", (code) => {
      timeoutHandle.clear();
      if (timeoutHandle.wasTimeout()) {
        reject(new GitCommandTimeoutError(args, opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS));
        return;
      }
      if (timeoutHandle.wasCancelled()) {
        reject(new OperationCancelledError(args));
        return;
      }
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code !== 0) {
        reject(
          new GitCommandError(
            `git ${args.join(" ")} exited with code ${code}: ${stderr.trim()}`,
            args,
            code,
            stderr,
          ),
        );
        return;
      }
      resolve({ stdout, stderr });
    });

    // Write and close stdin last: some git versions/platforms start processing stdin as soon
    // as it's writable, and we want listeners above attached first regardless.
    // EPIPE/ECONNRESET here means git exited early (e.g. locked index); an unhandled stream error would
    // crash the host process, and the close handler already reports git's real failure.
    child.stdin.on("error", () => {});
    child.stdin.end(input, "utf8");
  });
}

/** Prefix user/repo-controlled revision args (branch names, SHAs) with `--end-of-options` so git can't parse them as flags. */
export function withEndOfOptions(revisionArgs: readonly string[]): string[] {
  if (revisionArgs.length === 0) return [];
  return ["--end-of-options", ...revisionArgs];
}

/** Build a single-token option=value argv entry. Never split flag/value across two array entries
 * for user-controlled values — keeping them as one token means the value can never itself be
 * misparsed as a separate flag, even if it starts with `-`. */
export function optionEquals(flag: string, value: string): string {
  return `${flag}=${value}`;
}

let cachedVersionCheck: Promise<void> | null = null;

/** Parse "git version 2.31.1.windows.1" -> [2, 31, 1]. Returns null if unparseable. */
export function parseGitVersion(raw: string): [number, number, number] | null {
  const m = raw.match(/git version (\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function versionAtLeast(v: [number, number, number], min: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (v[i]! > min[i]!) return true;
    if (v[i]! < min[i]!) return false;
  }
  return true;
}

/**
 * Verify the installed git supports `--end-of-options` (>= MIN_GIT_VERSION). Cached per process, but
 * only outcomes that describe the installed git: cancellation (FR-165) and `GitCommandTimeoutError`
 * (a slow first spawn under AV/PATH overhead) reject with their own type and are NOT cached, so the
 * next call retries instead of reporting a false "git unsupported" until restart. Cache clearing is
 * guarded by `cachedVersionCheck === attempt` so a newer in-flight attempt isn't clobbered.
 *
 * `signal` (FR-163, specs/repo-open-feedback.md) makes this first-spawn probe cancellable.
 * `timeoutMs` is test-only, as in `RunOptions`.
 */
export function checkGitVersion(cwd: string, signal?: AbortSignal, timeoutMs?: number): Promise<void> {
  if (cachedVersionCheck) return cachedVersionCheck;
  let isTransientOutcome = false;
  const attempt = (async () => {
    let stdout: string;
    try {
      ({ stdout } = await runGit(["--version"], { cwd, signal, timeoutMs }));
    } catch (err) {
      if (err instanceof OperationCancelledError || err instanceof GitCommandTimeoutError) {
        isTransientOutcome = true;
        throw err;
      }
      throw new UnsupportedGitVersionError(null, MIN_GIT_VERSION);
    }
    const parsed = parseGitVersion(stdout);
    const min = parseGitVersion(`git version ${MIN_GIT_VERSION}`)!;
    if (!parsed || !versionAtLeast(parsed, min)) {
      throw new UnsupportedGitVersionError(stdout.trim() || null, MIN_GIT_VERSION);
    }
  })();
  cachedVersionCheck = attempt;
  attempt.catch(() => {
    if (isTransientOutcome && cachedVersionCheck === attempt) {
      cachedVersionCheck = null;
    }
  });
  return attempt;
}

/** Test-only: reset the cached version check. */
export function _resetGitVersionCacheForTests(): void {
  cachedVersionCheck = null;
}

/**
 * FR-162 (specs/repo-open-feedback.md): fire-and-forget startup warm-up that resolves the git path and
 * runs `git --version` (caching both), moving first-exec cost (e.g. AV scanning) off the
 * open-repo spinner. Failures are swallowed so a broken git still surfaces its real error on the first
 * `openRepo`. `cwd` need only be some existing directory (e.g. `os.tmpdir()`).
 */
export function warmUpGitResolution(cwd: string): void {
  void checkGitVersion(cwd).catch(() => {
    /* best-effort only — see this function's own doc comment. */
  });
}

export function pathExists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}
