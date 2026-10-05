// SPDX-License-Identifier: GPL-3.0-or-later
// specs/ignore-and-multiselect.md FR-494, FR-495, FR-497, FR-500, FR-501, FR-503, FR-502, D1, D2, D3, D9 through the real ChangesPanel.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { IgnoreReport, IgnoreRowReport } from "@githydra/git-core";
import { file, list, mountPanel } from "../../test/changesPanelHarness";

const rowBtn = (path: string): HTMLElement => document.querySelector<HTMLElement>(`[data-row-key$=":${path}"]`) as HTMLElement;
const rowOf = (path: string): HTMLElement => rowBtn(path).closest<HTMLElement>(".gh-changes-panel__file")!;

const changes = () =>
  list({
    unstaged: [file("src/a.ts", "unstaged")],
    untracked: [file("build/out.log", "untracked", "added"), file("build/x.log", "untracked", "added"), file(".env", "untracked", "added")],
  });

const reportOf = (rows: Partial<IgnoreRowReport>[], extra: Partial<IgnoreReport> = {}): IgnoreReport => ({
  rows: rows.map((r) => ({ path: "p", tracked: false, outcome: "will-write", file: ".gitignore", rule: "/p", ...r }) as IgnoreRowReport),
  files: [{ file: ".gitignore", created: false, rules: ["/p"], alreadyPresent: [], sharedWithOtherWorktrees: false }],
  stopTracking: null,
  applied: false,
  ...extra,
});

async function openIgnoreMenuFor(path: string) {
  fireEvent.contextMenu(rowOf(path), { clientX: 10, clientY: 10 });
  const menu = await screen.findByRole("menu", { name: `Actions for ${path}` });
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Ignore…" }));
  return screen.findByRole("menu", { name: "Ignore options" });
}

async function ready() {
  await waitFor(() => expect(screen.getByText("Untracked (3)")).toBeInTheDocument());
}

beforeEach(() => window.localStorage.clear());

describe("per-file Ignore entry points (FR-503, D1)", () => {
  it("right-click Ignore… opens the scope submenu naming the file, extension and folder", async () => {
    mountPanel(changes());
    await ready();
    const sub = await openIgnoreMenuFor("build/out.log");
    const items = within(sub).getAllByRole("menuitem").map((i) => i.textContent);
    expect(items).toEqual(["This file", "All *.log files", "All files in build/"]);
  });

  it("disables inapplicable scopes with their reason (dotfile, repository root)", async () => {
    mountPanel(changes());
    await ready();
    const sub = await openIgnoreMenuFor(".env");
    const ext = within(sub).getByRole("menuitem", { name: /extension/i });
    expect(ext).toBeDisabled();
    expect(ext).toHaveAttribute("title", "This file has no extension.");
    expect(within(sub).getByRole("menuitem", { name: /files in this folder/i })).toBeDisabled();
  });

  it("every row has a keyboard-reachable Ignore button that opens the same menu", async () => {
    mountPanel(changes());
    await ready();
    const button = within(rowOf("build/out.log")).getByRole("button", { name: "Ignore build/out.log…" });
    button.focus();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("menu", { name: "Ignore options" })).toBeInTheDocument();
  });

  it("the Menu key (a contextmenu event from the focused row) opens the row menu", async () => {
    mountPanel(changes());
    await ready();
    rowBtn("build/out.log").focus();
    fireEvent.contextMenu(rowBtn("build/out.log"), { clientX: 0, clientY: 0 });
    expect(await screen.findByRole("menu", { name: "Actions for build/out.log" })).toBeInTheDocument();
  });

  it("a conflicted row has no Ignore action button (FR-501)", async () => {
    mountPanel(list({ conflicted: [file("c.ts", "conflicted", "unmerged")] }));
    await waitFor(() => expect(screen.getByText("Conflicted (1)")).toBeInTheDocument());
    expect(within(rowOf("c.ts")).queryByRole("button", { name: /ignore/i })).not.toBeInTheDocument();
  });
});

