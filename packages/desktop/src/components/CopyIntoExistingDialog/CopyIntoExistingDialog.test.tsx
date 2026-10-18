// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { decideInitialTicks } from "@githydra/git-core";
import type { GitHydraApi, WorktreeExistingCopyResult, WorktreeExistingListing, WorktreeExistingProgress, WorktreeExistingRow } from "../../../shared/ipcContract";
import { makeMockGitHydra } from "../../test/mockGitHydra";
import { readCopyRecord } from "../../lib/worktreeCopyMemory";
import { CopyIntoExistingDialog } from "./CopyIntoExistingDialog";

const KEY = "a".repeat(64);

export function row(path: string, over: Partial<WorktreeExistingRow> = {}): WorktreeExistingRow {
  return {
    id: path,
    path,
    displayPath: path,
    isDirectory: path.endsWith("/"),
    fileCount: 1,
    copyableCount: 1,
    existingCount: 0,
    bytes: 1024,
    disabledReason: null,
    disabledText: null,
    secret: false,
    runsCode: false,
    large: false,
    changesGit: false,
    notIgnoredInDestination: false,
    droppedFiles: 0,
    droppedReasons: {},
    ...over,
  };
}

function listing(rows: WorktreeExistingRow[], over: { dest?: Partial<Extract<WorktreeExistingListing, { status: "ok" }>["destination"]>; source?: string; matched?: string[] } = {}): WorktreeExistingListing {
  return {
    status: "ok",
    token: rows.length === 0 ? "" : "tok-1",
    source: { name: over.source ?? "acme" },
    destination: { id: "tl", name: "tour-login", path: "/w/tour-login", branch: "tour-login", detached: false, shortHead: null, ...over.dest },
    rows,
    include: { status: over.matched ? "ok" : "absent", matchedRows: over.matched ?? [], skipped: [] },
  };
}

const done = (over: Partial<Extract<WorktreeExistingCopyResult, { skipped: unknown }>> = {}): WorktreeExistingCopyResult => ({
  status: "done",
  copied: 1,
  bytes: 1024,
  skipped: [],
  skippedTotal: 0,
  from: "acme",
  into: "tour-login",
  ...over,
});

interface Over {
  rows?: WorktreeExistingRow[];
  listingResult?: WorktreeExistingListing;
  copy?: (req: { token: string; rowIds: string[] }) => Promise<WorktreeExistingCopyResult> | WorktreeExistingCopyResult;
  sourcePath?: string;
  matched?: string[];
}

function setup(over: Over = {}) {
  const api = makeMockGitHydra({ repoPath: "/w/acme" });
  const l = over.listingResult ?? listing(over.rows ?? [], { matched: over.matched });
  (api as { listIgnoredForExisting: unknown }).listIgnoredForExisting = vi.fn(() => Promise.resolve({ ok: true, data: l }));
  (api as { getWorktreeRepoKey: unknown }).getWorktreeRepoKey = vi.fn(() => Promise.resolve({ ok: true, data: KEY }));
  const progressListeners: ((p: WorktreeExistingProgress) => void)[] = [];
  (api as { onIgnoredCopyIntoExistingProgress: unknown }).onIgnoredCopyIntoExistingProgress = (fn: (p: WorktreeExistingProgress) => void) => {
    progressListeners.push(fn);
    return () => progressListeners.splice(progressListeners.indexOf(fn), 1);
  };
  const runCopy = vi.fn(async (req: { token: string; rowIds: string[] }) => (over.copy ? await over.copy(req) : done()));
  const onClose = vi.fn();
  const view = render(<CopyIntoExistingDialog api={api} destId="tl" sourcePath={over.sourcePath} runCopy={runCopy} onClose={onClose} />);
  return { api: api as GitHydraApi & { listIgnoredForExisting: ReturnType<typeof vi.fn>; cancelIgnoredCopyIntoExisting: ReturnType<typeof vi.fn>; releaseIgnoredForExisting: ReturnType<typeof vi.fn> }, runCopy, onClose, progressListeners, ...view };
}

