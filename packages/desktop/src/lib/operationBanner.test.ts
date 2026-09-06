// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { InProgressOperationDetail } from "@githydra/git-core";
import { describeInProgressOperationText } from "./operationBanner";

describe("describeInProgressOperationText (FR-58/FR-60/FR-61)", () => {
  it("describes a merge with the incoming ref and current branch", () => {
    const detail: InProgressOperationDetail = {
      kind: "merge",
      headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      headSubject: "HEAD subject",
      mergeHeadSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      mergeHeadSubject: null,
      incomingRef: "origin/main",
    };
    expect(describeInProgressOperationText(detail, "feature-x")).toBe("Merging origin/main into feature-x");
  });

  it("falls back to a short SHA when the incoming ref can't be resolved from MERGE_MSG", () => {
    const detail: InProgressOperationDetail = {
      kind: "merge",
      headSha: null,
      headSubject: null,
      mergeHeadSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      mergeHeadSubject: null,
      incomingRef: null,
    };
    expect(describeInProgressOperationText(detail, "feature-x")).toBe("Merging bbbbbbb into feature-x");
  });

  it("describes a rebase with the original branch, onto ref, and step count (AC2)", () => {
    const detail: InProgressOperationDetail = {
      kind: "rebase",
      originalBranch: "feature-x",
      ontoSha: "cccccccccccccccccccccccccccccccccccccccc",
      ontoSubject: null,
      ontoRef: "main",
      currentCommitSha: "dddddddddddddddddddddddddddddddddddddddd",
      currentCommitSubject: "Do the thing",
      currentStep: 2,
      totalSteps: 5,
    };
    expect(describeInProgressOperationText(detail, "feature-x")).toBe(
      "Rebasing feature-x onto main — step 2 of 5",
    );
  });

  it("labels a detached-HEAD rebase explicitly rather than showing null/undefined", () => {
    const detail: InProgressOperationDetail = {
      kind: "rebase",
      originalBranch: null,
      ontoSha: null,
      ontoSubject: null,
      ontoRef: null,
      currentCommitSha: null,
      currentCommitSubject: null,
      currentStep: null,
      totalSteps: null,
    };
    expect(describeInProgressOperationText(detail, null)).toBe(
      "Rebasing a detached HEAD onto an unresolved ref",
    );
  });

  it("describes a cherry-pick with the short SHA and subject", () => {
    const detail: InProgressOperationDetail = {
      kind: "cherry-pick",
      targetSha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      targetSubject: "Fix off-by-one",
      isEmptyResult: false,
      remainingAfterCurrent: null,
    };
    expect(describeInProgressOperationText(detail, null)).toBe(
      'Cherry-picking a1b2c3d "Fix off-by-one"',
    );
  });

  it("specs/cherry-pick.md FR-117: appends '(N more queued)' for a multi-commit sequence with commits still queued (AC5)", () => {
    const detail: InProgressOperationDetail = {
      kind: "cherry-pick",
      targetSha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      targetSubject: "Fix off-by-one",
      isEmptyResult: false,
      remainingAfterCurrent: 2,
    };
    expect(describeInProgressOperationText(detail, null)).toBe(
      'Cherry-picking a1b2c3d "Fix off-by-one" (2 more queued)',
    );
  });

  it("shows no queued-count suffix when this is the last queued commit (remainingAfterCurrent: 0) — never a misleading '0 more queued'", () => {
    const detail: InProgressOperationDetail = {
      kind: "cherry-pick",
      targetSha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      targetSubject: "Fix off-by-one",
      isEmptyResult: false,
      remainingAfterCurrent: 0,
    };
    expect(describeInProgressOperationText(detail, null)).toBe(
      'Cherry-picking a1b2c3d "Fix off-by-one"',
    );
  });

  it("describes a revert with the short SHA and subject", () => {
    const detail: InProgressOperationDetail = {
      kind: "revert",
      targetSha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      targetSubject: "Fix off-by-one",
    };
    expect(describeInProgressOperationText(detail, null)).toBe('Reverting a1b2c3d "Fix off-by-one"');
  });

  it("describes an am step count when known", () => {
    const detail: InProgressOperationDetail = { kind: "am", currentStep: 1, totalSteps: 3 };
    expect(describeInProgressOperationText(detail, null)).toBe("Applying patches (am) — step 1 of 3");
  });

  it("returns no rich copy for bisect or a null detail (StatusBanner falls back to the generic label)", () => {
    expect(describeInProgressOperationText({ kind: "bisect" }, null)).toBe("");
    expect(describeInProgressOperationText(null, null)).toBe("");
  });
});
