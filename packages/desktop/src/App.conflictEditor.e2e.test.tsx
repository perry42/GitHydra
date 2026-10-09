// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { configure, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { createRealGitHydraApi, type RealGitHydraHandle } from "./test/realGitHydraApi";
import { cleanup, commitAll, git, initRepo, readFile as readRaw, statusPorcelain, writeFile } from "./test/gitFixture";
import { polyfillCodeMirrorDom } from "./test/codemirrorDom";

configure({ asyncUtilTimeout: 12000 });
beforeAll(polyfillCodeMirrorDom);

/**
 * specs/edit-in-diff.md FR-556..FR-565 against a REAL repo, real git-core and the real App: a merge conflict opened in the
 * block editor resolves into the file git would stage, and "Mark as resolved" stages what is on DISK (FR-558/FR-563).
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
      /* a Windows file lock must not fail the assertions */
    }
  }
});

// The Windows runner checks files out with CRLF; the editor preserves whatever the file had, so compare the text only.
const readFile = async (dir: string, rel: string) => (await readRaw(dir, rel)).replace(/\r\n/g, "\n");

const BASE = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9", ""].join("\n");
const withLines = (a: string, b: string) => BASE.replace("l2", a).replace("l8", b);

async function mergeConflictRepo(style?: "diff3"): Promise<string> {
  const dir = await initRepo();
  dirs.push(dir);
  if (style) await git(dir, ["config", "merge.conflictStyle", style]);
  await writeFile(dir, "a.txt", BASE);
  await commitAll(dir, "base");
  await git(dir, ["checkout", "-q", "-b", "feature"]);
  await writeFile(dir, "a.txt", withLines("feat2", "feat8"));
  await commitAll(dir, "feature change");
  await git(dir, ["checkout", "-q", "main"]);
  await writeFile(dir, "a.txt", withLines("main2", "main8"));
  await commitAll(dir, "main change");
  await git(dir, ["merge", "feature"]).catch(() => {});
  return dir;
}

async function openEditorOnConflict(dir: string): Promise<void> {
  const handle = createRealGitHydraApi();
  handles.push(handle);
  handle.setDialogPath(dir);
  window.gitHydra = handle.api;
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
  await userEvent.click(await screen.findByRole("button", { name: /^changes/i }, { timeout: 10000 }));
  const panel = await screen.findByRole("complementary", { name: "Changes" });
  await waitFor(() => expect(within(panel).getByText("a.txt")).toBeInTheDocument());
  // specs/edit-in-diff.md FR-556: clicking an editor-eligible conflicted row opens the editor itself.
  await userEvent.click(within(panel).getByText("a.txt"));
  await screen.findByRole("textbox", { name: "Editing a.txt" }, { timeout: 10000 });
}

const chip = (n: number, name: RegExp | string) => within(screen.getByRole("group", { name: `Resolution for conflict ${n}` })).getByRole("button", { name });

