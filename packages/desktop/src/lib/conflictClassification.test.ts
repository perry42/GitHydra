import { describe, expect, it } from "vitest";
import { acceptActionLabel, classifyConflictRender } from "./conflictClassification";
import { makeConflictedFile } from "../test/fixtures";

describe("classifyConflictRender (FR-63/76-80)", () => {
  it("classifies a submodule gitlink regardless of stage presence (FR-77)", () => {
    const file = makeConflictedFile("libs/thing", { isSubmodule: true });
    expect(classifyConflictRender(file).mode).toBe("submodule");
  });

  it("classifies a binary file (FR-80)", () => {
    const file = makeConflictedFile("image.png", { isBinary: true });
    expect(classifyConflictRender(file).mode).toBe("binary");
  });

  it("classifies deleted-by-us as delete-modify with theirs as the surviving side (FR-78)", () => {
    const file = makeConflictedFile("a.ts", { ours: null });
    const info = classifyConflictRender(file);
    expect(info.mode).toBe("delete-modify");
    expect(info.deletedSide).toBe("ours");
  });

  it("classifies deleted-by-them as delete-modify with ours as the surviving side (FR-78)", () => {
    const file = makeConflictedFile("a.ts", { theirs: null });
    const info = classifyConflictRender(file);
    expect(info.mode).toBe("delete-modify");
    expect(info.deletedSide).toBe("theirs");
  });

  it("classifies an add/add (both sides added, no common ancestor) as both-added", () => {
    const file = makeConflictedFile("new.ts", { base: null });
    expect(classifyConflictRender(file).mode).toBe("both-added");
  });

  it("classifies a path only one side ever had (no base, no counterpart) as add-only", () => {
    const file = makeConflictedFile("new.ts", { base: null, theirs: null });
    expect(classifyConflictRender(file).mode).toBe("add-only");
  });

  it("classifies the common both-modified shape as text", () => {
    const file = makeConflictedFile("a.ts");
    expect(classifyConflictRender(file).mode).toBe("text");
  });
});

describe("acceptActionLabel (FR-61/FR-78)", () => {
  const labels = {
    ours: { label: "Your branch (feature-x @ a1b2c3d)", refName: "feature-x", sha: "a1b2c3d" },
    theirs: { label: "Incoming (main @ d4e5f6a)", refName: "main", sha: "d4e5f6a" },
  };

  it("never renders the bare word 'ours'/'theirs' — always the concrete label", () => {
    expect(acceptActionLabel("ours", true, labels)).toBe("Accept Your branch (feature-x @ a1b2c3d)");
    expect(acceptActionLabel("theirs", true, labels)).not.toMatch(/\btheirs\b/i);
  });

  it("qualifies a side with no content as a delete", () => {
    expect(acceptActionLabel("ours", false, labels)).toBe("Accept Your branch (feature-x @ a1b2c3d) (delete file)");
  });

  it("falls back gracefully when labels haven't loaded yet", () => {
    expect(acceptActionLabel("ours", true, null)).toBe("Accept our side");
  });
});
