// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { computePushDisabledReason } from "./pushEligibility";
import { makeRepoState } from "../test/fixtures";

describe("computePushDisabledReason (specs/online-sync-push.md FR-349)", () => {
  it("enabled (null) on an ordinary repo, current branch, with at least one configured remote", () => {
    expect(computePushDisabledReason(makeRepoState({ currentBranch: "main" }), ["origin"], false)).toBeNull();
  });

  it("disabled while a push is already running", () => {
    expect(computePushDisabledReason(makeRepoState({ currentBranch: "main" }), ["origin"], true)).toMatch(
      /already running/i,
    );
  });

  it("disabled while repo state is still loading", () => {
    expect(computePushDisabledReason(null, ["origin"], false)).toMatch(/still loading/i);
  });

  it("disabled on a bare repository, naming the missing checked-out branch", () => {
    expect(
      computePushDisabledReason(
        makeRepoState({ isBare: true, workdir: null, currentBranch: null }),
        ["origin"],
        false,
      ),
    ).toBe("This is a bare repository — there is no checked-out branch to push.");
  });

  it("disabled with the exact in-progress operation named, for every operation kind", () => {
    for (const op of ["merge", "rebase", "am", "cherry-pick", "revert", "bisect"] as const) {
      expect(
        computePushDisabledReason(
          makeRepoState({ currentBranch: "main", inProgressOperation: op }),
          ["origin"],
          false,
        ),
      ).toBe(`Push is disabled while a ${op} is already in progress.`);
    }
  });

  it("disabled on an unborn HEAD — nothing to push yet", () => {
    expect(
      computePushDisabledReason(makeRepoState({ currentBranch: "main", isUnbornHead: true }), ["origin"], false),
    ).toBe("This repository has no commits yet, so there is nothing to push.");
  });

  it("disabled on a detached HEAD — no current branch to push", () => {
    expect(
      computePushDisabledReason(
        makeRepoState({ currentBranch: null, isDetachedHead: true, headSha: "a".repeat(40) }),
        ["origin"],
        false,
      ),
    ).toMatch(/detached head/i);
  });

  it("disabled while the configured-remotes read is still loading", () => {
    expect(computePushDisabledReason(makeRepoState({ currentBranch: "main" }), "loading", false)).toMatch(
      /checking/i,
    );
  });

  it("disabled with 'no remotes configured' once the read has resolved to an empty list", () => {
    expect(computePushDisabledReason(makeRepoState({ currentBranch: "main" }), [], false)).toBe(
      "This repository has no remotes configured — add one before pushing.",
    );
  });

  it("never disabled merely because a repo is a worktree or shallow, or has more than one remote — only the listed reasons apply", () => {
    expect(
      computePushDisabledReason(
        makeRepoState({ currentBranch: "main", isWorktree: true, isShallow: true }),
        ["origin", "upstream"],
        false,
      ),
    ).toBeNull();
  });
});
