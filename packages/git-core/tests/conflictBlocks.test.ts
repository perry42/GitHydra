// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import {
  classifyConflictMarkerLine,
  findConflictMarkerLines,
  parseConflictText,
  composeConflictResolution,
  classifyConflictResolution,
} from "../src/conflictBlocks";

describe("classifyConflictMarkerLine", () => {
  it("accepts 7 chars followed by a space or end of line", () => {
    expect(classifyConflictMarkerLine("<<<<<<<")).toBe("start");
    expect(classifyConflictMarkerLine("<<<<<<< HEAD")).toBe("start");
    expect(classifyConflictMarkerLine(">>>>>>> feature/x")).toBe("end");
    expect(classifyConflictMarkerLine("||||||| merged common ancestors")).toBe("base");
    expect(classifyConflictMarkerLine("|||||||")).toBe("base");
    expect(classifyConflictMarkerLine("=======")).toBe("separator");
  });

  it("rejects longer runs, glued text, indented markers and a labelled separator", () => {
    for (const l of ["<<<<<<<<", "<<<<<<<x", ">>>>>>>>", "========", "======= ", "=======x", " =======", "<<<<<< x", "=== ===", "", "|||||||x"]) {
      expect(classifyConflictMarkerLine(l), JSON.stringify(l)).toBeNull();
    }
  });
});

describe("findConflictMarkerLines", () => {
  it("returns 1-based lines across LF, CRLF and lone CR", () => {
    expect(findConflictMarkerLines("a\r\n<<<<<<< x\r\n=======\r\n>>>>>>> y\r\n")).toEqual([2, 3, 4]);
    expect(findConflictMarkerLines("a\n=======\n")).toEqual([2]);
    expect(findConflictMarkerLines("x\r<<<<<<< a\r")).toEqual([2]);
  });
  it("ignores a markdown-style long underline and ordinary prose", () => {
    expect(findConflictMarkerLines("Title\n==========\nbody =======\n")).toEqual([]);
  });
});

