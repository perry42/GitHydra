// SPDX-License-Identifier: GPL-3.0-or-later
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CombinedDiffHunk, CombinedFileDiffResult, FileDiffResult, WorkingDirectoryChanges } from "@githydra/git-core";
import { ChangesPanel, type ChangesPanelProps } from "./ChangesPanel";
import { makeMockGitHydra } from "../../test/mockGitHydra";
import type { GitHydraApi } from "../../../shared/ipcContract";

// specs/live-refresh.md FR-460, FR-461, FR-493 through the real ChangesPanel + useChangesPanel. The harness plays
// the graph hook's part: it owns `changes` and bumps `liveRevision` on every simulated working-dir read.

const ok = <T,>(data: T) => ({ ok: true as const, data });

interface Control {
  read: (changes: WorkingDirectoryChanges) => void;
}

function Harness({ initial, ctl, ...rest }: { initial: WorkingDirectoryChanges; ctl: { current: Control | null } } & Omit<ChangesPanelProps, "changes" | "liveRevision">) {
  const [changes, setChanges] = useState(initial);
  const [rev, setRev] = useState(0);
  ctl.current = {
    read: (next) => {
      setChanges((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      setRev((r) => r + 1);
    },
  };
  return <ChangesPanel {...rest} changes={changes} liveRevision={rev} />;
}

const entry = (path: string, category: "staged" | "unstaged" | "untracked") => ({ path, status: "modified" as const, category });
const list = (p: Partial<WorkingDirectoryChanges>): WorkingDirectoryChanges => ({ staged: [], unstaged: [], untracked: [], conflicted: [], ...p });

function diffOf(content: string): FileDiffResult {
  return {
    status: "ok",
    isBinary: false,
    hunks: [
      {
        header: "@@ -1,1 +1,1 @@",
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: [
          { type: "remove", content: "old", oldLineNumber: 1, newLineNumber: null },
          { type: "add", content, oldLineNumber: null, newLineNumber: 1 },
        ],
      },
    ],
  };
}

function combinedHunks(addText: string, staged = false): CombinedDiffHunk[] {
  const line = (type: "add" | "remove", content: string, n: number) => ({
    type,
    content,
    oldLineNumber: type === "remove" ? n : null,
    newLineNumber: type === "add" ? n : null,
    staged,
    discardable: !staged,
  });
  return [
    {
      header: "@@ -1,2 +1,2 @@",
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 2,
      stagedState: staged ? "all" : "none",
      lines: [line("remove", "old1", 1), line("add", addText, 1), line("remove", "old2", 2), line("add", "new2", 2)],
    },
  ];
}

function mount(api: GitHydraApi, initial: WorkingDirectoryChanges, extra: Partial<ChangesPanelProps> = {}) {
  const ctl: { current: Control | null } = { current: null };
  render(<Harness api={api} initial={initial} ctl={ctl} onClose={() => {}} onWorkingDirChanged={() => {}} onCommitCreated={() => {}} {...extra} />);
  return ctl;
}

const row = (path: string) => screen.getByRole("button", { name: new RegExp(`modified.*${path.replace(".", "[.]")}`, "i") });

describe("ChangesPanel live refresh: selection by path (FR-460)", () => {
  it("keeps the selection on the path when it moves from Unstaged to Staged, reloading the diff in place", async () => {
    const api = makeMockGitHydra({ fileDiff: diffOf("new") });
    vi.mocked(api.getCombinedFileDiff).mockResolvedValue(ok<CombinedFileDiffResult>({ mode: "separate", reason: "ambiguous" }));
    const staged = vi.mocked(api.getStagedFileDiff);
    staged.mockResolvedValue(ok(diffOf("staged-new")));
    const ctl = mount(api, list({ unstaged: [entry("a.ts", "unstaged"), entry("b.ts", "unstaged")] }));
    await waitFor(() => expect(row("a.ts")).toHaveAttribute("aria-pressed", "true"));

    act(() => ctl.current!.read(list({ staged: [entry("a.ts", "staged")], unstaged: [entry("b.ts", "unstaged")] })));

    await waitFor(() => expect(staged).toHaveBeenCalledWith("a.ts"));
    await waitFor(() => expect(screen.getByText("staged-new")).toBeInTheDocument());
    expect(row("a.ts")).toHaveAttribute("aria-pressed", "true");
    expect(row("b.ts")).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByText(/loading diff/i)).not.toBeInTheDocument();
  });

  it("AC4: a file that loses all changes shows 'no longer has changes' and waits, selecting nothing else", async () => {
    const api = makeMockGitHydra({ fileDiff: diffOf("new") });
    vi.mocked(api.getCombinedFileDiff).mockResolvedValue(ok<CombinedFileDiffResult>({ mode: "separate", reason: "ambiguous" }));
    const ctl = mount(api, list({ unstaged: [entry("a.ts", "unstaged"), entry("b.ts", "unstaged")] }));
    await waitFor(() => expect(row("a.ts")).toHaveAttribute("aria-pressed", "true"));

    act(() => ctl.current!.read(list({ unstaged: [entry("b.ts", "unstaged")] })));

    await waitFor(() => expect(screen.getByText("This file no longer has changes.")).toBeInTheDocument());
    expect(row("b.ts")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("heading", { name: "a.ts" })).toBeInTheDocument();

    // It keeps waiting through further reads, and picks the path back up if it changes again.
    act(() => ctl.current!.read(list({ unstaged: [entry("b.ts", "unstaged")] })));
    expect(screen.getByText("This file no longer has changes.")).toBeInTheDocument();
    act(() => ctl.current!.read(list({ unstaged: [entry("a.ts", "unstaged"), entry("b.ts", "unstaged")] })));
    await waitFor(() => expect(screen.queryByText("This file no longer has changes.")).not.toBeInTheDocument());
    expect(row("a.ts")).toHaveAttribute("aria-pressed", "true");
  });
});

describe("ChangesPanel live refresh: open diff (FR-461)", () => {
  it("AC3: an unchanged diff keeps its DOM nodes; a changed one reloads in place", async () => {
    const api = makeMockGitHydra({ fileDiff: diffOf("new") });
    vi.mocked(api.getCombinedFileDiff).mockResolvedValue(ok<CombinedFileDiffResult>({ mode: "separate", reason: "ambiguous" }));
    const unstaged = vi.mocked(api.getUnstagedFileDiff);
    unstaged.mockResolvedValue(ok(diffOf("new")));
    const initial = list({ unstaged: [entry("a.ts", "unstaged")] });
    const ctl = mount(api, initial);
    const before = await screen.findByText("new");

    const reads = unstaged.mock.calls.length;
    act(() => ctl.current!.read(initial));
    await waitFor(() => expect(unstaged.mock.calls.length).toBeGreaterThan(reads));
    expect(screen.getByText("new")).toBe(before);

    unstaged.mockResolvedValue(ok(diffOf("edited")));
    act(() => ctl.current!.read(initial));
    expect(await screen.findByText("edited")).toBeInTheDocument();
    expect(screen.queryByText(/loading diff/i)).not.toBeInTheDocument();
  });

  it("an untracked file's diff reloads when its content changes", async () => {
    const api = makeMockGitHydra({ fileDiff: diffOf("new") });
    const read = vi.mocked(api.getUntrackedFileDiff);
    read.mockResolvedValue(ok(diffOf("v1")));
    const initial = list({ untracked: [entry("n.txt", "untracked")] });
    const ctl = mount(api, initial);
    await screen.findByText("v1");
    read.mockResolvedValue(ok(diffOf("v2")));
    act(() => ctl.current!.read(initial));
    expect(await screen.findByText("v2")).toBeInTheDocument();
  });
});

describe("ChangesPanel live refresh: checkbox diff (FR-493)", () => {
  function combinedApi(initialText = "new1") {
    const api = makeMockGitHydra({ fileDiff: diffOf("x") });
    const state = { text: initialText, n: 1 };
    vi.mocked(api.getCombinedFileDiff).mockImplementation(async () =>
      ok<CombinedFileDiffResult>({ mode: "combined", fingerprint: `fp-${state.n}-${state.text}`, hunks: combinedHunks(state.text) }),
    );
    return { api, state };
  }
  const initial = list({ unstaged: [entry("a.ts", "unstaged")] });

  it("defers a live reload while a toggle is in flight and runs it once the toggle resolves", async () => {
    const { api } = combinedApi();
    let release: () => void = () => {};
    vi.mocked(api.toggleCombinedLines).mockImplementationOnce(() => new Promise((res) => (release = () => res(ok(undefined)))));
    const ctl = mount(api, initial);
    const box = await screen.findByRole("checkbox", { name: /^Added line 1/ });
    fireEvent.click(box.querySelector(".gh-diff-view__gutter")!);
    await waitFor(() => expect(api.toggleCombinedLines).toHaveBeenCalledTimes(1));

    const reads = vi.mocked(api.getCombinedFileDiff).mock.calls.length;
    act(() => ctl.current!.read(initial));
    await act(async () => void (await new Promise((r) => setTimeout(r, 30))));
    expect(vi.mocked(api.getCombinedFileDiff).mock.calls.length).toBe(reads);

    release();
    await waitFor(() => expect(vi.mocked(api.getCombinedFileDiff).mock.calls.length).toBeGreaterThan(reads));
  });

  it("AC11: a tick queued behind an in-flight apply is refused when an external edit changed the rows meanwhile", async () => {
    const { api, state } = combinedApi();
    let release: () => void = () => {};
    vi.mocked(api.toggleCombinedLines).mockImplementationOnce(
      () =>
        new Promise((res) => {
          release = () => {
            state.text = "edited externally"; // the file changes while the first apply is landing
            state.n++;
            res(ok(undefined));
          };
        }),
    );
    mount(api, initial);
    const first = await screen.findByRole("checkbox", { name: /^Added line 1/ });
    fireEvent.click(first.querySelector(".gh-diff-view__gutter")!);
    await waitFor(() => expect(api.toggleCombinedLines).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("checkbox", { name: /^Added line 2/ }).querySelector(".gh-diff-view__gutter")!);

    release();

    await waitFor(() => expect(screen.getByText(/file changed on disk, so nothing was staged/i)).toBeInTheDocument());
    expect(api.toggleCombinedLines).toHaveBeenCalledTimes(1); // the second tick never reached git
    expect(await screen.findByText("edited externally")).toBeInTheDocument();
  });

  it("clears the Shift anchor when the rows changed, so a Shift-click is a single toggle, never a range over other rows", async () => {
    const { api, state } = combinedApi();
    const ctl = mount(api, initial);
    const first = await screen.findByRole("checkbox", { name: /^Added line 1/ });
    fireEvent.click(first.querySelector(".gh-diff-view__gutter")!);
    await waitFor(() => expect(api.toggleCombinedLines).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());

    state.text = "edited externally";
    state.n++;
    act(() => ctl.current!.read(initial));
    await screen.findByText("edited externally");

    fireEvent.click(screen.getByRole("checkbox", { name: /^Added line 2/ }).querySelector(".gh-diff-view__gutter")!, { shiftKey: true });
    await waitFor(() => expect(api.toggleCombinedLines).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.toggleCombinedLines).mock.calls[1]![2]).toHaveLength(1);
  });

  it("keeps the anchor across the toggle's own reload (staging does not move rows)", async () => {
    const { api } = combinedApi();
    mount(api, initial);
    const first = await screen.findByRole("checkbox", { name: /^Added line 1/ });
    fireEvent.click(first.querySelector(".gh-diff-view__gutter")!);
    await waitFor(() => expect(api.toggleCombinedLines).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(vi.mocked(api.getCombinedFileDiff).mock.calls.length).toBeGreaterThan(1));
    fireEvent.click(screen.getByRole("checkbox", { name: /^Added line 2/ }).querySelector(".gh-diff-view__gutter")!, { shiftKey: true });
    await waitFor(() => expect(api.toggleCombinedLines).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.toggleCombinedLines).mock.calls[1]![2].length).toBeGreaterThan(1);
  });
});

describe("ChangesPanel idle-gate reporting (FR-465)", () => {
  it("reports the composer as busy while it holds a draft and clears it on unmount", async () => {
    const api = makeMockGitHydra({ fileDiff: diffOf("x") });
    const onInteractionChange = vi.fn();
    const ctl = { current: null as Control | null };
    const view = render(
      <Harness
        api={api}
        initial={list({ unstaged: [entry("a.ts", "unstaged")] })}
        ctl={ctl}
        onClose={() => {}}
        onWorkingDirChanged={() => {}}
        onCommitCreated={() => {}}
        onInteractionChange={onInteractionChange}
      />,
    );
    await waitFor(() => expect(onInteractionChange).toHaveBeenCalledWith({ composerBusy: false, conflictViewOpen: false, mutationBusy: false }));
    fireEvent.change(screen.getByPlaceholderText("Summarize this commit"), { target: { value: "wip" } });
    await waitFor(() => expect(onInteractionChange).toHaveBeenLastCalledWith(expect.objectContaining({ composerBusy: true })));
    view.unmount();
    expect(onInteractionChange).toHaveBeenLastCalledWith({ composerBusy: false, conflictViewOpen: false, mutationBusy: false });
  });
});
