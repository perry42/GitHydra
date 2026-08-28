import { runGit, withEndOfOptions } from "./gitProcess";
import { InvalidArgumentError } from "./errors";
import type { ChangedFile } from "./types";

/** Git's well-known empty-tree object, present in every repository. Used as the diff base for root commits. */
export const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export const HEX_SHA_RE = /^[0-9a-f]{4,40}$/i;

/** Shared with `workingDirStatus.ts` (porcelain v2 X/Y letters use the same vocabulary as `diff --name-status`). */
export function statusToChangeType(letter: string): ChangedFile["status"] {
  switch (letter[0]) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "type-changed";
    case "U":
      return "unmerged";
    default:
      return "unknown";
  }
}

/**
 * List files changed by a commit (FR-13's data dependency), for the given commit's SHA and
 * known parent SHAs. For merge commits (2+ parents) we diff against the first parent, which
 * is the conventional "what did this merge commit bring in" view — matching common tooling
 * (GitHub/GitLab/GitKraken all default to first-parent diff for merges). Root commits (no
 * parents) are diffed against git's empty-tree object so they show as 100% additions, same
 * as any other tool would show them.
 */
export async function getChangedFiles(
  repoPath: string,
  sha: string,
  parents: readonly string[],
): Promise<ChangedFile[]> {
  if (!HEX_SHA_RE.test(sha)) {
    throw new InvalidArgumentError(`Not a valid hex SHA: ${JSON.stringify(sha)}`);
  }
  const base = parents.length > 0 ? parents[0]! : EMPTY_TREE_SHA;
  if (base !== EMPTY_TREE_SHA && !HEX_SHA_RE.test(base)) {
    throw new InvalidArgumentError(`Not a valid hex SHA: ${JSON.stringify(base)}`);
  }

  const args = [
    "diff",
    "--no-color",
    "--find-renames",
    "--find-copies",
    "--name-status",
    "-z",
    ...withEndOfOptions([base, sha]),
  ];
  const { stdout } = await runGit(args, { cwd: repoPath });

  // -z separates fields/records with NUL instead of newlines/tabs, so paths containing
  // newlines or other unusual bytes can't corrupt parsing.
  const tokens = stdout.split("\0").filter((t) => t.length > 0);
  const files: ChangedFile[] = [];
  let i = 0;
  while (i < tokens.length) {
    const statusToken = tokens[i++]!;
    const status = statusToChangeType(statusToken);
    if (statusToken[0] === "R" || statusToken[0] === "C") {
      const oldPath = tokens[i++];
      const newPath = tokens[i++];
      if (newPath === undefined) break;
      const similarityMatch = statusToken.match(/\d+/);
      files.push({
        path: newPath,
        oldPath,
        status,
        similarity: similarityMatch ? Number(similarityMatch[0]) : undefined,
      });
    } else {
      const p = tokens[i++];
      if (p === undefined) break;
      files.push({ path: p, status });
    }
  }
  return files;
}
