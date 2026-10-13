// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { GitCommandError } from "./errors";
import { getEmptyHooksDir } from "./emptyHooksDir";
import { runInMutationQueue, withEndOfOptions } from "./gitProcess";
import { listWorktrees, type WorktreeEntry, type WorktreeList } from "./worktreeList";
import {
  realpathBestEffort,
  relatePaths,
  validateWorktreeDestination,
  verifyWorktreeMetadata,
  type DestinationRefusalReason,
  type WorktreeDistrustReason,
} from "./worktreePaths";
import { toWorktreeError, wtRun, wtRunAllowing } from "./worktreeRunner";

/**
 * specs/worktrees.md FR-602..605, FR-638, FR-641. Expected refusals come back as `{ ok: false, reason }` results with NO
 * side effects; only unexpected git failures throw, as the redacted `WorktreeOperationError`. Every mutation is one entry
 * in the global mutation queue, so inner git calls below omit `mutatesRepository`.
 */

const ADD_TIMEOUT_MS = 5 * 60_000;
const NUL_SPLIT = "\0";

// --- small git helpers (all through the worktree runner) ---

async function isValidBranchName(cwd: string, name: string): Promise<boolean> {
  // eslint-disable-next-line no-control-regex
  if (name === "" || name.startsWith("-") || /[\u0000-\u001f\u007f]/.test(name)) return false;
  const r = await wtRunAllowing(["check-ref-format", "--branch", name], cwd, [0, 1, 128]);
  // `--branch` expands "@{-1}" style names; a result that differs from the input is not a name we were given.
  return r.exitCode === 0 && r.stdout.replace(/\r?\n$/, "") === name;
}

async function refExists(cwd: string, fullRef: string): Promise<boolean> {
  const r = await wtRunAllowing(["show-ref", "--verify", "--quiet", fullRef], cwd, [0, 1, 128]);
  return r.exitCode === 0;
}

