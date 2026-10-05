// SPDX-License-Identifier: GPL-3.0-or-later
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runGit, runGitAllowingExitCodes, runGitWithInput, runInMutationQueue, withFsmonitorNeutralized, withReadOnlyIndex } from "./gitProcess";
import { GitCommandError, IgnoreFileChangedError, IgnorePlanChangedError, IgnoreUntrackError, IgnoreWriteError, InvalidArgumentError, IGNORE_ROW_LIMIT, TooManyFilesError } from "./errors";
import { assertPathWithinWorkdir, isErrnoException } from "./pathSafety";
import { getWorkingDirectoryChanges } from "./workingDirStatus";
import { batchArgs } from "./argvBatch";

/**
 * specs/ignore-and-multiselect.md FR-494..FR-502: write ignore rules and optionally untrack files. Every path is
 * re-validated against a fresh status/index lookup here; the caller's strings are never trusted as-is (FR-499).
 */

export type IgnoreScope = "name" | "extension" | "directory";
export type IgnoreTarget = "root" | "nearest" | "exclude";

export interface IgnoreRequest {
  /** Repo-relative, `/`-separated row paths as shown by status; a trailing `/` marks a directory row (nested repo). */
  paths: readonly string[];
  scope: IgnoreScope;
  target: IgnoreTarget;
  /** FR-500: after writing the rule, `rm --cached` exactly the selected tracked files (or tracked files under the directory). */
  stopTracking?: boolean;
  /**
   * Security review L2: the `StopTrackingReport.paths` the user confirmed. When set with `stopTracking`, a recomputed set
   * that differs throws `IgnorePlanChangedError` before anything is written.
   */
  expectedUntrackPaths?: string[];
}

export type IgnoreRefusalCode =
  | "not-in-status"
  | "conflicted"
  | "submodule"
  | "symlinked-parent"
  | "unrepresentable-name"
  | "no-extension"
  | "no-parent-directory"
  | "directory-has-no-extension"
  | "target-unsafe"
  | "target-unwritable";

export interface IgnoreMatch {
  /** `check-ignore -v` source as git printed it (`.gitignore`, `a/.gitignore`, `.git/info/exclude`, or an absolute global file). */
  source: string;
  line: number;
  pattern: string;
}

export interface IgnoreRowReport {
  path: string;
  tracked: boolean;
  outcome: "will-write" | "written" | "already-in" | "already-ignored" | "still-not-ignored" | "refused";
  rule?: string;
  /** Display name of the file the rule goes (or went) into. */
  file?: string;
  /** For `already-ignored`: the rule that ignores it. For `still-not-ignored`: the later `!` rule that wins. */
  ignoredBy?: IgnoreMatch;
  reasonCode?: IgnoreRefusalCode;
  reason?: string;
}

export interface IgnoreFileReport {
  file: string;
  /** True when the file does not exist yet and will be/was created (always LF, no BOM). */
  created: boolean;
  /** Rules that are (to be) appended, in order. */
  rules: string[];
  alreadyPresent: string[];
  /** `.git/info/exclude` of a linked worktree is shared with the main checkout; the UI must say so (FR-495). */
  sharedWithOtherWorktrees: boolean;
}

export interface StopTrackingReport {
  /** Exactly the files that are (were) removed from the index; the worktree is never touched. */
  paths: string[];
  count: number;
  /** Tracked files that match the new rules but are not in `paths` and therefore stay tracked. */
  otherMatchesStillTracked: number;
  /** Rows with both staged and unstaged edits: the staged edits are dropped from the index. */
  mixedRows: string[];
  /** Staged renames: the new path is untracked; the old path stays staged as deleted. */
  renamedRows: { path: string; oldPath: string }[];
  skippedSubmodules: string[];
  skippedConflicted: string[];
}

export interface IgnoreReport {
  rows: IgnoreRowReport[];
  files: IgnoreFileReport[];
  stopTracking: StopTrackingReport | null;
  applied: boolean;
}

// --- rule text -------------------------------------------------------------------------------------------------

/** FR-496: escape `\ * ? [ ]` in a name part (not in the wrapper `/`, `*`, `/` we add around it). */
function escapeName(text: string): string {
  return text.replace(/[\\*?[\]]/g, (c) => "\\" + c);
}

/** FR-496: escape a leading `#`/`!` and a trailing run of spaces (git strips unescaped trailing spaces) in a finished rule. */
function finishRule(rule: string): string {
  const lead = rule.startsWith("#") || rule.startsWith("!") ? "\\" + rule : rule;
  return lead.replace(/ +$/, (spaces) => "\\ ".repeat(spaces.length));
}

