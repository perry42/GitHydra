// SPDX-License-Identifier: GPL-3.0-or-later
import { createRef, useCallback, useEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type {
  CombinedDiffHunk,
  CombinedFileDiffResult,
  FileDiffResult,
  PartialStagingIneligibleReason,
  WorkingDirectoryChanges,
} from "@githydra/git-core";
import { ChangesPanel, type ChangesPanelHandle, type ChangesPanelProps } from "./ChangesPanel";
import { makeMockGitHydra } from "../../test/mockGitHydra";
import type { GitHydraApi } from "../../../shared/ipcContract";

// specs/hunk-line-staging.md FR-453..FR-455, FR-477..FR-483 through the real ChangesPanel + useChangesPanel.

function Harness(props: Omit<ChangesPanelProps, "changes"> & { panelRef?: React.Ref<ChangesPanelHandle> }) {
  const [changes, setChanges] = useState<WorkingDirectoryChanges | null | undefined>(undefined);
  const refetch = useCallback(() => {
    void props.api.getWorkingDirectoryChanges().then((r) => r.ok && setChanges(r.data));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.api]);
  useEffect(refetch, [refetch]);
  if (changes === undefined) return null;
  const { panelRef, ...rest } = props;
  return (
    <ChangesPanel
      {...rest}
      ref={panelRef}
      changes={changes}
      onWorkingDirChanged={() => {
        refetch();
        props.onWorkingDirChanged();
      }}
    />
  );
}

const ok = <T,>(data: T) => ({ ok: true as const, data });
const err = (name: string, message: string) => ({ ok: false as const, error: { name, message } });

// Base shape of a.ts's combined diff. Hunk 0: ctx, -old (1), +new (2), ctx. Hunk 1: ctx, -gone (1), ctx.
function buildHunks(staged: ReadonlySet<string>, header0 = "@@ -1,3 +1,3 @@"): CombinedDiffHunk[] {
  const L = (h: number, i: number, type: "add" | "remove", content: string, n: number) => ({
    type,
    content,
    oldLineNumber: type === "remove" ? n : null,
    newLineNumber: type === "add" ? n : null,
    staged: staged.has(`${h}:${i}`),
    discardable: !staged.has(`${h}:${i}`),
  });
  const C = (content: string, n: number) => ({
    type: "context" as const,
    content,
    oldLineNumber: n,
    newLineNumber: n,
    staged: false,
    discardable: false,
  });
  const state = (h: number, idx: number[]) => {
    const c = idx.filter((i) => staged.has(`${h}:${i}`)).length;
    return c === 0 ? ("none" as const) : c === idx.length ? ("all" as const) : ("some" as const);
  };
  return [
    {
      header: header0,
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 3,
      stagedState: state(0, [1, 2]),
      lines: [C("keep", 1), L(0, 1, "remove", "old", 2), L(0, 2, "add", "new", 2), C("tail", 3)],
    },
    {
      header: "@@ -20,3 +20,2 @@",
      oldStart: 20,
      oldLines: 3,
      newStart: 20,
      newLines: 2,
      stagedState: state(1, [1]),
      lines: [C("c", 20), L(1, 1, "remove", "gone", 21), C("d", 22)],
    },
  ];
}

/** A tiny fake index behind getCombinedFileDiff/toggleCombinedLines, so a toggle really changes the next read. */
function fakeIndex(api: GitHydraApi, initialStaged: string[] = []) {
  const st = { n: 1, staged: new Set(initialStaged), header0: "@@ -1,3 +1,3 @@" };
  vi.mocked(api.getCombinedFileDiff).mockImplementation(async () =>
    ok<CombinedFileDiffResult>({ mode: "combined", fingerprint: `fp-${st.n}`, hunks: buildHunks(st.staged, st.header0) }),
  );
  vi.mocked(api.toggleCombinedLines).mockImplementation(async (_path, _fp, lines, target) => {
    for (const l of lines) {
      const k = `${l.hunkIndex}:${l.lineIndex}`;
      if (target === "stage") st.staged.add(k);
      else st.staged.delete(k);
    }
    st.n++;
    return ok(undefined);
  });
  return st;
}

const unstagedOnly: WorkingDirectoryChanges = {
  staged: [],
  unstaged: [{ path: "a.ts", status: "modified", category: "unstaged" }],
  untracked: [],
  conflicted: [],
};

const plainDiff: FileDiffResult = {
  status: "ok",
  isBinary: false,
  hunks: [
    {
      header: "@@ -1,2 +1,2 @@",
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 2,
      lines: [
        { type: "remove", content: "old", oldLineNumber: 1, newLineNumber: null },
        { type: "add", content: "new", oldLineNumber: null, newLineNumber: 1 },
        { type: "context", content: "same", oldLineNumber: 2, newLineNumber: 2 },
      ],
    },
  ],
};

function setup(
  changes: WorkingDirectoryChanges = unstagedOnly,
  { staged = [] as string[], combined = true as boolean } = {},
) {
  const api = makeMockGitHydra({ workingDirectoryChanges: changes, fileDiff: plainDiff });
  const index = combined ? fakeIndex(api, staged) : null;
  const onWorkingDirChanged = vi.fn();
  const panelRef = createRef<ChangesPanelHandle>();
  const onHunkCommandsChange = vi.fn();
  render(
    <Harness
      api={api}
      panelRef={panelRef}
      onClose={() => {}}
      onWorkingDirChanged={onWorkingDirChanged}
      onCommitCreated={() => {}}
      onHunkCommandsChange={onHunkCommandsChange}
    />,
  );
  return { api, index, onWorkingDirChanged, panelRef, onHunkCommandsChange };
}

// A live-refresh reload (FR-485) may add one extra read after each toggle, so reads are counted "at least".
const reads = (api: GitHydraApi) => vi.mocked(api.getCombinedFileDiff).mock.calls.length;
const line = (name: string) => screen.findByRole("checkbox", { name: new RegExp(`^${name}(:|$)`) });
const lineNow = (name: string) => screen.getByRole("checkbox", { name: new RegExp(`^${name}(:|$)`) });
const click = (el: HTMLElement) => fireEvent.click(el.querySelector(".gh-diff-view__gutter") ?? el);
const hunkBox = (n: number, of = 2) => screen.findByRole("checkbox", { name: `Hunk ${n} of ${of}` });

function separateResult(reason: PartialStagingIneligibleReason): CombinedFileDiffResult {
  return { mode: "separate", reason };
}

describe("ChangesPanel checkbox staging", () => {
  it("shows the combined diff for an eligible unstaged file without loading the separate diff", async () => {
    const { api } = setup();
    expect(await hunkBox(1)).toHaveAttribute("aria-checked", "false");
    expect(await line("Added line 2")).toHaveAttribute("aria-checked", "false");
    expect(api.getCombinedFileDiff).toHaveBeenCalledWith("a.ts");
    expect(api.getUnstagedFileDiff).not.toHaveBeenCalled();
    expect(document.querySelector("button[data-gutter]")).toBeNull(); // old select-then-act UI is gone
  });

  it("hunk checkbox stages every changed line of the hunk with the displayed fingerprint (AC1), then reloads in place with scroll preserved (AC11)", async () => {
    const { api, onWorkingDirChanged } = setup();
    const box = await hunkBox(1);
    const scroller = document.querySelector<HTMLElement>(".gh-diff-view__hunks")!;
    scroller.scrollTop = 140;

    fireEvent.click(box);

    await waitFor(() =>
      expect(api.toggleCombinedLines).toHaveBeenCalledWith(
        "a.ts",
        "fp-1",
        [
          { hunkIndex: 0, lineIndex: 1 },
          { hunkIndex: 0, lineIndex: 2 },
        ],
        "stage",
      ),
    );
    await waitFor(() => expect(reads(api)).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(onWorkingDirChanged).toHaveBeenCalled());
    expect(await hunkBox(1)).toHaveAttribute("aria-checked", "true");
    expect(document.querySelector(".gh-diff-view__hunks")).toBe(scroller); // never unmounted
    expect(scroller.scrollTop).toBe(140);
    expect(screen.queryByText(/loading diff/i)).not.toBeInTheDocument();
  });

  it("ticks optimistically before git answers (AC2)", async () => {
    const { api } = setup();
    const row = await line("Added line 2");
    let release: () => void = () => {};
    vi.mocked(api.toggleCombinedLines).mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve(ok(undefined)))),
    );
    click(row);
    await waitFor(() => expect(lineNow("Added line 2")).toHaveAttribute("aria-checked", "true"));
    expect(reads(api)).toBe(1); // still waiting on git
    release();
    await waitFor(() => expect(reads(api)).toBeGreaterThanOrEqual(2));
  });

  it("a single line toggles exactly that line, and clicking again unstages it (AC2)", async () => {
    const { api } = setup();
    click(await line("Removed line 2"));
    await waitFor(() =>
      expect(api.toggleCombinedLines).toHaveBeenLastCalledWith("a.ts", "fp-1", [{ hunkIndex: 0, lineIndex: 1 }], "stage"),
    );
    await waitFor(() => expect(lineNow("Removed line 2")).toHaveAttribute("aria-checked", "true"));
    await waitFor(() => expect(reads(api)).toBeGreaterThanOrEqual(2));
    click(lineNow("Removed line 2"));
    await waitFor(() =>
      expect(api.toggleCombinedLines).toHaveBeenLastCalledWith("a.ts", "fp-2", [{ hunkIndex: 0, lineIndex: 1 }], "unstage"),
    );
  });

  it("Shift-click stages the whole range in ONE operation (AC5)", async () => {
    const { api } = setup();
    click(await line("Removed line 2"));
    await waitFor(() => expect(api.toggleCombinedLines).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(reads(api)).toBeGreaterThanOrEqual(2));
    fireEvent.click(lineNow("Removed line 21").querySelector(".gh-diff-view__gutter")!, { shiftKey: true });
    await waitFor(() => expect(api.toggleCombinedLines).toHaveBeenCalledTimes(2));
    expect(api.toggleCombinedLines).toHaveBeenLastCalledWith(
      "a.ts",
      "fp-2",
      [
        { hunkIndex: 0, lineIndex: 1 },
        { hunkIndex: 0, lineIndex: 2 },
        { hunkIndex: 1, lineIndex: 1 },
      ],
      "stage",
    );
  });

  it("clicks made while an operation is in flight queue and run with the fresh fingerprint", async () => {
    const { api } = setup();
    const a = await line("Removed line 2");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const real = vi.mocked(api.toggleCombinedLines).getMockImplementation()!;
    vi.mocked(api.toggleCombinedLines).mockImplementationOnce(async (...args) => {
      await gate;
      return real(...args);
    });
    click(a);
    await waitFor(() => expect(api.toggleCombinedLines).toHaveBeenCalledTimes(1));
    click(lineNow("Added line 2")); // second click while the first is still being applied
    expect(api.toggleCombinedLines).toHaveBeenCalledTimes(1);
    expect(lineNow("Added line 2")).toHaveAttribute("aria-checked", "true"); // optimistic already
    release();
    await waitFor(() => expect(api.toggleCombinedLines).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.toggleCombinedLines).mock.calls[1]![1]).toBe("fp-2");
    await waitFor(() => expect(reads(api)).toBeGreaterThanOrEqual(3));
    expect(lineNow("Removed line 2")).toHaveAttribute("aria-checked", "true");
    expect(lineNow("Added line 2")).toHaveAttribute("aria-checked", "true");
  });

  it("STALE_DIFF: one-line notice beside the diff, reload, 'try again', nothing retried, tick reverted (AC7)", async () => {
    const { api, index } = setup();
    const row = await line("Removed line 2");
    vi.mocked(api.toggleCombinedLines).mockResolvedValueOnce(err("StaleDiffError", "The diff for a.ts changed."));
    index!.n = 5;
    index!.header0 = "@@ -9,3 +9,3 @@";

    click(row);

    const notice = await screen.findByText("The file changed on disk, so nothing was staged.");
    expect(notice.closest(".gh-changes-panel__diff")).not.toBeNull();
    fireEvent.click(within(notice.closest<HTMLElement>("[role=status]")!).getByRole("button", { name: "Show details" }));
    expect(screen.getByText(/Try again; nothing is retried automatically/)).toBeInTheDocument();
    await screen.findByText("@@ -9,3 +9,3 @@");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(lineNow("Removed line 2")).toHaveAttribute("aria-checked", "false");
    expect(api.toggleCombinedLines).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("status").some((r) => /Diff reloaded; try again\./.test(r.textContent ?? ""))).toBe(true);
    // the user tries again against the fresh fingerprint
    click(lineNow("Removed line 2"));
    await waitFor(() => expect(vi.mocked(api.toggleCombinedLines).mock.calls[1]![1]).toBe("fp-5"));
  });

  it("another failure (locked index) shows a one-line summary with details, reverts the tick and is not stuck busy (AC13)", async () => {
    const { api, onWorkingDirChanged } = setup();
    const row = await line("Added line 2");
    vi.mocked(api.toggleCombinedLines).mockResolvedValueOnce(
      err(
        "GitCommandError",
        "git -c core.fsmonitor=false -c core.hooksPath=C:/x apply --cached - exited with code 128:\nfatal: Unable to create '.git/index.lock': File exists.",
      ),
    );

    click(row);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't stage: another git process holds index.lock");
    expect(alert.closest(".gh-changes-panel__diff")).not.toBeNull();
    expect(alert).not.toHaveTextContent("core.fsmonitor");
    fireEvent.click(within(alert).getByRole("button", { name: "Show details" }));
    expect(alert).toHaveTextContent("Unable to create '.git/index.lock'");
    await waitFor(() => expect(lineNow("Added line 2")).toHaveAttribute("aria-checked", "false")); // reverted
    expect(onWorkingDirChanged).toHaveBeenCalled();
    expect(screen.getByText("Unstaged (1)")).toBeInTheDocument();
    click(lineNow("Added line 2"));
    await waitFor(() => expect(api.toggleCombinedLines).toHaveBeenCalledTimes(2));
  });

  it("announces ticks and failures in the polite live region (AC15)", async () => {
    const { api } = setup();
    click(await line("Removed line 2"));
    await waitFor(() =>
      expect(screen.getAllByRole("status").some((r) => /Staged line 2/.test(r.textContent ?? ""))).toBe(true),
    );
    await waitFor(() => expect(reads(api)).toBeGreaterThanOrEqual(2));
    click(lineNow("Removed line 2"));
    await waitFor(() =>
      expect(screen.getAllByRole("status").some((r) => /Unstaged line 2/.test(r.textContent ?? ""))).toBe(true),
    );
  });

  it("announces the tick at click time, before git answers, and names the real action when an unstage fails", async () => {
    const { api } = setup(unstagedOnly, { staged: ["0:2"] });
    const statusText = () => screen.getAllByRole("status").map((r) => r.textContent ?? "").join("|");
    const row = await line("Added line 2");
    expect(row).toHaveAttribute("aria-checked", "true");
    vi.mocked(api.toggleCombinedLines).mockImplementationOnce(
      () => new Promise(() => {}), // never answers: only the click-time announcement can be present
    );
    click(await line("Removed line 2"));
    await waitFor(() => expect(statusText()).toMatch(/Ticked line 2/));
  });

  it("a failed UNSTAGE says Couldn't unstage, not Couldn't stage", async () => {
    const { api } = setup(unstagedOnly, { staged: ["0:2"] });
    const row = await line("Added line 2");
    vi.mocked(api.toggleCombinedLines).mockResolvedValueOnce(
      err("GitCommandError", "git apply exited with code 1: error: patch failed"),
    );
    click(row);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/^Couldn't unstage the selection/);
    await waitFor(() =>
      expect(screen.getAllByRole("status").some((r) => /Couldn't unstage the selection/.test(r.textContent ?? ""))).toBe(true),
    );
  });

  describe("discard (FR-478)", () => {
    it("the header Discard asks for confirmation naming the file and hunk, says unrecoverable; Cancel does nothing (AC9)", async () => {
      const { api } = setup();
      fireEvent.click(await screen.findByRole("button", { name: "Discard hunk 1 of 2" }));
      const dialog = await screen.findByRole("alertdialog");
      expect(dialog).toHaveTextContent(
        "Discard 1 hunk (lines 1–3) from a.ts? This permanently removes the change from your working tree. This cannot be undone.",
      );
      expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
      expect(api.discardCombinedLines).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(api.discardCombinedLines).not.toHaveBeenCalled();
    });

    it("confirming calls discardCombinedLines with the fingerprint captured at click time and reloads", async () => {
      const { api } = setup();
      fireEvent.click(await screen.findByRole("button", { name: "Discard hunk 2 of 2" }));
      fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Discard hunk" }));
      await waitFor(() =>
        expect(api.discardCombinedLines).toHaveBeenCalledWith("a.ts", "fp-1", [{ hunkIndex: 1, lineIndex: 1 }]),
      );
      await waitFor(() => expect(reads(api)).toBeGreaterThanOrEqual(2));
    });

    it("the right-click menu on a line offers Discard, naming the line count in the same confirmation", async () => {
      const { api } = setup();
      fireEvent.contextMenu(await line("Removed line 2"));
      fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Discard 1 line" }));
      const dialog = await screen.findByRole("alertdialog");
      expect(dialog).toHaveTextContent("Discard 1 line from a.ts?");
      fireEvent.click(within(dialog).getByRole("button", { name: "Discard 1 line" }));
      await waitFor(() =>
        expect(api.discardCombinedLines).toHaveBeenCalledWith("a.ts", "fp-1", [{ hunkIndex: 0, lineIndex: 1 }]),
      );
    });

    it("a mixed hunk discards only its unstaged lines (the staged ones are never sent)", async () => {
      const { api } = setup(unstagedOnly, { staged: ["0:2"] });
      fireEvent.click(await screen.findByRole("button", { name: "Discard hunk 1 of 2" }));
      const dialog = await screen.findByRole("alertdialog");
      expect(dialog).toHaveTextContent("Discard 1 line from a.ts?");
      fireEvent.click(within(dialog).getByRole("button", { name: "Discard 1 line" }));
      await waitFor(() =>
        expect(api.discardCombinedLines).toHaveBeenCalledWith("a.ts", "fp-1", [{ hunkIndex: 0, lineIndex: 1 }]),
      );
    });

    it("a Discard clicked while a tick is still being applied opens its confirmation once that settles, with the fresh fingerprint", async () => {
      const { api } = setup();
      const row = await line("Added line 2");
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      const real = vi.mocked(api.toggleCombinedLines).getMockImplementation()!;
      vi.mocked(api.toggleCombinedLines).mockImplementationOnce(async (...args) => {
        await gate;
        return real(...args);
      });
      click(row); // stages "+new" in hunk 0 and is still in flight
      await waitFor(() => expect(api.toggleCombinedLines).toHaveBeenCalledTimes(1));
      fireEvent.click(screen.getByRole("button", { name: "Discard hunk 2 of 2" }));
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(); // not yet: the diff is mid-change
      release();
      const dialog = await screen.findByRole("alertdialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "Discard hunk" }));
      await waitFor(() =>
        expect(api.discardCombinedLines).toHaveBeenCalledWith("a.ts", "fp-2", [{ hunkIndex: 1, lineIndex: 1 }]),
      );
    });

    it("offers no Discard on a staged line and none on a fully staged hunk", async () => {
      setup(unstagedOnly, { staged: ["0:1", "0:2"] });
      await hunkBox(1);
      expect(screen.queryByRole("button", { name: "Discard hunk 1 of 2" })).not.toBeInTheDocument();
      fireEvent.contextMenu(await line("Added line 2"));
      expect(within(screen.getByRole("menu")).queryByRole("menuitem", { name: /discard/i })).toBeNull();
    });
  });

  describe("fallback to the separate diffs (FR-481)", () => {
    it("an ineligible file shows today's plain diff: no checkboxes, whole-file Stage remains (AC8)", async () => {
      const { api } = setup(unstagedOnly, { combined: false });
      vi.mocked(api.getCombinedFileDiff).mockResolvedValue(ok(separateResult("renamed")));
      await screen.findByText("@@ -1,2 +1,2 @@");
      expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
      expect(screen.queryByText("Line-level staging unavailable for this file.")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^stage$/i })).toBeInTheDocument();
    });

    it("'ambiguous' falls back with exactly one neutral note beside the diff, never a half tick", async () => {
      const { api } = setup(unstagedOnly, { combined: false });
      vi.mocked(api.getCombinedFileDiff).mockResolvedValue(ok(separateResult("ambiguous")));
      const note = await screen.findByText("Line-level staging unavailable for this file.");
      expect(note.closest(".gh-changes-panel__diff")).not.toBeNull();
      expect(screen.getByText("@@ -1,2 +1,2 @@")).toBeInTheDocument();
      expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    });

    it("a staged-side ineligible file loads the staged diff", async () => {
      const { api } = setup(
        { staged: [{ path: "a.ts", status: "modified", category: "staged" }], unstaged: [], untracked: [], conflicted: [] },
        { combined: false },
      );
      vi.mocked(api.getCombinedFileDiff).mockResolvedValue(ok(separateResult("binary")));
      await screen.findByText("@@ -1,2 +1,2 @@");
      expect(api.getStagedFileDiff).toHaveBeenCalledWith("a.ts");
    });

    it("an untracked file never asks for the combined view and has no checkboxes", async () => {
      const { api } = setup(
        { staged: [], unstaged: [], untracked: [{ path: "a.ts", status: "added", category: "untracked" }], conflicted: [] },
        { combined: false },
      );
      await screen.findByText("@@ -1,2 +1,2 @@");
      expect(api.getCombinedFileDiff).not.toHaveBeenCalled();
      expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    });

    it("if the combined read itself fails, the plain diff is still shown", async () => {
      const { api } = setup(unstagedOnly, { combined: false });
      vi.mocked(api.getCombinedFileDiff).mockResolvedValue(err("GitCommandError", "boom"));
      await screen.findByText("@@ -1,2 +1,2 @@");
    });
  });

  describe("file list: partly staged files (FR-482/FR-488, layout AC7)", () => {
    const both: WorkingDirectoryChanges = {
      staged: [{ path: "a.ts", status: "modified", category: "staged" }],
      unstaged: [{ path: "a.ts", status: "modified", category: "unstaged" }],
      untracked: [],
      conflicted: [],
    };
    const section = (label: RegExp) =>
      screen.getByRole("heading", { name: label }).closest<HTMLElement>("section.gh-changes-panel__section")!;

    it("an eligible partly staged file appears ONCE, in Unstaged, with the Partly staged marker", async () => {
      setup(both, { staged: ["0:1"] });
      await hunkBox(1);
      await waitFor(() => expect(screen.getByRole("heading", { name: /^Staged \(0\)/ })).toBeInTheDocument());
      expect(screen.getByRole("heading", { name: /^Unstaged \(1\)/ })).toBeInTheDocument();
      const marker = within(section(/^Unstaged/)).getByRole("img", { name: "Partly staged" });
      expect(marker).toHaveAttribute("title", "Partly staged");
      expect(screen.getAllByText("a.ts")).toHaveLength(2); // the row's name + the diff heading, never two rows
    });

    it("collapses immediately: one row with the marker in the first frame, before any per-file read has answered", async () => {
      const { api } = setup(both, { combined: false });
      vi.mocked(api.getCombinedFileDiff).mockImplementation(() => new Promise(() => {})); // verdicts never arrive
      expect(await screen.findByRole("img", { name: "Partly staged" })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: /^Staged \(0\)/ })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: /^Unstaged \(1\)/ })).toBeInTheDocument();
    });

    it("an ineligible partly staged file still appears in both sections, with no marker", async () => {
      const { api } = setup(both, { combined: false });
      vi.mocked(api.getCombinedFileDiff).mockResolvedValue(ok(separateResult("mode-change")));
      await screen.findByText("@@ -1,2 +1,2 @@");
      await waitFor(() => expect(api.getCombinedFileDiff).toHaveBeenCalled());
      expect(screen.getByRole("heading", { name: /^Staged \(1\)/ })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: /^Unstaged \(1\)/ })).toBeInTheDocument();
      expect(screen.queryByRole("img", { name: "Partly staged" })).not.toBeInTheDocument();
    });

    it("a fully staged eligible file stays in Staged only", async () => {
      setup(
        { staged: [{ path: "a.ts", status: "modified", category: "staged" }], unstaged: [], untracked: [], conflicted: [] },
        { staged: ["0:1", "0:2", "1:1"] },
      );
      expect(await hunkBox(1)).toHaveAttribute("aria-checked", "true");
      expect(screen.getByRole("heading", { name: /^Staged \(1\)/ })).toBeInTheDocument();
      expect(screen.queryByRole("img", { name: "Partly staged" })).not.toBeInTheDocument();
    });

    it("mixed row: Stage stages the whole file", async () => {
      const { api } = setup(both, { staged: ["0:1"] });
      await screen.findByRole("img", { name: "Partly staged" });
      fireEvent.click(within(section(/^Unstaged/)).getByRole("button", { name: "Stage" }));
      await waitFor(() => expect(api.stageFile).toHaveBeenCalledWith("a.ts"));
    });

    it("mixed row: Unstage unstages the whole file", async () => {
      const { api } = setup(both, { staged: ["0:1"] });
      await screen.findByRole("img", { name: "Partly staged" });
      fireEvent.click(within(section(/^Unstaged/)).getByRole("button", { name: "Unstage" }));
      await waitFor(() => expect(api.unstageFile).toHaveBeenCalledWith("a.ts"));
    });

    it("mixed row: Discard confirms, says only the unstaged part goes, then discards the file's worktree changes", async () => {
      const { api } = setup(both, { staged: ["0:1"] });
      await screen.findByRole("img", { name: "Partly staged" });
      fireEvent.click(within(section(/^Unstaged/)).getByRole("button", { name: "Discard changes to a.ts" }));
      const dialog = await screen.findByRole("alertdialog");
      expect(dialog).toHaveTextContent("Only the unstaged part is discarded; your staged changes are kept.");
      expect(api.discardTrackedFileChanges).not.toHaveBeenCalled();
      fireEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
      await waitFor(() => expect(api.discardTrackedFileChanges).toHaveBeenCalledWith("a.ts"));
    });

    it("the mixed row is highlighted as the open file even though the file moved sections", async () => {
      setup(both, { staged: ["0:1"] });
      await screen.findByRole("img", { name: "Partly staged" });
      const label = section(/^Unstaged/).querySelector(".gh-changes-panel__file-label")!;
      await waitFor(() => expect(label).toHaveAttribute("aria-pressed", "true")); // selection settles a tick after the list
    });
  });

  describe("Command Palette hunk commands (FR-483)", () => {
    it("are unavailable until a hunk has the cursor, then act on that hunk", async () => {
      const { api, panelRef, onHunkCommandsChange } = setup();
      await hunkBox(1);
      expect(onHunkCommandsChange).toHaveBeenLastCalledWith({ toggle: false, discard: false });
      fireEvent.focus(screen.getByRole("checkbox", { name: "Hunk 2 of 2" }));
      await waitFor(() => expect(onHunkCommandsChange).toHaveBeenLastCalledWith({ toggle: true, discard: true }));

      act(() => panelRef.current!.toggleCurrentHunk());
      await waitFor(() =>
        expect(api.toggleCombinedLines).toHaveBeenCalledWith("a.ts", "fp-1", [{ hunkIndex: 1, lineIndex: 1 }], "stage"),
      );
      await waitFor(() => expect(reads(api)).toBeGreaterThanOrEqual(2));

      act(() => panelRef.current!.discardCurrentHunk());
      expect(api.discardCombinedLines).not.toHaveBeenCalled(); // opens the confirmation, never discards by itself
    });

    it("Discard hunk is unavailable on a fully staged hunk", async () => {
      const { onHunkCommandsChange } = setup(unstagedOnly, { staged: ["1:1"] });
      await hunkBox(2);
      fireEvent.focus(screen.getByRole("checkbox", { name: "Hunk 2 of 2" }));
      await waitFor(() => expect(onHunkCommandsChange).toHaveBeenLastCalledWith({ toggle: true, discard: false }));
    });
  });

  it("when the last unstaged change is discarded the clean file drops out of the diff", async () => {
    const { api } = setup();
    await hunkBox(1);
    vi.mocked(api.getCombinedFileDiff).mockResolvedValue(ok({ mode: "combined", fingerprint: "fp-9", hunks: [] }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard hunk 1 of 2" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Discard hunk" }));
    await waitFor(() => expect(api.discardCombinedLines).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryAllByRole("checkbox")).toHaveLength(0));
  });
});
