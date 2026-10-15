// SPDX-License-Identifier: GPL-3.0-or-later
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { GitCommandError, GitCommandTimeoutError } from "./errors";
import { getEmptyHooksDir } from "./emptyHooksDir";
import { runInMutationQueue, withEndOfOptions } from "./gitProcess";
import { listWorktrees, type WorktreeEntry, type WorktreeList } from "./worktreeList";
import { detectPostCheckoutHook, prepareConsentedHooksDir, releaseConsentDir } from "./worktreeHook";
import { classifyPathString, relatePaths, visibleUntrustedText } from "./worktreeParse";
import {
  realpathBestEffort,
  realpathOfMetadataPath,
  validateWorktreeDestination,
  verifyWorktreeMetadata,
  type DestinationRefusalReason,
  type WorktreeDistrustReason,
} from "./worktreePaths";
import { CONFIG_HOOKS_MIN_VERSION, gitVersionAtLeast } from "./gitVersion";
import { getWorktreeGitVersion, toWorktreeError, wrapGit, wtRun, wtRunAllowing } from "./worktreeRunner";

/**
 * specs/worktrees.md FR-602..605, FR-638, FR-641. Expected refusals come back as `{ ok: false, reason }` results with NO
 * side effects; only unexpected git failures throw, as the redacted `WorktreeOperationError` (every public entry point is
 * wrapped, so a raw `GitCommandError` with argv/stderr never escapes). Every mutation is one entry in the global mutation
 * queue, so inner git calls below omit `mutatesRepository`.
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

/** `-c core.hooksPath=<private empty dir>` for git calls that fire ref-transaction hooks (update-ref, branch -d). */
async function noHooks(): Promise<string[]> {
  return ["-c", `core.hooksPath=${await getEmptyHooksDir()}`];
}

/** Keys of `branch.<name>.*` in the effective config (exact subsection match). */
async function branchConfigKeys(cwd: string, name: string): Promise<string[]> {
  const r = await wtRunAllowing(["config", "--get-regexp", "^branch\\."], cwd, [0, 1]);
  const prefix = `branch.${name}.`;
  return r.stdout
    .split("\n")
    .map((l) => l.split(/\s/, 1)[0]!)
    .filter((k) => k.startsWith(prefix));
}

const sameFolder = (a: string, b: string): boolean => relatePaths(a, b) === "same";

// --- FR-602 addWorktree ---

export type AddWorktreeSource =
  | { kind: "branch"; branch: string }
  | { kind: "newBranch"; branch: string; startPoint: string }
  | { kind: "detached"; commit: string }
  | { kind: "remoteBranch"; remote: string; branch: string };

export interface AddWorktreeOptions {
  /**
   * FR-644: the user chose "Run hook". Default false: no hook can run. Requires `expectedHookFingerprint` (what the user
   * was shown); git then runs a private COPY of the consented post-checkout hook only, so no sibling hook runs with it.
   * `core.fsmonitor` is neutralised either way.
   */
  runPostCheckoutHook?: boolean;
  /** `PostCheckoutHookInfo.fingerprint` the consent was given for; re-checked right before git is spawned. */
  expectedHookFingerprint?: string;
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
  | "dubiousOwnership"
  | "hookFingerprintRequired"
  | "hookChanged"
  | "hooksPathRelative"
  | "listUntrusted"
  | "configHooks";

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
  return wrapGit("add", () => runInMutationQueue(() => addWorktreeCore(repoPath, destination, source, options)));
}

