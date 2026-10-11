// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorPane, resetHintDismissedForTests, type EditorPaneProps } from "./EditorPane";
import { makeMockGitHydra } from "../../test/mockGitHydra";
import { polyfillCodeMirrorDom, viewOf } from "../../test/codemirrorDom";
import { createDirtyLeaveRegistry } from "../../hooks/useDirtyLeaveGuard";
import type { GitHydraApi } from "../../../shared/ipcContract";

beforeAll(polyfillCodeMirrorDom);
beforeEach(resetHintDismissedForTests);

const H = (c: string) => c.repeat(64);
const TEXT = ["head", "<<<<<<< HEAD", "top1", "=======", "bot1", ">>>>>>> feature", "mid", "<<<<<<< HEAD", "top2", "=======", "bot2", ">>>>>>> feature", "tail", ""].join("\n");
const base = { eligible: true as const, hasStagedContent: false, isNew: false, isUntracked: false, conflicted: true, size: 3, mtimeMs: 1, mode: 0o644 };
const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;
const side = (text: string) => ({ status: "ok" as const, sha: "a".repeat(40), mode: "100644", text });
const okSides = { base: side("base\n"), ours: side("top1\n"), theirs: side("bot1\n") };
const label = (l: string, ref: string) => ({ label: l, refName: ref, sha: "abc1234" });

