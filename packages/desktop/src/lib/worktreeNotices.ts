// SPDX-License-Identifier: GPL-3.0-or-later
import { formatCopySize } from "@githydra/git-core";
import type { WorktreeCopyResult } from "../../shared/ipcContract";
import type { BannerTone } from "../components/StatusBanner/BannerIcon";
import { visibleText } from "./worktrees";

/** specs/worktrees.md FR-634: in-flow banners, persistent until dismissed (never auto-dismissed, never a toast). */
export type WorktreeNoticeAction =
  | { kind: "copy"; label: string; text: string }
  | { kind: "openBranches"; label: string }
  /** specs/external-programs.md FR-622: a failed program launch offers the Programs dialog. */
  | { kind: "managePrograms"; label: string };

/** One short follow-up line of a notice group (dependencies, submodules, a skipped hook), with its own quiet action. */
export interface WorktreeNoticeLine {
  text: string;
  action?: Extract<WorktreeNoticeAction, { kind: "copy" }>;
}

export interface WorktreeNotice {
  id: number;
  tone: BannerTone;
  text: string;
  /** A second, muted sentence. */
  detail?: string;
  actions: WorktreeNoticeAction[];
  /** Follow-ups of the same event (FR-632/633/644), listed inside THIS banner so there is one Dismiss and one announcement. */
  lines?: WorktreeNoticeLine[];
}

/** FR-644: truthful outcomes of the hook choice; the old "not available yet" interim text is gone. */
export const HOOK_RAN_NOTICE = "The post-checkout hook was run.";
export const HOOK_RAN_WITH_PROBLEM_NOTICE = "The post-checkout hook was allowed to run; git reported a problem afterwards, so check the result.";
export const HOOK_SKIPPED_NOTICE = "The post-checkout hook was skipped.";

export const HOOK_UNKNOWN_NOTICE = "We could not check for a post-checkout hook; none was run.";

/** FR-632: git-core exposes no submodule init (and no git version), so the line only offers the command to copy. */
export const SUBMODULE_NOTICE_TEXT =
  ".gitmodules found - submodules are not initialized in this worktree. Initializing submodules needs a newer git than yours. Update git, or run the command yourself.";

// --- specs/worktree-copy-ignored.md FR-643 "Result notices" ---

const filesOf = (n: number): string => (n === 1 ? "1 file" : `${n} files`);

/** "a (already exists), b (...) and 2 more": fixed texts from git-core, names shown with invisible characters escaped. */
function notCopiedList(copy: WorktreeCopyResult): string {
  const shown = copy.skipped.slice(0, 3).map((s) => `${visibleText(s.path)} (${s.message})`);
  const more = copy.skippedTotal - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
}

/**
 * The persistent banner for a copy. Never mentions remembering (FR-643). `text` is the whole banner; `line` is the same news
 * as a follow-up line, for a create that already has its own banner text (a post-create git problem).
 */
/** LOW-6: files that never reached the reviewed list are reported, not silently absent. */
function droppedSentence(copy: WorktreeCopyResult): string {
  if (copy.droppedFiles === 0) return "";
  return ` ${filesOf(copy.droppedFiles)} not copied (${copy.droppedReasons.join(", ")}).`;
}

export function copyOutcomeNotice(name: string, copy: WorktreeCopyResult): { tone: "success" | "warning"; text: string; line: string } {
  const head = `Created worktree "${name}"`;
  if (copy.status === "copied") {
    const line = `Copied ${filesOf(copy.copied)} (${formatCopySize(copy.bytes)}) from ${visibleText(copy.from)}.${droppedSentence(copy)}`;
    return { tone: "success", text: `${head}. ${line}`, line };
  }
  if (copy.status === "partial") {
    const line = `Copied ${copy.copied} of ${filesOf(copy.total)}. Not copied: ${notCopiedList(copy)}.${droppedSentence(copy)}`;
    return { tone: "warning", text: `${head}. ${line}`, line };
  }
  const onlyDropped = copy.message === undefined && copy.skipped.length === 0 && copy.droppedFiles > 0;
  const reason = onlyDropped
    ? `${filesOf(copy.droppedFiles)} not copied (${copy.droppedReasons.join(", ")})`
    : (copy.message ?? (copy.skipped.length > 0 ? notCopiedList(copy) : "none of the files could be copied"));
  const more = onlyDropped ? "" : droppedSentence(copy);
  return { tone: "warning", text: `${head}, but nothing was copied: ${reason}.${more}`, line: `Nothing was copied: ${reason}.${more}` };
}
