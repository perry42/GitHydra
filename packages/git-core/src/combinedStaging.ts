// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import { runGit, runGitAllowingExitCodes, runGitBuffer, runGitBufferWithInput, runGitWithInput, SAFE_DIFF_FLAGS, runInMutationQueue, withFsmonitorNeutralized } from "./gitProcess";
import { DEFAULT_CONTEXT_LINES, DEFAULT_MAX_CHANGED_LINES, DEFAULT_MAX_FILE_SIZE_BYTES } from "./diff";
import { buildPartialPatch, classifyRawDiff, parseRawDiff, type HunkSelection, type RawDiff } from "./diffPatch";
import { GitCommandError, InvalidArgumentError, LinesNotDiscardableError, PartialStagingIneligibleError, StaleDiffError } from "./errors";
import { assertPathWithinWorkdir, resolveWithinWorkdir, isErrnoException } from "./pathSafety";
import { applyPatchBytes, type PartialStagingOptions } from "./partialStaging";
import type {
  CombinedDiffHunk,
  CombinedDiffLine,
  CombinedFileDiffResult,
  CombinedLineRef,
  PartialStagingIneligibleReason,
} from "./types";

/**
 * specs/hunk-line-staging.md FR-479..481: the combined (HEAD vs worktree) diff with a per-line staged flag.
 * State is derived only from git's own HEAD->index and index->worktree diffs (composed line-number maps),
 * then proven by re-applying the staged set to the HEAD blob and requiring byte equality with the index
 * blob. Anything not provable becomes `{ mode: "separate", reason }`; we never guess.
 */

const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true });
const HEX_OID_RE = /^[0-9a-f]{40,64}$/;

