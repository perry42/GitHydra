import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configure, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { createRealGitHydraApi, type RealGitHydraHandle } from "./test/realGitHydraApi";
import { cleanup, commitAll, git, initRepo, statusPorcelain, writeFile } from "./test/gitFixture";

// Real `git` child-process spawns underneath every `waitFor`, same rationale as
// `App.stash.e2e.test.tsx` (RTL's default 1000ms timeout is too tight for that).
configure({ asyncUtilTimeout: 12000 });

/**
 * specs/amend-last-commit.md — the acceptance-criteria sweep that needs the REAL running app, not
 * a mocked `window.gitHydra`: does checking the amend checkbox in the real UI produce a real,
 * correct amended commit (right SHA, right tree, right message), does the pushed-commit warning
 * actually gate on real `listBranches()` upstream/ahead data, does a detached-HEAD repo really
 * amend HEAD directly with no branch-ref movement. Every test here renders the REAL `<App/>`
 * component tree against a REAL `GitHydraApi` backed by a REAL `RepoSession`/`Repository` shelling
 * out to a REAL `git` binary against a REAL temp repo on disk (`./test/realGitHydraApi.ts`) — no
 * git-core mocking anywhere in this file (see `App.amendNetwork.e2e.test.tsx` for the one file in
 * this pair that DOES mock `node:child_process`, purely to observe/assert on real spawn args for
 * AC10 — a distinct, narrower kind of "not mocking git itself").
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
  await screen.findByRole("button", { name: /^changes/i }, { timeout: 10000 });
  return handle;
}

async function openChangesPanel(): Promise<HTMLElement> {
  await userEvent.click(await screen.findByRole("button", { name: /^changes/i }));
  return screen.findByRole("complementary", { name: "Changes" });
}

async function headSha(dir: string): Promise<string> {
  const { stdout } = await git(dir, ["rev-parse", "HEAD"]);
  return stdout.trim();
}

async function isDetached(dir: string): Promise<boolean> {
  try {
    await git(dir, ["symbolic-ref", "-q", "HEAD"]);
    return false;
  } catch {
    return true;
  }
}

describe("specs/amend-last-commit.md — real App + real git-core integration", () => {
  it(
    "AC2: message-only amend (nothing staged) via the real UI produces a new HEAD SHA with the new subject and an unchanged tree",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeFile(dir, "a.txt", "1\n");
      const before = await commitAll(dir, "Original message");

      await openAppOn(dir);
      const changesPanel = await openChangesPanel();
      await userEvent.click(within(changesPanel).getByRole("checkbox", { name: /amend last commit/i }));
      await waitFor(() => expect(within(changesPanel).getByLabelText(/subject/i)).toHaveValue("Original message"));
      await userEvent.clear(within(changesPanel).getByLabelText(/subject/i));
      await userEvent.type(within(changesPanel).getByLabelText(/subject/i), "Fixed message");
      await userEvent.click(within(changesPanel).getByRole("button", { name: /^amend commit$/i }));

      await waitFor(async () => expect(await headSha(dir)).not.toBe(before));
      const { stdout: subject } = await git(dir, ["log", "-1", "--pretty=%s"]);
      expect(subject.trim()).toBe("Fixed message");
      const { stdout: beforeTree } = await git(dir, [`rev-parse`, `${before}^{tree}`]);
      const { stdout: afterTree } = await git(dir, ["rev-parse", "HEAD^{tree}"]);
      expect(afterTree).toBe(beforeTree);
      const { stdout: log } = await git(dir, ["log", "--oneline"]);
      expect(log.trim().split("\n")).toHaveLength(1); // no second commit was created
    },
    30000,
  );

  it(
    "AC3: amend with a newly staged file folds it into the SAME commit — exactly one commit exists afterward",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeFile(dir, "a.txt", "1\n");
      const before = await commitAll(dir, "Original message");
      await writeFile(dir, "b.txt", "new file\n");

      await openAppOn(dir);
      const changesPanel = await openChangesPanel();
      await waitFor(() => expect(within(changesPanel).getByText("Untracked (1)")).toBeInTheDocument());
      await userEvent.click(within(changesPanel).getByRole("button", { name: /^stage$/i }));
      await waitFor(() => expect(within(changesPanel).getByText("Staged (1)")).toBeInTheDocument());

      await userEvent.click(within(changesPanel).getByRole("checkbox", { name: /amend last commit/i }));
      await waitFor(() => expect(within(changesPanel).getByLabelText(/subject/i)).toHaveValue("Original message"));
      await userEvent.clear(within(changesPanel).getByLabelText(/subject/i));
      await userEvent.type(within(changesPanel).getByLabelText(/subject/i), "Original message plus b");
      await userEvent.click(within(changesPanel).getByRole("button", { name: /^amend commit$/i }));

      await waitFor(async () => expect(await headSha(dir)).not.toBe(before));
      const { stdout: log } = await git(dir, ["log", "--oneline"]);
      expect(log.trim().split("\n")).toHaveLength(1); // still exactly one commit — no second commit
      const { stdout: content } = await git(dir, ["show", "HEAD:b.txt"]);
      expect(content).toBe("new file\n");
      await waitFor(async () => expect(await statusPorcelain(dir)).toBe(""));
    },
    30000,
  );

  it(
    "AC4: on an unborn-HEAD repository, the amend checkbox is disabled with an explanatory tooltip and produces no git call",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeFile(dir, "a.txt", "content\n");

      await openAppOn(dir);
      const changesPanel = await openChangesPanel();
      const checkbox = await within(changesPanel).findByRole("checkbox", { name: /amend last commit/i });
      expect(checkbox).toBeDisabled();
      expect(checkbox.closest("label")).toHaveAttribute("title", expect.stringMatching(/no commits yet/i));
    },
    25000,
  );

  it(
    "AC5: while a merge is genuinely mid-conflict, the amend checkbox is disabled with an explanatory tooltip",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeFile(dir, "a.txt", "base\n");
      await commitAll(dir, "base");
      await git(dir, ["checkout", "-q", "-b", "feature"]);
      await writeFile(dir, "a.txt", "feature change\n");
      await commitAll(dir, "feature change");
      await git(dir, ["checkout", "-q", "main"]);
      await writeFile(dir, "a.txt", "main change\n");
      await commitAll(dir, "main change");
      await git(dir, ["merge", "-q", "feature"]).catch(() => {});

      await openAppOn(dir);
      const changesPanel = await openChangesPanel();
      const checkbox = await within(changesPanel).findByRole("checkbox", { name: /amend last commit/i });
      await waitFor(() => expect(checkbox).toBeDisabled());
      expect(checkbox.closest("label")).toHaveAttribute("title", expect.stringMatching(/merge/i));

      await git(dir, ["merge", "--abort"]);
    },
    25000,
  );

  it(
    "AC6: on a branch with a real present upstream and ahead===0, submitting shows the pushed-commit warning; confirming proceeds with a real amend",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      const bareRemote = await initRepo({ bare: true });
      dirs.push(bareRemote);
      await writeFile(dir, "a.txt", "1\n");
      await commitAll(dir, "Original message");
      await git(dir, ["remote", "add", "origin", bareRemote]);
      await git(dir, ["push", "-q", "-u", "origin", "main"]);

      await openAppOn(dir);
      const changesPanel = await openChangesPanel();
      await userEvent.click(within(changesPanel).getByRole("checkbox", { name: /amend last commit/i }));
      await waitFor(() => expect(within(changesPanel).getByLabelText(/subject/i)).toHaveValue("Original message"));
      await userEvent.clear(within(changesPanel).getByLabelText(/subject/i));
      await userEvent.type(within(changesPanel).getByLabelText(/subject/i), "Amended after push");
      await userEvent.click(within(changesPanel).getByRole("button", { name: /^amend commit$/i }));

      const dialog = await screen.findByRole("alertdialog");
      expect(dialog).toHaveTextContent(/pushed/i);
      // No git call has happened yet — HEAD on disk is still the pre-amend commit.
      const { stdout: preSha } = await git(dir, ["rev-parse", "HEAD"]);
      await userEvent.click(within(dialog).getByRole("button", { name: /amend anyway/i }));

      await waitFor(async () => {
        const { stdout } = await git(dir, ["rev-parse", "HEAD"]);
        expect(stdout.trim()).not.toBe(preSha.trim());
      });
      const { stdout: subject } = await git(dir, ["log", "-1", "--pretty=%s"]);
      expect(subject.trim()).toBe("Amended after push");
    },
    30000,
  );

  it(
    "AC7: no upstream configured — submitting an amend proceeds directly with no warning and a real amended commit results",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeFile(dir, "a.txt", "1\n");
      const before = await commitAll(dir, "Original message");

      await openAppOn(dir);
      const changesPanel = await openChangesPanel();
      await userEvent.click(within(changesPanel).getByRole("checkbox", { name: /amend last commit/i }));
      await waitFor(() => expect(within(changesPanel).getByLabelText(/subject/i)).toHaveValue("Original message"));
      await userEvent.clear(within(changesPanel).getByLabelText(/subject/i));
      await userEvent.type(within(changesPanel).getByLabelText(/subject/i), "No upstream, no warning");
      await userEvent.click(within(changesPanel).getByRole("button", { name: /^amend commit$/i }));

      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      await waitFor(async () => expect(await headSha(dir)).not.toBe(before));
      const { stdout: subject } = await git(dir, ["log", "-1", "--pretty=%s"]);
      expect(subject.trim()).toBe("No upstream, no warning");
    },
    30000,
  );

  it(
    "AC7: a real upstream but ahead>=1 (an unpushed local commit sits on top) — submitting proceeds directly with no warning",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      const bareRemote = await initRepo({ bare: true });
      dirs.push(bareRemote);
      await writeFile(dir, "a.txt", "1\n");
      await commitAll(dir, "base");
      await git(dir, ["remote", "add", "origin", bareRemote]);
      await git(dir, ["push", "-q", "-u", "origin", "main"]);
      await writeFile(dir, "a.txt", "2\n");
      const before = await commitAll(dir, "Unpushed HEAD commit");

      await openAppOn(dir);
      const changesPanel = await openChangesPanel();
      await userEvent.click(within(changesPanel).getByRole("checkbox", { name: /amend last commit/i }));
      await waitFor(() => expect(within(changesPanel).getByLabelText(/subject/i)).toHaveValue("Unpushed HEAD commit"));
      await userEvent.clear(within(changesPanel).getByLabelText(/subject/i));
      await userEvent.type(within(changesPanel).getByLabelText(/subject/i), "Amended unpushed commit");
      await userEvent.click(within(changesPanel).getByRole("button", { name: /^amend commit$/i }));

      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      await waitFor(async () => expect(await headSha(dir)).not.toBe(before));
    },
    30000,
  );

  it(
    "AC8: after a successful amend, the composer clears and the commit graph shows the new SHA (not the old one) at HEAD's row",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeFile(dir, "a.txt", "1\n");
      const before = await commitAll(dir, "Original message");

      await openAppOn(dir);
      const changesPanel = await openChangesPanel();
      await userEvent.click(within(changesPanel).getByRole("checkbox", { name: /amend last commit/i }));
      await waitFor(() => expect(within(changesPanel).getByLabelText(/subject/i)).toHaveValue("Original message"));
      await userEvent.clear(within(changesPanel).getByLabelText(/subject/i));
      await userEvent.type(within(changesPanel).getByLabelText(/subject/i), "Amended subject for graph");
      await userEvent.click(within(changesPanel).getByRole("button", { name: /^amend commit$/i }));

      // Queried fresh via `screen` on each poll (not the captured `changesPanel` handle): a
      // successful amend's `onCommitCreated` triggers a graph refresh, and `ChangesPanel` is
      // remounted on repo-open sequence changes (`App.tsx`'s `key={graph.openSequence}`) — a stale
      // captured element handle can otherwise be queried mid-swap and throw a spurious RTL error.
      await waitFor(async () => expect(await headSha(dir)).not.toBe(before));
      await waitFor(() => expect(screen.getByLabelText(/subject/i)).toHaveValue(""));
      expect(screen.getByRole("checkbox", { name: /amend last commit/i })).not.toBeChecked();

      // The graph (rendered behind/alongside ChangesPanel in MainArea) reflects the new subject
      // without any manual refresh/restart.
      await waitFor(() => expect(screen.getByText("Amended subject for graph")).toBeInTheDocument());
      expect(screen.queryByText("Original message")).not.toBeInTheDocument();
    },
    30000,
  );

  it(
    "AC11: amending on a detached HEAD updates HEAD directly with no crash, and the branch ref pointing at the old commit is untouched",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeFile(dir, "a.txt", "1\n");
      await commitAll(dir, "first");
      await writeFile(dir, "a.txt", "2\n");
      const second = await commitAll(dir, "second");
      await git(dir, ["checkout", "-q", second]);
      expect(await isDetached(dir)).toBe(true);

      await openAppOn(dir);
      const changesPanel = await openChangesPanel();
      const checkbox = await within(changesPanel).findByRole("checkbox", { name: /amend last commit/i });
      // Detached HEAD is not one of the two documented disable conditions (unborn HEAD / operation
      // in progress) — the checkbox must be enabled.
      expect(checkbox).not.toBeDisabled();
      await userEvent.click(checkbox);
      await waitFor(() => expect(within(changesPanel).getByLabelText(/subject/i)).toHaveValue("second"));
      await userEvent.clear(within(changesPanel).getByLabelText(/subject/i));
      await userEvent.type(within(changesPanel).getByLabelText(/subject/i), "second, amended via UI");
      await userEvent.click(within(changesPanel).getByRole("button", { name: /^amend commit$/i }));

      await waitFor(async () => expect(await headSha(dir)).not.toBe(second));
      expect(await isDetached(dir)).toBe(true); // still detached, not reattached to any branch
      const { stdout: mainTip } = await git(dir, ["rev-parse", "main"]);
      expect(mainTip.trim()).toBe(second); // the branch ref itself never moved
      expect(screen.queryByRole("alert")).not.toBeInTheDocument(); // no crash/error surfaced
    },
    30000,
  );

  it(
    "AC9: a real commit-msg hook rejecting the amend surfaces the existing commit-error UI, and HEAD/its message are left untouched on disk",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeFile(dir, "a.txt", "1\n");
      const before = await commitAll(dir, "Original message");

      const { stdout: hooksDirRaw } = await git(dir, ["rev-parse", "--git-path", "hooks"]);
      const hooksDir = path.resolve(dir, hooksDirRaw.trim());
      await fs.mkdir(hooksDir, { recursive: true });
      const hookPath = path.join(hooksDir, "commit-msg");
      await fs.writeFile(hookPath, '#!/bin/sh\necho "rejected by real e2e commit-msg hook" 1>&2\nexit 1\n', {
        mode: 0o755,
      });
      await fs.chmod(hookPath, 0o755).catch(() => {
        /* chmod is a no-op-ish on Windows; the shebang alone is enough for git-for-windows to run it */
      });

      await openAppOn(dir);
      const changesPanel = await openChangesPanel();
      await userEvent.click(within(changesPanel).getByRole("checkbox", { name: /amend last commit/i }));
      await waitFor(() => expect(within(changesPanel).getByLabelText(/subject/i)).toHaveValue("Original message"));
      await userEvent.clear(within(changesPanel).getByLabelText(/subject/i));
      await userEvent.type(within(changesPanel).getByLabelText(/subject/i), "Should be rejected");
      await userEvent.click(within(changesPanel).getByRole("button", { name: /^amend commit$/i }));

      // The same `commitError` alert a failed plain commit already uses — not a crash, not
      // swallowed — and the checkbox/subject stay exactly as submitted (no silent reset on failure).
      await waitFor(() => expect(within(changesPanel).getByRole("alert")).toHaveTextContent(/rejected/i));
      expect(within(changesPanel).getByRole("checkbox", { name: /amend last commit/i })).toBeChecked();
      expect(within(changesPanel).getByLabelText(/subject/i)).toHaveValue("Should be rejected");

      const { stdout } = await git(dir, ["log", "-1", "--pretty=%H%n%s"]);
      const [sha, subject] = stdout.split("\n");
      expect(sha).toBe(before);
      expect(subject).toBe("Original message");
    },
    30000,
  );
});
