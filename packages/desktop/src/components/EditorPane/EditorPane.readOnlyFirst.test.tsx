// SPDX-License-Identifier: GPL-3.0-or-later
// specs/edit-in-diff.md FR-593..FR-600: the conflict view opens read-only (Resolving) and enters Editing without a remount.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorPane, resetHintDismissedForTests, type EditorPaneProps } from "./EditorPane";
import { makeMockGitHydra } from "../../test/mockGitHydra";
import { polyfillCodeMirrorDom, viewOf } from "../../test/codemirrorDom";
import { createDirtyLeaveRegistry } from "../../hooks/useDirtyLeaveGuard";
import type { GitHydraApi } from "../../../shared/ipcContract";

// The default is now "block text editable" (resolvingSwitches test); this file covers the fully locked variant.
vi.mock("../../lib/resolvingMode", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/resolvingMode")>()),
  LOCK_BLOCK_TEXT_IN_RESOLVING: true,
}));

beforeAll(polyfillCodeMirrorDom);
beforeEach(resetHintDismissedForTests);

const H = (c: string) => c.repeat(64);
const TEXT = ["head", "<<<<<<< HEAD", "top1", "=======", "bot1", ">>>>>>> feature", "mid", "<<<<<<< HEAD", "top2", "=======", "bot2", ">>>>>>> feature", "tail", ""].join("\n");
const base = { eligible: true as const, hasStagedContent: false, isNew: false, isUntracked: false, conflicted: true, size: 3, mtimeMs: 1, mode: 0o644 };
const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;
const side = (text: string) => ({ status: "ok" as const, sha: "a".repeat(40), mode: "100644", text });
const okSides = { base: side("base\n"), ours: side("top1\n"), theirs: side("bot1\n") };
const label = (l: string, ref: string) => ({ label: l, refName: ref, sha: "abc1234" });

function setup(opts: { conflicted?: boolean; props?: Partial<EditorPaneProps> } = {}) {
  const api = makeMockGitHydra();
  api.readEditableFile = vi.fn(() => Promise.resolve({ ok: true as const, data: { ...base, conflicted: opts.conflicted ?? true, content: TEXT, eol: "lf" as const, hasBom: false, finalNewline: true, contentHash: H("a") } })) as GitHydraApi["readEditableFile"];
  api.readConflictSides = vi.fn(() => Promise.resolve({ ok: true as const, data: okSides })) as unknown as GitHydraApi["readConflictSides"];
  api.getConflictSideLabels = vi.fn(() =>
    Promise.resolve({ ok: true as const, data: { ours: label("Your branch (main @ abc1234)", "main"), theirs: label("Incoming (feature @ def5678)", "feature") } }),
  ) as unknown as GitHydraApi["getConflictSideLabels"];
  let worktree: (() => void) | null = null;
  api.onWorktreeChanged = vi.fn((l: () => void) => {
    worktree = l;
    return () => {};
  });
  const props: EditorPaneProps = {
    api,
    path: "src/f.txt",
    open: { mode: "resolving" },
    guard: createDirtyLeaveRegistry(),
    indexDiffersFromWorkingCopy: false,
    lineWasStaged: false,
    onClose: vi.fn(),
    onSaved: vi.fn(),
    onResolved: vi.fn(),
    onMutationStart: vi.fn(),
    onMutationSettled: vi.fn(),
    ...opts.props,
  };
  return { api, props, fireWorktree: () => act(() => worktree?.()), ...render(<EditorPane {...props} />) };
}

const ready = () => screen.findByRole("textbox", { name: "Editing src/f.txt" });
const pill = () => screen.getByRole("region", { name: "Conflict navigation" });
const chipBtn = (n: number, name: RegExp | string) => within(screen.getByRole("group", { name: `Resolution for conflict ${n}` })).getByRole("button", { name });
const docOf = () => viewOf(document.body).state.doc.toString();
const key = (el: Element, init: KeyboardEventInit) => fireEvent.keyDown(el, { bubbles: true, cancelable: true, ...init });
const tag = (name: "Resolving" | "Editing") => document.querySelector(".gh-edit__bar .gh-edit__tag-text")?.textContent === name;
const HINT = "Read-only. Double-click or press E to edit.";

