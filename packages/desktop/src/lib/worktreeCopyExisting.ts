// SPDX-License-Identifier: GPL-3.0-or-later
import { COPY_MAX_BYTES, COPY_MAX_FILES, escapeDisplayName, formatCopySize, type WorktreeEntry, type WorktreeList } from "@githydra/git-core";
import type { WorktreeExistingCopyResult, WorktreeExistingRow } from "../../shared/ipcContract";
import { looksLikeSamePath } from "../../shared/pathEquivalence";
import type { BannerTone } from "../components/StatusBanner/BannerIcon";
import type { NoticePart } from "./worktreeNotices";
import { visibleText } from "./worktrees";

/**
 * specs/worktree-copy-ignored.md section G (FR-649..657): the strings and the pure rules of "Copy ignored files here...". Names that
 * come from main are already escaped (`U+XXXX`) and truncated; they are shown as text, never re-derived from the renderer's own list.
 */

export const COPY_HERE_LABEL = "Copy ignored files here...";
export const COPY_PALETTE_LABEL = "Copy ignored files into worktree...";

// FR-650: exact disabled reasons.
export const REASON_SOURCE = "This is the source worktree";
export const REASON_LOCKED = "Locked: unlock it first";
export const REASON_MISSING = "The folder is missing";
export const REASON_UNSAFE_LIST = "This worktree list could not be read safely";
export const REASON_BARE = "This is a bare repository: there is nothing to copy.";
// FR-656
export const REASON_NO_OTHER = "No other worktree to copy into";

// FR-651
export const DIALOG_TITLE = "Copy ignored files";
export const NOTHING_TO_COPY = "No ignored files to copy in this repository.";
export const LIST_FAILED = "Couldn't list ignored files.";
export const CHECKING = "Checking for ignored files...";
export const NONE_SELECTED = "No ignored files will be copied.";
export const OVER_LIMIT = "Over the limit of 5,000 files or 200 MB. Untick something.";
/** FR-652: shown when the ignore check could not answer; names come from main. */
export const ignoreCheckUnknownLine = (dest: string): string => `Could not check whether ${dest} ignores these files.`;
export const SECRET_NOT_IGNORED_SENTENCE = (dest: string): string => `${dest} does not ignore this file; it could be committed by accident.`;
export const copyIntro = (dest: string): string => `Tick the ignored files you want copied. Files that already exist in ${dest} are never overwritten.`;
/** M1: every key event is ignored for this long after the dialog opens (a held Enter from the menu that opened it). */
export const KEY_GUARD_MS = 400;

const filesOf = (n: number): string => (n === 1 ? "1 file" : `${n} files`);
export { filesOf as filesLabel };

/** Display-safe text for a string main already escaped (idempotent; never trusts the shape blindly). */
export const shown = (s: string): string => escapeDisplayName(s);

/** Last path segment, for the folder-name side of the sentence before main has answered (palette picker). */
export function folderName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() || trimmed;
}

export interface CopyIntoContext {
  /** The worktree of the ACTIVE tab (FR-650), or null when it cannot be told. */
  source: WorktreeEntry | null;
  list: WorktreeList;
}

/** The entry that is the active tab's worktree: matched by spelled path (the tab path is git-resolved, FR-611). */
export function findSourceEntry(list: WorktreeList | null, activePath: string | null): WorktreeEntry | null {
  if (!list || !activePath) return null;
  return list.entries.find((e) => !e.isBare && looksLikeSamePath(e.path, activePath)) ?? null;
}

/**
 * FR-650: why this destination is refused up front (null = allowed). "No ignored files" is NOT a reason: it is known only after
 * the asynchronous listing, so the dialog says it.
 */
export function copyIntoReason(entry: WorktreeEntry, ctx: CopyIntoContext): string | null {
  if (ctx.list.entries.some((e) => e.isBare) || entry.isBare) return REASON_BARE;
  if (ctx.source && sameEntry(ctx.source, entry)) return REASON_SOURCE;
  if (entry.locked) return REASON_LOCKED;
  if (entry.prunable) return REASON_MISSING;
  if (!entry.supported || ctx.list.untrusted) return REASON_UNSAFE_LIST;
  return null;
}

const sameEntry = (a: WorktreeEntry, b: WorktreeEntry): boolean => a.id === b.id;

/** FR-656: why the palette entry cannot run (null = it can). The source is never a candidate, so it is not counted. */
export function paletteCopyIntoReason(list: WorktreeList | null, source: WorktreeEntry | null): string | null {
  if (!list) return REASON_NO_OTHER;
  if (list.entries.some((e) => e.isBare)) return REASON_BARE;
  const others = list.entries.filter((e) => !e.isBare && !(source && sameEntry(source, e)));
  return others.length === 0 ? REASON_NO_OTHER : null;
}

/** The picker sub line (FR-656): `<branch> · <path>`, or `detached at <short sha>` in place of the branch. */
export function pickerSubLine(entry: WorktreeEntry): string {
  const where = entry.branch ? visibleText(entry.branch) : `detached at ${visibleText(entry.shortHead ?? entry.head?.slice(0, 7) ?? "")}`.trim();
  return `${where} · ${visibleText(entry.path)}`;
}

