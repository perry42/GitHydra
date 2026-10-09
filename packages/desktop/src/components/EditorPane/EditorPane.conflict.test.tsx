// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { EditorPane, type EditorPaneProps } from "./EditorPane";
import { makeMockGitHydra } from "../../test/mockGitHydra";
import { polyfillCodeMirrorDom, viewOf } from "../../test/codemirrorDom";
import { createDirtyLeaveRegistry } from "../../hooks/useDirtyLeaveGuard";
import type { GitHydraApi } from "../../../shared/ipcContract";

beforeAll(polyfillCodeMirrorDom);

const H = (c: string) => c.repeat(64);
const TEXT = ["head", "<<<<<<< HEAD", "top1", "=======", "bot1", ">>>>>>> feature", "mid", "<<<<<<< HEAD", "top2", "=======", "bot2", ">>>>>>> feature", "tail", ""].join("\n");
const base = { eligible: true as const, hasStagedContent: false, isNew: false, isUntracked: false, conflicted: true, size: 3, mtimeMs: 1, mode: 0o644 };
const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;
const side = (text: string) => ({ status: "ok" as const, sha: "a".repeat(40), mode: "100644", text });
const okSides = { base: side("base\n"), ours: side("top1\n"), theirs: side("bot1\n") };
const label = (l: string, ref: string) => ({ label: l, refName: ref, sha: "abc1234" });