describe("read-only first (FR-593..FR-600)", () => {
  it("opens Resolving: readOnly state but still focusable text, caret hidden, hint in the single slot, focus on the first chip", async () => {
    setup();
    const ed = await ready();
    const view = viewOf(document.body);
    expect(view.state.readOnly).toBe(true);
    expect(ed.getAttribute("contenteditable")).toBe("true");
    expect(view.dom).toHaveClass("gh-cm-ro");
    expect(tag("Resolving")).toBe(true);
    // FR-584/FR-592: ONE slot, and the blocking reason still outranks the hint; the hint appears once nothing blocks.
    expect(screen.getAllByTestId("editor-slot")).toHaveLength(1);
    // Sides load after the textbox mounts; until then the slot reads "Reading the conflicts…".
    await waitFor(() => expect(screen.getByTestId("editor-slot")).toHaveTextContent(/Conflict markers still present/));
    act(() => chipBtn(1, /^Yours/).click());
    act(() => chipBtn(2, /^Yours/).click());
    expect(screen.getByTestId("editor-slot")).toHaveTextContent(HINT);
    expect(screen.getAllByTestId("editor-slot")).toHaveLength(1);
    expect(screen.getByText(/^E edit/)).toBeInTheDocument();
    expect(ed).not.toHaveFocus();
  });

  it("a plain open (no mode) is Editing and keeps the old hint", async () => {
    setup({ props: { open: {} } });
    await ready();
    expect(viewOf(document.body).state.readOnly).toBe(false);
    expect(tag("Editing")).toBe(true);
    act(() => chipBtn(1, /^Yours/).click());
    act(() => chipBtn(2, /^Yours/).click());
    expect(screen.getByTestId("editor-slot")).toHaveTextContent("Editing the working file");
  });

  it("chips work while read-only, dirty the buffer, and Undo / Redo / Save keep working", async () => {
    const { api } = setup();
    await ready();
    expect(screen.getAllByText("No unsaved edits").length).toBeGreaterThan(0);
    act(() => chipBtn(1, /^Incoming/).click());
    expect(docOf()).not.toContain("top1");
    expect(chipBtn(1, /^Incoming/)).toHaveAttribute("aria-pressed", "true");
    expect(viewOf(document.body).state.readOnly).toBe(true);
    expect(screen.getByText("Unsaved")).toBeInTheDocument();
    // History commands refuse under readOnly; the layer routes around that for both the toolbar and the keyboard.
    fireEvent.click(screen.getByRole("button", { name: "Undo (Ctrl+Z)" }));
    expect(docOf()).toContain("top1");
    fireEvent.click(screen.getByRole("button", { name: "Redo (Ctrl+Shift+Z)" }));
    expect(docOf()).not.toContain("top1");
    key(screen.getByRole("textbox"), { key: "z", code: "KeyZ", ctrlKey: true });
    expect(docOf()).toContain("top1");
    expect(viewOf(document.body).state.readOnly).toBe(true);
    act(() => chipBtn(1, /^Yours/).click());
    mock(api.writeEditedFile).mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
    await waitFor(() => expect(api.writeEditedFile).toHaveBeenCalledTimes(1));
  });

  it("F3 and Alt+Up navigate immediately", async () => {
    setup();
    await ready();
    await waitFor(() => expect(pill()).toHaveTextContent("1 of 2"));
    key(screen.getByRole("textbox"), { key: "F3", code: "F3" });
    expect(pill()).toHaveTextContent("2 of 2");
    key(screen.getByRole("textbox"), { key: "ArrowUp", code: "ArrowUp", altKey: true });
    expect(pill()).toHaveTextContent("1 of 2");
  });

  it("typing changes nothing and announces; Enter and Tab do not edit either", async () => {
    setup();
    const ed = await ready();
    const before = docOf();
    ed.focus();
    key(ed, { key: "x", code: "KeyX" });
    key(ed, { key: "Enter", code: "Enter" });
    key(ed, { key: "Tab", code: "Tab" });
    expect(docOf()).toBe(before);
    expect(tag("Resolving")).toBe(true);
    await waitFor(() => expect(screen.getAllByText("Read-only. Press E to edit.").length).toBeGreaterThan(0));
    expect(screen.getAllByText("Read-only. Press E to edit.")[0]!.closest("[aria-live=polite]")).not.toBeNull();
  });

  describe.each([
    ["E", async (ed: HTMLElement) => key(ed, { key: "e", code: "KeyE" })],
    ["double-click on a plain line", async (ed: HTMLElement) => fireEvent.dblClick(ed.querySelectorAll(".cm-line")[0]!)],
    ["the Edit chip", async () => act(() => chipBtn(1, /Edit/).click())],
    ["double-click on an undecided block", async (ed: HTMLElement) => fireEvent.dblClick(ed.querySelectorAll(".cm-line")[2]!)],
  ])("entering edit mode with %s", (_n, go) => {
    it("flips to Editing in place: same view, scroll and chip choices kept, the editing hint returns", async () => {
      setup();
      const ed = await ready();
      act(() => chipBtn(1, /^Yours/).click());
      act(() => chipBtn(2, /^Incoming/).click());
      const view = viewOf(document.body);
      view.scrollDOM.scrollTop = 40;
      await go(ed);
      await waitFor(() => expect(tag("Editing")).toBe(true));
      expect(viewOf(document.body)).toBe(view);
      expect(view.state.readOnly).toBe(false);
      expect(view.scrollDOM.scrollTop).toBe(40);
      expect(chipBtn(2, /^Incoming/)).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByTestId("editor-slot")).toHaveTextContent("Editing the working file");
      expect(screen.getByText("Unsaved")).toBeInTheDocument();
    });
  });

  it("E on a focused chip enters Editing and puts the caret in that block's text without changing it", async () => {
    setup();
    await ready();
    const view = viewOf(document.body);
    key(chipBtn(1, /^Yours/), { key: "e", code: "KeyE" });
    await waitFor(() => expect(tag("Editing")).toBe(true));
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(3);
    expect(docOf()).toBe(TEXT);
  });

  it("Esc steps back: block text, chip row, Resolving (dirty or not), then Esc asks only because the buffer is dirty", async () => {
    const { props } = setup();
    const ed = await ready();
    act(() => chipBtn(1, /^Yours/).click());
    act(() => chipBtn(2, /^Incoming/).click());
    key(chipBtn(1, /^Yours/), { key: "e", code: "KeyE" });
    await waitFor(() => expect(tag("Editing")).toBe(true));
    key(ed, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(chipBtn(1, /^Yours/)).toHaveFocus());
    expect(tag("Editing")).toBe(true);
    key(chipBtn(1, /^Yours/), { key: "Escape", code: "Escape" });
    await waitFor(() => expect(tag("Resolving")).toBe(true));
    expect(viewOf(document.body).state.readOnly).toBe(true);
    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByTestId("editor-slot")).toHaveTextContent(HINT);
    key(chipBtn(1, /^Yours/), { key: "Escape", code: "Escape" });
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("Save changes to f.txt?");
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("Esc outside any block while editing also steps back; a clean Resolving Esc leaves with no prompt", async () => {
    const { props } = setup();
    const ed = await ready();
    key(ed, { key: "e", code: "KeyE" });
    await waitFor(() => expect(tag("Editing")).toBe(true));
    viewOf(document.body).dispatch({ selection: { anchor: 1 } });
    key(ed, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(tag("Resolving")).toBe(true));
    await waitFor(() => expect(chipBtn(1, /^Yours/)).toHaveFocus());
    key(ed, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(props.onClose).toHaveBeenCalledWith({ returnFocus: true }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("a mouse click on a pill arrow returns focus to the chip row in Resolving and to the text in Editing (FR-586)", async () => {
    setup();
    const ed = await ready();
    await waitFor(() => expect(pill()).toHaveTextContent("1 of 2"));
    const user = userEvent.setup();
    await user.click(within(pill()).getByRole("button", { name: "Next conflict (F3)" }));
    expect(ed).not.toHaveFocus();
    await waitFor(() => expect(chipBtn(2, /^Yours/)).toHaveFocus());
    key(ed, { key: "e", code: "KeyE" });
    await waitFor(() => expect(tag("Editing")).toBe(true));
    await user.click(within(pill()).getByRole("button", { name: "Next conflict (F3)" }));
    expect(ed).toHaveFocus();
  });

  it("opening focuses the first chip, not the text", async () => {
    setup();
    const ed = await ready();
    await waitFor(() => expect(chipBtn(1, /^Yours/)).toHaveFocus());
    expect(ed).not.toHaveFocus();
  });

  it.each([
    ["Editing", true],
    ["Resolving", false],
  ])("a disk reload remounts the editor but never changes the mode (%s stays %s)", async (name, edit) => {
    const { api, fireWorktree } = setup();
    const ed = await ready();
    if (edit) key(ed, { key: "e", code: "KeyE" });
    await waitFor(() => expect(tag(name as "Editing" | "Resolving")).toBe(true));
    mock(api.readEditableFile).mockResolvedValue({ ok: true as const, data: { ...base, content: `${TEXT}more\n`, eol: "lf" as const, hasBom: false, finalNewline: true, contentHash: H("d") } });
    fireWorktree();
    await waitFor(() => expect(docOf()).toContain("more"));
    expect(tag(name as "Editing" | "Resolving")).toBe(true);
    expect(viewOf(document.body).state.readOnly).toBe(!edit);
  });

  it("a plain (non-conflict) file is never read-only, even if asked for Resolving", async () => {
    setup({ conflicted: false });
    await ready();
    expect(viewOf(document.body).state.readOnly).toBe(false);
  });
});