describe("conflict block editor, real git (specs/edit-in-diff.md FR-556..FR-565)", () => {
  it(
    "resolves two blocks by chip and Mark as resolved stages exactly what was written to disk",
    async () => {
      const dir = await mergeConflictRepo();
      expect(await statusPorcelain(dir)).toMatch(/^UU a\.txt/m);
      await openEditorOnConflict(dir);

      expect(screen.getByText("Resolving")).toBeInTheDocument();
      const mark = screen.getByTestId("mark-resolved");
      await waitFor(() => expect(mark).toHaveAttribute("aria-disabled", "true"));
      // Nothing was written or staged just by opening it (FR-528/FR-556).
      expect(await statusPorcelain(dir)).toMatch(/^UU a\.txt/m);

      await userEvent.click(chip(1, /^Yours/));
      await userEvent.click(chip(2, /^Incoming/));
      await waitFor(() => expect(screen.getByText("All 2 conflicts decided")).toBeInTheDocument());
      expect(mark).not.toHaveAttribute("aria-disabled");

      await userEvent.click(mark);
      await waitFor(async () => expect(await statusPorcelain(dir)).toMatch(/^M {2}a\.txt/m), { timeout: 12000 });
      expect(await readFile(dir, "a.txt")).toBe(withLines("main2", "feat8"));
      expect((await git(dir, ["ls-files", "--unmerged"])).stdout.trim()).toBe("");
      expect((await git(dir, ["diff", "--cached", "--", "a.txt"])).stdout).toContain("+feat8");
    },
    90000,
  );

  it(
    "a half-resolved file that was saved and reopened still shows the tick of the decided block (FR-557, FR-565)",
    async () => {
      const dir = await mergeConflictRepo();
      await openEditorOnConflict(dir);
      await userEvent.click(chip(1, /^Incoming/));
      await userEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
      await waitFor(async () => expect(await readFile(dir, "a.txt")).not.toContain("main2"), { timeout: 12000 });
      // Saving writes the working file only; the conflict is still unmerged in the index.
      expect(await statusPorcelain(dir)).toMatch(/^UU a\.txt/m);

      await userEvent.click(screen.getByRole("button", { name: "Back to changes" }));
      expect(screen.queryByRole("textbox", { name: "Editing a.txt" })).toBeNull();
      await userEvent.click(within(await screen.findByRole("complementary", { name: "Changes" })).getByText("a.txt"));
      await screen.findByRole("textbox", { name: "Editing a.txt" }, { timeout: 10000 });

      await waitFor(() => expect(chip(1, /^Incoming/)).toHaveAttribute("aria-pressed", "true"));
      expect(chip(2, /^Yours/)).toHaveAttribute("aria-pressed", "false");
      expect(screen.getByRole("group", { name: "Conflict navigator" })).toHaveTextContent("of 2");
      expect(screen.getByRole("button", { name: /1 conflict unresolved/ })).toBeInTheDocument();
      // The recovered sides make the decided block re-decidable.
      await userEvent.click(chip(1, /^Yours/));
      await waitFor(() => expect(chip(1, /^Yours/)).toHaveAttribute("aria-pressed", "true"));
    },
    90000,
  );


  it(
    "a diff3 conflict (base section in the markers) opens as blocks, and Reset restores the pristine markers",
    async () => {
      const dir = await mergeConflictRepo("diff3");
      await openEditorOnConflict(dir);
      expect(chip(1, /^Yours/)).toBeInTheDocument();
      await userEvent.click(chip(1, "Neither, remove both sides"));
      await waitFor(() => expect(chip(1, "Neither, remove both sides")).toHaveAttribute("aria-pressed", "true"));
      await userEvent.click(chip(1, /^Reset/));
      await waitFor(() => expect(chip(1, "Neither, remove both sides")).toHaveAttribute("aria-pressed", "false"));
      expect(screen.getByRole("button", { name: /2 conflicts unresolved/ })).toBeInTheDocument();
      // Save writes the working file only; the index keeps the conflict (FR-556).
      expect(await statusPorcelain(dir)).toMatch(/^UU a\.txt/m);
    },
    90000,
  );

  it(
    "in a rebase the chips read Onto then Yours, and the stage is refused on disk while markers remain",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeFile(dir, "a.txt", BASE);
      await commitAll(dir, "base");
      await git(dir, ["checkout", "-q", "-b", "feature"]);
      await writeFile(dir, "a.txt", withLines("feat2", "l8"));
      await commitAll(dir, "feature change");
      await git(dir, ["checkout", "-q", "main"]);
      await writeFile(dir, "a.txt", withLines("main2", "l8"));
      await commitAll(dir, "main change");
      await git(dir, ["checkout", "-q", "feature"]);
      await git(dir, ["rebase", "main"]).catch(() => {});
      expect(await statusPorcelain(dir)).toMatch(/^UU a\.txt/m);
      await openEditorOnConflict(dir);

      const row = within(screen.getByRole("group", { name: "Resolution for conflict 1" })).getAllByRole("button");
      expect(row[0]).toHaveAccessibleName("Onto, main");
      expect(row[1]).toHaveAccessibleName("Yours, feature");
      expect(screen.getByText(/Rebase swaps the sides/)).toBeInTheDocument();
      // Yours in a rebase is the SECOND section: the user's own commit.
      await userEvent.click(chip(1, /^Yours/));
      await waitFor(() => expect(screen.getByText("All 1 conflict decided")).toBeInTheDocument());
      await userEvent.click(screen.getByTestId("mark-resolved"));
      await waitFor(async () => expect(await statusPorcelain(dir)).not.toMatch(/^UU a\.txt/m), { timeout: 12000 });
      expect(await readFile(dir, "a.txt")).toBe(withLines("feat2", "l8"));
    },
    90000,
  );

  it(
    "two conflicted files: resolving the first offers Next conflicted file, resolving the last offers Continue merge, which finishes the merge (FR-569)",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeFile(dir, "a.txt", BASE);
      await writeFile(dir, "b.txt", BASE);
      await commitAll(dir, "base");
      await git(dir, ["checkout", "-q", "-b", "feature"]);
      await writeFile(dir, "a.txt", withLines("feat2", "l8"));
      await writeFile(dir, "b.txt", withLines("feat2", "l8"));
      await commitAll(dir, "feature change");
      await git(dir, ["checkout", "-q", "main"]);
      await writeFile(dir, "a.txt", withLines("main2", "l8"));
      await writeFile(dir, "b.txt", withLines("main2", "l8"));
      await commitAll(dir, "main change");
      await git(dir, ["merge", "feature"]).catch(() => {});
      await openEditorOnConflict(dir);

      await userEvent.click(chip(1, /^Yours/));
      await userEvent.click(screen.getByTestId("mark-resolved"));
      const strip = await screen.findByTestId("resolved-strip", {}, { timeout: 15000 });
      await waitFor(() => expect(strip).toHaveTextContent("Resolved and staged. 1 conflicted file left."));
      await userEvent.click(within(strip).getByRole("button", { name: "Next conflicted file" }));
      await screen.findByRole("textbox", { name: "Editing b.txt" }, { timeout: 10000 });

      await userEvent.click(chip(1, /^Incoming/));
      await userEvent.click(screen.getByTestId("mark-resolved"));
      const last = await screen.findByTestId("resolved-strip", {}, { timeout: 15000 });
      await waitFor(() => expect(last).toHaveTextContent("All conflicts resolved. Ready to continue."));
      const cont = within(last).getByRole("button", { name: "Continue merge" });
      await waitFor(() => expect(cont).not.toHaveAttribute("aria-disabled"), { timeout: 15000 });
      expect((await git(dir, ["log", "--merges", "--oneline"])).stdout.trim()).toBe("");
      await userEvent.click(cont);
      await waitFor(async () => expect((await git(dir, ["log", "--merges", "--oneline"])).stdout.trim()).not.toBe(""), { timeout: 20000 });
    },
    120000,
  );
});
