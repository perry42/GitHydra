import * as fs from "node:fs/promises";
import type { Stats } from "node:fs";
import * as path from "node:path";
import { OperationCancelledError } from "./errors";
import { DEFAULT_GIT_TIMEOUT_MS } from "./gitProcess";

/**
 * Fast, git-process-free pre-check for `resolveRepositoryPaths()`: answers "is `startDir`
 * DEFINITELY not (inside) a git repository" using only plain `fs` calls, so the extremely common
 * case of a user opening a folder that has no `.git` anywhere in its parent chain never has to
 * pay for spawning `git` at all — not even `git --version` (see `checkGitVersion()`'s doc comment
 * in `gitProcess.ts`) — just to be told "no".
 *
 * Real user report this exists to fix: opening a non-repo folder was observed to take a very long
 * time (in the worst case, reportedly close to forever). Timed directly against this repo's own
 * dev machine (see git-core-engineer's investigation notes), the existing all-git-based path for
 * a non-repo folder always pays for one `git --version` spawn (`checkGitVersion`, cached only
 * after the FIRST one) PLUS one combined `git rev-parse` spawn (see `repository.ts`'s own doc
 * comment on that consolidation) before concluding `NotAGitRepositoryError` — every one of those
 * spawns is a real OS process launch, which is
 * exactly the kind of operation real-time antivirus/EDR software hooks and can add very large,
 * highly variable latency to (seconds to tens of seconds per spawn is a documented real-world
 * report for some AV products, independent of the repository's own size or content — confirmed
 * here that a large/deeply-nested non-repo directory takes essentially the same time as an empty
 * one, since none of these commands ever read the directory's own *contents*, only its parent
 * chain). `warmUpGitResolution()` already amortizes that tax to once per app session for the
 * *positive* (real repo) path; this function removes it entirely for the *negative* one, which is
 * the specific scenario reported.
 *
 * Correctness contract — this function is deliberately asymmetric and can only ever short-circuit
 * the NEGATIVE case:
 *   - Returns `"definitely-not-a-repo"` ONLY when it has walked from `startDir` up through every
 *     parent directory, within the same filesystem/device, all the way to a filesystem boundary or
 *     the root, and found no `.git` entry (file, directory, or symlink to either — worktrees and
 *     submodules both use a `.git` *file*, not a directory, containing a `gitdir:` pointer, so
 *     both must count as "found" here even though this function never needs to parse that
 *     pointer itself) and no directory that itself looks like a bare repository.
 *   - Returns `"defer-to-git"` for literally everything else, including any ambiguity: a `.git`
 *     entry found anywhere in the chain, a directory that looks bare, an unexpected fs error
 *     partway through the walk (permission denied, a concurrent delete, ...), the walk exceeding a
 *     generous safety step cap, the walk not finishing within `DEFAULT_GIT_TIMEOUT_MS` (see
 *     below), or (see further below) any of a handful of environment variables being set that
 *     change git's own discovery algorithm in ways this function does not attempt to replicate.
 *     A `"defer-to-git"` verdict changes NOTHING about the caller's existing behavior — it falls
 *     straight through to the exact same `checkGitVersion`/`rev-parse` calls that ran
 *     unconditionally before this function existed. This function can therefore never introduce a
 *     wrong "yes, this is a repo" answer (it never gives a positive answer at all) — the only way
 *     it can misbehave is a false negative, which the deliberately-conservative rules above (defer
 *     on anything not a clean, confident "no") are designed to avoid.
 *
 * Symlinks (security-review finding, 2026-09-04): `startDir` is resolved via a single
 * `fs.realpath()` call BEFORE the upward walk begins, and the walk operates on that fully
 * physical (symlink-free) path from then on — never on the caller-supplied path directly. This
 * matters because a real spawned `git` process (via `chdir()`) always operates on the physical
 * cwd, not whatever symlink chain got there; a walk that used plain `path.dirname()` on the
 * ORIGINAL (possibly symlinked) path could walk up through the symlink's own parent directories
 * instead of its target's, completely missing a real repository that only becomes visible once
 * the symlink is resolved (e.g. `~/work` -> `/mnt/data/project-a`, where `/mnt/data` itself is a
 * repo `~/work` would then be inside — walking up from `~/work` unresolved would visit `~`,
 * `/home`, `/`, never `/mnt/data`). One resolve suffices for the whole walk: every prefix of an
 * already-fully-resolved absolute path is itself already fully resolved, so no per-step
 * re-resolution is needed once this first call succeeds. If `fs.realpath()` itself fails for any
 * reason (the path doesn't exist, a broken symlink, permission denied, a symlink cycle, ...), this
 * function defers to git rather than guessing.
 *
 * No hang risk on a slow/wedged filesystem (security-review finding, 2026-09-04): unlike the
 * `git`-spawn path this function fast-rejects ahead of (which always has `armTimeout()`'s
 * `DEFAULT_GIT_TIMEOUT_MS` backstop even with no caller signal — see `gitProcess.ts`), a plain
 * `fs.stat`/`fs.lstat`/`fs.readFile` call has no built-in timeout or abort-signal support in
 * Node, and can hang indefinitely against a wedged network mount/share. This function cannot
 * force-interrupt such a call (there is no equivalent of SIGKILLing a stuck syscall), but it
 * guarantees the OVERALL operation always makes forward progress: the whole walk races against
 * both the caller's `signal` (rejecting immediately, the moment it fires — via a real event
 * listener, not polled between steps, so it fires even while a single fs call is still in
 * flight) and an internal `DEFAULT_GIT_TIMEOUT_MS` timer that resolves to `"defer-to-git"` on
 * expiry, exactly like a caller with no signal at all gets from the git-spawn path today. A
 * walk that eventually finishes after having already lost that race is simply ignored (its
 * result, whatever it turns out to be, is discarded) — this function only ever returns once,
 * to whichever of the three (finished walk / caller abort / internal timeout) settles first.
 *
 * `GIT_CEILING_DIRECTORIES` IS replicated (see `parseCeilingDirectories()` below), both because
 * it's simple and well-specified (a list of absolute directories where the upward search stops —
 * the ceiling directory itself is still checked, only its parent is not) and because it's the
 * same real, documented env var this codebase's own test suite already relies on (see
 * `repository.test.ts`) to deterministically isolate a test from an ambient repo somewhere above
 * a temp directory (e.g. a developer's home directory that happens to itself be a git repo) —
 * exactly the same real-world hazard a plain upward fs walk has to be correct about.
 *
 * Deliberately NOT replicated (cause an immediate `"defer-to-git"` instead, via the env var check
 * below): `GIT_DIR`/`GIT_WORK_TREE` (bypass discovery entirely and can point anywhere),
 * `GIT_DISCOVERY_ACROSS_FILESYSTEM` (would invert this function's device-boundary stopping rule),
 * `safe.directory`/"dubious ownership" refusal (a config-driven decision only real git can make),
 * and any git version too old to match this repo's own `MIN_GIT_VERSION` assumptions (irrelevant
 * here since a `"defer-to-git"` verdict is the ONLY outcome that ever reaches a real git
 * invocation, where that check already happens).
 */
