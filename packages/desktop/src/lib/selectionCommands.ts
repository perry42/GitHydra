// SPDX-License-Identifier: GPL-3.0-or-later
import { eligibility, type FileRow } from "./fileSelection";

/**
 * specs/ignore-and-multiselect.md FR-504: what each selection command can do right now. `null` means it can run; a string is
 * the reason it cannot (the Command Palette shows the command disabled with that reason instead of hiding it).
 */
export interface SelectionCommandReasons {
  stage: string | null;
  unstage: string | null;
  discard: string | null;
  ignore: string | null;
  discardAll: string | null;
  selectAll: string | null;
}

const NEEDS_PANEL = "Open the Changes panel first.";

export const NO_SELECTION_COMMANDS: SelectionCommandReasons = {
  stage: NEEDS_PANEL,
  unstage: NEEDS_PANEL,
  discard: NEEDS_PANEL,
  ignore: NEEDS_PANEL,
  discardAll: NEEDS_PANEL,
  selectAll: NEEDS_PANEL,
};

export function computeSelectionCommands(
  rows: readonly FileRow[],
  selected: readonly FileRow[],
  hasWorkdir: boolean,
): SelectionCommandReasons {
  if (!hasWorkdir) {
    const bare = "This repository has no working directory.";
    return { stage: bare, unstage: bare, discard: bare, ignore: bare, discardAll: bare, selectAll: bare };
  }
  const none = "Select files in the Changes list first.";
  const reasonFor = (action: "stage" | "unstage" | "discard" | "ignore", nothing: string): string | null => {
    if (selected.length === 0) return none;
    const e = eligibility(action, selected);
    return e.eligible.length > 0 ? null : (e.skipped[0]?.reason ?? nothing);
  };
  const discardable = rows.some((r) => eligibility("discard", [r]).eligible.length > 0);
  return {
    stage: reasonFor("stage", "No selected file can be staged."),
    unstage: reasonFor("unstage", "No selected file is staged."),
    discard: reasonFor("discard", "No selected file can be discarded."),
    ignore: reasonFor("ignore", "No selected file can be ignored."),
    discardAll: discardable ? null : "There are no unstaged or untracked changes to discard.",
    selectAll: rows.length > 0 ? null : "There are no changed files.",
  };
}

export function sameReasons(a: SelectionCommandReasons, b: SelectionCommandReasons): boolean {
  return (
    a.stage === b.stage &&
    a.unstage === b.unstage &&
    a.discard === b.discard &&
    a.ignore === b.ignore &&
    a.discardAll === b.discardAll &&
    a.selectAll === b.selectAll
  );
}
