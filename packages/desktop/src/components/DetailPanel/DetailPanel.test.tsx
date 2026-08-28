import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DetailPanel } from "./DetailPanel";
import { makeCommit } from "../../test/fixtures";
import { makeMockGitHydra } from "../../test/mockGitHydra";
import type { CommitDetailState } from "../../hooks/useRepositoryGraph";

describe("DetailPanel", () => {
  it("renders nothing when idle", () => {
    const api = makeMockGitHydra();
    const { container } = render(
      <DetailPanel
        detail={{ status: "idle" }}
        isRepoDetachedHead={false}
        api={api}
        onJumpToParent={() => {}}
        onClose={() => {}}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a loading state", () => {
    const api = makeMockGitHydra();
    render(
      <DetailPanel
        detail={{ status: "loading", sha: "abcdef1234" }}
        isRepoDetachedHead={false}
        api={api}
        onJumpToParent={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/loading abcdef1234/i)).toBeInTheDocument();
  });

  it("shows message, author/committer, clickable parents, refs, and typed file list with counts (FR-13)", async () => {
    const api = makeMockGitHydra();
    const commit = makeCommit("c2", ["c1"], {
      subject: "Fix bug",
      body: "Details here.",
      message: "Fix bug\n\nDetails here.",
      refs: [{ name: "main", fullName: "refs/heads/main", type: "local-branch" }],
    });
    const detail: CommitDetailState = {
      status: "ready",
      commit,
      files: [
        { path: "src/a.ts", status: "modified" },
        { path: "src/b.ts", status: "added" },
        { path: "src/c.ts", oldPath: "src/old.ts", status: "renamed", similarity: 92 },
      ],
    };
    const onJump = vi.fn();
    render(
      <DetailPanel detail={detail} isRepoDetachedHead={false} api={api} onJumpToParent={onJump} onClose={() => {}} />,
    );

    expect(screen.getByText(/fix bug/i)).toBeInTheDocument();
    expect(screen.getByText(/changed files \(3\)/i)).toBeInTheDocument();
    // "src/a.ts" is auto-selected (Must-have #1), so it now also appears as the DiffView
    // heading — scope to the file-list button to avoid ambiguity.
    expect(screen.getByRole("button", { name: /modified.*src\/a\.ts/i })).toBeInTheDocument();
    expect(screen.getByText(/src\/old\.ts → src\/c\.ts/)).toBeInTheDocument();

    // Refs and the clickable parent SHA live in the metadata block, which is collapsed by
    // default (screen-space fix) — expand it first.
    await userEvent.click(screen.getByRole("button", { name: /expand commit metadata/i }));
    expect(screen.getByRole("img", { name: /local branch: main/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /c1/ }));
    expect(onJump).toHaveBeenCalledWith("c1");
  });

  it("automatically loads and shows the first changed file's diff once the commit is ready, with no click required (AC1)", async () => {
    const api = makeMockGitHydra({
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
            lines: [{ type: "add", content: "auto-selected content", oldLineNumber: null, newLineNumber: 1 }],
          },
        ],
      },
    });
    const commit = makeCommit("c1", []);
    const detail: CommitDetailState = {
      status: "ready",
      commit,
      files: [
        { path: "x.ts", status: "modified" },
        { path: "y.ts", status: "added" },
      ],
    };
    render(
      <DetailPanel detail={detail} isRepoDetachedHead={false} api={api} onJumpToParent={() => {}} onClose={() => {}} />,
    );

    expect(vi.mocked(api.getCommitFileDiff)).toHaveBeenCalledWith(
      { sha: "c1", parents: [] },
      { path: "x.ts", oldPath: undefined },
    );
    expect(vi.mocked(api.getCommitFileDiff)).not.toHaveBeenCalledWith(
      { sha: "c1", parents: [] },
      { path: "y.ts", oldPath: undefined },
    );
    await waitFor(() => expect(screen.getByText("auto-selected content")).toBeInTheDocument());
  });

  it("manually clicking a different file after auto-selection swaps the diff pane to that file, without fighting the auto-selection (AC6)", async () => {
    const api = makeMockGitHydra({ fileDiff: { status: "ok", isBinary: false, hunks: [] } });
    const commit = makeCommit("c1", []);
    const detail: CommitDetailState = {
      status: "ready",
      commit,
      files: [
        { path: "first.ts", status: "modified" },
        { path: "second.ts", status: "modified" },
      ],
    };
    render(
      <DetailPanel detail={detail} isRepoDetachedHead={false} api={api} onJumpToParent={() => {}} onClose={() => {}} />,
    );

    await waitFor(() =>
      expect(vi.mocked(api.getCommitFileDiff)).toHaveBeenCalledWith(
        { sha: "c1", parents: [] },
        { path: "first.ts", oldPath: undefined },
      ),
    );

    await userEvent.click(screen.getByRole("button", { name: /modified.*second\.ts/i }));
    expect(vi.mocked(api.getCommitFileDiff)).toHaveBeenCalledWith(
      { sha: "c1", parents: [] },
      { path: "second.ts", oldPath: undefined },
    );
    expect(screen.getByRole("button", { name: /modified.*second\.ts/i })).toHaveAttribute("aria-pressed", "true");
  });

  it("shows an explicit 'No diff found for this commit.' message for a commit with zero changed files (AC4)", () => {
    const api = makeMockGitHydra();
    const commit = makeCommit("c1", []);
    const detail: CommitDetailState = { status: "ready", commit, files: [] };
    render(
      <DetailPanel detail={detail} isRepoDetachedHead={false} api={api} onJumpToParent={() => {}} onClose={() => {}} />,
    );

    expect(screen.getByText("No files changed.")).toBeInTheDocument();
    expect(screen.getByText(/no diff found for this commit/i)).toBeInTheDocument();
    expect(screen.queryByText(/select a file to view its diff/i)).not.toBeInTheDocument();
    expect(vi.mocked(api.getCommitFileDiff)).not.toHaveBeenCalled();
  });

  it("switching from commit A to commit B updates in place — no unmount/remount, and the idle placeholder is never shown as an interstitial frame (AC3)", async () => {
    const api = makeMockGitHydra({ fileDiff: { status: "ok", isBinary: false, hunks: [] } });
    const detailA: CommitDetailState = {
      status: "ready",
      commit: makeCommit("a1", []),
      files: [{ path: "a.ts", status: "modified" }],
    };
    const detailB: CommitDetailState = {
      status: "ready",
      commit: makeCommit("b1", []),
      files: [{ path: "b.ts", status: "modified" }],
    };

    const { rerender } = render(
      <DetailPanel detail={detailA} isRepoDetachedHead={false} api={api} onJumpToParent={() => {}} onClose={() => {}} />,
    );
    const asideBefore = screen.getByRole("complementary", { name: "Commit details" });
    await waitFor(() =>
      expect(vi.mocked(api.getCommitFileDiff)).toHaveBeenCalledWith(
        { sha: "a1", parents: [] },
        { path: "a.ts", oldPath: undefined },
      ),
    );

    rerender(
      <DetailPanel detail={detailB} isRepoDetachedHead={false} api={api} onJumpToParent={() => {}} onClose={() => {}} />,
    );

    // Never shown as an interstitial frame between two ready commits that each have files.
    expect(screen.queryByText(/select a file to view its diff/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/no diff found/i)).not.toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Commit details" })).toBe(asideBefore);

    await waitFor(() =>
      expect(vi.mocked(api.getCommitFileDiff)).toHaveBeenCalledWith(
        { sha: "b1", parents: [] },
        { path: "b.ts", oldPath: undefined },
      ),
    );
  });

  it("navigating commit A -> B -> A again re-shows A's first file's diff each time, discarding any file manually selected on an earlier visit (AC9)", async () => {
    const api = makeMockGitHydra({ fileDiff: { status: "ok", isBinary: false, hunks: [] } });
    const detailA: CommitDetailState = {
      status: "ready",
      commit: makeCommit("a1", []),
      files: [
        { path: "a-first.ts", status: "modified" },
        { path: "a-second.ts", status: "modified" },
      ],
    };
    const detailB: CommitDetailState = {
      status: "ready",
      commit: makeCommit("b1", []),
      files: [{ path: "b.ts", status: "modified" }],
    };

    const { rerender } = render(
      <DetailPanel detail={detailA} isRepoDetachedHead={false} api={api} onJumpToParent={() => {}} onClose={() => {}} />,
    );
    await waitFor(() =>
      expect(vi.mocked(api.getCommitFileDiff)).toHaveBeenCalledWith(
        { sha: "a1", parents: [] },
        { path: "a-first.ts", oldPath: undefined },
      ),
    );

    // Manually pick the second file on this visit to A.
    await userEvent.click(screen.getByRole("button", { name: /modified.*a-second\.ts/i }));
    expect(vi.mocked(api.getCommitFileDiff)).toHaveBeenCalledWith(
      { sha: "a1", parents: [] },
      { path: "a-second.ts", oldPath: undefined },
    );

    rerender(
      <DetailPanel detail={detailB} isRepoDetachedHead={false} api={api} onJumpToParent={() => {}} onClose={() => {}} />,
    );
    await waitFor(() =>
      expect(vi.mocked(api.getCommitFileDiff)).toHaveBeenCalledWith(
        { sha: "b1", parents: [] },
        { path: "b.ts", oldPath: undefined },
      ),
    );

    vi.mocked(api.getCommitFileDiff).mockClear();
    rerender(
      <DetailPanel detail={detailA} isRepoDetachedHead={false} api={api} onJumpToParent={() => {}} onClose={() => {}} />,
    );

    // Fresh reselection of A always re-picks files[0] — not the previously manually-clicked file.
    await waitFor(() =>
      expect(vi.mocked(api.getCommitFileDiff)).toHaveBeenCalledWith(
        { sha: "a1", parents: [] },
        { path: "a-first.ts", oldPath: undefined },
      ),
    );
    expect(vi.mocked(api.getCommitFileDiff)).not.toHaveBeenCalledWith(
      { sha: "a1", parents: [] },
      { path: "a-second.ts", oldPath: undefined },
    );
  });

  it("the file list and diff pane are independently-scrolling regions (AC7)", () => {
    const api = makeMockGitHydra();
    const files = Array.from({ length: 12 }, (_, i) => ({ path: `file-${i}.ts`, status: "modified" as const }));
    const detail: CommitDetailState = { status: "ready", commit: makeCommit("c1", []), files };
    const { container } = render(
      <DetailPanel detail={detail} isRepoDetachedHead={false} api={api} onJumpToParent={() => {}} onClose={() => {}} />,
    );

    const filesRegion = container.querySelector<HTMLElement>(".gh-detail-panel__files")!;
    const diffRegion = container.querySelector<HTMLElement>(".gh-detail-panel__diff")!;
    expect(filesRegion).not.toBeNull();
    expect(diffRegion).not.toBeNull();
    expect(filesRegion).not.toBe(diffRegion);

    filesRegion.scrollTop = 120;
    diffRegion.scrollTop = 40;
    expect(filesRegion.scrollTop).toBe(120);
    expect(diffRegion.scrollTop).toBe(40);

    filesRegion.scrollTop = 0;
    expect(diffRegion.scrollTop).toBe(40);
  });

  it("commit metadata sits outside the scrolling file-list/diff split (AC8)", async () => {
    const api = makeMockGitHydra();
    const commit = makeCommit("c1", [], { subject: "Meta commit" });
    const detail: CommitDetailState = { status: "ready", commit, files: [{ path: "x.ts", status: "modified" }] };
    const { container } = render(
      <DetailPanel detail={detail} isRepoDetachedHead={false} api={api} onJumpToParent={() => {}} onClose={() => {}} />,
    );

    // The full SHA only renders once the (collapsed-by-default) metadata block is expanded.
    await userEvent.click(screen.getByRole("button", { name: /expand commit metadata/i }));

    const metaRegion = container.querySelector(".gh-detail-panel__meta-region")!;
    const splitRegion = container.querySelector(".gh-detail-panel__split")!;
    expect(metaRegion.querySelector(".gh-detail-panel__sha")).not.toBeNull();
    expect(splitRegion.contains(metaRegion)).toBe(false);
    expect(metaRegion.contains(splitRegion)).toBe(false);
  });

  it("the metadata block is collapsed by default, showing only a SHA + first message line summary", () => {
    const api = makeMockGitHydra();
    const commit = makeCommit("c1", [], { subject: "Meta commit", body: "More detail.", message: "Meta commit\n\nMore detail." });
    const detail: CommitDetailState = { status: "ready", commit, files: [{ path: "x.ts", status: "modified" }] };
    const { container } = render(
      <DetailPanel detail={detail} isRepoDetachedHead={false} api={api} onJumpToParent={() => {}} onClose={() => {}} />,
    );

    expect(screen.getByRole("button", { name: /expand commit metadata/i })).toBeInTheDocument();
    expect(screen.getByText(/meta commit/i)).toBeInTheDocument();
    expect(container.querySelector(".gh-detail-panel__meta-content")).toBeNull();
    expect(screen.queryByText(/more detail\./i)).not.toBeInTheDocument();
  });

  it("clicking a changed file fetches and shows that file's diff for the commit (FR-29, closes FR-13's deferred scope / AC4)", async () => {
    const api = makeMockGitHydra({
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
            lines: [{ type: "add", content: "hello", oldLineNumber: null, newLineNumber: 1 }],
          },
        ],
      },
    });
    const commit = makeCommit("c2", ["c1"]);
    const detail: CommitDetailState = {
      status: "ready",
      commit,
      files: [{ path: "src/a.ts", status: "modified" }],
    };
    render(
      <DetailPanel detail={detail} isRepoDetachedHead={false} api={api} onJumpToParent={() => {}} onClose={() => {}} />,
    );

    await userEvent.click(screen.getByRole("button", { name: /modified.*src\/a\.ts/i }));

    expect(vi.mocked(api.getCommitFileDiff)).toHaveBeenCalledWith(
      { sha: "c2", parents: ["c1"] },
      { path: "src/a.ts", oldPath: undefined },
    );
    await waitFor(() => expect(screen.getByText("hello")).toBeInTheDocument());
  });

  it("does NOT label HEAD as detached when the repo is on a normal branch tip (regression, AC4/AC7)", async () => {
    // git-core's commitLog.ts always attaches a `{ type: "head" }` decoration to whichever
    // commit HEAD currently resolves to, attached or not — DetailPanel must not treat that
    // decoration's mere presence as proof of a detached HEAD (it previously did).
    const api = makeMockGitHydra();
    const commit = makeCommit("c1", [], {
      refs: [
        { name: "main", fullName: "refs/heads/main", type: "local-branch" },
        { name: "HEAD", fullName: null, type: "head" },
      ],
    });
    const detail: CommitDetailState = { status: "ready", commit, files: [] };
    render(
      <DetailPanel detail={detail} isRepoDetachedHead={false} api={api} onJumpToParent={() => {}} onClose={() => {}} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /expand commit metadata/i }));

    expect(screen.getByRole("img", { name: /^HEAD:\s*HEAD$/i })).toBeInTheDocument();
    expect(screen.queryByText(/HEAD \(detached\)/i)).not.toBeInTheDocument();
  });

  it("does label HEAD as detached when the repo's HEAD is actually detached (AC4/AC7)", async () => {
    const api = makeMockGitHydra();
    const commit = makeCommit("c1", [], {
      refs: [{ name: "HEAD", fullName: null, type: "head" }],
    });
    const detail: CommitDetailState = { status: "ready", commit, files: [] };
    render(
      <DetailPanel detail={detail} isRepoDetachedHead={true} api={api} onJumpToParent={() => {}} onClose={() => {}} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /expand commit metadata/i }));

    expect(screen.getByText(/HEAD \(detached\)/i)).toBeInTheDocument();
  });
});
