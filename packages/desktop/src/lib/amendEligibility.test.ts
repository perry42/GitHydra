import { describe, expect, it } from "vitest";
import { computeAmendDisabledReason } from "./amendEligibility";

describe("computeAmendDisabledReason (specs/amend-last-commit.md FR-155)", () => {
  it("is eligible when HEAD is born and no operation is in progress", () => {
    expect(computeAmendDisabledReason({ isUnbornHead: false, inProgressOperation: null })).toBeNull();
  });

  it("AC11: is eligible regardless of detached HEAD — no detached-HEAD signal is even part of this check, matching the spec's 'no special-cased UI' for a detached HEAD", () => {
    // isUnbornHead/inProgressOperation are the only two conditions this function ever looks at
    // (mirroring exactly what git-core's amendCommit() itself refuses on, FR-149/FR-151) — a
    // detached HEAD is neither, so it can never appear disabled for that reason alone.
    expect(computeAmendDisabledReason({ isUnbornHead: false, inProgressOperation: null })).toBeNull();
  });

  it("AC4: disables on an unborn HEAD, naming the reason", () => {
    expect(computeAmendDisabledReason({ isUnbornHead: true, inProgressOperation: null })).toMatch(
      /no commits yet/i,
    );
  });

  it("AC5: disables while a merge/rebase/cherry-pick/revert/am/bisect is in progress, naming which one", () => {
    expect(computeAmendDisabledReason({ isUnbornHead: false, inProgressOperation: "rebase" })).toMatch(
      /rebase.*in progress/i,
    );
    expect(computeAmendDisabledReason({ isUnbornHead: false, inProgressOperation: "cherry-pick" })).toMatch(
      /cherry-pick.*in progress/i,
    );
  });

  it("an unborn HEAD takes precedence when both conditions are somehow true", () => {
    expect(computeAmendDisabledReason({ isUnbornHead: true, inProgressOperation: "merge" })).toMatch(
      /no commits yet/i,
    );
  });
});