export type FastRepoDiscoveryVerdict = "definitely-not-a-repo" | "defer-to-git";

/** Generous safety cap on upward walk steps. Real filesystem hierarchies never come close to
 * this; it exists only to bound a pathological/unexpected case (e.g. a symlink loop that somehow
 * keeps reporting a changing `path.dirname()`), never expected to trigger in practice. */
const MAX_WALK_STEPS = 2048;

/**
 * Security-review finding (2026-09-04): GitHydra explicitly supports opening untrusted repos
 * (CLAUDE.md), so a plain `fs.readFile` with no size cap on a file this function doesn't control
 * (`HEAD`, checked against an arbitrary candidate directory that may not be a git dir at all) is
 * inconsistent with this codebase's established pattern of bounding untrusted-content reads
 * (`diff.ts`'s `DEFAULT_MAX_FILE_SIZE_BYTES`, reused by `blame.ts`/`conflicts.ts`). A real HEAD
 * file is always tiny (`ref: refs/heads/<name>\n` or a bare 40/64-hex SHA — well under 100 bytes),
 * so this threshold only ever exists to bound a pathological/adversarial candidate, not to
 * accommodate any legitimate case.
 */
const MAX_HEAD_FILE_SIZE_BYTES = 1024;

/** Env vars that change git's own repository-discovery algorithm in a way this function does not
 * attempt to replicate — see this module's doc comment. Checked once, up front: if ANY is set,
 * every call defers to git immediately, without walking the filesystem at all.
 * `GIT_CEILING_DIRECTORIES` is deliberately NOT in this list — it's parsed and honored directly,
 * see `parseCeilingDirectories()`. */
