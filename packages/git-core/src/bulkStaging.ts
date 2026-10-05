// SPDX-License-Identifier: GPL-3.0-or-later
import { runGit, runGitAllowingExitCodes, runInMutationQueue, withFsmonitorNeutralized } from "./gitProcess";
import { BULK_STAGE_ROW_LIMIT, BulkStagingError, GitCommandError, InvalidArgumentError, TooManyFilesError } from "./errors";
import { assertPathWithinWorkdir } from "./pathSafety";
import { getWorkingDirectoryChanges } from "./workingDirStatus";
import { hasHead, restorePathsFor } from "./staging";
import { batchArgs } from "./argvBatch";

/** specs/ignore-and-multiselect.md FR-505..FR-507: bulk stage/unstage as ONE mutation-queue entry. */

export type BulkRowSection = "staged" | "unstaged" | "untracked" | "mixed" | "conflicted";

export interface BulkRow {
  /** Repo-relative path as listed by status (an untracked nested repo keeps its trailing `/`). */
  path: string;
  section: BulkRowSection;
}

export interface BulkSkipped {
  path: string;
  reason: string;
}

export interface BulkStageResult {
  /** Paths whose state really changed (re-read from status afterwards). */
  changed: string[];
  /** Eligible paths that did not change (e.g. the file vanished or was reverted meanwhile). */
  unchanged: string[];
  /** FR-506: ineligible rows, with the reason, never touched. */
  skipped: BulkSkipped[];
}

function validate(workdir: string, rows: readonly BulkRow[]): BulkRow[] {
  if (!Array.isArray(rows)) throw new InvalidArgumentError("Rows must be an array.");
  if (rows.length > BULK_STAGE_ROW_LIMIT) throw new TooManyFilesError(rows.length, BULK_STAGE_ROW_LIMIT);
  const seen = new Set<string>();
  const out: BulkRow[] = [];
  for (const r of rows) {
    if (typeof r?.path !== "string") throw new InvalidArgumentError("Each row needs a path.");
    assertPathWithinWorkdir(workdir, r.path.endsWith("/") && r.path.length > 1 ? r.path.slice(0, -1) : r.path);
    const key = `${r.path}\0${r.section}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

async function runBatches(workdir: string, prefix: readonly string[], paths: readonly string[]): Promise<void> {
  for (const batch of batchArgs(paths, prefix.join(" ").length + 40)) {
    // No `mutatesRepository`: the caller holds the queue slot for the whole bulk operation.
    await runGit(withFsmonitorNeutralized([...prefix, "--", ...batch]), { cwd: workdir });
  }
}

async function bulk(
  workdir: string,
  rows: readonly BulkRow[],
  mode: "stage" | "unstage",
): Promise<BulkStageResult> {
  const input = validate(workdir, rows);
  return runInMutationQueue(async () => {
    const before = await getWorkingDirectoryChanges(workdir);
    const conflicted = new Set(before.conflicted.map((c) => c.path));
    const unstagedOrUntracked = new Set([...before.unstaged, ...before.untracked].map((c) => c.path));
    const stagedByPath = new Map(before.staged.map((c) => [c.path, c]));

    const skipped: BulkSkipped[] = [];
    const eligible: string[] = [];
    const gitPaths: string[] = [];
    for (const r of input) {
      if (r.section === "conflicted" || conflicted.has(r.path)) {
        skipped.push({ path: r.path, reason: "Conflicted files are resolved in the conflict view." });
      } else if (mode === "stage") {
        if (r.section !== "unstaged" && r.section !== "untracked" && r.section !== "mixed") skipped.push({ path: r.path, reason: "Not an unstaged or untracked row." });
        else if (!unstagedOrUntracked.has(r.path)) skipped.push({ path: r.path, reason: "No longer has unstaged changes." });
        else {
          eligible.push(r.path);
          gitPaths.push(r.path);
        }
      } else if (r.section !== "staged") {
        skipped.push({ path: r.path, reason: "Not a staged row." });
      } else if (!stagedByPath.has(r.path)) {
        skipped.push({ path: r.path, reason: "No longer staged." });
      } else {
        eligible.push(r.path);
        // A staged rename must restore old and new path together (see `restorePathsFor`).
        gitPaths.push(...restorePathsFor(stagedByPath.get(r.path)!));
      }
    }

    const unique = Array.from(new Set(gitPaths));
    const classify = async (): Promise<{ changed: string[]; unchanged: string[] }> => {
      const after = await getWorkingDirectoryChanges(workdir);
      const still = new Set((mode === "stage" ? [...after.unstaged, ...after.untracked] : after.staged).map((c) => c.path));
      const changed: string[] = [];
      const unchanged: string[] = [];
      for (const p of eligible) (still.has(p) ? unchanged : changed).push(p);
      return { changed, unchanged };
    };

    if (unique.length > 0) {
      try {
        if (mode === "stage") {
          await runBatches(workdir, ["--literal-pathspecs", "add"], unique);
        } else if (await hasHead(workdir)) {
          await runBatches(workdir, ["--literal-pathspecs", "restore", "--staged"], unique);
        } else {
          // `restore --staged` fails on an unborn HEAD; every staged path is then a plain addition.
          await runBatches(workdir, ["--literal-pathspecs", "rm", "--cached", "-r", "-f", "-q"], unique);
        }
      } catch (err) {
        const { changed, unchanged } = await classify().catch(() => ({ changed: [] as string[], unchanged: eligible }));
        throw new BulkStagingError(changed, unchanged, err instanceof GitCommandError ? err.message.split("\n")[0]! : err instanceof Error ? err.message : "unknown error");
      }
    }
    const { changed, unchanged } = unique.length > 0 ? await classify() : { changed: [], unchanged: [] };
    return { changed, unchanged, skipped };
  });
}

/** FR-507: stage every eligible row (Unstaged, Untracked, mixed) via batched `git add`, literal pathspecs. */
export function stagePaths(workdir: string, rows: readonly BulkRow[]): Promise<BulkStageResult> {
  return bulk(workdir, rows, "stage");
}

/** FR-507: unstage every eligible Staged row via batched `git restore --staged`; worktree untouched. */
export function unstagePaths(workdir: string, rows: readonly BulkRow[]): Promise<BulkStageResult> {
  return bulk(workdir, rows, "unstage");
}
