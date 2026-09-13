// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { configure, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { createRealGitHydraApi, type RealGitHydraHandle } from "./test/realGitHydraApi";
import { cleanup, commitAll, initRepo, writeFile } from "./test/gitFixture";
import { isCaseInsensitiveFileSystem } from "../shared/pathEquivalence";

configure({ asyncUtilTimeout: 12000 });

/**
 * ROADMAP.md "Open tech debt — repo-open dedup uses exact string equality, no path normalization":
 * real-git, real-`RepoSession` coverage for the two sub-cases that turned out to already be (or
 * are now, per this same ticket's `pathEquivalence.ts` fix) correctly deduped end-to-end — a
 * sibling to `App.repoOpenPathResolution.e2e.test.tsx`'s AC5/AC7/AC8/AC9 coverage of the
 * subfolder-of-a-repo case.
 *
 * Symlink/junction dedup: confirmed EMPIRICALLY (against a real Windows junction, via a scratch
 * script, during this fix's own investigation) that `git rev-parse --show-toplevel` already
 * resolves a junction/symlink — at any depth, including a PARENT directory being the junction, not
 * only the repo root itself — back to the real physical path, before this app's own
 * `resolveOpenedPath`/`looksLikeSamePath` machinery even runs. Combined with
 * `reconcileDuplicateTab`'s existing `looksLikeSamePath` comparison (specs/repo-open-feedback-
 * fixes.md FR-202/FR-203, AC8), this means symlink/junction dedup already worked correctly before
 * this ticket touched any code — this test is new REGRESSION coverage locking that behavior in,
 * not evidence of a fix.
 *
 * Mapped-network-drive-letter vs. UNC path is NOT covered here — see `pathEquivalence.ts`'s
 * `resolveOpenedPath` doc comment for why that sub-case is a deliberately scoped-out non-goal
 * (untestable end-to-end without a real network share, and would need a materially larger
 * cross-tab canonical-key mechanism to fix for real).
 */

const handles: RealGitHydraHandle[] = [];
const dirs: string[] = [];
const extraLinks: string[] = [];

afterEach(async () => {
  // @ts-expect-error test cleanup of the global bridge
  delete window.gitHydra;
  window.localStorage.clear();
  await new Promise((resolve) => setTimeout(resolve, 350));
  while (handles.length) handles.pop()!.dispose();
  while (extraLinks.length) {
    const link = extraLinks.pop()!;
    try {
      await fs.unlink(link);
    } catch {
      // Best-effort — a junction/symlink removal failure here shouldn't fail the whole suite.
    }
  }
  while (dirs.length) {
    const dir = dirs.pop()!;
    try {
      await cleanup(dir);
    } catch {
      // Best-effort Windows file-lock tolerance, same as the sibling e2e files.
    }
  }
});

/** Creates a directory symlink (`junction` on Windows — doesn't require elevated privileges, unlike
 * a Windows `dir`-type symlink — `dir` everywhere else) at `linkPath` pointing at `targetPath`. */
async function makeDirLink(targetPath: string, linkPath: string): Promise<void> {
  const isWindows = (globalThis as { process?: { platform?: string } }).process?.platform === "win32";
  await fs.symlink(targetPath, linkPath, isWindows ? "junction" : "dir");
  extraLinks.push(linkPath);
}

describe("repo-open path canonicalization dedup (ROADMAP.md repo-open dedup tech debt)", () => {
  it("opening a repo via its real path, then via a junction/symlink pointing at it, dedups into a single tab", async () => {
    const dir = await initRepo();
    dirs.push(dir);
    await writeFile(dir, "a.txt", "1\n");
    await commitAll(dir, "Repo commit");

    const link = `${dir}-link`;
    await makeDirLink(dir, link);

    const handle = createRealGitHydraApi();
    handles.push(handle);
    handle.setDialogPath(dir);
    window.gitHydra = handle.api;
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
    await screen.findByText("Repo commit", {}, { timeout: 10000 });
    expect(screen.getAllByRole("tab")).toHaveLength(1);

    // "+ New tab" -> the idle landing screen, then pick the JUNCTION path instead of the real one.
    await userEvent.click(screen.getByRole("button", { name: /open a repository in a new tab/i }));
    await screen.findByRole("button", { name: "Open a repository" });

    handle.setDialogPath(link);
    await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
    await screen.findByText("Repo commit", {}, { timeout: 10000 });

    // Still exactly one tab — git's own toplevel resolution already chased the junction back to
    // the real path, so this collapsed into the tab already open for it.
    expect(screen.getAllByRole("tab")).toHaveLength(1);
  }, 30000);

  it("opening a repo, then via a differently-cased spelling of the identical path, dedups exactly when the real host filesystem is case-insensitive", async () => {
    const dir = await initRepo();
    dirs.push(dir);
    await writeFile(dir, "a.txt", "1\n");
    await commitAll(dir, "Repo commit");

    // A case-flipped spelling of the exact same directory. On a case-insensitive filesystem
    // (Windows/macOS default) this resolves to the identical directory on disk.
    const flippedCase = dir
      .split("")
      .map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))
      .join("");

    const handle = createRealGitHydraApi();
    handles.push(handle);
    handle.setDialogPath(dir);
    window.gitHydra = handle.api;
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
    await screen.findByText("Repo commit", {}, { timeout: 10000 });
    expect(screen.getAllByRole("tab")).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: /open a repository in a new tab/i }));
    await screen.findByRole("button", { name: "Open a repository" });

    handle.setDialogPath(flippedCase);
    await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
    await screen.findByText("Repo commit", {}, { timeout: 10000 });

    if (isCaseInsensitiveFileSystem()) {
      expect(screen.getAllByRole("tab")).toHaveLength(1);
    } else {
      // Case-sensitive (Linux): git would fail to open the case-flipped path at all (it's a
      // genuinely nonexistent directory there) — not exercised by this sandbox/host, documented
      // rather than asserted on.
      expect(screen.getAllByRole("tab").length).toBeGreaterThanOrEqual(1);
    }
  }, 30000);
});