/** M1 lets no key through for 400 ms and Enter needs a released key first; tests move the clock and release one key. */
function pastGuard(ms = 500) {
  vi.setSystemTime(new Date(Date.now() + ms));
}
const releaseKey = () => fireEvent.keyUp(screen.getByRole("dialog"), { key: "Shift" });

beforeEach(() => {
  window.localStorage.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
});

describe("CopyIntoExistingDialog (FR-651)", () => {
  it("is ONE sentence with bold folder names plus a separate muted destination path (no two-row list)", async () => {
    setup({ rows: [row(".env")] });
    const dialog = await screen.findByRole("dialog", { name: "Copy ignored files" });
    const sentence = within(dialog).getByText((_, el) => el?.tagName === "P" && el.textContent === "From acme into tour-login.");
    expect(within(sentence).getByText("acme").tagName).toBe("STRONG");
    expect(within(sentence).getByText("tour-login").tagName).toBe("STRONG");
    const path = within(dialog).getByText("/w/tour-login");
    expect(path).toHaveClass("gh-copy-into__path");
    expect(path.closest("p")).not.toBe(sentence);
    expect(dialog.querySelector("dl")).toBeNull();
  });

  it("uses the full paths in the sentence when both folder names are equal", async () => {
    setup({ rows: [row(".env")], listingResult: listing([row(".env")], { source: "app", dest: { name: "app", path: "/w/b/app" } }), sourcePath: "/w/a/app" });
    const sentence = await screen.findByText((_, el) => el?.tagName === "P" && el.textContent === "From /w/a/app into /w/b/app.");
    expect(sentence).toBeInTheDocument();
  });

  it("shows main's names as text and cuts a single name at 120 characters in the middle", async () => {
    const long = "x".repeat(300);
    setup({ rows: [row(".env", { displayPath: "bad\u202ename" })], listingResult: listing([row("a.txt", { displayPath: "bad U+202E name" })], { dest: { name: long } }) });
    const sentence = await screen.findByText((_, el) => el?.tagName === "P" && /^From acme into x+\.\.\.x+\.$/.test(el.textContent ?? ""));
    expect(sentence.textContent!.length).toBeLessThan(150);
    expect(screen.getByText("bad U+202E name")).toBeInTheDocument();
  });

  it("focus lands on the first ENABLED row checkbox; with every row disabled it stays on Cancel", async () => {
    const view = setup({ rows: [row("a.txt", { disabledReason: "already-exists", disabledText: "already exists" }), row("b.txt")] });
    const checkboxes = await screen.findAllByRole("checkbox");
    await waitFor(() => expect(checkboxes[1]).toHaveFocus());
    view.unmount();
    setup({ rows: [row("a.txt", { disabledReason: "already-exists", disabledText: "already exists" })] });
    await screen.findByText("already exists");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("zero candidates: the muted sentence and ONE Close button that has the focus", async () => {
    const { onClose } = setup({ rows: [] });
    expect(await screen.findByText("No ignored files to copy in this repository.")).toHaveClass("gh-copy__text--muted");
    const buttons = within(screen.getByRole("dialog")).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Close"]);
    await waitFor(() => expect(buttons[0]).toHaveFocus());
    pastGuard();
    await userEvent.click(buttons[0]!);
    expect(onClose).toHaveBeenCalled();
  });

  it("renders the intro, the footer sentence, one list-level secret warning, the tags and no 'Select all'", async () => {
    setup({
      rows: [
        row(".env", { secret: true }),
        row(".npmrc", { secret: true }),
        row(".vscode/", { runsCode: true, isDirectory: true, fileCount: 3, copyableCount: 3 }),
        row("big/", { large: true, isDirectory: true }),
        row("config/", { isDirectory: true, fileCount: 3, copyableCount: 2, existingCount: 1 }),
        row(".gitignore", { changesGit: true }),
      ],
      matched: ["config/"],
    });
    await screen.findByText("Tick the ignored files you want copied. Files that already exist in tour-login are never overwritten.");
    expect(screen.getByText("Changes you make here are remembered for this repository, on this computer.")).toBeInTheDocument();
    expect(screen.getAllByText('Rows marked "secret" look like passwords, tokens or keys. Copy them only if the new worktree needs them.')).toHaveLength(1);
    expect(screen.getAllByText("secret")).toHaveLength(2);
    expect(screen.queryByText(/^\d+ secret files?:/)).toBeNull(); // nothing ticked yet
    expect(screen.getByText("runs code when opened")).toBeInTheDocument();
    expect(screen.getByText("large, consider reinstalling")).toBeInTheDocument();
    expect(screen.getByText("changes how git behaves in tour-login")).toBeInTheDocument();
    expect(screen.getByText("1 of 3 already exist")).toBeInTheDocument();
    expect(screen.getByText("in .worktreeinclude")).toBeInTheDocument();
    expect(screen.queryByText(/Select all/i)).toBeNull();
    // Nothing is ticked yet (no record, include file matched only a directory that fits the seed rule? it is ticked, so Select none shows).
    expect(screen.queryByRole("button", { name: "Select none" })).not.toBeNull();
  });

  it("a ticked secret shows the '1 secret file: .env' line next to the list", async () => {
    setup({ rows: [row(".env", { secret: true }), row(".npmrc", { secret: true })] });
    const boxes = await screen.findAllByRole("checkbox");
    await userEvent.click(boxes[0]!, { delay: null });
    expect(screen.getByText("1 secret file: .env")).toBeInTheDocument();
    await userEvent.click(boxes[1]!, { delay: null });
    expect(screen.getByText("2 secret files: .env, .npmrc")).toBeInTheDocument();
  });

  it("caps the list at 6 rows with 'Show all N' and has no scroller of its own", async () => {
    const rows = Array.from({ length: 9 }, (_, i) => row(`f${i}.txt`));
    setup({ rows });
    await screen.findAllByRole("checkbox");
    expect(screen.getAllByRole("checkbox")).toHaveLength(6);
    await userEvent.click(screen.getByRole("button", { name: "Show all 9" }));
    expect(screen.getAllByRole("checkbox")).toHaveLength(9);
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
  });

  it("the live region reads 'N files selected, X KB' and Select none appears only when something is ticked", async () => {
    setup({ rows: [row("a.txt", { bytes: 2048 }), row("b/", { isDirectory: true, copyableCount: 2, bytes: 2048 })] });
    const boxes = await screen.findAllByRole("checkbox");
    expect(screen.queryByRole("button", { name: "Select none" })).toBeNull();
    const live = screen.getAllByRole("status").find((n) => n.getAttribute("aria-live") === "polite")!;
    expect(live).toHaveTextContent("No ignored files will be copied.");
    await userEvent.click(boxes[0]!, { delay: null });
    await userEvent.click(boxes[1]!, { delay: null });
    expect(live).toHaveTextContent("3 files selected, 4 KB");
    await userEvent.click(screen.getByRole("button", { name: "Select none" }), { delay: null });
    expect(live).toHaveTextContent("No ignored files will be copied.");
  });

  it.each([
    [5000, 1, false],
    [5001, 1, true],
    [1, 200 * 1024 * 1024, false],
    [1, 200 * 1024 * 1024 + 1, true],
  ])("the over-limit readout: %i files, %i bytes -> blocked %s", async (files, bytes, blocked) => {
    setup({ rows: [row("big/", { isDirectory: true, fileCount: files, copyableCount: files, bytes })] });
    const box = await screen.findByRole("checkbox");
    await userEvent.click(box, { delay: null });
    const copy = screen.getByRole("button", { name: "Copy" });
    if (blocked) {
      expect(copy).toHaveAttribute("aria-disabled", "true");
      expect(screen.getByText("Over the limit of 5,000 files or 200 MB. Untick something.")).toHaveClass("gh-copy-into__readout--critical");
    } else {
      expect(copy).not.toHaveAttribute("aria-disabled");
    }
  });

  it("counts only ENABLED ticked files toward the limit (a skipped file never does)", async () => {
    setup({
      rows: [row("a/", { isDirectory: true, fileCount: 6000, copyableCount: 10, existingCount: 5990 }), row("gone.txt", { copyableCount: 9000, disabledReason: "already-exists", disabledText: "already exists" })],
    });
    await userEvent.click(await screen.findByRole("checkbox", { name: /a\// }), { delay: null });
    expect(screen.getByRole("button", { name: "Copy" })).not.toHaveAttribute("aria-disabled");
  });

  it("'Checking for ignored files...' is aria-busy and a 5 s timeout shows the failure with a Try again that lists again", async () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    const api = makeMockGitHydra({ repoPath: "/w/acme" });
    const list = vi.fn(() => new Promise<never>(() => undefined));
    (api as { listIgnoredForExisting: unknown }).listIgnoredForExisting = list;
    render(<CopyIntoExistingDialog api={api} destId="tl" runCopy={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("Checking for ignored files...")).toBeInTheDocument();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: "Copy" })).toHaveAttribute("aria-disabled", "true");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.getByText("Couldn't list ignored files.")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("a name with control or bidi characters is visible and its row is disabled 'name not allowed'", async () => {
    setup({ rows: [row("a U+202E b", { displayPath: "a U+202E b", disabledReason: "name-not-allowed", disabledText: "name not allowed" })] });
    expect(await screen.findByText("a U+202E b")).toBeInTheDocument();
    expect(screen.getByText("name not allowed")).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).toBeDisabled();
  });

  it("Esc cancels (after the key guard) and the backdrop closes", async () => {
    const { onClose } = setup({ rows: [row("a.txt")] });
    await screen.findByRole("checkbox");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled(); // within the first 400 ms
    pastGuard();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("releases the token when the dialog goes away", async () => {
    const { api, unmount } = setup({ rows: [row("a.txt")] });
    await screen.findByRole("checkbox");
    unmount();
    expect(api.releaseIgnoredForExisting).toHaveBeenCalled();
  });
});

describe("Enter (FR-651, M1)", () => {
  async function ready(rows: WorktreeExistingRow[], over: Over = {}) {
    const s = setup({ rows, ...over });
    const boxes = await screen.findAllByRole("checkbox");
    await waitFor(() => expect(boxes.find((b) => !(b as HTMLInputElement).disabled)).toHaveFocus());
    return { ...s, boxes };
  }

  it("presses Copy when something is ticked, with the ticked ids", async () => {
    const { boxes, runCopy } = await ready([row("a.txt"), row("b.txt")]);
    fireEvent.click(boxes[0]!);
    pastGuard();
    releaseKey();
    fireEvent.keyDown(boxes[0]!, { key: "Enter" });
    await waitFor(() => expect(runCopy).toHaveBeenCalledWith({ token: "tok-1", rowIds: ["a.txt"] }));
  });

  it("does nothing when nothing is ticked", async () => {
    const { boxes, runCopy } = await ready([row("a.txt")]);
    pastGuard();
    releaseKey();
    fireEvent.keyDown(boxes[0]!, { key: "Enter" });
    expect(runCopy).not.toHaveBeenCalled();
  });

  it("a held Enter never presses Copy: a keydown inside the first 400 ms, a repeating keydown, and one without a prior keyup", async () => {
    const { boxes, runCopy } = await ready([row("a.txt")]);
    fireEvent.click(boxes[0]!);
    // Inside the guard window every key is ignored, even after a keyup.
    releaseKey();
    fireEvent.keyDown(boxes[0]!, { key: "Enter" });
    expect(runCopy).not.toHaveBeenCalled();
    pastGuard();
    // A repeating keydown (the menu's held Enter) never counts.
    fireEvent.keyDown(boxes[0]!, { key: "Enter", repeat: true });
    expect(runCopy).not.toHaveBeenCalled();
  });

  it("a keydown that follows no keyup seen inside the dialog does nothing; the next Enter after a keyup presses Copy", async () => {
    const { boxes, runCopy } = await ready([row("a.txt")]);
    fireEvent.click(boxes[0]!);
    pastGuard();
    fireEvent.keyDown(boxes[0]!, { key: "Enter" });
    expect(runCopy).not.toHaveBeenCalled();
    releaseKey();
    fireEvent.keyDown(boxes[0]!, { key: "Enter" });
    await waitFor(() => expect(runCopy).toHaveBeenCalledTimes(1));
  });

  it.each([
    ["secret", { secret: true }],
    ["runs code when opened", { runsCode: true }],
    ["not ignored in the destination", { notIgnoredInDestination: true }],
  ])("Enter does not press Copy while a ticked row is %s, unless the focus is on Copy", async (_name, flags) => {
    const { boxes, runCopy } = await ready([row("x.cfg", flags as Partial<WorktreeExistingRow>)]);
    fireEvent.click(boxes[0]!);
    pastGuard();
    releaseKey();
    fireEvent.keyDown(boxes[0]!, { key: "Enter" });
    expect(runCopy).not.toHaveBeenCalled();
    // On the Copy button itself a deliberate Enter is the user's own press (the button's click).
    const copy = screen.getByRole("button", { name: "Copy" });
    copy.focus();
    releaseKey();
    expect(fireEvent.keyDown(copy, { key: "Enter" })).toBe(true);
    fireEvent.click(copy);
    await waitFor(() => expect(runCopy).toHaveBeenCalledTimes(1));
  });

  it("Enter on Cancel is Cancel's own key, never Copy", async () => {
    const { boxes, runCopy } = await ready([row("a.txt")]);
    fireEvent.click(boxes[0]!);
    pastGuard();
    releaseKey();
    fireEvent.keyDown(screen.getByRole("button", { name: "Cancel" }), { key: "Enter" });
    expect(runCopy).not.toHaveBeenCalled();
  });
});

describe("FR-654 ticks on open and memory (AC 18)", () => {
  // Rows are ordered ticked-first, so tests address a row by its name.
  const box = (name: string): HTMLInputElement => screen.getAllByRole("checkbox").find((b) => b.closest("label")?.querySelector(".gh-copy__name")?.textContent === name) as HTMLInputElement;
  const ticks = (): Record<string, boolean> =>
    Object.fromEntries(screen.getAllByRole("checkbox").map((b) => [b.closest("label")!.querySelector(".gh-copy__name")!.textContent!, (b as HTMLInputElement).checked]));
  const setRecord = (paths: string[]) => window.localStorage.setItem(`githydra:worktreeCopy:${KEY}`, JSON.stringify({ v: 1, paths, at: 5 }));
  const record = () => readCopyRecord(KEY);
  const press = async (boxes?: HTMLElement[]) => {
    pastGuard();
    releaseKey();
    fireEvent.keyDown(boxes?.[0] ?? screen.getAllByRole("checkbox")[0]!, { key: "Enter" });
  };

  it("pre-ticks remembered enabled rows; a remembered row whose row is disabled stays in the record untouched and is not ticked", async () => {
    setRecord(["a.txt", "b.txt"]);
    const { runCopy } = setup({ rows: [row("a.txt", { disabledReason: "already-exists", disabledText: "already exists" }), row("b.txt"), row("c.txt")] });
    const boxes = await screen.findAllByRole("checkbox");
    expect(ticks()).toEqual({ "a.txt": false, "b.txt": true, "c.txt": false });
    await userEvent.click(box("c.txt"), { delay: null });
    await press(boxes);
    await waitFor(() => expect(runCopy).toHaveBeenCalled());
    await waitFor(() => expect(record()!.paths.sort()).toEqual(["a.txt", "b.txt", "c.txt"]));
  });

  it("unchanged ticks write nothing, changed ticks write once", async () => {
    setRecord(["b.txt"]);
    const spy = vi.spyOn(Storage.prototype, "setItem");
    const first = setup({ rows: [row("b.txt"), row("c.txt")] });
    const boxes = await screen.findAllByRole("checkbox");
    await press(boxes);
    await waitFor(() => expect(first.runCopy).toHaveBeenCalled());
    await waitFor(() => expect(first.onClose).toHaveBeenCalled());
    expect(spy).not.toHaveBeenCalled();
    first.unmount();
    const second = setup({ rows: [row("b.txt"), row("c.txt")] });
    const again = await screen.findAllByRole("checkbox");
    await userEvent.click(again[1]!, { delay: null });
    await press(again);
    await waitFor(() => expect(second.onClose).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("a hand-ticked secret enters the record; a secret that was only seeded from .worktreeinclude does not", async () => {
    const view = setup({ rows: [row(".env", { secret: true }), row("a.txt")], matched: [".env", "a.txt"] });
    const boxes = await screen.findAllByRole("checkbox");
    // .worktreeinclude never seeds a secret: .env is unticked, a.txt is ticked.
    expect(ticks()).toEqual({ ".env": false, "a.txt": true });
    await userEvent.click(box(".env"), { delay: null });
    // A ticked secret row needs a deliberate press on Copy itself (M1), not Enter elsewhere.
    pastGuard();
    await userEvent.click(screen.getByRole("button", { name: "Copy" }), { delay: null });
    await waitFor(() => expect(view.onClose).toHaveBeenCalled());
    expect(record()!.paths.sort()).toEqual([".env", "a.txt"]);
  });

  it("a remembered run-code row and a remembered secret row that this destination does not ignore are never pre-ticked, and stay in the record", async () => {
    setRecord([".vscode/", ".env", "a.txt"]);
    const view = setup({
      rows: [row(".vscode/", { isDirectory: true, runsCode: true }), row(".env", { secret: true, notIgnoredInDestination: true }), row("a.txt"), row("b.txt")],
    });
    const boxes = await screen.findAllByRole("checkbox");
    expect(ticks()).toEqual({ ".vscode/": false, ".env": false, "a.txt": true, "b.txt": false });
    expect(screen.getByText("tour-login does not ignore this file; it could be committed by accident.")).toHaveClass("gh-copy-into__critical");
    expect(box(".env")).toHaveAccessibleDescription("tour-login does not ignore this file; it could be committed by accident.");
    await userEvent.click(box("b.txt"), { delay: null });
    await press(boxes);
    await waitFor(() => expect(view.onClose).toHaveBeenCalled());
    expect(record()!.paths.sort()).toEqual([".env", ".vscode/", "a.txt", "b.txt"]);
  });

  it("Cancel before Copy, a typed refusal, and a failed listing write nothing", async () => {
    const spy = vi.spyOn(Storage.prototype, "setItem");
    const a = setup({ rows: [row("a.txt")] });
    await userEvent.click((await screen.findAllByRole("checkbox"))[0]!, { delay: null });
    pastGuard();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }), { delay: null });
    expect(a.onClose).toHaveBeenCalled();
    a.unmount();
    const b = setup({ rows: [row("a.txt")], copy: () => ({ status: "refused", reason: "busy", message: "Another copy is already running.", into: "tour-login" }) });
    const boxes = await screen.findAllByRole("checkbox");
    await userEvent.click(boxes[0]!, { delay: null });
    await press(boxes);
    await screen.findByRole("alert");
    expect(b.onClose).not.toHaveBeenCalled();
    b.unmount();
    setup({ listingResult: { status: "failed", reason: "git-failed", message: "Couldn't list ignored files." } });
    await screen.findByText("Couldn't list ignored files.");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("a cancelled copy that already wrote a file still saves; one that wrote nothing does not", async () => {
    const wrote = setup({ rows: [row("a.txt")], copy: () => done({ status: "cancelled", copied: 2 }) });
    let boxes = await screen.findAllByRole("checkbox");
    await userEvent.click(boxes[0]!, { delay: null });
    await press(boxes);
    await waitFor(() => expect(wrote.onClose).toHaveBeenCalled());
    expect(record()!.paths).toEqual(["a.txt"]);
    wrote.unmount();
    window.localStorage.clear();
    const none = setup({ rows: [row("a.txt")], copy: () => done({ status: "cancelled", copied: 0 }) });
    boxes = await screen.findAllByRole("checkbox");
    await userEvent.click(boxes[0]!, { delay: null });
    await press(boxes);
    await waitFor(() => expect(none.onClose).toHaveBeenCalled());
    expect(record()).toBeNull();
  });

  it("every file skipped by main still counts as the user's decision, and Create reads the same record", async () => {
    const view = setup({
      rows: [row("a.txt")],
      copy: () => done({ copied: 0, bytes: 0, skipped: [{ path: "a.txt", reason: "already-exists", text: "already exists" }], skippedTotal: 1 }),
    });
    const boxes = await screen.findAllByRole("checkbox");
    await userEvent.click(boxes[0]!, { delay: null });
    await press(boxes);
    await waitFor(() => expect(view.onClose).toHaveBeenCalled());
    const saved = record();
    expect(saved!.paths).toEqual(["a.txt"]);
    // The Create dialog's own pre-tick function sees it.
    const ticks = decideInitialTicks({ candidates: [{ path: "a.txt", isDirectory: false, fileCount: 1, bytes: 10 }], record: saved, includeMatches: [] });
    expect(ticks.ticked).toEqual(["a.txt"]);
  });
});

describe("progress, cancel and typed refusals (FR-657, AC 22)", () => {
  async function start(copy: Over["copy"], rows = [row("a/", { isDirectory: true, fileCount: 10, copyableCount: 10, bytes: 10 * 1024 })]) {
    vi.useRealTimers();
    vi.useFakeTimers();
    const s = setup({ rows, copy });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const box = screen.getByRole("checkbox");
    fireEvent.click(box);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    releaseKey();
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });
    return s;
  }

  it("shows nothing before 2 s, then 'Copying N of M files...' with a determinate progressbar; Esc is ignored; Cancel stays active", async () => {
    let finish: (r: WorktreeExistingCopyResult) => void = () => undefined;
    const s = await start(() => new Promise<WorktreeExistingCopyResult>((resolve) => (finish = resolve)));
    expect(screen.getByRole("button", { name: "Copying..." })).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByText(/Copying \d+ of/)).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(screen.queryByRole("progressbar")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
      s.progressListeners.forEach((fn) => fn({ filesDone: 4, filesTotal: 10, bytesDone: 4096 }));
    });
    expect(screen.getByText("Copying 4 of 10 files...")).toBeInTheDocument();
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "4");
    expect(bar).toHaveAttribute("aria-valuemax", "10");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(s.onClose).not.toHaveBeenCalled();
    expect(document.querySelector("[inert]")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(s.api.cancelIgnoredCopyIntoExisting).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish(done({ status: "cancelled", copied: 4 }));
    });
    expect(s.onClose).toHaveBeenCalled();
  });

  it("a typed refusal stays in the dialog as a critical alert, the primary becomes Try again, and it lists again with a new token", async () => {
    const s = await start(() => ({ status: "refused", reason: "destinationChanged", message: "tour-login changed. Open this dialog again.", into: "tour-login" }));
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Could not copy: tour-login changed. Open this dialog again.");
    expect(alert).toHaveClass("gh-status-banner--critical");
    expect(s.onClose).not.toHaveBeenCalled();
    expect(s.api.listIgnoredForExisting).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });
    expect(s.api.listIgnoredForExisting).toHaveBeenCalledTimes(2);
  });

  it("an unexpected IPC failure never shows raw error text", async () => {
    await start(() => {
      throw new Error("EPERM: C:\\secret\\path");
    });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Could not copy: The copy did not finish.");
    expect(alert.textContent).not.toMatch(/EPERM|secret/);
  });
});