async function addWorktreeCore(
  repoPath: string,
  destination: string,
  source: AddWorktreeSource,
  options: AddWorktreeOptions,
): Promise<AddWorktreeResult> {
  const list = await listWorktrees(repoPath);
  // `git worktree add` realpaths every registered worktree path; with a planted network path that would be probed.
  if (list.untrustedReason === "network-path") return refusal("listUntrusted", "A registered worktree points at a network path; fix or remove it first.");
  const cwd = list.mainPath;

  // Config-based hooks run regardless of core.hooksPath, so neither the empty dir nor the consent copy contains them.
  const version = await getWorktreeGitVersion(cwd);
  if (version === null || gitVersionAtLeast(version, CONFIG_HOOKS_MIN_VERSION)) {
    const hooks = await wtRunAllowing(["config", "--get-regexp", "^hook\\."], cwd, [0, 1]);
    if (hooks.stdout.trim() !== "") return refusal("configHooks", "This repository configures hooks in git config, which cannot be disabled for a new worktree.");
  }

  let flags: string[] = [];
  let commitish: string;
  let newBranchName: string | null = null;
  let createdFrom: string | null = null;
  let expectBranch: string | null = null;
  let trackConfigWasEmpty = false;

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
      // Only a config section this call created may be removed again on rollback.
      trackConfigWasEmpty = (await branchConfigKeys(cwd, source.branch)).length === 0;
      break;
    }
  }

  const dest = await validateWorktreeDestination(repoPath, destination, { list });
  if (!dest.ok) {
    return refusal("destination", dest.message, { destinationReason: dest.reason, worktreePath: dest.worktreePath, branch: dest.branch });
  }

  // FR-644 consent: re-read the hook right before the spawn and compare with what the user was shown.
  let hooksDir: string;
  let consentDir: string | null = null;
  if (options.runPostCheckoutHook) {
    if (!options.expectedHookFingerprint) return refusal("hookFingerprintRequired", "Running the hook needs the fingerprint that was shown to the user.");
    const info = await detectPostCheckoutHook(repoPath);
    if (info.present && info.hooksPathRelative) return refusal("hooksPathRelative", "A relative core.hooksPath resolves inside the new worktree and cannot be consented to.");
    if (!info.present || info.fingerprint !== options.expectedHookFingerprint) return refusal("hookChanged", "The hook changed since it was shown. Review it again.");
    const copy = await prepareConsentedHooksDir(info);
    if (!copy) return refusal("hookChanged", "The hook changed since it was shown. Review it again.");
    consentDir = copy.dir;
    hooksDir = copy.dir;
  } else {
    hooksDir = await getEmptyHooksDir();
  }

  const beforeIds = new Set(list.entries.map((e) => e.id));
  const createdDirs = await missingDirsFor(dest.path);
  const isThisFolder = (e: WorktreeEntry): boolean => sameFolder(e.path, dest.path) || sameFolder(e.path, dest.realPath);

  try {
    // git gets the realpath-resolved destination that was validated, so a link swapped in later cannot redirect it.
    await wtRun(["-c", `core.hooksPath=${hooksDir}`, "worktree", "add", ...flags, "--", dest.realPath, commitish], cwd, { timeoutMs: ADD_TIMEOUT_MS });
  } catch (err) {
    // A timeout (a consented hook hanging is the likely cause) gets the same "did the worktree appear?" check and is never rolled back
    // when it did: the checkout may be complete and only the hook is stuck.
    const timedOut = err instanceof GitCommandTimeoutError;
    if (!(err instanceof GitCommandError) && !timedOut) throw err;
    const stderr = err instanceof GitCommandError ? err.stderr : "";
    const after = await listWorktrees(repoPath).catch(() => null);
    const created = after?.entries.find((e) => !e.isMain && !beforeIds.has(e.id) && e.supported && isThisFolder(e)) ?? null;
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
    await rollbackAdd(cwd, {
      branch: newBranchName,
      startSha: createdFrom,
      removeTrackConfig: source.kind === "remoteBranch" && trackConfigWasEmpty,
      createdDirs,
      after,
      alreadyExists: /a branch named .* already exists/i.test(stderr),
    });
    if (/dubious ownership|safe\.directory/i.test(stderr)) {
      return refusal("dubiousOwnership", "Git refused to work in this repository because of its ownership.");
    }
    const owner = /(?:is already (?:checked out|used by worktree) at|already checked out at) '([^']+)'/.exec(stderr);
    if (owner && expectBranch) {
      // The path comes from git's stderr: only a path the listing knows is returned. (Ownership itself rests on each admin
      // dir's HEAD, which a forged admin dir can lie about; this only decides what is shown.)
      const known = list.entries.find((e) => e.supported && sameFolder(e.path, owner[1]!));
      return refusal("branchCheckedOut", "That branch is already checked out in another worktree.", { worktreePath: known?.path, branch: expectBranch });
    }
    throw toWorktreeError("add", err);
  } finally {
    if (consentDir) await releaseConsentDir(consentDir);
  }

  const after = await listWorktrees(repoPath).catch(() => null);
  const entry = after?.entries.find((e) => !e.isMain && e.supported && isThisFolder(e)) ?? null;
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