function isValidUtf8(bytes: Buffer): boolean {
  try {
    UTF8_STRICT.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------------------------------------
// Pure analysis (no git, no fs)
// ---------------------------------------------------------------------------------------------

interface Ref {
  hunk: number;
  idx: number;
}

function countLE(sorted: readonly number[], x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function countLT(sorted: readonly number[], x: number): number {
  return countLE(sorted, x - 1);
}

interface ItemNumbers {
  oldLine: number | null;
  newLine: number | null;
}

/**
 * A parsed one-file diff turned into old<->new line maps. Lines outside every hunk shift by the running
 * (added - removed) count, so no total line count is needed (worktree filters can change it).
 */
class SideDiff {
  readonly numbers: ItemNumbers[][] = [];
  readonly removedAt = new Map<number, Ref>();
  readonly addedAt = new Map<number, Ref>();
  private readonly addAnchors: number[] = []; // old-side position each add precedes
  private readonly removeAnchors: number[] = []; // new-side position each remove precedes
  private readonly removedOld: number[] = [];
  private readonly addedNew: number[] = [];

  constructor(readonly raw: RawDiff) {
    raw.hunks.forEach((hunk, h) => {
      // A zero-length range is printed as the line BEFORE the change, so the next line is start+1.
      let oldLine = hunk.oldLines === 0 ? hunk.oldStart + 1 : hunk.oldStart;
      let newLine = hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart;
      const rows: ItemNumbers[] = [];
      hunk.items.forEach((item, idx) => {
        if (item.type === "context") {
          rows.push({ oldLine, newLine });
          oldLine++;
          newLine++;
          return;
        }
        if (item.type === "remove") {
          rows.push({ oldLine, newLine: null });
          this.removedAt.set(oldLine, { hunk: h, idx });
          this.removedOld.push(oldLine);
          this.removeAnchors.push(newLine);
          oldLine++;
        } else {
          rows.push({ oldLine: null, newLine });
          this.addedAt.set(newLine, { hunk: h, idx });
          this.addedNew.push(newLine);
          this.addAnchors.push(oldLine);
          newLine++;
        }
      });
      this.numbers.push(rows);
    });
  }

  /** New-side line for an old-side line, or -1 when the diff removes it. */
  oldToNew(o: number): number {
    if (this.removedAt.has(o)) return -1;
    return o + countLE(this.addAnchors, o) - countLT(this.removedOld, o);
  }

  /** Old-side line for a new-side line, or -1 when the diff adds it. */
  newToOld(n: number): number {
    if (this.addedAt.has(n)) return -1;
    return n + countLE(this.removeAnchors, n) - countLT(this.addedNew, n);
  }
}

export interface ItemInfo {
  type: "add" | "remove";
  staged: boolean;
  discardable: boolean;
  /** Where this change lives in the single-side diff the operation must patch: HEAD->index when staged, index->worktree otherwise. */
  ref: Ref;
}

export type CombinedAnalysis =
  | { ok: false; reason: PartialStagingIneligibleReason }
  | {
      ok: true;
      hunks: CombinedDiffHunk[];
      items: Map<string, ItemInfo>;
      hi: RawDiff;
      iw: RawDiff;
    };

export const itemKey = (hunkIndex: number, lineIndex: number): string => `${hunkIndex}:${lineIndex}`;

function countLines(bytes: Buffer): number {
  if (bytes.length === 0) return 0;
  let n = 0;
  for (const b of bytes) if (b === 0x0a) n++;
  return bytes[bytes.length - 1] === 0x0a ? n : n + 1;
}

function splitKeepingEol(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (;;) {
    const nl = text.indexOf("\n", start);
    if (nl === -1) break;
    out.push(text.slice(start, nl + 1));
    start = nl + 1;
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/** Replays the staged subset of the combined diff onto the HEAD blob in memory; null when it is incoherent. */
function applyStagedToHead(headText: string, combined: RawDiff, staged: ReadonlySet<string>): string | null {
  const segs = splitKeepingEol(headText);
  const out: string[] = [];
  let ptr = 0;
  for (let h = 0; h < combined.hunks.length; h++) {
    const hunk = combined.hunks[h]!;
    const firstOld0 = (hunk.oldLines === 0 ? hunk.oldStart + 1 : hunk.oldStart) - 1;
    if (firstOld0 < ptr || firstOld0 > segs.length) return null;
    while (ptr < firstOld0) out.push(segs[ptr++]!);
    for (let i = 0; i < hunk.items.length; i++) {
      const item = hunk.items[i]!;
      if (item.type === "add") {
        if (staged.has(itemKey(h, i))) out.push(item.text.slice(1) + (item.noNewline === null ? "\n" : ""));
        continue;
      }
      const seg = segs[ptr];
      if (seg === undefined || seg.replace(/\n$/, "") !== item.text.slice(1)) return null;
      ptr++;
      if (item.type === "context" || !staged.has(itemKey(h, i))) out.push(seg);
    }
  }
  while (ptr < segs.length) out.push(segs[ptr++]!);
  return out.join("");
}

function separate(reason: PartialStagingIneligibleReason): CombinedAnalysis {
  return { ok: false, reason };
}

/**
 * Pure core of FR-479/481. Inputs are raw bytes: `combined` = `git diff HEAD`, `hi` = `git diff --cached`,
 * `iw` = `git diff`, all for one file at the same context size, plus the HEAD and index blobs.
 */
export function analyzeCombined(input: { combined: Buffer; hi: Buffer; iw: Buffer; head: Buffer; index: Buffer }): CombinedAnalysis {
  for (const buf of [input.combined, input.hi, input.iw]) {
    if (buf.length > DEFAULT_MAX_FILE_SIZE_BYTES) return separate("too-large");
    const text = buf.toString("latin1");
    const reason = classifyRawDiff(text);
    if (reason && reason !== "empty") return separate(reason);
    if (!isValidUtf8(buf)) return separate("non-utf8");
  }
  if (input.combined.length === 0) return separate("no-changes");

  let combinedRaw: RawDiff;
  let hiRaw: RawDiff;
  let iwRaw: RawDiff;
  try {
    combinedRaw = parseRawDiff(input.combined.toString("latin1"));
    hiRaw = parseRawDiff(input.hi.toString("latin1"));
    iwRaw = parseRawDiff(input.iw.toString("latin1"));
  } catch {
    return separate("ambiguous");
  }
  if (combinedRaw.hunks.length === 0) return separate("no-changes");
  const changed = combinedRaw.hunks.reduce((n, h) => n + h.items.filter((i) => i.type !== "context").length, 0);
  if (changed > DEFAULT_MAX_CHANGED_LINES) return separate("too-large");

  const hw = new SideDiff(combinedRaw);
  const hi = new SideDiff(hiRaw);
  const iw = new SideDiff(iwRaw);

  // A line only in the index (staged, then removed or re-edited in the worktree) is invisible in HEAD->worktree,
  // so the replay below cannot reproduce the index and the file falls back; that is how FR-478's "staged and
  // edited again is not discardable" is enforced.
  // The composition HEAD->index->worktree must pair exactly the lines the displayed HEAD->worktree diff
  // pairs; with repeated identical lines the two alignments can differ, and then nothing can be proven.
  const nHead = countLines(input.head);
  for (let h = 1; h <= nHead; h++) {
    const i = hi.oldToNew(h);
    const viaIndex = i === -1 ? -1 : iw.oldToNew(i);
    if (viaIndex !== hw.oldToNew(h)) return separate("ambiguous");
  }

  const items = new Map<string, ItemInfo>();
  const stagedKeys = new Set<string>();
  for (let h = 0; h < combinedRaw.hunks.length; h++) {
    const hunk = combinedRaw.hunks[h]!;
    for (let idx = 0; idx < hunk.items.length; idx++) {
      const item = hunk.items[idx]!;
      if (item.type === "context") continue;
      const n = hw.numbers[h]![idx]!;
      let info: ItemInfo;
      if (item.type === "add") {
        const w = n.newLine!;
        const i = iw.newToOld(w);
        if (i === -1) {
          const ref = iw.addedAt.get(w);
          if (!ref) return separate("ambiguous");
          info = { type: "add", staged: false, discardable: true, ref };
        } else {
          const ref = hi.addedAt.get(i);
          if (!ref) return separate("ambiguous");
          info = { type: "add", staged: true, discardable: false, ref };
        }
      } else {
        const hLine = n.oldLine!;
        const i = hi.oldToNew(hLine);
        if (i === -1) {
          const ref = hi.removedAt.get(hLine);
          if (!ref) return separate("ambiguous");
          info = { type: "remove", staged: true, discardable: false, ref };
        } else {
          const ref = iw.removedAt.get(i);
          if (!ref) return separate("ambiguous");
          info = { type: "remove", staged: false, discardable: true, ref };
        }
      }
      items.set(itemKey(h, idx), info);
      if (info.staged) stagedKeys.add(itemKey(h, idx));
    }
  }

  const replay = applyStagedToHead(input.head.toString("latin1"), combinedRaw, stagedKeys);
  if (replay === null || !Buffer.from(replay, "latin1").equals(input.index)) return separate("ambiguous");

  const dec = (s: string): string => Buffer.from(s, "latin1").toString("utf8");
  const hunks: CombinedDiffHunk[] = combinedRaw.hunks.map((hunk, h) => {
    let stagedCount = 0;
    let changedCount = 0;
    const lines: CombinedDiffLine[] = hunk.items.map((item, idx) => {
      const n = hw.numbers[h]![idx]!;
      const info = items.get(itemKey(h, idx));
      if (info) {
        changedCount++;
        if (info.staged) stagedCount++;
      }
      return {
        type: item.type,
        content: dec(item.text.slice(1)),
        oldLineNumber: n.oldLine,
        newLineNumber: n.newLine,
        staged: info?.staged ?? false,
        discardable: info?.discardable ?? false,
      };
    });
    return {
      header: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@${dec(hunk.suffix)}`,
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      lines,
      stagedState: stagedCount === 0 ? "none" : stagedCount === changedCount ? "all" : "some",
    };
  });
  return { ok: true, hunks, items, hi: hiRaw, iw: iwRaw };
}

// ---------------------------------------------------------------------------------------------
// Git / filesystem reads
// ---------------------------------------------------------------------------------------------

/** --no-optional-locks: a read must not refresh and rewrite the index behind a concurrent writer (FR-456). */
function readArgs(args: string[]): string[] {
  return ["--no-optional-locks", ...withFsmonitorNeutralized(args)];
}

function diffArgs(kind: "combined" | "hi" | "iw", filePath: string, contextLines: number): string[] {
  return readArgs([
    "-c",
    "diff.suppressBlankEmpty=false",
    "diff",
    "--no-color",
    ...SAFE_DIFF_FLAGS,
    "--no-renames",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    `-U${contextLines}`,
    ...(kind === "hi" ? ["--cached"] : kind === "combined" ? ["HEAD"] : []),
    "--",
    filePath,
  ]);
}

interface Inputs {
  headOid: string;
  indexOid: string;
  worktreeHash: string;
}

/** `changed`: the inputs moved while being read, so nothing read so far can be trusted. */
type InputsResult = ({ ok: true } & Inputs) | { ok: false; reason: PartialStagingIneligibleReason } | { ok: false; changed: true };

export type WorktreeRead = { kind: "ok"; bytes: Buffer } | { kind: "reason"; reason: PartialStagingIneligibleReason };

/**
 * Reads the worktree file through one handle: fstat it, refuse above the size guard, read at most guard+1 bytes
 * (a file that grows after the check still cannot be buffered whole). O_NOFOLLOW makes a symlink swapped in after
 * the lstat fail with ELOOP instead of being followed; Windows has no O_NOFOLLOW, so there the lstat above and
 * the ino identity check of the opened handle are the only defence (accepted: FR-479 only reads and hashes).
 */
export async function readWorktreeBounded(abs: string, maxBytes: number = DEFAULT_MAX_FILE_SIZE_BYTES): Promise<WorktreeRead> {
  let st;
  try {
    st = await fs.lstat(abs);
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") return { kind: "reason", reason: "deleted" };
    throw err;
  }
  if (st.isSymbolicLink()) return { kind: "reason", reason: "symlink" };
  if (!st.isFile()) return { kind: "reason", reason: "not-a-file" };

  let fh;
  try {
    fh = await fs.open(abs, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") return { kind: "reason", reason: "deleted" };
    if (isErrnoException(err) && err.code === "ELOOP") return { kind: "reason", reason: "symlink" };
    throw err;
  }
  try {
    const hst = await fh.stat();
    if (!hst.isFile()) return { kind: "reason", reason: "not-a-file" };
    if (st.ino !== 0 && hst.ino !== 0 && (st.ino !== hst.ino || (process.platform !== "win32" && st.dev !== hst.dev))) {
      return { kind: "reason", reason: "not-a-file" }; // swapped between lstat and open
    }
    if (hst.size > maxBytes) return { kind: "reason", reason: "too-large" };
    const buf = Buffer.alloc(Math.min(hst.size, maxBytes) + 1);
    let total = 0;
    while (total < buf.length) {
      const { bytesRead } = await fh.read(buf, total, buf.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > maxBytes) return { kind: "reason", reason: "too-large" };
    return { kind: "ok", bytes: buf.subarray(0, total) };
  } finally {
    await fh.close();
  }
}

function worktreeRead(workdir: string, filePath: string): Promise<WorktreeRead | { error: unknown }> {
  return readWorktreeBounded(resolveWithinWorkdir(workdir, filePath)).catch((error: unknown) => ({ error }));
}

/** `cat-file --batch-check` output -> oid and size per requested name; null if any line is not a present object. */
function parseBatchCheck(stdout: string): { oid: string; size: number }[] | null {
  const out: { oid: string; size: number }[] = [];
  for (const l of stdout.split("\n")) {
    if (l === "") continue;
    const m = /^([0-9a-f]{40,64}) \w+ (\d+)$/.exec(l);
    if (!m) return null;
    out.push({ oid: m[1]!, size: Number(m[2]) });
  }
  return out;
}

/** Object names relative to the cwd (`./`), so a subdirectory workdir resolves the same way as the `--` pathspecs. */
function objectNames(filePath: string): { head: string; index: string } {
  const p = process.platform === "win32" ? filePath.split("\\").join("/") : filePath;
  return { head: `HEAD:./${p}`, index: `:0:./${p}` };
}

async function readInputs(workdir: string, filePath: string): Promise<InputsResult> {
  const names = objectNames(filePath);
  const nameSafe = !/[\r\n]/.test(filePath);
  // One round: the index entry, the HEAD entry, both blob sizes and the worktree bytes are independent reads.
  const sizesByName: Promise<string | null> = nameSafe
    ? runGitWithInput(readArgs(["cat-file", "--batch-check"]), { cwd: workdir }, `${names.head}\n${names.index}\n`).then(
        (r) => r.stdout,
        () => null,
      )
    : Promise.resolve(null);
  const lsTree = runGit(readArgs(["ls-tree", "-z", "HEAD", "--", filePath]), { cwd: workdir }).then(
    (r) => ({ stdout: r.stdout }),
    (err: unknown) => ({ err }),
  );
  const wt = worktreeRead(workdir, filePath);
  const { stdout: staged } = await runGit(readArgs(["ls-files", "--stage", "-z", "--", filePath]), { cwd: workdir });
  const entries = staged.split("\0").filter((e) => e !== "");
  const parsed = entries.map((e) => /^(\d+) ([0-9a-f]+) (\d)\t([\s\S]*)$/.exec(e));
  if (parsed.some((p) => p === null)) return { ok: false, reason: "not-a-file" };

  const tree = await lsTree;
  if ("err" in tree) {
    const err = tree.err;
    if (!(err instanceof GitCommandError)) throw err;
    const probe = await runGitAllowingExitCodes(["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: workdir }, [0, 1]);
    if (probe.exitCode === 0) throw err;
    return { ok: false, reason: entries.length === 0 ? "untracked" : "added" }; // unborn HEAD
  }
  const headEntry = /^(\d+) (\w+) ([0-9a-f]+)\t/.exec(tree.stdout.split("\0")[0] ?? "");

  if (entries.length === 0) return { ok: false, reason: headEntry ? "deleted" : "untracked" };
  if (entries.length > 1) {
    return { ok: false, reason: parsed.some((p) => p![3] !== "0") ? "conflicted" : "not-a-file" };
  }
  const [, indexMode, indexOid, stage] = parsed[0]!;
  if (stage !== "0") return { ok: false, reason: "conflicted" };
  if (indexMode === "160000") return { ok: false, reason: "submodule" };
  if (indexMode === "120000") return { ok: false, reason: "symlink" };
  if (!headEntry) return { ok: false, reason: "added" };
  if (headEntry[1] === "160000" || headEntry[2] === "commit") return { ok: false, reason: "submodule" };
  if (headEntry[1] === "120000") return { ok: false, reason: "symlink" };
  if (headEntry[1] !== indexMode) return { ok: false, reason: "mode-change" };
  const headOid = headEntry[3]!;
  if (!HEX_OID_RE.test(headOid) || !HEX_OID_RE.test(indexOid!)) return { ok: false, reason: "not-a-file" };

  const wtResult = await wt;
  if ("error" in wtResult) throw wtResult.error;
  if (wtResult.kind === "reason") return { ok: false, reason: wtResult.reason };

  // Sizes: by name in the parallel round; if that was unavailable or disagrees with the entries above
  // (odd path, or the index/HEAD moved), ask by oid so the guard is always about the oids we will read.
  let sizes = parseBatchCheck((await sizesByName) ?? "");
  if (!sizes || sizes.length !== 2 || sizes[0]!.oid !== headOid || sizes[1]!.oid !== indexOid) {
    const r = await runGitWithInput(readArgs(["cat-file", "--batch-check"]), { cwd: workdir }, `${headOid}\n${indexOid}\n`);
    sizes = parseBatchCheck(r.stdout);
    if (!sizes || sizes.length !== 2) return { ok: false, changed: true };
  }
  if (sizes[0]!.size > DEFAULT_MAX_FILE_SIZE_BYTES || sizes[1]!.size > DEFAULT_MAX_FILE_SIZE_BYTES) return { ok: false, reason: "too-large" };

  return { ok: true, headOid, indexOid: indexOid!, worktreeHash: sha256(wtResult.bytes) };
}

/**
 * The cheap "after" half of the before/after bracket: HEAD blob oid and index blob oid (one `rev-parse`) plus the
 * worktree hash. These are exactly the fields the fingerprint covers, so a change to any of them mid-read is detected.
 */
async function readInputsAfter(workdir: string, filePath: string): Promise<Inputs | null> {
  const names = objectNames(filePath);
  const wt = worktreeRead(workdir, filePath);
  let oids: string[];
  try {
    const r = await runGit(readArgs(["rev-parse", names.head, names.index]), { cwd: workdir });
    oids = r.stdout.split("\n").filter((l) => l !== "");
  } catch (err) {
    if (err instanceof GitCommandError) return null;
    throw err;
  }
  const w = await wt;
  if ("error" in w) throw w.error;
  if (w.kind !== "ok" || oids.length !== 2) return null;
  return { headOid: oids[0]!, indexOid: oids[1]!, worktreeHash: sha256(w.bytes) };
}

/** One `cat-file --batch` for both blobs; each header oid must be the one requested, else the inputs moved. */
async function readBlobs(workdir: string, headOid: string, indexOid: string): Promise<{ head: Buffer; index: Buffer } | null> {
  const { stdout } = await runGitBufferWithInput(readArgs(["cat-file", "--batch"]), { cwd: workdir }, `${headOid}\n${indexOid}\n`);
  const out: Buffer[] = [];
  let pos = 0;
  for (const want of [headOid, indexOid]) {
    const nl = stdout.indexOf(0x0a, pos);
    if (nl === -1) return null;
    const m = /^([0-9a-f]{40,64}) \w+ (\d+)$/.exec(stdout.toString("latin1", pos, nl));
    if (!m || m[1] !== want) return null;
    const start = nl + 1;
    const end = start + Number(m[2]);
    if (end > stdout.length) return null;
    out.push(stdout.subarray(start, end));
    pos = end + 1;
  }
  return { head: out[0]!, index: out[1]! };
}

let midReadHook: (() => Promise<void>) | null = null;

/** Test-only: runs after the diffs are read and before the "after" bracket, to simulate a write mid-read. */
export function _setCombinedMidReadHookForTests(hook: (() => Promise<void>) | null): void {
  midReadHook = hook;
}

function fingerprintOf(i: Inputs, contextLines: number): string {
  return sha256(Buffer.from(`githydra-combined-v1\0${i.headOid}\0${i.indexOid}\0${i.worktreeHash}\0${contextLines}`));
}

const sameInputs = (a: Inputs, b: Inputs): boolean =>
  a.headOid === b.headOid && a.indexOid === b.indexOid && a.worktreeHash === b.worktreeHash;

type Snapshot = { kind: "unstable" } | { kind: "analyzed"; fingerprint: string; analysis: CombinedAnalysis } | { kind: "inputs"; reason: PartialStagingIneligibleReason };

/**
 * Reads the inputs, the diffs and the blobs, bracketed by a before/after comparison of (HEAD oid, index oid,
 * worktree hash) so the fingerprint always describes the diffs. Reads retry up to 3 times; a mutation passes
 * `attempts = 1` (an unstable file is reported as stale instead of holding the mutation queue).
 */
async function readSnapshot(workdir: string, filePath: string, contextLines: number, expected?: string, attempts = 3): Promise<Snapshot> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const before = await readInputs(workdir, filePath);
    if ("changed" in before) continue;
    if (!before.ok) return { kind: "inputs", reason: before.reason };
    const fingerprint = fingerprintOf(before, contextLines);
    if (expected !== undefined && fingerprint !== expected) throw new StaleDiffError(filePath);

    const run = (args: string[]): Promise<Buffer> => runGitBuffer(args, { cwd: workdir }).then((r) => r.stdout);
    const [combined, hi, iw, blobs] = await Promise.all([
      run(diffArgs("combined", filePath, contextLines)),
      run(diffArgs("hi", filePath, contextLines)),
      run(diffArgs("iw", filePath, contextLines)),
      readBlobs(workdir, before.headOid, before.indexOid),
    ]);

    if (midReadHook) await midReadHook();
    const after = await readInputsAfter(workdir, filePath);
    if (!blobs || !after || !sameInputs(before, after)) continue;
    return { kind: "analyzed", fingerprint, analysis: analyzeCombined({ combined, hi, iw, head: blobs.head, index: blobs.index }) };
  }
  return { kind: "unstable" };
}

function resolveContext(options: PartialStagingOptions): number {
  const contextLines = options.contextLines ?? DEFAULT_CONTEXT_LINES;
  if (!Number.isInteger(contextLines) || contextLines < 0) throw new InvalidArgumentError("contextLines must be a non-negative integer.");
  return contextLines;
}

/** FR-479: HEAD-vs-worktree hunks with per-line staged state, or `{ mode: "separate" }` (FR-481). Read-only. */
export async function getCombinedFileDiff(
  workdir: string,
  filePath: string,
  options: PartialStagingOptions = {},
): Promise<CombinedFileDiffResult> {
  assertPathWithinWorkdir(workdir, filePath);
  const contextLines = resolveContext(options);
  const snap = await readSnapshot(workdir, filePath, contextLines);
  if (snap.kind === "unstable") return { mode: "separate", reason: "ambiguous" };
  if (snap.kind === "inputs") return { mode: "separate", reason: snap.reason };
  if (!snap.analysis.ok) return { mode: "separate", reason: snap.analysis.reason };
  return { mode: "combined", hunks: snap.analysis.hunks, fingerprint: snap.fingerprint };
}

type OkAnalysis = Extract<CombinedAnalysis, { ok: true }>;

function validateRefs(lines: readonly CombinedLineRef[]): void {
  if (!Array.isArray(lines) || lines.length === 0) throw new InvalidArgumentError("Selection is empty.");
}

async function withSnapshot<T>(
  workdir: string,
  filePath: string,
  fingerprint: string,
  options: PartialStagingOptions,
  fn: (analysis: OkAnalysis, contextLines: number) => Promise<T>,
): Promise<T> {
  assertPathWithinWorkdir(workdir, filePath);
  if (typeof fingerprint !== "string" || fingerprint.length === 0) throw new InvalidArgumentError("A diff fingerprint is required.");
  const contextLines = resolveContext(options);
  // Inner git calls omit `mutatesRepository`: we already hold the queue, and the stale check + apply must be one entry.
  // One snapshot attempt only: an unstable file throws StaleDiffError instead of retrying while holding the queue.
  return runInMutationQueue(async () => {
    const snap = await readSnapshot(workdir, filePath, contextLines, fingerprint, 1);
    if (snap.kind === "unstable") throw new StaleDiffError(filePath);
    if (snap.kind === "inputs") throw new PartialStagingIneligibleError(filePath, snap.reason);
    if (!snap.analysis.ok) throw new PartialStagingIneligibleError(filePath, snap.analysis.reason);
    return fn(snap.analysis, contextLines);
  });
}

function resolveItems(analysis: OkAnalysis, lines: readonly CombinedLineRef[]): { ref: CombinedLineRef; info: ItemInfo }[] {
  const seen = new Set<string>();
  return lines.map((ref) => {
    const key = itemKey(ref.hunkIndex, ref.lineIndex);
    const info = analysis.items.get(key);
    if (!info) throw new InvalidArgumentError(`Line ${ref.lineIndex} of hunk ${ref.hunkIndex} is not a changed line of this diff.`);
    if (seen.has(key)) throw new InvalidArgumentError(`Line ${ref.lineIndex} of hunk ${ref.hunkIndex} is selected twice.`);
    seen.add(key);
    return { ref, info };
  });
}

function toSelection(infos: readonly ItemInfo[]): HunkSelection[] {
  const byHunk = new Map<number, number[]>();
  for (const { ref } of infos) {
    const list = byHunk.get(ref.hunk) ?? [];
    list.push(ref.idx);
    byHunk.set(ref.hunk, list);
  }
  return [...byHunk.entries()].map(([hunkIndex, lineIndexes]) => ({ hunkIndex, lineIndexes }));
}

/**
 * FR-480: put the given combined-diff lines into the index (`stage`) or take them out (`unstage`) as ONE
 * `git apply`. Lines already in the target state are skipped; if none remain nothing is applied.
 */
export async function toggleCombinedLines(
  workdir: string,
  filePath: string,
  fingerprint: string,
  lines: readonly CombinedLineRef[],
  target: "stage" | "unstage",
  options: PartialStagingOptions = {},
): Promise<void> {
  if (target !== "stage" && target !== "unstage") throw new InvalidArgumentError('target must be "stage" or "unstage".');
  validateRefs(lines);
  return withSnapshot(workdir, filePath, fingerprint, options, async (analysis, contextLines) => {
    const wanted = resolveItems(analysis, lines)
      .map((r) => r.info)
      .filter((info) => info.staged === (target === "unstage"));
    if (wanted.length === 0) return;
    const selection = toSelection(wanted);
    if (target === "stage") {
      // Staging applies index->worktree changes forward onto the index.
      await applyPatchBytes(workdir, "stage", "forward", contextLines, buildPartialPatch(analysis.iw, selection, "forward"));
    } else {
      await applyPatchBytes(workdir, "unstage", "reverse", contextLines, buildPartialPatch(analysis.hi, selection, "reverse"));
    }
  });
}

/**
 * FR-478: discard unstaged lines from the worktree only (`git apply --reverse`, index untouched). Refuses with
 * `LinesNotDiscardableError`, changing nothing, if any line is staged or a re-edit of a staged line.
 */
export async function discardCombinedLines(
  workdir: string,
  filePath: string,
  fingerprint: string,
  lines: readonly CombinedLineRef[],
  options: PartialStagingOptions = {},
): Promise<void> {
  validateRefs(lines);
  return withSnapshot(workdir, filePath, fingerprint, options, async (analysis, contextLines) => {
    const resolved = resolveItems(analysis, lines);
    const bad = resolved.filter((r) => !r.info.discardable).map((r) => r.ref);
    if (bad.length > 0) throw new LinesNotDiscardableError(filePath, bad);
    const selection = toSelection(resolved.map((r) => r.info));
    // Accepted residual (FR-478/480): plain `git apply --reverse` takes no lock, so an external write to this file in
    // the tiny window between the re-read above and the apply can shift where the lines land; context must still match.
    await applyPatchBytes(workdir, "discard", "reverse", contextLines, buildPartialPatch(analysis.iw, selection, "reverse"));
  });
}
