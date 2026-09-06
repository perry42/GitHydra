// SPDX-License-Identifier: GPL-3.0-or-later
import { runGit } from "./gitProcess";
import type { RefDecoration, RefInfo, RefType } from "./types";

const FS = "\x1f"; // ASCII unit separator — control char, won't collide with ref names/content.

// for-each-ref format: we ask for both the ref's own object and, for annotated tags, the
// dereferenced target (`*objectname`) so we always end up with the commit SHA the ref points
// at, not an intermediate tag object.
const FOR_EACH_REF_FORMAT = [
  "%(refname)",
  "%(objectname)",
  "%(*objectname)",
  "%(objecttype)",
  "%(symref)",
].join(FS);

function classify(fullName: string): { type: Exclude<RefType, "head">; remoteName?: string } | null {
  if (fullName.startsWith("refs/heads/")) return { type: "local-branch" };
  if (fullName.startsWith("refs/remotes/")) {
    const rest = fullName.slice("refs/remotes/".length);
    const remoteName = rest.split("/")[0];
    return { type: "remote-branch", remoteName };
  }
  if (fullName.startsWith("refs/tags/")) return { type: "tag" };
  return null;
}

/**
 * List all local branches, remote-tracking branches, and tags (FR-1's ref sources minus HEAD,
 * which is a separate pseudo-ref handled by repository state / getHeadDecoration below).
 *
 * specs/repo-open-feedback-fixes.md FR-197: `signal` — when supplied (from a still-in-flight
 * cancellable `openRepo` attempt's aux-data phase) — is threaded straight through to `runGit`, so
 * this call is abortable the same way `resolveRepositoryPaths`'s own reads already are.
 */
export async function listRefs(repoPath: string, signal?: AbortSignal): Promise<RefInfo[]> {
  const { stdout } = await runGit(
    [
      "for-each-ref",
      `--format=${FOR_EACH_REF_FORMAT}`,
      "refs/heads",
      "refs/remotes",
      "refs/tags",
    ],
    { cwd: repoPath, signal },
  );

  const refs: RefInfo[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const [fullName, objectname, derefObjectname, objecttype, symref] = line.split(FS);
    if (!fullName || !objectname) continue;

    const classification = classify(fullName);
    if (!classification) continue; // refs/stash, refs/notes/*, refs/bisect/*, etc. — out of scope for FR-1.

    const isAnnotatedTag = objecttype === "tag";
    const targetCommitSha = isAnnotatedTag && derefObjectname ? derefObjectname : objectname;

    // A tag pointing at something other than a commit (e.g. a tag on a blob) has no
    // dereferenced commit target; skip it from commit-graph decoration rather than
    // mislabeling a random object as a commit.
    if (isAnnotatedTag && !derefObjectname) continue;
    if (!isAnnotatedTag && objecttype !== "commit") continue;

    refs.push({
      fullName,
      shortName: shortenRefName(fullName, classification.type),
      type: classification.type,
      targetCommitSha,
      isAnnotatedTag,
      isSymbolic: Boolean(symref),
      remoteName: classification.remoteName,
    });
  }
  return refs;
}

function shortenRefName(fullName: string, type: Exclude<RefType, "head">): string {
  if (type === "local-branch") return fullName.slice("refs/heads/".length);
  if (type === "remote-branch") return fullName.slice("refs/remotes/".length);
  return fullName.slice("refs/tags/".length);
}

/** Build a lookup of commit SHA -> ref decorations, for attaching to CommitInfo.refs. */
export function indexRefsBySha(refs: RefInfo[]): Map<string, RefDecoration[]> {
  const map = new Map<string, RefDecoration[]>();
  for (const ref of refs) {
    const decoration: RefDecoration = {
      name: ref.shortName,
      fullName: ref.fullName,
      type: ref.type,
      isAnnotatedTag: ref.isAnnotatedTag || undefined,
      isSymbolic: ref.isSymbolic || undefined,
    };
    const list = map.get(ref.targetCommitSha);
    if (list) list.push(decoration);
    else map.set(ref.targetCommitSha, [decoration]);
  }
  return map;
}

/** The synthetic HEAD decoration, to be merged into a commit's refs alongside branch/tag decorations. */
export function headDecoration(): RefDecoration {
  return { name: "HEAD", fullName: null, type: "head" };
}