async function resolveCommit(cwd: string, rev: string): Promise<string | null> {
  if (rev === "" || rev.startsWith("-")) return null;
  const r = await wtRunAllowing(["rev-parse", "--verify", "--quiet", ...withEndOfOptions([`${rev}^{commit}`])], cwd, [0, 1, 128]);
  const sha = r.stdout.trim();
  return r.exitCode === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

const sameFolder = (a: string, b: string): boolean => relatePaths(a, b) === "same";

// --- FR-602 addWorktree ---

export type AddWorktreeSource =
  | { kind: "branch"; branch: string }
  | { kind: "newBranch"; branch: string; startPoint: string }
  | { kind: "detached"; commit: string }
  | { kind: "remoteBranch"; remote: string; branch: string };

export interface AddWorktreeOptions {
  /** FR-644: the user chose "Run hook". Default false: `post-checkout` cannot run. `core.fsmonitor` is neutralised either way. */
  runPostCheckoutHook?: boolean;
}

export type AddWorktreeRefusalReason =
  | "destination"
  | "branchCheckedOut"
  | "invalidBranchName"
  | "branchExists"
  | "branchNotFound"
  | "startPointNotFound"
  | "emptyRepository"
  | "remoteNotFound"
  | "remoteBranchNotFound"
  | "dubiousOwnership";

export type AddWorktreeResult =
  | {
      ok: true;
      path: string;
      /** The new worktree's listing entry (null only if it could not be re-read). */
      entry: WorktreeEntry | null;
      branch: string | null;
      head: string;
      createdBranch: boolean;
      /** FR-602 "created, but <reason>": git reported a failure after creating the worktree; it is kept. */
      warning: { reason: "createdButFailed" } | null;
    }
  | {
      ok: false;
      reason: AddWorktreeRefusalReason;
      message: string;
      destinationReason?: DestinationRefusalReason;
      /** branchCheckedOut / destination: the worktree in the way. */
      worktreePath?: string;
      branch?: string | null;
    };

const refusal = (
  reason: AddWorktreeRefusalReason,
  message: string,
  extra: { destinationReason?: DestinationRefusalReason; worktreePath?: string; branch?: string | null } = {},
): AddWorktreeResult => ({ ok: false, reason, message, ...extra });

/** Directories that do not exist yet along `p`, deepest first: the only ones a failed add may remove again. */
async function missingDirsFor(p: string): Promise<string[]> {
  const missing: string[] = [];
  let cur = p;
  for (;;) {
    const exists = await fs.lstat(cur).then(() => true, () => false);
    if (exists) return missing;
    missing.push(cur);
    const parent = path.dirname(cur);
    if (parent === cur) return missing;
    cur = parent;
  }
}

export function addWorktree(
  repoPath: string,
  destination: string,
  source: AddWorktreeSource,
  options: AddWorktreeOptions = {},
): Promise<AddWorktreeResult> {
  return runInMutationQueue(() => addWorktreeCore(repoPath, destination, source, options));
}

async function addWorktreeCore(
  repoPath: string,
  destination: string,
  source: AddWorktreeSource,
  options: AddWorktreeOptions,
): Promise<AddWorktreeResult> {
  const list = await listWorktrees(repoPath);
  const cwd = list.mainPath;

  let flags: string[] = [];
  let commitish: string;
  let newBranchName: string | null = null;
  let createdFrom: string | null = null;
  let expectBranch: string | null = null;

  const checkedOut = (name: string): WorktreeEntry | undefined => list.entries.find((e) => e.branch === name);

  switch (source.kind) {
    case "branch": {
      if (!(await isValidBranchName(cwd, source.branch))) return refusal("invalidBranchName", "That is not a valid branch name.");
      if (!(await refExists(cwd, `refs/heads/${source.branch}`))) return refusal("branchNotFound", "That branch does not exist.");
      const other = checkedOut(source.branch);
      if (other) return refusal("branchCheckedOut", "That branch is already checked out in another worktree.", { worktreePath: other.path, branch: source.branch });
      commitish = source.branch;
      expectBranch = source.branch;
      break;
    }
    case "newBranch": {
      if (!(await isValidBranchName(cwd, source.branch))) return refusal("invalidBranchName", "That is not a valid branch name.");
      if (await refExists(cwd, `refs/heads/${source.branch}`)) return refusal("branchExists", "A branch with that name already exists.");
      const sha = await resolveCommit(cwd, source.startPoint);
      if (!sha) {
        const hasCommits = (await resolveCommit(cwd, "HEAD")) !== null;
        return hasCommits
          ? refusal("startPointNotFound", "The starting commit does not exist.")
          : refusal("emptyRepository", "This repository has no commits yet.");
      }
      flags = ["-b", source.branch];
      commitish = sha;
      newBranchName = source.branch;
      createdFrom = sha;
      expectBranch = source.branch;
      break;
    }
    case "detached": {
      const sha = await resolveCommit(cwd, source.commit);
      if (!sha) {
        const hasCommits = (await resolveCommit(cwd, "HEAD")) !== null;
        return hasCommits ? refusal("startPointNotFound", "That commit does not exist.") : refusal("emptyRepository", "This repository has no commits yet.");
      }
      flags = ["--detach"];
      commitish = sha;
      break;
    }
    case "remoteBranch": {
      const remotes = (await wtRun(["remote"], cwd)).stdout.split("\n").map((l) => l.replace(/\r$/, ""));
      if (!remotes.includes(source.remote) || source.remote === "") return refusal("remoteNotFound", "That remote is not configured.");
      if (!(await isValidBranchName(cwd, source.branch))) return refusal("invalidBranchName", "That is not a valid branch name.");
      const remoteRef = `refs/remotes/${source.remote}/${source.branch}`;
      if (!(await refExists(cwd, remoteRef))) return refusal("remoteBranchNotFound", "That remote branch is not known locally. Fetch first.");
      if (await refExists(cwd, `refs/heads/${source.branch}`)) return refusal("branchExists", "A local branch with that name already exists.");
      const sha = await resolveCommit(cwd, remoteRef);
      flags = ["--track", "-b", source.branch];
      commitish = remoteRef;
      newBranchName = source.branch;
      createdFrom = sha;
      expectBranch = source.branch;
      break;
    }
  }

  const dest = await validateWorktreeDestination(repoPath, destination, { list });
  if (!dest.ok) {
    return refusal("destination", dest.message, { destinationReason: dest.reason, worktreePath: dest.worktreePath, branch: dest.branch });
  }

  const beforeIds = new Set(list.entries.map((e) => e.id));
  const createdDirs = await missingDirsFor(dest.path);
  const hookOverride = options.runPostCheckoutHook ? [] : ["-c", `core.hooksPath=${await getEmptyHooksDir()}`];

  try {
    await wtRun([...hookOverride, "worktree", "add", ...flags, "--", dest.path, commitish], cwd, { timeoutMs: ADD_TIMEOUT_MS });
  } catch (err) {
    if (!(err instanceof GitCommandError)) throw err;
    const after = await listWorktrees(repoPath).catch(() => null);
    const created = after?.entries.find((e) => !e.isMain && !beforeIds.has(e.id) && e.supported && sameFolder(e.path, dest.path)) ?? null;
    if (created) {
      return {
        ok: true,
        path: dest.path,
        entry: created,
        branch: created.branch,
        head: created.head ?? "",
        createdBranch: newBranchName !== null,
        warning: { reason: "createdButFailed" },
      };
    }
    await rollbackAdd(cwd, newBranchName, createdFrom, createdDirs, after);
    if (/dubious ownership|safe\.directory/i.test(err.stderr)) {
      return refusal("dubiousOwnership", "Git refused to work in this repository because of its ownership.");
    }
    const owner = /(?:is already (?:checked out|used by worktree) at|already checked out at) '([^']+)'/.exec(err.stderr);
    if (owner && expectBranch) return refusal("branchCheckedOut", "That branch is already checked out in another worktree.", { worktreePath: owner[1], branch: expectBranch });
    throw toWorktreeError("add", err);
  }

  const after = await listWorktrees(repoPath).catch(() => null);
  const entry = after?.entries.find((e) => !e.isMain && e.supported && sameFolder(e.path, dest.path)) ?? null;
  return {
    ok: true,
    path: dest.path,
    entry,
    branch: entry ? entry.branch : expectBranch,
    head: entry?.head ?? (createdFrom ?? ""),
    createdBranch: newBranchName !== null,
    warning: null,
  };
}