/** Full escaping of free text used as a whole pattern. Exported for tests. */
export function escapeIgnorePattern(text: string): string {
  return finishRule(escapeName(text));
}

function hasUnrepresentableChar(s: string): boolean {
  return /[\r\n\0]/.test(s);
}

interface RuleChoice {
  rule?: string;
  code?: IgnoreRefusalCode;
  reason?: string;
}

function relFrom(targetDir: string, p: string): string {
  return targetDir === "" ? p : p.slice(targetDir.length + 1);
}

/** FR-494/FR-496: the single rule for `rowPath` under `scope`, anchored relative to the directory of the file it is written into. */
export function buildIgnoreRule(rowPath: string, isDir: boolean, scope: IgnoreScope, targetDir: string): RuleChoice {
  if (scope === "name") {
    if (hasUnrepresentableChar(rowPath)) return { code: "unrepresentable-name", reason: "The name contains a line break or NUL and cannot be written as an ignore rule." };
    return { rule: finishRule(`/${escapeName(relFrom(targetDir, rowPath))}${isDir ? "/" : ""}`) };
  }
  if (scope === "extension") {
    if (isDir) return { code: "directory-has-no-extension", reason: "Extension rules are not offered for directories." };
    const base = rowPath.slice(rowPath.lastIndexOf("/") + 1);
    const dot = base.lastIndexOf(".");
    if (dot <= 0 || dot === base.length - 1) return { code: "no-extension", reason: "This file has no extension." };
    const ext = base.slice(dot);
    if (hasUnrepresentableChar(ext)) return { code: "unrepresentable-name", reason: "The extension contains a line break or NUL." };
    return { rule: finishRule(`*${escapeName(ext)}`) };
  }
  const dir = isDir ? rowPath : rowPath.includes("/") ? rowPath.slice(0, rowPath.lastIndexOf("/")) : "";
  if (dir === "") return { code: "no-parent-directory", reason: "The file is in the repository root; there is no parent directory to ignore." };
  if (hasUnrepresentableChar(dir)) return { code: "unrepresentable-name", reason: "The directory name contains a line break or NUL." };
  return { rule: finishRule(`/${escapeName(relFrom(targetDir, dir))}/`) };
}

/** Raw fs errors embed absolute paths; surface the errno and the repo-relative display name only (security review L4). */
function asIgnoreFsError(err: unknown, display: string): unknown {
  if (err instanceof IgnoreWriteError || err instanceof IgnoreFileChangedError || !isErrnoException(err)) return err;
  return new IgnoreWriteError(display, err.code!);
}

// --- file bytes ------------------------------------------------------------------------------------------------

// Lazy: the renderer bundle evaluates this module at load, where `Buffer` does not exist.
const hasUtf8Bom = (b: Buffer): boolean => b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;

/** FR-498: append rules touching no other byte; keeps BOM and dominant EOL, adds a missing final newline first. Exported for tests. */
export function appendIgnoreRules(existing: Buffer, rules: readonly string[]): { bytes: Buffer; added: string[]; present: string[] } {
  const hasBom = hasUtf8Bom(existing);
  const body = hasBom ? existing.subarray(3) : existing;
  const text = body.toString("latin1");
  const have = new Set(text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l)));
  const added: string[] = [];
  const present: string[] = [];
  for (const r of rules) {
    if (added.includes(r) || present.includes(r)) continue;
    if (have.has(Buffer.from(r, "utf8").toString("latin1"))) present.push(r);
    else added.push(r);
  }
  if (added.length === 0) return { bytes: existing, added, present };
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  const eol = crlf > lf ? "\r\n" : "\n";
  const needsEol = body.length > 0 && body[body.length - 1] !== 0x0a;
  const tail = Buffer.from((needsEol ? eol : "") + added.map((r) => r + eol).join(""), "utf8");
  return { bytes: Buffer.concat([existing, tail]), added, present };
}

interface Snapshot {
  exists: boolean;
  bytes: Buffer;
  mode: number | undefined;
}

class TargetRefusal extends Error {
  constructor(
    public readonly code: IgnoreRefusalCode,
    message: string,
  ) {
    super(message);
  }
}

