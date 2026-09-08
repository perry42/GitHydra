// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ChangedFile } from "@githydra/git-core";
import { App } from "./App";
import { makeMockGitHydra } from "./test/mockGitHydra";
import { makeCommit } from "./test/fixtures";

/**
 * specs/remember-last-selected-file.md: App-level integration coverage for FR-215 through FR-219
 * — the full cross-tab-switch/cross-panel wiring (App.tsx's `selectedFile` state, its
 * `consumedFileRestoreSeqRef`-gated restore hint, and `DetailPanel`/`ChangesPanel`'s one-shot
 * restore-hint consultation), mirroring `App.multiRepoTabs.test.tsx`'s own harness style for
 * AC1/AC2/AC5, and `App.restoreTabs.test.tsx`'s "simulated relaunch" style for AC6.
 */

afterEach(() => {
  // @ts-expect-error test cleanup of the global bridge
  delete window.gitHydra;
  window.localStorage.clear();
});

async function openFirstTab(): Promise<void> {
  await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
}

async function newTabInto(api: ReturnType<typeof makeMockGitHydra>, path: string): Promise<void> {
  vi.mocked(api.openRepoDialog).mockResolvedValueOnce({ ok: true, data: path });
  await userEvent.click(screen.getByRole("button", { name: /open a repository in a new tab/i }));
  await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
}

/** Seeds `getChangedFiles` (shared across every repo the mock knows about, keyed by sha) so
 * DetailPanel has more than one changed file to pick from — the mock's own default always
 * resolves `[]` regardless of which commit is asked about. */
function seedChangedFiles(api: ReturnType<typeof makeMockGitHydra>, bySha: Record<string, ChangedFile[]>): void {
  vi.mocked(api.getChangedFiles).mockImplementation(async (commit) => ({ ok: true, data: bySha[commit.sha] ?? [] }));
}

