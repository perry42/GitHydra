// SPDX-License-Identifier: GPL-3.0-or-later
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configure, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { createRealGitHydraApi, type RealGitHydraHandle } from "./test/realGitHydraApi";
import { cleanup, commitAll, initRepo, writeFile } from "./test/gitFixture";

configure({ asyncUtilTimeout: 12000 });

/**
 * specs/repo-open-feedback-fixes.md FR-202/FR-203, AC5/AC8/AC9: real-git, real-`RepoSession`
 * coverage (via `realGitHydraApi.ts` — see its own module doc comment for why this exists
 * alongside the pure in-memory `makeMockGitHydra` suites) for the "show git's resolved toplevel,
 * not the raw picked path" fix. `useRepositoryGraph.test.ts`/`useRepoTabs.recentSwitchGuard.
 * test.ts` cover the same logic against a mock; this file proves it against a REAL subfolder-of-a-
 * repo pick and a REAL bare repository, where the actual divergence (or lack of one) can only be
 * observed by really shelling out to `git rev-parse --show-toplevel`-equivalent resolution.
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

/** Case/separator-insensitive comparison — matches `resolveOpenedPath`'s own `looksLikeSamePath`
 * intent: git's resolved toplevel is always forward-slash-styled, which is a trivial spelling
 * difference from a native-Windows-backslash `dir`, not a real divergence. */
function normalizePathForAssertion(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function toolbarRepoPathTitle(): string | null {
  return document.querySelector(".gh-toolbar__repo-path")?.getAttribute("title") ?? null;
}

describe("repo-open path resolution (specs/repo-open-feedback-fixes.md FR-202/FR-203)", () => {
  it("AC5: opening a subfolder of a repo's working tree resolves to the parent toplevel, not the picked subfolder", async () => {
    const dir = await initRepo();
    dirs.push(dir);
    await writeFile(dir, "sub/file.txt", "content\n");
    await commitAll(dir, "Repo commit");
    const subDir = path.join(dir, "sub");

    const handle = createRealGitHydraApi();
    handles.push(handle);
    handle.setDialogPath(subDir);
    window.gitHydra = handle.api;
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
    await screen.findByText("Repo commit", {}, { timeout: 10000 });

    // Never the raw picked subfolder.
    expect(screen.queryByTitle(subDir)).not.toBeInTheDocument();
    // The resolved parent toplevel (allowing for git's own forward-slash spelling).
    expect(normalizePathForAssertion(toolbarRepoPathTitle() ?? "")).toBe(normalizePathForAssertion(dir));
  }, 30000);

  it("AC7: opening a repo's actual root directly shows that exact path, unchanged (no divergence)", async () => {
    const dir = await initRepo();
    dirs.push(dir);
    await writeFile(dir, "a.txt", "1\n");
    await commitAll(dir, "Repo commit");

    const handle = createRealGitHydraApi();
    handles.push(handle);
    handle.setDialogPath(dir);
    window.gitHydra = handle.api;
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
    await screen.findByText("Repo commit", {}, { timeout: 10000 });

    // No divergence: the ORIGINAL path's own spelling is preserved verbatim (AC7's "renders
    // exactly as it does today" — not just an equivalent-but-reformatted string).
    expect(toolbarRepoPathTitle()).toBe(dir);
  }, 30000);

  it("AC8: opening the same repo via its root, then via a subfolder of it in a new tab, dedups into a single tab", async () => {
    const dir = await initRepo();
    dirs.push(dir);
    await writeFile(dir, "sub/file.txt", "content\n");
    await commitAll(dir, "Repo commit");
    const subDir = path.join(dir, "sub");

    const handle = createRealGitHydraApi();
    handles.push(handle);
    window.gitHydra = handle.api;
    handle.setDialogPath(dir);
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
    await screen.findByText("Repo commit", {}, { timeout: 10000 });
    expect(screen.getAllByRole("tab")).toHaveLength(1);

    // "+ New tab" -> the idle landing screen (no dialog of its own — see TabBar's own doc comment).
    await userEvent.click(screen.getByRole("button", { name: /open a repository in a new tab/i }));
    await screen.findByRole("button", { name: "Open a repository" });

    handle.setDialogPath(subDir);
    await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
    await screen.findByText("Repo commit", {}, { timeout: 10000 });

    // Still exactly one tab — the subfolder pick resolved to the repo already open in tab 1,
    // collapsing the brand-new tab into it rather than leaving two tabs for one physical repo.
    expect(screen.getAllByRole("tab")).toHaveLength(1);
  }, 30000);

  it("AC9: opening a bare repository shows the caller-supplied path unchanged — no resolution attempted", async () => {
    const bareDir = await initRepo({ bare: true });
    dirs.push(bareDir);

    const handle = createRealGitHydraApi();
    handles.push(handle);
    handle.setDialogPath(bareDir);
    window.gitHydra = handle.api;
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
    await screen.findByTitle(bareDir, {}, { timeout: 10000 });
  }, 30000);
});
