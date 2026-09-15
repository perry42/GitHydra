// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from "vitest";
import { configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { createRealGitHydraApi, type RealGitHydraHandle } from "./test/realGitHydraApi";
import { cleanup, commitAll, git, initRepo, makeTempDir, writeFile } from "./test/gitFixture";

// Real `git` child-process spawns underneath every `waitFor` — same rationale as
// `App.cherryPick.e2e.test.tsx`/`App.compareCommits.e2e.test.tsx` (RTL's default 1000ms timeout
// is too tight for that).
configure({ asyncUtilTimeout: 15000 });

/**
 * specs/drag-commit-menu.md — the acceptance-criteria sweep that needs the REAL running app, not a
 * mocked `window.gitHydra`: does dragging one commit node onto another actually produce correct
 * real `git` history (fast-forward vs. real merge commit, a real rebase replay, a real branch
 * switch, a real conflict), exactly like `App.cherryPick.e2e.test.tsx`/
 * `App.compareCommits.e2e.test.tsx` already do for their own entry points. Every test here renders
 * the REAL `<App/>` component tree against a REAL `GitHydraApi` backed by a REAL
 * `RepoSession`/`Repository` shelling out to a REAL `git` binary against a REAL temp repo on disk
 * (`./test/realGitHydraApi.ts`) — no git-core mocking anywhere in this file.
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

async function headSha(dir: string): Promise<string> {
  const { stdout } = await git(dir, ["rev-parse", "HEAD"]);
  return stdout.trim();
}

async function currentBranch(dir: string): Promise<string> {
  const { stdout } = await git(dir, ["branch", "--show-current"]);
  return stdout.trim();
}

async function parentShas(dir: string, rev = "HEAD"): Promise<string[]> {
  const { stdout } = await git(dir, ["rev-list", "--parents", "-1", rev]);
  return stdout.trim().split(/\s+/).slice(1);
}

const operationBannerText = () =>
  document.querySelector(".gh-status-banner--serious.gh-status-banner--operation")?.textContent ?? "";
const operationBannerVisible = () =>
  document.querySelector(".gh-status-banner--serious.gh-status-banner--operation") !== null;
async function waitForOperationBannerText(matcher: RegExp): Promise<void> {
  await waitFor(() => expect(operationBannerText()).toMatch(matcher));
}
async function waitForOperationBannerGone(): Promise<void> {
  await waitFor(() => expect(operationBannerVisible()).toBe(false));
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

/**
 * specs/drag-commit-menu.md FR-301: drags the row for `fromSubject` (the dragged commit, `{A}`)
 * onto the row for `toSubject` (the dropped-on commit, `{B}`) and returns the resulting drop menu.
 * `document.elementFromPoint` is unimplemented in jsdom — stubbed here to resolve to the target
 * row for the whole gesture, mirroring the real hit-testing `CommitGraph`'s drag handler performs
 * against actual layout in a real browser (see `CommitGraph.dragCommitMenu.test.tsx`'s identical
 * technique at the component-test level).
 */
async function dragRow(fromSubject: string, toSubject: string): Promise<HTMLElement> {
  const source = await rowFor(fromSubject);
  const target = await rowFor(toSubject);
  document.elementFromPoint = () => target;
  fireEvent.pointerDown(source, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 30, clientY: 30 });
  fireEvent.pointerUp(window, { pointerId: 1, clientX: 30, clientY: 30 });
  return screen.findByRole("menu", { name: /^dragged /i });
}