// --- rows ---

export const sizeLabel = (bytes: number): string => formatCopySize(bytes);

/** A row that can be ticked at all. */
export const rowEnabled = (r: WorktreeExistingRow): boolean => r.disabledReason === null;

/** FR-654 (M2): never pre-ticked from memory in this dialog. Unknown (null) counts as not ignored (FR-652), so the check failing fails closed. */
export const rowWithheldFromPreTick = (r: WorktreeExistingRow): boolean => r.runsCode || (r.secret && r.notIgnoredInDestination !== false);

/** FR-652: at least one row could not be checked against the destination's ignore rules. */
export const ignoreCheckUnknown = (rows: readonly WorktreeExistingRow[]): boolean => rows.some((r) => r.notIgnoredInDestination === null);

/** Rows whose Enter must not press Copy (M1): any ticked secret, runs-code or not-ignored row. */
export const rowNeedsExplicitCopy = (r: WorktreeExistingRow): boolean => r.secret || r.runsCode || r.notIgnoredInDestination !== false;

export interface Selection {
  files: number;
  bytes: number;
  overLimit: boolean;
}

/** FR-651: the limits count ENABLED TICKED files only (`copyableCount`), never skipped ones. */
export function measureSelection(rows: readonly WorktreeExistingRow[], ticked: ReadonlySet<string>): Selection {
  let files = 0;
  let bytes = 0;
  for (const r of rows) {
    if (!rowEnabled(r) || !ticked.has(r.id)) continue;
    files += r.copyableCount;
    bytes += r.bytes;
  }
  return { files, bytes, overLimit: files > COPY_MAX_FILES || bytes > COPY_MAX_BYTES };
}

/** The footer readout and the polite live region: one string. */
export function selectionReadout(sel: Selection, anyTicked: boolean): string {
  if (sel.overLimit) return OVER_LIMIT;
  if (!anyTicked || sel.files === 0) return NONE_SELECTED;
  return `${filesOf(sel.files)} selected, ${formatCopySize(sel.bytes)}`;
}

// --- FR-655 banners ---

export interface CopyIntoNames {
  /** Used only when both folder names are equal (main sends names, not paths). */
  fromPath?: string;
  intoPath?: string;
}

function namesOf(from: string, into: string, paths: CopyIntoNames): { a: string; b: string } {
  const a = shown(from);
  const b = shown(into);
  if (a === b && paths.fromPath && paths.intoPath) return { a: shown(paths.fromPath), b: shown(paths.intoPath) };
  return { a, b };
}

function notCopied(result: Extract<WorktreeExistingCopyResult, { skipped: unknown }>): NoticePart[] {
  const parts: NoticePart[] = [" Not copied: "];
  const list = result.skipped.slice(0, 3);
  list.forEach((s, i) => {
    if (i > 0) parts.push(", ");
    parts.push({ code: shown(s.path) }, ` (${s.text})`);
  });
  const more = result.skippedTotal - list.length;
  if (more > 0) parts.push(` and ${more} more`);
  parts.push(".");
  return parts;
}

export interface CopyIntoNoticeModel {
  tone: BannerTone;
  parts: NoticePart[];
  /** The same text without markup, for tests and the plain `text` field. */
  text: string;
}

export const partsText = (parts: readonly NoticePart[]): string => parts.map((p) => (typeof p === "string" ? p : p.code)).join("");

/**
 * FR-655: the result banner for a copy that ran. Every reason string is a fixed text from main (never file content, never raw error
 * text). Not for `refused`: that stays in the dialog (FR-657).
 */
export function copyIntoNotice(result: Exclude<WorktreeExistingCopyResult, { status: "refused" }>, paths: CopyIntoNames = {}): CopyIntoNoticeModel {
  const { a, b } = namesOf(result.from, result.into, paths);
  const where = `${filesOf(result.copied)} (${formatCopySize(result.bytes)}) from ${a} into ${b}`;
  const skipped = result.skippedTotal > 0;
  let tone: BannerTone;
  let parts: NoticePart[];
  if (result.status === "cancelled") {
    tone = skipped ? "warning" : "info";
    parts = [result.copied > 0 ? `Copy cancelled. Copied ${where} before it stopped.` : "Copy cancelled. Nothing was copied."];
    if (skipped) parts.push(...notCopied(result));
  } else if (result.status === "limit") {
    tone = "warning";
    parts = [`Stopped at the limit of 5,000 files, 200 MB or 60 s. Copied ${where}.`];
    if (skipped) parts.push(...notCopied(result));
  } else if (result.copied === 0) {
    tone = "warning";
    parts = skipped ? [`Nothing was copied into ${b}: every selected file was skipped.`, ...notCopied(result)] : [`Nothing was copied into ${b}: not found.`];
  } else {
    tone = skipped ? "warning" : "success";
    parts = [`Copied ${where}.`];
    if (skipped) parts.push(...notCopied(result));
  }
  return { tone, parts, text: partsText(parts) };
}
