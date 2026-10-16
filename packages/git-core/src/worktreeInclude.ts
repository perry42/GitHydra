// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { enumerateIgnored, resolveSourceWorktree, type IgnoredCandidate, type ListFailureReason, type ListIgnoredOptions } from "./worktreeCopy";
import { errCode, readFlags, realCopyFs, sameFileIdentity, noFollowFlag, type CopyFs } from "./worktreeCopyFs";
import { wrapGit } from "./worktreeRunner";

/**
 * Reading `.worktreeinclude` (specs/worktree-copy-ignored.md FR-631). The file is repo-controlled: read once without
 * following links, capped while reading, copied to a private temp file and handed to git by THAT path. Matching is git's, as
 * the intersection of two `-i` listings, so the file can only narrow the set of ignored files that already exist.
 */

export const INCLUDE_MAX_BYTES = 64 * 1024;
export const INCLUDE_MAX_LINES = 1000;
export const INCLUDE_FILE_NAME = ".worktreeinclude";

export type IncludeRefusal = "symlink" | "not-regular-file" | "too-large" | "too-many-lines" | "unreadable";
export type SkippedPatternReason = "parent-directory-segment" | "absolute-path" | "invalid-character";

export interface SkippedPattern {
  line: number;
  /** Untrusted text, cut to 200 characters; render as text only. */
  pattern: string;
  reason: SkippedPatternReason;
}

export type IncludeResult =
  | { status: "absent" }
  | { status: "refused"; reason: IncludeRefusal }
  | { status: "failed"; reason: ListFailureReason }
  | {
      status: "ok";
      /** Ignored files the include file names (intersection), as git reports them. */
      matchedFiles: string[];
      /** Candidate rows to show as `in .worktreeinclude`: a file row that matched, or a directory row ALL of whose files matched. */
      matchedRows: string[];
      skipped: SkippedPattern[];
    };

export interface ReadIncludeOptions extends ListIgnoredOptions {
  fs?: CopyFs;
  /** Rows from `listIgnoredCandidates`; without them `matchedRows` is the file list. */
  candidates?: readonly IgnoredCandidate[];
  maxBytes?: number;
  maxLines?: number;
  platform?: string;
}

/** Hygiene for ONE pattern line (not a path check): the real containment is the intersection with git's own listing. */
export function classifyIncludePattern(line: string): SkippedPatternReason | null {
  if (line.includes("\0")) return "invalid-character";
  const body = line.startsWith("!") ? line.slice(1) : line;
  if (/^[A-Za-z]:[\\/]/.test(body) || body.startsWith("\\\\") || body.startsWith("//")) return "absolute-path";
  if (body.split(/[\\/]/).includes("..")) return "parent-directory-segment";
  return null;
}

async function readCapped(file: string, rootReal: string, o: Required<Pick<ReadIncludeOptions, "maxBytes" | "maxLines">> & { fs: CopyFs; platform: string }): Promise<{ text: string } | { refused: IncludeRefusal } | "absent"> {
  let lst;
  try {
    lst = await o.fs.lstat(file);
  } catch (err) {
    return errCode(err) === "ENOENT" || errCode(err) === "ENOTDIR" ? "absent" : { refused: "unreadable" };
  }
  if (lst.isSymbolicLink()) return { refused: "symlink" };
  if (!lst.isFile()) return { refused: "not-regular-file" };
  if (lst.size > BigInt(o.maxBytes)) return { refused: "too-large" };
  let handle;
  try {
    handle = await o.fs.open(file, readFlags());
  } catch (err) {
    return { refused: errCode(err) === "ELOOP" ? "symlink" : "unreadable" };
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) return { refused: "not-regular-file" };
    if (!sameFileIdentity(lst, st)) return { refused: "unreadable" };
    // Where no-follow is a no-op (Windows) the realpath must still be the file inside the source root.
    if (noFollowFlag() === 0 || o.platform === "win32") {
      const real = await o.fs.realpath(file).catch(() => null);
      const want = path.join(rootReal, INCLUDE_FILE_NAME);
      const fold = (p: string): string => (o.platform === "win32" ? p.toLowerCase() : p);
      if (real === null || fold(real) !== fold(want)) return { refused: "symlink" };
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let lines = 0;
    for (;;) {
      const buf = Buffer.alloc(8192);
      const { bytesRead } = await handle.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > o.maxBytes) return { refused: "too-large" };
      for (let i = 0; i < bytesRead; i++) if (buf[i] === 0x0a) lines++;
      if (lines > o.maxLines) return { refused: "too-many-lines" };
      chunks.push(buf.subarray(0, bytesRead));
    }
    const text = new TextDecoder("utf-8").decode(Buffer.concat(chunks));
    const lineCount = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    if (lineCount > o.maxLines) return { refused: "too-many-lines" };
    return { text };
  } catch {
    return { refused: "unreadable" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** `a/b/c` gives `a/`, `a/b/`. */
function ancestorDirs(p: string): string[] {
  const out: string[] = [];
  for (let i = p.indexOf("/"); i >= 0; i = p.indexOf("/", i + 1)) out.push(p.slice(0, i + 1));
  return out;
}

/** Splits, drops rejected patterns (reported) and returns the validated content git will read. Exported for tests. */
export function sanitizeIncludeText(rawText: string): { content: string; skipped: SkippedPattern[] } {
  const text = rawText.charCodeAt(0) === 0xfeff ? rawText.slice(1) : rawText;
  const skipped: SkippedPattern[] = [];
  const kept: string[] = [];
  text.split("\n").forEach((rawLine, i) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.trim() === "" || line.startsWith("#")) {
      kept.push(line);
      return;
    }
    const reason = classifyIncludePattern(line);
    if (reason) skipped.push({ line: i + 1, pattern: line.slice(0, 200), reason });
    else kept.push(line);
  });
  return { content: `${kept.join("\n")}\n`, skipped };
}

