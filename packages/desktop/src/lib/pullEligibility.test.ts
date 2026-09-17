// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { computePullDisabledReason } from "./pullEligibility";
import { makeRepoState } from "../test/fixtures";

describe("computePullDisabledReason (specs/online-sync-pull.md FR-343)", () => {
  it("enabled (null) on an ordinary repo, current branch, with a configured upstream", () => {
    expect(computePullDisabledReason(makeRepoState({ currentBranch: "main" }), true, false)).toBeNull();
  });

  it("disabled while a pull is already running", () => {
    expect(computePullDisabledReason(makeRepoState({ currentBranch: "main" }), true, true)).toMatch(/already running/i);
  });

  it("disabled while repo state is still loading", () => {
    expect(computePullDisabledReason(null, true, false)).toMatch(/still loading/i);
  });

  it("disabled on a bare repository, naming the missing working tree", () => {
    expect(
      computePullDisabledReason(makeRepoState({ isBare: true, workdir: null, currentBranch: null }), true, false),
    ).toBe("This is a bare repository — it has no working directory to pull into.");
  });

  it("disabled with the exact in-progress operation named, for every operation kind", () => {
    for (const op of ["merge", "rebase", "am", "cherry-pick", "revert", "bisect"] as const) {
      expect(
        computePullDisabledReason(makeRepoState({ currentBranch: "main", inProgressOperation: op }), true, false),
      ).toBe(`Pull is disabled while a ${op} is already in progress.`);
    }
  });

  it("disabled on an unborn HEAD, even though hasUpstream is true — a UI-layer-only gate per FR-343 (git-core itself would allow it)", () => {
    expect(
      computePullDisabledReason(makeRepoState({ currentBranch: "main", isUnbornHead: true }), true, false),
    ).toBe("This repository has no commits yet, so there is nothing to pull into.");
  });

  it("disabled on a detached HEAD — no current branch to pull into", () => {
    expect(
      computePullDisabledReason(
        makeRepoState({ currentBranch: null, isDetachedHead: true, headSha: "a".repeat(40) }),
        true,
        false,
      ),
    ).toMatch(/detached head/i);
  });

  it("disabled while the current branch's upstream configuration is still loading", () => {
    expect(computePullDisabledReason(makeRepoState({ currentBranch: "main" }), "loading", false)).toMatch(
      /checking/i,
    );
  });

  it("disabled with 'no upstream configured' once the read has resolved false", () => {
    expect(computePullDisabledReason(makeRepoState({ currentBranch: "main" }), false, false)).toBe(
      "This branch has no upstream configured — set one before pulling.",
    );
  });

  it("never disabled merely because a repo is a worktree or shallow — only the listed reasons apply", () => {
    expect(
      computePullDisabledReason(makeRepoState({ currentBranch: "main", isWorktree: true, isShallow: true }), true, false),
    ).toBeNull();
  });
});