const DISCOVERY_OVERRIDE_ENV_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_DISCOVERY_ACROSS_FILESYSTEM"] as const;

/**
 * Parse `GIT_CEILING_DIRECTORIES` the same way git itself does: a list of absolute paths,
 * separated by `path.delimiter` (`:` on POSIX, `;` on Windows). Entries that aren't absolute are
 * silently ignored (matching git's own documented behavior) rather than treated as an error.
 * Resolved (via `path.resolve`) so a ceiling entry with a trailing slash, `..`, or different
 * casing-of-separators still compares correctly against the resolved directories this module's
 * walk produces.
 */
function parseCeilingDirectories(): Set<string> {
  const raw = process.env.GIT_CEILING_DIRECTORIES;
  if (!raw) return new Set();
  const result = new Set<string>();
  for (const entry of raw.split(path.delimiter)) {
    if (entry && path.isAbsolute(entry)) result.add(path.resolve(entry));
  }
  return result;
}

const BARE_HEAD_SYMREF_RE = /^ref:\s*refs\//;
const BARE_HEAD_SHA_RE = /^[0-9a-fA-F]{4,64}$/;

/**
 * Conservative approximation of git's own `is_git_directory()`: true when `dir` itself (not a
 * `.git` child of it) looks like the top of a bare repository — `HEAD` parses as either a symref
 * or a raw SHA, and both `objects` and `refs` exist as directories. Never throws; any read failure
 * (most commonly: the paths simply don't exist, the ordinary "not a bare repo" case) means "no".
 * See `MAX_HEAD_FILE_SIZE_BYTES`'s doc comment for why `HEAD`'s size is checked before its content
 * is ever read.
 */
async function looksLikeBareGitDirectory(dir: string): Promise<boolean> {
  try {
    const headPath = path.join(dir, "HEAD");
    const [headStat, objectsStat, refsStat] = await Promise.all([
      fs.stat(headPath),
      fs.stat(path.join(dir, "objects")),
      fs.stat(path.join(dir, "refs")),
    ]);
    if (!objectsStat.isDirectory() || !refsStat.isDirectory()) return false;
    if (!headStat.isFile() || headStat.size > MAX_HEAD_FILE_SIZE_BYTES) return false;
    const head = (await fs.readFile(headPath, "utf8")).trim();
    return BARE_HEAD_SYMREF_RE.test(head) || BARE_HEAD_SHA_RE.test(head);
  } catch {
    return false;
  }
}

/** Case-insensitive-safe comparison key for a resolved absolute path — Windows paths are
 * case-insensitive, so a `GIT_CEILING_DIRECTORIES` entry spelled with different casing than the
 * walk's own resolved directory must still match. A no-op normalization on POSIX, where paths are
 * case-sensitive and this would otherwise risk a false match. */
