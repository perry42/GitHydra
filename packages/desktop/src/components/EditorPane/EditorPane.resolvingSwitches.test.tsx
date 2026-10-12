// SPDX-License-Identifier: GPL-3.0-or-later
// specs/edit-in-diff.md FR-599: the two owner-open answers are single constants in lib/resolvingMode.ts; flipping either works.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { EditorPane, type EditorPaneProps } from "./EditorPane";
import { makeMockGitHydra } from "../../test/mockGitHydra";
import { polyfillCodeMirrorDom, viewOf } from "../../test/codemirrorDom";
import { createDirtyLeaveRegistry } from "../../hooks/useDirtyLeaveGuard";
import type { GitHydraApi } from "../../../shared/ipcContract";

vi.mock("../../lib/resolvingMode", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/resolvingMode")>()),
  ESC_STEPS_BACK_TO_RESOLVING: false,
}));

beforeAll(polyfillCodeMirrorDom);

const H = (c: string) => c.repeat(64);
const TEXT = ["head", "<<<<<<< HEAD", "top1", "=======", "bot1", ">>>>>>> feature", "tail", ""].join("\n");
const base = { eligible: true as const, hasStagedContent: false, isNew: false, isUntracked: false, conflicted: true, size: 3, mtimeMs: 1, mode: 0o644 };
const side = (text: string) => ({ status: "ok" as const, sha: "a".repeat(40), mode: "100644", text });

function setup() {
  const api = makeMockGitHydra();
  api.readEditableFile = vi.fn(() => Promise.resolve({ ok: true as const, data: { ...base, content: TEXT, eol: "lf" as const, hasBom: false, finalNewline: true, contentHash: H("a") } })) as GitHydraApi["readEditableFile"];
  api.readConflictSides = vi.fn(() => Promise.resolve({ ok: true as const, data: { base: side("b\n"), ours: side("top1\n"), theirs: side("bot1\n") } })) as unknown as GitHydraApi["readConflictSides"];
  api.getConflictSideLabels = vi.fn(() =>
    Promise.resolve({ ok: true as const, data: { ours: { label: "Your branch (main @ abc1234)", refName: "main", sha: "abc1234" }, theirs: { label: "Incoming (feature @ def5678)", refName: "feature", sha: "def5678" } } }),
  ) as unknown as GitHydraApi["getConflictSideLabels"];
  api.onWorktreeChanged = vi.fn(() => () => {});
  const props: EditorPaneProps = {
    api,
    path: "src/f.txt",
    open: { mode: "resolving" },
    guard: createDirtyLeaveRegistry(),
    indexDiffersFromWorkingCopy: false,
    lineWasStaged: false,
    onClose: vi.fn(),
    onSaved: vi.fn(),
  };
  return { props, ...render(<EditorPane {...props} />) };
}

const tagText = () => document.querySelector(".gh-edit__bar .gh-edit__tag-text")?.textContent;
const type = (view: ReturnType<typeof viewOf>, from: number, insert: string, to = from) => view.dispatch({ changes: { from, to, insert }, userEvent: "input.type" });

