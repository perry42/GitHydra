// SPDX-License-Identifier: GPL-3.0-or-later
import type { GitChildProcess, TimeoutHandle } from "./gitProcess";
import {
  DEFAULT_GIT_TIMEOUT_MS,
  armTimeout,
  runGit,
  spawnGit,
  withCredentialHelperNeutralized,
  withDangerousTransportsBlocked,
  withEndOfOptions,
} from "./gitProcess";
import { GitCommandError, GitCommandTimeoutError, InvalidArgumentError, OperationCancelledError } from "./errors";
import { redactGitCredentials } from "./credentialRedaction";
import { classifyGitNetworkError } from "./networkErrorClassification";
import type { FetchAllRemotesResult, FetchProgressEvent, FetchRemoteOutcome } from "./types";

/**
 * specs/online-sync-fetch.md FR-320/FR-321/FR-322: `fetchRemote()`/`fetchAllRemotes()` — the only
 * two network-capable functions this package exposes (FR-328; see `tests/noNetworkCalls.test.ts`'s
 * new describe block for the mechanical proof). Everything else in `packages/git-core` remains
 * exactly as offline as it always was.
 */

/** Matches `[remote: ]<Stage name>: NN% (a/b)` — see `FetchProgressEvent`'s own doc comment
 * (types.ts) for exactly which real stderr shapes this was verified against, and the one that was
 * deliberately NOT observed from `fetch` specifically ("Receiving objects"/"Resolving deltas").
 * The stage-name group is non-greedy and requires at least one letter, so it can never swallow the
 * literal word "remote" itself when there's no colon-delimited stage name at all (e.g. a plain
 * `remote: Total 67 (delta 7), ...` summary line, which has no `%` and so never matches this
 * pattern in the first place — correctly falls through to `stage: null` below). */
const PROGRESS_LINE_RE = /^(?:remote:\s*)?([A-Za-z][A-Za-z ]*?):\s*(\d{1,3})%/;

/**
 * FR-322: parse one raw stderr line (already split on `\r`/`\n` by the caller — see
 * `runFetchProcess()`) from a `git fetch --progress` invocation into a `FetchProgressEvent`.
 * Exported for direct unit testing of the parsing logic against the exact real strings this was
 * verified against, independent of spawning a real git process.
 */
export function parseFetchProgressLine(remoteName: string, rawLine: string): FetchProgressEvent {
  // FR-324: every raw line is redacted before it is ever returned from this module, in case a
  // future git version/transport ever echoes a URL (with a possibly-embedded credential) into a
  // progress line — defense in depth, not because any currently-observed progress line does this.
  const raw = redactGitCredentials(rawLine).trim();
  const match = PROGRESS_LINE_RE.exec(raw);
  if (!match) {
    return { remoteName, stage: null, percent: null, raw };
  }
  const parsedPercent = Number(match[2]);
  const percent = Number.isFinite(parsedPercent) ? Math.min(100, Math.max(0, parsedPercent)) : null;
  return { remoteName, stage: match[1]!.trim(), percent, raw };
}

/**
 * FR-321: every remote name `git remote` currently lists, in git's own (alphabetical) order. A
 * pure local config read — never itself a network call (see `tests/noNetworkCalls.test.ts`'s
 * existing describe blocks, which already exercise this indirectly via other flows without ever
 * flagging it, since `git remote` matches none of the forbidden subcommands).
 */
