// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  choiceLabel,
  decisionStatus,
  deriveChoice,
  gateReason,
  roleSpans,
  sideNamesFromLabels,
  sideOfStage,
  takeSideLabel,
  textForChip,
} from "./conflictModel";

const label = (l: string, ref: string | null) => ({ label: l, refName: ref, sha: "abc1234" });

describe("sideNamesFromLabels (specs/edit-in-diff.md FR-559, FR-61)", () => {
  it("merge: the top section (stage 2) is Yours, the bottom is Incoming", () => {
    const n = sideNamesFromLabels({ ours: label("Your branch (main @ abc1234)", "main"), theirs: label("Incoming (feature @ def5678)", "feature") });
    expect(n.rebase).toBe(false);
    expect(n.top).toMatchObject({ short: "yours", role: "you", name: "main" });
    expect(n.bottom).toMatchObject({ short: "incoming", role: "oth", name: "feature" });
  });

  it("rebase inverts the roles: the top section is Onto and Yours is the SECOND section", () => {
    const n = sideNamesFromLabels({ ours: label("Onto (main @ abc1234)", "main"), theirs: label("Your branch (feature @ def5678)", "feature") });
    expect(n.rebase).toBe(true);
    expect(n.top).toMatchObject({ short: "onto", role: "oth", name: "main" });
    expect(n.bottom).toMatchObject({ short: "yours", role: "you", name: "feature" });
  });

  it("falls back to plain words, never bare ours/theirs, when no labels are known", () => {
    const n = sideNamesFromLabels(null);
    expect(n.top.label).toBe("Yours");
    expect(n.bottom.label).toBe("Incoming");
  });
});

describe("derived chip selection (FR-557)", () => {
  const ours = "a\nb\n";
  const theirs = "c\n";
  it("reads each preset back from its own text", () => {
    expect(deriveChoice(textForChip("ours", "file", ours, theirs), ours, theirs).key).toBe("ours");
    expect(deriveChoice(textForChip("theirs", "file", ours, theirs), ours, theirs).key).toBe("theirs");
    expect(deriveChoice(textForChip("neither", "file", ours, theirs), ours, theirs).key).toBe("neither");
    expect(deriveChoice("a\nb\nc\n", ours, theirs)).toEqual({ key: "both", order: "file" });
    expect(deriveChoice("c\na\nb\n", ours, theirs)).toEqual({ key: "both", order: "rev" });
  });

  it("anything else is Custom, and a CRLF buffer still matches an LF side", () => {
    expect(deriveChoice("a\nx\n", ours, theirs).key).toBe("custom");
    expect(deriveChoice("a\r\nb\r\n", ours, theirs).key).toBe("ours");
  });

  it("Both defaults to file order and the order option swaps it", () => {
    expect(textForChip("both", "file", ours, theirs)).toBe("a\nb\nc\n");
    expect(textForChip("both", "rev", ours, theirs)).toBe("c\na\nb\n");
  });
});

describe("tints and labels", () => {
  const names = sideNamesFromLabels({ ours: label("Onto (main @ abc1234)", "main"), theirs: label("Your branch (f @ def5678)", "f") });
  it("tints a Both result with the first section's role then the second's, in the chosen order", () => {
    expect(roleSpans({ key: "both", order: "file" }, "a\nb\n", "c\n", names)).toEqual([
      { role: "oth", lines: 2 },
      { role: "you", lines: 1 },
    ]);
    expect(roleSpans({ key: "both", order: "rev" }, "a\nb\n", "c\n", names)).toEqual([
      { role: "you", lines: 1 },
      { role: "oth", lines: 2 },
    ]);
    expect(roleSpans({ key: "neither", order: "file" }, "a\n", "b\n", names)).toEqual([]);
  });

  it("names the choice with the side's human word in a rebase", () => {
    expect(choiceLabel("theirs", names, "file")).toBe("Yours (f)");
    expect(choiceLabel("both", names, "rev")).toBe("both sides, yours first");
  });

  it("gate reason lists the remaining marker lines and truncates a long list", () => {
    expect(gateReason([])).toBeNull();
    expect(gateReason([4, 6])).toContain("lines 4, 6");
    expect(gateReason([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toContain("and 2 more");
  });

  it("status text counts what is left", () => {
    expect(decisionStatus(2, 3, "Yours", 1)).toBe("Conflict 2 of 3: Yours. 1 conflict unresolved.");
    expect(decisionStatus(3, 3, "Yours", 0)).toContain("No conflicts unresolved.");
  });
});

describe("one SideNames source for chips and the file-level Take buttons (B2)", () => {
  const lab = (label: string, refName: string) => ({ label, refName, sha: "abc1234" });
  const merge = sideNamesFromLabels({ ours: lab("Your branch (main @ abc1234)", "main"), theirs: lab("Incoming (feature @ abc1234)", "feature") });
  const rebase = sideNamesFromLabels({ ours: lab("Onto (main @ abc1234)", "main"), theirs: lab("Your branch (feature @ abc1234)", "feature") });

  it("in a merge stage 2 is Yours and stage 3 is Incoming", () => {
    expect(sideOfStage(merge, "ours").short).toBe("yours");
    expect(sideOfStage(merge, "theirs").short).toBe("incoming");
  });

  it("in a rebase stage 2 (git's --ours) is Onto and stage 3 is Yours, for the chip and the button alike", () => {
    expect(sideOfStage(rebase, "ours")).toBe(rebase.top);
    expect(sideOfStage(rebase, "theirs")).toBe(rebase.bottom);
    expect(sideOfStage(rebase, "ours").short).toBe("onto");
    expect(sideOfStage(rebase, "theirs").short).toBe("yours");
    expect(takeSideLabel(rebase, "ours", true)).toBe("Take Onto (main @ abc1234) and mark resolved");
    expect(takeSideLabel(rebase, "theirs", true)).toBe("Take Your branch (feature @ abc1234) and mark resolved");
  });

  it("names a side that would delete the file", () => {
    expect(takeSideLabel(merge, "ours", false)).toBe("Take Your branch (main @ abc1234) (delete file) and mark resolved");
  });
});
