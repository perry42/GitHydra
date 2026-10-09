// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { classifyConflictRender, whyNoBlockEditor } from "./conflictClassification";
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

describe("whyNoBlockEditor (specs/edit-in-diff.md FR-556)", () => {
  it("names the render mode first, then the probe's own wording, then a generic reason", () => {
    expect(whyNoBlockEditor(makeConflictedFile("a", { isSubmodule: true }), null)).toMatch(/commit pointer/);
    expect(whyNoBlockEditor(makeConflictedFile("a", { isBinary: true }), null)).toMatch(/no text blocks/);
    expect(whyNoBlockEditor(makeConflictedFile("a", { ours: null }), null)).toMatch(/deleted this file/);
    expect(whyNoBlockEditor(makeConflictedFile("a"), "Not UTF-8, edit externally")).toBe("Not UTF-8, edit externally.");
    expect(whyNoBlockEditor(makeConflictedFile("a"), "Conflicted file: use the conflict resolution view")).toMatch(/UTF-8 text within the size limit/);
  });
});
