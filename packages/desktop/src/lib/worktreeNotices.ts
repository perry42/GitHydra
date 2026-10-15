// SPDX-License-Identifier: GPL-3.0-or-later
import type { BannerTone } from "../components/StatusBanner/BannerIcon";

/** specs/worktrees.md FR-634: in-flow banners, persistent until dismissed (never auto-dismissed, never a toast). */
export type WorktreeNoticeAction =
  | { kind: "copy"; label: string; text: string }
  | { kind: "openBranches"; label: string };

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

export const HOOK_NOT_RUN_NOTICE =
  "A post-checkout hook in this repository was skipped. Running hooks needs your confirmation, which is not available yet.";

export const HOOK_UNKNOWN_NOTICE = "We could not check for a post-checkout hook; none was run.";

/** FR-632: git-core exposes no submodule init (and no git version), so the line only offers the command to copy. */
export const SUBMODULE_NOTICE_TEXT =
  ".gitmodules found - submodules are not initialized in this worktree. Initializing submodules needs a newer git than yours. Update git, or run the command yourself.";
