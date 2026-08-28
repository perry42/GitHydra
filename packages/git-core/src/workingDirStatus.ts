import { runGit, withFsmonitorNeutralized } from "./gitProcess";
import { statusToChangeType } from "./changedFiles";
import type { WorkingDirectoryChanges, WorkingDirectoryFileChange, WorkingDirectoryStatus } from "./types";

/**
 * `git status` is unlike most commands this module runs (`rev-parse`, `log`, `for-each-ref`):
 * it consults the repository's *local* `.git/config` for `core.fsmonitor`, and — per
 * `git help config` — if that key is set to anything other than a recognized boolean, git
 * treats it as the path/command of an external "fsmonitor hook" and executes it (via the OS's
 * normal child-process/shell invocation for hook scripts) every time `status` needs
 * working-tree state. No confirmation, no opt-in beyond the value already being present in
 * `.git/config`.
 *
 * That matters here specifically because a repo can arrive as a pre-existing checkout, zip/
 * tarball extraction, bare repo, or linked worktree — all explicitly-supported ways to open a
 * repo in GitHydra per CLAUDE.md, not just a fresh `git clone` (which never copies this local
 * config; it lives in `.git/config`, not anything transferred by the clone protocol). Such a
 * repo can ship `[core]\n    fsmonitor = <malicious command>` and have that command run the
 * moment `getWorkingDirectoryStatus()` is called — e.g. right after the user opens it via
 * GitHydra's "Open a git repository" dialog.
 *
 * Fix: `withFsmonitorNeutralized()` (`gitProcess.ts`) prepends `-c core.fsmonitor=false` ahead
 * of the subcommand in argv. See that function's doc comment for the full rationale and for
 * the other call sites (diff/add/restore/clean/commit) across `git-core` that now share this
 * same guard — this used to be a `status`-only fix; it wasn't broad enough once this module
 * grew commands that also refresh working-tree/index state against the same kind of untrusted
 * repo (staging, diff, commit).
 *
 * `core.hooksPath` does NOT need the same treatment for `status` specifically: verified
 * empirically (git 2.31, 2026-08-27, via `GIT_TRACE=1`) that plain `git status` invokes no
 * hook at all, so there is no hook-based execution surface here to neutralize beyond
 * `core.fsmonitor`. (Other git-core commands that DO run hooks — `commit`, see
 * `commitChanges.ts` — are assessed on their own merits.)
 */

/**
 * Working-tree status counts (FR-18's uncommitted-changes pseudo-node). Caller is responsible
 * for only calling this against a non-bare repo with a working directory — see
 * `Repository.getWorkingDirectoryStatus()`, which guards that.
 */
export async function getWorkingDirectoryStatus(workdir: string): Promise<WorkingDirectoryStatus> {
  const { stdout } = await runGit(
    withFsmonitorNeutralized(["status", "--porcelain=v1", "--untracked-files=all"]),
    { cwd: workdir },
  );
  return parsePorcelainStatus(stdout);
}

/** Parse `git status --porcelain=v1 --untracked-files=all` output into summary counts. */
export function parsePorcelainStatus(porcelainOutput: string): WorkingDirectoryStatus {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  let conflicted = 0;

  for (const line of porcelainOutput.split("\n")) {
    if (!line) continue;
    const x = line[0];
    const y = line[1];
    if (x === "?" && y === "?") {
      untracked++;
      continue;
    }
    // Unmerged (conflict) combinations per `git status --porcelain` docs.
    const isConflict =
      x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");
    if (isConflict) {
      conflicted++;
      continue;
    }
    if (x && x !== " ") staged++;
    if (y && y !== " ") unstaged++;
  }

  return {
    hasChanges: staged + unstaged + untracked + conflicted > 0,
    staged,
    unstaged,
    untracked,
    conflicted,
  };
}

/**
 * Per-file working-directory change list (FR-19). Caller is responsible for only calling this
 * against a non-bare repo with a working directory — see `Repository.getWorkingDirectoryChanges()`,
 * which guards that, same convention as `getWorkingDirectoryStatus()`.
 *
 * Uses `--porcelain=v2` rather than v1: v2's `X`/`Y` status letters share the exact same
 * vocabulary as `git diff --name-status` (see `statusToChangeType` in `changedFiles.ts`), it
 * separates "staged" (X, index vs HEAD) from "unstaged" (Y, worktree vs index) unambiguously
 * per entry, it reports a rename/copy score, and it gives conflicted (unmerged) paths their own
 * distinct record type (`u ...`) instead of overloading the same two-letter code v1 uses for
 * everything — exactly the split FR-19/FR-27 need. Also passes the same
 * `withFsmonitorNeutralized()` guard as `getWorkingDirectoryStatus()`, since this is still
 * `git status` under the hood.
 */
