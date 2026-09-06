// SPDX-License-Identifier: GPL-3.0-or-later
import type { RefInfo } from "@githydra/git-core";

/**
 * FR-15's default ref-filtering heuristic (flagged in specs/commit-graph.md as left to
 * ui-graphics to propose): a large repo can have hundreds of remote-tracking branches and tags,
 * which would make the label area at commit line-ends unreadable if all were shown by default.
 *
 * Default visible set:
 *   - every local branch (they're what the user actually works with day to day)
 *   - the current branch's upstream remote-tracking branch, if any (so "am I ahead/behind" is
 *     visible without extra configuration)
 *   - tags "reachable near HEAD": approximated here as any tag whose target commit is within the
 *     first `nearHeadWindow` commits of the loaded (default, unfiltered) log — a cheap, good-enough
 *     stand-in for a full merge-base walk against every tag (which would be O(tags) graph walks on
 *     every repo open). ASSUMPTION, flagged back per task instructions: this is recency-in-the-
 *     default-log-order, not a strict ancestry check — acceptable because the default log is
 *     already topo/date-ordered from every ref including HEAD, so a tag on an old, unrelated
 *     branch tip won't spuriously qualify just because that branch is old but still `--all`-visible
 *     near the top for unrelated reasons.
 *
 * Everything else (other remote-tracking branches, older tags) is hidden by default; the "show
 * all" toggle (see useRepositoryGraph) removes this filter entirely without re-querying git — it's
 * a display-layer filter over already-fetched refs, not a change to the commit log query itself.
 */
export interface RefFilterContext {
  /** Local branch short name HEAD is attached to, or null if detached/unborn. */
  currentBranch: string | null;
  /** Short name of the current branch's upstream (e.g. "origin/main"), or null if none/detached. */
  upstreamShortName: string | null;
  /** SHAs considered "near HEAD" for the tag heuristic above. */
  nearHeadShas: ReadonlySet<string>;
}

export function isRefVisibleByDefault(ref: RefInfo, ctx: RefFilterContext): boolean {
  if (ref.type === "local-branch") return true;
  if (ref.type === "remote-branch") {
    return ctx.upstreamShortName != null && ref.shortName === ctx.upstreamShortName;
  }
  if (ref.type === "tag") {
    return ctx.nearHeadShas.has(ref.targetCommitSha);
  }
  return false;
}

export function getDefaultVisibleRefs(refs: RefInfo[], ctx: RefFilterContext): RefInfo[] {
  return refs.filter((ref) => isRefVisibleByDefault(ref, ctx));
}

/** Fully-qualified ref names (plus the synthetic "HEAD") visible under the current toggle state. */
export function computeVisibleRefNames(
  refs: RefInfo[],
  ctx: RefFilterContext,
  showAll: boolean,
): Set<string> {
  const visible = showAll ? refs : getDefaultVisibleRefs(refs, ctx);
  const names = new Set(visible.map((r) => r.fullName));
  names.add("HEAD");
  return names;
}
