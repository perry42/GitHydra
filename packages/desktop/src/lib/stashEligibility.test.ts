import { describe, expect, it } from "vitest";
import { computeCreateStashDisabledReason } from "./stashEligibility";

const readyStatus = { hasChanges: true, staged: 1, unstaged: 0, untracked: 0, conflicted: 0 };

describe("computeCreateStashDisabledReason (FR-100)", () => {
  it("is eligible when there is at least one non-conflicted changed file", () => {
    expect(computeCreateStashDisabledReason({ isBare: false, isUnbornHead: false, workingDirStatus: readyStatus })).toBeNull();
  });

  it("disables on a bare repository, naming the reason", () => {
    expect(
      computeCreateStashDisabledReason({ isBare: true, isUnbornHead: false, workingDirStatus: null }),
    ).toMatch(/bare repository/i);
  });

  it("disables on an unborn HEAD, naming the reason", () => {
    expect(
      computeCreateStashDisabledReason({ isBare: false, isUnbornHead: true, workingDirStatus: null }),
    ).toMatch(/no commits yet/i);
  });

  it("disables on a clean working tree", () => {
    const clean = { hasChanges: false, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
    expect(computeCreateStashDisabledReason({ isBare: false, isUnbornHead: false, workingDirStatus: clean })).toMatch(
      /no changes to stash/i,
    );
  });

  it("disables when ANY conflict exists repo-wide, even alongside other eligible changes (discovery (a))", () => {
    const mixed = { hasChanges: true, staged: 2, unstaged: 1, untracked: 0, conflicted: 1 };
    expect(computeCreateStashDisabledReason({ isBare: false, isUnbornHead: false, workingDirStatus: mixed })).toMatch(
      /unresolved conflicts/i,
    );
  });

  it("disables when every changed path is conflicted", () => {
    const allConflicted = { hasChanges: true, staged: 0, unstaged: 0, untracked: 0, conflicted: 3 };
    expect(
      computeCreateStashDisabledReason({ isBare: false, isUnbornHead: false, workingDirStatus: allConflicted }),
    ).toMatch(/unresolved conflicts/i);
  });
});
