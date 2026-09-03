import { afterEach, describe, expect, it } from "vitest";
import { configure, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { createRealGitHydraApi, type RealGitHydraHandle } from "./test/realGitHydraApi";
import { cleanup, commitAll, git, initRepo, writeFile } from "./test/gitFixture";

configure({ asyncUtilTimeout: 12000 });

/**
 * specs/repo-list.md AC7: zero outbound network requests across relaunch, viewing the recent
 * list, and opening a recent entry — verified against a repo configured with GitHub/GitLab/
 * Bitbucket/self-hosted remotes pointed at non-routable addresses, using the same "would hang/fail
 * loudly rather than silently succeed" technique as `App.amendNetwork.e2e.test.tsx`'s AC10 (see its
 * own doc comment for the full reasoning on why this real, unmocked layer is worth the extra
 * coverage on top of git-core's own intercepting no-network tests — this feature reuses the exact
 * same `openRepo`/`openRepoCancellable` plumbing every other open entry point already does, adding
 * no new git-core call and no new IPC channel per Must-have 6, so that existing proof already
 * covers the underlying git calls; what's new here is the recent-list orchestration itself).
 */

const handles: RealGitHydraHandle[] = [];
const dirs: string[] = [];

afterEach(async () => {
  // @ts-expect-error test cleanup of the global bridge
  delete window.gitHydra;
  window.localStorage.clear();
  await new Promise((resolve) => setTimeout(resolve, 350));
  while (handles.length) handles.pop()!.dispose();
  while (dirs.length) {
    const dir = dirs.pop()!;
    try {
      await cleanup(dir);
    } catch {
      // Best-effort Windows file-lock tolerance, same as the sibling e2e files.
    }
  }
});

describe("AC7 (specs/repo-list.md): the real recent-repos flow completes promptly with named-host remotes pointed at non-routable addresses", () => {
  it(
    "open a repo (building the recent list), 'relaunch', then reopen it straight from the recent list — completes promptly, with no native dialog call for the second open",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeFile(dir, "a.txt", "1\n");
      await commitAll(dir, "Repo commit");
      const bareRemote = await initRepo({ bare: true });
      dirs.push(bareRemote);
      await git(dir, ["remote", "add", "origin", bareRemote]);
      await git(dir, ["push", "-q", "-u", "origin", "main"]);
      await git(dir, ["remote", "add", "github", "https://github.com.invalid.198.51.100.1/o/r.git"]);
      await git(dir, ["remote", "add", "gitlab", "https://gitlab.com.invalid.198.51.100.1/o/r.git"]);
      await git(dir, ["remote", "add", "bitbucket", "https://bitbucket.org.invalid.198.51.100.1/o/r.git"]);
      await git(dir, ["remote", "add", "selfhosted", "https://git.example.invalid.198.51.100.1/o/r.git"]);

      // Session 1: open the repo via the real native-dialog stand-in, seeding the persisted
      // recent list (Must-have 1) exactly as a real relaunch would have left it.
      const handle1 = createRealGitHydraApi();
      handles.push(handle1);
      handle1.setDialogPath(dir);
      window.gitHydra = handle1.api;
      const { unmount } = render(<App />);
      await userEvent.click(screen.getByRole("button", { name: /^open repository/i }));
      await screen.findByText("Repo commit", {}, { timeout: 10000 });
      unmount();
      // @ts-expect-error test cleanup — simulating the app actually quitting before "relaunch".
      delete window.gitHydra;

      // Session 2 ("relaunch"): a fresh `<App/>`, fresh `RepoSession`, same persisted recent list
      // (real `localStorage`, never cleared between these two sessions in this test).
      const handle2 = createRealGitHydraApi();
      handles.push(handle2);
      let dialogCalls = 0;
      const realDialog = handle2.api.openRepoDialog;
      handle2.api.openRepoDialog = (...args) => {
        dialogCalls += 1;
        return realDialog(...args);
      };
      window.gitHydra = handle2.api;
      render(<App />);

      // AC1: the repo shows under "Recent repositories" on the fresh empty state, no browsing
      // needed. AC2: clicking it reopens it directly — no native dialog involved. AC7: the whole
      // sequence (relaunch, viewing the list, opening the entry) completes promptly despite the
      // repo's GitHub/GitLab/Bitbucket/self-hosted remotes all pointing at non-routable addresses.
      const recentEntry = await screen.findByTitle(dir, {}, { timeout: 10000 });
      await userEvent.click(recentEntry);
      await screen.findByText("Repo commit", {}, { timeout: 10000 });

      expect(dialogCalls).toBe(0);
    },
    30000,
  );

  it(
    "the same relaunch -> recent-click flow completes promptly on a purely local repo with no remote at all",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeFile(dir, "a.txt", "1\n");
      await commitAll(dir, "Repo commit");

      // Session 1: same as the named-host-remotes test above, but this repo has no remote
      // configured at all — specs/repo-list.md AC7 explicitly lists "no-remote" as one of the
      // cases to verify, mirroring `App.amendNetwork.e2e.test.tsx`'s own remote/no-remote pair.
      const handle1 = createRealGitHydraApi();
      handles.push(handle1);
      handle1.setDialogPath(dir);
      window.gitHydra = handle1.api;
      const { unmount } = render(<App />);
      await userEvent.click(screen.getByRole("button", { name: /^open repository/i }));
      await screen.findByText("Repo commit", {}, { timeout: 10000 });
      unmount();
      // @ts-expect-error test cleanup — simulating the app actually quitting before "relaunch".
      delete window.gitHydra;

      // Session 2 ("relaunch").
      const handle2 = createRealGitHydraApi();
      handles.push(handle2);
      let dialogCalls = 0;
      const realDialog = handle2.api.openRepoDialog;
      handle2.api.openRepoDialog = (...args) => {
        dialogCalls += 1;
        return realDialog(...args);
      };
      window.gitHydra = handle2.api;
      render(<App />);

      const recentEntry = await screen.findByTitle(dir, {}, { timeout: 10000 });
      await userEvent.click(recentEntry);
      await screen.findByText("Repo commit", {}, { timeout: 10000 });

      expect(dialogCalls).toBe(0);
    },
    30000,
  );
});