function setup(opts: { sides?: unknown; labels?: unknown; props?: Partial<EditorPaneProps>; conflicted?: boolean; content?: string } = {}) {
  const api = makeMockGitHydra();
  api.readEditableFile = vi.fn(() => Promise.resolve({ ok: true as const, data: { ...base, conflicted: opts.conflicted ?? true, content: opts.content ?? TEXT, eol: "lf" as const, hasBom: false, finalNewline: true, contentHash: H("a") } })) as GitHydraApi["readEditableFile"];
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
const pill = () => screen.getByRole("region", { name: "Conflict navigation" });

describe("EditorPane conflict block editor (specs/edit-in-diff.md FR-556..FR-565)", () => {
  it("opens a text conflict as blocks: Resolving tag, navigator, no Save and stage, Mark as resolved off with the line numbers", async () => {
    setup();
    await ready();
    expect(screen.getByText("Resolving")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Save and stage/ })).toBeNull();
    await waitFor(() => expect(pill()).toHaveTextContent("1 of 2"));
    expect(screen.getByRole("button", { name: /2 conflicts unresolved/ })).toBeInTheDocument();
    expect(primary()).toHaveAttribute("aria-disabled", "true");
    expect(primary()).toHaveAttribute("aria-describedby");
    expect(screen.getByText(/Conflict markers still present \(lines 2, 4, 6, 8, 10, 12\)/)).toBeInTheDocument();
    // FR-573: ONE slot; the blocking reason outranks the hint, so the hint is not there yet.
    expect(screen.getAllByTestId("editor-slot")).toHaveLength(1);
    expect(screen.queryByRole("note", { name: "" })).toBeNull();
  });

  it("deciding every block opens the gate; Mark as resolved saves through the guarded write path, then stages from the disk (FR-563)", async () => {
    const { api, props } = setup();
    await ready();
    act(() => chip(1, /^Yours/).click());
    act(() => chip(2, /^Incoming/).click());
    expect(screen.getByTestId("pill-all-decided")).toHaveTextContent("All decided");
    expect(primary()).not.toHaveAttribute("aria-disabled");
    expect(primary()).toHaveTextContent("Mark as resolved");

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
    const nav = pill();
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
    const nav = pill();
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
    const [first, second] = within(screen.getByRole("group", { name: "Resolution for conflict 1" })).getAllByRole("button");
    expect(first).toHaveAccessibleName("Onto, main");
    expect(second).toHaveAccessibleName("Yours, feature");
    // The hint (here the rebase variant) takes the slot once nothing blocks.
    act(() => chip(1, /^Onto/).click());
    act(() => chip(2, /^Onto/).click());
    expect(screen.getByText(/Rebase swaps the sides/)).toBeInTheDocument();
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

  it("when every block is decided and no marker is left the pill and the button say so; the live region says it in words (FR-576)", async () => {
    setup();
    await ready();
    await waitFor(() => expect(pill()).toHaveTextContent("1 of 2"));
    expect(primary().className).not.toContain("gh-edit__btn--ready");
    expect(screen.queryByText("All conflicts decided. Mark as resolved is available.")).toBeNull();
    act(() => chip(1, /^Yours/).click());
    act(() => chip(2, /^Incoming/).click());
    expect(screen.queryByText(/Looks good/)).toBeNull();
    expect(primary().className).toContain("gh-edit__btn--ready");
    expect(screen.getByTestId("pill-all-decided")).toBeInTheDocument();
    const polite = screen.getAllByRole("status").find((r) => /All conflicts decided\. Mark as resolved is available\./.test(r.textContent ?? ""));
    expect(polite).toBeTruthy();
    expect(screen.getByText("All 2 conflicts decided, no markers left")).toBeInTheDocument();
    // Undo returns to the quiet state.
    act(() => within(screen.getByRole("toolbar", { name: "Editor actions" })).getByRole("button", { name: /^Undo/ }).click());
    expect(primary().className).not.toContain("gh-edit__btn--ready");
  });

  it("the hint takes the slot only when nothing blocks; Got it dismisses it for the session, never persisted (FR-573)", async () => {
    const first = setup();
    await ready();
    act(() => chip(1, /^Yours/).click());
    act(() => chip(2, /^Incoming/).click());
    const slot = screen.getByTestId("editor-slot");
    expect(slot).toHaveTextContent("Editing the working file");
    fireEvent.click(within(slot).getByRole("button", { name: "Got it" }));
    expect(screen.queryByTestId("editor-slot")).toBeNull();
    first.unmount();
    // A later open in the same session stays dismissed...
    setup();
    await ready();
    act(() => chip(1, /^Yours/).click());
    act(() => chip(2, /^Incoming/).click());
    expect(screen.queryByTestId("editor-slot")).toBeNull();
    // ...and nothing was written to storage.
    expect(JSON.stringify({ ...localStorage })).not.toMatch(/hint|got ?it/i);
  });

  it("the blocking reason comes back over the hint when a block is undone (FR-573)", async () => {
    setup();
    await ready();
    act(() => chip(1, /^Yours/).click());
    act(() => chip(2, /^Incoming/).click());
    expect(screen.getByTestId("editor-slot")).toHaveTextContent("Editing the working file");
    act(() => chip(2, /^Reset/).click());
    expect(screen.getByTestId("editor-slot")).toHaveTextContent(/Conflict markers still present/);
  });

  it("an unacknowledged operation alert gates Mark as resolved with the reason, like the file-level view (FR-571)", async () => {
    const { api } = setup({ props: { blockActions: true } });
    await ready();
    act(() => chip(1, /^Yours/).click());
    act(() => chip(2, /^Incoming/).click());
    expect(primary()).toHaveAttribute("aria-disabled", "true");
    expect(primary().className).not.toContain("gh-edit__btn--ready");
    fireEvent.click(primary());
    expect(screen.getAllByText(/changed outside GitHydra/).length).toBeGreaterThan(0);
    expect(api.markConflictResolved).not.toHaveBeenCalled();
  });

  it("Undo and Redo are offered in a plain edit as well as in a conflict (FR-570)", async () => {
    setup({ conflicted: false, content: "plain\n" });
    await ready();
    const bar = screen.getByRole("toolbar", { name: "Editor actions" });
    expect(within(bar).getByRole("button", { name: /^Undo/ })).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: /^Redo/ })).toBeInTheDocument();
  });

  async function resolveAll(props: Partial<EditorPaneProps>) {
    const r = setup({ props });
    await ready();
    act(() => chip(1, /^Yours/).click());
    act(() => chip(2, /^Incoming/).click());
    fireEvent.click(primary());
    await waitFor(() => expect(r.props.onResolved).toHaveBeenCalled());
    return r;
  }
  const flow = (over: Partial<NonNullable<EditorPaneProps["conflictFlow"]>>): NonNullable<EditorPaneProps["conflictFlow"]> => ({
    conflictedPaths: ["src/f.txt", "src/g.txt", "src/h.txt"],
    operation: "merge",
    nextPath: "src/g.txt",
    onOpenNext: vi.fn(),
    continueOp: { run: vi.fn(), isContinuing: false, error: null, clearError: vi.fn() },
    ...over,
  });

  it("a successful auto-advance never flashes the resolved toolbar: not before the refresh, not after it (FR-577)", async () => {
    const f = flow({});
    const r = await resolveAll({ conflictFlow: f });
    expect(screen.queryByTestId("resolved-strip")).toBeNull();
    r.rerender(<EditorPane {...r.props} conflictFlow={{ ...f, conflictedPaths: ["src/g.txt", "src/h.txt"] }} />);
    expect(screen.queryByTestId("resolved-strip")).toBeNull();
  });

  it("when auto-open is blocked the toolbar swaps to Staged + count and ONE focused Next conflicted file (FR-577, FR-569)", async () => {
    const f = flow({});
    const r = await resolveAll({ conflictFlow: f });
    r.rerender(<EditorPane {...r.props} conflictFlow={{ ...f, conflictedPaths: ["src/g.txt", "src/h.txt"] }} blockActions />);
    const strip = await screen.findByTestId("resolved-strip");
    expect(within(strip).getByRole("status")).toHaveAttribute("aria-live", "polite");
    expect(strip).toHaveTextContent("Staged · 2 files left");
    const next = within(strip).getByRole("button", { name: "Next conflicted file" });
    expect(within(strip).getAllByRole("button")).toHaveLength(1);
    expect(next.className).toContain("gh-edit__btn--primary");
    await waitFor(() => expect(next).toHaveFocus());
    // The toolbar swapped: no Save, no Undo, and the blocked reason sits in the slot.
    expect(within(screen.getByRole("toolbar", { name: "Editor actions" })).queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByTestId("editor-slot")).toHaveTextContent(/changed outside GitHydra/);
    fireEvent.click(next);
    expect(f.onOpenNext).toHaveBeenCalledTimes(1);
  });

  it("when it was the last file the toolbar offers Continue, never fired by itself, live only once the list is refreshed (FR-577, FR-569)", async () => {
    const f = flow({ conflictedPaths: ["src/f.txt"], nextPath: null });
    const r = await resolveAll({ conflictFlow: f });
    expect(screen.queryByTestId("resolved-strip")).toBeNull();
    // The Changes list refreshed: the file is gone, so Continue is live.
    r.rerender(<EditorPane {...r.props} conflictFlow={{ ...f, conflictedPaths: [] }} />);
    const strip = await screen.findByTestId("resolved-strip");
    expect(strip).toHaveTextContent("All conflicts resolved");
    const live = within(strip).getByRole("button", { name: "Continue merge" });
    expect(live).not.toHaveAttribute("aria-disabled");
    expect(f.continueOp.run).not.toHaveBeenCalled();
    fireEvent.click(live);
    expect(f.continueOp.run).toHaveBeenCalledTimes(1);
  });

  it("Continue stays disabled with the lock reason while an operation alert is unacknowledged (FR-569)", async () => {
    const f = flow({ conflictedPaths: [], nextPath: null });
    const r = await resolveAll({ conflictFlow: f });
    r.rerender(<EditorPane {...r.props} conflictFlow={f} blockActions />);
    const cont = await screen.findByRole("button", { name: "Continue merge" });
    expect(cont).toHaveAttribute("aria-disabled", "true");
    expect(cont.getAttribute("title")).toMatch(/changed outside GitHydra/);
  });

  it("the Undo toast lasts 15 seconds, and hovering or focusing it holds it (FR-570)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      setup();
      await ready();
      act(() => chip(1, /^Yours/).click());
      const toast = document.querySelector(".gh-cf-toast") as HTMLElement;
      expect(toast).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(document.querySelector(".gh-cf-toast")).toBeTruthy();
      fireEvent.mouseEnter(toast);
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(document.querySelector(".gh-cf-toast")).toBeTruthy();
      fireEvent.mouseLeave(toast);
      act(() => {
        vi.advanceTimersByTime(16_000);
      });
      expect(document.querySelector(".gh-cf-toast")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  describe("toolbar and pill (FR-573..FR-579)", () => {
    // jsdom has no container queries, so the stylesheet leaves the overflow trigger at its default display:none; show it as the <760px step does.
    beforeEach(() => {
      const st = document.createElement("style");
      st.id = "ovf-test";
      st.textContent = ".gh-edit__ovf{display:inline-flex !important}";
      document.head.appendChild(st);
      return () => st.remove();
    });
    const names = (bar: HTMLElement) => within(bar).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent?.trim());

    it("in a conflict the far-right slot is Mark as resolved, after Save, after Undo/Redo/More (FR-578)", async () => {
      setup();
      await ready();
      const bar = screen.getByRole("toolbar", { name: "Editor actions" });
      const n = names(bar);
      expect(n[0]).toBe("Back to changes");
      expect(n.slice(1)).toEqual([expect.stringMatching(/^Undo/), expect.stringMatching(/^Redo/), "More editor actions", "Save", "Mark as resolved"]);
      expect(primary().className).toContain("gh-edit__btn--primary");
    });

    it("in a plain edit Save stays the primary look when dirty and Save and stage sits far right in secondary weight (FR-578, FR-533)", async () => {
      setup({ conflicted: false, content: "plain\n" });
      const ed = await ready();
      const bar = screen.getByRole("toolbar", { name: "Editor actions" });
      const btns = within(bar).getAllByRole("button");
      const last = btns[btns.length - 1]!;
      expect(last).toHaveTextContent("Save and stage");
      expect(btns[btns.length - 2]).toHaveTextContent("Save");
      expect(last.className).not.toContain("gh-edit__btn--primary");
      expect(btns[btns.length - 2]!.className).not.toContain("gh-edit__btn--primary");
      act(() => {
        const v = viewOf(ed.closest(".gh-edit")!);
        v.dispatch({ changes: { from: 0, insert: "x" } });
      });
      await waitFor(() => expect(within(bar).getByRole("button", { name: "Save" }).className).toContain("gh-edit__btn--primary"));
      expect(within(bar).getAllByRole("button").at(-1)).toHaveTextContent("Save and stage");
      expect(within(bar).getAllByRole("button").at(-1)!.className).not.toContain("gh-edit__btn--primary");
    });

    it("the Unsaved word stays in the bar, and the Back button keeps its name and Esc hint when its label is hidden by width (FR-579)", async () => {
      setup({ conflicted: false, content: "plain\n" });
      const ed = await ready();
      act(() => viewOf(ed.closest(".gh-edit")!).dispatch({ changes: { from: 0, insert: "x" } }));
      const bar = screen.getByRole("toolbar", { name: "Editor actions" });
      await waitFor(() => expect(within(bar).getByText("Unsaved")).toBeInTheDocument());
      const back = within(bar).getByRole("button", { name: "Back to diff" });
      expect(back).toHaveAttribute("title", expect.stringMatching(/Esc/));
    });

    it("the overflow menu lists Undo and Redo with their shortcuts; Esc closes it and returns to the trigger without leaving the editor (FR-579)", async () => {
      const { props } = setup({ conflicted: false, content: "plain\n" });
      await ready();
      const user = userEvent.setup();
      const more = screen.getByRole("button", { name: "More editor actions" });
      await user.click(more);
      const menu = screen.getByRole("menu", { name: "Editor actions" });
      const items = within(menu).getAllByRole("menuitem");
      expect(items[0]).toHaveTextContent(/Undo.*Ctrl\+Z/);
      expect(items[1]).toHaveTextContent(/Redo.*Ctrl\+Shift\+Z/);
      expect(more).toHaveAttribute("aria-expanded", "true");
      expect(items[0]).toHaveFocus();
      await user.keyboard("{ArrowDown}");
      expect(items[1]).toHaveFocus();
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("menu")).toBeNull();
      expect(more).toHaveFocus();
      expect(props.onClose).not.toHaveBeenCalled();
    });

    it("choosing Undo in the overflow menu undoes in the text and returns focus there", async () => {
      setup({ conflicted: false, content: "plain\n" });
      const ed = await ready();
      const v = viewOf(ed.closest(".gh-edit")!);
      act(() => v.dispatch({ changes: { from: 0, insert: "x" }, userEvent: "input.type" }));
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "More editor actions" }));
      await user.click(screen.getByRole("menuitem", { name: /^Undo/ }));
      expect(v.state.doc.toString()).toBe("plain\n");
      expect(v.hasFocus).toBe(true);
    });

    it("the pill is a labelled region after the text in tab order, with shortcut-labelled buttons and a hidden status that speaks the move (FR-574, FR-575)", async () => {
      setup();
      const ed = await ready();
      await waitFor(() => expect(pill()).toHaveTextContent("1 of 2"));
      const p = pill();
      expect(ed.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(within(p).getByRole("button", { name: "Previous conflict (Shift+F3)" })).toBeInTheDocument();
      expect(within(p).getByRole("button", { name: "Next conflict (F3)" })).toBeInTheDocument();
      expect(p.querySelector(".gh-pill__count")).toHaveAttribute("aria-hidden", "true");
      expect(within(p).getByRole("status")).toHaveTextContent("Conflict 1 of 2. 2 conflicts unresolved.");
      fireEvent.click(within(p).getByRole("button", { name: "Next conflict (F3)" }));
      expect(within(p).getByRole("status")).toHaveTextContent("Conflict 2 of 2. 2 conflicts unresolved.");
    });

    it("a mouse click on an arrow returns focus to the text; keyboard activation keeps focus on the button (FR-575)", async () => {
      setup();
      const ed = await ready();
      await waitFor(() => expect(pill()).toHaveTextContent("1 of 2"));
      const next = within(pill()).getByRole("button", { name: "Next conflict (F3)" });
      next.focus();
      fireEvent.click(next, { detail: 0 });
      expect(next).toHaveFocus();
      expect(pill()).toHaveTextContent("2 of 2");
      const user = userEvent.setup();
      await user.click(next);
      expect(ed).toHaveFocus();
      expect(pill()).toHaveTextContent("1 of 2");
    });

    it("Esc inside the pill returns focus to the text and does not leave the editor (FR-575)", async () => {
      const { props } = setup();
      const ed = await ready();
      await waitFor(() => expect(pill()).toHaveTextContent("1 of 2"));
      const next = within(pill()).getByRole("button", { name: "Next conflict (F3)" });
      next.focus();
      fireEvent.keyDown(next, { key: "Escape", code: "Escape" });
      expect(ed).toHaveFocus();
      expect(props.onClose).not.toHaveBeenCalled();
    });

    it("Ctrl+F in the editor is swallowed: it never reaches the global Focus-branches-search binding (ROADMAP: Find in editor)", async () => {
      setup();
      const ed = await ready();
      const seen = vi.fn();
      document.addEventListener("keydown", seen);
      try {
        const ev = new KeyboardEvent("keydown", { key: "f", code: "KeyF", ctrlKey: true, bubbles: true, cancelable: true });
        ed.dispatchEvent(ev);
        expect(ev.defaultPrevented).toBe(true);
        expect(seen).not.toHaveBeenCalled();
      } finally {
        document.removeEventListener("keydown", seen);
      }
    });
  });
});
