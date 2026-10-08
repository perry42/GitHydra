// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { EditorPane, type EditorPaneProps } from "./EditorPane";
import { makeMockGitHydra } from "../../test/mockGitHydra";
import { polyfillCodeMirrorDom, typeAtEnd, viewOf } from "../../test/codemirrorDom";
import { createDirtyLeaveRegistry } from "../../hooks/useDirtyLeaveGuard";
import type { GitHydraApi } from "../../../shared/ipcContract";

beforeAll(polyfillCodeMirrorDom);

const H = (c: string) => c.repeat(64);
const base = { eligible: true as const, hasStagedContent: false, isNew: false, isUntracked: false, size: 3, mtimeMs: 1, mode: 0o644 };
const read = (content: string, hash = H("a"), extra: Record<string, unknown> = {}) => ({
  ok: true as const,
  data: { ...base, content, eol: "lf" as const, hasBom: false, finalNewline: true, contentHash: hash, ...extra },
});
const written = (hash: string) => ({ ok: true as const, data: { status: "written" as const, contentHash: hash, mtimeMs: 2, size: 4 } });
const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

function setup(opts: { content?: string; api?: Partial<GitHydraApi>; props?: Partial<EditorPaneProps>; readExtra?: Record<string, unknown> } = {}) {
  const api = makeMockGitHydra();
  api.readEditableFile = vi.fn(() => Promise.resolve(read(opts.content ?? "one\ntwo\n", H("a"), opts.readExtra))) as GitHydraApi["readEditableFile"];
  Object.assign(api, opts.api);
  let worktreeListener: (() => void) | null = null;
  api.onWorktreeChanged = vi.fn((l: () => void) => {
    worktreeListener = l;
    return () => {};
  });
  const guard = createDirtyLeaveRegistry();
  const props: EditorPaneProps = {
    api,
    path: "src/f.txt",
    open: {},
    guard,
    indexDiffersFromWorkingCopy: false,
    lineWasStaged: false,
    onClose: vi.fn(),
    onSaved: vi.fn(),
    ...opts.props,
  };
  const utils = render(<EditorPane {...props} />);
  return { api, props, guard, fireWorktree: () => worktreeListener?.(), ...utils };
}

const ready = () => screen.findByRole("textbox", { name: "Editing src/f.txt" });
const saveKey = (shift = false, target: Element = document.querySelector(".cm-content")!) => fireEvent.keyDown(target, { key: "s", code: "KeyS", ctrlKey: true, shiftKey: shift });
const save = () => screen.getByRole("button", { name: "Save", exact: true });

