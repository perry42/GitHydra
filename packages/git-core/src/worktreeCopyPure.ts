// SPDX-License-Identifier: GPL-3.0-or-later
import { isReservedDeviceName } from "./worktreeParse";

/**
 * Pure rules for copying ignored files into a new worktree (specs/worktree-copy-ignored.md FR-627..630). No I/O and no
 * Node globals at load time (renderer-reachable, see rendererSafeLoad). Name checks are prefix/suffix/substring tests,
 * never backtracking regexes, so a hostile file name cannot stall the renderer.
 */

export const RECORD_MAX_PATHS = 200;
export const RECORD_MAX_REPOS = 200;
export const SEED_MAX_ROWS = 20;
export const SEED_MAX_BYTES = 20 * 1024 * 1024;
export const LARGE_BYTES = 50 * 1024 * 1024;
export const LARGE_FILES = 5000;
const MAX_PATH_CHARS = 260;
const MAX_SEGMENT_CHARS = 255;

const lastSegment = (p: string): string => {
  const trimmed = p.endsWith("/") ? p.slice(0, -1) : p;
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
};

// --- FR-627 secret-looking ---

const SECRET_PREFIXES = [".env", "id_", "credentials"] as const;
const SECRET_SUFFIXES = [".pem", ".key", ".p12", ".pfx", ".jks"] as const;
const SECRET_EXACT = [".npmrc", ".netrc", ".pypirc"] as const;
const SECRET_SUBSTRINGS = ["secret", "token", "password"] as const;

/** Name-pattern based on the BASENAME (false positives such as `tokenizer.js` cost a warning; false negatives are accepted). */
export function isSecretLooking(relPath: string): boolean {
  const name = lastSegment(relPath).toLowerCase();
  if (SECRET_PREFIXES.some((p) => name.startsWith(p))) return true;
  if (SECRET_SUFFIXES.some((s) => name.endsWith(s))) return true;
  if (SECRET_EXACT.some((e) => name === e)) return true;
  return SECRET_SUBSTRINGS.some((s) => name.includes(s));
}

// --- FR-627 run-code-on-open ---

/** Any path segment equal to one of these (directories, or a file of that name). */
const RUN_CODE_SEGMENTS = [".idea", ".husky", ".githooks", ".devcontainer", ".claude", ".cursor", ".zed", ".yarn", ".direnv", ".mvn", ".bundle"] as const;
/** Basename equals. */
const RUN_CODE_NAMES = [".envrc", ".yarnrc.yml"] as const;
/** Basename starts with. */
const RUN_CODE_PREFIXES = [".mise", ".pre-commit", ".lefthook"] as const;
/** Consecutive segments; a directory row ending at the first segment also counts (it contains the file). */
const RUN_CODE_SEQUENCES: readonly (readonly [string, string])[] = [
  [".vscode", "tasks.json"],
  [".vscode", "launch.json"],
  [".vscode", "settings.json"],
  [".cargo", "config.toml"],
];

/** True when opening the new worktree in an editor or shell may execute this (tagged, never pre-ticked from `.worktreeinclude`). */
export function runsCodeWhenOpened(relPath: string): boolean {
  const isDir = relPath.endsWith("/");
  const segs = (isDir ? relPath.slice(0, -1) : relPath).toLowerCase().split("/");
  const base = segs[segs.length - 1] ?? "";
  if (segs.some((s) => (RUN_CODE_SEGMENTS as readonly string[]).includes(s))) return true;
  if ((RUN_CODE_NAMES as readonly string[]).includes(base)) return true;
  if (RUN_CODE_PREFIXES.some((p) => base.startsWith(p))) return true;
  for (const [a, b] of RUN_CODE_SEQUENCES) {
    for (let i = 0; i < segs.length; i++) {
      if (segs[i] !== a) continue;
      if (segs[i + 1] === b) return true;
      if (isDir && i === segs.length - 1) return true;
    }
  }
  return false;
}

// --- FR-627 large ---

const LARGE_DIR_NAMES = ["node_modules", "target", "dist", "build", ".venv", "venv", "vendor", ".gradle", "pods"] as const;

export function isLargeRow(row: { path: string; fileCount?: number | null; bytes?: number | null }): boolean {
  const segs = (row.path.endsWith("/") ? row.path.slice(0, -1) : row.path).toLowerCase().split("/");
  if (segs.some((s) => (LARGE_DIR_NAMES as readonly string[]).includes(s))) return true;
  if (typeof row.bytes === "number" && row.bytes >= LARGE_BYTES) return true;
  return typeof row.fileCount === "number" && row.fileCount >= LARGE_FILES;
}