/** Removes only what this call made: the branch (compare-and-delete at the start commit) and empty folders it would have created. */
async function rollbackAdd(
  cwd: string,
  branch: string | null,
  startSha: string | null,
  createdDirs: readonly string[],
  after: WorktreeList | null,
): Promise<void> {
  if (branch && startSha && !after?.entries.some((e) => e.branch === branch)) {
    const ref = `refs/heads/${branch}`;
    await wtRunAllowing(["update-ref", "-d", ref, startSha], cwd, [0, 1, 128]).catch(() => undefined);
    // `--track` leaves a config section behind; the branch did not exist before, so neither did this section.
    await wtRunAllowing(["config", "--remove-section", `branch.${branch}`], cwd, [0, 1, 128]).catch(() => undefined);
  }
  for (const dir of createdDirs) await fs.rmdir(dir).catch(() => undefined);
}

// --- FR-603 / FR-641 removeWorktree ---

export interface RemoveWorktreeOptions {
  /** The path the user confirmed; re-checked against a fresh listing (FR-641). */
  confirmedPath: string;
  /** Honoured only for `dirty` and `hasSubmodules`; never for locked or main. */
  force?: boolean;
}

export type RemoveWorktreeRefusal =
  | { reason: "dirty"; count: number; dirtySubmodules: string[] }
  | { reason: "locked"; lockReason: string | null }
  | { reason: "hasSubmodules"; submodules: string[]; dirtySubmodules: string[] }
  | { reason: "inUse" }
  | { reason: "main" }
  | { reason: "unsupported" }
  | { reason: "symlinkTarget" }
  | { reason: "unsafeTarget" }
  | { reason: "notAWorktree"; distrust: WorktreeDistrustReason }
  | { reason: "missing" }
  | { reason: "notFound" }
  | { reason: "pathChanged" };

export type RemoveWorktreeResult =
  | { ok: true; id: string; path: string; branch: string | null; linksUnlinked: number }
  | ({ ok: false; message: string } & RemoveWorktreeRefusal);

