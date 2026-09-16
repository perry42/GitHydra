// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { formatLastFetchedLabel, stashBranchCaption } from "./format";

describe("stashBranchCaption (specs/stash.md FR-94/edge cases)", () => {
  it("returns the branch name when git-core resolved one", () => {
    expect(stashBranchCaption({ branch: "main", message: "WIP on main: abc1234 x" })).toBe("main");
  });

  it("returns '(detached HEAD)' for git's own detached-HEAD default message", () => {
    expect(stashBranchCaption({ branch: null, message: "WIP on (no branch): abc1234 x" })).toBe("(detached HEAD)");
  });

  it("regression: never claims '(detached HEAD)' for a custom message — that null-reason is genuinely unknown, not detached (bug found via manual end-to-end testing)", () => {
    expect(stashBranchCaption({ branch: null, message: "my custom message" })).toBe("(unknown — custom message)");
  });
});

describe("formatLastFetchedLabel (specs/online-sync-fetch.md FR-326)", () => {
  it("reports 'never fetched this session' when null", () => {
    expect(formatLastFetchedLabel(null)).toBe("never fetched this session");
  });

  it("reports a relative 'fetched N ago' caption for a real timestamp", () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    expect(formatLastFetchedLabel(fiveMinutesAgo)).toBe("fetched 5 minutes ago");
  });
});
