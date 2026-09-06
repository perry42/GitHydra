// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CompareView } from "./CompareView";
import { makeCommit } from "../../test/fixtures";
import { makeMockGitHydra } from "../../test/mockGitHydra";

describe("CompareView (specs/compare-commits.md)", () => {
  it("AC4: shows an abbreviated SHA + first message line for both base and target, labeled explicitly", async () => {
    const api = makeMockGitHydra({
      commits: [
        makeCommit("target0000", ["base00000"], { subject: "Target commit", message: "Target commit" }),
        makeCommit("base00000", [], { subject: "Base commit", message: "Base commit" }),
      ],
    });
    render(
      <CompareView api={api} target={{ baseSha: "base00000", targetSha: "target0000" }} onClose={() => {}} onSwap={() => {}} />,
    );

    await waitFor(() => expect(screen.getByText("Base commit")).toBeInTheDocument());
    expect(screen.getByText("Target commit")).toBeInTheDocument();
    expect(screen.getByText("Base")).toBeInTheDocument();
    expect(screen.getByText("Target")).toBeInTheDocument();
  });

  it("AC5/AC6: the file list shows exactly the files that differ, and the first one auto-loads with no click required", async () => {
    const api = makeMockGitHydra({
      commits: [makeCommit("t1", ["b1"]), makeCommit("b1", [])],
      compareChangedFiles: [
        { path: "a.ts", status: "modified" },
        { path: "b.ts", status: "added" },
      ],
      fileDiff: {
        status: "ok",
        isBinary: false,
        hunks: [
          {
            header: "@@ -1 +1 @@",
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: [{ type: "add", content: "auto-loaded content", oldLineNumber: null, newLineNumber: 1 }],
          },
        ],
      },
    });
    render(<CompareView api={api} target={{ baseSha: "b1", targetSha: "t1" }} onClose={() => {}} onSwap={() => {}} />);

    expect(await screen.findByText(/changed files \(2\)/i)).toBeInTheDocument();
    await waitFor(() =>
      expect(vi.mocked(api.getCommitRangeFileDiff)).toHaveBeenCalledWith("b1", "t1", { path: "a.ts", oldPath: undefined }),
    );
    expect(vi.mocked(api.getCommitRangeFileDiff)).not.toHaveBeenCalledWith("b1", "t1", { path: "b.ts", oldPath: undefined });
    await waitFor(() => expect(screen.getByText("auto-loaded content")).toBeInTheDocument());
  });

  it("AC5: clicking a different file loads that file's diff via getCommitRangeFileDiff", async () => {
    const api = makeMockGitHydra({
      commits: [makeCommit("t1", ["b1"]), makeCommit("b1", [])],
      compareChangedFiles: [
        { path: "first.ts", status: "modified" },
        { path: "second.ts", status: "modified" },
      ],
      fileDiff: { status: "ok", isBinary: false, hunks: [] },
    });
    render(<CompareView api={api} target={{ baseSha: "b1", targetSha: "t1" }} onClose={() => {}} onSwap={() => {}} />);

    await waitFor(() =>
      expect(vi.mocked(api.getCommitRangeFileDiff)).toHaveBeenCalledWith(
        "b1",
        "t1",
        { path: "first.ts", oldPath: undefined },
      ),
    );

    await userEvent.click(await screen.findByRole("button", { name: /modified.*second\.ts/i }));
    expect(vi.mocked(api.getCommitRangeFileDiff)).toHaveBeenCalledWith("b1", "t1", { path: "second.ts", oldPath: undefined });
  });

  it("AC7: shows 'No files changed.' when the two commits' trees are identical", async () => {
    const api = makeMockGitHydra({
      commits: [makeCommit("t1", ["b1"]), makeCommit("b1", [])],
      compareChangedFiles: [],
    });
    render(<CompareView api={api} target={{ baseSha: "b1", targetSha: "t1" }} onClose={() => {}} onSwap={() => {}} />);

    expect(await screen.findByText("No files changed.")).toBeInTheDocument();
    expect(vi.mocked(api.getCommitRangeFileDiff)).not.toHaveBeenCalled();
  });

  it("AC12: the Swap control calls onSwap", async () => {
    const api = makeMockGitHydra({
      commits: [makeCommit("t1", ["b1"], { subject: "Target" }), makeCommit("b1", [], { subject: "Base" })],
    });
    const onSwap = vi.fn();
    render(<CompareView api={api} target={{ baseSha: "b1", targetSha: "t1" }} onClose={() => {}} onSwap={onSwap} />);

    await waitFor(() => expect(screen.getByText("Base")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /swap base and target/i }));
    expect(onSwap).toHaveBeenCalledTimes(1);
  });

  it("re-fetches everything when `target` changes identity (e.g. FR-193's Swap re-labeling, or FR-195's replace-in-place)", async () => {
    const api = makeMockGitHydra({
      commits: [
        makeCommit("t1", ["b1"], { subject: "Target one", message: "Target one" }),
        makeCommit("b1", [], { subject: "Base one", message: "Base one" }),
      ],
    });
    // Seed a second pair of commits reachable via getCommit (mock's allCommits includes both).
    vi.mocked(api.getCommit).mockImplementation((sha: string) => {
      const table: Record<string, ReturnType<typeof makeCommit>> = {
        b1: makeCommit("b1", [], { subject: "Base one", message: "Base one" }),
        t1: makeCommit("t1", ["b1"], { subject: "Target one", message: "Target one" }),
        t2: makeCommit("t2", [], { subject: "New target", message: "New target" }),
      };
      return Promise.resolve({ ok: true, data: table[sha] ?? null });
    });

    const { rerender } = render(
      <CompareView api={api} target={{ baseSha: "b1", targetSha: "t1" }} onClose={() => {}} onSwap={() => {}} />,
    );
    await waitFor(() => expect(screen.getByText("Target one")).toBeInTheDocument());

    rerender(<CompareView api={api} target={{ baseSha: "b1", targetSha: "t2" }} onClose={() => {}} onSwap={() => {}} />);
    await waitFor(() => expect(screen.getByText("New target")).toBeInTheDocument());
    expect(screen.queryByText("Target one")).not.toBeInTheDocument();
  });

  it("closing calls onClose", async () => {
    const api = makeMockGitHydra({ commits: [makeCommit("t1", ["b1"]), makeCommit("b1", [])] });
    const onClose = vi.fn();
    render(<CompareView api={api} target={{ baseSha: "b1", targetSha: "t1" }} onClose={onClose} onSwap={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /close compare view/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