interface RollbackPlan {
  branch: string | null;
  startSha: string | null;
  removeTrackConfig: boolean;
  createdDirs: readonly string[];
  /** The listing after the failure; null when it could not be read (then nothing is deleted). */
  after: WorktreeList | null;
  /** git failed because the branch already existed: this call did not create it. */
  alreadyExists: boolean;
}

/** Removes only what this call made: the branch (compare-and-delete at the start commit) and empty folders it would have created. */
async function rollbackAdd(cwd: string, plan: RollbackPlan): Promise<void> {
  const { branch, startSha, after } = plan;
  if (branch && startSha && after !== null && !plan.alreadyExists && !after.entries.some((e) => e.branch === branch)) {
    const ref = `refs/heads/${branch}`;
    const deleted = await wtRunAllowing([...(await noHooks()), "update-ref", "-d", ref, startSha], cwd, [0, 1, 128]).catch(() => null);
    if (deleted && deleted.exitCode === 0 && plan.removeTrackConfig) {
      await wtRunAllowing(["config", "--remove-section", `branch.${branch}`], cwd, [0, 1, 128]).catch(() => undefined);
    }
  }
  for (const dir of plan.createdDirs) await fs.rmdir(dir).catch(() => undefined);
}

// --- FR-603 / FR-641 removeWorktree ---

