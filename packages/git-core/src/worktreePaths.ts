// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { constants as fsConstants } from "node:fs";
import { isErrnoException } from "./pathSafety";
import { listWorktrees, type WorktreeEntry, type WorktreeList } from "./worktreeList";
import { WINDOWS_MAX_PATH, classifyPathString, isReservedDeviceName } from "./worktreeParse";
import { GitCommandError } from "./errors";
import { wtRun } from "./worktreeRunner";

/**
 * Path rules for worktrees (specs/worktrees.md FR-639 destination validation, FR-640 metadata trust). Everything under a
 * `.git/worktrees/<id>/gitdir` is repo-controlled, so string checks run before any filesystem touch.
 */

// --- shared helpers ---

const CASE_INSENSITIVE = (): boolean => process.platform === "win32" || process.platform === "darwin";
const foldCase = (p: string): string => (CASE_INSENSITIVE() ? p.toLowerCase() : p);

export type PathRelation = "same" | "inside" | "outside";

/** How `child` relates to `parent`, by already-resolved paths, case-folded where the filesystem is. */
export function relatePaths(parent: string, child: string): PathRelation {
  const r = path.relative(foldCase(path.resolve(parent)), foldCase(path.resolve(child)));
  if (r === "") return "same";
  if (r === ".." || r.startsWith(`..${path.sep}`) || path.isAbsolute(r)) return "outside";
  return "inside";
}