function setup(opts: { sides?: unknown; labels?: unknown; props?: Partial<EditorPaneProps> } = {}) {
  const api = makeMockGitHydra();
  api.readEditableFile = vi.fn(() => Promise.resolve({ ok: true as const, data: { ...base, content: TEXT, eol: "lf" as const, hasBom: false, finalNewline: true, contentHash: H("a") } })) as GitHydraApi["readEditableFile"];
  api.readConflictSides = vi.fn(() => Promise.resolve({ ok: true as const, data: opts.sides === undefined ? okSides : opts.sides })) as unknown as GitHydraApi["readConflictSides"];
  api.getConflictSideLabels = vi.fn(() =>
    Promise.resolve({
      ok: true as const,
      data: opts.labels === undefined ? { ours: label("Your branch (main @ abc1234)", "main"), theirs: label("Incoming (feature @ def5678)", "feature") } : opts.labels,
    }),
  ) as unknown as GitHydraApi["getConflictSideLabels"];
  api.onWorktreeChanged = vi.fn(() => () => {});
  const props: EditorPaneProps = {
    api,
    path: "src/f.txt",
    open: {},
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
  const utils = render(<EditorPane {...props} />);
  return { api, props, ...utils };
}

const ready = () => screen.findByRole("textbox", { name: "Editing src/f.txt" });
const chip = (n: number, name: RegExp | string) => within(screen.getByRole("group", { name: `Resolution for conflict ${n}` })).getByRole("button", { name });
const primary = () => screen.getByTestId("mark-resolved");

describe("EditorPane conflict block editor (specs/edit-in-diff.md FR-556..FR-565)", () => {
  it("opens a text conflict as blocks: Resolving tag, navigator, no Save and stage, Mark as resolved off with the line numbers", async () => {
    setup();
    await ready();
    expect(screen.getByText("Resolving")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Save and stage/ })).toBeNull();
    await waitFor(() => expect(screen.getByRole("group", { name: "Conflict navigator" })).toHaveTextContent("1 of 2"));
    expect(screen.getByRole("button", { name: /2 conflicts unresolved/ })).toBeInTheDocument();
    expect(primary()).toHaveAttribute("aria-disabled", "true");
    expect(primary()).toHaveAttribute("aria-describedby");
    expect(screen.getByText(/Conflict markers still present \(lines 2, 4, 6, 8, 10, 12\)/)).toBeInTheDocument();
    expect(screen.getByRole("note", { name: "" })).toBeTruthy();
  });

  it("deciding every block opens the gate; Mark as resolved saves through the guarded write path, then stages from the disk (FR-563)", async () => {
    const { api, props } = setup();
    await ready();
    act(() => chip(1, /^Yours/).click());
    act(() => chip(2, /^Incoming/).click());
    expect(screen.getByText("All 2 decided")).toBeInTheDocument();
    expect(primary()).not.toHaveAttribute("aria-disabled");
    expect(primary()).toHaveTextContent("Save and mark resolved");

    const order: string[] = [];
    mock(api.writeEditedFile).mockImplementationOnce((_p: string, content: string) => {
      order.push(`write:${content.includes("<<<<<<<") ? "markers" : "clean"}`);
      return Promise.resolve({ ok: true as const, data: { status: "written" as const, contentHash: H("b"), mtimeMs: 2, size: 4 } });
    });
    mock(api.markConflictResolved).mockImplementationOnce(() => {
      order.push("mark");
      return Promise.resolve({ ok: true as const, data: undefined });
    });
    fireEvent.click(primary());
    await waitFor(() => expect(props.onResolved).toHaveBeenCalledTimes(1));
    expect(order).toEqual(["write:clean", "mark"]);
    expect(api.markConflictResolved).toHaveBeenCalledWith("src/f.txt");
    expect(props.onMutationStart).toHaveBeenCalledTimes(1);
    // The block layer is gone once the file is resolved; the text stays.
    await waitFor(() => expect(screen.queryByRole("group", { name: "Resolution for conflict 1" })).toBeNull());
    expect(screen.getAllByText("Marked as resolved and staged.").length).toBeGreaterThan(0);
  });

  it("while any marker remains, clicking Mark as resolved writes and stages nothing and says why", async () => {
    const { api } = setup();
    await ready();
    act(() => chip(1, /^Yours/).click());
    fireEvent.click(primary());
    expect(api.writeEditedFile).not.toHaveBeenCalled();
    expect(api.markConflictResolved).not.toHaveBeenCalled();
    expect(screen.getAllByText(/Conflict markers still present/).length).toBeGreaterThan(0);
  });

  it("a refused stage keeps the buffer and shows the typed reason (FR-558)", async () => {
    const { api, props } = setup();
    await ready();
    act(() => chip(1, /^Yours/).click());
    act(() => chip(2, /^Yours/).click());
    mock(api.writeEditedFile).mockResolvedValueOnce({ ok: true, data: { status: "written", contentHash: H("b"), mtimeMs: 2, size: 4 } });
    mock(api.markConflictResolved).mockResolvedValueOnce({ ok: false, error: { name: "NotConflictedError", message: 'Cannot resolve "src/f.txt"' } });
    fireEvent.click(primary());
    expect(await screen.findByRole("alert")).toHaveTextContent("Nothing was staged: this file is no longer in a conflicted state.");
    expect(props.onResolved).not.toHaveBeenCalled();
    expect(props.onMutationSettled).toHaveBeenCalledTimes(1);
  });

  it("the first decision announces the move and shows a toast whose Undo returns; re-deciding shows no toast (FR-562)", async () => {
    setup();
    const ed = await ready();
    act(() => chip(1, /^Yours/).click());
    const toast = screen.getByText("Moved to conflict 2 of 2, the next unresolved one.");
    expect(toast).toBeInTheDocument();
    expect(screen.getAllByRole("status").some((r) => /Conflict 1 of 2: Yours \(main\)\. 1 conflict unresolved\. Moved to conflict 2 of 2/.test(r.textContent ?? ""))).toBe(true);
    fireEvent.click(within(toast.parentElement!).getByRole("button", { name: "Undo" }));
    expect(screen.queryByText("Moved to conflict 2 of 2, the next unresolved one.")).toBeNull();
    expect(viewOf(ed.closest(".gh-edit")!).state.doc.toString()).toBe(TEXT);
    act(() => chip(1, /^Yours/).click());
    act(() => chip(1, /^Incoming/).click());
    expect(screen.queryByText("Moved to conflict 2 of 2, the next unresolved one.")).toBeNull();
  });

  it("F3 / Shift+F3 and Alt+Down / Alt+Up move between conflicts, by physical key code", async () => {
    setup();
    const ed = await ready();
    const nav = screen.getByRole("group", { name: "Conflict navigator" });
    await waitFor(() => expect(nav).toHaveTextContent("1 of 2"));
    fireEvent.keyDown(ed, { key: "F3", code: "F3" });
    expect(nav).toHaveTextContent("2 of 2");
    fireEvent.keyDown(ed, { key: "F3", code: "F3", shiftKey: true });
    expect(nav).toHaveTextContent("1 of 2");
    fireEvent.keyDown(ed, { key: "ArrowDown", code: "ArrowDown", altKey: true });
    expect(nav).toHaveTextContent("2 of 2");
    fireEvent.keyDown(ed, { key: "ArrowUp", code: "ArrowUp", altKey: true });
    expect(nav).toHaveTextContent("1 of 2");
  });

  it("the navigator exposes Next/Previous to the Command Palette", async () => {
    const commandsRef = { current: null as null | { nextConflict(): void; prevConflict(): void } };
    const onCommandStateChange = vi.fn();
    setup({ props: { commandsRef: commandsRef as unknown as EditorPaneProps["commandsRef"], onCommandStateChange } });
    await ready();
    const nav = screen.getByRole("group", { name: "Conflict navigator" });
    await waitFor(() => expect(nav).toHaveTextContent("1 of 2"));
    act(() => commandsRef.current!.nextConflict());
    expect(nav).toHaveTextContent("2 of 2");
    act(() => commandsRef.current!.prevConflict());
    expect(nav).toHaveTextContent("1 of 2");
    await waitFor(() => expect(onCommandStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ conflict: true, conflictCount: 2 })));
  });

  it("a rebase shows the swap note and names Onto before Yours (FR-61, FR-559)", async () => {
    setup({ labels: { ours: label("Onto (main @ abc1234)", "main"), theirs: label("Your branch (feature @ def5678)", "feature") } });
    await ready();
    expect(screen.getByText(/Rebase swaps the sides/)).toBeInTheDocument();
    const [first, second] = within(screen.getByRole("group", { name: "Resolution for conflict 1" })).getAllByRole("button");
    expect(first).toHaveAccessibleName("Onto, main");
    expect(second).toHaveAccessibleName("Yours, feature");
  });

  it("an unreadable stage disables Yours/Incoming/Both with the reason but leaves Neither and hand editing (FR-559)", async () => {
    setup({ sides: { base: side(""), ours: { status: "binary", sha: null, mode: null, text: null }, theirs: side("x\n") } });
    await ready();
    expect(chip(1, /^Yours/)).toHaveAttribute("aria-disabled", "true");
    expect(chip(1, /^Yours/)).toHaveAttribute("title", expect.stringMatching(/could not be read/));
    expect(chip(1, "Neither, remove both sides")).not.toHaveAttribute("aria-disabled");
  });

  it("a path that is no longer unmerged falls back to the ordinary editor", async () => {
    setup({ sides: null });
    await ready();
    expect(screen.queryByText("Resolving")).toBeNull();
    expect(screen.getByRole("button", { name: /^Save and stage/ })).toBeInTheDocument();
  });

  it("an ordinary file never gets the conflict layer", async () => {
    const api = makeMockGitHydra();
    api.readEditableFile = vi.fn(() => Promise.resolve({ ok: true as const, data: { ...base, conflicted: false, content: "x\n", eol: "lf" as const, hasBom: false, finalNewline: true, contentHash: H("a") } })) as GitHydraApi["readEditableFile"];
    api.onWorktreeChanged = vi.fn(() => () => {});
    render(<EditorPane api={api} path="src/f.txt" open={{}} guard={createDirtyLeaveRegistry()} indexDiffersFromWorkingCopy={false} lineWasStaged={false} onClose={vi.fn()} onSaved={vi.fn()} />);
    await ready();
    expect(api.readConflictSides).not.toHaveBeenCalled();
    expect(screen.queryByText("Resolving")).toBeNull();
  });
});
