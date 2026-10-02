// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from "node:crypto";
import { InvalidArgumentError } from "./errors";
import type { PartialStagingIneligibleReason } from "./types";

/**
 * Pure (no git, no fs) helpers for specs/hunk-line-staging.md FR-449/450/452. Raw diff bytes are handled
 * as latin1 strings: a 1:1 byte<->char mapping, so split/join on "\n" keeps CRLF and every other byte exact.
 */

export function fingerprintDiffBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const NO_NEWLINE_PREFIX = "\\ No newline at end of file";
const HUNK_START_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** FR-452: null when hunk/line operations apply, "empty" for a zero-byte diff. `text` is one git diff output. */
export function classifyRawDiff(text: string): PartialStagingIneligibleReason | "empty" | null {
  if (text.length === 0) return "empty";
  const lines = text.split("\n");
  const firstHunk = lines.findIndex((l) => l.startsWith("@@"));
  const header = firstHunk === -1 ? lines : lines.slice(0, firstHunk);

  if (header.some((l) => l.startsWith("diff --cc ") || l.startsWith("diff --combined ") || l.startsWith("* Unmerged path"))) {
    return "conflicted";
  }
  if (header.some((l) => l.startsWith("Binary files ") || l === "GIT binary patch")) return "binary";
  if (lines.some((l) => /^[-+ ]Subproject commit /.test(l))) return "submodule";
  if (header.filter((l) => l.startsWith("diff --git ")).length > 1) return "not-a-file";

  let oldMode: string | null = null;
  let newMode: string | null = null;
  for (const l of header) {
    let m: RegExpExecArray | null;
    if (l.startsWith("new file mode ")) return "added";
    if (l.startsWith("deleted file mode ")) return "deleted";
    if (/^(rename|copy) (from|to) /.test(l) || l.startsWith("similarity index ") || l.startsWith("dissimilarity index ")) {
      return "renamed";
    }
    if ((m = /^old mode (\d+)$/.exec(l))) oldMode = m[1]!;
    else if ((m = /^new mode (\d+)$/.exec(l))) newMode = m[1]!;
    else if ((m = /^index [0-9a-f]+\.\.[0-9a-f]+ (\d+)$/.exec(l))) {
      if (m[1] === "160000") return "submodule";
      if (m[1] === "120000") return "symlink";
    }
  }
  if (oldMode !== null || newMode !== null) {
    if (oldMode === "160000" || newMode === "160000") return "submodule";
    return oldMode?.slice(0, 3) !== newMode?.slice(0, 3) ? "type-change" : "mode-change";
  }
  return null;
}

export interface RawDiffItem {
  type: "context" | "add" | "remove";
  /** The whole line including its leading ' ', '+' or '-', without the trailing "\n". */
  text: string;
  /** The "\ No newline at end of file" marker line that followed this item, if any. */
  noNewline: string | null;
}

export interface RawDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Text after the closing "@@" (git's function-context hint), kept verbatim. */
  suffix: string;
  /** Same indexing as `parseUnifiedDiffHunks`' `DiffHunk.lines` (marker lines are not items). */
  items: RawDiffItem[];
}

export interface RawDiff {
  header: string[];
  hunks: RawDiffHunk[];
}

