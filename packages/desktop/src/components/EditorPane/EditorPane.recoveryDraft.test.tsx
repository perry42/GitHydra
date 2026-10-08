// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { EditorPane, type EditorPaneProps } from "./EditorPane";
import { makeMockGitHydra } from "../../test/mockGitHydra";
import { polyfillCodeMirrorDom, typeAtEnd, viewOf } from "../../test/codemirrorDom";
import { createDirtyLeaveRegistry } from "../../hooks/useDirtyLeaveGuard";
import type { GitHydraApi } from "../../../shared/ipcContract";

beforeAll(polyfillCodeMirrorDom);
afterEach(() => vi.useRealTimers());

const REPO = "/repo";
const H = (c: string) => c.repeat(64);
const base = { eligible: true as const, hasStagedContent: false, isNew: false, isUntracked: false, size: 3, mtimeMs: 1, mode: 0o644 };
const read = (content: string, hash = H("a"), extra: Record<string, unknown> = {}) => ({
  ok: true as const,
  data: { ...base, content, eol: "lf" as const, hasBom: false, finalNewline: true, contentHash: hash, ...extra },
});
const written = (hash: string) => ({ ok: true as const, data: { status: "written" as const, contentHash: hash, mtimeMs: 2, size: 4 } });
const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

function setup(opts: { content?: string; readExtra?: Record<string, unknown>; props?: Partial<EditorPaneProps> } = {}) {
  const api = makeMockGitHydra();
  api.readEditableFile = vi.fn(() => Promise.resolve(read(opts.content ?? "one\ntwo\n", H("a"), opts.readExtra))) as GitHydraApi["readEditableFile"];
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
    repoPath: REPO,
    ...opts.props,
  };
  const utils = render(<EditorPane {...props} />);
  return { api, props, guard, fireWorktree: () => worktreeListener?.(), ...utils };
}

const ready = () => screen.findByRole("textbox", { name: "Editing src/f.txt" });
const content = (c: HTMLElement) => viewOf(c).contentDOM;
const saveKey = () => fireEvent.keyDown(document.querySelector(".cm-content")!, { key: "s", code: "KeyS", ctrlKey: true });
const backspaceLast = (c: HTMLElement) => {
  const v = viewOf(c);
  v.dispatch({ changes: { from: v.state.doc.length - 1, to: v.state.doc.length } });
};

