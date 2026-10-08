// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { makeMockGitHydra } from "./test/mockGitHydra";
import { makeCommit } from "./test/fixtures";
import { polyfillCodeMirrorDom, typeAtEnd } from "./test/codemirrorDom";
import { persistRightPanel } from "./hooks/useLayoutPreferences";
import { SESSION_TABS_KEY } from "./hooks/useRepoTabs";

// specs/edit-in-diff.md FR-535 (ship gate M1): every App-level path that would unmount a dirty editor asks first.

beforeAll(polyfillCodeMirrorDom);
afterEach(() => {
  // @ts-expect-error test cleanup of the global bridge
  delete window.gitHydra;
  window.localStorage.clear();
});

const H = (c: string) => c.repeat(64);
const readOk = (content: string) => ({
  ok: true as const,
  data: {
    eligible: true as const, hasStagedContent: false, isNew: false, isUntracked: false, size: 1, mtimeMs: 1, mode: 0o644,
    content, eol: "lf" as const, hasBom: false, finalNewline: true, contentHash: H("a"),
  },
});

function makeApi() {
  const api = makeMockGitHydra({
    repoPath: "/repoA",
    commits: [makeCommit("a1", [], { subject: "Repo A commit" })],
    reposByPath: { "/repoB": { commits: [makeCommit("b1", [], { subject: "Repo B commit" })] } },
    workingDirectoryChanges: {
      staged: [],
      unstaged: [{ path: "a.txt", status: "modified", category: "unstaged" }],
      untracked: [],
      conflicted: [],
    },
    workingDirStatus: { hasChanges: true, staged: 0, unstaged: 1, untracked: 0, conflicted: 0 },
  });
  vi.mocked(api.readEditableFile).mockImplementation((p: string) => Promise.resolve(readOk(`${p} body\n`)));
  window.gitHydra = api;
  return api;
}

/** Opens repo A, its Changes panel, edits a.txt and types, leaving a dirty buffer. */
async function dirtyEditor(api: ReturnType<typeof makeApi>, { twoTabs = false }: { twoTabs?: boolean } = {}) {
  persistRightPanel("changes");
  if (twoTabs) {
    const remembered = { selectedSha: null, filter: {}, showAllRefs: false, rightPanel: "changes", selectedFile: null };
    window.localStorage.setItem(
      SESSION_TABS_KEY,
      JSON.stringify({ tabs: [{ repoPath: "/repoA", remembered }, { repoPath: "/repoB", remembered }], activeRepoPath: "/repoA" }),
    );
  }
  render(<App />);
  if (!twoTabs) await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
  await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
  const row = await waitFor(() => {
    const el = document.querySelector<HTMLElement>('[data-row-key="unstaged:a.txt"]');
    if (!el) throw new Error("no row yet");
    return el;
  });
  await userEvent.click(row);
  await waitFor(() => expect(screen.getByRole("button", { name: "Edit" })).not.toHaveAttribute("aria-disabled"));
  await userEvent.click(screen.getByRole("button", { name: "Edit" }));
  await screen.findByRole("textbox", { name: "Editing a.txt" });
  act(() => typeAtEnd(document.body, "x"));
  await waitFor(() => expect(screen.getByText("Unsaved")).toBeInTheDocument());
  expect(api.readEditableFile).toHaveBeenCalledWith("a.txt");
}

async function runPaletteCommand(name: string) {
  await userEvent.keyboard("{Control>}k{/Control}");
  const dialog = await screen.findByRole("dialog");
  await userEvent.type(within(dialog).getByRole("combobox"), name);
  await userEvent.keyboard("{Enter}");
}

const prompt = () => screen.findByRole("alertdialog");
const stillEditing = () => expect(screen.getByRole("textbox", { name: "Editing a.txt" })).toBeInTheDocument();
async function cancelPrompt() {
  fireEvent.click(within(await prompt()).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  stillEditing();
  expect(document.querySelector(".cm-content")!.textContent).toContain("bodyx");
}

describe("Command Palette edit commands (FR-533)", () => {
  it("Edit file opens the editor on the open file; Save and Save and stage act on it", async () => {
    const api = makeApi();
    persistRightPanel("changes");
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
    const row = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-row-key="unstaged:a.txt"]');
      if (!el) throw new Error("no row yet");
      return el;
    });
    await userEvent.click(row);
    await waitFor(() => expect(api.probeEditableFile).toHaveBeenCalledWith("a.txt"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit" })).not.toHaveAttribute("aria-disabled"));

    await userEvent.keyboard("{Control>}k{/Control}");
    let dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByRole("combobox"), "Save and stage");
    expect(within(dialog).getByRole("option", { name: /Save and stage/ })).toHaveAttribute("aria-disabled", "true");
    expect(dialog).toHaveTextContent("Open a file for editing first.");
    await userEvent.keyboard("{Escape}");

    await runPaletteCommand("Edit file");
    await screen.findByRole("textbox", { name: "Editing a.txt" });
    act(() => typeAtEnd(document.body, "x"));
    await waitFor(() => expect(screen.getByText("Unsaved")).toBeInTheDocument());

    await runPaletteCommand("Save and stage");
    await waitFor(() => expect(api.writeEditedFile).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.stageFile).toHaveBeenCalledWith("a.txt"));
  });
});

