// SPDX-License-Identifier: GPL-3.0-or-later
import * as path from "node:path";

/**
 * Pure worktree helpers (specs/worktrees.md FR-601, FR-609, FR-639, FR-640). No I/O and no Node
 * globals at load time (`rendererSafeLoad`); `path` is a module import, not a global.
 */

// --- the lenient parser branches.ts has always used (FR-33/FR-42 behaviour must not change) ---

export interface LooseWorktreeEntry {
  path: string;
  branchFullName: string | null;
  isBare: boolean;
}

/** Parse `git worktree list --porcelain` output into structured entries. Lenient on purpose; the strict parser below is for trust decisions. */
export function parseWorktreeListPorcelain(stdout: string): LooseWorktreeEntry[] {
  const entries: LooseWorktreeEntry[] = [];
  let current: Partial<LooseWorktreeEntry> | null = null;

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
      // "HEAD <sha>", "locked [reason]", "prunable [reason]" are not needed here.
    }
  }
  flush();
  return entries;
}

// --- strict parser (FR-601): any deviation from git's exact grammar means "do not trust this output" ---

export interface PorcelainBlock {
  path: string;
  /** Null when git printed no HEAD line (bare) or the all-zero id (unborn). */
  head: string | null;
  branchFullName: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  lockReason: string | null;
  prunable: boolean;
  prunableReason: string | null;
}

/** Newline format: blocks end with a blank line, so the text must end with "\n". Null when the shape is wrong. */
export function splitPorcelainNewline(stdout: string): string[][] | null {
  if (stdout === "") return [];
  const lines = stdout.split("\n");
  if (lines.pop() !== "") return null;
  return groupFields(lines);
}

/** `-z` format (git >= 2.36): NUL after every field, an extra NUL after every block. */
export function splitPorcelainNul(stdout: string): string[][] | null {
  if (stdout === "") return [];
  const fields = stdout.split("\0");
  if (fields.pop() !== "") return null;
  return groupFields(fields);
}

function groupFields(fields: readonly string[]): string[][] | null {
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const f of fields) {
    if (f === "") {
      if (current.length === 0) return null;
      blocks.push(current);
      current = [];
    } else {
      current.push(f);
    }
  }
  return current.length === 0 ? blocks : null;
}

const HEX_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Order is `worktree`, then either `bare` alone (real git prints no HEAD for a bare entry) or `HEAD`
 * and optionally one of `branch`/`detached`, then optional `locked`, then optional `prunable`; no key twice.
 */
export function parseStrictPorcelainBlocks(blocks: readonly (readonly string[])[]): PorcelainBlock[] | null {
  const out: PorcelainBlock[] = [];
  for (const fields of blocks) {
    let i = 0;
    const first = fields[i++];
    if (first === undefined || !first.startsWith("worktree ") || first.length === "worktree ".length) return null;
    const block: PorcelainBlock = {
      path: first.slice("worktree ".length),
      head: null,
      branchFullName: null,
      detached: false,
      bare: false,
      locked: false,
      lockReason: null,
      prunable: false,
      prunableReason: null,
    };
    if (fields[i] === "bare") {
      block.bare = true;
      i++;
    } else {
      const headLine = fields[i++];
      if (headLine === undefined || !headLine.startsWith("HEAD ")) return null;
      const id = headLine.slice("HEAD ".length);
      if (!HEX_ID.test(id)) return null;
      block.head = /^0+$/.test(id) ? null : id;
      const next = fields[i];
      if (next === "detached") {
        block.detached = true;
        i++;
      } else if (next !== undefined && next.startsWith("branch ") && next.length > "branch ".length) {
        block.branchFullName = next.slice("branch ".length);
        i++;
      } else if (next === "bare") {
        block.bare = true;
        i++;
      }
    }
    const lock = fields[i];
    if (lock !== undefined && (lock === "locked" || lock.startsWith("locked "))) {
      block.locked = true;
      block.lockReason = lock.length > "locked ".length ? lock.slice("locked ".length) : null;
      i++;
    }
    const prune = fields[i];
    if (prune !== undefined && (prune === "prunable" || prune.startsWith("prunable "))) {
      block.prunable = true;
      block.prunableReason = prune.length > "prunable ".length ? prune.slice("prunable ".length) : null;
      i++;
    }
    if (i !== fields.length) return null;
    out.push(block);
  }
  return out;
}

// --- admin-directory `gitdir` file analysis (FR-601) ---

export interface GitdirAnalysis {
  /** False when the path cannot be represented or trusted: interior CR/LF/NUL, trailing blanks git would trim, not absolute, or no `/.git` suffix. */
  supported: boolean;
  /** Worktree folder as the file states it (without the `/.git` leaf). Only meaningful when `supported`. */
  worktreePath: string;
  /**
   * The path string `git worktree list` prints for this admin dir: git trims all trailing whitespace and strips
   * `/.git`. Without that suffix some gits print the trimmed text as is and newer ones print the main worktree's
   * path, so a `suffixMissing` entry may also match the main path.
   */
  gitPrintsPath: string;
  suffixMissing: boolean;
  /** CR, LF or NUL inside the path: the signature of a forged entry, so its text must never be shown or parsed. */
  hasInteriorBreak: boolean;
}