describe("recovery draft write policy (specs/edit-recovery-draft.md FR-545, FR-548)", () => {
  it("writes once, 2 s after the last change, with the session's metadata and recorded hash", async () => {
    const { api, container } = setup({ readExtra: { eol: "crlf", hasBom: true, finalNewline: false } });
    await ready();
    vi.useFakeTimers();
    act(() => typeAtEnd(container, "x"));
    await vi.advanceTimersByTimeAsync(1500);
    act(() => typeAtEnd(container, "y"));
    await vi.advanceTimersByTimeAsync(1999);
    expect(api.writeDraft).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(api.writeDraft).toHaveBeenCalledTimes(1);
    expect(api.writeDraft).toHaveBeenCalledWith(REPO, "src/f.txt", {
      content: "one\ntwo\nxy",
      bom: true,
      eol: "crlf",
      finalNewline: false,
      expectedHash: H("a"),
    });
  });

  it("writes immediately on editor blur and when the window becomes hidden", async () => {
    const { api, container } = setup();
    await ready();
    act(() => typeAtEnd(container, "x"));
    expect(api.writeDraft).not.toHaveBeenCalled();
    fireEvent.blur(content(container));
    await waitFor(() => expect(api.writeDraft).toHaveBeenCalledTimes(1));

    act(() => typeAtEnd(container, "y"));
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    await waitFor(() => expect(api.writeDraft).toHaveBeenCalledTimes(2));
    expect(mock(api.writeDraft).mock.calls[1]![2]).toMatchObject({ content: "one\ntwo\nxy" });
  });

  it("a clean buffer, or one edited back to the base text, deletes instead of writing", async () => {
    const { api, container } = setup();
    await ready();
    vi.useFakeTimers();
    act(() => typeAtEnd(container, "x"));
    act(() => backspaceLast(container));
    await vi.advanceTimersByTimeAsync(3000);
    expect(api.writeDraft).not.toHaveBeenCalled();
    expect(api.deleteDraft).toHaveBeenCalledWith(REPO, "src/f.txt");
  });

  it("writes nothing for an ineligible file or when no repo identity is known", async () => {
    const a = setup({ props: { repoPath: null } });
    await ready();
    act(() => typeAtEnd(a.container, "x"));
    fireEvent.blur(content(a.container));
    await new Promise((r) => setTimeout(r, 20));
    expect(a.api.writeDraft).not.toHaveBeenCalled();
    a.unmount();

    const api = makeMockGitHydra();
    api.readEditableFile = vi.fn(() =>
      Promise.resolve({ ok: true as const, data: { eligible: false as const, reason: "symlink" as const, message: "Symbolic links cannot be edited here" } }),
    ) as GitHydraApi["readEditableFile"];
    render(<EditorPane api={api} path="src/f.txt" open={{}} guard={createDirtyLeaveRegistry()} indexDiffersFromWorkingCopy={false} lineWasStaged={false} onClose={vi.fn()} onSaved={vi.fn()} repoPath={REPO} />);
    await screen.findByText(/Edit unavailable/);
    await new Promise((r) => setTimeout(r, 20));
    expect(api.writeDraft).not.toHaveBeenCalled();
  });

  it("superseded and no-repository are not failures: no footer note", async () => {
    const { api, container } = setup();
    await ready();
    mock(api.writeDraft).mockResolvedValueOnce({ ok: true, data: { status: "superseded" } });
    act(() => typeAtEnd(container, "x"));
    fireEvent.blur(content(container));
    await waitFor(() => expect(api.writeDraft).toHaveBeenCalledTimes(1));
    mock(api.writeDraft).mockResolvedValueOnce({ ok: false, code: "no-repository", message: "x" });
    act(() => typeAtEnd(container, "y"));
    fireEvent.blur(content(container));
    await waitFor(() => expect(api.writeDraft).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("Recovery copy unavailable")).toBeNull();
  });

  it("any other failure (or a thrown call) shows the polite footer note and never blocks Save; success clears it", async () => {
    const { api, container } = setup();
    await ready();
    mock(api.writeDraft).mockResolvedValueOnce({ ok: false, code: "io", message: "disk full" });
    act(() => typeAtEnd(container, "x"));
    fireEvent.blur(content(container));
    const note = await screen.findByText("Recovery copy unavailable");
    expect(note).toHaveAttribute("role", "status");
    expect(document.getElementById(note.parentElement!.id)).toContainElement(note);

    mock(api.writeDraft).mockRejectedValueOnce(new Error("boom"));
    act(() => typeAtEnd(container, "y"));
    fireEvent.blur(content(container));
    await waitFor(() => expect(api.writeDraft).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Recovery copy unavailable")).toBeInTheDocument();

    mock(api.writeEditedFile).mockResolvedValueOnce(written(H("b")));
    saveKey();
    await waitFor(() => expect(api.writeEditedFile).toHaveBeenCalledTimes(1));

    act(() => typeAtEnd(container, "z"));
    fireEvent.blur(content(container));
    await waitFor(() => expect(screen.queryByText("Recovery copy unavailable")).toBeNull());
  });

  it("content-too-large is not retried for the same or a larger buffer", async () => {
    const { api, container } = setup();
    await ready();
    mock(api.writeDraft).mockResolvedValue({ ok: false, code: "content-too-large", message: "x" });
    act(() => typeAtEnd(container, "x"));
    fireEvent.blur(content(container));
    await screen.findByText("Recovery copy unavailable");
    act(() => typeAtEnd(container, "y"));
    fireEvent.blur(content(container));
    await new Promise((r) => setTimeout(r, 20));
    expect(api.writeDraft).toHaveBeenCalledTimes(1);
  });

  it("flushes a pending write when the editor unmounts", async () => {
    const { api, container, unmount } = setup();
    await ready();
    act(() => typeAtEnd(container, "x"));
    expect(api.writeDraft).not.toHaveBeenCalled();
    unmount();
    expect(api.writeDraft).toHaveBeenCalledTimes(1);
    expect(mock(api.writeDraft).mock.calls[0]![2]).toMatchObject({ content: "one\ntwo\nx" });
  });
});

describe("recovery draft delete triggers (FR-546)", () => {
  it("Save deletes the draft, and a pending debounced write can never recreate it", async () => {
    const { api, container } = setup();
    await ready();
    vi.useFakeTimers();
    act(() => typeAtEnd(container, "x"));
    mock(api.writeEditedFile).mockResolvedValueOnce(written(H("b")));
    saveKey();
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.deleteDraft).toHaveBeenCalledWith(REPO, "src/f.txt");
    expect(api.writeDraft).not.toHaveBeenCalled();
  });

  it("a failed Save keeps the draft (no delete)", async () => {
    const { api, container } = setup();
    await ready();
    act(() => typeAtEnd(container, "x"));
    mock(api.writeEditedFile).mockResolvedValueOnce({ ok: false, code: "io", message: "disk full" });
    saveKey();
    await screen.findByRole("alert");
    expect(api.deleteDraft).not.toHaveBeenCalled();
  });

  it("typing during a save leaves the buffer dirty, so a fresh draft is written after the delete", async () => {
    const { api, container } = setup();
    await ready();
    act(() => typeAtEnd(container, "x"));
    let release: (v: unknown) => void = () => {};
    mock(api.writeEditedFile).mockImplementationOnce(() => new Promise((r) => (release = r)));
    saveKey();
    await waitFor(() => expect(api.writeEditedFile).toHaveBeenCalledTimes(1));
    act(() => typeAtEnd(container, "y"));
    release(written(H("b")));
    await waitFor(() => expect(api.deleteDraft).toHaveBeenCalled());
    fireEvent.blur(content(container));
    await waitFor(() => expect(api.writeDraft).toHaveBeenCalled());
    expect(mock(api.writeDraft).mock.calls.at(-1)![2]).toMatchObject({ expectedHash: H("b"), content: "one\ntwo\nxy" });
  });

  it("leave prompt Discard deletes before the guard resolves; Cancel keeps the draft", async () => {
    const { api, guard, container } = setup();
    await ready();
    act(() => typeAtEnd(container, "x"));
    fireEvent.blur(content(container));
    await waitFor(() => expect(api.writeDraft).toHaveBeenCalledTimes(1));

    let p = guard.confirmLeave();
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    await expect(p).resolves.toBe(false);
    expect(api.deleteDraft).not.toHaveBeenCalled();

    let deleted = false;
    mock(api.deleteDraft).mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 30));
      deleted = true;
      return { ok: true, data: undefined };
    });
    p = guard.confirmLeave().then((ok) => {
      expect(deleted).toBe(true);
      return ok;
    });
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Discard" }));
    await expect(p).resolves.toBe(true);
    expect(api.deleteDraft).toHaveBeenCalledWith(REPO, "src/f.txt");
  });

  it("Discard then unmount does not write the draft back", async () => {
    const { api, guard, container, unmount } = setup();
    await ready();
    act(() => typeAtEnd(container, "x"));
    const p = guard.confirmLeave();
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Discard" }));
    await expect(p).resolves.toBe(true);
    // The dialog taking focus blurs the editor, which legitimately wrote before the Discard.
    mock(api.writeDraft).mockClear();
    unmount();
    expect(api.writeDraft).not.toHaveBeenCalled();
  });

  it("leave prompt Save deletes the draft once written", async () => {
    const { api, guard, container } = setup();
    await ready();
    act(() => typeAtEnd(container, "x"));
    mock(api.writeEditedFile).mockResolvedValueOnce(written(H("b")));
    const p = guard.confirmLeave();
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Save" }));
    await expect(p).resolves.toBe(true);
    expect(api.deleteDraft).toHaveBeenCalledWith(REPO, "src/f.txt");
  });

  it("Reload confirmed in the external-change banner deletes the draft", async () => {
    const { api, fireWorktree, container } = setup();
    await ready();
    act(() => typeAtEnd(container, "mine"));
    mock(api.readEditableFile).mockResolvedValue(read("theirs\n", H("e")));
    fireWorktree();
    const banner = await screen.findByRole("alert");
    fireEvent.click(within(banner).getByRole("button", { name: "Reload" }));
    expect(api.deleteDraft).not.toHaveBeenCalled();
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(api.deleteDraft).toHaveBeenCalledWith(REPO, "src/f.txt"));
  });

  it("the file disappearing from disk deletes the draft without a prompt", async () => {
    const { api, fireWorktree, container } = setup();
    await ready();
    act(() => typeAtEnd(container, "x"));
    mock(api.readEditableFile).mockResolvedValue({
      ok: true,
      data: { eligible: false, reason: "deleted", message: "The file does not exist in the working tree" },
    });
    fireWorktree();
    mock(api.probeEditableFile).mockResolvedValue({ ok: true, data: { eligible: false, reason: "deleted", message: "gone" } });
    await screen.findByRole("alert");
    await waitFor(() => expect(api.deleteDraft).toHaveBeenCalledWith(REPO, "src/f.txt"), { timeout: 3000 });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    fireEvent.blur(content(container));
    await new Promise((r) => setTimeout(r, 20));
    expect(api.writeDraft).not.toHaveBeenCalled();
  });
});

