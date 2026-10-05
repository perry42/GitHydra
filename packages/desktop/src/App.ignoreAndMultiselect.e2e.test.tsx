// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { createRealGitHydraApi, type RealGitHydraHandle } from "./test/realGitHydraApi";
import { cleanup, commitAll, git, initRepo, readFile, statusPorcelain, writeFile } from "./test/gitFixture";

configure({ asyncUtilTimeout: 12000 });

/**
 * specs/ignore-and-multiselect.md AC1, AC2, AC6, AC10, AC11, AC12 end to end: the real App against a real RepoSession, real
 * git-core and a real git binary. Every assertion on repository state reads the repo back with git itself.
 */

const handles: RealGitHydraHandle[] = [];
const dirs: string[] = [];

afterEach(async () => {
  // @ts-expect-error test cleanup of the global bridge
  delete window.gitHydra;
  await new Promise((resolve) => setTimeout(resolve, 350));
  while (handles.length) handles.pop()!.dispose();
  while (dirs.length) {
    try {
      await cleanup(dirs.pop()!);
    } catch {
      // A Windows file lock must not fail an assertion that already passed.
    }
  }
});

async function openAppOn(dir: string): Promise<HTMLElement> {
  const handle = createRealGitHydraApi();
  handles.push(handle);
  handle.setDialogPath(dir);
  window.gitHydra = handle.api;
  window.localStorage.clear();
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
  await userEvent.click(await screen.findByRole("button", { name: /^changes/i }, { timeout: 10000 }));
  return screen.findByRole("complementary", { name: "Changes" });
}

const rowBtn = (panel: HTMLElement, p: string): HTMLElement =>
  panel.querySelector<HTMLElement>(`[data-row-key$=":${p}"]`) as HTMLElement;
const rowOf = (panel: HTMLElement, p: string): HTMLElement => rowBtn(panel, p).closest<HTMLElement>(".gh-changes-panel__file")!;

