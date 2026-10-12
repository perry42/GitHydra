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
  LOCK_BLOCK_TEXT_IN_RESOLVING: false,
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

describe("Q1 LOCK_BLOCK_TEXT_IN_RESOLVING = false", () => {
  it("block text stays typable in Resolving while the text outside the blocks is locked", async () => {
    setup();
    const ed = await screen.findByRole("textbox", { name: "Editing src/f.txt" });
    const view = viewOf(document.body);
    expect(view.state.readOnly).toBe(false);
    expect(document.querySelector(".gh-edit__bar .gh-edit__tag-text")?.textContent).toBe("Resolving");
    const inBlock = view.state.doc.line(3).to;
    view.dispatch({ changes: { from: inBlock, insert: "Z" }, userEvent: "input.type" });
    expect(view.state.doc.line(3).text).toBe("top1Z");
    view.dispatch({ changes: { from: 2, insert: "Q" }, userEvent: "input.type" });
    expect(view.state.doc.line(1).text).toBe("head");
    // Typing a key outside a block announces; inside a block it is left to the editor.
    view.dispatch({ selection: { anchor: 1 } });
    fireEvent.keyDown(ed, { key: "x", code: "KeyX" });
    await waitFor(() => expect(screen.getAllByText("Read-only. Press E to edit.").length).toBeGreaterThan(0));
  });

  it("a chip choice still works and Undo restores it", async () => {
    setup();
    await screen.findByRole("textbox", { name: "Editing src/f.txt" });
    act(() => within(screen.getByRole("group", { name: "Resolution for conflict 1" })).getByRole("button", { name: /^Incoming/ }).click());
    expect(viewOf(document.body).state.doc.toString()).not.toContain("top1");
    fireEvent.click(screen.getByRole("button", { name: "Undo (Ctrl+Z)" }));
    expect(viewOf(document.body).state.doc.toString()).toContain("top1");
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
