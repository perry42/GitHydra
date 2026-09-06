// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from "vitest";
import { configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { createRealGitHydraApi, type RealGitHydraHandle } from "./test/realGitHydraApi";
import { cleanup, commitAll, git, initRepo, statusPorcelain, writeFile } from "./test/gitFixture";

// Real `git` child-process spawns underneath every `waitFor`, same rationale as
// `App.stash.e2e.test.tsx`/`App.cherryPick.e2e.test.tsx` (RTL's default 1000ms timeout is too
// tight for that).
configure({ asyncUtilTimeout: 12000 });

/**
 * specs/blame.md — the acceptance-criteria sweep that needs the REAL running app, not a mocked
 * `window.gitHydra`: does right-clicking a real Changes/DetailPanel row actually open a BlamePanel
 * showing what real `git blame`/`git log --follow` produced, does clicking a blamed block's commit
 * metadata actually select/reveal the right real commit, does re-blaming in place actually swap
 * content without a second panel, and — the data-loss-adjacent one — does the whole flow really
 * never mutate the repo. Every test here renders the REAL `<App/>` component tree against a REAL
 * `GitHydraApi` backed by a REAL `RepoSession`/`Repository` shelling out to a REAL `git` binary
 * against a REAL temp repo on disk (`./test/realGitHydraApi.ts`) — no git-core mocking anywhere in
 * this file.
 *
 * Each test opens its own independent temp repo (no shared fixture state, no ordering dependency).
 */

const handles: RealGitHydraHandle[] = [];
const dirs: string[] = [];

afterEach(async () => {
  // @ts-expect-error test cleanup of the global bridge
  delete window.gitHydra;
  // Same grace window App.stash.e2e.test.tsx/App.cherryPick.e2e.test.tsx use before disposing.
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

async function headSha(dir: string): Promise<string> {
  const { stdout } = await git(dir, ["rev-parse", "HEAD"]);
  return stdout.trim();
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

async function openChangesPanel(): Promise<HTMLElement> {
  await userEvent.click(await screen.findByRole("button", { name: /^changes/i }));
  return screen.findByRole("complementary", { name: "Changes" });
}

/** Locates a `ChangesPanel` section's `<ul>` by its heading label ("Staged"/"Unstaged"/
 * "Untracked"/"Conflicted"), matching that section's own `${label} (${count})` heading text.
 * Async (`findByText`, not `getByText`) — the panel's data is `useRepositoryGraph`-owned and
 * threaded down as a prop (ROADMAP.md tech-debt fix); a synchronous query issued the instant the
 * panel appears can still race that state landing/React committing the resulting render. */
async function changesSectionList(panelEl: HTMLElement, label: string): Promise<HTMLElement> {
  const heading = await within(panelEl).findByText(new RegExp(`^${label} \\(`));
  const section = heading.closest("section");
  if (!section) throw new Error(`section not found for label: ${label}`);
  const list = section.querySelector("ul");
  if (!list) throw new Error(`no file list rendered for section: ${label}`);
  return list as HTMLElement;
}

async function rightClickChangesFile(panelEl: HTMLElement, sectionLabel: string, path: string): Promise<HTMLElement> {
  const list = await changesSectionList(panelEl, sectionLabel);
  const pathEl = within(list).getByText(path);
  const row = pathEl.closest(".gh-changes-panel__file") as HTMLElement;
  fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
  return screen.findByRole("menu");
}

/** Scoped to the changed-file list specifically (`.gh-detail-panel__file-list`) — `DiffView`'s own
 * heading also renders the same path text once a file is auto-selected (FR-29's auto-diff), so an
 * unscoped `within(panelEl).getByText(path)` is ambiguous. */
async function rightClickDetailFile(panelEl: HTMLElement, path: string): Promise<HTMLElement> {
  const list = await within(panelEl).findByRole("list");
  const pathEl = within(list).getByText(path);
  const row = pathEl.closest(".gh-detail-panel__file") as HTMLElement;
  fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
  return screen.findByRole("menu");
}

/** Clicks the (assumed enabled) "Blame" item in an already-open context menu and waits for
 * `BlamePanel` (FR-132) to mount. */
async function chooseBlame(menu: HTMLElement): Promise<HTMLElement> {
  const item = within(menu).getByRole("menuitem", { name: "Blame" });
  expect(item).toBeEnabled();
  await userEvent.click(item);
  return screen.findByRole("complementary", { name: "Blame" });
}

/** Async — `useBlame`'s fetch (a real `getFileBlame` IPC round trip) is still in flight for a
 * moment right after `BlamePanel` mounts, during which its body shows the "Loading blame…"
 * status rather than `.gh-blame-panel__content`. */
async function waitForBlameContent(panelEl: HTMLElement): Promise<HTMLElement> {
  return waitFor(() => {
    const content = panelEl.querySelector(".gh-blame-panel__content");
    if (!content) throw new Error("BlamePanel content region not found (still loading, or a non-content state?)");
    return content as HTMLElement;
  });
}

describe("specs/blame.md — real App + real git-core integration", () => {
  it(
    "AC1: Blame from an Unstaged ChangesPanel row shows every working-tree line, a locally-edited line attributed to 'Not Committed Yet'",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await commitFile(dir, "a.txt", "line one\nline two\nline three\n", "base");
      // Unstaged edit — never committed.
      await writeFile(dir, "a.txt", "line one\nline TWO EDITED\nline three\n");

      await openAppOn(dir);
      const changes = await openChangesPanel();
      const menu = await rightClickChangesFile(changes, "Unstaged", "a.txt");
      const blame = await chooseBlame(menu);

      const content = await waitForBlameContent(blame);
      expect(within(content).getByText("line one")).toBeInTheDocument();
      expect(within(content).getByText("line TWO EDITED")).toBeInTheDocument();
      expect(within(content).getByText("line three")).toBeInTheDocument();
      // FR-126/AC1: the locally-modified line is attributed to git's own literal string, not a
      // fabricated commit.
      expect(within(content).getByText("Not Committed Yet")).toBeInTheDocument();
    },
    30000,
  );

  it(
    "AC2: Blame from a DetailPanel changed-file row shows the file exactly as of that commit, never the working tree's current (further-edited) content",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      const firstSha = await commitFile(dir, "a.txt", "v1 line\n", "first commit");
      await commitFile(dir, "a.txt", "v2 line\n", "second commit");
      // Further uncommitted edit on top — historical blame must ignore this entirely.
      await writeFile(dir, "a.txt", "v3 UNCOMMITTED\n");

      await openAppOn(dir);
      await userEvent.click(await rowFor("first commit"));
      const detail = await screen.findByRole("complementary", { name: "Commit details" });
      await within(detail).findByRole("list");

      const menu = await rightClickDetailFile(detail, "a.txt");
      const blame = await chooseBlame(menu);

      expect(within(blame).getByText(new RegExp(`@ ${firstSha.slice(0, 10)}`))).toBeInTheDocument();
      const content = await waitForBlameContent(blame);
      expect(within(content).getByText("v1 line")).toBeInTheDocument();
      expect(within(content).queryByText("v2 line")).not.toBeInTheDocument();
      expect(within(content).queryByText("v3 UNCOMMITTED")).not.toBeInTheDocument();
    },
    30000,
  );

  it(
    "AC7: clicking a blamed block's commit metadata selects that commit and opens its DetailPanel, applying the SHA filter when the commit is hidden by the active filter",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      const firstSha = await commitFile(dir, "a.txt", "base\n", "base commit");
      await commitFile(dir, "a.txt", "base\nsecond\n", "second commit");

      await openAppOn(dir);

      // Apply a message filter that excludes "base commit" from the graph entirely.
      await userEvent.click(screen.getByRole("button", { name: /search.*filter/i }));
      const search = screen.getByRole("search", { name: /filter commit graph/i });
      await userEvent.type(within(search).getByLabelText("Message"), "second");
      await userEvent.click(within(search).getByRole("button", { name: /^search$/i }));

      await screen.findByText("second commit");
      await waitFor(() => expect(screen.queryByText("base commit")).not.toBeInTheDocument());

      await userEvent.click(await rowFor("second commit"));
      const detail = await screen.findByRole("complementary", { name: "Commit details" });
      await within(detail).findByRole("list");
      const menu = await rightClickDetailFile(detail, "a.txt");
      const blame = await chooseBlame(menu);

      const content = await waitForBlameContent(blame);
      await waitFor(() => expect(within(content).getByText("second")).toBeInTheDocument());
      const blockButton = within(content).getByRole("button", { name: /base commit/i });
      await userEvent.click(blockButton);

      // BlamePanel closes (FR-134).
      await waitFor(() => expect(screen.queryByRole("complementary", { name: "Blame" })).not.toBeInTheDocument());
      // The SHA filter was applied to reveal the otherwise-excluded commit.
      await waitFor(() => expect((within(search).getByLabelText("SHA") as HTMLInputElement).value).toBe(firstSha));
      // The commit is now visible, selected, and its DetailPanel is open.
      await waitFor(async () => expect(await rowFor("base commit")).toHaveAttribute("aria-selected", "true"));
      const reopenedDetail = await screen.findByRole("complementary", { name: "Commit details" });
      await waitFor(() => expect(within(reopenedDetail).getByText(/base commit/i)).toBeInTheDocument());
    },
    30000,
  );

  it(
    "AC8: selecting an earlier commit from File history re-blames the same open BlamePanel in place, without closing/reopening it",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await commitFile(dir, "a.txt", "v1\n", "first");
      const secondSha = await commitFile(dir, "a.txt", "v2\n", "second");

      await openAppOn(dir);
      await userEvent.click(await rowFor("second"));
      const detail = await screen.findByRole("complementary", { name: "Commit details" });
      await within(detail).findByRole("list");
      const menu = await rightClickDetailFile(detail, "a.txt");
      const blame = await chooseBlame(menu);

      const content = await waitForBlameContent(blame);
      await waitFor(() => expect(within(content).getByText("v2")).toBeInTheDocument());
      expect(within(blame).getByText(new RegExp(`@ ${secondSha.slice(0, 10)}`))).toBeInTheDocument();

      await userEvent.click(within(blame).getByRole("button", { name: /file history/i }));
      const historyList = await waitFor(() => {
        const list = blame.querySelector(".gh-blame-panel__history-list");
        if (!list) throw new Error("history list not rendered yet");
        return list as HTMLElement;
      });
      const historyRow = within(historyList).getByRole("button", { name: /^first/ });
      await userEvent.click(historyRow);

      // Still exactly one BlamePanel — re-blamed in place, not a second panel opened.
      expect(screen.getAllByRole("complementary", { name: "Blame" })).toHaveLength(1);
      const reblamedContent = await waitForBlameContent(blame);
      await waitFor(() => expect(within(reblamedContent).getByText("v1")).toBeInTheDocument());
      expect(within(reblamedContent).queryByText("v2")).not.toBeInTheDocument();
    },
    30000,
  );

  it(
    "AC9: Blame is disabled with an explicit reason on an Untracked row and a Conflicted row, and clicking it anyway opens no BlamePanel",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await commitFile(dir, "base.txt", "base\n", "base");

      // A real, unresolved merge conflict on a second file.
      await commitFile(dir, "a.txt", "base\n", "base a");
      await git(dir, ["checkout", "-q", "-b", "other"]);
      await commitFile(dir, "a.txt", "other change\n", "other change");
      await git(dir, ["checkout", "-q", "main"]);
      await commitFile(dir, "a.txt", "main change\n", "main change");
      await git(dir, ["merge", "other"]).catch(() => {}); // real, unresolved merge conflict.

      // Created LAST, after every `commitAll`'s own `git add -A` above — otherwise an earlier
      // commit would sweep it in and it would never be untracked by the time the app opens.
      await writeFile(dir, "new.txt", "never committed\n");

      await openAppOn(dir);
      const changes = await openChangesPanel();

      const untrackedMenu = await rightClickChangesFile(changes, "Untracked", "new.txt");
      const untrackedBlame = within(untrackedMenu).getByRole("menuitem", { name: "Blame" });
      expect(untrackedBlame).toBeDisabled();
      expect(untrackedBlame).toHaveAttribute("title", expect.stringMatching(/never committed/i));
      fireEvent.click(untrackedBlame); // disabled — must be a no-op regardless.
      expect(screen.queryByRole("complementary", { name: "Blame" })).not.toBeInTheDocument();
      await userEvent.keyboard("{Escape}");

      const conflictedMenu = await rightClickChangesFile(changes, "Conflicted", "a.txt");
      const conflictedBlame = within(conflictedMenu).getByRole("menuitem", { name: "Blame" });
      expect(conflictedBlame).toBeDisabled();
      expect(conflictedBlame).toHaveAttribute("title", expect.stringMatching(/resolve.*conflict/i));
      fireEvent.click(conflictedBlame); // disabled — must be a no-op regardless.
      expect(screen.queryByRole("complementary", { name: "Blame" })).not.toBeInTheDocument();
    },
    30000,
  );

  it(
    "AC10: opening BlamePanel, browsing file history, and re-blaming never changes HEAD, the index, or any working-tree file",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      const baseSha = await commitFile(dir, "a.txt", "v1\nv2\nv3\n", "base");
      await writeFile(dir, "a.txt", "v1\nEDITED\nv3\n"); // unstaged edit.

      await openAppOn(dir);
      const statusBefore = await statusPorcelain(dir);
      const headBefore = await headSha(dir);

      const changes = await openChangesPanel();
      const menu = await rightClickChangesFile(changes, "Unstaged", "a.txt");
      const blame = await chooseBlame(menu);
      const content = await waitForBlameContent(blame);
      await waitFor(() => expect(within(content).getByText("EDITED")).toBeInTheDocument());

      await userEvent.click(within(blame).getByRole("button", { name: /file history/i }));
      const historyList = await waitFor(() => {
        const list = blame.querySelector(".gh-blame-panel__history-list");
        if (!list) throw new Error("history list not rendered yet");
        return list as HTMLElement;
      });
      const historyRow = within(historyList).getByRole("button", { name: /^base/ });
      await userEvent.click(historyRow);
      const reblamedContent = await waitForBlameContent(blame);
      await waitFor(() => expect(within(reblamedContent).getByText("v2")).toBeInTheDocument());

      await userEvent.click(within(blame).getByRole("button", { name: /close blame panel/i }));
      await waitFor(() => expect(screen.queryByRole("complementary", { name: "Blame" })).not.toBeInTheDocument());

      const statusAfter = await statusPorcelain(dir);
      const headAfter = await headSha(dir);
      expect(statusAfter).toBe(statusBefore);
      expect(headAfter).toBe(headBefore);
      expect(headAfter).toBe(baseSha);
    },
    30000,
  );
});