/** FR-499: a symlinked or non-regular rule file is refused, never followed. */
async function snapshotFile(abs: string): Promise<Snapshot> {
  let st;
  try {
    st = await fs.lstat(abs);
  } catch (err) {
    if (isErrnoException(err) && (err.code === "ENOENT" || err.code === "ENOTDIR")) return { exists: false, bytes: Buffer.alloc(0), mode: undefined };
    throw new TargetRefusal("target-unwritable", `Cannot read the ignore file (${isErrnoException(err) ? err.code : "unreadable"}).`);
  }
  if (st.isSymbolicLink()) throw new TargetRefusal("target-unsafe", "The ignore file is a symbolic link; it was not touched.");
  if (!st.isFile()) throw new TargetRefusal("target-unsafe", "The ignore file is not a regular file.");
  try {
    return { exists: true, bytes: await fs.readFile(abs), mode: st.mode & 0o7777 };
  } catch (err) {
    throw new TargetRefusal("target-unwritable", `Cannot read the ignore file (${isErrnoException(err) ? err.code : "unreadable"}).`);
  }
}

async function writeAtomic(abs: string, bytes: Buffer, mode: number | undefined): Promise<void> {
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.githydra-${randomBytes(6).toString("hex")}.tmp`);
  await fs.writeFile(tmp, bytes, { flag: "wx", mode: mode ?? 0o644 });
  try {
    if (mode !== undefined && process.platform !== "win32") await fs.chmod(tmp, mode);
    await fs.rename(tmp, abs);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

let beforeRenameHook: ((abs: string) => Promise<void>) | null = null;

/** Test-only: runs after the temp file is written and before the concurrent-change re-check (simulates a racing editor). */
export function _setIgnoreBeforeRenameHookForTests(hook: ((abs: string) => Promise<void>) | null): void {
  beforeRenameHook = hook;
}

let afterWriteHook: (() => Promise<void>) | null = null;

/** Test-only: runs after the rule files are written and before the untrack step (simulates a user edit in between). */
export function _setIgnoreAfterWriteHookForTests(hook: (() => Promise<void>) | null): void {
  afterWriteHook = hook;
}

interface WrittenFile {
  abs: string;
  display: string;
  before: Buffer | null;
  after: Buffer;
  mode: number | undefined;
}

/** FR-498: read-modify-write; if the file changed in between, re-read once, then fail without writing. */
async function updateRuleFile(abs: string, display: string, rules: readonly string[], recheckDir: () => Promise<void>): Promise<WrittenFile | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const snap = await snapshotFile(abs);
    const { bytes, added } = appendIgnoreRules(snap.exists && snap.bytes.length > 0 ? snap.bytes : Buffer.alloc(0), rules);
    if (added.length === 0) return null;
    const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.githydra-${randomBytes(6).toString("hex")}.tmp`);
    await recheckDir();
    try {
      await fs.writeFile(tmp, bytes, { flag: "wx", mode: snap.mode ?? 0o644 });
    } catch (err) {
      throw asIgnoreFsError(err, display);
    }
    try {
      if (snap.mode !== undefined && process.platform !== "win32") await fs.chmod(tmp, snap.mode);
      await beforeRenameHook?.(abs);
      const again = await snapshotFile(abs);
      if (again.exists !== snap.exists || !again.bytes.equals(snap.bytes)) {
        await fs.unlink(tmp).catch(() => {});
        if (attempt === 0) continue;
        throw new IgnoreFileChangedError(display);
      }
      // L3: a folder swapped for a symlink since analysis would redirect the rename outside the repo.
      await recheckDir();
      await fs.rename(tmp, abs);
    } catch (err) {
      await fs.unlink(tmp).catch(() => {});
      throw asIgnoreFsError(err, display);
    }
    return { abs, display, before: snap.exists ? snap.bytes : null, after: bytes, mode: snap.mode };
  }
  throw new IgnoreFileChangedError(display);
}

/** FR-500: restore only if the file is still byte-for-byte what we wrote; anything else is the user's and stays. */
async function rollbackFile(w: WrittenFile): Promise<boolean> {
  try {
    const cur = await snapshotFile(w.abs);
    if (!cur.exists || !cur.bytes.equals(w.after)) return false;
    if (w.before === null) await fs.unlink(w.abs);
    else await writeAtomic(w.abs, w.before, w.mode);
    return true;
  } catch {
    return false;
  }
}

// --- git lookups -----------------------------------------------------------------------------------------------

interface IndexEntry {
  mode: string;
  stage: number;
}

async function readIndexEntries(workdir: string, pathspecs: readonly string[]): Promise<Map<string, IndexEntry[]>> {
  const out = new Map<string, IndexEntry[]>();
  for (const batch of batchArgs(pathspecs, 80)) {
    const { stdout } = await runGit(withReadOnlyIndex(["--literal-pathspecs", "ls-files", "--stage", "-z", "--", ...batch]), { cwd: workdir });
    for (const rec of stdout.split("\0")) {
      if (!rec) continue;
      const tab = rec.indexOf("\t");
      const [mode, , stage] = rec.slice(0, tab).split(" ");
      const p = rec.slice(tab + 1);
      const list = out.get(p) ?? [];
      list.push({ mode: mode!, stage: Number(stage) });
      out.set(p, list);
    }
  }
  return out;
}