// --- FR-630 path hygiene (refused, never sanitised, on EVERY platform) ---

export type PathHygieneReason =
  | "empty"
  | "nul"
  | "control-character"
  | "bidi"
  | "absolute"
  | "drive-relative"
  | "parent-segment"
  | "git-directory"
  | "reserved-name"
  | "short-name"
  | "extended-prefix"
  | "alternate-stream"
  | "trailing-dot-or-space"
  | "empty-segment"
  | "too-long";

export type PathHygiene = { ok: true } | { ok: false; reason: PathHygieneReason };

const bad = (reason: PathHygieneReason): PathHygiene => ({ ok: false, reason });

function isBidi(c: number): boolean {
  return c === 0x061c || c === 0x200e || c === 0x200f || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
}
function isInvisibleFormat(c: number): boolean {
  return c === 0x00ad || (c >= 0x200b && c <= 0x200d) || c === 0x2060 || c === 0xfeff;
}

/** `name~N` or `name~N.ext`: the 8.3 alias form Windows resolves to a long name (`git~1` is `.git`). */
function isShortName(seg: string): boolean {
  const tilde = seg.indexOf("~");
  if (tilde < 1 || tilde > 6) return false;
  let i = tilde + 1;
  let digits = 0;
  while (i < seg.length && seg.charCodeAt(i) >= 48 && seg.charCodeAt(i) <= 57) {
    i++;
    digits++;
  }
  if (digits === 0) return false;
  if (i === seg.length) return true;
  return seg[i] === "." && seg.length - i - 1 <= 3 && !seg.slice(i + 1).includes(".");
}

/** FR-630. `relPath` uses `/` as git reports it (a directory row ends in one `/`); `\` also counts as a separator here. */
export function validateCopyPath(relPath: string): PathHygiene {
  if (relPath === "") return bad("empty");
  for (let i = 0; i < relPath.length; i++) {
    const c = relPath.charCodeAt(i);
    if (c === 0) return bad("nul");
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return bad("control-character");
    if (isBidi(c)) return bad("bidi");
  }
  if (relPath.startsWith("\\\\?\\") || relPath.startsWith("//?/") || relPath.startsWith("\\\\.\\")) return bad("extended-prefix");
  if (relPath.startsWith("/") || relPath.startsWith("\\")) return bad("absolute");
  const colon = relPath.indexOf(":");
  if (colon === 1 && /^[A-Za-z]$/.test(relPath[0]!)) return bad(relPath[2] === "/" || relPath[2] === "\\" ? "absolute" : "drive-relative");
  if (colon >= 0) return bad("alternate-stream");
  const body = relPath.endsWith("/") ? relPath.slice(0, -1) : relPath;
  if (body === "") return bad("empty");
  if (relPath.length >= MAX_PATH_CHARS) return bad("too-long");
  const segs = body.split(/[\\/]/);
  for (const seg of segs) {
    if (seg === "") return bad("empty-segment");
    if (seg === "..") return bad("parent-segment");
    if (seg.length > MAX_SEGMENT_CHARS) return bad("too-long");
    let folded = "";
    for (let i = 0; i < seg.length; i++) if (!isInvisibleFormat(seg.charCodeAt(i))) folded += seg[i];
    folded = folded.toLowerCase();
    if (folded === ".git" || folded === "git~1") return bad("git-directory");
    if (seg.endsWith(".") || seg.endsWith(" ")) return bad("trailing-dot-or-space");
    if (folded.replace(/[. ]+$/, "") === ".git") return bad("git-directory");
    if (isReservedDeviceName(seg)) return bad("reserved-name");
    if (isShortName(seg)) return bad("short-name");
  }
  return { ok: true };
}

// --- candidates, tags, initial ticks ---

export type CandidateDisabledReason = "nested-repository" | "symbolic-link" | "not-a-regular-file" | "name-not-allowed" | "too-many-files";

export interface CopyCandidateRow {
  /** Exactly as git reports it; directories end in `/`. */
  path: string;
  isDirectory: boolean;
  /** Null when not computed. */
  fileCount: number | null;
  bytes: number | null;
  disabledReason?: CandidateDisabledReason | null;
}

export interface RowTags {
  secret: boolean;
  runsCode: boolean;
  large: boolean;
}
export const tagRow = (row: CopyCandidateRow): RowTags => ({ secret: isSecretLooking(row.path), runsCode: runsCodeWhenOpened(row.path), large: isLargeRow(row) });

export interface CopyMemoryRecord {
  v: 1;
  paths: string[];
  at: number;
}

