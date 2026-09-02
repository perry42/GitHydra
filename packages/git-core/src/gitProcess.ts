import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import * as fs from "node:fs";
import * as path from "node:path";
import { GitCommandError, GitNotFoundError, UnsupportedGitVersionError } from "./errors";

/** The shape of every child process we spawn: stdin ignored, stdout/stderr piped. */
export type GitChildProcess = ChildProcessByStdio<null, Readable, Readable>;

/**
 * All process execution for git-core goes through this module. Rules enforced here:
 *
 *  - We only ever call `child_process.spawn` with an argv ARRAY and `shell: false`
 *    (the Node default, but set explicitly). We never build a command string.
 *    That means repo paths, branch names, search terms, etc. can never be interpreted
 *    by a shell, no matter how adversarial (spaces, quotes, `;`, `$(...)`, backticks, ...).
 *
 *  - Revision arguments derived from user/repo-controlled strings (branch names, SHAs)
 *    must be passed through `withEndOfOptions()` before being appended to argv. This
 *    stops a ref literally named e.g. `--upload-pack=/bin/sh` (a real, if obscure, attack
 *    a malicious repo could ship) from being parsed by git as an option instead of a
 *    revision. Requires git >= 2.24 for `--end-of-options`; see checkGitVersion().
 *
 *  - Path filters are always appended after a literal `--` separator.
 *
 *  - We never invoke a pager and never allow an interactive credential/terminal prompt,
 *    since (a) we're non-interactive by construction and (b) per FR-9 this module must
 *    never touch the network, and disabling prompts is a defense-in-depth backstop against
 *    any git command here accidentally hanging on a credential/host-key prompt.
 */

export const MIN_GIT_VERSION = "2.24.0";

