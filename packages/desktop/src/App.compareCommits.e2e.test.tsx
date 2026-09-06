// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from "vitest";
import { configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { createRealGitHydraApi, type RealGitHydraHandle } from "./test/realGitHydraApi";
import { cleanup, commitAll, git, initRepo, makeTempDir, writeFile } from "./test/gitFixture";

// Real `git` child-process spawns underneath every `waitFor`, same rationale as
// `App.cherryPick.e2e.test.tsx`/`App.blame.e2e.test.tsx` (RTL's default 1000ms timeout is too
// tight for that).
configure({ asyncUtilTimeout: 12000 });

/**
 * specs/compare-commits.md — the acceptance-criteria sweep that needs the REAL running app, not a
 * mocked `window.gitHydra`: does the "Compare 2 commits" context-menu action actually produce a
 * correct real `git diff <a> <b>` comparison, does the header/file-list/diff really reflect real
 * git-core output, and do App.tsx's panel-precedence/FR-194/195/196 deviations from `blameTarget`
 * behave correctly against the real component tree. Every test here renders the REAL `<App/>`
 * component tree against a REAL `GitHydraApi` backed by a REAL `RepoSession`/`Repository` shelling
 * out to a REAL `git` binary against a REAL temp repo on disk (`./test/realGitHydraApi.ts`) — no
 * git-core mocking anywhere in this file.
 *
 * Each test opens its own independent temp repo (no shared fixture state, no ordering dependency).
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

/** `fireEvent`, not `userEvent.click` — see `App.cherryPick.e2e.test.tsx`'s identical helper's
 * own comment for why (`userEvent.click`'s options aren't `fireEvent`'s event-init shape). */
async function ctrlClickRow(subject: string): Promise<void> {
  const row = await rowFor(subject);
  fireEvent.click(row, { ctrlKey: true });
}

async function rightClickRow(subject: string): Promise<HTMLElement> {
  const row = await rowFor(subject);
  fireEvent.contextMenu(row, { clientX: 20, clientY: 20 });
  return screen.findByRole("menu");
}

async function compareView(): Promise<HTMLElement> {
  return screen.findByRole("complementary", { name: "Compare commits" });
}

/** Ctrl-clicks both given (not-yet-selected) rows, right-clicks the second one (still part of
 * the resulting 2-row selection, per FR-112's existing "right-click within the selection leaves
 * it intact" convention), and invokes "Compare 2 commits" from its context menu. Mirrors
 * `App.cherryPick.e2e.test.tsx`'s own multi-select-then-right-click pattern. */
async function selectPairAndCompare(subjectA: string, subjectB: string): Promise<void> {
  await ctrlClickRow(subjectA);
  await ctrlClickRow(subjectB);
  const menu = await rightClickRow(subjectB);
  const item = within(menu).getByRole("menuitem", { name: /compare 2 commits/i });
  expect(item).not.toBeDisabled();
  await userEvent.click(item);
}

describe("specs/compare-commits.md — real App + real git-core integration", () => {
  it(
    "AC1/AC3/AC5/AC6: comparing two ctrl-selected commits opens CompareView with a correctly-labeled header and an auto-loaded first-file diff matching a real `git diff`",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      const baseSha = await commitFile(dir, "a.txt", "base\n", "base commit");
      const targetSha = await commitFile(dir, "a.txt", "changed\n", "target commit");

      await openAppOn(dir);
      await selectPairAndCompare("base commit", "target commit");

      const panel = await compareView();
      expect(await within(panel).findByText(baseSha.slice(0, 7))).toBeInTheDocument();
      expect(within(panel).getByText(targetSha.slice(0, 7))).toBeInTheDocument();
      expect(within(panel).getByText("base commit")).toBeInTheDocument();
      expect(within(panel).getByText("target commit")).toBeInTheDocument();

      expect(await within(panel).findByText(/changed files \(1\)/i)).toBeInTheDocument();
      const expected = await git(dir, ["diff", baseSha, targetSha, "--", "a.txt"]);
      const addedLine = expected.stdout.split("\n").find((l) => l.startsWith("+") && !l.startsWith("+++"));
      expect(addedLine).toBeTruthy();
      await waitFor(() => expect(within(panel).getByText("changed")).toBeInTheDocument());
    },
    30000,
  );

  it(
    "AC4: selecting the same two commits in the opposite click order produces the identical header/base-target labeling",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await commitFile(dir, "a.txt", "base\n", "commit one");
      await commitFile(dir, "a.txt", "changed\n", "commit two");

      await openAppOn(dir);
      // Opposite order: newer first, older second.
      await selectPairAndCompare("commit two", "commit one");

      const panel = await compareView();
      expect(await within(panel).findByText("Base")).toBeInTheDocument();
      expect(within(panel).getByText("Target")).toBeInTheDocument();
      // "commit one" (older) is base, "commit two" (newer) is target, regardless of click order.
      const baseRow = within(panel).getByText("Base").closest(".gh-compare-view__commit")!;
      expect(within(baseRow as HTMLElement).getByText("commit one")).toBeInTheDocument();
      const targetRow = within(panel).getByText("Target").closest(".gh-compare-view__commit")!;
      expect(within(targetRow as HTMLElement).getByText("commit two")).toBeInTheDocument();
    },
    30000,
  );

  it(
    "AC1/AC2: right-clicking with 0 selected shows a discoverable-but-disabled default; right-clicking a 3-commit selection shows a count-specific disabled tooltip",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await commitFile(dir, "a.txt", "v1\n", "commit one");
      await commitFile(dir, "a.txt", "v2\n", "commit two");
      await commitFile(dir, "a.txt", "v3\n", "commit three");

      await openAppOn(dir);
      let menu = await rightClickRow("commit one");
      let item = within(menu).getByRole("menuitem", { name: /compare 2 commits/i });
      expect(item).toBeDisabled();
      expect(item).toHaveAttribute("title", expect.stringMatching(/ctrl\/cmd-click another commit/i));
      await userEvent.keyboard("{Escape}");

      await ctrlClickRow("commit one");
      await ctrlClickRow("commit two");
      await ctrlClickRow("commit three");
      menu = await rightClickRow("commit two");
      item = within(menu).getByRole("menuitem", { name: /compare 2 commits/i });
      expect(item).toBeDisabled();
      expect(item).toHaveAttribute("title", expect.stringMatching(/select exactly 2 commits to compare \(3 selected\)/i));
    },
    30000,
  );

  it(
    "AC7: comparing two commits whose net diff is empty shows 'No files changed.'",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await commitFile(dir, "a.txt", "base\n", "only commit");
      await commitFile(dir, "a.txt", "changed\n", "middle commit");
      await commitFile(dir, "a.txt", "base\n", "reverted back to original");

      await openAppOn(dir);
      await selectPairAndCompare("only commit", "reverted back to original");

      const panel = await compareView();
      expect(await within(panel).findByText("No files changed.")).toBeInTheDocument();
    },
    30000,
  );

  it(
    "AC8: comparing the tips of two diverged branches (neither an ancestor of the other) succeeds with a correct diff",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await commitFile(dir, "a.txt", "base\n", "base commit");
      await git(dir, ["checkout", "-q", "-b", "left"]);
      await commitFile(dir, "a.txt", "left change\n", "left tip");
      await git(dir, ["checkout", "-q", "main"]);
      await git(dir, ["checkout", "-q", "-b", "right"]);
      await commitFile(dir, "a.txt", "right change\n", "right tip");

      await openAppOn(dir);
      await selectPairAndCompare("left tip", "right tip");

      const panel = await compareView();
      expect(await within(panel).findByText(/changed files \(1\)/i)).toBeInTheDocument();
      await waitFor(() => expect(within(panel).getByText("right change")).toBeInTheDocument());
    },
    30000,
  );

  it(
    "AC10: closing CompareView restores the right panel that was open before Compare was invoked",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await commitFile(dir, "a.txt", "v1\n", "commit one");
      await commitFile(dir, "a.txt", "v2\n", "commit two");

      await openAppOn(dir);
      await userEvent.click(await rowFor("commit one"));
      await screen.findByRole("complementary", { name: "Commit details" });

      await selectPairAndCompare("commit one", "commit two");
      const panel = await compareView();
      expect(screen.queryByRole("complementary", { name: "Commit details" })).not.toBeInTheDocument();

      await userEvent.click(within(panel).getByRole("button", { name: /close compare view/i }));
      expect(screen.queryByRole("complementary", { name: "Compare commits" })).not.toBeInTheDocument();
      expect(await screen.findByRole("complementary", { name: "Commit details" })).toBeInTheDocument();
    },
    30000,
  );

  it(
    "AC11: works against a bare repository",
    async () => {
      const srcDir = await initRepo();
      dirs.push(srcDir);
      await commitFile(srcDir, "a.txt", "v1\n", "commit one");
      await commitFile(srcDir, "a.txt", "v2\n", "commit two");
      const bareDir = await makeTempDir();
      await cleanup(bareDir); // git clone --bare insists on creating its own target.
      await git(process.cwd(), ["clone", "--bare", "-q", srcDir, bareDir]);
      dirs.push(bareDir);

      await openAppOn(bareDir);
      await screen.findByText(/bare repository/i);

      await selectPairAndCompare("commit one", "commit two");

      const panel = await compareView();
      expect(await within(panel).findByText(/changed files \(1\)/i)).toBeInTheDocument();
    },
    30000,
  );

  it(
    "AC12: the Swap control flips the base/target labeling and reloads content",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await commitFile(dir, "a.txt", "v1\n", "first commit");
      await commitFile(dir, "a.txt", "v2\n", "second commit");

      await openAppOn(dir);
      await selectPairAndCompare("first commit", "second commit");

      const panel = await compareView();
      await within(panel).findByText("Base");
      const baseRowBefore = within(panel).getByText("Base").closest(".gh-compare-view__commit")!;
      expect(within(baseRowBefore as HTMLElement).getByText("first commit")).toBeInTheDocument();

      await userEvent.click(within(panel).getByRole("button", { name: /swap base and target/i }));

      // Mirrors `BlamePanel`'s own re-blame-in-place precedent (App.blame.e2e.test.tsx AC8): the
      // header briefly clears while the swapped comparison reloads, then reflects the new pair.
      await within(panel).findByText("Base");
      const baseRowAfter = within(panel).getByText("Base").closest(".gh-compare-view__commit")!;
      expect(within(baseRowAfter as HTMLElement).getByText("second commit")).toBeInTheDocument();
      const targetRowAfter = within(panel).getByText("Target").closest(".gh-compare-view__commit")!;
      expect(within(targetRowAfter as HTMLElement).getByText("first commit")).toBeInTheDocument();
    },
    30000,
  );

  it(
    "AC13: a plain single click on a commit row while CompareView is open closes it and opens that commit's DetailPanel — never silently swallowed",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await commitFile(dir, "a.txt", "v1\n", "commit one");
      await commitFile(dir, "a.txt", "v2\n", "commit two");
      await commitFile(dir, "a.txt", "v3\n", "commit three");

      await openAppOn(dir);
      await selectPairAndCompare("commit one", "commit two");
      await compareView();

      await userEvent.click(await rowFor("commit three"));

      expect(screen.queryByRole("complementary", { name: "Compare commits" })).not.toBeInTheDocument();
      const detail = await screen.findByRole("complementary", { name: "Commit details" });
      await waitFor(() => expect(within(detail).getByText("commit three")).toBeInTheDocument());
    },
    30000,
  );

  it(
    "FR-194 (checkpoint row): clicking the uncommitted-changes pseudo-row while CompareView is open closes it and opens the Changes panel, mirroring a plain commit-row click",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await commitFile(dir, "a.txt", "v1\n", "commit one");
      await commitFile(dir, "a.txt", "v2\n", "commit two");
      // An uncommitted change so the graph's "Uncommitted changes" checkpoint pseudo-row renders.
      await writeFile(dir, "untracked.txt", "new stuff\n");

      await openAppOn(dir);
      await selectPairAndCompare("commit one", "commit two");
      await compareView();

      const graph = await graphRegion();
      const checkpointRow = (await within(graph).findByText(/^Uncommitted changes/)).closest('[role="option"]');
      if (!checkpointRow) throw new Error("checkpoint row not found");
      await userEvent.click(checkpointRow as HTMLElement);

      expect(screen.queryByRole("complementary", { name: "Compare commits" })).not.toBeInTheDocument();
      await screen.findByRole("complementary", { name: "Changes" });
    },
    30000,
  );

  it(
    "AC14/AC15: invoking Compare again on a newly-made 2-commit selection replaces the comparison in place, and the previously-compared row that's no longer part of the new pair loses its highlight while the new pair gains it",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await commitFile(dir, "a.txt", "v1\n", "commit one");
      await commitFile(dir, "a.txt", "v2\n", "commit two");
      await commitFile(dir, "a.txt", "v3\n", "commit three");

      await openAppOn(dir);
      await selectPairAndCompare("commit one", "commit two");
      let panel = await compareView();
      await waitFor(() => expect(within(panel).getByText("commit one")).toBeInTheDocument());
      expect(await rowFor("commit one")).toHaveClass("gh-commit-row--multi-selected");
      expect(await rowFor("commit two")).toHaveClass("gh-commit-row--multi-selected");

      // Build a fresh {commit two, commit three} selection purely via ctrl-clicks (never a plain
      // click, which would close CompareView per FR-194 before this can even be tested): toggle
      // "commit one" OUT of the still-live {one, two} selection, then toggle "commit three" IN.
      await ctrlClickRow("commit one");
      await ctrlClickRow("commit three");
      const menu = await rightClickRow("commit three");
      await userEvent.click(within(menu).getByRole("menuitem", { name: /compare 2 commits/i }));

      // Still exactly one CompareView — replaced in place, not closed and reopened.
      expect(screen.getAllByRole("complementary", { name: "Compare commits" })).toHaveLength(1);
      panel = await compareView();
      await waitFor(() => expect(within(panel).getByText("commit three")).toBeInTheDocument());

      expect(await rowFor("commit one")).not.toHaveClass("gh-commit-row--multi-selected");
      expect(await rowFor("commit two")).toHaveClass("gh-commit-row--multi-selected");
      expect(await rowFor("commit three")).toHaveClass("gh-commit-row--multi-selected");
    },
    30000,
  );
});
