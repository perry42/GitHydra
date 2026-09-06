// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { RefInfo } from "@githydra/git-core";
import { computeVisibleRefNames, getDefaultVisibleRefs } from "./refFiltering";

function ref(overrides: Partial<RefInfo>): RefInfo {
  return {
    fullName: "refs/heads/x",
    shortName: "x",
    type: "local-branch",
    targetCommitSha: "sha1",
    isAnnotatedTag: false,
    isSymbolic: false,
    ...overrides,
  };
}

describe("getDefaultVisibleRefs", () => {
  const refs: RefInfo[] = [
    ref({ fullName: "refs/heads/main", shortName: "main", type: "local-branch" }),
    ref({ fullName: "refs/heads/feature", shortName: "feature", type: "local-branch" }),
    ref({
      fullName: "refs/remotes/origin/main",
      shortName: "origin/main",
      type: "remote-branch",
      remoteName: "origin",
    }),
    ref({
      fullName: "refs/remotes/origin/stale-branch",
      shortName: "origin/stale-branch",
      type: "remote-branch",
      remoteName: "origin",
    }),
    ref({ fullName: "refs/tags/v1.0", shortName: "v1.0", type: "tag", targetCommitSha: "near-sha" }),
    ref({ fullName: "refs/tags/v0.1", shortName: "v0.1", type: "tag", targetCommitSha: "old-sha" }),
  ];

  it("shows all local branches, the current branch's upstream, and near-HEAD tags only", () => {
    const visible = getDefaultVisibleRefs(refs, {
      currentBranch: "main",
      upstreamShortName: "origin/main",
      nearHeadShas: new Set(["near-sha"]),
    });
    const names = visible.map((r) => r.fullName).sort();
    expect(names).toEqual(
      ["refs/heads/feature", "refs/heads/main", "refs/remotes/origin/main", "refs/tags/v1.0"].sort(),
    );
  });

  it("hides remote branches with no configured upstream match, and old tags", () => {
    const visible = getDefaultVisibleRefs(refs, {
      currentBranch: "main",
      upstreamShortName: "origin/main",
      nearHeadShas: new Set(["near-sha"]),
    });
    expect(visible.some((r) => r.fullName === "refs/remotes/origin/stale-branch")).toBe(false);
    expect(visible.some((r) => r.fullName === "refs/tags/v0.1")).toBe(false);
  });

  it("show-all toggle returns every ref plus the synthetic HEAD name", () => {
    const names = computeVisibleRefNames(
      refs,
      { currentBranch: "main", upstreamShortName: "origin/main", nearHeadShas: new Set() },
      true,
    );
    expect(names.has("refs/remotes/origin/stale-branch")).toBe(true);
    expect(names.has("refs/tags/v0.1")).toBe(true);
    expect(names.has("HEAD")).toBe(true);
  });
});