const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\/|\\\\)/;

export function analyzeGitdirFile(content: string): GitdirAnalysis {
  const terminatorless = content.endsWith("\r\n") ? content.slice(0, -2) : content.endsWith("\n") ? content.slice(0, -1) : content;
  const trimmedLikeGit = content.replace(/\s+$/, "");
  const hasSuffix = trimmedLikeGit.endsWith("/.git");
  const gitPrintsPath = hasSuffix ? trimmedLikeGit.slice(0, -"/.git".length) : trimmedLikeGit;
  const interiorBreak = /[\r\n\0]/.test(terminatorless);
  const supported =
    !interiorBreak && terminatorless === trimmedLikeGit && hasSuffix && terminatorless.length > "/.git".length && ABSOLUTE_PATH.test(terminatorless);
  return { supported, worktreePath: hasSuffix ? gitPrintsPath : "", gitPrintsPath, suffixMissing: !hasSuffix, hasInteriorBreak: interiorBreak };
}

/** Control characters become U+FFFD so an untrusted name can never carry line breaks into logs or a UI. */
export function visibleUntrustedText(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "\uFFFD");
}

export function shortSha(sha: string | null): string | null {
  return sha ? sha.slice(0, 7) : null;
}

// --- folder-name hygiene and the default location (FR-609, FR-639) ---

const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** True for CON, NUL, COM1.. and also with an extension ("nul.txt") or trailing blanks, which Windows treats the same way. */
export function isReservedDeviceName(name: string): boolean {
  const base = name.split(".")[0]!.replace(/[ ]+$/, "");
  return WINDOWS_RESERVED_BASENAME.test(base);
}

/** FR-639 hygiene, applied on every platform: forbidden characters become `-`, trailing dots/spaces go, reserved names get `_`, empty becomes `worktree`. */
export function sanitizeFolderName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  let name = raw.replace(/[<>:"|?*\\/\u0000-\u001f]/g, "-").replace(/[. ]+$/, "");
  if (name === "") name = "worktree";
  if (isReservedDeviceName(name)) name = `_${name}`;
  return name;
}

function pathApiFor(p: string): typeof path.posix {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\") ? path.win32 : path.posix;
}

export interface DefaultWorktreePathInput {
  /** The MAIN worktree (or the bare repo folder), never a linked worktree the user happens to be looking at. */
  mainWorktreePath: string;
  branchName: string;
  /** Folder names already present in `<name>.worktrees`; a clash gets `-2`, `-3`, ... (case-insensitive). */
  existingNames?: Iterable<string>;
}

/** FR-609: `<main-repo-parent>/<main-repo-name>.worktrees/<branch-slug>`. Pure; path style follows the input. */
export function defaultWorktreePath(input: DefaultWorktreePathInput): string {
  const api = pathApiFor(input.mainWorktreePath);
  const main = api.resolve(input.mainWorktreePath);
  let repoName = api.basename(main).replace(/\.git$/i, "");
  if (repoName === "") repoName = "repo";
  const container = api.join(api.dirname(main), `${sanitizeFolderName(repoName)}.worktrees`);
  const taken = new Set<string>();
  for (const n of input.existingNames ?? []) taken.add(n.toLowerCase());
  const base = sanitizeFolderName(input.branchName);
  let slug = base;
  for (let n = 2; taken.has(slug.toLowerCase()); n++) slug = `${base}-${n}`;
  return api.join(container, slug);
}

// --- string-level path classification (FR-639 step 0, FR-640 step 1: runs BEFORE any filesystem touch) ---

export type PathStringProblem = "empty" | "controlChars" | "unc" | "notAbsolute" | "reservedName";

/** `platform` is injectable so the Windows rules are testable anywhere. */
export function classifyPathString(p: string, platform: string = process.platform): PathStringProblem | null {
  if (p === "") return "empty";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(p)) return "controlChars";
  // \\server, \\?\UNC, \\.\ device paths and //server/share all count as UNC; forward-slash form too.
  if (/^[\\/]{2}/.test(p)) return "unc";
  const win = platform === "win32";
  if (win ? !/^[A-Za-z]:[\\/]/.test(p) : !p.startsWith("/")) return "notAbsolute";
  const parts = p.split(/[\\/]+/).filter((s) => s !== "");
  const names = win ? parts.slice(1) : parts.slice(-1);
  if (names.some(isReservedDeviceName)) return "reservedName";
  return null;
}

/** Windows MAX_PATH as the spec measures it (characters, after realpath expansion of 8.3 names). */
export const WINDOWS_MAX_PATH = 260;

// --- path relations ---

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