export interface InitialTicks {
  ticked: string[];
  source: "memory" | "worktreeinclude" | "none";
  /** `.worktreeinclude` matches that look like secrets: shown with a hint, never ticked. */
  secretsInInclude: string[];
  /** `.worktreeinclude` matches left unticked because memory won or the budget failed (tagged `in .worktreeinclude`). */
  includeUnticked: string[];
}

const tickable = (r: CopyCandidateRow): boolean => !r.disabledReason;

/**
 * FR-627 order. Memory first (a remembered secret IS ticked, it is the user's own); else non-secret, non-run-code
 * `.worktreeinclude` matches when the whole set fits (<= 20 rows, <= 20 MB, nothing large; unknown size does not fit); else nothing.
 */
export function decideInitialTicks(input: { candidates: readonly CopyCandidateRow[]; record: CopyMemoryRecord | null; includeMatches: readonly string[] }): InitialTicks {
  const byPath = new Map(input.candidates.map((c) => [c.path, c]));
  const matches = [...new Set(input.includeMatches)].filter((p) => {
    const r = byPath.get(p);
    return r !== undefined && tickable(r);
  });
  const secretsInInclude = matches.filter(isSecretLooking);
  const remembered = (input.record?.paths ?? []).filter((p) => {
    const r = byPath.get(p);
    return r !== undefined && tickable(r) && validateCopyPath(p).ok;
  });
  if (remembered.length > 0) {
    return { ticked: remembered, source: "memory", secretsInInclude, includeUnticked: matches.filter((p) => !remembered.includes(p)) };
  }
  const eligible = matches.filter((p) => !isSecretLooking(p) && !runsCodeWhenOpened(p));
  let fits = eligible.length > 0 && eligible.length <= SEED_MAX_ROWS;
  let total = 0;
  for (const p of eligible) {
    const r = byPath.get(p)!;
    if (r.bytes === null || isLargeRow(r)) fits = false;
    else total += r.bytes;
  }
  if (fits && total <= SEED_MAX_BYTES) return { ticked: eligible, source: "worktreeinclude", secretsInInclude, includeUnticked: [] };
  return { ticked: [], source: "none", secretsInInclude, includeUnticked: matches };
}

// --- FR-629 save rule ---

export type MemoryDecision = { action: "none" } | { action: "delete" } | { action: "write"; paths: string[] };

/**
 * `initial` and `final` are the ticked path sets; `candidates` are ALL candidate rows (not just the 6 shown). A secret-looking
 * path is kept only if it was already in the user's own record or was ticked by hand (not in `initial`), so an include-file seed never lands.
 */
export function decide(
  initial: readonly string[],
  final: readonly string[],
  checkboxOn: boolean,
  candidates: readonly CopyCandidateRow[],
  record: CopyMemoryRecord | null,
): MemoryDecision {
  if (!checkboxOn) return { action: "none" };
  const a = new Set(initial);
  const b = new Set(final);
  if (a.size === b.size && [...a].every((p) => b.has(p))) return { action: "none" };
  const candidatePaths = new Set(candidates.map((c) => c.path));
  const remembered = new Set(record?.paths ?? []);
  const out: string[] = [];
  const add = (p: string): void => {
    if (!out.includes(p) && validateCopyPath(p).ok) out.push(p);
  };
  for (const p of final) {
    if (isSecretLooking(p) && a.has(p) && !remembered.has(p)) continue;
    add(p);
  }
  for (const p of record?.paths ?? []) if (!candidatePaths.has(p)) add(p);
  const paths = out.slice(0, RECORD_MAX_PATHS);
  if (paths.length === 0) return record ? { action: "delete" } : { action: "none" };
  if (record && paths.length === remembered.size && paths.every((p) => remembered.has(p))) return { action: "none" };
  return { action: "write", paths };
}

// --- record helpers ---

/** Wrong shape, wrong version or over the path cap: null (dropped). Invalid individual paths are filtered out; none left: null. */
export function normalizeRecord(raw: unknown): CopyMemoryRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as { v?: unknown; paths?: unknown; at?: unknown };
  if (r.v !== 1 || !Array.isArray(r.paths) || typeof r.at !== "number" || !Number.isFinite(r.at)) return null;
  if (r.paths.length > RECORD_MAX_PATHS) return null;
  const paths: string[] = [];
  for (const p of r.paths) if (typeof p === "string" && validateCopyPath(p).ok && !paths.includes(p)) paths.push(p);
  return paths.length === 0 ? null : { v: 1, paths, at: r.at };
}

/** Strictly increasing `at`, so two writes in one millisecond still order (the eviction tie-break). */
export const nextRecordAt = (now: number, lastAt: number): number => Math.max(now, lastAt + 1);

