// SPDX-License-Identifier: GPL-3.0-or-later
import { createRef } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { CodeEditor, type CodeEditorHandle } from "./CodeEditor";
import { polyfillCodeMirrorDom, viewOf } from "../../test/codemirrorDom";
import { recoverBlocks } from "../../lib/conflictRecover";
import { EMPTY_SUMMARY, sideNamesFromLabels, type ConflictEvent, type ConflictSummary } from "../../lib/conflictModel";

beforeAll(polyfillCodeMirrorDom);

const TEXT = [
  "head",
  "<<<<<<< HEAD",
  "top1",
  "=======",
  "bot1",
  ">>>>>>> feature",
  "mid",
  "<<<<<<< HEAD",
  "top2",
  "top2b",
  "=======",
  "bot2",
  ">>>>>>> feature",
  "tail",
  "",
].join("\n");

const label = (l: string, ref: string) => ({ label: l, refName: ref, sha: "abc1234" });
const MERGE = sideNamesFromLabels({ ours: label("Your branch (main @ abc1234)", "main"), theirs: label("Incoming (feature @ def5678)", "feature") });
const REBASE = sideNamesFromLabels({ ours: label("Onto (main @ abc1234)", "main"), theirs: label("Your branch (feature @ def5678)", "feature") });

function mount(over: { names?: typeof MERGE; sidesOk?: boolean; text?: string } = {}) {
  const ref = createRef<CodeEditorHandle>();
  const events: ConflictEvent[] = [];
  let summary: ConflictSummary = EMPTY_SUMMARY;
  const utils = render(
    <CodeEditor
      ref={ref}
      initialValue={over.text ?? TEXT}
      ariaLabel="Editing f.txt"
      indentUnit="  "
      conflict={{
        names: over.names ?? MERGE,
        sidesOk: over.sidesOk ?? true,
        sidesReason: "stage unreadable",
        onSummary: (s) => {
          summary = s;
        },
        onEvent: (e) => events.push(e),
      }}
    />,
  );
  const view = viewOf(utils.container);
  const row = (n: number) => utils.container.querySelector<HTMLElement>(`[role=group][aria-label="Resolution for conflict ${n}"]`)!;
  const chip = (n: number, key: string) => row(n).querySelector<HTMLButtonElement>(`[data-chip="${key}"]`);
  const pressed = (n: number) => [...row(n).querySelectorAll<HTMLElement>("[aria-pressed=true]")].map((b) => b.getAttribute("data-chip"));
  return { ref, view, events, summary: () => summary, row, chip, pressed, ...utils };
}