describe("specs/drag-commit-menu.md — real App + real git-core integration", () => {
  it(
    "AC6: Cherry-pick when {B} is already HEAD cherry-picks {A} directly, with no branch switch",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      const baseSha = await commitFile(dir, "a.txt", "base\n", "base commit");
      await git(dir, ["checkout", "-q", "-b", "feature"]);
      const featureSha = await commitFile(dir, "a.txt", "feature change\n", "feature commit");
      await git(dir, ["checkout", "-q", "main"]);
      expect(await headSha(dir)).toBe(baseSha);

      await openAppOn(dir);
      const menu = await dragRow("feature commit", "base commit");
      const item = within(menu).getByRole("menuitem", { name: /^cherry-pick/i });
      await waitFor(() => expect(item).not.toBeDisabled());
      await userEvent.click(item);

      await waitFor(async () => expect(await headSha(dir)).not.toBe(baseSha));
      expect(await currentBranch(dir)).toBe("main"); // never switched — {B} was already HEAD.
      const newHead = await headSha(dir);
      expect(newHead).not.toBe(featureSha); // a new commit, not a fast-forward.
      const sourceDiff = await git(dir, ["show", featureSha, "--format=", "--"]);
      const newDiff = await git(dir, ["show", newHead, "--format=", "--"]);
      expect(newDiff.stdout).toBe(sourceDiff.stdout);
    },
    60000,
  );

  it(
    "AC6: Cherry-pick when {B} isn't HEAD switches HEAD to {B}'s branch first, then cherry-picks {A} — both reflected with no restart",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await commitFile(dir, "a.txt", "base\n", "base commit");
      await git(dir, ["checkout", "-q", "-b", "feature"]);
      const featureSha = await commitFile(dir, "feature.txt", "feature content\n", "feature commit");
      await git(dir, ["checkout", "-q", "main"]);
      await git(dir, ["checkout", "-q", "-b", "other"]);
      const otherSha = await commitFile(dir, "other.txt", "other content\n", "other tip");
      await git(dir, ["checkout", "-q", "main"]); // HEAD starts on main — neither feature nor other.
      expect(await currentBranch(dir)).toBe("main");

      await openAppOn(dir);
      const menu = await dragRow("feature commit", "other tip");
      const item = within(menu).getByRole("menuitem", { name: /^cherry-pick/i });
      await waitFor(() => expect(item).not.toBeDisabled());
      await userEvent.click(item);

      await waitFor(async () => expect(await currentBranch(dir)).toBe("other"));
      // The branch switch alone doesn't create a new commit — wait for the cherry-pick itself
      // (a second, separate async step after the checkout) to actually land a new commit too.
      await waitFor(async () => expect(await headSha(dir)).not.toBe(otherSha));
      const newHead = await headSha(dir);
      const sourceDiff = await git(dir, ["show", featureSha, "--format=", "--"]);
      const newDiff = await git(dir, ["show", newHead, "--format=", "--"]);
      expect(newDiff.stdout).toBe(sourceDiff.stdout);
      // FR-314: the Toolbar's branch indicator reflects the switch too, with no app restart.
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /current branch other/i })).toBeInTheDocument(),
      );
    },
    60000,
  );

  it(
    "AC7: Merge when {B} is an ancestor of {A} fast-forwards with no merge commit created",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      const baseSha = await commitFile(dir, "a.txt", "base\n", "base commit");
      await git(dir, ["checkout", "-q", "-b", "feature"]);
      const featureSha = await commitFile(dir, "a.txt", "feature change\n", "feature commit");
      await git(dir, ["checkout", "-q", "main"]);
      expect(await headSha(dir)).toBe(baseSha);

      await openAppOn(dir);
      const menu = await dragRow("feature commit", "base commit");
      const item = within(menu).getByRole("menuitem", { name: /^merge/i });
      await waitFor(() => expect(item).not.toBeDisabled());
      await userEvent.click(item);

      await waitFor(async () => expect(await headSha(dir)).toBe(featureSha));
      expect(await parentShas(dir)).toEqual([baseSha]); // one parent — no merge commit.
    },
    60000,
  );

  it(
    "AC7: Merge on a diverged pair creates a real merge commit with both parents",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await commitFile(dir, "a.txt", "base\n", "base commit");
      await git(dir, ["checkout", "-q", "-b", "left"]);
      const leftSha = await commitFile(dir, "left.txt", "left content\n", "left tip");
      await git(dir, ["checkout", "-q", "main"]);
      const mainSha = await commitFile(dir, "main.txt", "main content\n", "main tip");
      expect(await headSha(dir)).toBe(mainSha);

      await openAppOn(dir);
      const menu = await dragRow("left tip", "main tip");
      const item = within(menu).getByRole("menuitem", { name: /^merge/i });
      await waitFor(() => expect(item).not.toBeDisabled());
      await userEvent.click(item);

      await waitFor(async () => expect(await parentShas(dir)).toHaveLength(2));
      const parents = await parentShas(dir);
      expect(parents).toContain(mainSha);
      expect(parents).toContain(leftSha);
    },
    60000,
  );

  it(
    "AC8: Rebase on a diverged pair replays {B}'s unique commit onto {A}, content preserved, switching to {B}'s branch first",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await commitFile(dir, "a.txt", "base\n", "base commit");
      await git(dir, ["checkout", "-q", "-b", "topic"]);
      const topicSha = await commitFile(dir, "topic.txt", "topic content\n", "topic tip");
      await git(dir, ["checkout", "-q", "main"]);
      const mainSha = await commitFile(dir, "main.txt", "main content\n", "main tip");
      expect(await currentBranch(dir)).toBe("main");

      await openAppOn(dir);
      // {A} = "main tip" (dragged), {B} = "topic tip" (dropped-on) — "Rebase topic tip onto main tip".
      const menu = await dragRow("main tip", "topic tip");
      const item = within(menu).getByRole("menuitem", { name: /^rebase/i });
      await waitFor(() => expect(item).not.toBeDisabled());
      await userEvent.click(item);

      await waitFor(async () => expect(await currentBranch(dir)).toBe("topic"));
      await waitFor(async () => expect(await parentShas(dir)).toEqual([mainSha]));
      const newHead = await headSha(dir);
      expect(newHead).not.toBe(topicSha); // replayed onto a new base — a different commit object.
      const sourceDiff = await git(dir, ["show", topicSha, "--format=", "--"]);
      const newDiff = await git(dir, ["show", newHead, "--format=", "--"]);
      expect(newDiff.stdout).toBe(sourceDiff.stdout);
    },
    60000,
  );

  it(
    "AC9: a refused checkout (uncommitted changes that would be overwritten) surfaces inline; no merge/cherry-pick/rebase is attempted, HEAD/working tree/index unchanged",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await commitFile(dir, "a.txt", "base\n", "base commit");
      await git(dir, ["checkout", "-q", "-b", "left"]);
      await commitFile(dir, "a.txt", "left content\n", "left tip");
      await git(dir, ["checkout", "-q", "main"]);
      await git(dir, ["checkout", "-q", "-b", "right"]);
      await commitFile(dir, "a.txt", "right content\n", "right tip");
      await git(dir, ["checkout", "-q", "left"]);
      const preHead = await headSha(dir);
      // An uncommitted change to a.txt that switching to "right" would overwrite.
      await writeFile(dir, "a.txt", "dirty uncommitted content\n");

      await openAppOn(dir);
      // Cherry-pick (always enabled regardless of ancestry, FR-307) exercises the identical
      // FR-309 checkout-if-needed precondition Merge/Rebase share, without needing "right tip" to
      // sit in a specific ancestry relationship relative to "left tip" for the item to be enabled.
      const menu = await dragRow("base commit", "right tip");
      const item = within(menu).getByRole("menuitem", { name: /^cherry-pick/i });
      await waitFor(() => expect(item).not.toBeDisabled());
      await userEvent.click(item);

      await screen.findByText(/would be overwritten|overwritten by checkout|overwritten by merge/i);
      expect(await headSha(dir)).toBe(preHead);
      expect(await currentBranch(dir)).toBe("left");
      const status = await git(dir, ["status", "--porcelain"]);
      expect(status.stdout).toMatch(/a\.txt/); // the uncommitted edit is still there, untouched.
    },
    60000,
  );

  it(
    "AC10: a conflicting Merge started from this menu shows the same StatusBanner/ConflictResolutionView a terminal-started conflict would; Abort restores the pre-merge HEAD",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await commitFile(dir, "a.txt", "line1\nline2\nline3\n", "base commit");
      await git(dir, ["checkout", "-q", "-b", "other"]);
      await commitFile(dir, "a.txt", "other change\nline2\nline3\n", "other tip");
      await git(dir, ["checkout", "-q", "main"]);
      const mainSha = await commitFile(dir, "a.txt", "main change\nline2\nline3\n", "main tip");

      await openAppOn(dir);
      const menu = await dragRow("other tip", "main tip");
      const item = within(menu).getByRole("menuitem", { name: /^merge/i });
      await waitFor(() => expect(item).not.toBeDisabled());
      await userEvent.click(item);

      await waitForOperationBannerText(/merging/i);

      await userEvent.click(await screen.findByRole("button", { name: /^changes/i }));
      const changesPanel = await screen.findByRole("complementary", { name: /changes/i });
      await waitFor(() => expect(within(changesPanel).getByText("a.txt")).toBeInTheDocument());
      await userEvent.click(within(changesPanel).getByText("a.txt"));
      await screen.findByRole("region", { name: /resolve conflict in a\.txt/i });

      await userEvent.click(await screen.findByRole("button", { name: /^abort$/i }));
      const confirmDialog = await screen.findByRole("alertdialog");
      await userEvent.click(within(confirmDialog).getByRole("button", { name: /^abort$/i }));

      await waitForOperationBannerGone();
      expect(await headSha(dir)).toBe(mainSha);
    },
    60000,
  );

  it(
    "AC10: a conflicting Rebase started from this menu shows the same StatusBanner/ConflictResolutionView a terminal-started conflict would; Continue (not just Abort) completes it into a real replayed commit",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await commitFile(dir, "a.txt", "line1\nline2\nline3\n", "base commit");
      await git(dir, ["checkout", "-q", "-b", "topic"]);
      await commitFile(dir, "a.txt", "topic change\nline2\nline3\n", "topic tip");
      await git(dir, ["checkout", "-q", "main"]);
      const mainSha = await commitFile(dir, "a.txt", "main change\nline2\nline3\n", "main tip");

      await openAppOn(dir);
      // {A} = "main tip" (dragged), {B} = "topic tip" (dropped-on) — checks out topic, then
      // rebases topic onto main tip; both commits touch the same line, so this pauses on conflict.
      const menu = await dragRow("main tip", "topic tip");
      const item = within(menu).getByRole("menuitem", { name: /^rebase/i });
      await waitFor(() => expect(item).not.toBeDisabled());
      await userEvent.click(item);

      await waitFor(async () => expect(await currentBranch(dir)).toBe("topic"));
      await waitForOperationBannerText(/rebas/i);

      await userEvent.click(await screen.findByRole("button", { name: /^changes/i }));
      const changesPanel = await screen.findByRole("complementary", { name: /changes/i });
      await waitFor(() => expect(within(changesPanel).getByText("a.txt")).toBeInTheDocument());
      await userEvent.click(within(changesPanel).getByText("a.txt"));
      const conflictView = await screen.findByRole("region", { name: /resolve conflict in a\.txt/i });

      // Keep the replayed commit's own content (rebase's "theirs" = the original commit being
      // replayed, labeled "Your branch" — see conflicts.ts's inverted ours/theirs mapping for
      // rebase) so the result is a real, non-empty diff against the new base, not a no-op the
      // sequencer would instead treat as FR-118's empty-result pause.
      await userEvent.click(
        await within(conflictView).findByRole("button", { name: /accept your branch/i }),
      );
      await waitFor(() => expect(within(conflictView).getByText(/this file is resolved/i)).toBeInTheDocument());

      const continueButton = await screen.findByRole("button", { name: /^continue$/i });
      await waitFor(() => expect(continueButton).not.toBeDisabled());
      await userEvent.click(continueButton);

      await waitForOperationBannerGone();
      await waitFor(async () => expect(await currentBranch(dir)).toBe("topic"));
      const newHead = await headSha(dir);
      await waitFor(async () => expect(await parentShas(dir)).toEqual([mainSha]));
      expect((await git(dir, ["show", `${newHead}:a.txt`])).stdout).toBe("topic change\nline2\nline3\n");
      expect((await git(dir, ["log", "-1", "--format=%s", newHead])).stdout.trim()).toBe("topic tip");
    },
    60000,
  );

  it(
    "FR-317/AC12: every disabled item shows its specific reason via a tooltip — verified for a bare repo's Merge/Rebase/Cherry-pick",
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

      const menu = await dragRow("commit one", "commit two");
      const compareItem = within(menu).getByRole("menuitem", { name: /^compare/i });
      const cherryPickItem = within(menu).getByRole("menuitem", { name: /^cherry-pick/i });
      const mergeItem = within(menu).getByRole("menuitem", { name: /^merge/i });
      const rebaseItem = within(menu).getByRole("menuitem", { name: /^rebase/i });
      // Merge/Rebase are disabled throughout (including the brief "Computing…" state, AC1) — wait
      // for the ancestry read to actually SETTLE (title moves off "Computing…") before asserting
      // the real bare-repo reason, rather than a disabled-state check that's already true either way.
      await waitFor(() => expect(mergeItem).not.toHaveAttribute("title", "Computing…"));

      expect(compareItem).not.toBeDisabled();
      expect(cherryPickItem).toBeDisabled();
      expect(cherryPickItem).toHaveAttribute("title", expect.stringMatching(/bare repository/i));
      expect(mergeItem).toHaveAttribute("title", expect.stringMatching(/bare repository/i));
      expect(rebaseItem).toBeDisabled();
      expect(rebaseItem).toHaveAttribute("title", expect.stringMatching(/bare repository/i));
    },
    30000,
  );
});