const REMOVE_MESSAGES: Record<RemoveWorktreeRefusal["reason"], string> = {
  dirty: "The worktree has uncommitted changes.",
  locked: "The worktree is locked.",
  hasSubmodules: "The worktree contains submodules.",
  inUse: "Close programs using this folder and try again.",
  main: "The main worktree cannot be removed.",
  unsupported: "This worktree entry cannot be trusted.",
  symlinkTarget: "The worktree folder is a link.",
  unsafeTarget: "This folder cannot be removed safely.",
  notAWorktree: "Not a worktree of this repository.",
  missing: "The worktree's folder is missing.",
  notFound: "No such worktree.",
  pathChanged: "The worktree changed since it was confirmed.",
};

const denied = (r: RemoveWorktreeRefusal): RemoveWorktreeResult => ({ ok: false, message: REMOVE_MESSAGES[r.reason], ...r });

/** Tracked changes + untracked files (each untracked directory counted by its files); ignored files are not counted. */
export function countStatusEntries(statusZ: string): { count: number; paths: string[] } {
  const fields = statusZ.split(NUL_SPLIT);
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    if (f.length < 4) continue;
    paths.push(f.slice(3));
    // Renames/copies carry the old path as an extra field.
    if (/[RC]/.test(f.slice(0, 2))) i++;
  }
  return { count: paths.length, paths };
}

export interface WorktreeContentState {
  count: number;
  /** Populated submodule folders (paths relative to the worktree). */
  submodules: string[];
  /** The subset with uncommitted changes. */
  dirtySubmodules: string[];
}

async function inspectContent(worktreePath: string): Promise<WorktreeContentState> {
  const [status, staged] = await Promise.all([
    wtRun(["status", "--porcelain=v1", "-z", "-uall", "--ignore-submodules=none"], worktreePath),
    wtRun(["ls-files", "--stage", "-z"], worktreePath),
  ]);
  const { count, paths } = countStatusEntries(status.stdout);
  const submodules: string[] = [];
  for (const rec of staged.stdout.split(NUL_SPLIT)) {
    const tab = rec.indexOf("\t");
    if (tab < 0 || !rec.startsWith("160000 ")) continue;
    const sub = rec.slice(tab + 1);
    // Git itself only objects to a populated submodule (one with its own `.git`).
    if (await fs.lstat(path.join(worktreePath, sub, ".git")).then(() => true, () => false)) submodules.push(sub);
  }
  const dirtySubmodules = submodules.filter((s) => paths.includes(s));
  return { count, submodules, dirtySubmodules };
}

export type WorktreeRemovalState = ({ ok: true } & WorktreeContentState) | { ok: false; reason: WorktreeDistrustReason };

/** FR-601/FR-603: the dirty count for ONE entry, on demand, only after FR-640 trusts it. */
export async function getWorktreeRemovalState(repoPath: string, id: string): Promise<WorktreeRemovalState> {
  const list = await listWorktrees(repoPath);
  const entry = list.entries.find((e) => e.id !== null && e.id === id);
  if (!entry) return { ok: false, reason: "not-registered" };
  if (list.untrusted) return { ok: false, reason: "untrusted-list" };
  if (!entry.supported) return { ok: false, reason: "unsupported" };
  const v = await verifyWorktreeMetadata({
    commonDir: list.commonDir,
    mainPath: list.mainPath,
    mainIsBare: list.entries[0]!.isBare,
    id,
    worktreePath: entry.path,
  });
  if (!v.trusted) return { ok: false, reason: v.reason };
  return { ok: true, ...(await inspectContent(entry.path)) };
}

/**
 * git for Windows deletes THROUGH a directory junction (verified on 2.31: an ignored junction to an outside folder lost
 * the outside files on a plain remove). Links are unlinked first so only the link itself goes; POSIX git never follows them.
 */
async function unlinkReparsePoints(root: string): Promise<number> {
  if (process.platform !== "win32") return 0;
  let unlinked = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        await fs.unlink(full).catch(() => fs.rmdir(full));
        unlinked++;
      } else if (entry.isDirectory()) {
        stack.push(full);
      }
    }
  }
  return unlinked;
}