/** Exported for tests only. A leading `:` is pathspec magic to check-ignore, so such names go as `./name`. */
export async function _checkIgnoreForTests(workdir: string, paths: readonly string[]) {
  return checkIgnore(workdir, paths);
}

async function checkIgnore(workdir: string, paths: readonly string[]): Promise<Map<string, (IgnoreMatch & { negated: boolean }) | null>> {
  const result = new Map<string, (IgnoreMatch & { negated: boolean }) | null>();
  for (const batch of batchArgs(paths, 120)) {
    // `-n` prints one line per input in order, so results map by position; `--no-index` evaluates tracked files too (FR-497).
    const r = await runGitAllowingExitCodes(
      withReadOnlyIndex(["-c", "core.quotepath=false", "check-ignore", "-v", "-n", "--no-index", "--", ...batch.map((p) => (p.startsWith(":") ? `./${p}` : p))]),
      // check-ignore rejects the literal-pathspec env (it takes exact paths, not pathspecs), so it is switched off for this one read.
      { cwd: workdir, extraEnv: { GIT_LITERAL_PATHSPECS: "0" } },
      [0, 1],
    );
    const lines = r.stdout.split("\n").filter((l) => l.length > 0);
    if (lines.length !== batch.length) throw new Error("Unexpected output from git check-ignore.");
    batch.forEach((p, i) => {
      const line = lines[i]!;
      const tab = line.lastIndexOf("\t");
      const m = /^(.*?):(\d+):(.*)$/s.exec(line.slice(0, tab));
      result.set(p, m ? { source: m[1]!, line: Number(m[2]), pattern: m[3]!, negated: m[3]!.startsWith("!") } : null);
    });
  }
  return result;
}

interface GitDirs {
  excludeAbs: string;
  gitDir: string;
  commonDir: string;
}

async function resolveGitDirs(workdir: string): Promise<GitDirs> {
  const run = async (args: string[]) => (await runGit(withReadOnlyIndex(args), { cwd: workdir })).stdout.trim();
  const [gitDir, common, exclude] = await Promise.all([
    run(["rev-parse", "--absolute-git-dir"]),
    run(["rev-parse", "--git-common-dir"]),
    run(["rev-parse", "--git-path", "info/exclude"]),
  ]);
  return { gitDir: path.resolve(gitDir), commonDir: path.resolve(workdir, common), excludeAbs: path.resolve(workdir, exclude) };
}

function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** First symlinked directory component of `relDir` under `workdir`, or null. Same defence as `discardGuard.ts`. */
async function symlinkedComponent(workdir: string, relDir: string): Promise<string | null> {
  if (relDir === "") return null;
  let cur = path.resolve(workdir);
  for (const seg of relDir.split("/")) {
    cur = path.join(cur, seg);
    try {
      if ((await fs.lstat(cur)).isSymbolicLink()) return seg;
    } catch (err) {
      if (isErrnoException(err) && (err.code === "ENOENT" || err.code === "ENOTDIR")) return null;
      throw asIgnoreFsError(err, path.relative(path.resolve(workdir), cur).split(path.sep).join("/") || ".");
    }
  }
  return null;
}

// --- analysis --------------------------------------------------------------------------------------------------

interface Row {
  path: string;
  isDir: boolean;
  tracked: boolean;
  report: IgnoreRowReport;
  targetDir: string | null;
  targetAbs: string | null;
}

interface TargetFile {
  key: string;
  abs: string;
  display: string;
  targetDir: string;
  isExclude: boolean;
  snap: Snapshot | null;
  refusal: TargetRefusal | null;
  rules: string[];
}

function displayFor(workdir: string, abs: string): string {
  const rel = path.relative(path.resolve(workdir), abs);
  return rel.startsWith("..") || path.isAbsolute(rel) ? abs : rel.split(path.sep).join("/");
}

function refuse(row: Row, code: IgnoreRefusalCode, reason: string): void {
  row.report.outcome = "refused";
  row.report.reasonCode = code;
  row.report.reason = reason;
}

async function nearestIgnoreDir(workdir: string, startDir: string, cache: Map<string, string>): Promise<string> {
  const cached = cache.get(startDir);
  if (cached !== undefined) return cached;
  let dir = startDir;
  for (;;) {
    let exists = true;
    try {
      await fs.lstat(path.join(path.resolve(workdir), dir, ".gitignore"));
    } catch (err) {
      if (isErrnoException(err) && (err.code === "ENOENT" || err.code === "ENOTDIR")) exists = false;
    }
    if (exists || dir === "") break;
    dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
  }
  cache.set(startDir, dir);
  return dir;
}

