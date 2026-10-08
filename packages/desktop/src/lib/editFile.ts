// SPDX-License-Identifier: GPL-3.0-or-later
import type { LineEnding } from "@githydra/git-core";

// Pure helpers for the edit-in-diff UI (specs/edit-in-diff.md); no React, no DOM.

export const SAVE_ERROR_SUMMARY = "Couldn't save. Check that you can write to this folder and file.";
export const STAGED_COPY_NOTE =
  "Editing the working copy. Your staged version is unchanged. Stage again to include these edits.";
export const ALREADY_STAGED_LINE_NOTE =
  "This line was already staged. Your edit is unstaged on top of it. Use Unstage on the Staged row, or Save and stage whole file.";
export const DIRTY_ROW_REASON = "Save or discard your edits first";
export const NO_EDITS_REASON = "No unsaved edits";
export const SAVE_AND_STAGE_WHOLE_TIP = "Replaces your current staged version with the full working copy.";

const EOL_LABEL: Record<LineEnding, string> = { lf: "LF", crlf: "CRLF", mixed: "Mixed" };

/** FR-469 footer: "Ln 3, Col 7 · LF · UTF-8, plain text · final newline". */
export function footerText(o: { line: number; col: number; eol: LineEnding; hasBom: boolean; finalNewline: boolean }): string {
  const enc = `${o.hasBom ? "UTF-8 with BOM" : "UTF-8"}, plain text`;
  return `Ln ${o.line}, Col ${o.col} · ${EOL_LABEL[o.eol]} · ${enc} · ${o.finalNewline ? "final newline" : "no final newline"}`;
}

/** The indent a Tab inserts: the file's own style, so a tab-indented file is not littered with spaces (FR-469). */
export function detectIndentUnit(text: string): string {
  let tabLines = 0;
  let spaceLines = 0;
  let minSpaces = Infinity;
  for (const line of text.split(/\r\n|\r|\n/, 2000)) {
    if (line.startsWith("\t")) tabLines++;
    else {
      const m = /^( +)\S/.exec(line);
      if (m) {
        spaceLines++;
        minSpaces = Math.min(minSpaces, m[1]!.length);
      }
    }
  }
  if (tabLines > spaceLines) return "\t";
  if (spaceLines === 0 || !Number.isFinite(minSpaces)) return "  ";
  return " ".repeat(Math.min(8, Math.max(2, minSpaces)));
}

/** A diff line as far as position mapping is concerned. */
export interface MapLine {
  type: "context" | "add" | "remove";
  newLineNumber: number | null;
}

/**
 * FR-539: the working-file line a diff row stands for. A removed line has no working line, so it maps to the first
 * working line after it (where the deletion happened); null when the hunk ends in deletions with nothing after.
 */
export function workingLineOf(lines: readonly MapLine[], index: number): number | null {
  for (let i = index; i < lines.length; i++) {
    const n = lines[i]!.newLineNumber;
    if (n !== null) return n;
  }
  for (let i = index - 1; i >= 0; i--) {
    const n = lines[i]!.newLineNumber;
    if (n !== null) return n;
  }
  return null;
}

/** FR-539: "that hunk's first working-file line", i.e. the `+start` of its header (clamped to line 1 for a new-side of 0). */
export function hunkFirstWorkingLine(hunk: { newStart: number }): number {
  return Math.max(1, hunk.newStart);
}

export interface EditOpenTarget {
  /** 1-based working-file line to put the caret on; omitted: top of the file. */
  line?: number;
  /** 0-based column within that line. */
  column?: number;
}

/** "10:42" style time for the header's "Saved" state. */
export function formatSavedAt(d: Date): string {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}
export function dirName(path: string): string {
  const parts = path.split("/");
  parts.pop();
  return parts.join("/");
}

/** FR-533: what the Command Palette needs to know about the open editor. `null` upstream means no editor is open. */
export interface EditorCommandState {
  dirty: boolean;
  /** The file finished loading; Save and Save and stage can only act once it has. */
  ready: boolean;
  canSave: boolean;
  canSaveAndStage: boolean;
  /** The file has staged content, so the stage command reads "Save and stage whole file". */
  stagedContent: boolean;
}

export interface EditorCommands {
  save(): void;
  saveAndStage(): void;
}

/** FR-533: the palette's reasons for a disabled edit command. */
export const NO_FILE_TO_EDIT_REASON = "Open a file in the Changes panel first.";
export const ALREADY_EDITING_REASON = "Already editing this file.";
export const NO_EDITOR_REASON = "Open a file for editing first.";
export const CHECKING_FILE_REASON = "Checking whether this file can be edited…";

/** FR-533: null = the command can run now, a string = why it cannot. Reported by the Changes panel to the palette. */
export interface EditCommandReasons {
  edit: string | null;
  save: string | null;
  saveAndStage: string | null;
  /** The open file has staged content: the stage command reads "Save and stage whole file". */
  stagedContent: boolean;
}

/** What the palette sees while no Changes panel is mounted. */
export const NO_EDIT_COMMANDS: EditCommandReasons = {
  edit: NO_FILE_TO_EDIT_REASON,
  save: NO_EDITOR_REASON,
  saveAndStage: NO_EDITOR_REASON,
  stagedContent: false,
};