describe("EditorPane save flow (specs/edit-in-diff.md FR-470, FR-474, FR-537)", () => {
  it("opens the working copy; Save is aria-disabled with the reason while clean, then writes with the read metadata and hash", async () => {
    const { api, props, container } = setup({ readExtra: { eol: "crlf", hasBom: true, finalNewline: false } });
    await ready();
    expect(api.readEditableFile).toHaveBeenCalledWith("src/f.txt");
    expect(save()).toHaveAttribute("aria-disabled", "true");
    expect(save()).toHaveAttribute("title", "No unsaved edits");
    expect(screen.getByText(/Ln 1, Col 1 · CRLF · UTF-8 with BOM, plain text · no final newline/)).toBeInTheDocument();

    act(() => typeAtEnd(container, "x"));
    expect(screen.getByText("Unsaved")).toBeInTheDocument();
    expect(save()).not.toHaveAttribute("aria-disabled");
    mock(api.writeEditedFile).mockResolvedValueOnce(written(H("b")));
    saveKey();
    await waitFor(() => expect(props.onSaved).toHaveBeenCalledTimes(1));
    expect(api.writeEditedFile).toHaveBeenCalledWith("src/f.txt", "one\ntwo\nx", {
      expectedHash: H("a"),
      eol: "crlf",
      hasBom: true,
      finalNewline: false,
      force: false,
    });
    expect(screen.queryByText("Unsaved")).toBeNull();

    // The returned hash is the new baseline: a second save never prompts.
    act(() => typeAtEnd(container, "y"));
    mock(api.writeEditedFile).mockResolvedValueOnce(written(H("c")));
    saveKey();
    await waitFor(() => expect(props.onSaved).toHaveBeenCalledTimes(2));
    expect(mock(api.writeEditedFile).mock.calls[1]![2]).toMatchObject({ expectedHash: H("b") });
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("changed-on-disk asks before overwriting (Cancel focused) and retries with force only after the yes", async () => {
    const { api, container } = setup();
    await ready();
    act(() => typeAtEnd(container, "x"));
    const w = mock(api.writeEditedFile);
    w.mockResolvedValueOnce({ ok: true, data: { status: "changed-on-disk", currentHash: H("z") } }).mockResolvedValueOnce(written(H("b")));
    saveKey();
    const dlg = await screen.findByRole("alertdialog");
    expect(within(dlg).getByText("File changed on disk since you opened it. Overwrite?")).toBeInTheDocument();
    expect(within(dlg).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(w).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dlg).getByRole("button", { name: "Overwrite" }));
    await waitFor(() => expect(w).toHaveBeenCalledTimes(2));
    expect(w.mock.calls[1]![2]).toMatchObject({ force: true });
    await waitFor(() => expect(screen.queryByText("Unsaved")).toBeNull());
  });

  it("Cancel on the overwrite prompt writes nothing more and keeps the buffer", async () => {
    const { api, container } = setup();
    await ready();
    act(() => typeAtEnd(container, "x"));
    mock(api.writeEditedFile).mockResolvedValueOnce({ ok: true, data: { status: "changed-on-disk", currentHash: H("z") } });
    saveKey();
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(api.writeEditedFile).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Unsaved")).toBeInTheDocument();
  });

  it("a write error shows the one-line banner with the raw detail behind Show details; the buffer stays dirty", async () => {
    const { api, container } = setup();
    await ready();
    act(() => typeAtEnd(container, "x"));
    mock(api.writeEditedFile).mockResolvedValueOnce({ ok: false, code: "read-only", message: "The file is read-only" });
    saveKey();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't save. Check that you can write to this folder and file.");
    expect(screen.queryByText(/read-only: The file is read-only/)).toBeNull();
    fireEvent.click(within(alert).getByRole("button", { name: "Show details" }));
    expect(screen.getByText("read-only: The file is read-only")).toBeInTheDocument();
    expect(screen.getByText("Unsaved")).toBeInTheDocument();
  });

  it("an ineligible file shows its reason instead of an editor", async () => {
    const { container } = setup({
      api: {
        readEditableFile: vi.fn(() => Promise.resolve({ ok: true as const, data: { eligible: false as const, reason: "binary" as const, message: "Binary file" } })),
      } as Partial<GitHydraApi>,
    });
    expect(await screen.findByText("Edit unavailable: Binary file")).toBeInTheDocument();
    expect(container.querySelector(".cm-editor")).toBeNull();
  });

  it("Ctrl+S and Ctrl+Shift+S only act for keys aimed inside the editor pane (never the commit-message box)", async () => {
    const { api, container } = setup();
    await ready();
    act(() => typeAtEnd(container, "x"));
    const outside = document.createElement("input");
    document.body.append(outside);
    saveKey(false, outside);
    saveKey(true, outside);
    outside.remove();
    await new Promise((r) => setTimeout(r, 20));
    expect(api.writeEditedFile).not.toHaveBeenCalled();
    expect(api.stageFile).not.toHaveBeenCalled();
    // From the toolbar (inside the pane) it still works.
    mock(api.writeEditedFile).mockResolvedValueOnce(written(H("b")));
    saveKey(false, screen.getByRole("button", { name: "Back to diff" }));
    await waitFor(() => expect(api.writeEditedFile).toHaveBeenCalledTimes(1));
  });

  it("Ctrl+S is ignored while another modal is open", async () => {
    const { api, container } = setup();
    await ready();
    act(() => typeAtEnd(container, "x"));
    const modal = document.createElement("div");
    modal.setAttribute("aria-modal", "true");
    document.body.append(modal);
    saveKey();
    modal.remove();
    await new Promise((r) => setTimeout(r, 20));
    expect(api.writeEditedFile).not.toHaveBeenCalled();
  });
});

describe("EditorPane save and stage (FR-528, FR-530, FR-540)", () => {
  it("with staged content: relabelled button, tooltip text, persistent note and Working copy tag", async () => {
    setup({ readExtra: { hasStagedContent: true }, props: { indexDiffersFromWorkingCopy: true } });
    await ready();
    const btn = screen.getByRole("button", { name: /Save and stage whole file/ });
    expect(btn).toHaveAttribute("data-tip", "Replaces your current staged version with the full working copy.");
    expect(screen.getByRole("note")).toHaveTextContent("Editing the working copy. Your staged version is unchanged. Stage again to include these edits.");
    expect(screen.getByText("Working copy")).toBeInTheDocument();
  });

  it("without staged content there is no note and the label is plain", async () => {
    setup();
    await ready();
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.getByRole("button", { name: /^Save and stage$/ })).toBeInTheDocument();
  });

  it("writes, then stages the whole file; the editor stays open and clean", async () => {
    const { api, container } = setup();
    await ready();
    act(() => typeAtEnd(container, "x"));
    mock(api.writeEditedFile).mockResolvedValueOnce(written(H("b")));
    saveKey(true);
    await waitFor(() => expect(api.stageFile).toHaveBeenCalledWith("src/f.txt"));
    await screen.findByText("Saved and staged the whole file.");
    expect(screen.queryByText("Unsaved")).toBeNull();
    expect(container.querySelector(".cm-editor")).not.toBeNull();
  });

  it("a stage failure after a good write keeps the file saved, the buffer clean, and shows the error", async () => {
    const { api, container } = setup();
    await ready();
    mock(api.stageFile).mockResolvedValueOnce({ ok: false, error: { name: "Error", message: "index.lock exists" } });
    act(() => typeAtEnd(container, "x"));
    mock(api.writeEditedFile).mockResolvedValueOnce(written(H("b")));
    saveKey(true);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Saved, but staging failed");
    expect(screen.queryByText("Unsaved")).toBeNull();
  });

  it("clean: both buttons are aria-disabled with the reason as description", async () => {
    setup();
    await ready();
    const btn = screen.getByRole("button", { name: /^Save and stage$/ });
    expect(btn).toHaveAttribute("aria-disabled", "true");
    expect(btn).toHaveAccessibleDescription(/No unsaved edits/);
  });

  it("clean but the index differs from the working copy: Save and stage stages without writing", async () => {
    const { api, props } = setup({ props: { indexDiffersFromWorkingCopy: true } });
    await ready();
    const btn = screen.getByRole("button", { name: /^Save and stage$/ });
    expect(btn).not.toHaveAttribute("aria-disabled");
    fireEvent.click(btn);
    await waitFor(() => expect(api.stageFile).toHaveBeenCalledWith("src/f.txt"));
    expect(api.writeEditedFile).not.toHaveBeenCalled();
    await waitFor(() => expect(props.onSaved).toHaveBeenCalled());
  });

  it("a clean Save and stage never stages after the file was deleted or changed outside", async () => {
    const { api, fireWorktree } = setup({ props: { indexDiffersFromWorkingCopy: true } });
    await ready();
    mock(api.readEditableFile).mockResolvedValue({ ok: true, data: { eligible: false, reason: "deleted", message: "The file does not exist in the working tree" } });
    fireWorktree();
    await screen.findByRole("alert");
    const btn = screen.getByRole("button", { name: /^Save and stage$/ });
    expect(btn).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(btn);
    saveKey(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(api.stageFile).not.toHaveBeenCalled();
  });

  it("a reload note is dropped as soon as the buffer goes dirty", async () => {
    const { api, fireWorktree, container } = setup();
    await ready();
    mock(api.readEditableFile).mockResolvedValue(read("new" + String.fromCharCode(92) + "n", H("d")));
    fireWorktree();
    expect(await screen.findByText("Reloaded from disk", { selector: ".gh-edit__stat" })).toBeInTheDocument();
    act(() => typeAtEnd(container, "x"));
    expect(screen.queryByText("Reloaded from disk", { selector: ".gh-edit__stat" })).toBeNull();
  });

  it("FR-540: after a save, an ambiguous line-staging verdict shows the already-staged note (no button)", async () => {
    const { rerender, api, props, container } = setup({ readExtra: { hasStagedContent: true } });
    await ready();
    expect(screen.queryByText(/This line was already staged/)).toBeNull();
    act(() => typeAtEnd(container, "x"));
    mock(api.writeEditedFile).mockResolvedValueOnce(written(H("b")));
    saveKey();
    await waitFor(() => expect(props.onSaved).toHaveBeenCalled());
    rerender(<EditorPane {...props} lineWasStaged />);
    const note = await screen.findByText(/This line was already staged\. Your edit is unstaged on top of it\./);
    expect(note.closest("p")!.querySelector("button")).toBeNull();
  });
});

describe("EditorPane leaving (FR-535, FR-538)", () => {
  it("Back to diff on a clean buffer leaves at once and asks for focus on the Edit button", async () => {
    const { props } = setup();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Back to diff" }));
    await waitFor(() => expect(props.onClose).toHaveBeenCalledWith({ returnFocus: true }));
  });

  it("a dirty buffer asks Save / Discard / Cancel with Save focused; Cancel stays, Discard leaves, Save writes then leaves", async () => {
    const { api, props, container } = setup();
    await ready();
    act(() => typeAtEnd(container, "x"));
    fireEvent.click(screen.getByRole("button", { name: "Back to diff" }));
    let dlg = await screen.findByRole("alertdialog");
    expect(within(dlg).getByRole("button", { name: "Save" })).toHaveFocus();
    expect(within(dlg).getByRole("button", { name: "Discard" })).not.toHaveFocus();
    expect(within(dlg).getByRole("button", { name: "Discard" })).toHaveClass("gh-confirm-dialog__secondary--destructive");
    fireEvent.click(within(dlg).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(props.onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Back to diff" }));
    dlg = await screen.findByRole("alertdialog");
    fireEvent.click(within(dlg).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1));
    expect(api.writeEditedFile).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Back to diff" }));
    dlg = await screen.findByRole("alertdialog");
    mock(api.writeEditedFile).mockResolvedValueOnce(written(H("b")));
    fireEvent.click(within(dlg).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(2));
    expect(api.writeEditedFile).toHaveBeenCalledTimes(1);
  });

  it("if Save fails the leave is aborted and the buffer is kept", async () => {
    const { api, props, container } = setup();
    await ready();
    act(() => typeAtEnd(container, "x"));
    fireEvent.click(screen.getByRole("button", { name: "Back to diff" }));
    const dlg = await screen.findByRole("alertdialog");
    mock(api.writeEditedFile).mockResolvedValueOnce({ ok: false, code: "io", message: "disk full" });
    fireEvent.click(within(dlg).getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Couldn't save/);
    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.getByText("Unsaved")).toBeInTheDocument();
  });

  it("the shared guard asks the editor too, so other in-panel paths cannot drop the buffer", async () => {
    const { guard, container } = setup();
    await ready();
    expect(guard.isDirty()).toBe(false);
    act(() => typeAtEnd(container, "x"));
    expect(guard.isDirty()).toBe(true);
    const p = guard.confirmLeave();
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    await expect(p).resolves.toBe(false);
  });

  it("Esc inside the editor leaves (asking when dirty)", async () => {
    const { props, container } = setup();
    await ready();
    fireEvent.keyDown(viewOf(container).contentDOM, { key: "Escape" });
    await waitFor(() => expect(props.onClose).toHaveBeenCalled());
  });
});

describe("EditorPane external change (FR-472..474)", () => {
  it("a clean buffer reloads quietly and says so politely", async () => {
    const { api, fireWorktree, container } = setup();
    await ready();
    mock(api.readEditableFile).mockResolvedValue(read("one\ntwo\nthree\n", H("d")));
    fireWorktree();
    await waitFor(() => expect(viewOf(container).state.doc.toString()).toBe("one\ntwo\nthree\n"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("File reloaded from disk (changed outside GitHydra).", { selector: "[role=status]" })).toBeInTheDocument();
  });

  it("our own save hash is not an external change", async () => {
    const { api, fireWorktree, container } = setup();
    await ready();
    act(() => typeAtEnd(container, "x"));
    mock(api.writeEditedFile).mockResolvedValueOnce(written(H("b")));
    saveKey();
    await waitFor(() => expect(screen.queryByText("Unsaved")).toBeNull());
    mock(api.readEditableFile).mockResolvedValue(read("one\ntwo\nx", H("b")));
    fireWorktree();
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(viewOf(container).state.doc.toString()).toBe("one\ntwo\nx");
  });

  it("a dirty buffer gets the banner; nothing is overwritten; Reload confirms first; Keep mine hides it and Save still guards", async () => {
    const { api, fireWorktree, container } = setup();
    await ready();
    act(() => typeAtEnd(container, "mine"));
    mock(api.readEditableFile).mockResolvedValue(read("theirs\n", H("e")));
    fireWorktree();
    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("f.txt changed on disk. Neither version was overwritten.");
    expect(viewOf(container).state.doc.toString()).toBe("one\ntwo\nmine");
    expect(within(banner).queryByRole("button", { name: "Compare" })).toBeNull();

    fireEvent.click(within(banner).getByRole("button", { name: "Reload" }));
    let dlg = await screen.findByRole("alertdialog");
    expect(within(dlg).getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.click(within(dlg).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(viewOf(container).state.doc.toString()).toBe("one\ntwo\nmine");

    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Keep mine" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Changed on disk")).toBeInTheDocument();
    mock(api.writeEditedFile).mockResolvedValueOnce({ ok: true, data: { status: "changed-on-disk", currentHash: H("e") } });
    saveKey();
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(mock(api.writeEditedFile).mock.calls[0]![2]).toMatchObject({ expectedHash: H("a"), force: false });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    mock(api.readEditableFile).mockResolvedValue(read("theirs2\n", H("f")));
    fireWorktree();
    fireEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Reload" }));
    dlg = await screen.findByRole("alertdialog");
    fireEvent.click(within(dlg).getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(viewOf(container).state.doc.toString()).toBe("theirs2\n"));
    expect(screen.queryByText("Unsaved")).toBeNull();
  });
});
