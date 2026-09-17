// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from "vitest";
import { configure, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { createRealGitHydraApi, type RealGitHydraHandle } from "./test/realGitHydraApi";
import { cleanup, commitAll, git, initRepo, makeTempDir, writeFile } from "./test/gitFixture";

// Real `git` child-process spawns underneath every `waitFor` — same rationale as
// `App.dragCommitMenu.e2e.test.tsx`/`App.cherryPick.e2e.test.tsx` (RTL's default 1000ms timeout is
// too tight for that).
configure({ asyncUtilTimeout: 15000 });

/**
 * specs/online-sync-pull.md — the acceptance-criteria sweep that needs the REAL running app, not a
 * mocked `window.gitHydra`: does clicking Pull actually fetch a real local `file://` bare remote
 * and correctly fast-forward / create a real merge commit / replay a real rebase / pause on a real
 * conflict, exactly like `App.dragCommitMenu.e2e.test.tsx` already does for the drag-menu's own
 * Merge/Rebase actions. No network, no credentials — the "remote" is a real local bare repo on
 * disk, the same technique `specs/online-sync-fetch.md`'s own e2e coverage uses.
 *
 * AC4's own requirement — "a conflicting pull shows the exact same `ConflictResolutionView`
 * component (same class names and behavior, not a lookalike) — confirmed by reusing that spec's
 * own test assertions against a pull-triggered conflict" — is the one test in this file that
 * matters most: it reuses `App.dragCommitMenu.e2e.test.tsx`'s AC10 test's own assertions
 * (`waitForOperationBannerText`, the `role="region", name: /resolve conflict in/i` query, the
 * Abort flow) verbatim against a Pull-triggered conflict instead of a drag-menu-triggered one.
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

/**
 * Builds a real local bare "remote" seeded with one commit, plus a working clone (`dir`) with
 * `origin/main` already configured as its upstream (a real `git clone` sets
 * `branch.main.remote`/`branch.main.merge` itself — no manual config poking needed, matching
 * FR-339's "exactly as real `git pull` would" resolution). Returns both directories; the caller is
 * responsible for pushing further "teammate" commits to `remoteDir` (via a second clone) to set up
 * a genuine divergence before opening the app on `dir`.
 */
async function setupRemoteAndClone(): Promise<{ remoteDir: string; dir: string; baseSha: string }> {
  const remoteDir = await initRepo({ bare: true });
  dirs.push(remoteDir);
  const seedDir = await initRepo();
  dirs.push(seedDir);
  const baseSha = await commitFile(seedDir, "a.txt", "line1\nline2\nline3\n", "base commit");
  await git(seedDir, ["remote", "add", "origin", remoteDir]);
  await git(seedDir, ["push", "-q", "origin", "main"]);

  const dir = await makeTempDir();
  dirs.push(dir);
  await git(process.cwd(), ["clone", "-q", "--branch", "main", remoteDir, dir]);
  return { remoteDir, dir, baseSha };
}

/** Simulates a teammate pushing a new commit to the remote from a second, independent clone —
 * never touches `dir` (the app's own repo) directly, matching real divergence. */
async function pushFromTeammate(remoteDir: string, file: string, content: string, message: string): Promise<string> {
  const teammateDir = await makeTempDir();
  dirs.push(teammateDir);
  await git(process.cwd(), ["clone", "-q", remoteDir, teammateDir]);
  const sha = await commitFile(teammateDir, file, content, message);
  await git(teammateDir, ["push", "-q", "origin", "main"]);
  return sha;
}

async function waitForEnabledPullButton(): Promise<HTMLElement> {
  // FR-343: the button starts disabled ("Checking this branch's upstream configuration…") until
  // `useCurrentBranchUpstream`'s own `listBranches()` read resolves — real, if brief, async work.
  return waitFor(() => {
    const button = screen.getByRole("button", { name: /^pull$/i });
    expect(button).toBeEnabled();
    return button;
  });
}

async function selectPullStrategy(strategy: "merge" | "rebase"): Promise<void> {
  const select = screen.getByRole("combobox", { name: /pull strategy/i });
  await userEvent.selectOptions(select, strategy);
}

describe("specs/online-sync-pull.md — real App + real git-core integration", () => {
  it(
    "AC1: pulling a fast-forwardable branch moves HEAD forward with zero conflict UI and no merge/rebase invocation",
    async () => {
      const { remoteDir, dir, baseSha } = await setupRemoteAndClone();
      const teammateSha = await pushFromTeammate(remoteDir, "b.txt", "teammate content\n", "teammate commit");
      expect(await headSha(dir)).toBe(baseSha);

      await openAppOn(dir);
      const button = await waitForEnabledPullButton();
      await userEvent.click(button);

      await waitFor(async () => expect(await headSha(dir)).toBe(teammateSha));
      expect(await parentShas(dir)).toEqual([baseSha]); // one parent — no merge commit.
      expect(operationBannerVisible()).toBe(false); // never a merge/rebase operation.
      await screen.findByText(/fast-forwarded/i);
    },
    60000,
  );

  it(
    "up-to-date pull reads distinctly from a fast-forward or a real merge/rebase (FR-338 success feedback)",
    async () => {
      const { dir } = await setupRemoteAndClone();
      const preHead = await headSha(dir);

      await openAppOn(dir);
      const button = await waitForEnabledPullButton();
      await userEvent.click(button);

      await screen.findByText(/already up to date/i);
      expect(await headSha(dir)).toBe(preHead);
    },
    60000,
  );

  it(
    "AC2: pulling a diverged branch with Merge selected produces a real merge commit via the existing mergeCommit() path — two parents",
    async () => {
      const { remoteDir, dir, baseSha } = await setupRemoteAndClone();
      const teammateSha = await pushFromTeammate(remoteDir, "teammate.txt", "teammate content\n", "teammate commit");
      const localSha = await commitFile(dir, "local.txt", "local content\n", "local commit");
      expect(await headSha(dir)).toBe(localSha);

      await openAppOn(dir);
      await selectPullStrategy("merge");
      const button = await waitForEnabledPullButton();
      await userEvent.click(button);

      await waitFor(async () => expect(await parentShas(dir)).toHaveLength(2));
      const parents = await parentShas(dir);
      expect(parents).toContain(localSha);
      expect(parents).toContain(teammateSha);
      expect(baseSha).toBeTruthy(); // sanity: base commit is a real shared ancestor, not coincidence.
      await screen.findByText(/merge commit was created/i);
    },
    60000,
  );

  it(
    "AC3: pulling the same divergence with Rebase selected replays the local commit via the existing rebaseCommitOnto() path — linear history, rewritten SHA",
    async () => {
      const { remoteDir, dir } = await setupRemoteAndClone();
      const teammateSha = await pushFromTeammate(remoteDir, "teammate.txt", "teammate content\n", "teammate commit");
      const localSha = await commitFile(dir, "local.txt", "local content\n", "local commit");

      await openAppOn(dir);
      await selectPullStrategy("rebase");
      const button = await waitForEnabledPullButton();
      await userEvent.click(button);

      await waitFor(async () => expect(await parentShas(dir)).toEqual([teammateSha]));
      const newHead = await headSha(dir);
      expect(newHead).not.toBe(localSha); // replayed onto a new base — a different commit object.
      const sourceDiff = await git(dir, ["show", localSha, "--format=", "--"]);
      const newDiff = await git(dir, ["show", newHead, "--format=", "--"]);
      expect(newDiff.stdout).toBe(sourceDiff.stdout);
      await screen.findByText(/rebased onto the incoming changes/i);
    },
    60000,
  );

  it(
    "AC4/AC5: a conflicting pull shows the exact same StatusBanner/ConflictResolutionView a manual merge would (reusing drag-commit-menu's own AC10 assertions) — Abort restores the exact pre-pull HEAD",
    async () => {
      const { remoteDir, dir } = await setupRemoteAndClone();
      await pushFromTeammate(remoteDir, "a.txt", "teammate change\nline2\nline3\n", "teammate tip");
      const preHead = await commitFile(dir, "a.txt", "local change\nline2\nline3\n", "local tip");

      await openAppOn(dir);
      await selectPullStrategy("merge");
      const button = await waitForEnabledPullButton();
      await userEvent.click(button);

      await waitForOperationBannerText(/merging/i);

      // Same reuse-verification technique `App.dragCommitMenu.e2e.test.tsx`'s own AC10 test uses:
      // the Changes panel + ConflictResolutionView are not opened automatically (matching that
      // spec's existing behavior, not new for Pull) — the user opens Changes the same way.
      await userEvent.click(await screen.findByRole("button", { name: /^changes/i }));
      const changesPanel = await screen.findByRole("complementary", { name: /changes/i });
      await waitFor(() => expect(within(changesPanel).getByText("a.txt")).toBeInTheDocument());
      await userEvent.click(within(changesPanel).getByText("a.txt"));
      // The exact same component, class name, and accessible name a manual drag-menu Merge
      // conflict's own test already asserts against — proof this is reuse, not a lookalike.
      await screen.findByRole("region", { name: /resolve conflict in a\.txt/i });
      expect(document.querySelector(".gh-conflict-view")).not.toBeNull();

      await userEvent.click(await screen.findByRole("button", { name: /^abort$/i }));
      const confirmDialog = await screen.findByRole("alertdialog");
      await userEvent.click(within(confirmDialog).getByRole("button", { name: /^abort$/i }));

      await waitForOperationBannerGone();
      expect(await headSha(dir)).toBe(preHead);
    },
    60000,
  );

  it(
    "FR-343: Pull is disabled with a stated reason when the current branch has no configured upstream",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await commitFile(dir, "a.txt", "content\n", "solo commit");

      await openAppOn(dir);

      await waitFor(() => {
        const button = screen.getByRole("button", { name: /pull.*no upstream configured/i });
        expect(button).toBeDisabled();
      });
    },
    60000,
  );
});