interface Analysis {
  rows: Row[];
  targets: Map<string, TargetFile>;
  changes: Awaited<ReturnType<typeof getWorkingDirectoryChanges>>;
  index: Map<string, IndexEntry[]>;
  dirs: GitDirs;
  scope: IgnoreScope;
}

async function analyze(workdir: string, req: IgnoreRequest): Promise<Analysis> {
  if (!Array.isArray(req.paths) || req.paths.length === 0) throw new InvalidArgumentError("Choose at least one file to ignore.");
  if (!["name", "extension", "directory"].includes(req.scope)) throw new InvalidArgumentError(`Unknown ignore scope: ${String(req.scope)}`);
  if (!["root", "nearest", "exclude"].includes(req.target)) throw new InvalidArgumentError(`Unknown ignore target: ${String(req.target)}`);

  if (req.paths.length > IGNORE_ROW_LIMIT) throw new TooManyFilesError(req.paths.length, IGNORE_ROW_LIMIT);
  const inputs = Array.from(new Set(req.paths));
  for (const p of inputs) assertPathWithinWorkdir(workdir, p.endsWith("/") ? p.slice(0, -1) || p : p);

  const [changes, dirs] = await Promise.all([getWorkingDirectoryChanges(workdir), resolveGitDirs(workdir)]);
  const index = await readIndexEntries(workdir, inputs.map((p) => (p.endsWith("/") ? p.slice(0, -1) : p)));
  const conflicted = new Set(changes.conflicted.map((c) => c.path));
  const known = new Set([...changes.staged, ...changes.unstaged, ...changes.untracked].map((c) => c.path));

  const rows: Row[] = [];
  for (const input of inputs) {
    const isDir = input.endsWith("/");
    const p = isDir ? input.slice(0, -1) : input;
    const entries = index.get(p);
    const row: Row = {
      path: p,
      isDir,
      tracked: !!entries && entries.length > 0,
      report: { path: input, tracked: !!entries && entries.length > 0, outcome: "will-write" },
      targetDir: null,
      targetAbs: null,
    };
    rows.push(row);
    if (conflicted.has(p) || (entries && entries.some((e) => e.stage > 0))) {
      refuse(row, "conflicted", "Conflicted files cannot be ignored; resolve the conflict first.");
    } else if (entries && entries.some((e) => e.mode === "160000")) {
      refuse(row, "submodule", "Ignoring a submodule does not untrack it; it is not offered.");
    } else if (!(isDir ? known.has(`${p}/`) : known.has(p) || row.tracked)) {
      refuse(row, "not-in-status", "This path is not in the repository's current changes.");
    } else {
      const parentDir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
      const bad = await symlinkedComponent(workdir, parentDir);
      if (bad !== null) refuse(row, "symlinked-parent", `A parent folder ("${bad}") is a symbolic link; refused.`);
    }
    row.report.path = p;
    if (isDir) row.report.path = input;
  }

  // Resolve each live row's target file, then its rule; the rule depends on the target dir (FR-496).
  const nearestCache = new Map<string, string>();
  const targets = new Map<string, TargetFile>();
  for (const row of rows) {
    if (row.report.outcome === "refused") continue;
    let targetDir = "";
    if (req.target === "nearest") {
      const thing = req.scope === "directory" && !row.isDir ? (row.path.includes("/") ? row.path.slice(0, row.path.lastIndexOf("/")) : "") : row.path;
      const start = thing.includes("/") ? thing.slice(0, thing.lastIndexOf("/")) : "";
      targetDir = await nearestIgnoreDir(workdir, start, nearestCache);
    }
    const choice = buildIgnoreRule(row.path, row.isDir, req.scope, req.target === "nearest" ? targetDir : "");
    if (!choice.rule) {
      refuse(row, choice.code!, choice.reason!);
      continue;
    }
    row.report.rule = choice.rule;
    const isExclude = req.target === "exclude";
    const abs = isExclude ? dirs.excludeAbs : path.join(path.resolve(workdir), targetDir, ".gitignore");
    const key = abs;
    let tf = targets.get(key);
    if (!tf) {
      tf = { key, abs, display: displayFor(workdir, abs), targetDir, isExclude, snap: null, refusal: null, rules: [] };
      try {
        if (isExclude) {
          if (!isWithin(dirs.commonDir, abs) && !isWithin(dirs.gitDir, abs)) throw new TargetRefusal("target-unsafe", "The exclude file lies outside the git directory.");
          const infoDir = path.dirname(abs);
          const info = await fs.lstat(infoDir).catch(() => null);
          if (info && (info.isSymbolicLink() || !info.isDirectory())) throw new TargetRefusal("target-unsafe", "The info folder is a symbolic link or not a folder.");
        } else {
          const bad = await symlinkedComponent(workdir, targetDir);
          if (bad !== null) throw new TargetRefusal("target-unsafe", `A parent folder ("${bad}") of the ignore file is a symbolic link.`);
        }
        tf.snap = await snapshotFile(abs);
      } catch (err) {
        if (!(err instanceof TargetRefusal)) throw err;
        tf.refusal = err;
      }
      targets.set(key, tf);
    }
    row.targetDir = targetDir;
    row.targetAbs = abs;
    row.report.file = tf.display;
    if (tf.refusal) {
      refuse(row, tf.refusal.code, tf.refusal.message);
      continue;
    }
    if (!tf.rules.includes(choice.rule)) tf.rules.push(choice.rule);
  }

  // FR-497: identical line in the target, then any other rule via check-ignore.
  const live = rows.filter((r) => r.report.outcome === "will-write");
  const matches = await checkIgnore(workdir, live.map((r) => (r.isDir ? `${r.path}/` : r.path)));
  for (const row of live) {
    const tf = targets.get(row.targetAbs!)!;
    const { present } = appendIgnoreRules(tf.snap!.bytes, [row.report.rule!]);
    const m = matches.get(row.isDir ? `${row.path}/` : row.path) ?? null;
    if (present.length > 0) {
      row.report.outcome = "already-in";
      if (m && m.negated) row.report.ignoredBy = { source: m.source, line: m.line, pattern: m.pattern };
    } else if (m && !m.negated) {
      row.report.outcome = "already-ignored";
      row.report.ignoredBy = { source: m.source, line: m.line, pattern: m.pattern };
    }
  }
  return { rows, targets, changes, index, dirs, scope: req.scope };
}