/** realpath of the nearest existing ancestor joined with the not-yet-existing tail; never throws for a missing leaf. */
export async function realpathBestEffort(p: string): Promise<string> {
  let cur = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = await fs.realpath(cur);
      return tail.length ? path.join(real, ...tail) : real;
    } catch (err) {
      const parent = path.dirname(cur);
      if (!isErrnoException(err) || parent === cur) return path.resolve(p);
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

// --- FR-639 ---

export type DestinationRefusalReason =
  | "invalidPath"
  | "notAbsolute"
  | "unc"
  | "driveRoot"
  | "homeDirectory"
  | "invalidLeafName"
  | "tooLong"
  | "symlinkLeaf"
  | "unstablePath"
  | "inaccessible"
  | "insideRepo"
  | "insideGitDir"
  | "insideWorktree"
  | "ancestorOfRepo"
  | "ancestorOfWorktree"
  | "alreadyWorktree"
  | "notADirectory"
  | "notEmpty"
  | "parentNotWritable";

const DESTINATION_MESSAGES: Record<DestinationRefusalReason, string> = {
  invalidPath: "That folder path is not valid.",
  notAbsolute: "The folder must be an absolute path.",
  unc: "Network (UNC) paths are not supported.",
  driveRoot: "A drive root cannot be used.",
  homeDirectory: "Your home folder cannot be used.",
  invalidLeafName: "The folder name is not valid on every platform.",
  tooLong: "That path is longer than Windows allows.",
  symlinkLeaf: "The folder is a link (symlink or junction).",
  unstablePath: "The folder's location changed while it was being checked.",
  inaccessible: "The folder cannot be read.",
  insideRepo: "The folder is inside the repository.",
  insideGitDir: "The folder is inside the repository's git directory.",
  insideWorktree: "The folder is inside another worktree.",
  ancestorOfRepo: "The folder contains the repository.",
  ancestorOfWorktree: "The folder contains another worktree.",
  alreadyWorktree: "A worktree already exists in that folder.",
  notADirectory: "That path exists and is not a folder.",
  notEmpty: "The folder is not empty.",
  parentNotWritable: "The parent folder is not writable.",
};

export type DestinationCheck =
  | { ok: true; /** Absolute, normalised path to hand to git. */ path: string; /** Same path with existing ancestors resolved. */ realPath: string }
  | { ok: false; reason: DestinationRefusalReason; message: string; /** alreadyWorktree: the branch checked out there. */ branch?: string | null; /** alreadyWorktree / inside*: the registered worktree concerned. */ worktreePath?: string };

const refuse = (reason: DestinationRefusalReason, extra: { branch?: string | null; worktreePath?: string } = {}): DestinationCheck => ({
  ok: false,
  reason,
  message: DESTINATION_MESSAGES[reason],
  ...extra,
});

export interface ValidateDestinationOptions {
  /** Injectable so the Windows string rules are testable on any OS; filesystem steps always use the real platform. */
  platform?: string;
  /** Reuse a listing the caller already took (add does) to avoid a second `git worktree list`. */
  list?: WorktreeList;
}

/** FR-639: all destination refusals, in git-core so the dialog cannot skip them. Read-only: creates and touches nothing. */
export async function validateWorktreeDestination(
  repoPath: string,
  destination: string,
  options: ValidateDestinationOptions = {},
): Promise<DestinationCheck> {
  const platform = options.platform ?? process.platform;
  const problem = classifyPathString(destination, platform);
  if (problem === "unc") return refuse("unc");
  if (problem === "notAbsolute") return refuse("notAbsolute");
  if (problem === "reservedName") return refuse("invalidLeafName");
  if (problem) return refuse("invalidPath");

  const resolved = path.resolve(destination);
  if (path.parse(resolved).root === resolved) return refuse("driveRoot");
  const leaf = path.basename(resolved);
  if (/[<>:"|?*\\]/.test(leaf) || /[. ]$/.test(leaf) || leaf === ".git" || leaf.length > 255 || isReservedDeviceName(leaf)) {
    return refuse("invalidLeafName");
  }

  // Nearest existing ancestor, lstat so a leaf symlink/junction is seen as itself.
  let existing = resolved;
  const missingTail: string[] = [];
  let leafStat: Awaited<ReturnType<typeof fs.lstat>> | null = null;
  for (;;) {
    try {
      const st = await fs.lstat(existing);
      if (existing === resolved) leafStat = st;
      else if (!st.isDirectory() && !st.isSymbolicLink()) return refuse("notADirectory");
      break;
    } catch (err) {
      const code = isErrnoException(err) ? err.code : "";
      if (code === "ENOTDIR") return refuse("notADirectory");
      if (code !== "ENOENT") return refuse("inaccessible");
      const parent = path.dirname(existing);
      if (parent === existing) return refuse("inaccessible");
      missingTail.unshift(path.basename(existing));
      existing = parent;
    }
  }
  if (leafStat?.isSymbolicLink()) return refuse("symlinkLeaf");
  if (leafStat && !leafStat.isDirectory()) return refuse("notADirectory");

  let realExisting: string;
  try {
    realExisting = await fs.realpath(existing);
  } catch {
    return refuse("inaccessible");
  }
  const real = missingTail.length ? path.join(realExisting, ...missingTail) : realExisting;
  if (process.platform === "win32" && real.length > WINDOWS_MAX_PATH) return refuse("tooLong");

  const home = await fs.realpath(os.homedir()).catch(() => null);
  if (home !== null && relatePaths(home, real) === "same") return refuse("homeDirectory");

  const list = options.list ?? (await listWorktrees(repoPath));
  const commonReal = await realpathBestEffort(list.commonDir);
  const mainReal = await realpathBestEffort(list.mainPath);
  const main = list.entries[0]!;
  if (!main.isBare) {
    const rel = relatePaths(mainReal, real);
    if (rel !== "outside") return refuse("insideRepo", { worktreePath: list.mainPath });
  }
  const rg = relatePaths(commonReal, real);
  if (rg !== "outside") return refuse(main.isBare ? "insideRepo" : "insideGitDir", { worktreePath: list.mainPath });

  const linkedReals: { entry: WorktreeEntry; real: string }[] = [];
  for (const entry of list.entries) {
    if (entry.isMain || !entry.supported) continue;
    linkedReals.push({ entry, real: await realpathBestEffort(entry.path) });
  }
  for (const { entry, real: wtReal } of linkedReals) {
    const rel = relatePaths(wtReal, real);
    if (rel === "same") return refuse("alreadyWorktree", { branch: entry.branch, worktreePath: entry.path });
    if (rel === "inside") return refuse("insideWorktree", { worktreePath: entry.path });
  }
  if (relatePaths(real, mainReal) === "inside" || relatePaths(real, commonReal) === "inside") return refuse("ancestorOfRepo");
  for (const { entry, real: wtReal } of linkedReals) {
    if (relatePaths(real, wtReal) === "inside") return refuse("ancestorOfWorktree", { worktreePath: entry.path });
  }

  if (leafStat) {
    try {
      if ((await fs.readdir(resolved)).length > 0) return refuse("notEmpty");
    } catch {
      return refuse("inaccessible");
    }
  }
  if (process.platform !== "win32") {
    try {
      await fs.access(existing, fsConstants.W_OK);
    } catch {
      return refuse("parentNotWritable");
    }
  }

  // Unstable chain: the same ancestor must resolve to the same place after all the checks above.
  try {
    if ((await fs.realpath(existing)) !== realExisting) return refuse("unstablePath");
  } catch {
    return refuse("unstablePath");
  }
  return { ok: true, path: resolved, realPath: real };
}

// --- FR-640 ---

export type WorktreeDistrustReason =
  | "not-registered"
  | "main"
  | "unsupported"
  | "untrusted-list"
  | "invalid-path"
  | "unc"
  | "reserved-name"
  | "missing"
  | "not-a-gitfile"
  | "bad-gitfile"
  | "backlink-mismatch"
  | "inside-main-worktree"
  | "git-mismatch";

export type WorktreeVerification =
  | { trusted: true; id: string; path: string; realPath: string }
  | { trusted: false; reason: WorktreeDistrustReason };

const GITFILE_READ_CAP = 4096;
const distrust = (reason: WorktreeDistrustReason): WorktreeVerification => ({ trusted: false, reason });

export interface WorktreeMetadataInput {
  commonDir: string;
  mainPath: string;
  mainIsBare: boolean;
  id: string;
  worktreePath: string;
  platform?: string;
}

/**
 * FR-640 steps 1-4 in the stated order, then `rev-parse` as the second check only: string rejection with no
 * filesystem touch, `lstat` of `<path>/.git`, capped read, realpath back-link to `<common-dir>/worktrees/<id>`.
 */
export async function verifyWorktreeMetadata(input: WorktreeMetadataInput): Promise<WorktreeVerification> {
  const problem = classifyPathString(input.worktreePath, input.platform);
  if (problem === "unc") return distrust("unc");
  if (problem === "reservedName") return distrust("reserved-name");
  if (problem) return distrust("invalid-path");
  // eslint-disable-next-line no-control-regex
  if (input.id === "" || input.id === "." || input.id === ".." || /[\\/\u0000-\u001f]/.test(input.id)) return distrust("invalid-path");

  const gitFile = path.join(input.worktreePath, ".git");
  let st: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    st = await fs.lstat(gitFile);
  } catch (err) {
    return distrust(isErrnoException(err) && (err.code === "ENOENT" || err.code === "ENOTDIR") ? "missing" : "not-a-gitfile");
  }
  if (!st.isFile()) return distrust("not-a-gitfile");

  let text: string;
  try {
    const handle = await fs.open(gitFile, "r");
    try {
      const buf = Buffer.alloc(GITFILE_READ_CAP + 1);
      const { bytesRead } = await handle.read(buf, 0, GITFILE_READ_CAP + 1, 0);
      if (bytesRead > GITFILE_READ_CAP) return distrust("bad-gitfile");
      text = new TextDecoder().decode(buf.subarray(0, bytesRead));
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch {
    return distrust("bad-gitfile");
  }
  const m = /^gitdir: ([^\r\n]+)(?:\r?\n)?$/.exec(text);
  if (!m) return distrust("bad-gitfile");

  const adminDir = path.join(input.commonDir, "worktrees", input.id);
  let pointedAt: string;
  let expected: string;
  try {
    pointedAt = await fs.realpath(path.resolve(input.worktreePath, m[1]!));
    expected = await fs.realpath(adminDir);
  } catch {
    return distrust("backlink-mismatch");
  }
  if (relatePaths(expected, pointedAt) !== "same") return distrust("backlink-mismatch");

  let realPath: string;
  try {
    realPath = await fs.realpath(input.worktreePath);
  } catch {
    return distrust("missing");
  }
  // A zip-planted nested "worktree" would pass the back-link check; it must not open as a trusted tab.
  const mainReal = await realpathBestEffort(input.mainPath);
  const commonReal = await realpathBestEffort(input.commonDir);
  if ((!input.mainIsBare && relatePaths(mainReal, realPath) !== "outside") || relatePaths(commonReal, realPath) !== "outside") {
    return distrust("inside-main-worktree");
  }

  try {
    const { stdout } = await wtRun(["rev-parse", "--git-common-dir"], realPath);
    const reported = await fs.realpath(path.resolve(realPath, stdout.trim()));
    if (relatePaths(commonReal, reported) !== "same") return distrust("git-mismatch");
  } catch (err) {
    // Cancellation and timeouts keep their own types; any git refusal (dubious ownership included) means "not trusted".
    if (err instanceof GitCommandError || isErrnoException(err)) return distrust("git-mismatch");
    throw err;
  }
  return { trusted: true, id: input.id, path: input.worktreePath, realPath };
}

/** FR-640 for a registered entry: lists, applies the trust gates of FR-601, then {@link verifyWorktreeMetadata}. */
export async function verifyRegisteredWorktree(
  repoPath: string,
  id: string,
  options: { list?: WorktreeList } = {},
): Promise<WorktreeVerification> {
  const list = options.list ?? (await listWorktrees(repoPath));
  const entry = list.entries.find((e) => e.id !== null && e.id === id);
  if (!entry) return distrust("not-registered");
  if (list.untrusted) return distrust("untrusted-list");
  if (!entry.supported) return distrust("unsupported");
  return verifyWorktreeMetadata({
    commonDir: list.commonDir,
    mainPath: list.mainPath,
    mainIsBare: list.entries[0]!.isBare,
    id,
    worktreePath: entry.path,
  });
}