export async function getWorkingDirectoryChanges(workdir: string): Promise<WorkingDirectoryChanges> {
  const { stdout } = await runGit(
    withFsmonitorNeutralized(["status", "--porcelain=v2", "-z", "--untracked-files=all"]),
    { cwd: workdir },
  );
  return parsePorcelainV2Changes(stdout);
}

/** Consume exactly `fieldCount` space-separated tokens from the front of `record`; the rest (which may itself contain spaces, e.g. a path) is returned unsplit. */
function splitFields(record: string, fieldCount: number): { fields: string[]; rest: string } {
  let idx = 0;
  const fields: string[] = [];
  for (let i = 0; i < fieldCount; i++) {
    const spaceIdx = record.indexOf(" ", idx);
    if (spaceIdx === -1) {
      fields.push(record.slice(idx));
      idx = record.length;
    } else {
      fields.push(record.slice(idx, spaceIdx));
      idx = spaceIdx + 1;
    }
  }
  return { fields, rest: record.slice(idx) };
}

/** Parse a porcelain v2 rename/copy score field like "R100" or "C75" into a similarity percentage. */
function parseSimilarity(scoreField: string | undefined): number | undefined {
  if (!scoreField) return undefined;
  const m = scoreField.match(/\d+/);
  return m ? Number(m[0]) : undefined;
}

/**
 * Parse `git status --porcelain=v2 -z --untracked-files=all` output into per-file changes
 * (FR-19, FR-27). Exported for direct unit testing, same pattern as `parsePorcelainStatus`.
 *
 * Record types (see `git help status`, "Porcelain Format Version 2"), all `-z`/NUL-terminated:
 *   `1 XY sub mH mI mW hH hI path`               — ordinary changed entry
 *   `2 XY sub mH mI mW hH hI Xscore path\0origPath` — renamed/copied entry (origPath is the NEXT NUL record)
 *   `u XY sub m1 m2 m3 mW h1 h2 h3 path`          — unmerged (conflicted) entry
 *   `? path`                                      — untracked
 *   `! path`                                      — ignored (never appears; --ignored isn't passed)
 */
export function parsePorcelainV2Changes(porcelainOutput: string): WorkingDirectoryChanges {
  const staged: WorkingDirectoryFileChange[] = [];
  const unstaged: WorkingDirectoryFileChange[] = [];
  const untracked: WorkingDirectoryFileChange[] = [];
  const conflicted: WorkingDirectoryFileChange[] = [];

  const records = porcelainOutput.split("\0").filter((r) => r.length > 0);
  let i = 0;
  while (i < records.length) {
    const record = records[i++]!;
    const type = record[0];

    if (type === "?") {
      untracked.push({ path: record.slice(2), status: "added", category: "untracked" });
      continue;
    }

    if (type === "!") {
      continue; // ignored — not requested, skip defensively if it ever appears.
    }

    if (type === "1") {
      const { fields, rest: path } = splitFields(record, 8);
      const x = fields[1]![0]!;
      const y = fields[1]![1]!;
      if (x !== ".") {
        staged.push({ path, status: statusToChangeType(x), category: "staged" });
      }
      if (y !== ".") {
        unstaged.push({ path, status: statusToChangeType(y), category: "unstaged" });
      }
      continue;
    }

    if (type === "2") {
      const { fields, rest: path } = splitFields(record, 9);
      const x = fields[1]![0]!;
      const y = fields[1]![1]!;
      const scoreField = fields[8];
      const origPath = records[i++]; // the next NUL-delimited record is the original path.
      if (x !== ".") {
        staged.push({
          path,
          oldPath: x === "R" || x === "C" ? origPath : undefined,
          status: statusToChangeType(x),
          category: "staged",
          similarity: x === "R" || x === "C" ? parseSimilarity(scoreField) : undefined,
        });
      }
      if (y !== ".") {
        unstaged.push({
          path,
          oldPath: y === "R" || y === "C" ? origPath : undefined,
          status: statusToChangeType(y),
          category: "unstaged",
          similarity: y === "R" || y === "C" ? parseSimilarity(scoreField) : undefined,
        });
      }
      continue;
    }

    if (type === "u") {
      const { rest: path } = splitFields(record, 10);
      conflicted.push({ path, status: "unmerged", category: "conflicted" });
      continue;
    }
  }

  return { staged, unstaged, untracked, conflicted };
}
