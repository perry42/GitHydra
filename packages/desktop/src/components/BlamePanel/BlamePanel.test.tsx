import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BlameLine, BlameResult } from "@githydra/git-core";
import { BlamePanel } from "./BlamePanel";
import { makeMockGitHydra } from "../../test/mockGitHydra";
import { makeCommit } from "../../test/fixtures";

function makeBlameLine(sha: string, lineNumber: number, overrides: Partial<BlameLine["commit"]> = {}): BlameLine {
  return {
    content: `line ${lineNumber} of ${sha}`,
    lineNumber,
    commit: {
      sha,
      abbrevSha: sha.slice(0, 7),
      authorName: "Ada Lovelace",
      authorEmail: "ada@example.com",
      authorDate: "2024-03-01T12:00:00+00:00",
      summary: `Commit ${sha}`,
      isBoundary: false,
      isUncommitted: false,
      ...overrides,
    },
  };
}

describe("BlamePanel", () => {
  it("shows a loading state, then bands contiguous same-commit lines into one block with metadata shown once (FR-132)", async () => {
    const result: BlameResult = {
      status: "ok",
      lines: [makeBlameLine("a".repeat(40), 1), makeBlameLine("a".repeat(40), 2), makeBlameLine("b".repeat(40), 3)],
    };
    const api = makeMockGitHydra({ blameResult: result });
    render(
      <BlamePanel
        api={api}
        target={{ path: "src/a.ts", revision: null }}
        onClose={() => {}}
        onReblame={() => {}}
        onJumpToCommit={() => {}}
      />,
    );

    expect(screen.getByText(/loading blame/i)).toBeInTheDocument();

    await waitFor(() => expect(screen.getByText("line 1 of aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBeInTheDocument());
    expect(screen.getByText("line 2 of aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBeInTheDocument();
    expect(screen.getByText("line 3 of bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")).toBeInTheDocument();

    // The first commit's abbrev sha appears exactly once (one block header for its 2 lines), not
    // once per line.
    expect(screen.getAllByText("aaaaaaa")).toHaveLength(1);
    expect(screen.getAllByText("bbbbbbb")).toHaveLength(1);
  });

  it("clicking a real block's commit metadata calls onJumpToCommit with that commit's sha (FR-134)", async () => {
    const sha = "c".repeat(40);
    const api = makeMockGitHydra({ blameResult: { status: "ok", lines: [makeBlameLine(sha, 1)] } });
    const onJump = vi.fn();
    render(
      <BlamePanel
        api={api}
        target={{ path: "src/a.ts", revision: null }}
        onClose={() => {}}
        onReblame={() => {}}
        onJumpToCommit={onJump}
      />,
    );

    const jumpButton = await screen.findByRole("button", { name: /ccccccc/ });
    await userEvent.click(jumpButton);
    expect(onJump).toHaveBeenCalledWith(sha);
  });

  it("renders the uncommitted-lines block distinctly, labeled 'Not Committed Yet', with no jump affordance (FR-135/FR-136)", async () => {
    const zeroSha = "0".repeat(40);
    const line = makeBlameLine(zeroSha, 1, { authorName: "Not Committed Yet", authorEmail: "not.committed.yet", isUncommitted: true });
    const api = makeMockGitHydra({ blameResult: { status: "ok", lines: [line] } });
    const onJump = vi.fn();
    render(
      <BlamePanel
        api={api}
        target={{ path: "src/a.ts", revision: null }}
        onClose={() => {}}
        onReblame={() => {}}
        onJumpToCommit={onJump}
      />,
    );

    await waitFor(() => expect(screen.getByText("Not Committed Yet")).toBeInTheDocument());
    // Not rendered as a button (no jump-to-commit affordance) — FR-135.
    expect(screen.queryByRole("button", { name: /Not Committed Yet/i })).not.toBeInTheDocument();
  });

  it.each([
    ["binary", { status: "binary" as const }, /binary file/i],
    ["too-large", { status: "too-large" as const, reason: "file-size" as const, fileSizeBytes: 5_000_000 }, /too large to blame inline/i],
    ["not-found", { status: "not-found" as const }, /does not exist/i],
    ["empty", { status: "empty" as const }, /file is empty/i],
  ])("renders an explicit named %s state, never a blank pane (FR-132)", async (_name, result, expected) => {
    const api = makeMockGitHydra({ blameResult: result as BlameResult });
    const { container } = render(
      <BlamePanel
        api={api}
        target={{ path: "src/a.ts", revision: null }}
        onClose={() => {}}
        onReblame={() => {}}
        onJumpToCommit={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByText(expected)).toBeInTheDocument());
    expect(container.querySelector(".gh-blame-panel__body")).not.toBeEmptyDOMElement();
  });

  it("surfaces a getFileBlame failure as an explicit error, not a blank pane", async () => {
    const api = makeMockGitHydra();
    vi.mocked(api.getFileBlame).mockResolvedValueOnce({
      ok: false,
      error: { name: "GitCommandError", message: "boom" },
    });
    render(
      <BlamePanel
        api={api}
        target={{ path: "src/a.ts", revision: null }}
        onClose={() => {}}
        onReblame={() => {}}
        onJumpToCommit={() => {}}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not load blame: boom/i);
  });

  it("expands the collapsible File history region (FR-133) and re-blames in place on row selection", async () => {
    const historyCommits = [
      makeCommit("h1111111".padEnd(40, "1"), [], { subject: "Second revision" }),
      makeCommit("h2222222".padEnd(40, "2"), [], { subject: "First revision" }),
    ];
    const api = makeMockGitHydra({
      blameResult: { status: "ok", lines: [makeBlameLine("a".repeat(40), 1)] },
      fileHistoryCommits: historyCommits,
    });
    const onReblame = vi.fn();
    render(
      <BlamePanel
        api={api}
        target={{ path: "src/a.ts", revision: null }}
        onClose={() => {}}
        onReblame={onReblame}
        onJumpToCommit={() => {}}
      />,
    );

    // Collapsed by default — no history rows visible yet.
    expect(screen.queryByText("Second revision")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /file history/i }));
    expect(await screen.findByText("Second revision")).toBeInTheDocument();
    expect(screen.getByText("First revision")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /first revision/i }));
    expect(onReblame).toHaveBeenCalledWith(historyCommits[1]!.sha);
  });

  it("re-blames against a new target when `target.revision` changes, without unmounting the panel (FR-133)", async () => {
    const shaA = "a".repeat(40);
    const shaB = "b".repeat(40);
    const api = makeMockGitHydra({ blameResult: { status: "ok", lines: [makeBlameLine(shaA, 1)] } });
    const { rerender } = render(
      <BlamePanel
        api={api}
        target={{ path: "src/a.ts", revision: null }}
        onClose={() => {}}
        onReblame={() => {}}
        onJumpToCommit={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getAllByText("aaaaaaa")).toHaveLength(1));

    vi.mocked(api.getFileBlame).mockResolvedValueOnce({
      ok: true,
      data: { status: "ok", lines: [makeBlameLine(shaB, 1)] },
    });
    rerender(
      <BlamePanel
        api={api}
        target={{ path: "src/a.ts", revision: shaA }}
        onClose={() => {}}
        onReblame={() => {}}
        onJumpToCommit={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getAllByText("bbbbbbb")).toHaveLength(1));
    expect(vi.mocked(api.getFileBlame)).toHaveBeenLastCalledWith("src/a.ts", shaA);
  });

  it("calls onClose from its close button", async () => {
    const api = makeMockGitHydra({ blameResult: { status: "empty" } });
    const onClose = vi.fn();
    render(
      <BlamePanel
        api={api}
        target={{ path: "src/a.ts", revision: null }}
        onClose={onClose}
        onReblame={() => {}}
        onJumpToCommit={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /close blame panel/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