export async function listConfiguredRemotes(cwd: string, signal?: AbortSignal): Promise<string[]> {
  const { stdout } = await runGit(["remote"], { cwd, signal });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export interface FetchRemoteOptions {
  /** specs/repo-open-feedback.md FR-163's same `AbortSignal` mechanism — aborting terminates the
   * underlying `git fetch` process via the same SIGTERM-then-SIGKILL escalation every other
   * cancellable invocation in this package uses (`gitProcess.ts`'s `armEscalation()`). */
  signal?: AbortSignal;
  /** FR-322: called once per parsed stderr line, in order, as `git fetch --progress` runs.
   * Never called after this call's promise has settled (success, error, or cancellation). */
  onProgress?: (event: FetchProgressEvent) => void;
}

/**
 * FR-320: `git fetch <remoteName>` — plain, no `--prune`, no `--tags` beyond git's own default (see
 * the spec's Non-goals). `--progress` is added so `options.onProgress` actually receives anything
 * (see `FetchProgressEvent`'s doc comment for why it's otherwise silent when piped). `remoteName`
 * is passed through `withEndOfOptions()` (same convention every other user/repo-controlled
 * revision-like argv value in this package uses) so a remote literally named e.g. `--upload-pack=…`
 * can never be misparsed as a flag.
 *
 * FR-325: the invocation always passes `-c credential.helper=` (`withCredentialHelperNeutralized()`,
 * `gitProcess.ts`) — without it, a missing/rejected credential can hang indefinitely against a
 * configured GUI credential helper instead of failing fast into a classifiable error. See that
 * function's own doc comment for the real, measured numbers this was verified against.
 *
 * Throws `GitCommandError` (stderr available for `classifyGitNetworkError()`, FR-323) on git
 * reporting failure, `GitCommandTimeoutError` if neither a caller `signal` nor a completed process
 * arrives within `DEFAULT_GIT_TIMEOUT_MS`, or `OperationCancelledError` (FR-165's same distinct
 * third outcome, never folded into either of the above) if `options.signal` aborts. Throws
 * `InvalidArgumentError` (no git call made) for an empty/whitespace-only `remoteName`.
 */
export async function fetchRemote(
  cwd: string,
  remoteName: string,
  options: FetchRemoteOptions = {},
): Promise<void> {
  if (!remoteName || !remoteName.trim()) {
    throw new InvalidArgumentError("fetchRemote requires a non-empty remote name.");
  }
  const args = withDangerousTransportsBlocked(
    withCredentialHelperNeutralized(["fetch", "--progress", ...withEndOfOptions([remoteName])]),
  );
  await runFetchProcess(args, cwd, remoteName, options.signal, options.onProgress);
}

/**
 * FR-321: fetch every remote `git remote` currently lists, **sequentially, one `fetchRemote()`
 * call per remote** — deliberately never `git fetch --all`, so a failure on one remote is always
 * attributable to that specific remote (`FetchRemoteOutcome.remoteName`) and never blended with
 * another remote's result into one opaque combined error. A repository with zero remotes
 * configured resolves to `{ outcomes: [] }` — nothing to fetch, not a failure.
 *
 * `options.signal` cancels the ENTIRE call, not just the currently-in-flight remote: cancellation
 * is a distinct, third outcome from both success and per-remote failure (matching every other
 * cancellable call in this package — see `OperationCancelledError`'s own doc comment), so a
 * cancellation always rejects this call directly rather than being folded into some remote's
 * per-outcome `"error"` entry. Every remote fetched successfully BEFORE the cancellation took
 * effect keeps its already-updated tracking refs (git itself already committed that fetch to disk
 * by the time the next iteration's `fetchRemote()` call observes the abort) — only the
 * currently-in-flight (if any) and not-yet-started remotes are affected.
 *
 * A `GitCommandError` from an individual `fetchRemote()` call is classified via
 * `classifyGitNetworkError()` (FR-323) using that error's own `stderr`. A `GitCommandTimeoutError`
 * (no real stderr exists — the process was killed before producing a final message) is reported as
 * `"unknown"` with that error's own message text as `rawStderr`, since no closed-set pattern can
 * be matched against output that was never produced.
 */
export async function fetchAllRemotes(cwd: string, options: FetchRemoteOptions = {}): Promise<FetchAllRemotesResult> {
  const remoteNames = await listConfiguredRemotes(cwd, options.signal);
  const outcomes: FetchRemoteOutcome[] = [];

  for (const remoteName of remoteNames) {
    try {
      await fetchRemote(cwd, remoteName, options);
      outcomes.push({ remoteName, status: "ok" });
    } catch (err) {
      // FR-165's convention, reused here: a caller cancellation is never folded into a per-remote
      // failure outcome — it propagates immediately, stopping the loop.
      if (err instanceof OperationCancelledError) throw err;
      if (err instanceof GitCommandError) {
        outcomes.push({ remoteName, status: "error", error: classifyGitNetworkError(err.stderr) });
      } else if (err instanceof GitCommandTimeoutError) {
        outcomes.push({
          remoteName,
          status: "error",
          error: { kind: "unknown", message: redactGitCredentials(err.message), rawStderr: "" },
        });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        outcomes.push({
          remoteName,
          status: "error",
          error: { kind: "unknown", message: redactGitCredentials(message), rawStderr: "" },
        });
      }
    }
  }

  return { outcomes };
}

/**
 * Runs one `git fetch` invocation to completion, reading its stderr incrementally (rather than
 * only buffering it, the way `runGit` does) so `onProgress` receives updates as they happen, not
 * all at once at the very end. Mirrors `gitProcess.ts`'s own `runGitTask()` almost exactly —
 * spawn, bind the timeout handle's child, resolve/reject on `"error"`/`"close"` with the same
 * timeout/cancellation-vs-failure precedence — the one real difference is reading `child.stderr`
 * incrementally instead of only buffering it for a final error message.
 */
function runFetchProcess(
  args: readonly string[],
  cwd: string,
  remoteName: string,
  signal: AbortSignal | undefined,
  onProgress: ((event: FetchProgressEvent) => void) | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeoutHandle: TimeoutHandle = armTimeout({ cwd, signal });

    let child: GitChildProcess;
    try {
      child = spawnGit(args, { cwd, signal: timeoutHandle.signal });
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

    const stderrChunks: Buffer[] = [];
    // git's `--progress` meter separates in-place updates with a bare `\r` (no `\n`) and only
    // emits a real `\n` once a stage finishes — verified directly (types.ts's `FetchProgressEvent`
    // doc comment has the full writeup). Splitting on either lets a caller see every meaningful
    // update as it arrives rather than one buffered blob at the end.
    let tail = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      if (!onProgress) return;
      tail += chunk.toString("utf8");
      const lines = tail.split(/\r\n|\r|\n/);
      tail = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        onProgress(parseFetchProgressLine(remoteName, line));
      }
    });
    // `git fetch` prints nothing meaningful to stdout — drained only so the pipe never backs up
    // and stalls the child process.
    child.stdout.on("data", () => {});

    const finish = (fn: () => void) => {
      timeoutHandle.clear();
      fn();
    };

    child.on("error", (err) => {
      finish(() => {
        if (timeoutHandle.wasTimeout()) {
          reject(new GitCommandTimeoutError(args, DEFAULT_GIT_TIMEOUT_MS));
          return;
        }
        if (timeoutHandle.wasCancelled()) {
          reject(new OperationCancelledError(args));
          return;
        }
        reject(new GitCommandError(`Failed to run git: ${err.message}`, args, null, ""));
      });
    });

    child.on("close", (code) => {
      finish(() => {
        if (timeoutHandle.wasTimeout()) {
          reject(new GitCommandTimeoutError(args, DEFAULT_GIT_TIMEOUT_MS));
          return;
        }
        if (timeoutHandle.wasCancelled()) {
          reject(new OperationCancelledError(args));
          return;
        }
        // Flush a final, still-buffered partial line (no trailing `\r`/`\n` ever arrived because
        // the process simply ended) so a caller's last real progress update is never silently
        // dropped — mirrors `CommitLogReader`'s own "flush whatever's left once the stream ends"
        // handling for the exact same reason.
        if (onProgress && tail.trim()) {
          onProgress(parseFetchProgressLine(remoteName, tail));
          tail = "";
        }
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        if (code !== 0) {
          reject(
            new GitCommandError(`git ${args.join(" ")} exited with code ${code}: ${stderr.trim()}`, args, code, stderr),
          );
          return;
        }
        resolve();
      });
    });
  });
}
