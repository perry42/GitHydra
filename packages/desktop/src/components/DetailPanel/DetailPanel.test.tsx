import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  describe("Blame context menu (specs/blame.md FR-131)", () => {
    function readyDetail(): CommitDetailState {
      const commit = makeCommit("c1", ["p1"], { subject: "Fix bug" });
      return {
        status: "ready",
        commit,
        files: [{ path: "src/a.ts", status: "modified" }],
      };
    }

    it("right-clicking a changed-file row offers an enabled Blame action that blames THIS commit's sha, not the working tree", async () => {
      const api = makeMockGitHydra();
      const onOpenBlame = vi.fn();
      const detail = readyDetail();
      render(
        <DetailPanel
          detail={detail}
          isRepoDetachedHead={false}
          api={api}
          onJumpToParent={() => {}}
          onClose={() => {}}
          onOpenBlame={onOpenBlame}
        />,
      );

      const row = screen.getByRole("button", { name: /modified.*src\/a\.ts/i }).closest<HTMLElement>(".gh-detail-panel__file")!;
      fireEvent.contextMenu(row, { clientX: 5, clientY: 5 });
      const blameItem = await screen.findByRole("menuitem", { name: "Blame" });
      expect(blameItem).toBeEnabled();

      await userEvent.click(blameItem);
      expect(onOpenBlame).toHaveBeenCalledWith("src/a.ts", "c1");
    });

    it("shows Blame disabled with a reason when no onOpenBlame handler is wired, never hidden", async () => {
      const api = makeMockGitHydra();
      const detail = readyDetail();
      render(
        <DetailPanel detail={detail} isRepoDetachedHead={false} api={api} onJumpToParent={() => {}} onClose={() => {}} />,
      );

      const row = screen.getByRole("button", { name: /modified.*src\/a\.ts/i }).closest<HTMLElement>(".gh-detail-panel__file")!;
      fireEvent.contextMenu(row, { clientX: 5, clientY: 5 });
      const blameItem = await screen.findByRole("menuitem", { name: "Blame" });
      expect(blameItem).toBeDisabled();
      expect(blameItem).toHaveAttribute("title", expect.stringMatching(/unavailable/i));
    });
  });

  // specs/image-diff-preview.md FR-144: same rendering, IPC method, and eligibility rules as
  // ChangesPanel (see ChangesPanel.test.tsx's own "image diff preview" suite) — AC9 (parity)
  // is the two suites exercising the identical scenarios against the two different callers.
  describe("image diff preview", () => {
    it("AC1/AC4: a modified/renamed .ico in a historical commit shows Before/After images sourced from the old/new path", async () => {
      const api = makeMockGitHydra({
        imageDiff: {
          status: "ok",
          old: { base64: "b2xk", byteSize: 10, mimeType: "image/x-icon" },
          new: { base64: "bmV3", byteSize: 20, mimeType: "image/x-icon" },
        },
      });
      const commit = makeCommit("c1", ["p1"]);
      const detail: CommitDetailState = {
        status: "ready",
        commit,
        files: [{ path: "new.ico", oldPath: "old.ico", status: "renamed", similarity: 80 }],
      };
      render(
        <DetailPanel detail={detail} isRepoDetachedHead={false} api={api} onJumpToParent={() => {}} onClose={() => {}} />,
      );

      await waitFor(() =>
        expect(vi.mocked(api.getCommitImageDiff)).toHaveBeenCalledWith(
          { sha: "c1", parents: ["p1"] },
          { path: "new.ico", oldPath: "old.ico" },
        ),
      );
      expect(vi.mocked(api.getCommitFileDiff)).not.toHaveBeenCalled();
      const images = await screen.findAllByRole("img");
      expect(images).toHaveLength(2);
      expect(images[0]).toHaveAttribute("src", "data:image/x-icon;base64,b2xk");
      expect(images[1]).toHaveAttribute("src", "data:image/x-icon;base64,bmV3");
    });

    it("AC3: a deleted .gif in a historical commit shows only the old image, labeled Deleted", async () => {
      const api = makeMockGitHydra({
        imageDiff: { status: "ok", old: { base64: "b2xk", byteSize: 5, mimeType: "image/gif" }, new: null },
      });
      const commit = makeCommit("c1", ["p1"]);
      const detail: CommitDetailState = {
        status: "ready",
        commit,
        files: [{ path: "removed.gif", status: "deleted" }],
      };
      render(
        <DetailPanel detail={detail} isRepoDetachedHead={false} api={api} onJumpToParent={() => {}} onClose={() => {}} />,
      );

      await waitFor(() => expect(vi.mocked(api.getCommitImageDiff)).toHaveBeenCalled());
      expect(screen.getByText(/Deleted · 5 B/, { selector: "figcaption" })).toBeInTheDocument();
      expect(screen.getAllByRole("img")).toHaveLength(1);
    });

    it("AC6: a non-image binary (.zip) in a historical commit is unaffected — keeps the generic Binary file message", async () => {
      const api = makeMockGitHydra({ fileDiff: { status: "binary", isBinary: true } });
      const commit = makeCommit("c1", ["p1"]);
      const detail: CommitDetailState = {
        status: "ready",
        commit,
        files: [{ path: "archive.zip", status: "modified" }],
      };
      render(
        <DetailPanel detail={detail} isRepoDetachedHead={false} api={api} onJumpToParent={() => {}} onClose={() => {}} />,
      );

      await waitFor(() => expect(vi.mocked(api.getCommitFileDiff)).toHaveBeenCalled());
      expect(vi.mocked(api.getCommitImageDiff)).not.toHaveBeenCalled();
      expect(await screen.findByText(/binary file/i)).toBeInTheDocument();
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
    });

    it("AC7: an oversized image side in a historical commit shows the existing too-large state", async () => {
      const api = makeMockGitHydra({ imageDiff: { status: "too-large", side: "old" } });
      const commit = makeCommit("c1", ["p1"]);
      const detail: CommitDetailState = {
        status: "ready",
        commit,
        files: [{ path: "huge.bmp", status: "modified" }],
      };
      render(
        <DetailPanel detail={detail} isRepoDetachedHead={false} api={api} onJumpToParent={() => {}} onClose={() => {}} />,
      );

      expect(await screen.findByText(/too large to display inline/i)).toBeInTheDocument();
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
    });

    it("manually clicking between an image-eligible file and a text file swaps DiffView content, never showing both", async () => {
      const api = makeMockGitHydra({
        imageDiff: { status: "ok", old: null, new: { base64: "cG5n", byteSize: 4, mimeType: "image/png" } },
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
              lines: [{ type: "add", content: "text content", oldLineNumber: null, newLineNumber: 1 }],
            },
          ],
        },
      });
      const commit = makeCommit("c1", []);
      const detail: CommitDetailState = {
        status: "ready",
        commit,
        files: [
          { path: "first.png", status: "added" },
          { path: "second.ts", status: "added" },
        ],
      };
      render(
        <DetailPanel detail={detail} isRepoDetachedHead={false} api={api} onJumpToParent={() => {}} onClose={() => {}} />,
      );

      await waitFor(() => expect(screen.getByRole("img")).toBeInTheDocument());

      await userEvent.click(screen.getByRole("button", { name: /added.*second\.ts/i }));
      await waitFor(() => expect(screen.getByText("text content")).toBeInTheDocument());
      expect(screen.queryByRole("img")).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: /added.*first\.png/i }));
      await waitFor(() => expect(screen.getByRole("img")).toBeInTheDocument());
      expect(screen.queryByText("text content")).not.toBeInTheDocument();
    });
  });
});
