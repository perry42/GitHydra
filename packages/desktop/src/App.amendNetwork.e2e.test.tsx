import { afterEach, describe, expect, it } from "vitest";
import { configure, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { createRealGitHydraApi, type RealGitHydraHandle } from "./test/realGitHydraApi";
import { cleanup, commitAll, git, initRepo, writeFile } from "./test/gitFixture";

configure({ asyncUtilTimeout: 12000 });

/**
 * specs/amend-last-commit.md AC10: zero outbound network requests at any point across checking
 * amend, viewing the pushed-commit warning, and submitting — verified against repos configured
 * with GitHub, GitLab, Bitbucket, and self-hosted remotes, and a purely local repo with no remote.
 *
 * NOTE on technique: `packages/git-core/tests/noNetworkCalls.test.ts` verifies its own FR-153 case
 * by `vi.mock`-ing `node:child_process` and asserting no captured `spawn` call is a
 * fetch/pull/push subcommand — a strictly stronger, allowlist-free proof. That technique was tried
 * here first and does NOT work at this package's integration layer: `packages/desktop` depends on
 * `@githydra/git-core`'s PUBLISHED `dist/index.js` (a compiled CommonJS module, per its
 * `package.json` `"main"`), which is loaded via Node's native `require` rather than through
 * Vitest/vite-node's SSR-transformed ESM module graph — `vi.mock("node:child_process", ...)`
 * silently fails to intercept `spawn` calls that originate from inside that `require`d module (a
 * real, verified environment gap: an instrumented probe here captured zero `spawn` calls even
 * while a real repo was demonstrably being opened via real git). git-core's own two files —
 * `noNetworkCalls.test.ts`'s `FR-153` describe block and `branchesNoNetwork.test.ts` (covering
 * `listBranches()`, the other call this feature's warning step makes) — remain the load-bearing,
 * intercepting proof that neither underlying git-core call ever touches a network subcommand.
 *
 * What THIS file adds on top of that (and is the reason it still exists, rather than treating
 * git-core's two files as sufficient): a real, unmocked, black-box proof, at the full real-`<App/>`
 * UI-integration layer, that the exact ORCHESTRATION this feature's UI performs — check the amend
 * box, view the pushed-commit warning, confirm, submit — completes promptly against remotes named
 * for GitHub/GitLab/Bitbucket/self-hosted pointed at non-routable addresses, the same "would
 * hang/fail loudly rather than silently succeed" technique `noNetworkCalls.test.ts` itself uses.
 * This is a materially weaker guarantee than an intercepted allowlist (a very slow, still-local
 * operation could theoretically pass it), but it is real coverage of the UI-level call sequence
 * (`useChangesPanel.ts`'s `listBranches()` pre-flight + `getCommit()` preload + `amendCommit()`
 * submit) that git-core's own two files, being git-core-only, cannot exercise end to end.
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
      // Best-effort Windows file-lock tolerance, same as the sibling e2e files.
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

describe("AC10 (specs/amend-last-commit.md): the real UI's check/warning/submit sequence completes promptly against unreachable named-host remotes", () => {
  it(
    "check -> pushed-commit warning -> confirm -> amend all complete within the normal timeout, with GitHub/GitLab/Bitbucket/self-hosted remotes configured against non-routable addresses",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeFile(dir, "a.txt", "1\n");
      await commitAll(dir, "Original message");
      // A real, reachable, purely local bare "remote" is required to make the warning trigger at
      // all (present + non-gone upstream + ahead===0) — then each named host is ALSO added as an
      // extra remote pointed at a non-routable TEST-NET-1 address, mirroring
      // `noNetworkCalls.test.ts`'s own AC8 image-diff-preview block's exact host list.
      const bareRemote = await initRepo({ bare: true });
      dirs.push(bareRemote);
      await git(dir, ["remote", "add", "origin", bareRemote]);
      await git(dir, ["push", "-q", "-u", "origin", "main"]);
      await git(dir, ["remote", "add", "github", "https://github.com.invalid.198.51.100.1/o/r.git"]);
      await git(dir, ["remote", "add", "gitlab", "https://gitlab.com.invalid.198.51.100.1/o/r.git"]);
      await git(dir, ["remote", "add", "bitbucket", "https://bitbucket.org.invalid.198.51.100.1/o/r.git"]);
      await git(dir, ["remote", "add", "selfhosted", "https://git.example.invalid.198.51.100.1/o/r.git"]);

      await openAppOn(dir);
      const changesPanel = await openChangesPanel();
      await userEvent.click(within(changesPanel).getByRole("checkbox", { name: /amend last commit/i }));
      await waitFor(() => expect(within(changesPanel).getByLabelText(/subject/i)).toHaveValue("Original message"));
      await userEvent.click(within(changesPanel).getByRole("button", { name: /^amend commit$/i }));

      const dialog = await screen.findByRole("alertdialog");
      expect(dialog).toHaveTextContent(/pushed/i);
      await userEvent.click(within(dialog).getByRole("button", { name: /amend anyway/i }));

      await waitFor(() => expect(screen.getByLabelText(/subject/i)).toHaveValue(""));
      const { stdout: subject } = await git(dir, ["log", "-1", "--pretty=%s"]);
      expect(subject.trim()).toBe("Original message");
    },
    30000,
  );

  it(
    "the same check -> confirm -> amend flow completes promptly on a purely local repo with no remote at all",
    async () => {
      const dir = await initRepo();
      dirs.push(dir);
      await writeFile(dir, "a.txt", "1\n");
      await commitAll(dir, "Original message");

      await openAppOn(dir);
      const changesPanel = await openChangesPanel();
      await userEvent.click(within(changesPanel).getByRole("checkbox", { name: /amend last commit/i }));
      await waitFor(() => expect(within(changesPanel).getByLabelText(/subject/i)).toHaveValue("Original message"));
      await userEvent.click(within(changesPanel).getByRole("button", { name: /^amend commit$/i }));

      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      await waitFor(() => expect(screen.getByLabelText(/subject/i)).toHaveValue(""));
    },
    30000,
  );
});
