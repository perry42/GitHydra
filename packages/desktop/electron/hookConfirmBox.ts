// SPDX-License-Identifier: GPL-3.0-or-later
import { visibleText } from "../shared/visibleText";

/**
 * specs/worktrees.md FR-644: the native confirmation main shows before a hook runs. It is the authority (the renderer dialog
 * only explains), and its checkbox is the ONLY thing that can store a remembered "run": a renderer flag only pre-ticks it.
 */
export interface HookBoxRequest {
  hookPath: string;
  /** Full-file sha256: its first 12 characters identify the exact content the user is approving. */
  contentSha256: string;
  lineCount: number;
  /** The renderer asked to remember: the box opens with the checkbox ticked so the user sees it and can untick it. */
  rememberRequested: boolean;
  /** False when a remembered run is impossible (relative core.hooksPath): no checkbox at all. */
  canRemember: boolean;
}

export interface HookBoxOptions {
  type: "warning";
  buttons: string[];
  defaultId: number;
  cancelId: number;
  noLink: true;
  title: string;
  message: string;
  detail: string;
  checkboxLabel?: string;
  checkboxChecked?: boolean;
}

export const MAX_BOX_PATH_CHARS = 300;

/** The path is repository-controlled: control, bidi and invisible characters are made visible and the length capped (security L1). */
export function boxPath(raw: string): string {
  const shown = visibleText(raw);
  return shown.length > MAX_BOX_PATH_CHARS ? `${shown.slice(0, MAX_BOX_PATH_CHARS)}...` : shown;
}

export function buildHookConfirmBox(r: HookBoxRequest): HookBoxOptions {
  const remembering = r.canRemember && r.rememberRequested;
  return {
    type: "warning",
    buttons: ["Run hook", "Cancel"],
    // Cancel is both the default and the Esc answer: Enter alone never runs a hook.
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: "Run the post-checkout hook?",
    message: "Run the post-checkout hook?",
    detail:
      `It can run any code. Run it only if you trust this repository.\n\n${boxPath(r.hookPath)}\nContent: sha256 ${r.contentSha256.slice(0, 12)}, ${r.lineCount} ${r.lineCount === 1 ? "line" : "lines"}` +
      (remembering ? "\n\nGitHydra will not ask again for this repository." : ""),
    ...(r.canRemember ? { checkboxLabel: "Remember for this repository", checkboxChecked: r.rememberRequested } : {}),
  };
}

export function readHookBoxAnswer(r: Pick<HookBoxRequest, "canRemember">, answer: { response: number; checkboxChecked?: boolean }): { accepted: boolean; remember: boolean } {
  const accepted = answer.response === 0;
  return { accepted, remember: accepted && r.canRemember && answer.checkboxChecked === true };
}