function pathKey(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

/**
 * The actual upward walk, operating on an already-`fs.realpath()`-resolved, symlink-free absolute
 * starting directory (see `fastCheckRepositoryDiscovery()`'s doc comment for why that resolution
 * must happen before this is called, and why once is enough). Never throws `OperationCancelledError`
 * or anything else caller-cancellation-related — that's handled entirely by the outer wrapper's
 * race, so this function only ever resolves to a verdict, never rejects.
 */
async function walkUpward(resolvedStartDir: string, ceilings: Set<string>): Promise<FastRepoDiscoveryVerdict> {
  let dir = resolvedStartDir;
  let steps = 0;

  try {
    let dirStat: Stats = await fs.stat(dir);

    for (;;) {
      steps += 1;
      if (steps > MAX_WALK_STEPS) return "defer-to-git";

      let dotGitExists = true;
      try {
        await fs.lstat(path.join(dir, ".git"));
      } catch {
        dotGitExists = false;
      }
      if (dotGitExists) return "defer-to-git";

      if (await looksLikeBareGitDirectory(dir)) return "defer-to-git";

      // A ceiling directory is still checked for `.git`/bare-repo-ness (above) — only its PARENT
      // is never examined, matching git's own documented `GIT_CEILING_DIRECTORIES` semantics.
      if (ceilings.has(pathKey(dir))) return "definitely-not-a-repo";

      const parent = path.dirname(dir);
      if (parent === dir) return "definitely-not-a-repo"; // reached the filesystem root

      const parentStat = await fs.stat(parent);
      // Matches git's own DEFAULT (GIT_DISCOVERY_ACROSS_FILESYSTEM unset) behavior: stop at a
      // device/filesystem boundary rather than walking across it.
      if (parentStat.dev !== dirStat.dev) return "definitely-not-a-repo";

      dir = parent;
      dirStat = parentStat;
    }
  } catch {
    // Any unexpected fs error (permission denied on an intermediate directory, a concurrent
    // delete/rename mid-walk, ...) must never produce a false "definitely not a repo" verdict —
    // defer to git, which gives the real, correct answer (including its own real error if the
    // path itself is now gone).
    return "defer-to-git";
  }
}

export async function fastCheckRepositoryDiscovery(
  startDir: string,
  signal?: AbortSignal,
): Promise<FastRepoDiscoveryVerdict> {
  for (const name of DISCOVERY_OVERRIDE_ENV_VARS) {
    if (process.env[name]) return "defer-to-git";
  }

  if (signal?.aborted) {
    throw new OperationCancelledError(["<fs-repo-discovery-walk>"]);
  }

  const ceilings = new Set(Array.from(parseCeilingDirectories(), pathKey));

  let resolvedStartDir: string;
  try {
    // Security-review finding (2026-09-04): resolve symlinks ONCE, up front — see this module's
    // doc comment for why a single resolve suffices for the entire walk, and why skipping this
    // (walking the caller-supplied path's own `path.dirname()` chain directly) could miss a real
    // repository reachable only through a symlinked ancestor directory.
    resolvedStartDir = await fs.realpath(path.resolve(startDir));
  } catch {
    // Doesn't exist, a broken symlink, permission denied, a symlink cycle, ... — never guess.
    return "defer-to-git";
  }

  // Security-review finding (2026-09-04): race the walk against both the caller's signal (an
  // immediate, event-driven rejection — not merely polled between steps, so it fires even while a
  // single fs call within the walk is still in flight) and an internal timeout mirroring
  // gitProcess.ts's own `DEFAULT_GIT_TIMEOUT_MS` bound, so a wedged/slow filesystem (a stuck
  // network mount, the exact case this module's own doc comment calls out) can never hang this
  // check forever with no backstop, the way the git-spawn path it fast-rejects ahead of never
  // could either. See `walkUpward()`'s own doc comment: it never rejects, so the only rejection
  // path here is caller cancellation.
  return new Promise<FastRepoDiscoveryVerdict>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      // A timeout is NOT evidence this is or isn't a repo — it's evidence the filesystem was slow
      // for this one check. Fall through to the real git-based path, which has its own real,
      // working cancellation/timeout machinery, exactly like a caller who supplied no signal at
      // all gets from that path today.
      resolve("defer-to-git");
    }, DEFAULT_GIT_TIMEOUT_MS);
    timer.unref?.();

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new OperationCancelledError(["<fs-repo-discovery-walk>"]));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    function cleanup(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }

    walkUpward(resolvedStartDir, ceilings).then(
      (verdict) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(verdict);
      },
      (err: unknown) => {
        // walkUpward() never rejects (see its own doc comment) — this branch exists only as a
        // defensive belt-and-suspenders, never expected to actually run.
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      },
    );
  });
}
