// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { RefDecoration } from "@githydra/git-core";
import { buildRefChips } from "./refChips";

const head: RefDecoration = { name: "HEAD", fullName: null, type: "head" };
const mainBranch: RefDecoration = { name: "main", fullName: "refs/heads/main", type: "local-branch" };
const tag: RefDecoration = { name: "v1.0", fullName: "refs/tags/v1.0", type: "tag" };

describe("buildRefChips", () => {
  it("collapses HEAD into a single filled branch chip when attached to the checked-out branch", () => {
    const chips = buildRefChips(
      { refs: [head, mainBranch] },
      new Set(["HEAD", "refs/heads/main"]),
      { isDetachedHead: false, currentBranch: "main" },
    );
    expect(chips).toHaveLength(1);
    expect(chips[0]).toMatchObject({ filled: true, detached: false });
    expect(chips[0]!.decoration.name).toBe("main");
  });

  it("renders a distinct detached-HEAD chip separate from any branch tip at the same commit (AC4)", () => {
    const chips = buildRefChips(
      { refs: [head, mainBranch] },
      new Set(["HEAD", "refs/heads/main"]),
      { isDetachedHead: true, currentBranch: null },
    );
    expect(chips).toHaveLength(2);
    const headChip = chips.find((c) => c.decoration.type === "head")!;
    expect(headChip.detached).toBe(true);
    const branchChip = chips.find((c) => c.decoration.type === "local-branch")!;
    expect(branchChip.filled).toBe(false);
  });

  it("filters out refs not in the visible set (FR-15)", () => {
    const chips = buildRefChips({ refs: [tag] }, new Set(["HEAD"]), {
      isDetachedHead: false,
      currentBranch: "main",
    });
    expect(chips).toHaveLength(0);
  });

  it("does not fill a non-current local branch that happens to share a commit with HEAD", () => {
    const otherBranch: RefDecoration = { name: "other", fullName: "refs/heads/other", type: "local-branch" };
    const chips = buildRefChips(
      { refs: [head, mainBranch, otherBranch] },
      new Set(["HEAD", "refs/heads/main", "refs/heads/other"]),
      { isDetachedHead: false, currentBranch: "main" },
    );
    const other = chips.find((c) => c.decoration.name === "other")!;
    expect(other.filled).toBe(false);
  });
});