describe("remember-last-selected-file (specs/remember-last-selected-file.md)", () => {
  it("AC1: a non-first file selected in DetailPanel survives a switch away and back", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [makeCommit("a1", [], { subject: "Repo A commit" })],
      reposByPath: { "/repoB": { commits: [makeCommit("b1", [], { subject: "Repo B commit" })] } },
    });
    seedChangedFiles(api, {
      a1: [
        { path: "first.ts", status: "modified" },
        { path: "second.ts", status: "modified" },
        { path: "third.ts", status: "modified" },
      ],
    });
    window.gitHydra = api;
    render(<App />);

    await openFirstTab();
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    await userEvent.click(screen.getByText("Repo A commit"));
    await waitFor(() => expect(screen.getByRole("button", { name: /modified.*first\.ts/i })).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /modified.*second\.ts/i }));
    expect(screen.getByRole("button", { name: /modified.*second\.ts/i })).toHaveAttribute("aria-pressed", "true");

    await newTabInto(api, "/repoB");
    await waitFor(() => expect(screen.getByText("Repo B commit")).toBeInTheDocument());

    const tabs = screen.getAllByRole("tab");
    await userEvent.click(tabs[0]!);
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());

    // second.ts's diff is showing again — no additional click, not files[0] ("first.ts").
    await waitFor(() => expect(screen.getByRole("button", { name: /modified.*second\.ts/i })).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByRole("button", { name: /modified.*first\.ts/i })).toHaveAttribute("aria-pressed", "false");
  });

  it("AC2: a non-first file selected in ChangesPanel's Unstaged section survives a switch away and back", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [makeCommit("a1", [], { subject: "Repo A commit" })],
      workingDirectoryChanges: {
        staged: [],
        unstaged: [
          { path: "first.ts", status: "modified", category: "unstaged" },
          { path: "second.ts", status: "modified", category: "unstaged" },
        ],
        untracked: [],
        conflicted: [],
      },
      workingDirStatus: { hasChanges: true, staged: 0, unstaged: 2, untracked: 0, conflicted: 0 },
      reposByPath: { "/repoB": { commits: [makeCommit("b1", [], { subject: "Repo B commit" })] } },
    });
    window.gitHydra = api;
    render(<App />);

    await openFirstTab();
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /changes/i }));
    const changesPanel = await screen.findByRole("complementary", { name: "Changes" });
    await waitFor(() => expect(within(changesPanel).getByRole("button", { name: /modified.*first\.ts/i })).toBeInTheDocument());

    await userEvent.click(within(changesPanel).getByRole("button", { name: /modified.*second\.ts/i }));
    expect(within(changesPanel).getByRole("button", { name: /modified.*second\.ts/i })).toHaveAttribute("aria-pressed", "true");

    await newTabInto(api, "/repoB");
    await waitFor(() => expect(screen.getByText("Repo B commit")).toBeInTheDocument());

    const tabs = screen.getAllByRole("tab");
    await userEvent.click(tabs[0]!);
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());

    const reshownPanel = await screen.findByRole("complementary", { name: "Changes" });
    await waitFor(() =>
      expect(within(reshownPanel).getByRole("button", { name: /modified.*second\.ts/i })).toHaveAttribute("aria-pressed", "true"),
    );
    expect(within(reshownPanel).getByRole("button", { name: /modified.*first\.ts/i })).toHaveAttribute("aria-pressed", "false");
  });

  it("AC3: within a single tab, commit A -> B -> A again continues to reset to A's files[0] every time — unaffected by this feature", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [makeCommit("a1", ["b1"], { subject: "A" }), makeCommit("b1", [], { subject: "B" })],
    });
    seedChangedFiles(api, {
      a1: [
        { path: "a-first.ts", status: "modified" },
        { path: "a-second.ts", status: "modified" },
      ],
      b1: [{ path: "b.ts", status: "modified" }],
    });
    window.gitHydra = api;
    render(<App />);

    await openFirstTab();
    await waitFor(() => expect(screen.getByText("A")).toBeInTheDocument());
    await userEvent.click(screen.getByText("A"));
    await waitFor(() => expect(screen.getByRole("button", { name: /modified.*a-first\.ts/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /modified.*a-second\.ts/i }));
    expect(screen.getByRole("button", { name: /modified.*a-second\.ts/i })).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(screen.getByText("B"));
    await waitFor(() => expect(screen.getByRole("button", { name: /modified.*b\.ts/i })).toBeInTheDocument());

    await userEvent.click(screen.getByText("A"));
    await waitFor(() => expect(screen.getByRole("button", { name: /modified.*a-first\.ts/i })).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByRole("button", { name: /modified.*a-second\.ts/i })).toHaveAttribute("aria-pressed", "false");
  });

  it("AC5: closing a tab reactivates the adjacent tab with ITS OWN remembered file, never the closed tab's", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [makeCommit("a1", [], { subject: "Repo A commit" })],
      reposByPath: { "/repoB": { commits: [makeCommit("b1", [], { subject: "Repo B commit" })] } },
    });
    seedChangedFiles(api, {
      a1: [
        { path: "a-first.ts", status: "modified" },
        { path: "a-second.ts", status: "modified" },
      ],
      b1: [
        { path: "b-first.ts", status: "modified" },
        { path: "b-second.ts", status: "modified" },
      ],
    });
    window.gitHydra = api;
    render(<App />);

    await openFirstTab();
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    await userEvent.click(screen.getByText("Repo A commit"));
    await waitFor(() => expect(screen.getByRole("button", { name: /modified.*a-first\.ts/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /modified.*a-second\.ts/i }));

    await newTabInto(api, "/repoB");
    await waitFor(() => expect(screen.getByText("Repo B commit")).toBeInTheDocument());
    await userEvent.click(screen.getByText("Repo B commit"));
    await waitFor(() => expect(screen.getByRole("button", { name: /modified.*b-first\.ts/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /modified.*b-second\.ts/i }));

    const tabs = screen.getAllByRole("tab");
    await userEvent.click(tabs[1]!); // repoB is active; close it
    await userEvent.click(screen.getByRole("button", { name: "Close repoB tab" }));

    // repoA reactivates — showing ITS OWN remembered file (a-second.ts), not repoB's.
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: /modified.*a-second\.ts/i })).toHaveAttribute("aria-pressed", "true"));
  });

  it("AC6: quitting with the active tab showing a non-default file selection restores that same file's diff automatically on relaunch", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [makeCommit("a1", [], { subject: "Repo A commit" })],
      reposByPath: { "/repoB": { commits: [makeCommit("b1", [], { subject: "Repo B commit" })] } },
    });
    seedChangedFiles(api, {
      a1: [
        { path: "first.ts", status: "modified" },
        { path: "second.ts", status: "modified" },
      ],
    });
    window.gitHydra = api;
    const { unmount } = render(<App />);

    await openFirstTab();
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    await userEvent.click(screen.getByText("Repo A commit"));
    await waitFor(() => expect(screen.getByRole("button", { name: /modified.*first\.ts/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /modified.*second\.ts/i }));

    // Background repoA (captures its selection into `remembered`), then switch back to it so it's
    // the active tab at "quit" time — same reasoning as
    // `App.restoreTabs.test.tsx`'s AC4 precedent for why a plain single-tab session alone can't
    // exercise this (the live selection is only captured into persisted storage when a tab is
    // actually backgrounded at least once).
    await newTabInto(api, "/repoB");
    await waitFor(() => expect(screen.getByText("Repo B commit")).toBeInTheDocument());
    const tabs = screen.getAllByRole("tab");
    await userEvent.click(tabs[0]!);
    await waitFor(() => expect(screen.getByRole("button", { name: /modified.*second\.ts/i })).toHaveAttribute("aria-pressed", "true"));

    unmount();

    // "Relaunch": a fresh App instance against the same (never-cleared) localStorage.
    render(<App />);
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: /modified.*second\.ts/i })).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByRole("button", { name: /modified.*first\.ts/i })).toHaveAttribute("aria-pressed", "false");
  });

  it("AC4: a remembered file that's no longer present in the restored commit falls back to files[0], never errors", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [makeCommit("a1", [], { subject: "Repo A commit" })],
      reposByPath: { "/repoB": { commits: [makeCommit("b1", [], { subject: "Repo B commit" })] } },
    });
    seedChangedFiles(api, { a1: [{ path: "only-file.ts", status: "modified" }] });
    window.gitHydra = api;
    render(<App />);

    await openFirstTab();
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    await userEvent.click(screen.getByText("Repo A commit"));
    await waitFor(() => expect(screen.getByRole("button", { name: /modified.*only-file\.ts/i })).toBeInTheDocument());

    await newTabInto(api, "/repoB");
    await waitFor(() => expect(screen.getByText("Repo B commit")).toBeInTheDocument());

    // The commit's own file list shrinks between backgrounding and reactivating tab A (e.g. a
    // fresh read after an external change) — the remembered path is simply gone now.
    seedChangedFiles(api, { a1: [{ path: "different-file.ts", status: "modified" }] });

    const tabs = screen.getAllByRole("tab");
    await userEvent.click(tabs[0]!);
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());

    await waitFor(() => expect(screen.getByRole("button", { name: /modified.*different-file\.ts/i })).toHaveAttribute("aria-pressed", "true"));
  });

  it("AC7: a tab whose right panel is 'none' round-trips through a tab switch with no error, regardless of a harmlessly-carried remembered-file value", async () => {
    const api = makeMockGitHydra({
      repoPath: "/repoA",
      commits: [makeCommit("a1", [], { subject: "Repo A commit" })],
      reposByPath: { "/repoB": { commits: [makeCommit("b1", [], { subject: "Repo B commit" })] } },
    });
    seedChangedFiles(api, { a1: [{ path: "x.ts", status: "modified" }] });
    window.gitHydra = api;
    render(<App />);

    await openFirstTab();
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    // Open DetailPanel (captures a `selectedFile`), then close it — `rightPanel` goes back to
    // "none" while a remembered file value is still sitting there, unused (AC7's premise).
    await userEvent.click(screen.getByText("Repo A commit"));
    await waitFor(() => expect(screen.getByRole("button", { name: /modified.*x\.ts/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /close commit details/i }));
    expect(screen.queryByRole("complementary", { name: "Commit details" })).not.toBeInTheDocument();

    await expect(newTabInto(api, "/repoB")).resolves.not.toThrow();
    await waitFor(() => expect(screen.getByText("Repo B commit")).toBeInTheDocument());

    const tabs = screen.getAllByRole("tab");
    await expect(userEvent.click(tabs[0]!)).resolves.not.toThrow();
    await waitFor(() => expect(screen.getByText("Repo A commit")).toBeInTheDocument());
    expect(screen.queryByRole("complementary", { name: "Commit details" })).not.toBeInTheDocument();
  });
});
