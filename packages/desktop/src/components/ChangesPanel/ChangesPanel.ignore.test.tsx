// SPDX-License-Identifier: GPL-3.0-or-later
// specs/ignore-and-multiselect.md FR-494, FR-495, FR-497, FR-500, FR-501, FR-503, FR-502, FR-513, D1, D2, D3, D9: the single anchored
// Ignore popover (user-approved mockup, option 1) through the real ChangesPanel.
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

/** Right-click, then the menu's Ignore… item: one popover, never a second menu. */
async function openPopoverFor(path: string) {
  fireEvent.contextMenu(rowOf(path), { clientX: 10, clientY: 10 });
  const menu = await screen.findByRole("menu", { name: `Actions for ${path}` });
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Ignore…" }));
  return screen.findByRole("dialog", { name: new RegExp(`^Ignore ${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) });
}

/** The previews are read in parallel on open; wait until the primary action is usable. */
async function readyPopover(path: string) {
  const pop = await openPopoverFor(path);
  await waitFor(() => expect(pop).not.toHaveAttribute("aria-busy"));
  return pop;
}

async function ready() {
  await waitFor(() => expect(screen.getByText("Untracked (3)")).toBeInTheDocument());
}

beforeEach(() => window.localStorage.clear());

describe("entry points (FR-503)", () => {
  it("right-click Ignore… opens one anchored popover naming the file, with the exact rule and '+N files' per scope", async () => {
    mountPanel(changes());
    await ready();
    const pop = await readyPopover("build/out.log");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(pop).toHaveAttribute("aria-modal", "false");
    const radios = within(pop).getAllByRole("radio");
    expect(radios.map((r) => r.closest("label")!.textContent)).toEqual([
      "This file: /build/out.log",
      "All *.log files: *.log+1 file",
      "All files in build/: /build/+1 file",
    ]);
    expect(radios[0]).toBeChecked();
  });

  it("disables inapplicable scopes with their reason (dotfile, repository root) instead of hiding them", async () => {
    mountPanel(changes());
    await ready();
    const pop = await readyPopover(".env");
    const ext = within(pop).getByRole("radio", { name: /all files with this extension/i });
    expect(ext).toBeDisabled();
    expect(ext.closest("label")).toHaveAttribute("title", "This file has no extension.");
    expect(within(pop).getByRole("radio", { name: /files in this folder/i })).toBeDisabled();
  });

  it("the Menu key (a contextmenu event from the focused row) opens the row menu", async () => {
    mountPanel(changes());
    await ready();
    rowBtn("build/out.log").focus();
    fireEvent.contextMenu(rowBtn("build/out.log"), { clientX: 0, clientY: 0 });
    expect(await screen.findByRole("menu", { name: "Actions for build/out.log" })).toBeInTheDocument();
  });

  it("rows have no hover Ignore button: names stay uncovered (the menu, bulk bar and palette carry Ignore)", async () => {
    mountPanel(changes());
    await ready();
    expect(within(rowOf("build/out.log")).queryByRole("button", { name: /ignore/i })).not.toBeInTheDocument();
  });

  it("a conflicted row's menu disables Ignore with the reason (FR-501)", async () => {
    mountPanel(list({ conflicted: [file("c.ts", "conflicted", "unmerged")] }));
    await waitFor(() => expect(screen.getByText("Conflicted (1)")).toBeInTheDocument());
    fireEvent.contextMenu(rowOf("c.ts"), { clientX: 10, clientY: 10 });
    const item = within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Ignore…" });
    expect(item).toBeDisabled();
    expect(item).toHaveAttribute("title", expect.stringMatching(/conflict/i));
  });
});

describe("keyboard operation (hard requirement)", () => {
  it("moves focus onto the checked scope radio when it opens", async () => {
    mountPanel(changes());
    await ready();
    const pop = await readyPopover("build/out.log");
    expect(within(pop).getByRole("radio", { name: /This file/ })).toHaveFocus();
  });

  it("Up/Down arrows change the scope", async () => {
    mountPanel(changes());
    await ready();
    const pop = await readyPopover("build/out.log");
    await userEvent.keyboard("{ArrowDown}");
    expect(within(pop).getByRole("radio", { name: /All \*\.log files/ })).toBeChecked();
    await userEvent.keyboard("{ArrowDown}");
    expect(within(pop).getByRole("radio", { name: /All files in build/ })).toBeChecked();
    await userEvent.keyboard("{ArrowUp}");
    expect(within(pop).getByRole("radio", { name: /All \*\.log files/ })).toBeChecked();
  });

  it("Enter from a radio activates the primary Ignore with the chosen scope", async () => {
    const { api } = mountPanel(changes());
    await ready();
    await readyPopover("build/out.log");
    await userEvent.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(api.ignorePaths).toHaveBeenCalledWith({ paths: ["build/out.log"], scope: "extension", target: "root" }));
  });

  it("Enter from the Add to select also activates the primary", async () => {
    const { api } = mountPanel(changes());
    await ready();
    const pop = await readyPopover(".env");
    within(pop).getByRole("combobox", { name: "Add to" }).focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(api.ignorePaths).toHaveBeenCalledWith({ paths: [".env"], scope: "name", target: "root" }));
  });

  it("Enter on the Cancel button cancels (it is not hijacked by the primary)", async () => {
    const { api } = mountPanel(changes());
    await ready();
    const pop = await readyPopover(".env");
    within(pop).getByRole("button", { name: "Cancel" }).focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.ignorePaths).not.toHaveBeenCalled();
  });

  it("Tab and Shift+Tab cycle inside the popover and never leave it", async () => {
    mountPanel(changes());
    await ready();
    const pop = await readyPopover("build/out.log");
    const radio = within(pop).getByRole("radio", { name: /This file/ });
    const select = within(pop).getByRole("combobox", { name: "Add to" });
    const cancel = within(pop).getByRole("button", { name: "Cancel" });
    const primary = within(pop).getByRole("button", { name: "Ignore" });
    expect(radio).toHaveFocus();
    await userEvent.tab();
    expect(select).toHaveFocus();
    await userEvent.tab();
    expect(cancel).toHaveFocus();
    await userEvent.tab();
    expect(primary).toHaveFocus();
    await userEvent.tab();
    expect(radio).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(primary).toHaveFocus();
  });

  it("Escape cancels without writing and returns focus to the row that invoked it", async () => {
    const { api } = mountPanel(changes());
    await ready();
    rowBtn("build/out.log").focus();
    fireEvent.contextMenu(rowBtn("build/out.log"), { clientX: 10, clientY: 10 });
    const menu = await screen.findByRole("menu");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Ignore…" }));
    await screen.findByRole("dialog");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.ignorePaths).not.toHaveBeenCalled();
    await waitFor(() => expect(rowBtn("build/out.log")).toHaveFocus());
  });

  it("is a labelled dialog whose description is the live summary line", async () => {
    mountPanel(changes());
    await ready();
    const pop = await readyPopover("build/out.log");
    const summary = document.getElementById(pop.getAttribute("aria-describedby")!)!;
    expect(summary).toHaveAttribute("aria-live", "polite");
    await waitFor(() => expect(summary).toHaveTextContent("Hides 1 file. Adds /build/out.log to .gitignore."));
  });
});

describe("live summary, destination and no 'Checking…' flash", () => {
  it("counts the files the chosen scope hides and names the destination", async () => {
    mountPanel(changes());
    await ready();
    const pop = await readyPopover("build/out.log");
    const summary = document.getElementById(pop.getAttribute("aria-describedby")!)!;
    await userEvent.click(within(pop).getByRole("radio", { name: /All \*\.log files/ }));
    await waitFor(() => expect(summary).toHaveTextContent("Hides 2 files. Adds *.log to .gitignore."));
    await userEvent.selectOptions(within(pop).getByRole("combobox", { name: "Add to" }), "exclude");
    await waitFor(() => expect(summary).toHaveTextContent("Adds *.log to .git/info/exclude (private to this clone)."));
  });

  it("keeps the previous preview on screen (aria-busy) while the next one is read", async () => {
    const { api } = mountPanel(changes());
    await ready();
    const pop = await readyPopover(".env");
    const summary = document.getElementById(pop.getAttribute("aria-describedby")!)!;
    await waitFor(() => expect(summary).toHaveTextContent(/Adds \/\.env to \.gitignore/));
    let release: (v: unknown) => void = () => {};
    vi.mocked(api.planIgnore).mockReturnValue(new Promise((r) => (release = r)) as never);
    await userEvent.selectOptions(within(pop).getByRole("combobox", { name: "Add to" }), "nearest");
    expect(pop).toHaveAttribute("aria-busy", "true");
    expect(summary.textContent).not.toMatch(/checking/i);
    expect(summary).toHaveTextContent(/Adds \/\.env to \.gitignore/);
    expect(within(pop).getByRole("button", { name: "Ignore" })).toBeDisabled();
    release({ ok: true, data: reportOf([{ path: ".env", rule: "/.env", file: "src/.gitignore" }]) });
    await waitFor(() => expect(pop).not.toHaveAttribute("aria-busy"));
    expect(within(pop).getByRole("button", { name: "Ignore" })).toBeEnabled();
  });

  it("previews every applicable scope once, with stop-tracking planned so one read decides tracked or not", async () => {
    const { api } = mountPanel(changes());
    await ready();
    await readyPopover("build/out.log");
    const scopes = vi.mocked(api.planIgnore).mock.calls.map((c) => c[0].scope).sort();
    expect(scopes).toEqual(["directory", "extension", "name"]);
    expect(vi.mocked(api.planIgnore).mock.calls.every((c) => c[0].stopTracking === true)).toBe(true);
  });
});

describe("writing and the result notice (D2, D9)", () => {
  it("writes the chosen rule on Ignore and says what was added", async () => {
    const onWorkingDirChanged = vi.fn();
    const { api } = mountPanel(changes(), { onWorkingDirChanged });
    await ready();
    const pop = await readyPopover("build/out.log");
    await userEvent.click(within(pop).getByRole("radio", { name: /All \*\.log files/ }));
    await userEvent.click(within(pop).getByRole("button", { name: "Ignore" }));
    await waitFor(() => expect(api.ignorePaths).toHaveBeenCalledWith({ paths: ["build/out.log"], scope: "extension", target: "root" }));
    const notice = await screen.findByText("Added *.log to .gitignore.");
    expect(notice.closest("p")).toHaveAttribute("role", "status");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onWorkingDirChanged).toHaveBeenCalled();
    await waitFor(() => expect(document.querySelector('[data-row-key$=":build/out.log"]')).toBeNull());
  });

  it("offers .gitignore, the nearest one and the private exclude, and Private writes to .git/info/exclude", async () => {
    const { api } = mountPanel(changes());
    await ready();
    const pop = await readyPopover(".env");
    const select = within(pop).getByRole("combobox", { name: "Add to" });
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual([
      ".gitignore",
      "Nearest .gitignore",
      "Private .git/info/exclude (this clone only)",
    ]);
    await userEvent.selectOptions(select, "exclude");
    await waitFor(() => expect(api.planIgnore).toHaveBeenLastCalledWith(expect.objectContaining({ target: "exclude" })));
    await waitFor(() => expect(pop).not.toHaveAttribute("aria-busy"));
    await userEvent.click(within(pop).getByRole("button", { name: "Ignore" }));
    await waitFor(() => expect(api.ignorePaths).toHaveBeenCalledWith(expect.objectContaining({ target: "exclude", scope: "name" })));
  });

  it("remembers the last destination per repository, locally, and falls back to .gitignore", async () => {
    const first = mountPanel(changes(), { repoKey: "/repos/one" });
    await ready();
    let pop = await readyPopover(".env");
    await userEvent.selectOptions(within(pop).getByRole("combobox", { name: "Add to" }), "nearest");
    expect(window.localStorage.getItem("githydra:ignoreTarget:/repos/one")).toBe("nearest");
    await userEvent.click(within(pop).getByRole("button", { name: "Cancel" }));
    first.unmount();

    mountPanel(changes(), { repoKey: "/repos/one" });
    await ready();
    pop = await readyPopover(".env");
    expect(within(pop).getByRole("combobox", { name: "Add to" })).toHaveValue("nearest");
  });

  it("falls back to .gitignore when localStorage throws", async () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    try {
      mountPanel(changes(), { repoKey: "/repos/blocked" });
      await ready();
      const pop = await readyPopover(".env");
      expect(within(pop).getByRole("combobox", { name: "Add to" })).toHaveValue("root");
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
    const pop = await readyPopover(".env");
    expect(within(pop).queryByText(/linked worktree/)).not.toBeInTheDocument();
    await userEvent.selectOptions(within(pop).getByRole("combobox", { name: "Add to" }), "exclude");
    expect(await within(pop).findByText(/linked worktree: \.git\/info\/exclude is shared with the main checkout/)).toBeInTheDocument();
  });

  it("does not offer Ignore when the rule is already in the file, and says so (FR-497)", async () => {
    const { api } = mountPanel(changes());
    await ready();
    vi.mocked(api.planIgnore).mockResolvedValue({
      ok: true,
      data: reportOf([{ path: ".env", outcome: "already-in", rule: "/.env" }], { files: [{ file: ".gitignore", created: false, rules: [], alreadyPresent: ["/.env"], sharedWithOtherWorktrees: false }] }),
    } as never);
    const pop = await readyPopover(".env");
    expect(await within(pop).findByText("/.env is already in .gitignore.")).toBeInTheDocument();
    expect(within(pop).getByRole("button", { name: "Ignore" })).toBeDisabled();
  });

  it("names the file and line of a rule that already ignores it, and writes nothing", async () => {
    const { api } = mountPanel(changes());
    await ready();
    vi.mocked(api.planIgnore).mockResolvedValue({
      ok: true,
      data: reportOf([{ path: "build/out.log", outcome: "already-ignored", ignoredBy: { source: ".gitignore", line: 4, pattern: "*.log" } }]),
    } as never);
    const pop = await readyPopover("build/out.log");
    expect(await within(pop).findByText(/already ignored by \.gitignore:4; nothing was written/)).toBeInTheDocument();
    expect(within(pop).getByRole("button", { name: "Ignore" })).toBeDisabled();
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
    const pop = await readyPopover("build/out.log");
    await userEvent.click(within(pop).getByRole("button", { name: "Ignore" }));
    const notice = await screen.findByText(/still not ignored\. A later rule re-includes it: !out\.log \(\.gitignore:9\)/);
    expect(notice.closest("p")).toHaveClass("gh-changes-panel__notice--warn");
  });

  it("keeps the popover open and shows the typed error when the write fails (IgnoreFileChangedError)", async () => {
    const { api } = mountPanel(changes());
    await ready();
    vi.mocked(api.ignorePaths).mockResolvedValue({
      ok: false,
      error: { name: "IgnoreFileChangedError", code: "IGNORE_FILE_CHANGED", message: '".gitignore" changed while it was being updated, twice. Nothing was written; try again.', details: { file: ".gitignore" } },
    } as never);
    const pop = await readyPopover(".env");
    await userEvent.click(within(pop).getByRole("button", { name: "Ignore" }));
    expect(await screen.findByText(/changed while it was being updated, twice/)).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("Cancel and an outside press close it without writing", async () => {
    const { api } = mountPanel(changes());
    await ready();
    let pop = await readyPopover(".env");
    await userEvent.click(within(pop).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    pop = await readyPopover(".env");
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.ignorePaths).not.toHaveBeenCalled();
  });

  it("an open popover counts as a modal for the idle gate and global keybindings (FR-465)", async () => {
    const onDialogOpenChange = vi.fn();
    mountPanel(changes(), { onDialogOpenChange });
    await ready();
    const pop = await readyPopover(".env");
    expect(onDialogOpenChange).toHaveBeenLastCalledWith(true);
    await userEvent.click(within(pop).getByRole("button", { name: "Cancel" }));
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

  async function trackedPopover(report: IgnoreReport) {
    const view = mountPanel(changes());
    await ready();
    vi.mocked(view.api.planIgnore).mockResolvedValue({ ok: true, data: report } as never);
    const pop = await readyPopover("src/a.ts");
    await within(pop).findByRole("button", { name: "Ignore and stop tracking" });
    await waitFor(() => expect(pop).not.toHaveAttribute("aria-busy"));
    return { ...view, pop };
  }

  it("the same popover becomes the tracked variant: primary 'Ignore and stop tracking', secondary 'Ignore only', the staged-deletion list", async () => {
    const { pop } = await trackedPopover(trackedReport({ otherMatchesStillTracked: 3, paths: ["src/a.ts", "logs/old.log"], count: 2 }));
    expect(within(pop).getByText("tracked")).toBeInTheDocument();
    expect(within(pop).getByRole("button", { name: "Ignore and stop tracking" })).toBeEnabled();
    expect(within(pop).getByRole("button", { name: "Ignore only" })).toBeEnabled();
    expect(within(pop).queryByRole("button", { name: "Ignore" })).not.toBeInTheDocument();
    // The file list sits behind a collapsed disclosure; the counts and the on-disk/staged-deletion note stay visible.
    expect(within(pop).queryByRole("list", { name: "Files that become staged deletions" })).not.toBeInTheDocument();
    const toggle = within(pop).getByRole("button", { name: "Show 2 files" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const deletions = within(pop).getByRole("list", { name: "Files that become staged deletions" });
    expect(deletions).toHaveTextContent("src/a.ts");
    expect(deletions).toHaveTextContent("logs/old.log");
    expect(within(pop).getByText(/removes 2 files from git's index; they stay on disk and the deletions appear as staged changes/)).toBeInTheDocument();
    expect(within(pop).getByText(/3 other tracked files matching this rule stay tracked/)).toBeInTheDocument();
  });

  it("caps the expanded list at 50 and says 'and M more'; the count above it stays the true total", async () => {
    const paths = Array.from({ length: 60 }, (_, i) => `logs/f${i}.log`);
    const { pop } = await trackedPopover(trackedReport({ paths, count: 60 }));
    await userEvent.click(within(pop).getByRole("button", { name: "Show 60 files" }));
    const deletions = within(pop).getByRole("list", { name: "Files that become staged deletions" });
    expect(deletions.querySelectorAll("li")).toHaveLength(51);
    expect(deletions).toHaveTextContent("and 10 more");
  });

  it("Ignore only writes the rule and keeps tracking", async () => {
    const { api, pop } = await trackedPopover(trackedReport());
    await userEvent.click(within(pop).getByRole("button", { name: "Ignore only" }));
    await waitFor(() => expect(api.ignorePaths).toHaveBeenCalledWith({ paths: ["src/a.ts"], scope: "name", target: "root" }));
    expect(api.ignoreAndStopTracking).not.toHaveBeenCalled();
  });

  it("Ignore and stop tracking runs the untrack path with the previewed set and reports it", async () => {
    const { api, pop } = await trackedPopover(trackedReport());
    vi.mocked(api.ignoreAndStopTracking).mockResolvedValue({
      ok: true,
      data: { ...trackedReport(), applied: true, rows: [{ path: "src/a.ts", tracked: true, outcome: "written", rule: "/src/a.ts", file: ".gitignore" }] },
    } as never);
    await userEvent.click(within(pop).getByRole("button", { name: "Ignore and stop tracking" }));
    await waitFor(() =>
      expect(api.ignoreAndStopTracking).toHaveBeenCalledWith({ paths: ["src/a.ts"], scope: "name", target: "root", expectedUntrackPaths: ["src/a.ts"] }),
    );
    expect(await screen.findByText(/Added \/src\/a\.ts to \.gitignore\. Stopped tracking 1 file; they stay on disk and show as staged deletions\./)).toBeInTheDocument();
  });

  it("Enter from the scope radio runs the primary (stop tracking), the safe default for a tracked file", async () => {
    const { api } = await trackedPopover(trackedReport());
    within(screen.getByRole("dialog")).getByRole("radio", { name: /This file/ }).focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(api.ignoreAndStopTracking).toHaveBeenCalled());
    expect(api.ignorePaths).not.toHaveBeenCalled();
  });

  it("warns that a partly staged file's staged edits are dropped, and about a staged rename's old path", async () => {
    const { pop } = await trackedPopover(
      trackedReport({ mixedRows: ["src/a.ts"], renamedRows: [{ path: "src/new.ts", oldPath: "src/old.ts" }] }),
    );
    expect(within(pop).getByText(/1 partly staged file: the staged edits are dropped from the index/)).toBeInTheDocument();
    expect(within(pop).getByText(/1 staged rename: only the new path is untracked; the old path stays staged as deleted/)).toBeInTheDocument();
  });

  it("when the rule already exists only 'Ignore and stop tracking' is offered (FR-497)", async () => {
    const { pop } = await trackedPopover(trackedReport({}, [{ outcome: "already-ignored", ignoredBy: { source: ".gitignore", line: 2, pattern: "src/" } }]));
    expect(within(pop).getByRole("button", { name: "Ignore only" })).toBeDisabled();
    expect(within(pop).getByRole("button", { name: "Ignore and stop tracking" })).toBeEnabled();
  });

  it("Cancel writes nothing", async () => {
    const { api, pop } = await trackedPopover(trackedReport());
    await userEvent.click(within(pop).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.ignorePaths).not.toHaveBeenCalled();
    expect(api.ignoreAndStopTracking).not.toHaveBeenCalled();
  });

  it("IGNORE_PLAN_CHANGED explains the files changed, re-reads the previews and keeps the popover open (security L2)", async () => {
    const { api, pop } = await trackedPopover(trackedReport());
    vi.mocked(api.ignoreAndStopTracking).mockResolvedValue({
      ok: false,
      error: { name: "IgnorePlanChangedError", code: "IGNORE_PLAN_CHANGED", message: "plan changed", details: { expected: ["src/a.ts"], actual: ["src/a.ts", "src/b.ts"] } },
    } as never);
    const planCalls = vi.mocked(api.planIgnore).mock.calls.length;
    vi.mocked(api.planIgnore).mockResolvedValue({ ok: true, data: trackedReport({ paths: ["src/a.ts", "src/b.ts"], count: 2 }) } as never);
    await userEvent.click(within(pop).getByRole("button", { name: "Ignore and stop tracking" }));
    expect(await within(pop).findByText(/changed since you previewed them\. Review the updated list below and try again\./)).toBeInTheDocument();
    await waitFor(() => expect(vi.mocked(api.planIgnore).mock.calls.length).toBeGreaterThan(planCalls));
    expect(await within(pop).findByText(/removes 2 files from git's index/)).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("shows an IgnoreUntrackError's message, including that the rule file was left modified", async () => {
    const { api, pop } = await trackedPopover(trackedReport());
    vi.mocked(api.ignoreAndStopTracking).mockResolvedValue({
      ok: false,
      error: {
        name: "IgnoreUntrackError",
        code: "IGNORE_UNTRACK_FAILED",
        message: "Could not stop tracking the files (boom). The ignore rule was left in .gitignore; the files are still tracked.",
        details: { rolledBack: false, ruleFilesLeftModified: [".gitignore"], gitMessage: "boom" },
      },
    } as never);
    await userEvent.click(within(pop).getByRole("button", { name: "Ignore and stop tracking" }));
    expect(await within(pop).findByText(/The ignore rule was left in \.gitignore; the files are still tracked\./)).toBeInTheDocument();
  });
});

describe("bulk Ignore (FR-510)", () => {
  it("the bulk bar's Ignore opens the popover for the selection, returns focus to the button on Escape, and writes all rows in one request", async () => {
    const { api } = mountPanel(changes());
    await ready();
    fireEvent.click(rowBtn("build/out.log"));
    fireEvent.click(rowBtn("build/x.log"), { ctrlKey: true });
    const button = within(screen.getByRole("toolbar")).getByRole("button", { name: /^Ignore 2/ });
    button.focus();
    await userEvent.click(button);
    let pop = await screen.findByRole("dialog", { name: /^Ignore 2 files/ });
    expect(within(pop).getAllByRole("radio").map((r) => r.closest("label")!.textContent)).toEqual([
      "These 2 files: /build/out.log +1 more",
      "All *.log files: *.log",
      "All files in build/: /build/",
    ]);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(button).toHaveFocus());

    await userEvent.click(button);
    pop = await screen.findByRole("dialog", { name: /^Ignore 2 files/ });
    await userEvent.click(within(pop).getByRole("radio", { name: /All files in build/ }));
    await waitFor(() => expect(pop).not.toHaveAttribute("aria-busy"));
    await userEvent.click(within(pop).getByRole("button", { name: "Ignore" }));
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
    await screen.findByRole("dialog", { name: /^Ignore a\.log/ });
    await waitFor(() => expect(api.planIgnore).toHaveBeenCalledWith(expect.objectContaining({ paths: ["a.log"] })));
  });

  it("the multi-selection context menu's Ignore opens the same popover", async () => {
    mountPanel(changes());
    await ready();
    fireEvent.click(rowBtn("build/out.log"));
    fireEvent.click(rowBtn("build/x.log"), { ctrlKey: true });
    fireEvent.contextMenu(rowOf("build/out.log"), { clientX: 10, clientY: 10 });
    const menu = await screen.findByRole("menu", { name: "Actions for 2 selected files" });
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Ignore 2 files…" }));
    expect(await screen.findByRole("dialog", { name: /^Ignore 2 files/ })).toBeInTheDocument();
  });
});
