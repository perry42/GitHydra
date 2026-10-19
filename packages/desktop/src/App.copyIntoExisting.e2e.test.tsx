// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { createRealGitHydraApi, type RealGitHydraHandle } from "./test/realGitHydraApi";
import { cleanup, commitAll, git, makeTempDir, writeFile } from "./test/gitFixture";

configure({ asyncUtilTimeout: 20000 });

/**
 * specs/worktree-copy-ignored.md section G, AC 13/19/20 on the real <App/> with real git underneath: the palette opens the dialog directly
 * for exactly one eligible other worktree, the copy writes the file, and the FR-655 banner lands in the Branches panel (FR-634).
 */
const handles: RealGitHydraHandle[] = [];
const dirs: string[] = [];

afterEach(async () => {
  // @ts-expect-error test cleanup of the global bridge
  delete window.gitHydra;
  window.localStorage.clear();
  await new Promise((resolve) => setTimeout(resolve, 350));
  while (handles.length) handles.pop()!.dispose();
  while (dirs.length) await cleanup(dirs.pop()!);
});

async function makeRepo(): Promise<{ repo: string; feature: string }> {
  const parent = await makeTempDir("copy-into-ui-");
  dirs.push(parent);
  const repo = path.join(parent, "acme");
  await fs.mkdir(repo);
  await git(repo, ["init", "-q", "--initial-branch=main"]);
  await writeFile(repo, "a.txt", "base\n");
  await writeFile(repo, ".gitignore", ".env\nconfig/local.json\n");
  await commitAll(repo, "base");
  const feature = path.join(parent, "acme.worktrees", "feature");
  await fs.mkdir(path.dirname(feature), { recursive: true });
  await git(repo, ["worktree", "add", "-q", "-b", "feature", feature]);
  await writeFile(repo, ".env", "SECRET=1\n");
  await writeFile(repo, "config/local.json", "{}\n");
  return { repo, feature };
}

async function openAppOn(dir: string): Promise<RealGitHydraHandle> {
  const handle = createRealGitHydraApi();
  handles.push(handle);
  handle.setDialogPath(dir);
  window.localStorage.setItem("githydra:layout:worktreesCollapsed", "0");
  window.gitHydra = handle.api;
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
  await screen.findByRole("button", { name: /stashes/i }, { timeout: 10000 });
  return handle;
}

const exists = (p: string) => fs.stat(p).then(() => true, () => false);

describe("Copy ignored files into a worktree (real App, real git)", () => {
  it(
    "from the Worktrees row menu: the dialog lists the files, a copy writes them, and the banner is in the Branches panel",
    async () => {
      const { feature } = await makeRepo();
      await openAppOn(path.dirname(path.dirname(feature)) + path.sep + "acme");
      const row = await screen.findByRole("listitem", { name: /Worktree feature, linked/ });
      await userEvent.click(within(row).getByRole("button", { name: "Actions for worktree feature" }));
      await userEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Copy ignored files here..." }));

      const dialog = await screen.findByRole("dialog", { name: "Copy ignored files" });
      await within(dialog).findByText((_, el) => el?.tagName === "P" && el.textContent === "From acme into feature.");
      const env = await within(dialog).findByRole("checkbox", { name: /\.env/ });
      expect(env).not.toBeChecked();
      expect(within(dialog).getByText("secret")).toBeInTheDocument();
      fireEvent.click(env);
      fireEvent.click(within(dialog).getByRole("checkbox", { name: /config\/local\.json|config\// }));
      await userEvent.click(within(dialog).getByRole("button", { name: "Copy" }));

      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Copy ignored files" })).toBeNull());
      const banner = await screen.findByText(/^Copied 2 files/);
      expect(banner.closest(".gh-status-banner")).not.toBeNull();
      expect(banner.closest(".gh-branches-panel")).not.toBeNull();
      expect(await fs.readFile(path.join(feature, ".env"), "utf8")).toBe("SECRET=1\n");
      expect(await fs.readFile(path.join(feature, "config", "local.json"), "utf8")).toBe("{}\n");
      expect(banner.closest(".gh-status-banner")!.textContent).not.toMatch(/remember/i);
    },
    60000,
  );

  it(
    "from the palette with exactly one other worktree, the dialog opens directly for it",
    async () => {
      const { feature } = await makeRepo();
      await openAppOn(path.join(path.dirname(path.dirname(feature)), "acme"));
      await screen.findByRole("listitem", { name: /Worktree feature, linked/ });
      await userEvent.keyboard("{Control>}k{/Control}");
      const input = await screen.findByRole("combobox");
      await userEvent.type(input, "Copy ignored");
      const option = screen.getByRole("option", { name: /Copy ignored files into worktree\.\.\./ });
      expect(option).not.toHaveAttribute("aria-disabled");
      await userEvent.keyboard("{Enter}");
      const dialog = await screen.findByRole("dialog", { name: "Copy ignored files" });
      await within(dialog).findByText((_, el) => el?.tagName === "P" && el.textContent === "From acme into feature.");
      expect(await exists(path.join(feature, ".env"))).toBe(false);
    },
    60000,
  );
});