export function readWorktreeInclude(repoPath: string, sourceWorktreePath: string, opts: ReadIncludeOptions = {}): Promise<IncludeResult> {
  return wrapGit("list-ignored", async () => {
    const src = await resolveSourceWorktree(repoPath, sourceWorktreePath);
    if ("failed" in src) return { status: "failed", reason: src.failed };
    if (src.bare) return { status: "absent" };
    const read = await readCapped(path.join(src.root, INCLUDE_FILE_NAME), src.root, {
      fs: opts.fs ?? realCopyFs,
      maxBytes: opts.maxBytes ?? INCLUDE_MAX_BYTES,
      maxLines: opts.maxLines ?? INCLUDE_MAX_LINES,
      platform: opts.platform ?? process.platform,
    });
    if (read === "absent") return { status: "absent" };
    if ("refused" in read) return { status: "refused", reason: read.refused };
    const { content, skipped } = sanitizeIncludeText(read.text);

    // 0700 directory from mkdtemp, 0600 file created exclusively; removed in the finally.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "githydra-include-"));
    try {
      const tmp = path.join(dir, "include");
      await fs.writeFile(tmp, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      let all = await enumerateIgnored(src.root, ["--exclude-standard", "-z"], opts);
      const named = await enumerateIgnored(src.root, ["-X", tmp, "-z"], opts);
      if (named.status === "failed") return { status: "failed", reason: named.reason };
      let covers: (p: string) => boolean;
      if (all.status === "ok") {
        const set = new Set(all.paths);
        covers = (p) => set.has(p);
      } else if (all.reason === "too-many-files") {
        // A huge ignored tree (node_modules) overflows the file-level listing; the collapsed form lists the same ignored set.
        all = await enumerateIgnored(src.root, ["--exclude-standard", "-z", "--directory"], opts);
        if (all.status === "failed") return { status: "failed", reason: all.reason };
        const rowSet = new Set(all.paths);
        covers = (p) => rowSet.has(p) || ancestorDirs(p).some((d) => rowSet.has(d));
      } else {
        return { status: "failed", reason: all.reason };
      }
      const matchedFiles = named.paths.filter(covers);
      const matched = new Set(matchedFiles);
      let matchedRows = matchedFiles;
      if (opts.candidates) {
        // One pass over the matches, counting per ancestor directory (not rows x files).
        const underDir = new Map<string, number>();
        for (const f of matchedFiles) for (const d of ancestorDirs(f)) underDir.set(d, (underDir.get(d) ?? 0) + 1);
        matchedRows = opts.candidates
          .filter((c) => {
            if (!c.isDirectory) return matched.has(c.path);
            if (!c.sizeComputed || c.fileCount === null || c.fileCount === 0) return false;
            return (underDir.get(c.path) ?? 0) === c.fileCount;
          })
          .map((c) => c.path);
      }
      return { status: "ok", matchedFiles, matchedRows, skipped };
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}
