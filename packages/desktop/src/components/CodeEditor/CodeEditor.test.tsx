// SPDX-License-Identifier: GPL-3.0-or-later
import { createRef } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { CodeEditor, type CodeEditorHandle, type CodeEditorProps } from "./CodeEditor";
import { polyfillCodeMirrorDom, typeAtEnd, viewOf } from "../../test/codemirrorDom";

beforeAll(polyfillCodeMirrorDom);

function mount(props: Partial<CodeEditorProps> = {}) {
  const ref = createRef<CodeEditorHandle>();
  const utils = render(<CodeEditor ref={ref} initialValue={"a\nb\nc"} ariaLabel="Editing f.txt" describedBy="foot" indentUnit="  " {...props} />);
  return { ref, ...utils };
}

const key = (el: HTMLElement, init: KeyboardEventInit) => el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));

describe("CodeEditor (specs/edit-in-diff.md FR-469, FR-538)", () => {
  it("exposes an accessible name and description on the editing surface", () => {
    const { container } = mount();
    const content = container.querySelector(".cm-content")!;
    expect(content.getAttribute("aria-label")).toBe("Editing f.txt");
    expect(content.getAttribute("aria-describedby")).toBe("foot");
    expect(content.getAttribute("aria-multiline")).toBe("true");
  });

  it("tracks dirty against the saved baseline, including text typed while a write was in flight", () => {
    const onDirtyChange = vi.fn();
    const { ref, container } = mount({ onDirtyChange });
    typeAtEnd(container, "1");
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    const snap = ref.current!.snapshot();
    typeAtEnd(container, "2");
    ref.current!.markSaved(snap);
    expect(ref.current!.isDirty()).toBe(true);
    ref.current!.markSaved(ref.current!.snapshot());
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(ref.current!.getValue()).toBe("a\nb\nc12");
  });

  it("replaceAll keeps the caret's line and column, leaves the buffer clean and is not undoable", () => {
    const { ref, container } = mount();
    const view = viewOf(container);
    view.dispatch({ selection: { anchor: 3 } }); // line 2, col 1
    typeAtEnd(container, "x");
    ref.current!.replaceAll("A\nBBB\nC\nD");
    expect(ref.current!.isDirty()).toBe(false);
    expect(ref.current!.getCursor()).toEqual({ line: 3, column: 1 });
    expect(ref.current!.getValue()).toBe("A\nBBB\nC\nD");
  });

  it("Tab indents every selected line, Shift+Tab outdents, with the file's indent unit", () => {
    const { container } = mount({ indentUnit: "\t" });
    const view = viewOf(container);
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    key(view.contentDOM, { key: "Tab" });
    expect(view.state.doc.toString()).toBe("\ta\n\tb\n\tc");
    key(view.contentDOM, { key: "Tab", shiftKey: true });
    expect(view.state.doc.toString()).toBe("a\nb\nc");
  });

  it("Tab on a caret inserts the unit instead of leaving the editor", () => {
    const { container } = mount({ indentUnit: "    " });
    const view = viewOf(container);
    view.dispatch({ selection: { anchor: 1 } });
    key(view.contentDOM, { key: "Tab" });
    expect(view.state.doc.line(1).text).toBe("a    ");
  });

  it("Esc calls onEscape; Ctrl+M (by physical key) calls onFocusToolbar", () => {
    const onEscape = vi.fn();
    const onFocusToolbar = vi.fn();
    const { container } = mount({ onEscape, onFocusToolbar });
    const view = viewOf(container);
    key(view.contentDOM, { key: "Escape" });
    expect(onEscape).toHaveBeenCalledTimes(1);
    key(view.contentDOM, { key: "צ", code: "KeyM", ctrlKey: true });
    expect(onFocusToolbar).toHaveBeenCalledTimes(1);
  });

  it("opens with the caret on the requested line and column", () => {
    const onCursorChange = vi.fn();
    mount({ initialValue: "aaa\nbbbb\ncc", initialCaret: { line: 2, column: 3 }, onCursorChange });
    expect(onCursorChange).toHaveBeenLastCalledWith({ line: 2, col: 4 });
  });

  it("a mixed-EOL file keeps every carriage return in the text (verbatim mode)", () => {
    const text = "a\r\nb\nc\r\n";
    const { ref } = mount({ initialValue: text, verbatimBreaks: true });
    expect(ref.current!.getValue()).toBe(text);
  });
});