describe("Q1 LOCK_BLOCK_TEXT_IN_RESOLVING = false (default)", () => {
  it("block text is typable in Resolving, the text outside the blocks is locked", async () => {
    setup();
    const ed = await screen.findByRole("textbox", { name: "Editing src/f.txt" });
    const view = viewOf(document.body);
    expect(view.state.readOnly).toBe(false);
    expect(tagText()).toBe("Resolving");
    expect(screen.getByTestId("editor-slot")).toHaveTextContent(/Conflict markers still present/);
    type(view, view.state.doc.line(3).to, "Z");
    expect(view.state.doc.line(3).text).toBe("top1Z");
    type(view, 2, "Q");
    type(view, view.state.doc.line(7).from, "Q");
    expect(view.state.doc.line(1).text).toBe("head");
    expect(view.state.doc.line(7).text).toBe("tail");
    // A change that spills out of the block is refused whole, not half applied.
    type(view, view.state.doc.line(3).from, "", view.state.doc.line(7).to);
    expect(view.state.doc.toString()).toContain("top1Z");
    expect(tagText()).toBe("Resolving");
    view.dispatch({ selection: { anchor: 1 } });
    fireEvent.keyDown(ed, { key: "x", code: "KeyX" });
    await waitFor(() => expect(screen.getAllByText("Read-only. Press E to edit.").length).toBeGreaterThan(0));
  });

  it("a key typed with the caret inside a block is not swallowed and is not announced; E there is a letter", async () => {
    setup();
    const ed = await screen.findByRole("textbox", { name: "Editing src/f.txt" });
    const view = viewOf(document.body);
    view.dispatch({ selection: { anchor: view.state.doc.line(3).to } });
    expect(view.dom).toHaveClass("gh-cm-ro-block");
    expect(view.dom).not.toHaveClass("gh-cm-ro");
    const x = new KeyboardEvent("keydown", { key: "e", code: "KeyE", bubbles: true, cancelable: true });
    ed.dispatchEvent(x);
    expect(x.defaultPrevented).toBe(false);
    expect(tagText()).toBe("Resolving");
    expect(screen.queryByText("Read-only. Press E to edit.")).toBeNull();
    view.dispatch({ selection: { anchor: 1 } });
    expect(view.dom).toHaveClass("gh-cm-ro");
    expect(view.dom).not.toHaveClass("gh-cm-ro-block");
  });

  it("Backspace at a block's first character is announced instead of silently dropped", async () => {
    setup();
    const ed = await screen.findByRole("textbox", { name: "Editing src/f.txt" });
    const view = viewOf(document.body);
    view.dispatch({ selection: { anchor: view.state.doc.line(2).from } });
    fireEvent.keyDown(ed, { key: "Backspace", code: "Backspace" });
    await waitFor(() => expect(screen.getAllByText("Read-only. Press E to edit.").length).toBeGreaterThan(0));
  });

  it("typing in a decided block ticks Custom and the mode stays Resolving; Undo and Redo work", async () => {
    setup();
    await screen.findByRole("textbox", { name: "Editing src/f.txt" });
    const view = viewOf(document.body);
    act(() => within(screen.getByRole("group", { name: "Resolution for conflict 1" })).getByRole("button", { name: /^Yours/ }).click());
    expect(view.state.doc.toString()).toBe(["head", "top1", "tail", ""].join("\n"));
    type(view, view.state.doc.line(2).to, "Z");
    expect(view.state.doc.line(2).text).toBe("top1Z");
    await waitFor(() => expect(within(screen.getByRole("group", { name: "Resolution for conflict 1" })).getByRole("button", { name: /^Custom/ })).toHaveAttribute("aria-pressed", "true"));
    expect(tagText()).toBe("Resolving");
    fireEvent.click(screen.getByRole("button", { name: "Undo (Ctrl+Z)" }));
    expect(view.state.doc.toString()).not.toContain("top1Z");
    fireEvent.click(screen.getByRole("button", { name: "Redo (Ctrl+Shift+Z)" }));
    expect(view.state.doc.toString()).toContain("top1Z");
    expect(tagText()).toBe("Resolving");
  });

  it("paste and deleting a whole block's text (Neither) inside a block work; a change spilling outside is refused", async () => {
    setup();
    await screen.findByRole("textbox", { name: "Editing src/f.txt" });
    const view = viewOf(document.body);
    act(() => within(screen.getByRole("group", { name: "Resolution for conflict 1" })).getByRole("button", { name: /^Yours/ }).click());
    type(view, view.state.doc.line(2).from, "pasted\nlines\n");
    expect(view.state.doc.toString()).toContain("pasted\nlines\ntop1");
    const before = view.state.doc.toString();
    type(view, 3, "", view.state.doc.length - 3);
    expect(view.state.doc.toString()).toBe(before);
    const from = before.indexOf("pasted");
    type(view, from, "", before.indexOf("top1") + "top1\n".length);
    expect(view.state.doc.toString()).toBe("head\ntail\n");
    expect(tagText()).toBe("Resolving");
    fireEvent.click(screen.getByRole("button", { name: "Undo (Ctrl+Z)" }));
    expect(view.state.doc.toString()).toContain("top1");
  });

  it("a chip choice still works and Undo restores it", async () => {
    setup();
    await screen.findByRole("textbox", { name: "Editing src/f.txt" });
    act(() => within(screen.getByRole("group", { name: "Resolution for conflict 1" })).getByRole("button", { name: /^Incoming/ }).click());
    expect(viewOf(document.body).state.doc.toString()).not.toContain("top1");
    fireEvent.click(screen.getByRole("button", { name: "Undo (Ctrl+Z)" }));
    expect(viewOf(document.body).state.doc.toString()).toContain("top1");
  });

  it("the hint says only the text outside the blocks is read-only", async () => {
    setup();
    await screen.findByRole("textbox", { name: "Editing src/f.txt" });
    act(() => within(screen.getByRole("group", { name: "Resolution for conflict 1" })).getByRole("button", { name: /^Yours/ }).click());
    expect(screen.getByTestId("editor-slot")).toHaveTextContent("Conflict text is editable. Double-click elsewhere or press E to edit the whole file.");
  });
});

describe("Q2 ESC_STEPS_BACK_TO_RESOLVING = false", () => {
  it("Esc from Editing leaves the file as before", async () => {
    const { props } = setup();
    const ed = await screen.findByRole("textbox", { name: "Editing src/f.txt" });
    fireEvent.keyDown(ed, { key: "e", code: "KeyE" });
    await waitFor(() => expect(document.querySelector(".gh-edit__bar .gh-edit__tag-text")?.textContent).toBe("Editing"));
    viewOf(document.body).dispatch({ selection: { anchor: 1 } });
    fireEvent.keyDown(ed, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(props.onClose).toHaveBeenCalledWith({ returnFocus: true }));
  });
});
