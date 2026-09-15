// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { makeCommit, makeRepoState } from "../test/fixtures";
import { computeMergeOrRebaseDisabledReason, localBranchNameOf, resolveDragCommitLabel } from "./dragCommitMenu";

describe("resolveDragCommitLabel (specs/drag-commit-menu.md FR-305/306)", () => {
  it("prefers a local branch name over remote-tracking/tag/SHA", () => {
    const commit = makeCommit("abc1234abc1234abc1234abc1234abc1234abcd", [], {
      refs: [
        { name: "origin/main", fullName: "refs/remotes/origin/main", type: "remote-branch" },
        { name: "main", fullName: "refs/heads/main", type: "local-branch" },
        { name: "v1.0", fullName: "refs/tags/v1.0", type: "tag" },
      ],
    });
    expect(resolveDragCommitLabel(commit, commit.sha)).toBe("main");
  });

  it("falls back to a remote-tracking branch name when there's no local branch", () => {
    const commit = makeCommit("abc1234abc1234abc1234abc1234abc1234abcd", [], {
      refs: [
        { name: "v1.0", fullName: "refs/tags/v1.0", type: "tag" },
        { name: "origin/main", fullName: "refs/remotes/origin/main", type: "remote-branch" },
      ],
    });
    expect(resolveDragCommitLabel(commit, commit.sha)).toBe("origin/main");
  });

  it("falls back to a tag name when there's no local or remote-tracking branch", () => {
    const commit = makeCommit("abc1234abc1234abc1234abc1234abc1234abcd", [], {
      refs: [{ name: "v1.0", fullName: "refs/tags/v1.0", type: "tag" }],
    });
    expect(resolveDragCommitLabel(commit, commit.sha)).toBe("v1.0");
  });

  it("falls back to the abbreviated SHA when the commit carries no ref at all", () => {
    const commit = makeCommit("abc1234abc1234abc1234abc1234abc1234abcd", [], { refs: [] });
    expect(resolveDragCommitLabel(commit, commit.sha)).toBe(commit.abbrevSha);
  });

  it("ignores a HEAD decoration — never a valid label source", () => {
    const commit = makeCommit("abc1234abc1234abc1234abc1234abc1234abcd", [], {
      refs: [{ name: "HEAD", fullName: null, type: "head" }],
    });
    expect(resolveDragCommitLabel(commit, commit.sha)).toBe(commit.abbrevSha);
  });

  it("falls back to the fallback SHA's own abbreviation when the commit isn't loaded at all", () => {
    expect(resolveDragCommitLabel(undefined, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef")).toBe("deadbee");
  });
});

describe("localBranchNameOf (specs/drag-commit-menu.md FR-309)", () => {
  it("returns the local branch name when present", () => {
    const commit = makeCommit("c1", [], {
      refs: [{ name: "main", fullName: "refs/heads/main", type: "local-branch" }],
    });
    expect(localBranchNameOf(commit)).toBe("main");
  });

  it("returns null when the commit has no local branch (remote/tag/nothing)", () => {
    const commit = makeCommit("c1", [], {
      refs: [{ name: "origin/main", fullName: "refs/remotes/origin/main", type: "remote-branch" }],
    });
    expect(localBranchNameOf(commit)).toBeNull();
    expect(localBranchNameOf(undefined)).toBeNull();
  });
});

describe("computeMergeOrRebaseDisabledReason (specs/drag-commit-menu.md FR-307/308)", () => {
  const repoState = makeRepoState();

  it('shows "Computing…" while the ancestry read hasn\'t resolved yet (AC1)', () => {
    expect(computeMergeOrRebaseDisabledReason(repoState, "computing", false, "merge")).toBe("Computing…");
    expect(computeMergeOrRebaseDisabledReason(repoState, "computing", false, "rebase")).toBe("Computing…");
  });

  it("surfaces a distinct reason when the ancestry read itself failed", () => {
    expect(computeMergeOrRebaseDisabledReason(repoState, "error", false, "merge")).toMatch(/could not determine/i);
  });

  it('FR-307: "a-ancestor-of-b" disables Merge ("Already up to date") and Rebase ("Nothing to replay")', () => {
    expect(computeMergeOrRebaseDisabledReason(repoState, "a-ancestor-of-b", false, "merge")).toBe(
      "Already up to date",
    );
    expect(computeMergeOrRebaseDisabledReason(repoState, "a-ancestor-of-b", false, "rebase")).toBe(
      "Nothing to replay",
    );
  });

  it('FR-307: "b-ancestor-of-a" (fast-forward) enables both', () => {
    expect(computeMergeOrRebaseDisabledReason(repoState, "b-ancestor-of-a", false, "merge")).toBeNull();
    expect(computeMergeOrRebaseDisabledReason(repoState, "b-ancestor-of-a", false, "rebase")).toBeNull();
  });

  it('FR-307: "no-common-ancestor" disables both with the shared-history reason', () => {
    expect(computeMergeOrRebaseDisabledReason(repoState, "no-common-ancestor", false, "merge")).toBe(
      "No shared history between these commits",
    );
    expect(computeMergeOrRebaseDisabledReason(repoState, "no-common-ancestor", false, "rebase")).toBe(
      "No shared history between these commits",
    );
  });

  it('FR-307: "diverged" enables both', () => {
    expect(computeMergeOrRebaseDisabledReason(repoState, "diverged", false, "merge")).toBeNull();
    expect(computeMergeOrRebaseDisabledReason(repoState, "diverged", false, "rebase")).toBeNull();
  });

  it("FR-308: disabled while busy, regardless of ancestry", () => {
    expect(computeMergeOrRebaseDisabledReason(repoState, "diverged", true, "merge")).toMatch(/already running/i);
  });

  it("FR-308: disabled while another operation is already in progress", () => {
    const busyRepo = makeRepoState({ inProgressOperation: "cherry-pick" });
    expect(computeMergeOrRebaseDisabledReason(busyRepo, "diverged", false, "merge")).toMatch(
      /already in progress/i,
    );
  });

  it("FR-308: disabled on a bare repository", () => {
    const bareRepo = makeRepoState({ isBare: true, workdir: null });
    expect(computeMergeOrRebaseDisabledReason(bareRepo, "diverged", false, "merge")).toMatch(/bare repository/i);
  });

  it("FR-308: disabled when HEAD is unborn", () => {
    const unbornRepo = makeRepoState({ isUnbornHead: true });
    expect(computeMergeOrRebaseDisabledReason(unbornRepo, "diverged", false, "rebase")).toMatch(/no commits yet/i);
  });
});
