// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from "vitest";
import { configure, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { createRealGitHydraApi, type RealGitHydraHandle } from "./test/realGitHydraApi";
import { cleanup, commitAll, git, initRepo, writeFile } from "./test/gitFixture";

// Real `git` child-process spawns underneath every `waitFor`, same rationale as
// App.branchTagGutter.e2e.test.tsx/App.stash.e2e.test.tsx.
configure({ asyncUtilTimeout: 12000 });

/**
 * Verification gate for specs/ref-chip-gutter-legibility.md FR-407-FR-411 (the "+N" multi-chip
 * collapse): exercises it against a REAL running `<App/>` + REAL git-core + a REAL temp repo on
 * disk — no git-core mocking anywhere in this file. `CommitRow.test.tsx`/
 * `CommitGraph.refChipCollapse.test.tsx` already cover the collapse decision and popover wiring at
 * component level with fixture data; this file's job is the real UI/git-core boundary those can't
 * reach — does a real multi-ref commit (two real local branches sharing a tip plus a real tag)
 * actually collapse in the real running app, and does the reused `ContextMenu` popover it opens
 * carry real branch/tag names end to end.
 */

const handles: RealGitHydraHandle[] = [];
const dirs: string[] = [];

afterEach(async () => {
  // @ts-expect-error test cleanup of the global bridge
  delete window.gitHydra;
  await new Promise((resolve) => setTimeout(resolve, 350));
  while (handles.length) handles.pop()!.dispose();
  while (dirs.length) {
    const dir = dirs.pop()!;
    try {
      await cleanup(dir);
    } catch {
      // Best-effort: an occasional Windows file-lock shouldn't fail this test's own assertions.
    }
  }
});

async function openAppOn(dir: string): Promise<RealGitHydraHandle> {
  const handle = createRealGitHydraApi();
  handles.push(handle);
  handle.setDialogPath(dir);
  window.gitHydra = handle.api;
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
  await screen.findByRole("button", { name: /stashes/i }, { timeout: 10000 });
  return handle;
}

async function commitFile(dir: string, file: string, content: string, message: string): Promise<string> {
  await writeFile(dir, file, content);
  return commitAll(dir, message);
}

async function currentBranchName(dir: string): Promise<string> {
  const { stdout } = await git(dir, ["symbolic-ref", "--short", "HEAD"]);
  return stdout.trim();
}

async function localBranchNames(dir: string): Promise<string[]> {
  const { stdout } = await git(dir, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  return stdout.split("\n").filter(Boolean);
}

async function graphRegion(): Promise<HTMLElement> {
  return screen.findByRole("listbox", { name: /commit graph/i });
}

async function rowFor(subject: string): Promise<HTMLElement> {
  const graph = await graphRegion();
  const text = await within(graph).findByText(subject);
  const row = text.closest('[role="option"]');
  if (!row) throw new Error(`row not found for subject: ${subject}`);
  return row as HTMLElement;
}

describe("specs/ref-chip-gutter-legibility.md — real App + real git-core integration", () => {
  it(
    "AC2/AC5/AC6: a real commit carrying two local branches plus a tag collapses to the checked-out branch's chip and a +2 button, whose popover lists both other refs' full names as inert rows",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await commitFile(dir, "a.txt", "base\n", "shared commit");
      await git(dir, ["branch", "alpha"]); // second local branch, same tip, not checked out.
      await git(dir, ["tag", "v1.0"]);

      await openAppOn(dir);
      const row = await rowFor("shared commit");

      // FR-409 priority 1: main is checked out — its own chip is the one that stays visible.
      const mainChip = within(row).getByRole("img", { name: /local branch: main/i });
      expect(mainChip.className).toContain("gh-refchip--filled");
      expect(within(row).queryByRole("img", { name: /local branch: alpha/i })).not.toBeInTheDocument();
      expect(within(row).queryByRole("img", { name: /tag: v1\.0/i })).not.toBeInTheDocument();

      const moreButton = within(row).getByRole("button", { name: "2 more refs on this commit — view all" });
      expect(moreButton).toHaveTextContent("+2");

      await userEvent.click(moreButton);
      const menu = await screen.findByRole("menu", { name: /more refs on this commit/i });
      expect(menu).toHaveClass("gh-context-menu");
      const items = within(menu).getAllByRole("menuitem");
      expect(items).toHaveLength(2);
      const texts = items.map((i) => i.getAttribute("aria-label"));
      expect(texts).toContain("local branch: alpha");
      expect(texts).toContain("tag: v1.0");
      for (const item of items) expect(item).toBeDisabled();

      // AC5/AC6: Escape closes it, and it was genuinely inert the whole time — the real repo's
      // branches/current branch are exactly as they were before the popover ever opened.
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(await currentBranchName(dir)).toBe("main");
      expect(await localBranchNames(dir)).toEqual(expect.arrayContaining(["main", "alpha"]));
    },
    30000,
  );

  it(
    "AC10: the +N affix is keyboard-reachable and Enter opens the same real popover a click would",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await commitFile(dir, "a.txt", "base\n", "shared commit");
      await git(dir, ["branch", "alpha"]);
      await git(dir, ["tag", "v1.0"]);

      await openAppOn(dir);
      const row = await rowFor("shared commit");
      const moreButton = within(row).getByRole("button", { name: /2 more refs on this commit/i });

      moreButton.focus();
      expect(moreButton).toHaveFocus();
      await userEvent.keyboard("{Enter}");

      const menu = await screen.findByRole("menu", { name: /more refs on this commit/i });
      expect(within(menu).getAllByRole("menuitem")).toHaveLength(2);
    },
    30000,
  );

  it(
    "AC1 (regression guard): a real commit with only one real ref chip never shows a +N affix",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await commitFile(dir, "a.txt", "base\n", "solo commit");

      await openAppOn(dir);
      const row = await rowFor("solo commit");
      expect(within(row).getByRole("img", { name: /local branch: main/i })).toBeInTheDocument();
      expect(within(row).queryByRole("button", { name: /more refs on this commit/i })).not.toBeInTheDocument();
    },
    30000,
  );
});
