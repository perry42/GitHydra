// SPDX-License-Identifier: GPL-3.0-or-later
import type { BannerTone } from "../components/StatusBanner/BannerIcon";

/** specs/worktrees.md FR-634: in-flow banners, persistent until dismissed (never auto-dismissed, never a toast). */
export type WorktreeNoticeAction =
  | { kind: "copy"; label: string; text: string }
  | { kind: "openBranches"; label: string }
  /** FR-632: there is no safe way to run `git submodule` from this slice, so the button exists but is disabled with its reason. */
  | { kind: "disabled"; label: string; reason: string };

export interface WorktreeNotice {
  id: number;
  tone: BannerTone;
  text: string;
  /** A second, muted sentence. */
  detail?: string;
  actions: WorktreeNoticeAction[];
}

export const HOOK_NOT_RUN_NOTICE =
  "A post-checkout hook in this repository was not run. Running hooks needs your confirmation, which is coming in a later update.";

export const HOOK_UNKNOWN_NOTICE = "We could not check for a post-checkout hook; none was run.";

export const SUBMODULE_NOTICE_TEXT = ".gitmodules found - submodules are not initialized in this worktree.";
export const SUBMODULE_NOTICE_DETAIL = "Initialize submodules is not available here yet. Update git to enable this button; until then copy the command.";
export const SUBMODULE_DISABLED_REASON = "GitHydra does not run git submodule commands yet. Copy the command and run it in a terminal.";