function fileReports(workdir: string, a: Analysis): IgnoreFileReport[] {
  const out: IgnoreFileReport[] = [];
  for (const tf of a.targets.values()) {
    if (tf.refusal) continue;
    const writing = a.rows.filter((r) => r.targetAbs === tf.abs && r.report.outcome === "will-write").map((r) => r.report.rule!);
    const present = a.rows.filter((r) => r.targetAbs === tf.abs && r.report.outcome === "already-in").map((r) => r.report.rule!);
    if (writing.length === 0 && present.length === 0) continue;
    out.push({
      file: tf.display,
      created: !tf.snap!.exists,
      rules: Array.from(new Set(writing)),
      alreadyPresent: Array.from(new Set(present)),
      sharedWithOtherWorktrees: tf.isExclude && a.dirs.commonDir !== a.dirs.gitDir,
    });
  }
  void workdir;
  return out;
}

/** Root-anchored copy of a rule written into `targetDir`, for `ls-files --exclude-from` previews. */
function rootForm(rule: string, targetDir: string): string {
  if (targetDir === "") return rule;
  const prefix = `/${targetDir.split("/").map(escapeName).join("/")}`;
  return rule.startsWith("/") ? `${prefix}${rule}` : `${prefix}/**/${rule}`;
}

async function buildStopTracking(workdir: string, a: Analysis): Promise<StopTrackingReport> {
  const picked = new Set<string>();
  const skippedSubmodules = new Set<string>();
  const skippedConflicted = new Set<string>();
  const dirsToExpand = new Set<string>();
  for (const row of a.rows) {
    if (row.report.outcome === "refused") continue;
    if (a.scope === "directory") {
      dirsToExpand.add(row.isDir ? row.path : row.path.includes("/") ? row.path.slice(0, row.path.lastIndexOf("/")) : "");
    }
    if (row.tracked && !row.isDir && a.scope !== "directory") picked.add(row.path);
  }
  for (const d of dirsToExpand) {
    if (d === "") continue;
    const { stdout } = await runGit(withReadOnlyIndex(["--literal-pathspecs", "ls-files", "--stage", "-z", "--", `${d}/`]), { cwd: workdir });
    for (const rec of stdout.split("\0")) {
      if (!rec) continue;
      const tab = rec.indexOf("\t");
      const [mode, , stage] = rec.slice(0, tab).split(" ");
      const p = rec.slice(tab + 1);
      if (mode === "160000") skippedSubmodules.add(p);
      else if (Number(stage) > 0) skippedConflicted.add(p);
      else picked.add(p);
    }
  }
  for (const row of a.rows) {
    if (row.report.outcome === "refused") continue;
    const e = a.index.get(row.path);
    if (e?.some((x) => x.mode === "160000")) picked.delete(row.path);
  }
  const paths = [...picked].sort();
  const unstaged = new Set(a.changes.unstaged.map((c) => c.path));
  const stagedMap = new Map(a.changes.staged.map((c) => [c.path, c]));
  const mixedRows = paths.filter((p) => unstaged.has(p) && stagedMap.has(p));
  const renamedRows = paths.flatMap((p) => {
    const s = stagedMap.get(p);
    return s && s.status === "renamed" && s.oldPath ? [{ path: p, oldPath: s.oldPath }] : [];
  });

  // Others: tracked files matching exactly our rules (not the whole ignore stack) that we are not untracking.
  let other = 0;
  const rules = Array.from(a.targets.values()).flatMap((tf) => (tf.refusal ? [] : [...tf.rules, ...[...new Set(a.rows.filter((r) => r.targetAbs === tf.abs && r.report.outcome === "already-in").map((r) => r.report.rule!))]].map((r) => rootForm(r, tf.targetDir))));
  if (rules.length > 0) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "githydra-ignore-")).catch((err) => { throw asIgnoreFsError(err, "temporary pattern file"); });
    try {
      const file = path.join(dir, "patterns");
      await fs.writeFile(file, rules.join("\n") + "\n", "utf8");
      const { stdout } = await runGit(withReadOnlyIndex(["ls-files", "-z", "-c", "-i", `--exclude-from=${file}`]), { cwd: workdir });
      const set = new Set(paths);
      for (const p of stdout.split("\0")) if (p && !set.has(p)) other++;
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  return { paths, count: paths.length, otherMatchesStillTracked: other, mixedRows, renamedRows, skippedSubmodules: [...skippedSubmodules], skippedConflicted: [...skippedConflicted] };
}