export interface RemoveWorktreeOptions {
  /** The path the user confirmed; re-checked against a fresh listing (FR-641). */
  confirmedPath: string;
  /** Honoured only for `dirty` and `hasSubmodules` and only together with the expectation below; never for locked or main. */
  force?: boolean;
  /** The dirty count the user confirmed. Required when `force` is needed; a different fresh count refuses (`dirty`) and force is NOT honoured. */
  expectedCount?: number;
  /** The populated submodules the user was shown (default none). A different fresh list refuses (`hasSubmodules`). */
  expectedSubmodules?: readonly string[];
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
  | { reason: "walkFailed" }
  | { reason: "notAWorktree"; distrust: WorktreeDistrustReason }
  | { reason: "missing" }
  | { reason: "notFound" }
  | { reason: "pathChanged" }
  | { reason: "expectationRequired" };

export type RemoveWorktreeResult =
  | { ok: true; id: string; path: string; branch: string | null; linksUnlinked: number }
  | ({ ok: false; message: string; /** Links already unlinked (Windows) before git refused: the worktree is otherwise unchanged. */ linksUnlinked?: number } & RemoveWorktreeRefusal);

const REMOVE_MESSAGES: Record<RemoveWorktreeRefusal["reason"], string> = {
  dirty: "The worktree has uncommitted changes.",
  locked: "The worktree is locked.",
  hasSubmodules: "The worktree contains submodules.",
  inUse: "Close programs using this folder and try again.",
  main: "The main worktree cannot be removed.",
  unsupported: "This worktree entry cannot be trusted.",
  symlinkTarget: "The worktree folder is a link.",
  unsafeTarget: "This folder cannot be removed safely.",
  walkFailed: "The worktree folder could not be read completely, so nothing was removed.",
  notAWorktree: "Not a worktree of this repository.",
  missing: "The worktree's folder is missing.",
  notFound: "No such worktree.",
  pathChanged: "The worktree changed since it was confirmed.",
  expectationRequired: "Forcing a removal needs the dirty count the user confirmed.",
};

const denied = (r: RemoveWorktreeRefusal, linksUnlinked?: number): RemoveWorktreeResult => ({
  ok: false,
  message: REMOVE_MESSAGES[r.reason],
  ...(linksUnlinked ? { linksUnlinked } : {}),
  ...r,
});

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

interface InspectedContent extends WorktreeContentState {
  /** Tracked symlinks (mode 120000): never unlinked by the Windows pre-step (a link at a gitlink path IS unlinked, it is foreign). */
  trackedLinks: Set<string>;
}

/** A submodule path from the index must be a plain relative path before it is joined onto the worktree and statted. */
export function isPlainRelativePath(p: string): boolean {
  return p !== "" && !path.isAbsolute(p) && !/^[A-Za-z]:/.test(p) && !p.split(/[\\/]/).includes("..") && !p.includes("\0");
}

async function inspectContent(worktreePath: string): Promise<InspectedContent> {
  const [status, staged] = await Promise.all([
    wtRun(["status", "--porcelain=v1", "-z", "-uall", "--ignore-submodules=none"], worktreePath),
    wtRun(["ls-files", "--stage", "-z"], worktreePath),
  ]);
  const { count, paths } = countStatusEntries(status.stdout);
  const submodules: string[] = [];
  const trackedLinks = new Set<string>();
  for (const rec of staged.stdout.split(NUL_SPLIT)) {
    const tab = rec.indexOf("\t");
    if (tab < 0) continue;
    const mode = rec.slice(0, 7);
    const sub = rec.slice(tab + 1);
    // Only a tracked SYMLINK is git's own business; a reparse point at a gitlink path is foreign and must be unlinked.
    if (mode === "120000 ") trackedLinks.add(sub);
    if (mode !== "160000 " || !isPlainRelativePath(sub)) continue;
    // Git itself only objects to a populated submodule (one with its own `.git`).
    if (await fs.lstat(path.join(worktreePath, sub, ".git")).then(() => true, () => false)) submodules.push(sub);
  }
  const dirtySubmodules = submodules.filter((s) => paths.includes(s));
  return { count, submodules, dirtySubmodules, trackedLinks };
}

const publicState = (c: InspectedContent): WorktreeContentState => ({ count: c.count, submodules: c.submodules, dirtySubmodules: c.dirtySubmodules });

/**
 * M5: a target inside the main working tree is only a genuine nested worktree when main tracks nothing under it; a planted
 * `src/.git` back-link must not make a tracked folder removable.
 */
async function nestedTargetTracksMainFiles(list: WorktreeList, mainReal: string, targetReal: string): Promise<boolean> {
  if (list.entries[0]!.isBare || list.mainPathIsGitDir || relatePaths(mainReal, targetReal) !== "inside") return false;
  const rel = path.relative(mainReal, targetReal).split(path.sep).join("/");
  const r = await wtRun(["ls-files", "-z", "--", rel], list.mainPath);
  return r.stdout.length > 0;
}

export type WorktreeRemovalState = ({ ok: true } & WorktreeContentState) | { ok: false; reason: WorktreeDistrustReason };

/** FR-601/FR-603: the dirty count for ONE entry, on demand, only after FR-640 trusts it. */
export function getWorktreeRemovalState(repoPath: string, id: string): Promise<WorktreeRemovalState> {
  return wrapGit("inspect", () => removalStateCore(repoPath, id));
}

async function removalStateCore(repoPath: string, id: string): Promise<WorktreeRemovalState> {
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
  if (await nestedTargetTracksMainFiles(list, await realpathBestEffort(list.mainPath), v.realPath)) return { ok: false, reason: "tracked-in-main" };
  return { ok: true, ...publicState(await inspectContent(entry.path)) };
}

/** `\\?\` form: Win32 name normalisation (trailing dots/spaces, device names) can never retarget the path. */
const extendedLength = (p: string): string => (p.startsWith("\\\\?\\") ? p : `\\\\?\\${path.win32.resolve(p)}`);

/**
 * git for Windows deletes THROUGH a directory junction (verified on 2.31: an ignored junction to an outside folder lost
 * the outside files on a plain remove). Untracked/ignored symlinks and junctions are unlinked first so only the link
 * itself goes; tracked symlinks and gitlinks are left to git, and an entry that is a reparse point but not a
 * symlink/junction (cloud placeholder, other mount) is neither unlinked nor entered. POSIX git never follows links.
 */
/** The pre-unlink walk could not list a folder: nothing may be removed on a partial view. */
export class UnlinkWalkError extends Error {
  constructor() {
    super("worktree walk failed");
    this.name = "UnlinkWalkError";
  }
}

export async function unlinkReparsePoints(root: string, trackedLinks: ReadonlySet<string>): Promise<number> {
  if (process.platform !== "win32") return 0;
  let unlinked = 0;
  const fold = (x: string): string => x.toLowerCase();
  const tracked = new Set([...trackedLinks].map(fold)); // NTFS is case-insensitive: the index may spell the path differently
  const stack: { abs: string; rel: string }[] = [{ abs: path.win32.resolve(root), rel: "" }];
  while (stack.length > 0) {
    const { abs, rel } = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(extendedLength(abs), { withFileTypes: true });
    } catch {
      throw new UnlinkWalkError();
    }
    for (const entry of entries) {
      const full = path.win32.join(abs, entry.name);
      const relChild = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        if (tracked.has(fold(relChild))) continue;
        // Only a real symlink or junction answers readlink; anything else must be left for git to refuse or handle.
        if (!(await fs.readlink(extendedLength(full)).then(() => true, () => false))) continue;
        await fs.unlink(extendedLength(full)).catch(() => fs.rmdir(extendedLength(full)));
        unlinked++;
      } else if (entry.isDirectory()) {
        stack.push({ abs: full, rel: relChild });
      }
    }
  }
  return unlinked;
}

