// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { computeCherryPickDisabledReason } from "./cherryPickEligibility";
import { makeRepoState } from "../test/fixtures";

describe("computeCherryPickDisabledReason (specs/cherry-pick.md FR-115)", () => {
  it("is eligible (null) for an ordinary non-merge selection on a normal repo", () => {
    expect(computeCherryPickDisabledReason(makeRepoState(), [{ parents: ["p1"] }], false)).toBeNull();
  });

  it("disables with a reason while busy (a cherry-pick already running)", () => {
    expect(computeCherryPickDisabledReason(makeRepoState(), [{ parents: [] }], true)).toMatch(/already running/i);
  });

  it("disables with a reason when another operation is already in progress (AC3)", () => {
    const state = makeRepoState({ inProgressOperation: "merge" });
    expect(computeCherryPickDisabledReason(state, [{ parents: ["p1"] }], false)).toMatch(/already in progress/i);
  });

  it("disables with a reason on a bare repository (AC10)", () => {
    const state = makeRepoState({ isBare: true });
    expect(computeCherryPickDisabledReason(state, [{ parents: ["p1"] }], false)).toMatch(/bare repository/i);
  });

  it("disables with a reason on an unborn-HEAD (zero-commit) repository (AC10)", () => {
    const state = makeRepoState({ isUnbornHead: true });
    expect(computeCherryPickDisabledReason(state, [{ parents: ["p1"] }], false)).toMatch(/no commits yet/i);
  });

  it("disables the WHOLE selection when any selected commit is a merge commit (AC9)", () => {
    const state = makeRepoState();
    expect(
      computeCherryPickDisabledReason(state, [{ parents: ["p1"] }, { parents: ["p1", "p2"] }], false),
    ).toMatch(/merge commit/i);
  });

  it("disables with a reason while repo state hasn't loaded yet", () => {
    expect(computeCherryPickDisabledReason(null, [{ parents: [] }], false)).toMatch(/still loading/i);
  });
});
