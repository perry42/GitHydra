import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DetailPanel } from "./DetailPanel";
import { makeCommit } from "../../test/fixtures";
import type { CommitDetailState } from "../../hooks/useRepositoryGraph";

describe("DetailPanel", () => {
  it("renders nothing when idle", () => {
    const { container } = render(
      <DetailPanel detail={{ status: "idle" }} isRepoDetachedHead={false} onJumpToParent={() => {}} onClose={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a loading state", () => {
    render(
      <DetailPanel
        detail={{ status: "loading", sha: "abcdef1234" }}
        isRepoDetachedHead={false}
        onJumpToParent={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/loading abcdef1234/i)).toBeInTheDocument();
  });

  it("shows message, author/committer, clickable parents, refs, and typed file list with counts (FR-13)", async () => {
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
    render(<DetailPanel detail={detail} isRepoDetachedHead={false} onJumpToParent={onJump} onClose={() => {}} />);

    expect(screen.getByText(/fix bug/i)).toBeInTheDocument();
    expect(screen.getByText(/changed files \(3\)/i)).toBeInTheDocument();
    expect(screen.getByText("src/a.ts")).toBeInTheDocument();
    expect(screen.getByText(/src\/old\.ts → src\/c\.ts/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /local branch: main/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /c1/ }));
    expect(onJump).toHaveBeenCalledWith("c1");
  });

  it("shows no diff content — only metadata and file list (non-goal check)", () => {
    const commit = makeCommit("c1", []);
    const detail: CommitDetailState = { status: "ready", commit, files: [{ path: "x.ts", status: "modified" }] };
    render(<DetailPanel detail={detail} isRepoDetachedHead={false} onJumpToParent={() => {}} onClose={() => {}} />);
    expect(screen.queryByText(/^\+/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^-/)).not.toBeInTheDocument();
  });

  it("does NOT label HEAD as detached when the repo is on a normal branch tip (regression, AC4/AC7)", () => {
    // git-core's commitLog.ts always attaches a `{ type: "head" }` decoration to whichever
    // commit HEAD currently resolves to, attached or not — DetailPanel must not treat that
    // decoration's mere presence as proof of a detached HEAD (it previously did).
    const commit = makeCommit("c1", [], {
      refs: [
        { name: "main", fullName: "refs/heads/main", type: "local-branch" },
        { name: "HEAD", fullName: null, type: "head" },
      ],
    });
    const detail: CommitDetailState = { status: "ready", commit, files: [] };
    render(<DetailPanel detail={detail} isRepoDetachedHead={false} onJumpToParent={() => {}} onClose={() => {}} />);

    expect(screen.getByRole("img", { name: /^HEAD:\s*HEAD$/i })).toBeInTheDocument();
    expect(screen.queryByText(/HEAD \(detached\)/i)).not.toBeInTheDocument();
  });

  it("does label HEAD as detached when the repo's HEAD is actually detached (AC4/AC7)", () => {
    const commit = makeCommit("c1", [], {
      refs: [{ name: "HEAD", fullName: null, type: "head" }],
    });
    const detail: CommitDetailState = { status: "ready", commit, files: [] };
    render(<DetailPanel detail={detail} isRepoDetachedHead={true} onJumpToParent={() => {}} onClose={() => {}} />);

    expect(screen.getByText(/HEAD \(detached\)/i)).toBeInTheDocument();
  });
});