const BUSY_STDERR = /failed to delete|Directory not empty|Permission denied|Device or resource busy|being used by another process|Invalid argument/i;

/** A busy/permission failure only counts as "in use" when the path git names lies inside the target. */
export function busyInside(stderr: string, targets: readonly string[]): boolean {
  if (!BUSY_STDERR.test(stderr)) return false;
  const named = [...stderr.matchAll(/'([^'\r\n]+)'/g)].map((m) => m[1]!).filter((p) => path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p));
  return named.some((p) => targets.some((t) => relatePaths(t, p) !== "outside"));
}

/**
 * A forced removal is bound to what the user saw: with `force` and something to force, the fresh dirty count and populated
 * submodule list must equal the expectation. A difference is reported with the FRESH numbers (the UI's "changed since you
 * opened this") and force is not honoured; no expectation at all is refused.
 */
function forceGate(fresh: WorktreeContentState, options: RemoveWorktreeOptions, linksUnlinked?: number): RemoveWorktreeResult | null {
  if (options.expectedCount === undefined) return denied({ reason: "expectationRequired" }, linksUnlinked);
  const sameSubs = JSON.stringify([...fresh.submodules].sort()) === JSON.stringify([...(options.expectedSubmodules ?? [])].sort());
  if (fresh.count === options.expectedCount && sameSubs) return null;
  return fresh.count > 0 || fresh.submodules.length === 0
    ? denied({ reason: "dirty", count: fresh.count, dirtySubmodules: fresh.dirtySubmodules }, linksUnlinked)
    : denied({ reason: "hasSubmodules", submodules: fresh.submodules, dirtySubmodules: fresh.dirtySubmodules }, linksUnlinked);
}

export function removeWorktree(repoPath: string, id: string | null, options: RemoveWorktreeOptions): Promise<RemoveWorktreeResult> {
  return wrapGit("remove", () => runInMutationQueue(() => removeCore(repoPath, id, options)));
}

