// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { computeResetDisabledReason, computeResetModeDisabledReason } from "./resetEligibility";
import { makeRepoState } from "../test/fixtures";

describe("computeResetDisabledReason (specs/reset-to-here.md FR-366)", () => {
  it("enabled (null) on an ordinary repo with no operation in progress", () => {
    expect(computeResetDisabledReason(makeRepoState(), false)).toBeNull();
  });

  it("disabled while a reset is already running", () => {
    expect(computeResetDisabledReason(makeRepoState(), true)).toMatch(/already running/i);
  });

  it("disabled while repo state is still loading", () => {
    expect(computeResetDisabledReason(null, false)).toMatch(/still loading/i);
  });

  it("disabled on a bare repository, naming the missing working tree", () => {
    expect(computeResetDisabledReason(makeRepoState({ isBare: true, workdir: null }), false)).toBe(
      "No working tree — reset isn't available in a bare repository.",
    );
  });

  it("disabled with the exact in-progress operation named, for every operation kind", () => {
    for (const op of ["merge", "rebase", "am", "cherry-pick", "revert", "bisect"] as const) {
      expect(computeResetDisabledReason(makeRepoState({ inProgressOperation: op }), false)).toBe(
        `Resolve or abort the ${op} in progress before resetting.`,
      );
    }
  });

  it("never disabled merely because a repo is a worktree, shallow, or detached — only the four named reasons apply", () => {
    expect(
      computeResetDisabledReason(makeRepoState({ isWorktree: true, isShallow: true, isDetachedHead: true }), false),
    ).toBeNull();
  });
});

describe("computeResetModeDisabledReason (specs/reset-to-here.md FR-370)", () => {
  it("Soft and Mixed are disabled with the 'already at this commit' reason when the target is HEAD", () => {
    expect(computeResetModeDisabledReason("soft", true)).toBe("Already at this commit — nothing to reset.");
    expect(computeResetModeDisabledReason("mixed", true)).toBe("Already at this commit — nothing to reset.");
  });

  it("Hard stays enabled at HEAD", () => {
    expect(computeResetModeDisabledReason("hard", true)).toBeNull();
  });

  it("every mode is enabled when the target isn't HEAD", () => {
    expect(computeResetModeDisabledReason("soft", false)).toBeNull();
    expect(computeResetModeDisabledReason("mixed", false)).toBeNull();
    expect(computeResetModeDisabledReason("hard", false)).toBeNull();
  });
});