describe("Add to dialog (D2) and result notice (D9)", () => {
  it("previews the rule with Root preselected, writes it on Add, and says what was added", async () => {
    const onWorkingDirChanged = vi.fn();
    const { api } = mountPanel(changes(), { onWorkingDirChanged });
    await ready();
    const sub = await openIgnoreMenuFor("build/out.log");
    await userEvent.click(within(sub).getByRole("menuitem", { name: "All *.log files" }));

    const dialog = await screen.findByRole("alertdialog", { name: "Ignore: add to" });
    expect(within(dialog).getByRole("radio", { name: /Root \.gitignore/ })).toBeChecked();
    await waitFor(() =>
      expect(api.planIgnore).toHaveBeenCalledWith({ paths: ["build/out.log"], scope: "extension", target: "root", stopTracking: false }),
    );
    expect(await within(dialog).findByText("Will add *.log to .gitignore.")).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("button", { name: "Add to .gitignore" }));
    await waitFor(() =>
      expect(api.ignorePaths).toHaveBeenCalledWith({ paths: ["build/out.log"], scope: "extension", target: "root" }),
    );
    const notice = await screen.findByText("Added *.log to .gitignore.");
    expect(notice.closest("p")).toHaveAttribute("role", "status");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(onWorkingDirChanged).toHaveBeenCalled();
    // The ignored untracked file left the list.
    await waitFor(() => expect(document.querySelector('[data-row-key$=":build/out.log"]')).toBeNull());
  });

  it("offers Root, Nearest and Private, and Private writes to .git/info/exclude", async () => {
    const { api } = mountPanel(changes());
    await ready();
    const sub = await openIgnoreMenuFor(".env");
    await userEvent.click(within(sub).getByRole("menuitem", { name: "This file" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getAllByRole("radio").map((r) => r.closest("label")!.textContent)).toEqual([
      expect.stringContaining("Root .gitignore"),
      expect.stringContaining("Nearest .gitignore"),
      expect.stringContaining("Private (.git/info/exclude)"),
    ]);
    await userEvent.click(within(dialog).getByRole("radio", { name: /Private/ }));
    await waitFor(() => expect(api.planIgnore).toHaveBeenLastCalledWith(expect.objectContaining({ target: "exclude" })));
    await userEvent.click(await within(dialog).findByRole("button", { name: /Add to \.git\/info\/exclude/ }));
    await waitFor(() => expect(api.ignorePaths).toHaveBeenCalledWith(expect.objectContaining({ target: "exclude", scope: "name" })));
  });

  it("remembers the last choice per repository, locally", async () => {
    const first = mountPanel(changes(), { repoKey: "/repos/one" });
    await ready();
    let sub = await openIgnoreMenuFor(".env");
    await userEvent.click(within(sub).getByRole("menuitem", { name: "This file" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("radio", { name: /Nearest/ }));
    expect(window.localStorage.getItem("githydra:ignoreTarget:/repos/one")).toBe("nearest");
    await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    first.unmount();

    // Same repo: remembered. Another repo: back to Root.
    mountPanel(changes(), { repoKey: "/repos/one" });
    await ready();
    sub = await openIgnoreMenuFor(".env");
    await userEvent.click(within(sub).getByRole("menuitem", { name: "This file" }));
    expect(within(await screen.findByRole("alertdialog")).getByRole("radio", { name: /Nearest/ })).toBeChecked();
  });

  it("falls back to Root when localStorage throws", async () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    try {
      mountPanel(changes(), { repoKey: "/repos/blocked" });
      await ready();
      const sub = await openIgnoreMenuFor(".env");
      await userEvent.click(within(sub).getByRole("menuitem", { name: "This file" }));
      expect(within(await screen.findByRole("alertdialog")).getByRole("radio", { name: /Root/ })).toBeChecked();
    } finally {
      spy.mockRestore();
    }
  });

  it("says the exclude file is shared when the repository is a linked worktree (FR-495)", async () => {
    const { api } = mountPanel(changes());
    await ready();
    vi.mocked(api.planIgnore).mockImplementation(async (req) =>
      ({
        ok: true,
        data: reportOf([{ path: req.paths[0], rule: "/x", file: ".git/info/exclude" }], {
          files: [{ file: ".git/info/exclude", created: false, rules: ["/x"], alreadyPresent: [], sharedWithOtherWorktrees: true }],
        }),
      }) as never,
    );
    const sub = await openIgnoreMenuFor(".env");
    await userEvent.click(within(sub).getByRole("menuitem", { name: "This file" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("radio", { name: /Private/ }));
    expect(await within(dialog).findByText(/linked worktree: \.git\/info\/exclude is shared with the main checkout/)).toBeInTheDocument();
  });

  it("does not offer Add when the rule is already in the file, and says so (FR-497)", async () => {
    const { api } = mountPanel(changes());
    await ready();
    vi.mocked(api.planIgnore).mockResolvedValue({
      ok: true,
      data: reportOf([{ path: ".env", outcome: "already-in", rule: "/.env" }], { files: [{ file: ".gitignore", created: false, rules: [], alreadyPresent: ["/.env"], sharedWithOtherWorktrees: false }] }),
    } as never);
    const sub = await openIgnoreMenuFor(".env");
    await userEvent.click(within(sub).getByRole("menuitem", { name: "This file" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(await within(dialog).findByText("/.env is already in .gitignore.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /^Add to/ })).toBeDisabled();
  });

  it("names the file and line of a rule that already ignores it, and writes nothing", async () => {
    const { api } = mountPanel(changes());
    await ready();
    vi.mocked(api.planIgnore).mockResolvedValue({
      ok: true,
      data: reportOf([{ path: "build/out.log", outcome: "already-ignored", ignoredBy: { source: ".gitignore", line: 4, pattern: "*.log" } }]),
    } as never);
    const sub = await openIgnoreMenuFor("build/out.log");
    await userEvent.click(within(sub).getByRole("menuitem", { name: "This file" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(await within(dialog).findByText(/already ignored by \.gitignore:4; nothing was written/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /^Add to/ })).toBeDisabled();
    expect(api.ignorePaths).not.toHaveBeenCalled();
  });

  it("is honest when a later rule leaves the file not ignored (still-not-ignored)", async () => {
    const { api } = mountPanel(changes());
    await ready();
    vi.mocked(api.ignorePaths).mockResolvedValue({
      ok: true,
      data: reportOf(
        [{ path: "build/out.log", outcome: "still-not-ignored", rule: "*.log", ignoredBy: { source: ".gitignore", line: 9, pattern: "!out.log" } }],
        { applied: true },
      ),
    } as never);
    const sub = await openIgnoreMenuFor("build/out.log");
    await userEvent.click(within(sub).getByRole("menuitem", { name: "This file" }));
    await userEvent.click(await screen.findByRole("button", { name: "Add to .gitignore" }));
    const notice = await screen.findByText(/still not ignored\. A later rule re-includes it: !out\.log \(\.gitignore:9\)/);
    expect(notice.closest("p")).toHaveClass("gh-changes-panel__notice--warn");
  });

  it("keeps the dialog open and shows the typed error when the write fails (IgnoreFileChangedError)", async () => {
    const { api } = mountPanel(changes());
    await ready();
    vi.mocked(api.ignorePaths).mockResolvedValue({
      ok: false,
      error: { name: "IgnoreFileChangedError", code: "IGNORE_FILE_CHANGED", message: '".gitignore" changed while it was being updated, twice. Nothing was written; try again.', details: { file: ".gitignore" } },
    } as never);
    const sub = await openIgnoreMenuFor(".env");
    await userEvent.click(within(sub).getByRole("menuitem", { name: "This file" }));
    await userEvent.click(await screen.findByRole("button", { name: "Add to .gitignore" }));
    expect(await screen.findByText(/changed while it was being updated, twice/)).toBeInTheDocument();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("Cancel and Escape close the dialog without writing", async () => {
    const { api } = mountPanel(changes());
    await ready();
    let sub = await openIgnoreMenuFor(".env");
    await userEvent.click(within(sub).getByRole("menuitem", { name: "This file" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    sub = await openIgnoreMenuFor(".env");
    await userEvent.click(within(sub).getByRole("menuitem", { name: "This file" }));
    await screen.findByRole("alertdialog");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(api.ignorePaths).not.toHaveBeenCalled();
  });

  it("an open dialog counts as a modal for the idle gate and global keybindings (FR-465)", async () => {
    const onDialogOpenChange = vi.fn();
    mountPanel(changes(), { onDialogOpenChange });
    await ready();
    const sub = await openIgnoreMenuFor(".env");
    await userEvent.click(within(sub).getByRole("menuitem", { name: "This file" }));
    await screen.findByRole("alertdialog");
    expect(onDialogOpenChange).toHaveBeenLastCalledWith(true);
    await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(onDialogOpenChange).toHaveBeenLastCalledWith(false));
  });
});

describe("tracked files (D3, FR-500)", () => {
  const trackedReport = (stop: Partial<NonNullable<IgnoreReport["stopTracking"]>> = {}, rows: Partial<IgnoreRowReport>[] = [{}]): IgnoreReport =>
    reportOf(
      rows.map((r) => ({ path: "src/a.ts", tracked: true, rule: "/src/a.ts", ...r })),
      {
        stopTracking: {
          paths: ["src/a.ts"],
          count: 1,
          otherMatchesStillTracked: 0,
          mixedRows: [],
          renamedRows: [],
          skippedSubmodules: [],
          skippedConflicted: [],
          ...stop,
        },
      },
    );

  async function toTrackedStep(report: IgnoreReport) {
    const view = mountPanel(changes());
    await ready();
    vi.mocked(view.api.planIgnore).mockResolvedValue({ ok: true, data: report } as never);
    const sub = await openIgnoreMenuFor("src/a.ts");
    await userEvent.click(within(sub).getByRole("menuitem", { name: "This file" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Ignore: add to" });
    const next = await within(dialog).findByRole("button", { name: "Next…" });
    await waitFor(() => expect(next).toBeEnabled());
    await userEvent.click(next);
    return { ...view, dialog: await screen.findByRole("alertdialog", { name: "These files are tracked by git" }) };
  }

  it("shows Ignore only / Ignore and Stop Tracking / Cancel with Cancel focused, the counts, and the on-disk and staged-deletion notes", async () => {
    const { dialog } = await toTrackedStep(trackedReport({ otherMatchesStillTracked: 3 }));
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(within(dialog).getByRole("button", { name: "Ignore only" })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "Ignore and Stop Tracking" })).toBeEnabled();
    expect(within(dialog).getByText(/removes 1 file from git's index\. The files stay on disk, and the removals appear as staged changes/)).toBeInTheDocument();
    expect(within(dialog).getByText(/3 other tracked files matching this rule stay tracked/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Ignore only writes the rule; git keeps tracking these files/)).toBeInTheDocument();
  });

  it("Ignore only writes the rule and keeps tracking", async () => {
    const { api, dialog } = await toTrackedStep(trackedReport());
    await userEvent.click(within(dialog).getByRole("button", { name: "Ignore only" }));
    await waitFor(() => expect(api.ignorePaths).toHaveBeenCalledWith({ paths: ["src/a.ts"], scope: "name", target: "root" }));
    expect(api.ignoreAndStopTracking).not.toHaveBeenCalled();
  });

  it("Ignore and Stop Tracking runs the untrack path and reports it", async () => {
    const { api, dialog } = await toTrackedStep(trackedReport());
    vi.mocked(api.ignoreAndStopTracking).mockResolvedValue({
      ok: true,
      data: { ...trackedReport(), applied: true, rows: [{ path: "src/a.ts", tracked: true, outcome: "written", rule: "/src/a.ts", file: ".gitignore" }] },
    } as never);
    await userEvent.click(within(dialog).getByRole("button", { name: "Ignore and Stop Tracking" }));
    await waitFor(() => expect(api.ignoreAndStopTracking).toHaveBeenCalledWith({ paths: ["src/a.ts"], scope: "name", target: "root" }));
    expect(await screen.findByText(/Added \/src\/a\.ts to \.gitignore\. Stopped tracking 1 file; they stay on disk and show as staged deletions\./)).toBeInTheDocument();
  });

  it("warns that a partly staged file's staged edits are dropped, and about a staged rename's old path", async () => {
    const { dialog } = await toTrackedStep(
      trackedReport({ mixedRows: ["src/a.ts"], renamedRows: [{ path: "src/new.ts", oldPath: "src/old.ts" }] }),
    );
    expect(within(dialog).getByText(/1 partly staged file: the staged edits are dropped from the index/)).toBeInTheDocument();
    expect(within(dialog).getByText(/1 staged rename: only the new path is untracked; the old path stays staged as deleted/)).toBeInTheDocument();
  });

  it("when the rule already exists only Ignore and Stop Tracking is offered (FR-497)", async () => {
    const { dialog } = await toTrackedStep(
      trackedReport({}, [{ outcome: "already-ignored", ignoredBy: { source: ".gitignore", line: 2, pattern: "src/" } }]),
    );
    expect(within(dialog).queryByRole("button", { name: "Ignore only" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Ignore and Stop Tracking" })).toBeEnabled();
  });

  it("Cancel from the tracked step writes nothing", async () => {
    const { api, dialog } = await toTrackedStep(trackedReport());
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(api.ignorePaths).not.toHaveBeenCalled();
    expect(api.ignoreAndStopTracking).not.toHaveBeenCalled();
  });

  it("shows an IgnoreUntrackError's message, including that the rule file was left modified", async () => {
    const { api, dialog } = await toTrackedStep(trackedReport());
    vi.mocked(api.ignoreAndStopTracking).mockResolvedValue({
      ok: false,
      error: {
        name: "IgnoreUntrackError",
        code: "IGNORE_UNTRACK_FAILED",
        message: "Could not stop tracking the files (boom). The ignore rule was left in .gitignore; the files are still tracked.",
        details: { rolledBack: false, ruleFilesLeftModified: [".gitignore"], gitMessage: "boom" },
      },
    } as never);
    await userEvent.click(within(dialog).getByRole("button", { name: "Ignore and Stop Tracking" }));
    expect(await screen.findByText(/The ignore rule was left in \.gitignore; the files are still tracked\./)).toBeInTheDocument();
  });
});

describe("bulk Ignore (FR-510)", () => {
  it("the bulk bar's Ignore opens a scope menu worded for the selection and writes all rows in one request", async () => {
    const { api } = mountPanel(changes());
    await ready();
    fireEvent.click(rowBtn("build/out.log"));
    fireEvent.click(rowBtn("build/x.log"), { ctrlKey: true });
    await userEvent.click(within(screen.getByRole("toolbar")).getByRole("button", { name: /^Ignore 2/ }));
    const sub = await screen.findByRole("menu", { name: "Ignore options" });
    expect(within(sub).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["These 2 files", "All *.log files", "All files in build/"]);
    await userEvent.click(within(sub).getByRole("menuitem", { name: "All files in build/" }));
    await userEvent.click(await screen.findByRole("button", { name: "Add to .gitignore" }));
    await waitFor(() =>
      expect(api.ignorePaths).toHaveBeenCalledWith({ paths: ["build/out.log", "build/x.log"], scope: "directory", target: "root" }),
    );
  });

  it("never sends a conflicted row to Ignore", async () => {
    const { api } = mountPanel(list({ untracked: [file("a.log", "untracked", "added")], conflicted: [file("c.ts", "conflicted", "unmerged")] }));
    await waitFor(() => expect(screen.getByText("Untracked (1)")).toBeInTheDocument());
    fireEvent.click(rowBtn("a.log"));
    fireEvent.click(rowBtn("c.ts"), { ctrlKey: true });
    await userEvent.click(within(screen.getByRole("toolbar")).getByRole("button", { name: /^Ignore 1/ }));
    await userEvent.click(within(await screen.findByRole("menu", { name: "Ignore options" })).getByRole("menuitem", { name: "This file" }));
    await waitFor(() => expect(api.planIgnore).toHaveBeenCalledWith(expect.objectContaining({ paths: ["a.log"] })));
  });
});