const BUSY_STDERR = /failed to delete|Directory not empty|Permission denied|Device or resource busy|being used by another process|Invalid argument/i;

export function removeWorktree(repoPath: string, id: string | null, options: RemoveWorktreeOptions): Promise<RemoveWorktreeResult> {
  return runInMutationQueue(() => removeCore(repoPath, id, options));
}

async function removeCore(repoPath: string, id: string | null, options: RemoveWorktreeOptions): Promise<RemoveWorktreeResult> {
  const list = await listWorktrees(repoPath);
  const mainReal = await realpathBestEffort(list.mainPath);
  const confirmedReal = await realpathBestEffort(options.confirmedPath);

  if (id === null || relatePaths(mainReal, confirmedReal) === "same") return denied({ reason: "main" });
  const entry = list.entries.find((e) => e.id === id);
  if (!entry) return denied({ reason: "notFound" });
  if (entry.isMain) return denied({ reason: "main" });
  if (list.untrusted || !entry.supported) return denied({ reason: "unsupported" });
  const entryReal = await realpathBestEffort(entry.path);
  if (relatePaths(mainReal, entryReal) === "same") return denied({ reason: "main" });
  if (relatePaths(path.resolve(entry.path), path.resolve(options.confirmedPath)) !== "same") return denied({ reason: "pathChanged" });

  if (entry.locked) return denied({ reason: "locked", lockReason: entry.lockReason });
  if (entry.prunable) return denied({ reason: "missing" });

  const st = await fs.lstat(entry.path).catch(() => null);
  if (!st) return denied({ reason: "missing" });
  if (st.isSymbolicLink()) return denied({ reason: "symlinkTarget" });

  const commonReal = await realpathBestEffort(list.commonDir);
  const homeReal = await fs.realpath(os.homedir()).catch(() => null);
  const target = entryReal;
  const callerReal = await realpathBestEffort(repoPath);
  if (path.parse(target).root === target || (homeReal !== null && relatePaths(homeReal, target) === "same")) return denied({ reason: "unsafeTarget" });
  if (relatePaths(target, mainReal) !== "outside" || relatePaths(target, commonReal) !== "outside") return denied({ reason: "unsafeTarget" });
  for (const other of list.entries) {
    if (other.isMain || other.id === id || !other.supported) continue;
    if (relatePaths(target, await realpathBestEffort(other.path)) !== "outside") return denied({ reason: "unsafeTarget" });
  }
  // The caller's own folder is held open by the caller: removing it would be the in-use case by construction.
  if (relatePaths(target, callerReal) !== "outside") return denied({ reason: "inUse" });

  const trust = await verifyWorktreeMetadata({
    commonDir: list.commonDir,
    mainPath: list.mainPath,
    mainIsBare: list.entries[0]!.isBare,
    id,
    worktreePath: entry.path,
  });
  if (!trust.trusted) return trust.reason === "missing" ? denied({ reason: "missing" }) : denied({ reason: "notAWorktree", distrust: trust.reason });

  const content = await inspectContent(entry.path);
  const needsForce = content.count > 0 || content.submodules.length > 0;
  if (needsForce && !options.force) {
    return content.count > 0
      ? denied({ reason: "dirty", count: content.count, dirtySubmodules: content.dirtySubmodules })
      : denied({ reason: "hasSubmodules", submodules: content.submodules, dirtySubmodules: content.dirtySubmodules });
  }

  let linksUnlinked = 0;
  try {
    linksUnlinked = await unlinkReparsePoints(entry.path);
  } catch {
    return denied({ reason: "inUse" });
  }

  // cwd is the main worktree, never inside the target; the single force flag below is the only one in this module.
  try {
    await wtRun(["worktree", "remove", ...(needsForce ? ["--force"] : []), "--", entry.path], list.mainPath);
  } catch (err) {
    if (!(err instanceof GitCommandError)) throw err;
    const text = err.stderr;
    if (/locked/i.test(text) && /cannot remove a locked/i.test(text)) return denied({ reason: "locked", lockReason: entry.lockReason });
    if (/containing submodules/i.test(text)) return denied({ reason: "hasSubmodules", submodules: content.submodules, dirtySubmodules: content.dirtySubmodules });
    if (/contains modified or untracked files/i.test(text)) {
      const again = await inspectContent(entry.path).catch(() => content);
      return denied({ reason: "dirty", count: again.count, dirtySubmodules: again.dirtySubmodules });
    }
    if (BUSY_STDERR.test(text)) return denied({ reason: "inUse" });
    throw toWorktreeError("remove", err);
  }
  return { ok: true, id, path: entry.path, branch: entry.branch, linksUnlinked };
}