describe("opening from a restored draft (FR-550, FR-551)", () => {
  const restore = { content: "one\nTWO\r\n", expectedHash: H("a"), eol: "mixed" as const, bom: true, finalNewline: false };

  it("opens dirty with the draft text verbatim, keeps the draft's metadata and hash, Save writes it and deletes the draft", async () => {
    const { api, guard, container } = setup({ props: { open: { restore } } });
    await ready();
    expect(viewOf(container).state.doc.toString()).toBe("one\nTWO\r\n");
    expect(screen.getByText("Unsaved")).toBeInTheDocument();
    expect(guard.isDirty()).toBe(true);
    mock(api.writeEditedFile).mockResolvedValueOnce(written(H("b")));
    saveKey();
    await waitFor(() => expect(api.deleteDraft).toHaveBeenCalledWith(REPO, "src/f.txt"));
    expect(api.writeEditedFile).toHaveBeenCalledWith("src/f.txt", "one\nTWO\r\n", {
      expectedHash: H("a"),
      eol: "mixed",
      hasBom: true,
      finalNewline: false,
      force: false,
    });
    expect(screen.queryByText("Unsaved")).toBeNull();
  });

  it("a restored buffer is guarded like any dirty buffer", async () => {
    const { guard } = setup({ props: { open: { restore } } });
    await ready();
    const p = guard.confirmLeave();
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    await expect(p).resolves.toBe(false);
  });

  it("when the file changed on disk the banner shows and Save asks the overwrite question with Cancel focused", async () => {
    const { api } = setup({ props: { open: { restore } } });
    mock(api.readEditableFile).mockResolvedValue(read("other\n", H("z")));
    await ready();
    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("f.txt changed on disk. Neither version was overwritten.");
    mock(api.writeEditedFile).mockResolvedValueOnce({ ok: true, data: { status: "changed-on-disk", currentHash: H("z") } });
    saveKey();
    const dlg = await screen.findByRole("alertdialog");
    expect(within(dlg).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(mock(api.writeEditedFile).mock.calls[0]![2]).toMatchObject({ expectedHash: H("a"), force: false });
  });
});

describe("recovery draft hardening (security review)", () => {
  it("L5/L1: a deleteDraft that never resolves cannot hold the guard past the 2 s cap; Cancel and a second Discard are no-ops meanwhile", async () => {
    const { api, guard, container } = setup();
    await ready();
    act(() => typeAtEnd(container, "x"));
    mock(api.deleteDraft).mockImplementation(() => new Promise(() => {}));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const p = guard.confirmLeave();
    let settled: boolean | null = null;
    void p.then((v) => (settled = v));
    await vi.advanceTimersByTimeAsync(10);
    const dlg = screen.getByRole("alertdialog");
    fireEvent.click(within(dlg).getByRole("button", { name: "Discard" }));
    await vi.advanceTimersByTimeAsync(500);
    fireEvent.click(within(dlg).getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(dlg).getByRole("button", { name: "Discard" }));
    await vi.advanceTimersByTimeAsync(500);
    expect(settled).toBeNull();
    expect(api.deleteDraft).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1100);
    expect(settled).toBe(true);
  });

  it("a delete answered {ok:false} still blocks the unmount flush after Discard", async () => {
    const { api, guard, container, unmount } = setup();
    await ready();
    act(() => typeAtEnd(container, "x"));
    mock(api.deleteDraft).mockResolvedValue({ ok: false, code: "io", message: "x" });
    const p = guard.confirmLeave();
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Discard" }));
    await expect(p).resolves.toBe(true);
    mock(api.writeDraft).mockClear();
    unmount();
    expect(api.writeDraft).not.toHaveBeenCalled();
  });

  it("L2: continuous typing still writes within the 10 s max wait", async () => {
    const { api, container } = setup();
    await ready();
    vi.useFakeTimers();
    for (let i = 0; i < 14; i++) {
      act(() => typeAtEnd(container, "x"));
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(api.writeDraft).toHaveBeenCalledTimes(1);
  });

  it("L3: an unchanged buffer is not written twice", async () => {
    const { api, container } = setup();
    await ready();
    act(() => typeAtEnd(container, "x"));
    fireEvent.blur(content(container));
    await waitFor(() => expect(api.writeDraft).toHaveBeenCalledTimes(1));
    fireEvent.blur(content(container));
    await new Promise((r) => setTimeout(r, 30));
    expect(api.writeDraft).toHaveBeenCalledTimes(1);
  });

  it("M1: one 'deleted' read is re-probed; a file that came back keeps the draft and writing resumes", async () => {
    const { api, fireWorktree, container } = setup();
    await ready();
    act(() => typeAtEnd(container, "x"));
    mock(api.readEditableFile).mockResolvedValueOnce({ ok: true, data: { eligible: false, reason: "deleted", message: "gone" } });
    mock(api.probeEditableFile).mockResolvedValue({ ok: true, data: { ...base, eligible: true } });
    fireWorktree();
    await screen.findByRole("alert");
    await new Promise((r) => setTimeout(r, 1300));
    expect(api.deleteDraft).not.toHaveBeenCalled();
  });

  it("M1: still deleted after the re-probe deletes the draft", async () => {
    const { api, fireWorktree, container } = setup();
    await ready();
    act(() => typeAtEnd(container, "x"));
    mock(api.readEditableFile).mockResolvedValue({ ok: true, data: { eligible: false, reason: "deleted", message: "gone" } });
    mock(api.probeEditableFile).mockResolvedValue({ ok: true, data: { eligible: false, reason: "deleted", message: "gone" } });
    fireWorktree();
    await screen.findByRole("alert");
    expect(api.deleteDraft).not.toHaveBeenCalled();
    await waitFor(() => expect(api.deleteDraft).toHaveBeenCalledWith(REPO, "src/f.txt"), { timeout: 3000 });
  });
});