/** Keys to remove so at most `max` records remain: oldest `at` first, ties by input order. */
export function evictRecords(entries: readonly { key: string; at: number }[], max: number = RECORD_MAX_REPOS): string[] {
  const excess = entries.length - max;
  if (excess <= 0) return [];
  return entries
    .map((e, i) => ({ ...e, i }))
    .sort((x, y) => x.at - y.at || x.i - y.i)
    .slice(0, excess)
    .map((e) => e.key);
}

// --- FR-628 text ---

export function formatCopySize(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, Math.floor(bytes))} B`;
  const kb = Math.max(1, Math.round(bytes / 1024));
  if (kb < 1024) return `${kb} KB`;
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
}

const files = (n: number): string => (n === 1 ? "1 file" : `${n} files`);
const secretFiles = (n: number): string => (n === 1 ? "1 secret file" : `${n} secret files`);
const nameList = (names: readonly string[]): string => {
  const shown = names.slice(0, 3).join(", ");
  return names.length > 3 ? `${shown} and ${names.length - 3} more` : shown;
};

export type CopyLineState =
  | { kind: "checking" }
  | { kind: "none-ticked" }
  | { kind: "from-memory"; count: number; bytes: number | null; names: readonly string[] }
  | { kind: "from-include"; count: number; bytes: number | null }
  | { kind: "secret-ticked"; names: readonly string[] }
  | { kind: "include-secrets-unticked"; names: readonly string[] }
  | { kind: "skipped-this-time"; count: number }
  | { kind: "failed" };

export interface CopyLineText {
  /** One text node. */
  text: string;
  /** Muted trailing text. */
  note?: string;
  /** Second line. */
  detail?: string;
  action?: "Choose files" | "Try again";
  /** Rendered with a triangle icon and the word "secret", never colour alone. */
  warning?: boolean;
}

export function copyLineText(state: CopyLineState): CopyLineText {
  const size = (bytes: number | null): string => (bytes === null ? "" : ` · ${formatCopySize(bytes)}`);
  switch (state.kind) {
    case "checking":
      return { text: "Checking for ignored files..." };
    case "none-ticked":
      return { text: "No ignored files will be copied.", action: "Choose files" };
    case "from-memory":
      return { text: `Copy ${files(state.count)}${size(state.bytes)}`, note: "remembered for this repo", detail: nameList(state.names) };
    case "from-include":
      return { text: `Copy ${files(state.count)}${size(state.bytes)} from .worktreeinclude` };
    case "secret-ticked":
      return { text: `${secretFiles(state.names.length)}: ${nameList(state.names)}`, warning: true };
    case "include-secrets-unticked":
      return {
        text:
          state.names.length === 1
            ? `${state.names[0]} is listed in .worktreeinclude but looks like a secret, so it is not ticked.`
            : `${state.names.length} files listed in .worktreeinclude look like secrets, so they are not ticked: ${state.names.join(", ")}.`,
        warning: true,
      };
    case "skipped-this-time":
      return { text: `Copy ${files(state.count)}`, note: "skipped this time" };
    case "failed":
      return { text: "Couldn't list ignored files. The worktree will be created without copying.", action: "Try again", warning: true };
  }
}

// --- skip reasons (shared with the copy engine) ---

export type CopySkipReason =
  | "not-in-manifest"
  | "row-disabled"
  | "unsafe-path"
  | "changed-since-review"
  | "source-symlink"
  | "source-parent-link"
  | "not-regular-file"
  | "source-unreadable"
  | "destination-parent-link"
  | "destination-not-directory"
  | "already-exists"
  | "tracked-in-destination"
  | "case-collision"
  | "path-too-long"
  | "file-limit"
  | "size-limit"
  | "time-limit"
  | "cancelled"
  | "write-failed";

/** Text for the result banner (FR-643 wording for changed files). */
export const COPY_SKIP_MESSAGES: Record<CopySkipReason, string> = {
  "not-in-manifest": "not in the reviewed list",
  "row-disabled": "cannot be copied",
  "unsafe-path": "name not allowed",
  "changed-since-review": "changed since you reviewed",
  "source-symlink": "symbolic link, not copied",
  "source-parent-link": "inside a linked folder, not copied",
  "not-regular-file": "not a regular file",
  "source-unreadable": "cannot be read",
  "destination-parent-link": "destination folder is a link",
  "destination-not-directory": "a file is in the way",
  "already-exists": "already exists",
  "tracked-in-destination": "tracked in the new worktree",
  "case-collision": "name collides with another file",
  "path-too-long": "path too long",
  "file-limit": "file limit reached",
  "size-limit": "size limit reached",
  "time-limit": "time limit reached",
  cancelled: "cancelled",
  "write-failed": "could not be written",
};