// --- FR-604 pruneWorktree ---

export interface PrunedEntry {
  id: string;
  reason: string;
  /** The folder git recorded for it, when the listing knows it. */
  path: string | null;
}

export interface PruneWorktreeOptions {
  /** Ids of OTHER entries the user saw listed and agreed to forget as well. */
  acceptAlsoForgotten?: readonly string[];
}

export type PruneWorktreeResult =
  | { ok: true; id: string; forgotten: PrunedEntry[]; /** Forgotten by the real run although the dry run did not list them. */ alsoForgot: PrunedEntry[] }
  | { ok: false; reason: "confirmationRequired"; message: string; alsoForgotten: PrunedEntry[] }
  | { ok: false; reason: "notFound" | "main" | "unsupported" | "notPrunable" | "locked"; message: string };

/** Lines of `worktree prune --verbose`: "Removing worktrees/<id>: <reason>". */
export function parsePruneVerbose(text: string): { id: string; reason: string }[] {
  const out: { id: string; reason: string }[] = [];
  for (const line of text.split("\n")) {
    const m = /^Removing worktrees\/(.+?): (.*?)\r?$/.exec(line);
    if (m) out.push({ id: m[1]!, reason: m[2]! });
  }
  return out;
}

export function pruneWorktree(repoPath: string, id: string, options: PruneWorktreeOptions = {}): Promise<PruneWorktreeResult> {
  return runInMutationQueue(() => pruneCore(repoPath, id, options));
}

async function pruneCore(repoPath: string, id: string, options: PruneWorktreeOptions): Promise<PruneWorktreeResult> {
  const fail = (reason: "notFound" | "main" | "unsupported" | "notPrunable" | "locked", message: string): PruneWorktreeResult => ({ ok: false, reason, message });
  const list = await listWorktrees(repoPath);
  const entry = list.entries.find((e) => e.id !== null && e.id === id);
  if (!entry) return fail("notFound", "No such worktree.");
  if (list.untrusted || !entry.supported) return fail("unsupported", "This worktree entry cannot be trusted.");
  if (entry.locked) return fail("locked", "The worktree is locked.");
  if (!entry.prunable) return fail("notPrunable", "Git does not consider this worktree stale.");

  const describe = (e: { id: string; reason: string }): PrunedEntry => ({
    id: e.id,
    reason: e.reason,
    path: list.entries.find((x) => x.id === e.id)?.path ?? null,
  });
  const dry = await wtRun(["worktree", "prune", "--dry-run", "--verbose"], list.mainPath).catch((err) => {
    throw toWorktreeError("prune", err);
  });
  const planned = parsePruneVerbose(`${dry.stdout}\n${dry.stderr}`);
  if (!planned.some((p) => p.id === id)) return fail("notPrunable", "Git does not consider this worktree stale.");

  const accepted = new Set(options.acceptAlsoForgotten ?? []);
  const others = planned.filter((p) => p.id !== id);
  if (others.some((o) => !accepted.has(o.id))) {
    return {
      ok: false,
      reason: "confirmationRequired",
      message: "Clean up would also forget other missing worktrees.",
      alsoForgotten: others.map(describe),
    };
  }

  const real = await wtRun(["worktree", "prune", "--verbose"], list.mainPath).catch((err) => {
    throw toWorktreeError("prune", err);
  });
  const done = parsePruneVerbose(`${real.stdout}\n${real.stderr}`);
  const plannedIds = new Set(planned.map((p) => p.id));
  return {
    ok: true,
    id,
    forgotten: done.map(describe),
    alsoForgot: done.filter((d) => !plannedIds.has(d.id)).map(describe),
  };
}