export function parseRawDiff(text: string): RawDiff {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const header: string[] = [];
  const hunks: RawDiffHunk[] = [];
  let current: RawDiffHunk | null = null;
  for (const line of lines) {
    const m = HUNK_START_RE.exec(line);
    if (m) {
      current = {
        oldStart: Number(m[1]),
        oldLines: m[2] !== undefined ? Number(m[2]) : 1,
        newStart: Number(m[3]),
        newLines: m[4] !== undefined ? Number(m[4]) : 1,
        suffix: m[5] ?? "",
        items: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current) {
      header.push(line);
      continue;
    }
    if (line.startsWith(NO_NEWLINE_PREFIX)) {
      const last = current.items[current.items.length - 1];
      if (last) last.noNewline = line;
      continue;
    }
    const marker = line[0];
    const type = marker === " " ? "context" : marker === "-" ? "remove" : marker === "+" ? "add" : null;
    if (!type) throw new InvalidArgumentError("Unexpected line inside a diff hunk; refusing to build a patch from it.");
    current.items.push({ type, text: line, noNewline: null });
  }
  return { header, hunks };
}

/** One entry per hunk to act on; omit `lineIndexes` for the whole hunk. Indexes are into `DiffHunk.lines`. */
export interface HunkSelection {
  hunkIndex: number;
  lineIndexes?: readonly number[];
}

/**
 * "forward" (stage): the patch is applied to the OLD side, so unselected '+' vanish and unselected '-'
 * stay as context. "reverse" (unstage/discard): applied backwards onto the NEW side, so unselected '+'
 * stay as context and unselected '-' vanish.
 */
export type PatchDirection = "forward" | "reverse";

/** FR-450: rebuild a patch from git's raw diff, containing only the selected changes, with recounted headers. */
export function buildPartialPatch(raw: RawDiff, selection: readonly HunkSelection[], direction: PatchDirection): Buffer {
  if (selection.length === 0) throw new InvalidArgumentError("Selection is empty.");
  const byHunk = new Map<number, HunkSelection>();
  for (const sel of selection) {
    if (!Number.isInteger(sel.hunkIndex) || sel.hunkIndex < 0 || sel.hunkIndex >= raw.hunks.length) {
      throw new InvalidArgumentError(`Hunk ${sel.hunkIndex} does not exist in this diff.`);
    }
    if (byHunk.has(sel.hunkIndex)) throw new InvalidArgumentError(`Hunk ${sel.hunkIndex} is selected twice.`);
    if (sel.lineIndexes !== undefined && sel.lineIndexes.length === 0) {
      throw new InvalidArgumentError(`Hunk ${sel.hunkIndex} has an empty line selection.`);
    }
    byHunk.set(sel.hunkIndex, sel);
  }

  const out: string[] = [...raw.header];
  let offset = 0; // cumulative (new - old) line delta of hunks already emitted

  for (let h = 0; h < raw.hunks.length; h++) {
    const sel = byHunk.get(h);
    if (!sel) continue;
    const hunk = raw.hunks[h]!;
    const chosen = sel.lineIndexes ? new Set<number>() : null;
    if (chosen && sel.lineIndexes) {
      for (const i of sel.lineIndexes) {
        const item = hunk.items[i];
        if (!Number.isInteger(i) || !item) throw new InvalidArgumentError(`Line ${i} does not exist in hunk ${h}.`);
        if (item.type === "context") throw new InvalidArgumentError(`Line ${i} of hunk ${h} is context, not a change.`);
        chosen.add(i);
      }
    }

    const kept: RawDiffItem[] = [];
    hunk.items.forEach((item, i) => {
      if (item.type === "context" || !chosen || chosen.has(i)) {
        kept.push(item);
      } else if (item.type === "remove" && direction === "forward") {
        kept.push({ type: "context", text: ` ${item.text.slice(1)}`, noNewline: item.noNewline });
      } else if (item.type === "add" && direction === "reverse") {
        kept.push({ type: "context", text: ` ${item.text.slice(1)}`, noNewline: item.noNewline });
      } // else: dropped
    });

    // A "no newline" marker is only coherent on the final line of each side it describes.
    kept.forEach((item, i) => {
      if (item.noNewline === null) return;
      const later = kept.slice(i + 1);
      const conflicts =
        item.type === "context"
          ? later.length > 0
          : later.some((l) => l.type === "context" || l.type === item.type);
      if (conflicts) {
        throw new InvalidArgumentError(
          `Hunk ${h}: this selection would separate a line from its "no newline at end of file" partner; select both lines.`,
        );
      }
    });

    const oldCount = kept.filter((i) => i.type !== "add").length;
    const newCount = kept.filter((i) => i.type !== "remove").length;
    if (!kept.some((i) => i.type !== "context")) continue;

    // A zero-length range is printed as the line BEFORE the insertion/deletion point.
    const origOldPos = hunk.oldLines === 0 ? hunk.oldStart + 1 : hunk.oldStart;
    const origNewPos = hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart;
    let oldStart: number;
    let newStart: number;
    if (direction === "forward") {
      oldStart = hunk.oldStart;
      const pos = origOldPos + offset;
      newStart = newCount === 0 ? pos - 1 : pos;
    } else {
      newStart = hunk.newStart;
      const pos = origNewPos - offset;
      oldStart = oldCount === 0 ? pos - 1 : pos;
    }
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${hunk.suffix}`);
    for (const item of kept) {
      out.push(item.text);
      if (item.noNewline !== null) out.push(item.noNewline);
    }
    offset += newCount - oldCount;
  }

  if (out.length === raw.header.length) throw new InvalidArgumentError("Selection contains no changes.");
  return Buffer.from(out.join("\n") + "\n", "latin1");
}
