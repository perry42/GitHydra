// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { decideLanding, mergingWindowTitle, operationKey } from "./midMergeLanding";
import { makeRepoState } from "../test/fixtures";

describe("operationKey", () => {
  it("is null with no operation, and distinguishes merge heads and rebase steps", () => {
    expect(operationKey(makeRepoState())).toBeNull();
    const m = (sha: string) =>
      operationKey(
        makeRepoState({ inProgressOperation: "merge", inProgressOperationDetail: { kind: "merge", mergeHeadSha: sha } as never }),
      );
    expect(m("a")).not.toBe(m("b"));
    const r = (n: number) =>
      operationKey(
        makeRepoState({
          inProgressOperation: "rebase",
          inProgressOperationDetail: { kind: "rebase", currentStep: n, totalSteps: 3, ontoSha: "x" } as never,
        }),
      );
    expect(r(1)).not.toBe(r(2));
    expect(r(1)).toBe(r(1));
  });
});

describe("decideLanding (FR-580)", () => {
  const base = { handled: undefined, key: "merge:a", conflicted: 2, changesOpen: false, editorDirty: false };
  it("opens once, then never again for the same key", () => {
    expect(decideLanding(base)).toEqual({ markHandled: true, open: true });
    expect(decideLanding({ ...base, handled: new Set(["merge:a"]) })).toEqual({ markHandled: false, open: false });
    expect(decideLanding({ ...base, handled: new Set(["merge:a"]), key: "merge:b" }).open).toBe(true);
  });
  it("spends the key without opening when the drawer is open or an unsaved edit exists", () => {
    expect(decideLanding({ ...base, changesOpen: true })).toEqual({ markHandled: true, open: false });
    expect(decideLanding({ ...base, editorDirty: true })).toEqual({ markHandled: true, open: false });
  });
  it("does nothing without conflicts or an operation", () => {
    expect(decideLanding({ ...base, conflicted: 0 }).markHandled).toBe(false);
    expect(decideLanding({ ...base, key: null }).open).toBe(false);
  });
});

describe("mergingWindowTitle (FR-582)", () => {
  it("names the operation and count, and is null when resolved", () => {
    expect(mergingWindowTitle("repo", "merge", 3)).toBe("repo — Merging (3 conflicts)");
    expect(mergingWindowTitle("repo", "cherry-pick", 1)).toBe("repo — Cherry-picking (1 conflict)");
    expect(mergingWindowTitle("repo", "merge", 0)).toBeNull();
    expect(mergingWindowTitle("repo", null, 2)).toBeNull();
  });
});