async function removeCore(repoPath: string, id: string | null, options: RemoveWorktreeOptions): Promise<RemoveWorktreeResult> {
  const list = await listWorktrees(repoPath);
  const mainReal = await realpathBestEffort(list.mainPath);
  const confirmedReal = await realpathOfMetadataPath(options.confirmedPath);

  if (id === null || relatePaths(mainReal, confirmedReal) === "same") return denied({ reason: "main" });
  const entry = list.entries.find((e) => e.id === id);
  if (!entry) return denied({ reason: "notFound" });
  if (entry.isMain) return denied({ reason: "main" });
  if (list.untrusted || !entry.supported) return denied({ reason: "unsupported" });
  // FR-640 step 1: a UNC/device/reserved-name path from metadata is rejected by string, before any filesystem touch.
  const suspicious = classifyPathString(entry.path);
  if (suspicious) {
    return denied({ reason: "notAWorktree", distrust: suspicious === "unc" ? "unc" : suspicious === "reservedName" ? "reserved-name" : "invalid-path" });
  }
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
    if (relatePaths(target, await realpathOfMetadataPath(other.path)) !== "outside") return denied({ reason: "unsafeTarget" });
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
  if (await nestedTargetTracksMainFiles(list, mainReal, trust.realPath)) return denied({ reason: "unsafeTarget" });

  const content = await inspectContent(entry.path);
  let needsForce = content.count > 0 || content.submodules.length > 0;
  if (needsForce && !options.force) {
    return content.count > 0
      ? denied({ reason: "dirty", count: content.count, dirtySubmodules: content.dirtySubmodules })
      : denied({ reason: "hasSubmodules", submodules: content.submodules, dirtySubmodules: content.dirtySubmodules });
  }
  if (needsForce) {
    const gate = forceGate(content, options);
    if (gate) return gate;
  }

  // Re-check right before the walk: the folder must still be a plain directory, not a link swapped in since the checks above.
  const stNow = await fs.lstat(entry.path).catch(() => null);
  if (!stNow) return denied({ reason: "missing" });
  if (stNow.isSymbolicLink() || !stNow.isDirectory()) return denied({ reason: "unsafeTarget" });

  let linksUnlinked = 0;
  try {
    linksUnlinked = await unlinkReparsePoints(entry.path, content.trackedLinks);
  } catch (err) {
    return err instanceof UnlinkWalkError ? denied({ reason: "walkFailed" }) : denied({ reason: "inUse" });
  }
  if (linksUnlinked > 0) {
    // Unlinking a foreign link changes what git sees (a gitlink folder becomes "missing"), so ask again before the remove.
    const again = await inspectContent(entry.path);
    needsForce = again.count > 0 || again.submodules.length > 0;
    if (needsForce && !options.force) {
      return again.count > 0
        ? denied({ reason: "dirty", count: again.count, dirtySubmodules: again.dirtySubmodules }, linksUnlinked)
        : denied({ reason: "hasSubmodules", submodules: again.submodules, dirtySubmodules: again.dirtySubmodules }, linksUnlinked);
    }
    if (needsForce) {
      const gate = forceGate(again, options, linksUnlinked);
      if (gate) return gate;
    }
  }

  // cwd is the main worktree, never inside the target; the single force flag below is the only one in this module.
  try {
    await wtRun(["worktree", "remove", ...(needsForce ? ["--force"] : []), "--", entry.path], list.mainPath);
  } catch (err) {
    if (!(err instanceof GitCommandError)) throw err;
    const text = err.stderr;
    if (/locked/i.test(text) && /cannot remove a locked/i.test(text)) return denied({ reason: "locked", lockReason: entry.lockReason }, linksUnlinked);
    if (/containing submodules/i.test(text)) return denied({ reason: "hasSubmodules", submodules: content.submodules, dirtySubmodules: content.dirtySubmodules }, linksUnlinked);
    if (/contains modified or untracked files/i.test(text)) {
      const again = await inspectContent(entry.path).catch(() => content);
      return denied({ reason: "dirty", count: again.count, dirtySubmodules: again.dirtySubmodules }, linksUnlinked);
    }
    if (busyInside(text, [entry.path, entryReal])) return denied({ reason: "inUse" }, linksUnlinked);
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

/**
 * Lines of `worktree prune --verbose`: "Removing worktrees/<id>: <reason>". With `knownIds` (the admin dir names) an id is
 * matched by prefix, so ids containing ": " parse correctly and anything else (forged lines, ids with line breaks) is ignored.
 */
export function parsePruneVerbose(text: string, knownIds?: readonly string[]): { id: string; reason: string }[] {
  const out: { id: string; reason: string }[] = [];
  // eslint-disable-next-line no-control-regex
  const hasControl = (s: string): boolean => /[\u0000-\u001f\u007f]/.test(s);
  const byLength = knownIds ? [...knownIds].filter((k) => !hasControl(k)).sort((a, b) => b.length - a.length) : null;
  for (const line of text.split("\n")) {
    const clean = line.replace(/\r$/, "");
    if (byLength) {
      const hit = byLength.find((k) => clean.startsWith(`Removing worktrees/${k}: `));
      if (hit) out.push({ id: hit, reason: clean.slice(`Removing worktrees/${hit}: `.length) });
      continue;
    }
    const m = /^Removing worktrees\/(.+?): (.*)$/.exec(clean);
    if (m && !hasControl(m[1]!)) out.push({ id: m[1]!, reason: m[2]! });
  }
  return out;
}

export function pruneWorktree(repoPath: string, id: string, options: PruneWorktreeOptions = {}): Promise<PruneWorktreeResult> {
  return wrapGit("prune", () => runInMutationQueue(() => pruneCore(repoPath, id, options)));
}

async function adminIds(commonDir: string): Promise<string[]> {
  return fs.readdir(path.join(commonDir, "worktrees")).catch(() => [] as string[]);
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
    id: visibleUntrustedText(e.id),
    reason: visibleUntrustedText(e.reason),
    path: list.entries.find((x) => x.id === e.id)?.path ?? null,
  });
  const before = await adminIds(list.commonDir);
  const dry = await wtRun(["worktree", "prune", "--dry-run", "--verbose"], list.mainPath);
  const planned = parsePruneVerbose(`${dry.stdout}\n${dry.stderr}`, before);
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

  const beforeReal = await adminIds(list.commonDir);
  const real = await wtRun(["worktree", "prune", "--verbose"], list.mainPath);
  const afterReal = new Set(await adminIds(list.commonDir));
  const reasons = new Map(parsePruneVerbose(`${real.stdout}\n${real.stderr}`, beforeReal).map((d) => [d.id, d.reason] as const));
  // The directory diff is authoritative: whatever disappeared was forgotten, whether or not its log line parsed.
  const removed = beforeReal.filter((x) => !afterReal.has(x));
  const plannedIds = new Set(planned.map((p) => p.id));
  const row = (x: string): { id: string; reason: string } => ({ id: x, reason: reasons.get(x) ?? "" });
  return {
    ok: true,
    id,
    forgotten: removed.map((x) => describe(row(x))),
    alsoForgot: removed.filter((x) => !plannedIds.has(x)).map((x) => describe(row(x))),
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
export function getBranchMergeState(repoPath: string, branch: string): Promise<BranchMergeState> {
  return wrapGit("inspect", () => branchMergeStateCore(repoPath, branch));
}

async function branchMergeStateCore(repoPath: string, branch: string): Promise<BranchMergeState> {
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
  return wrapGit("remove", () =>
    runInMutationQueue(async () => {
      const before = (await listWorktrees(repoPath)).entries.find((e) => e.id === id);
      const removed = await removeCore(repoPath, id, options);
      // `git branch -d` is never reached when the removal did not happen.
      if (!removed.ok) return removed;
      const name = before?.branch ?? removed.branch;
      if (name === null) return { ok: true as const, removed, branch: { status: "none" as const }, outcomeDiffersFromPreview: false };

      let outcome: BranchOutcome;
      const state = await branchMergeStateCore(repoPath, name);
      if (!state.exists) {
        outcome = { status: "kept", name, why: "missing", unmergedCommits: null };
      } else {
        const elsewhere = (await listWorktrees(repoPath)).entries.some((e) => e.branch === name);
        if (elsewhere) {
          outcome = { status: "kept", name, why: "checkedOutElsewhere", unmergedCommits: null };
        } else {
          try {
            // Hooks off: a reference-transaction hook fires on the ref deletion.
            await wtRun([...(await noHooks()), "branch", "-d", ...withEndOfOptions([name])], repoPath);
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
        ok: true as const,
        removed,
        branch: outcome,
        outcomeDiffersFromPreview: options.expectedMerged !== undefined && options.expectedMerged !== merged,
      };
    }),
  );
}
