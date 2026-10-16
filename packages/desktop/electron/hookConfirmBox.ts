// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * specs/worktrees.md FR-644: the native confirmation main shows before a hook runs. It is the authority (the renderer dialog
 * only explains), and its checkbox is the ONLY thing that can store a remembered "run": a renderer flag only pre-ticks it.
 */
export interface HookBoxRequest {
  hookPath: string;
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
      `It can run any code. Run it only if you trust this repository.\n\n${r.hookPath}` +
      (remembering ? "\n\nGitHydra will not ask again for this repository." : ""),
    ...(r.canRemember ? { checkboxLabel: "Remember for this repository", checkboxChecked: r.rememberRequested } : {}),
  };
}

export function readHookBoxAnswer(r: Pick<HookBoxRequest, "canRemember">, answer: { response: number; checkboxChecked?: boolean }): { accepted: boolean; remember: boolean } {
  const accepted = answer.response === 0;
  return { accepted, remember: accepted && r.canRemember && answer.checkboxChecked === true };
}
