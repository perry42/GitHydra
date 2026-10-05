// SPDX-License-Identifier: GPL-3.0-or-later
import { runGit, SAFE_DIFF_FLAGS, withReadOnlyIndex } from "./gitProcess";
import { batchArgs } from "./argvBatch";
import { TooManyFilesError } from "./errors";
import { assertPathWithinWorkdir } from "./pathSafety";
import { getWorkingDirectoryChanges } from "./workingDirStatus";

/** FR-521: the desktop asks for the rows it can see; more than this many in one call is refused before anything is read. */
export const DISCARD_PREVIEW_ROW_LIMIT = 50;

export interface DiscardPreviewRow {
  path: string;
  /** Git's status word for the row ("modified", "deleted", ...), "untracked" for an untracked row, "unknown" when the path is not a current Unstaged/Untracked row. */
  status: string;
  /** Added/removed lines of the worktree against the index; null when unknown, binary or untracked (never read in full). */
  added: number | null;
  removed: number | null;
  binary: boolean;
}

/**
 * specs/ignore-and-multiselect.md FR-521: line counts for the discard confirmation. Read-only (no mutation-queue slot): one
 * `git diff --numstat -z` per argv batch, worktree against index. Paths come from a fresh status lookup, never trusted as given;
 * a bad, absent or untracked path yields a null row instead of an error.
 */
export async function getDiscardPreview(workdir: string, paths: readonly string[]): Promise<DiscardPreviewRow[]> {
  if (paths.length > DISCARD_PREVIEW_ROW_LIMIT) throw new TooManyFilesError(paths.length, DISCARD_PREVIEW_ROW_LIMIT);
  const changes = await getWorkingDirectoryChanges(workdir);
  const unstaged = new Map(changes.unstaged.map((c) => [c.path, c.status as string]));
  const untracked = new Set(changes.untracked.map((c) => c.path));

  const rows = new Map<string, DiscardPreviewRow>();
  const toRead: string[] = [];
  for (const p of paths) {
    if (rows.has(p)) continue;
    let status = "unknown";
    let safe = true;
    try {
      assertPathWithinWorkdir(workdir, p);
    } catch {
      safe = false;
    }
    if (safe && unstaged.has(p)) {
      status = unstaged.get(p)!;
      toRead.push(p);
    } else if (safe && untracked.has(p)) status = "untracked";
    rows.set(p, { path: p, status, added: null, removed: null, binary: false });
  }

  for (const batch of batchArgs(toRead, 160)) {
    let out: string;
    try {
      out = (await runGit(withReadOnlyIndex(["--literal-pathspecs", "diff", "--no-color", ...SAFE_DIFF_FLAGS, "--no-renames", "--numstat", "-z", "--", ...batch]), { cwd: workdir })).stdout;
    } catch {
      continue; // an unreadable batch leaves its rows without counts
    }
    // -z numstat: "<added>\t<removed>\t<path>\0" per file; "-" counts mean binary.
    for (const rec of out.split("\0")) {
      const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(rec);
      const row = m ? rows.get(m[3]!) : undefined;
      if (!m || !row) continue;
      if (m[1] === "-") row.binary = true;
      else {
        row.added = Number(m[1]);
        row.removed = Number(m[2]);
      }
    }
  }
  return paths.filter((p, i) => paths.indexOf(p) === i).map((p) => rows.get(p)!);
}