// --- FR-605 removeWorktreeAndDeleteBranch ---

export interface BranchMergeState {
  exists: boolean;
  /** What `git branch -d` would decide: merged into the upstream when one exists, else into HEAD. */
  merged: boolean;
  /** Commits on the branch not in the reference; null if it could not be computed. */
  unmergedCommits: number | null;
  reference: "upstream" | "HEAD";
}

/** FR-615/FR-605: the same decision `git branch -d` makes, readable without deleting anything. */
export async function getBranchMergeState(repoPath: string, branch: string): Promise<BranchMergeState> {
  const none: BranchMergeState = { exists: false, merged: false, unmergedCommits: null, reference: "HEAD" };
  if (!(await isValidBranchName(repoPath, branch)) || !(await refExists(repoPath, `refs/heads/${branch}`))) return none;
  const up = await wtRunAllowing(["rev-parse", "--symbolic-full-name", `refs/heads/${branch}@{upstream}`], repoPath, [0, 128]);
  const upstream = up.exitCode === 0 && up.stdout.trim().startsWith("refs/") ? up.stdout.trim() : null;
  const reference = upstream ? "upstream" : "HEAD";
  const counted = await wtRunAllowing(["rev-list", "--count", `refs/heads/${branch}`, "--not", upstream ?? "HEAD"], repoPath, [0, 128]);
  const n = counted.exitCode === 0 ? Number(counted.stdout.trim()) : NaN;
  return { exists: true, merged: n === 0, unmergedCommits: Number.isFinite(n) ? n : null, reference };
}

export type BranchOutcome =
  | { status: "none" }
  | { status: "deleted"; name: string }
  | { status: "kept"; name: string; why: "unmerged" | "checkedOutElsewhere" | "missing" | "failed"; unmergedCommits: number | null };

export type RemoveWorktreeAndDeleteBranchResult =
  | { ok: true; removed: RemoveWorktreeResult & { ok: true }; branch: BranchOutcome; /** The merged/unmerged outcome differs from `expectedMerged`. */ outcomeDiffersFromPreview: boolean }
  | Extract<RemoveWorktreeResult, { ok: false }>;

export interface RemoveAndDeleteBranchOptions extends RemoveWorktreeOptions {
  /** What the dialog showed when it opened; a different outcome is flagged. */
  expectedMerged?: boolean;
}

export function removeWorktreeAndDeleteBranch(
  repoPath: string,
  id: string,
  options: RemoveAndDeleteBranchOptions,
): Promise<RemoveWorktreeAndDeleteBranchResult> {
  return runInMutationQueue(async () => {
    const before = (await listWorktrees(repoPath)).entries.find((e) => e.id === id);
    const removed = await removeCore(repoPath, id, options);
    // `git branch -d` is never reached when the removal did not happen.
    if (!removed.ok) return removed;
    const name = before?.branch ?? removed.branch;
    if (name === null) return { ok: true, removed, branch: { status: "none" }, outcomeDiffersFromPreview: false };

    let outcome: BranchOutcome;
    const state = await getBranchMergeState(repoPath, name);
    if (!state.exists) {
      outcome = { status: "kept", name, why: "missing", unmergedCommits: null };
    } else {
      const elsewhere = (await listWorktrees(repoPath)).entries.some((e) => e.branch === name);
      if (elsewhere) {
        outcome = { status: "kept", name, why: "checkedOutElsewhere", unmergedCommits: null };
      } else {
        try {
          await wtRun(["branch", "-d", ...withEndOfOptions([name])], repoPath);
          outcome = { status: "deleted", name };
        } catch (err) {
          if (!(err instanceof GitCommandError)) throw err;
          const unmerged = /not fully merged/i.test(err.stderr);
          outcome = { status: "kept", name, why: unmerged ? "unmerged" : "failed", unmergedCommits: unmerged ? state.unmergedCommits : null };
        }
      }
    }
    const merged = outcome.status === "deleted";
    return {
      ok: true,
      removed,
      branch: outcome,
      outcomeDiffersFromPreview: options.expectedMerged !== undefined && options.expectedMerged !== merged,
    };
  });
}