export interface RunOptions {
  cwd: string;
  /** Abort an in-flight command, e.g. if the caller closed the repository. */
  signal?: AbortSignal;
  /**
   * Set `true` for any invocation that actually mutates repository state on disk — the index,
   * a ref, or the working tree (`add`, `commit`, `branch -d`, `switch`, `stash push/apply/pop/
   * drop`, `cherry-pick`, `merge`/`rebase --abort`/`--continue`, `restore`, `clean`, `rm`, ...).
   * Routes the call through `enqueueGitTask()`'s single process-wide FIFO queue, so a second
   * mutating call arriving while one is still in flight waits its turn instead of racing it for
   * `.git/index.lock` (or a ref lock). See `enqueueGitTask`'s doc comment for the full design
   * rationale, including why this is opt-in per call rather than applied to every invocation.
   * Left `false`/unset (the default) for pure reads (`status`, `diff`, `log`, `rev-parse`,
   * `cat-file`, `show`, `for-each-ref`, `config --get`, ...) — those never need to queue behind
   * anything, including each other.
   */
  mutatesRepository?: boolean;
  /**
   * Extra environment variables merged on top of `safeEnv()`'s baseline, for a narrowly-scoped
   * override only — never used to loosen any of the safety defaults above (credential prompts
   * stay disabled, the pager stays off, etc, since `safeEnv()`'s values are applied first and
   * `extraEnv` is spread after, so an override here can only ADD variables `safeEnv()` doesn't
   * already set, or intentionally replace one for a specific, documented reason). The one current
   * use (FR-70, `conflicts.ts`'s `continueInProgressOperation`) sets `GIT_EDITOR=true` (and
   * `GIT_SEQUENCE_EDITOR=true`, defensively) so `--continue` can never spawn an interactive
   * external editor — Electron's `child_process` has no TTY to host one, so an unmodified `git
   * commit`/`git rebase --continue` invoking one would hang forever.
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
    // Security: force every pathspec this module ever passes to git (file paths after a
    // literal `--`, `CommitLogFilter.paths`, etc.) to be interpreted LITERALLY, never as a
    // glob/magic pathspec. Without this, git's default pathspec parsing treats `*`, `?`,
    // `[...]`, and a leading `:` specially — e.g. a real, unremarkable filename like a Next.js
    // dynamic route `pages/[id].tsx` has `[id]` parsed as a bracket character class, not a
    // literal path segment, which could make a destructive operation (`discardTrackedFileChanges`,
    // `discardUntrackedFile`) silently match and act on a *different* file than the one the
    // caller named. Confirmed (via repo-wide search) that nothing in this codebase relies on
    // glob pathspec behavior, so this is a safe blanket fix rather than a per-call-site one.
    GIT_LITERAL_PATHSPECS: "1",
  };
}

/**
 * Prepended to any git invocation that reads or refreshes working-tree/index state against a
 * real (non-bare) repository — `status`, a worktree/index-relative `diff`, `add`, `restore`,
 * `clean`, `commit`. Unlike most commands this module runs, these consult the repository's
 * *local* `.git/config` for `core.fsmonitor` and, if it's set to anything other than a
 * recognized boolean, execute it as an external hook — a real risk for a repo distributed as a
 * pre-existing checkout/zip/tarball/bare-repo/worktree (all explicitly-supported per
 * CLAUDE.md, not just a fresh `git clone`, which never copies this local config). See
 * `tests/workingDirStatus.test.ts`'s "fsmonitor argument-injection guard" describe block for
 * the original regression test (including a positive-control proving the exploit is real in
 * this environment) and `tests/gitProcess.test.ts` for coverage of the other call sites that
 * now share this same guard.
 *
 * `-c` always wins over anything read from `.git/config` for that one invocation, so this
 * can't be bypassed by repo-local config no matter what it contains. `false` (git's own
 * canonical "disabled" boolean spelling) is used rather than an empty value for clarity across
 * git versions.
 */
export const NEUTRALIZE_LOCAL_HOOK_CONFIG = ["-c", "core.fsmonitor=false"] as const;

/** Prepend `NEUTRALIZE_LOCAL_HOOK_CONFIG` to an argv array. See its doc comment for when to use this. */
export function withFsmonitorNeutralized(args: readonly string[]): string[] {
  return [...NEUTRALIZE_LOCAL_HOOK_CONFIG, ...args];
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
 * Resolve `git` to a single absolute executable path, once per process, and cache it —
 * every spawn() call in this module uses this resolved path instead of the bare string
 * "git". This is defense-in-depth: `spawn("git", ..., { cwd: <repo dir> })` asks Node to
 * search for git via PATH resolution, and while Node/libuv's Windows PATH search was
 * empirically verified (2026-08-27, see git-core security review) to NOT consult the
 * spawned child's `cwd`, relying on that being true forever, on every platform and Node
 * version, is fragile — and resolving once to an absolute path is essentially free. It
 * also removes any ambiguity about *which* installed git runs when a machine has more
 * than one on PATH.
 *
 * Search order:
 *   1. `GIT_EXEC_PATH`, if set — it identifies a specific git installation's
 *      `libexec/git-core` directory; the `git` binary itself conventionally lives two
 *      directories up, at `<prefix>/bin/git`.
 *   2. Every directory on `PATH`, in order, using the platform's normal executable
 *      resolution (PATHEXT-driven on Windows, executable-bit check elsewhere) — i.e. the
 *      same directories Node would have searched anyway, just resolved by us up front
 *      instead of implicitly by the OS on every spawn.
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

function spawnGitRaw(args: readonly string[], opts: RunOptions): GitChildProcess {
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
 * Serializes every git invocation opted in via `RunOptions.mutatesRepository` (see its doc
 * comment) through a single process-wide FIFO queue, so a second mutating caller arriving while
 * one is still in flight waits its turn instead of racing it for `.git/index.lock` (or a ref
 * lock) — the actual reported bug: two concurrent mutations (e.g. staging a file while applying
 * a stash) both trying to acquire the same lock, with the loser surfacing a raw `GitCommandError`
 * ("Unable to create '.../.git/index.lock': File exists...") straight to the user instead of
 * being queued.
 *
 * Why gate on an explicit opt-in flag rather than queuing every invocation uniformly:
 *  - Verified directly against real git (2026-09-02): a command that only *optionally* refreshes
 *    the index (`git status`, `git diff` against the worktree/index) does NOT fail when
 *    `.git/index.lock` is already held by a concurrent writer — it silently skips that
 *    opportunistic refresh and still succeeds. Only a command that REQUIRES the lock (`git add`,
 *    `git commit`, `git stash push/apply/pop`, ...) fails hard when it can't acquire one. So
 *    "read vs write" (in the sense of "must this be serialized against other mutations")
 *    actually is a clean, correct split here, once verified rather than assumed.
 *  - An earlier version of this fix queued every invocation uniformly (reads included), on the
 *    theory that classifying every call site was itself risky. In practice this made every
 *    concurrent-read pattern already used throughout this codebase (e.g. `Promise.all()` of
 *    several independent `rev-parse`/`show`/`cat-file` reads in `repository.ts`,
 *    `commitChanges.ts`, `stash.ts`, ...) run strictly sequentially instead of in parallel,
 *    which measurably slowed down real operations and caused this package's own test suite to
 *    start missing per-test timeouts under load. Gating on an explicit flag, set only at the
 *    ~20 call sites that actually perform a mutating git subcommand (see each call site's own
 *    `mutatesRepository: true`), fixes the real race with none of that cost.
 *  - This module's call sites span a dozen-plus files, so classifying every one of them here in
 *    a single central "is this argv a write" heuristic would be its own fragile, easy-to-miss-a-
 *    case abstraction; a call-site-local, explicit `true` is easy for a reviewer (and a future
 *    change) to see is correct for that one call, without gitProcess.ts having to know git's
 *    entire subcommand surface.
 *
 * Why a single global queue rather than one keyed per repo path:
 *  - Today exactly one `Repository`/`RepoSession` is ever open at a time in this process (see
 *    `packages/desktop/electron/main.ts`'s single module-level `RepoSession`), so a global queue
 *    serializes precisely the set of git calls that could ever race on the same `.git/index.lock`
 *    — no less, no more.
 *  - Different call sites legitimately pass different-but-equally-valid `cwd` strings for the
 *    SAME open repository — most methods on `Repository` pass `this.state.workdir` (the resolved
 *    toplevel), but a few (`deleteBranch`, `forceDeleteBranch`, `dropStash`,
 *    `abortInProgressOperation`, ...) pass `this.path` (the literal path the repo was opened
 *    with, which only differs from `workdir` when a user opens a *subdirectory* of a repo rather
 *    than its root). A queue keyed by a raw/normalized `cwd` string would fail to serialize those
 *    against each other for that edge case; a single global queue serializes them correctly for
 *    free, with no path-canonicalization (case-insensitivity, symlinks, trailing slashes, ...) to
 *    get subtly wrong.
 *  - If this process ever hosts more than one simultaneously-open repository, this should become
 *    a map keyed by each repo's resolved `gitDir` (the actual directory `index.lock` lives in) —
 *    not by a raw `cwd` string, for the reason above — computed once by `Repository.open()` and
 *    threaded through, rather than re-resolved (and re-queued) on every call.
 *
 * Deliberately NOT applied to `spawnGit()`: that path is used exclusively for long-lived,
 * caller-managed streaming reads (`git log`, paged over possibly minutes of user scrolling — see
 * `commitLog.ts`'s `CommitLogReader`), which never touch `.git/index` and so can never contend
 * for `index.lock` in the first place (and are never called with `mutatesRepository` regardless).
 */
let gitQueueTail: Promise<void> = Promise.resolve();

function enqueueGitTask<T>(task: () => Promise<T>): Promise<T> {
  const runTask = (): Promise<T> => task();
  const result = gitQueueTail.then(runTask, runTask);
  // Advance the queue regardless of whether this task succeeded or failed — a failed git
  // invocation (e.g. a real conflict, a validation error) must never wedge every subsequent
  // git call behind it. Swallow here; `result` (returned to the actual caller below) still
  // carries the real rejection.
  gitQueueTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
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
 * Run a git command to completion and buffer its output. For small/bounded output only.
 * Pass `opts.mutatesRepository: true` for any call that mutates repository state on disk — see
 * `RunOptions.mutatesRepository`'s doc comment.
 */
export function runGit(args: readonly string[], opts: RunOptions): Promise<RunResult> {
  return opts.mutatesRepository ? enqueueGitTask(() => runGitTask(args, opts)) : runGitTask(args, opts);
}

function runGitTask(args: readonly string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let child: GitChildProcess;
    try {
      child = spawnGitRaw(args, opts);
    } catch (err) {
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

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", (err) => {
      reject(
        new GitCommandError(`Failed to run git: ${err.message}`, args, null, ""),
      );
    });

    child.on("close", (code) => {
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

/**
 * Like `runGit`, but treats any exit code in `allowedExitCodes` as success instead of rejecting.
 * Needed for the handful of git invocations where a non-zero exit is an expected, meaningful
 * result rather than a failure:
 *  - `git diff --no-index <a> <b>` exits 1 (not 0) when the two inputs differ — used for
 *    FR-20(c)'s untracked-file diff, which has no index entry to diff against normally.
 *  - `git diff --cached --quiet` exits 1 when there IS a staged difference, 0 when there is
 *    none — used to detect "nothing staged" for FR-25 without parsing diff output.
 * Any exit code NOT in `allowedExitCodes` still rejects with `GitCommandError`, same as `runGit`.
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
    let child: GitChildProcess;
    try {
      child = spawnGitRaw(args, opts);
    } catch (err) {
      reject(
        new GitCommandError(`Failed to start git: ${(err as Error).message}`, args, null, ""),
      );
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", (err) => {
      reject(new GitCommandError(`Failed to run git: ${err.message}`, args, null, ""));
    });

    child.on("close", (code) => {
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
 * Like `runGit`, but pipes `input` to the child's stdin instead of leaving it ignored. Used
 * exclusively for `git commit -F -` (FR-25): the commit message is written to stdin, never
 * built into argv/a shell string, so a message that happens to start with `-` (or contains any
 * other shell/flag-like content) can never be misparsed as an option.
 */
export function runGitWithInput(
  args: readonly string[],
  opts: RunOptions,
  input: string,
): Promise<RunResult> {
  return opts.mutatesRepository
    ? enqueueGitTask(() => runGitWithInputTask(args, opts, input))
    : runGitWithInputTask(args, opts, input);
}

function runGitWithInputTask(
  args: readonly string[],
  opts: RunOptions,
  input: string,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const gitExecutable = resolveGitExecutablePath();
    let child: ChildProcessByStdio<import("node:stream").Writable, Readable, Readable>;
    try {
      child = spawn(gitExecutable, args as string[], {
        cwd: opts.cwd,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...safeEnv(), ...opts.extraEnv },
        signal: opts.signal,
      });
    } catch (err) {
      reject(
        new GitCommandError(`Failed to start git: ${(err as Error).message}`, args, null, ""),
      );
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", (err) => {
      reject(new GitCommandError(`Failed to run git: ${err.message}`, args, null, ""));
    });

    child.on("close", (code) => {
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

    // Write and close stdin last: some git versions/platforms start processing stdin as soon
    // as it's writable, and we want listeners above attached first regardless.
    child.stdin.end(input, "utf8");
  });
}

/**
 * Prefix a list of user/repo-controlled revision arguments (branch names, SHAs, etc.) with
 * `--end-of-options` so git can never interpret one of them as a flag. Always use this for
 * revision-like arguments that did not originate as a literal constant in our own code.
 */
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
 * Verify the installed git is new enough to safely support `--end-of-options`.
 * Cached for the process lifetime (git's version cannot change mid-run).
 */
export function checkGitVersion(cwd: string): Promise<void> {
  if (!cachedVersionCheck) {
    cachedVersionCheck = (async () => {
      let stdout: string;
      try {
        ({ stdout } = await runGit(["--version"], { cwd }));
      } catch {
        throw new UnsupportedGitVersionError(null, MIN_GIT_VERSION);
      }
      const parsed = parseGitVersion(stdout);
      const min = parseGitVersion(`git version ${MIN_GIT_VERSION}`)!;
      if (!parsed || !versionAtLeast(parsed, min)) {
        throw new UnsupportedGitVersionError(stdout.trim() || null, MIN_GIT_VERSION);
      }
    })();
  }
  return cachedVersionCheck;
}

/** Test-only: reset the cached version check. */
export function _resetGitVersionCacheForTests(): void {
  cachedVersionCheck = null;
}

export function pathExists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}