describe("conflict block layer (specs/edit-in-diff.md FR-556..FR-564)", () => {
  it("shows one chip row per block, nothing ticked, and the marker lines in the summary", () => {
    const m = mount();
    expect(m.row(1)).toBeTruthy();
    expect(m.row(2)).toBeTruthy();
    expect(m.pressed(1)).toEqual([]);
    const s = m.summary();
    expect(s.total).toBe(2);
    expect(s.unresolved).toBe(2);
    expect(s.markerLines).toEqual([2, 4, 6, 8, 11, 13]);
  });

  it("names the chips after the sections, and in a rebase the section order is Onto then Yours (FR-559)", () => {
    const merge = mount();
    expect(merge.chip(1, "ours")!.getAttribute("aria-label")).toBe("Yours, main");
    expect(merge.chip(1, "theirs")!.getAttribute("aria-label")).toBe("Incoming, feature");
    merge.unmount();
    const rebase = mount({ names: REBASE });
    expect(rebase.chip(1, "ours")!.getAttribute("aria-label")).toBe("Onto, main");
    expect(rebase.chip(1, "theirs")!.getAttribute("aria-label")).toBe("Yours, feature");
  });

  it("a chip click rewrites only its block, ticks exactly that chip, and is one undo step", () => {
    const m = mount();
    act(() => m.chip(1, "ours")!.click());
    expect(m.ref.current!.getValue()).toBe(["head", "top1", "mid", "<<<<<<< HEAD", "top2", "top2b", "=======", "bot2", ">>>>>>> feature", "tail", ""].join("\n"));
    expect(m.pressed(1)).toEqual(["ours"]);
    expect(m.pressed(2)).toEqual([]);
    expect(m.summary().unresolved).toBe(1);
    act(() => m.ref.current!.getConflict()!.undo());
    expect(m.ref.current!.getValue()).toBe(TEXT);
    expect(m.pressed(1)).toEqual([]);
    expect(m.summary().unresolved).toBe(2);
  });

  it("any chip can be re-clicked, and the tick follows the text (Incoming, Both, Neither)", () => {
    const m = mount();
    act(() => m.chip(1, "theirs")!.click());
    expect(m.pressed(1)).toEqual(["theirs"]);
    act(() => m.chip(1, "both")!.click());
    expect(m.pressed(1)).toEqual(["both"]);
    expect(m.view.state.doc.line(2).text).toBe("top1");
    expect(m.view.state.doc.line(3).text).toBe("bot1");
    act(() => m.chip(1, "neither")!.click());
    expect(m.pressed(1)).toEqual(["neither"]);
    expect(m.ref.current!.getValue()).not.toContain("top1");
    expect(m.ref.current!.getValue()).not.toContain("bot1");
  });

  it("Both has a visible order toggle that swaps the sections", () => {
    const m = mount();
    act(() => m.chip(2, "both")!.click());
    expect(m.view.state.doc.toString()).toContain("top2\ntop2b\nbot2\ntail");
    act(() => m.chip(2, "order")!.click());
    expect(m.view.state.doc.toString()).toContain("bot2\ntop2\ntop2b\ntail");
    expect(m.pressed(2)).toEqual(["both"]);
  });

  it("hand-editing a result makes the tick Custom, and the custom text is remembered per block (FR-560)", () => {
    const m = mount();
    act(() => m.chip(1, "ours")!.click());
    const at = m.view.state.doc.toString().indexOf("top1") + 4;
    act(() => m.view.dispatch({ changes: { from: at, insert: " edited" } }));
    expect(m.pressed(1)).toEqual(["custom"]);
    act(() => m.chip(1, "theirs")!.click());
    expect(m.pressed(1)).toEqual(["theirs"]);
    expect(m.chip(1, "custom")!.querySelector(".gh-cf-kdot")).not.toBeNull();
    act(() => m.chip(1, "custom")!.click());
    expect(m.view.state.doc.toString()).toContain("top1 edited");
    expect(m.pressed(1)).toEqual(["custom"]);
  });

  it("Reset returns the block to its markers in one undo step and forgets the custom text (FR-561)", () => {
    const m = mount();
    act(() => m.chip(1, "ours")!.click());
    act(() => m.chip(1, "reset")!.click());
    expect(m.ref.current!.getValue()).toBe(TEXT);
    expect(m.summary().unresolved).toBe(2);
    act(() => m.ref.current!.getConflict()!.undo());
    expect(m.pressed(1)).toEqual(["ours"]);
  });

  it("auto-advances only after the FIRST decision on a block (FR-562)", () => {
    const m = mount();
    act(() => m.chip(1, "ours")!.click());
    expect(m.events.at(-1)).toMatchObject({ type: "advance", fromN: 1, toN: 2, total: 2 });
    const before = m.events.length;
    act(() => m.chip(1, "theirs")!.click());
    expect(m.events.length).toBe(before + 1);
    expect(m.events.at(-1)!.type).toBe("status");
    act(() => m.chip(2, "ours")!.click());
    expect(m.events.at(-1)!.type).toBe("all-decided");
    expect(m.summary().markerLines).toEqual([]);
  });

  it("typing a marker out of shape leaves strays and keeps the gate shut (FR-564)", () => {
    const m = mount();
    const at = m.view.state.doc.toString().indexOf("=======");
    act(() => m.view.dispatch({ changes: { from: at, to: at + 7, insert: "edited" } }));
    expect(m.summary().strayCount).toBeGreaterThan(0);
    expect(m.summary().markerLines.length).toBeGreaterThan(0);
    expect(m.summary().unresolved).toBe(1);
  });

  it("roving keys: arrows move inside the row, Space picks, Enter edits (physical codes)", () => {
    const m = mount();
    const first = m.chip(1, "ours")!;
    first.focus();
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(m.chip(1, "theirs"));
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(m.chip(1, "edit"));
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(m.chip(1, "ours"));
    act(() => {
      m.chip(1, "theirs")!.focus();
      m.chip(1, "theirs")!.dispatchEvent(new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true, cancelable: true }));
    });
    expect(m.pressed(1)).toEqual(["theirs"]);
    // Hebrew layout: key is not "e", but the physical code is.
    act(() => {
      m.chip(1, "neither")!.focus();
      m.chip(1, "neither")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ק", code: "KeyE", bubbles: true, cancelable: true }));
    });
    const line2 = m.view.state.doc.line(2);
    expect(line2.text).toBe("bot1");
    expect(m.view.state.selection.main.head).toBe(line2.to);
  });

  it("Edit on an undecided block seeds both sides in file order as one undo step, with the caret in the result", () => {
    const m = mount();
    act(() => m.chip(1, "edit")!.click());
    expect(m.view.state.doc.line(2).text).toBe("top1");
    expect(m.view.state.doc.line(3).text).toBe("bot1");
    expect(m.pressed(1)).toEqual(["both"]);
    act(() => m.ref.current!.getConflict()!.undo());
    expect(m.ref.current!.getValue()).toBe(TEXT);
  });

  it("Esc inside a block's text goes back to its chip row; elsewhere it is left to the pane (FR-557)", () => {
    const m = mount();
    act(() => m.chip(1, "ours")!.click());
    act(() => m.view.dispatch({ selection: { anchor: m.view.state.doc.line(2).from } }));
    const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => {
      m.view.contentDOM.dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(true);
    act(() => m.view.dispatch({ selection: { anchor: 0 } }));
    const outside = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => {
      m.view.contentDOM.dispatchEvent(outside);
    });
    expect(m.view.state.selection.main.head).toBe(0);
  });

  it("chips are aria-pressed toggle buttons; the disabled sides carry the reason (FR-559)", () => {
    const m = mount({ sidesOk: false });
    expect(m.chip(1, "ours")!.getAttribute("aria-pressed")).toBe("false");
    expect(m.chip(1, "ours")!.getAttribute("aria-disabled")).toBe("true");
    expect(m.chip(1, "ours")!.title).toBe("stage unreadable");
    act(() => m.chip(1, "ours")!.click());
    expect(m.ref.current!.getValue()).toBe(TEXT);
    expect(m.chip(1, "neither")!.getAttribute("aria-disabled")).toBeNull();
  });

  it("hover or focus shows a passive preview and changes nothing", () => {
    const m = mount();
    m.chip(1, "theirs")!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    const pv = m.row(1).closest(".gh-cf-lens")!.querySelector<HTMLElement>(".gh-cf-pv")!;
    expect(pv.hidden).toBe(false);
    expect(pv.textContent).toContain("bot1");
    expect(m.ref.current!.getValue()).toBe(TEXT);
  });

  it("a row re-render keeps the same buttons, so a press that moved focus first still produces its click", async () => {
    const m = mount();
    const before = m.chip(2, "theirs")!;
    await act(async () => {
      before.focus(); // focusin makes row 2 current and re-renders it, between mousedown and mouseup
      await Promise.resolve();
    });
    expect(m.summary().currentId).toBe(m.summary().blocks[1]!.id);
    expect(m.chip(2, "theirs")).toBe(before);
    act(() => before.click());
    expect(m.pressed(2)).toEqual(["theirs"]);
  });

  it("navigation moves the current conflict and F3 wraps", () => {
    const m = mount();
    const api = m.ref.current!.getConflict()!;
    act(() => api.next());
    expect(m.summary().currentId).toBe(m.summary().blocks[1]!.id);
    act(() => api.next());
    expect(m.summary().currentId).toBe(m.summary().blocks[0]!.id);
    act(() => api.prev());
    expect(m.summary().currentId).toBe(m.summary().blocks[1]!.id);
  });

  it("a restored buffer shows the ticks of blocks already decided in it, derived from the text (FR-557, FR-565)", () => {
    const merged = TEXT.replace("=======\nbot1", "||||||| base\nold1\n=======\nbot1").replace("=======\nbot2", "||||||| base\nold2\n=======\nbot2");
    // Block 1 is Incoming, block 2 was hand-edited.
    const restored = ["head", "bot1", "mid", "hand written", "tail", ""].join("\n");
    const ref = createRef<CodeEditorHandle>();
    let summary: ConflictSummary = EMPTY_SUMMARY;
    const { container } = render(
      <CodeEditor
        ref={ref}
        initialValue={restored}
        ariaLabel="x"
        indentUnit="  "
        conflict={{ names: MERGE, sidesOk: true, onSummary: (s) => (summary = s), onEvent: vi.fn(), recover: (t) => recoverBlocks(merged, t) }}
      />,
    );
    const pressed = (n: number) =>
      [...container.querySelectorAll<HTMLElement>(`[aria-label="Resolution for conflict ${n}"] [aria-pressed=true]`)].map((b) => b.getAttribute("data-chip"));
    expect(summary.total).toBe(2);
    expect(summary.unresolved).toBe(0);
    expect(pressed(1)).toEqual(["theirs"]);
    expect(pressed(2)).toEqual(["custom"]);
    // The recovered sides make the other chips work, and Custom is remembered as soon as it is the result.
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Resolution for conflict 2"] [data-chip="ours"]')!.click());
    expect(ref.current!.getValue()).toContain("top2\ntop2b\ntail");
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Resolution for conflict 2"] [data-chip="custom"]')!.click());
    expect(ref.current!.getValue()).toContain("hand written");
    // Reset rebuilds the markers from the recovered sides.
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Resolution for conflict 1"] [data-chip="reset"]')!.click());
    expect(ref.current!.getValue()).toContain("<<<<<<< main\ntop1\n=======\nbot1\n>>>>>>> feature\n");
    expect(summary.unresolved).toBe(1);
  });

  it("disable() removes the block layer and leaves the text alone", () => {
    const m = mount();
    act(() => m.ref.current!.getConflict()!.disable());
    expect(m.container.querySelector(".gh-cf-lens")).toBeNull();
    expect(m.ref.current!.getValue()).toBe(TEXT);
    expect(m.summary().enabled).toBe(false);
  });

  it("a disk reload forgets remembered sides and re-reads the blocks from the new text", () => {
    const m = mount();
    act(() => m.chip(1, "ours")!.click());
    act(() => m.ref.current!.replaceAll(TEXT));
    expect(m.pressed(1)).toEqual([]);
    expect(m.summary().unresolved).toBe(2);
  });

  it("replaces CRLF-free sides inside a verbatim (mixed EOL) buffer without losing carriage returns", () => {
    const text = TEXT.replace("top1\n", "top1\r\n");
    const ref = createRef<CodeEditorHandle>();
    const { container } = render(
      <CodeEditor
        ref={ref}
        initialValue={text}
        verbatimBreaks
        ariaLabel="x"
        indentUnit="  "
        conflict={{ names: MERGE, sidesOk: true, onSummary: vi.fn(), onEvent: vi.fn() }}
      />,
    );
    const chip = container.querySelector<HTMLButtonElement>('[aria-label="Resolution for conflict 1"] [data-chip="ours"]')!;
    act(() => chip.click());
    expect(ref.current!.getValue()).toContain("top1\r\nmid");
  });
});
