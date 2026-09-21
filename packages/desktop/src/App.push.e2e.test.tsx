// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from "vitest";
import { configure, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { createRealGitHydraApi, type RealGitHydraHandle } from "./test/realGitHydraApi";
import { cleanup, commitAll, git, initRepo, makeTempDir, writeFile } from "./test/gitFixture";

// Real `git` child-process spawns underneath every `waitFor` — same rationale as
// `App.pull.e2e.test.tsx`/`App.dragCommitMenu.e2e.test.tsx` (RTL's default 1000ms timeout is too
// tight for that).
configure({ asyncUtilTimeout: 15000 });

/**
 * specs/online-sync-push.md — the acceptance-criteria sweep that needs the REAL running app, not a
 * mocked `window.gitHydra`: does clicking Push actually push a real local branch to a real local
 * bare "remote," correctly publish a brand-new branch via `--set-upstream`, get rejected with the
 * exact FR-346 message on a genuine non-fast-forward, and show FR-347's pre-attempt warning —
 * exactly like `App.pull.e2e.test.tsx` already does for Pull. No network, no credentials — the
 * "remote" is a real local bare repo on disk, the same technique `specs/online-sync-fetch.md`'s own
 * e2e coverage uses.
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

/** Builds a real local bare "remote" seeded with one commit, plus a working clone (`dir`) with
 * `origin/main` already configured as its upstream — same shape `App.pull.e2e.test.tsx`'s own
 * `setupRemoteAndClone` establishes. */
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

async function waitForEnabledPushButton(): Promise<HTMLElement> {
  // toolbar-action-row redesign: Push's accessible name now folds in an ahead-commit count (and a
  // freshness caveat) whenever `usePushTarget`'s own `ahead` read is non-zero — genuinely true in
  // several of this file's own setups (a real local commit made before the app ever opens). Match
  // on the name's start only, rather than requiring it stay exactly "Push".
  return waitFor(() => {
    const button = screen.getByRole("button", { name: /^push($| —)/i });
    expect(button).toBeEnabled();
    return button;
  });
}

describe("specs/online-sync-push.md — real App + real git-core integration", () => {
  it(
    "AC1: pushing a fast-forwardable local branch updates the remote's real ref and the local remote-tracking ref",
    async () => {
      const { remoteDir, dir, baseSha } = await setupRemoteAndClone();
      const newSha = await commitFile(dir, "b.txt", "local work\n", "local commit");

      await openAppOn(dir);
      const button = await waitForEnabledPushButton();
      await userEvent.click(button);

      await waitFor(async () => {
        const { stdout } = await git(remoteDir, ["rev-parse", "main"]);
        expect(stdout.trim()).toBe(newSha);
      });
      // The local remote-tracking ref's own update is a separate (near-instant, but not
      // necessarily simultaneous) step of the same `git push` invocation — poll it too rather than
      // assuming it's already landed the instant the remote's own ref is visible.
      await waitFor(async () => {
        const { stdout } = await git(dir, ["rev-parse", "origin/main"]);
        expect(stdout.trim()).toBe(newSha);
      });
      expect(baseSha).not.toBe(newSha); // sanity: a real new commit was actually pushed.
      await screen.findByText(/pushed "main" to origin\/main/i);
    },
    60000,
  );

  it(
    "AC2: pushing a brand-new local branch with no upstream publishes it via --set-upstream; ahead/behind then computes correctly",
    async () => {
      const { remoteDir, dir } = await setupRemoteAndClone();
      await git(dir, ["checkout", "-q", "-b", "feature"]);
      const sha = await commitFile(dir, "feature.txt", "new work\n", "feature work");

      await openAppOn(dir);
      const button = await waitForEnabledPushButton();
      await userEvent.click(button);

      await waitFor(async () => {
        const { stdout } = await git(remoteDir, ["rev-parse", "feature"]);
        expect(stdout.trim()).toBe(sha);
      });
      // Same "the local side effect isn't necessarily visible the exact instant the remote's own
      // ref is" reasoning AC1 already documents — `--set-upstream`'s local config write is a
      // separate step of the same `git push` invocation.
      await waitFor(async () => {
        const { stdout } = await git(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "feature@{u}"]);
        expect(stdout.trim()).toBe("origin/feature");
      });
      await screen.findByText(/published "feature".*set it as the upstream/i);
    },
    60000,
  );

  it(
    "AC3: a diverged remote rejects the push with the specific 'pull first' message, and the remote's ref is unchanged — never a generic error, never a force option",
    async () => {
      const { remoteDir, dir } = await setupRemoteAndClone();
      const teammateSha = await pushFromTeammate(remoteDir, "a.txt", "teammate change\nline2\nline3\n", "teammate tip");
      await commitFile(dir, "a.txt", "my own local change\nline2\nline3\n", "local tip");

      await openAppOn(dir);
      const button = await waitForEnabledPushButton();
      await userEvent.click(button);

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(/pull first/i);
      expect(screen.queryByRole("button", { name: /force/i })).not.toBeInTheDocument();

      const { stdout: remoteTip } = await git(remoteDir, ["rev-parse", "main"]);
      expect(remoteTip.trim()).toBe(teammateSha); // unchanged by the rejected attempt.
    },
    60000,
  );

  it(
    "FR-347: pushing while behind shows the pre-attempt warning before any push call is made; confirming it then pushes anyway",
    async () => {
      const { remoteDir, dir } = await setupRemoteAndClone();
      const teammateSha = await pushFromTeammate(remoteDir, "b.txt", "teammate content\n", "teammate commit");
      // FR-347's warning is computed from the LOCAL remote-tracking ref's last-known state (the
      // same "never live, last-known" convention this app's ahead/behind data always uses) — a real
      // `git fetch` is what makes that local state actually reflect the teammate's push.
      await git(dir, ["fetch", "-q", "origin"]);

      await openAppOn(dir);
      const button = await waitForEnabledPushButton();
      await userEvent.click(button);

      const dialog = await screen.findByRole("alertdialog", { name: /your branch is behind/i });
      expect(dialog).toHaveTextContent(/1 commit behind/i);
      // Confirming pushes anyway — git will reject it (a genuine non-fast-forward), proving no push
      // was silently made before this confirmation and the remote is genuinely still what the
      // teammate left it as.
      await userEvent.click(screen.getByRole("button", { name: /push anyway/i }));

      await screen.findByRole("alert");
      const { stdout: remoteTip } = await git(remoteDir, ["rev-parse", "main"]);
      expect(remoteTip.trim()).toBe(teammateSha);
    },
    60000,
  );

  it(
    "FR-347: cancelling the pre-attempt warning makes no push call — the remote is completely untouched",
    async () => {
      const { remoteDir, dir } = await setupRemoteAndClone();
      const teammateSha = await pushFromTeammate(remoteDir, "b.txt", "teammate content\n", "teammate commit");
      await git(dir, ["fetch", "-q", "origin"]);

      await openAppOn(dir);
      const button = await waitForEnabledPushButton();
      await userEvent.click(button);

      await screen.findByRole("alertdialog", { name: /your branch is behind/i });
      await userEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      const { stdout: remoteTip } = await git(remoteDir, ["rev-parse", "main"]);
      expect(remoteTip.trim()).toBe(teammateSha);
    },
    60000,
  );

  it(
    "FR-349: Push is disabled with a stated reason on a bare repository",
    async () => {
      const bareDir = await initRepo({ bare: true });
      dirs.push(bareDir);

      await openAppOn(bareDir);

      await waitFor(() => {
        const button = screen.getByRole("button", { name: /push.*bare repository/i });
        expect(button).toBeDisabled();
      });
    },
    60000,
  );

  it(
    "FR-349: Push is disabled with a stated reason on an unborn HEAD (zero commits)",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);

      await openAppOn(dir);

      await waitFor(() => {
        const button = screen.getByRole("button", { name: /push.*no commits yet/i });
        expect(button).toBeDisabled();
      });
    },
    60000,
  );

  it(
    "FR-345: a multi-remote repo shows the remote picker, defaults to the already-tracked remote, and pushes to whichever remote is actually selected",
    async () => {
      const { remoteDir, dir } = await setupRemoteAndClone();
      const otherRemoteDir = await initRepo({ bare: true });
      dirs.push(otherRemoteDir);
      await git(dir, ["remote", "add", "fork", otherRemoteDir]);
      const sha = await commitFile(dir, "b.txt", "local work\n", "local commit");

      await openAppOn(dir);
      await waitForEnabledPushButton();

      // toolbar-action-row redesign: the native <select> remote picker is now a caret-fused menu.
      const caret = await screen.findByRole("button", { name: /push remote options/i });
      await userEvent.click(caret);
      const menu = await screen.findByRole("menu", { name: /push to/i });
      // Defaults to the already-tracked remote, not just "first".
      expect(within(menu).getByRole("menuitemradio", { name: "origin" })).toHaveAttribute("aria-checked", "true");
      await userEvent.click(within(menu).getByRole("menuitemradio", { name: "fork" }));

      await userEvent.click(screen.getByRole("button", { name: /^push($| —)/i }));

      await waitFor(async () => {
        const { stdout } = await git(otherRemoteDir, ["rev-parse", "main"]);
        expect(stdout.trim()).toBe(sha);
      });
      // The originally-tracked remote is untouched — the push went only to the selected one.
      const { stdout: originTip } = await git(remoteDir, ["rev-parse", "main"]);
      expect(originTip.trim()).not.toBe(sha);
    },
    60000,
  );
});