async function probeWritable(abs: string): Promise<boolean> {
  const dir = path.dirname(abs);
  const tmp = path.join(dir, `.githydra-probe-${randomBytes(6).toString("hex")}.tmp`);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(tmp, "", { flag: "wx" });
    await fs.unlink(tmp);
    return true;
  } catch {
    await fs.unlink(tmp).catch(() => {});
    return false;
  }
}

function assertNotBareArgs(workdir: string): void {
  if (!workdir) throw new InvalidArgumentError("Ignore needs a working directory.");
}

/** FR-500 preview: what would happen, with the counts the confirm dialog shows. Reads only. */
export async function planIgnore(workdir: string, req: IgnoreRequest): Promise<IgnoreReport> {
  assertNotBareArgs(workdir);
  const a = await analyze(workdir, req);
  const stopTracking = req.stopTracking ? await buildStopTracking(workdir, a) : null;
  return { rows: a.rows.map((r) => r.report), files: fileReports(workdir, a), stopTracking, applied: false };
}

/** FR-494..FR-500: one queue entry, one read-modify-write per target file, optional untrack. */
export function ignorePaths(workdir: string, req: IgnoreRequest): Promise<IgnoreReport> {
  assertNotBareArgs(workdir);
  return runInMutationQueue(async () => {
    const a = await analyze(workdir, req);
    const stop = req.stopTracking ? await buildStopTracking(workdir, a) : null;
    if (stop) {
      if (!Array.isArray(req.expectedUntrackPaths) || req.expectedUntrackPaths.some((p) => typeof p !== "string")) {
        throw new InvalidArgumentError("expectedUntrackPaths must be an array of paths.");
      }
      const expected = Array.from(new Set(req.expectedUntrackPaths)).sort();
      if (expected.length !== stop.paths.length || expected.some((p, i) => p !== stop.paths[i])) {
        throw new IgnorePlanChangedError(expected, stop.paths);
      }
    }

    // Preflight every file we will write before touching any (FR-500 order).
    const toWrite = Array.from(a.targets.values()).filter((tf) => !tf.refusal && a.rows.some((r) => r.targetAbs === tf.abs && r.report.outcome === "will-write"));
    for (const tf of toWrite) {
      if (!(await probeWritable(tf.abs))) {
        tf.refusal = new TargetRefusal("target-unwritable", "The ignore file's folder is not writable.");
        for (const r of a.rows) if (r.targetAbs === tf.abs && r.report.outcome === "will-write") refuse(r, "target-unwritable", tf.refusal.message);
      }
    }

    const written: WrittenFile[] = [];
    const rollbackAll = async (): Promise<WrittenFile[]> => {
      const left: WrittenFile[] = [];
      for (const w of written.reverse()) if (!(await rollbackFile(w))) left.push(w);
      return left;
    };
    for (const tf of toWrite) {
      if (tf.refusal) continue;
      const rules = Array.from(new Set(a.rows.filter((r) => r.targetAbs === tf.abs && r.report.outcome === "will-write").map((r) => r.report.rule!)));
      try {
        if (tf.isExclude) await fs.mkdir(path.dirname(tf.abs), { recursive: true }).catch((err) => { throw asIgnoreFsError(err, tf.display); });
        const recheckDir = async (): Promise<void> => {
          if (tf.isExclude) {
            const info = await fs.lstat(path.dirname(tf.abs)).catch(() => null);
            if (info && (info.isSymbolicLink() || !info.isDirectory())) throw new IgnoreWriteError(tf.display, "folder is now a symbolic link");
          } else if ((await symlinkedComponent(workdir, tf.targetDir)) !== null) {
            throw new IgnoreWriteError(tf.display, "a parent folder is now a symbolic link");
          }
        };
        const w = await updateRuleFile(tf.abs, tf.display, rules, recheckDir);
        if (w) written.push(w);
      } catch (err) {
        await rollbackAll();
        throw err;
      }
    }

    await afterWriteHook?.();

    // Untrack only rows that were not refused (e.g. an unwritable target); recompute the set if anything was refused late.
    let untrackPaths = stop ? stop.paths : [];
    if (stop && a.rows.some((r) => r.report.outcome === "refused" && r.report.reasonCode === "target-unwritable")) {
      const refreshed = await buildStopTracking(workdir, a);
      untrackPaths = refreshed.paths;
      stop.paths = refreshed.paths;
      stop.count = refreshed.count;
    }
    if (stop && untrackPaths.length > 0) {
      try {
        // update-index --force-remove is one atomic index write with no argv-length limit; same effect as `rm --cached` on exact files.
        await runGitWithInput(withFsmonitorNeutralized(["update-index", "--force-remove", "-z", "--stdin"]), { cwd: workdir }, untrackPaths.join("\0") + "\0");
      } catch (err) {
        const left = await rollbackAll();
        const msg = err instanceof GitCommandError ? err.message.split("\n")[0]! : err instanceof Error ? err.message : "unknown error";
        throw new IgnoreUntrackError(left.length === 0, left.map((w) => w.display), msg);
      }
    }

    // FR-497: honest result; a later `!` rule can leave the path unignored.
    const writtenOrIn = a.rows.filter((r) => r.report.outcome === "will-write" || r.report.outcome === "already-in");
    const after = await checkIgnore(workdir, writtenOrIn.map((r) => (r.isDir ? `${r.path}/` : r.path)));
    for (const r of writtenOrIn) {
      const m = after.get(r.isDir ? `${r.path}/` : r.path) ?? null;
      const wasWrite = r.report.outcome === "will-write";
      if (m && !m.negated) {
        r.report.outcome = wasWrite ? "written" : "already-in";
        delete r.report.ignoredBy;
      } else {
        r.report.outcome = "still-not-ignored";
        if (m) r.report.ignoredBy = { source: m.source, line: m.line, pattern: m.pattern };
        else delete r.report.ignoredBy;
      }
    }
    const files: IgnoreFileReport[] = [];
    for (const tf of a.targets.values()) {
      if (tf.refusal) continue;
      const mine = a.rows.filter((r) => r.targetAbs === tf.abs);
      const w = written.find((x) => x.abs === tf.abs);
      const rules = Array.from(new Set(mine.filter((r) => w && (r.report.outcome === "written" || r.report.outcome === "still-not-ignored") && r.report.rule).map((r) => r.report.rule!)));
      const present = Array.from(new Set(mine.filter((r) => r.report.outcome === "already-in").map((r) => r.report.rule!)));
      if (rules.length === 0 && present.length === 0) continue;
      files.push({ file: tf.display, created: !!w && w.before === null, rules, alreadyPresent: present, sharedWithOtherWorktrees: tf.isExclude && a.dirs.commonDir !== a.dirs.gitDir });
    }
    return { rows: a.rows.map((r) => r.report), files, stopTracking: stop, applied: true };
  });
}

/** FR-500: `ignorePaths` with `stopTracking` forced on. */
export function ignoreAndStopTracking(workdir: string, req: Omit<IgnoreRequest, "stopTracking">): Promise<IgnoreReport> {
  // Security review: an untrack without the confirmed plan could remove files the user never saw.
  if (!Array.isArray(req?.expectedUntrackPaths)) return Promise.reject(new InvalidArgumentError("Stop tracking needs the confirmed file list (expectedUntrackPaths) from the preview."));
  return ignorePaths(workdir, { ...req, stopTracking: true });
}