describe("dirty-leave guard at App level (FR-535, M1)", () => {
  it("the dialog offers Save / Discard / Cancel with Save focused", async () => {
    await dirtyEditor(makeApi());
    fireEvent.click(screen.getByRole("button", { name: "Close repoA tab" }));
    const dlg = await prompt();
    expect(within(dlg).getByRole("button", { name: "Save" })).toHaveFocus();
    expect(within(dlg).getByRole("button", { name: "Discard" })).not.toHaveFocus();
    expect(within(dlg).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("closing the active repo tab: Cancel keeps the tab and the buffer, Discard closes it", async () => {
    await dirtyEditor(makeApi());
    fireEvent.click(screen.getByRole("button", { name: "Close repoA tab" }));
    await cancelPrompt();
    expect(screen.getAllByRole("tab")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Close repoA tab" }));
    fireEvent.click(within(await prompt()).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryAllByRole("tab")).toHaveLength(0));
  });

  it("closing the active tab by command (keyboard close) asks too", async () => {
    await dirtyEditor(makeApi());
    await runPaletteCommand("Close current tab");
    await cancelPrompt();
    expect(screen.getAllByRole("tab")).toHaveLength(1);
  });

  it("opening another repository by command asks once the path is picked; Cancel keeps repo, tab and buffer", async () => {
    const api = makeApi();
    await dirtyEditor(api);
    vi.mocked(api.openRepoDialog).mockResolvedValueOnce({ ok: true, data: "/repoB" });
    await runPaletteCommand("New tab / Open repository");
    await cancelPrompt();
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(screen.queryByText("Repo B commit")).toBeNull();
  });

  it("a finished clone opens its tab only after the prompt: Cancel keeps repo, tab and buffer, Discard opens the clone", async () => {
    const api = makeApi();
    await dirtyEditor(api);
    await runPaletteCommand("Clone a repository");
    const dlg = await screen.findByRole("dialog", { name: /clone a repository/i });
    await userEvent.type(within(dlg).getByLabelText(/url/i), "https://example.com/b.git");
    await userEvent.type(within(dlg).getByLabelText(/destination|folder|location/i), "/repoB");
    await userEvent.click(within(dlg).getByRole("button", { name: /^clone$/i }));
    await waitFor(() => expect(api.clone).toHaveBeenCalled());
    await cancelPrompt();
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(screen.queryByText("Repo B commit")).toBeNull();
  });

  it("'+ New tab' asks and Cancel keeps the repo, tab and buffer", async () => {
    await dirtyEditor(makeApi());
    fireEvent.click(screen.getByRole("button", { name: /open a repository in a new tab/i }));
    await cancelPrompt();
    expect(screen.getByText("Repo A commit")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open a repository" })).toBeNull();
  });

  it("switching to another tab asks; Cancel stays, Discard switches", async () => {
    await dirtyEditor(makeApi(), { twoTabs: true });
    const [, tabB] = screen.getAllByRole("tab");
    await userEvent.click(tabB!);
    await cancelPrompt();
    expect(screen.getByRole("tab", { name: /repoA/ })).toHaveAttribute("aria-selected", "true");

    await userEvent.click(screen.getAllByRole("tab")[1]!);
    fireEvent.click(within(await prompt()).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.getByText("Repo B commit")).toBeInTheDocument());
  });

  it("closing a BACKGROUND tab does not ask: the editor lives in the active tab and survives", async () => {
    await dirtyEditor(makeApi(), { twoTabs: true });
    fireEvent.click(screen.getByRole("button", { name: "Close repoB tab" }));
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(1));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    stillEditing();
  });

  it("selecting a commit in the graph asks before the Changes drawer is replaced", async () => {
    await dirtyEditor(makeApi());
    await userEvent.click(screen.getByText("Repo A commit"));
    await cancelPrompt();
    expect(screen.queryByRole("complementary", { name: "Commit details" })).toBeNull();

    await userEvent.click(screen.getByText("Repo A commit"));
    fireEvent.click(within(await prompt()).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.getByRole("complementary", { name: "Commit details" })).toBeInTheDocument());
  });

  it("closing the Changes drawer (x and the toolbar toggle) asks", async () => {
    await dirtyEditor(makeApi());
    fireEvent.click(screen.getByRole("button", { name: "Close changes panel" }));
    await cancelPrompt();
    await userEvent.click(screen.getByRole("button", { name: /^Changes/ }));
    await cancelPrompt();
    expect(screen.getByRole("complementary", { name: "Changes" })).toBeInTheDocument();
  });

  it("opening the Stashes panel asks", async () => {
    await dirtyEditor(makeApi());
    await userEvent.click(screen.getByRole("button", { name: /^Stash/ }));
    await cancelPrompt();
    expect(screen.queryByRole("complementary", { name: /Stash/ })).toBeNull();
  });

  it("opening Blame from the file row asks, since Blame replaces the drawer", async () => {
    await dirtyEditor(makeApi());
    fireEvent.contextMenu(document.querySelector('[data-row-key="unstaged:a.txt"]')!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Blame" }));
    await cancelPrompt();
  });

  it("Save in the dialog writes the file and then lets the action through", async () => {
    const api = makeApi();
    await dirtyEditor(api);
    fireEvent.click(screen.getByRole("button", { name: "Close repoA tab" }));
    fireEvent.click(within(await prompt()).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.writeEditedFile).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryAllByRole("tab")).toHaveLength(0));
  });

  it("a failed Save in the dialog aborts the leave and keeps the buffer", async () => {
    const api = makeApi();
    vi.mocked(api.writeEditedFile).mockResolvedValue({ ok: false, code: "io", message: "disk full" });
    await dirtyEditor(api);
    fireEvent.click(screen.getByRole("button", { name: "Close repoA tab" }));
    fireEvent.click(within(await prompt()).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.writeEditedFile).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    stillEditing();
  });

  it("a clean editor never prompts", async () => {
    const api = makeApi();
    await dirtyEditor(api);
    fireEvent.keyDown(document.querySelector(".cm-content")!, { key: "s", code: "KeyS", ctrlKey: true });
    await waitFor(() => expect(api.writeEditedFile).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText("Unsaved")).toBeNull());
    await userEvent.click(screen.getByText("Repo A commit"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(screen.getByRole("complementary", { name: "Commit details" })).toBeInTheDocument());
  });

  describe("app close (main asks through the typed event)", () => {
    const requestClose = (api: ReturnType<typeof makeApi>) => {
      const listener = vi.mocked(api.onCloseRequested!).mock.calls.at(-1)![0];
      act(() => listener());
    };

    it("reports the dirty state to main as it changes", async () => {
      const api = makeApi();
      await dirtyEditor(api);
      expect(vi.mocked(api.setEditDirty!).mock.calls.map((c) => c[0])).toContain(true);
      fireEvent.keyDown(document.querySelector(".cm-content")!, { key: "s", code: "KeyS", ctrlKey: true });
      await waitFor(() => expect(api.setEditDirty).toHaveBeenLastCalledWith(false));
    });

    it("clean: allows immediately", async () => {
      const api = makeApi();
      render(<App />);
      requestClose(api);
      await waitFor(() => expect(api.confirmClose).toHaveBeenCalledWith("allow"));
    });

    it("dirty: acknowledges, shows the prompt, and answers cancel / allow from the user's choice", async () => {
      const api = makeApi();
      await dirtyEditor(api);
      requestClose(api);
      await waitFor(() => expect(api.confirmClose).toHaveBeenCalledWith("prompting"));
      expect(api.confirmClose).not.toHaveBeenCalledWith("allow");
      await cancelPrompt();
      await waitFor(() => expect(api.confirmClose).toHaveBeenCalledWith("cancel"));

      requestClose(api);
      fireEvent.click(within(await prompt()).getByRole("button", { name: "Discard" }));
      await waitFor(() => expect(api.confirmClose).toHaveBeenCalledWith("allow"));
    });

    it("a repeated request while the prompt is open does not stack a second dialog", async () => {
      const api = makeApi();
      await dirtyEditor(api);
      requestClose(api);
      await prompt();
      requestClose(api);
      expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
    });
  });
});