describe("parseConflictText", () => {
  it("parses a two-way block with offsets and whole-line regions", () => {
    const text = "pre\n<<<<<<< HEAD\nours1\nours2\n=======\ntheirs\n>>>>>>> feature\npost\n";
    const { blocks, strayMarkers } = parseConflictText(text);
    expect(strayMarkers).toEqual([]);
    expect(blocks).toHaveLength(1);
    const b = blocks[0]!;
    expect(b.index).toBe(0);
    expect(b.startMarker).toMatchObject({ kind: "start", line: 2, label: "HEAD" });
    expect(b.endMarker).toMatchObject({ kind: "end", line: 7, label: "feature" });
    expect(b.ours.text).toBe("ours1\nours2\n");
    expect(b.theirs.text).toBe("theirs\n");
    expect(b.base).toBeNull();
    expect(text.slice(b.from, b.toWithEol)).toBe("<<<<<<< HEAD\nours1\nours2\n=======\ntheirs\n>>>>>>> feature\n");
    expect(text.slice(b.from, b.to)).toBe("<<<<<<< HEAD\nours1\nours2\n=======\ntheirs\n>>>>>>> feature");
    expect(b.ours).toMatchObject({ firstLine: 3, lastLine: 4 });
    expect(b.theirs).toMatchObject({ firstLine: 6, lastLine: 6 });
    // replacing the whole block with a side leaves a well-formed file
    expect(text.slice(0, b.from) + b.theirs.text + text.slice(b.toWithEol)).toBe("pre\ntheirs\npost\n");
  });

  it("parses diff3 blocks with a base region", () => {
    const text = "<<<<<<< ours\nA\n||||||| base\nB\n=======\nC\n>>>>>>> theirs\n";
    const b = parseConflictText(text).blocks[0]!;
    expect(b.ours.text).toBe("A\n");
    expect(b.base!.text).toBe("B\n");
    expect(b.theirs.text).toBe("C\n");
    expect(b.baseMarker!.label).toBe("base");
  });

  it("handles empty sides", () => {
    const text = "<<<<<<< a\n=======\nnew\n>>>>>>> b\n<<<<<<< a\nold\n=======\n>>>>>>> b\n";
    const { blocks, strayMarkers } = parseConflictText(text);
    expect(strayMarkers).toEqual([]);
    expect(blocks.map((b) => [b.ours.text, b.theirs.text])).toEqual([["", "new\n"], ["old\n", ""]]);
    expect(blocks[0]!.ours.from).toBe(blocks[0]!.ours.to);
    expect(blocks[0]!.ours.lastLine).toBeLessThan(blocks[0]!.ours.firstLine);
    expect(blocks.map((b) => b.index)).toEqual([0, 1]);
  });

  it("keeps CRLF terminators inside region text and offsets", () => {
    const text = "<<<<<<< a\r\nx\r\n=======\r\ny\r\n>>>>>>> b\r\n";
    const b = parseConflictText(text).blocks[0]!;
    expect(b.ours.text).toBe("x\r\n");
    expect(b.theirs.text).toBe("y\r\n");
    expect(b.toWithEol).toBe(text.length);
    expect(b.to).toBe(text.length - 2);
  });

  it("handles a block whose end marker is the last line without a terminator", () => {
    const text = "<<<<<<< a\nx\n=======\ny\n>>>>>>> b";
    const b = parseConflictText(text).blocks[0]!;
    expect(b.to).toBe(text.length);
    expect(b.toWithEol).toBe(text.length);
  });

  it("reports unterminated, orphaned and misordered markers as strays, never dropping them", () => {
    const cases: [string, number[]][] = [
      ["<<<<<<< a\nx\n=======\ny\n", [1, 3]], // no end marker
      ["x\n=======\ny\n", [2]],
      ["x\n>>>>>>> b\n", [2]],
      ["<<<<<<< a\nx\n>>>>>>> b\n", [1, 3]], // end without separator
      ["<<<<<<< a\n<<<<<<< b\nx\n=======\ny\n>>>>>>> c\n", [1]], // nested start abandons the first
      ["<<<<<<< a\nx\n=======\ny\n=======\nz\n>>>>>>> b\n", [5]], // second separator
      ["<<<<<<< a\nx\n=======\ny\n||||||| b\n>>>>>>> c\n", [5]], // base after separator
    ];
    for (const [text, strayLines] of cases) {
      const { strayMarkers, blocks } = parseConflictText(text);
      expect(strayMarkers.map((m) => m.line), JSON.stringify(text)).toEqual(strayLines);
      // invariant: every marker line is either in a block or stray
      const accounted = blocks.length * (text.includes("|||||||") ? 0 : 3) + strayMarkers.length;
      if (!text.includes("|||||||")) expect(accounted, JSON.stringify(text)).toBe(findConflictMarkerLines(text).length);
    }
  });

  it("returns nothing for a clean file and for an empty string", () => {
    expect(parseConflictText("just text\n")).toEqual({ blocks: [], strayMarkers: [] });
    expect(parseConflictText("")).toEqual({ blocks: [], strayMarkers: [] });
  });

  it("turns an edited marker line into text and strays the rest of its block", () => {
    const edited = "<<<<<<<HEAD\nx\n=======\ny\n>>>>>>> b\n";
    const { blocks, strayMarkers } = parseConflictText(edited);
    expect(blocks).toEqual([]);
    expect(strayMarkers.map((m) => m.kind)).toEqual(["separator", "end"]);
  });

  it("handles non-ASCII content and labels with correct UTF-16 offsets", () => {
    const text = "<<<<<<< ענף-א\nשלום 😀\n=======\nעולם\n>>>>>>> ענף-ב\n";
    const b = parseConflictText(text).blocks[0]!;
    expect(b.startMarker.label).toBe("ענף-א");
    expect(text.slice(b.ours.from, b.ours.to)).toBe("שלום 😀\n");
  });
});

describe("compose / classify resolution", () => {
  const ours = "o1\no2\n";
  const theirs = "t1\n";
  it("round-trips every preset", () => {
    expect(classifyConflictResolution(composeConflictResolution("ours", ours, theirs), ours, theirs)).toBe("ours");
    expect(classifyConflictResolution(composeConflictResolution("theirs", ours, theirs), ours, theirs)).toBe("theirs");
    expect(classifyConflictResolution("o1\no2\nt1\n", ours, theirs)).toBe("both-ours-first");
    expect(classifyConflictResolution("t1\no1\no2\n", ours, theirs)).toBe("both-theirs-first");
    expect(classifyConflictResolution("", ours, theirs)).toBe("neither");
  });
  it("is custom for anything else, including a one-line tweak", () => {
    expect(classifyConflictResolution("o1\n", ours, theirs)).toBe("custom");
    expect(classifyConflictResolution("o1\no2 changed\n", ours, theirs)).toBe("custom");
  });
  it("matches across line-ending styles", () => {
    expect(classifyConflictResolution("o1\r\no2\r\n", ours, theirs)).toBe("ours");
  });
  it("breaks ties in documented order when a side is empty", () => {
    expect(classifyConflictResolution("t1\n", "", theirs)).toBe("theirs");
    expect(classifyConflictResolution("", "", theirs)).toBe("ours");
  });
});