describe("ignore and multi-select, real App + real git-core", () => {
  it(
    "AC10: bulk Stage of files with spaces, glob and non-ASCII characters leaves git's own status exactly as expected",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      // No "*" or "?": Windows cannot create such file names. Brackets, braces, "#" and "!" still stress pathspec/rule handling.
      const names = ["plain.txt", "with space.txt", "x[1].txt", "a{b}.txt", "unicodé.txt"];
      for (const n of names) await writeFile(dir, n, "1\n");
      await commitAll(dir, "base");
      for (const n of names) await writeFile(dir, n, "2\n");

      const panel = await openAppOn(dir);
      await waitFor(() => expect(within(panel).getByText("Unstaged (5)")).toBeInTheDocument());
      // Git lists them alphabetically; select first to last by that order.
      const sorted = [...names].sort();
      fireEvent.click(rowBtn(panel, sorted[0]!));
      fireEvent.click(rowBtn(panel, sorted[4]!), { shiftKey: true });
      await waitFor(() => expect(within(panel).getByText("5 selected")).toBeInTheDocument());
      await userEvent.click(within(panel).getByRole("button", { name: "Stage 5 selected" }));

      // The UI updates optimistically; wait for git itself to show all five staged.
      await waitFor(async () => {
        const staged = (await statusPorcelain(dir)).split("\n").filter((l) => l.startsWith("M "));
        expect(staged).toHaveLength(5);
      });
      expect((await statusPorcelain(dir)).split("\n").filter(Boolean)).toHaveLength(5);
      expect(await within(panel).findByText("Staged 5 files.")).toBeInTheDocument();
    },
    60000,
  );

  it(
    "AC2/AC17: ignoring a file by extension into the private exclude writes one rule there, leaves .gitignore alone, and the file leaves the list",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeFile(dir, "keep.txt", "k\n");
      await commitAll(dir, "base");
      await writeFile(dir, "build/out.log", "log\n");
      await writeFile(dir, "build/other.log", "log\n");

      const panel = await openAppOn(dir);
      await waitFor(() => expect(within(panel).getByText("Untracked (2)")).toBeInTheDocument());
      fireEvent.contextMenu(rowOf(panel, "build/out.log"), { clientX: 10, clientY: 10 });
      await userEvent.click(await screen.findByRole("menuitem", { name: "Ignore…" }));
      const dialog = await screen.findByRole("dialog", { name: /^Ignore build\/out\.log/ });
      await userEvent.click(within(dialog).getByRole("radio", { name: /All \*\.log files/ }));
      await userEvent.selectOptions(within(dialog).getByRole("combobox", { name: "Add to" }), "exclude");
      // The preview (a real git read) must finish before Ignore enables.
      const add = within(dialog).getByRole("button", { name: "Ignore" });
      await waitFor(() => expect(dialog).not.toHaveAttribute("aria-busy"));
      await waitFor(() => expect(add).toBeEnabled());
      await userEvent.click(add);

      expect(await within(panel).findByText("Added *.log to .git/info/exclude.")).toBeInTheDocument();
      expect(await readFile(dir, ".git/info/exclude")).toContain("*.log\n");
      await expect(fs.stat(path.join(dir, ".gitignore"))).rejects.toThrow();
      expect(await statusPorcelain(dir)).toBe("");
      await waitFor(() => expect(within(panel).getByText("Untracked (0)")).toBeInTheDocument());
    },
    60000,
  );

  it(
    "AC6: Ignore and Stop Tracking on a tracked file stages its deletion, keeps it on disk, and writes the root rule",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeFile(dir, "secret.env", "A=1\n");
      await writeFile(dir, "other.txt", "o\n");
      await commitAll(dir, "base");
      await writeFile(dir, "secret.env", "A=2\n");

      const panel = await openAppOn(dir);
      await waitFor(() => expect(within(panel).getByText("Unstaged (1)")).toBeInTheDocument());
      fireEvent.contextMenu(rowOf(panel, "secret.env"), { clientX: 10, clientY: 10 });
      await userEvent.click(await screen.findByRole("menuitem", { name: "Ignore…" }));
      const tracked = await screen.findByRole("dialog", { name: /^Ignore secret\.env/ });
      await waitFor(() => expect(within(tracked).getByRole("button", { name: "Ignore and stop tracking" })).toBeEnabled());
      await userEvent.click(within(tracked).getByRole("button", { name: "Ignore and stop tracking" }));

      expect(await within(panel).findByText(/Stopped tracking 1 file/)).toBeInTheDocument();
      expect(await readFile(dir, ".gitignore")).toBe("/secret.env\n");
      expect(await readFile(dir, "secret.env")).toBe("A=2\n");
      const lines = (await statusPorcelain(dir)).split("\n").filter(Boolean).sort();
      // The deletion is staged; the new .gitignore is an ordinary untracked change, never auto-staged (FR-502).
      expect(lines).toEqual(["?? .gitignore", "D  secret.env"]);
    },
    60000,
  );

  it(
    "AC11: an external edit after the confirmation opened refuses the whole batch as STALE_DIFF, names the path and changes nothing",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeFile(dir, "a.txt", "1\n");
      await writeFile(dir, "b.txt", "1\n");
      await commitAll(dir, "base");
      await writeFile(dir, "a.txt", "2\n");
      await writeFile(dir, "b.txt", "2\n");

      const panel = await openAppOn(dir);
      await waitFor(() => expect(within(panel).getByText("Unstaged (2)")).toBeInTheDocument());
      fireEvent.click(rowBtn(panel, "a.txt"));
      fireEvent.click(rowBtn(panel, "b.txt"), { ctrlKey: true });
      await userEvent.click(within(panel).getByRole("button", { name: /^Discard 2/ }));
      const confirm = await screen.findByRole("button", { name: "Discard 2 files" });
      await waitFor(() => expect(confirm).toBeEnabled());

      await writeFile(dir, "b.txt", "edited behind the dialog\n");
      await userEvent.click(confirm);

      expect(await screen.findByText(/These files changed since you opened this: b\.txt\. Nothing was discarded\./)).toBeInTheDocument();
      expect(await readFile(dir, "a.txt")).toBe("2\n");
      expect(await readFile(dir, "b.txt")).toBe("edited behind the dialog\n");
    },
    60000,
  );

  it(
    "AC12: Discard all changes resets tracked files, keeps untracked files unless the box is ticked, and leaves staged content alone",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeFile(dir, "a.txt", "1\n");
      await writeFile(dir, "s.txt", "1\n");
      await commitAll(dir, "base");
      await writeFile(dir, "a.txt", "2\n");
      await writeFile(dir, "s.txt", "staged\n");
      await writeFile(dir, "new.txt", "keep me\n");
      // Staged before the app opens, so the discard must leave it staged.
      await git(dir, ["add", "s.txt"]);

      const panel = await openAppOn(dir);
      await waitFor(() => expect(within(panel).getByText("Staged (1)")).toBeInTheDocument());
      expect(within(panel).getByText("Unstaged (1)")).toBeInTheDocument();

      await userEvent.click(within(panel).getByRole("button", { name: "Unstaged section actions" }));
      await userEvent.click(await screen.findByRole("menuitem", { name: "Discard all changes…" }));
      const dialog = await screen.findByRole("alertdialog", { name: "Discard all changes?" });
      const box = await within(dialog).findByRole("checkbox", { name: "Also delete 1 untracked file" });
      expect(box).not.toBeChecked();
      const go = await within(dialog).findByRole("button", { name: "Discard 1 file" });
      await userEvent.type(within(dialog).getByRole("textbox", { name: /Type 1 to confirm/ }), "1");
      await waitFor(() => expect(go).toBeEnabled());
      // Let the app's own opening reads (diffs, mixed-file detection) finish: on Windows one of them can refresh the index
      // while the restore runs, which git-core then reports as a partial result. A person takes longer than this to click.
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await userEvent.click(go);

      expect(await within(panel).findByText("Discarded 1 file.")).toBeInTheDocument();
      // git may restore CRLF on Windows (autocrlf); the content, not the line ending, is what this checks.
      expect((await readFile(dir, "a.txt")).replace(/\r\n/g, "\n")).toBe("1\n");
      expect(await readFile(dir, "new.txt")).toBe("keep me\n");
      expect((await statusPorcelain(dir)).split("\n").filter(Boolean).sort()).toEqual(["?? new.txt", "M  s.txt"]);
    },
    60000,
  );
});
