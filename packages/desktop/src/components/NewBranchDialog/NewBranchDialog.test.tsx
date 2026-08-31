import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RefInfo } from "@githydra/git-core";
import { NewBranchDialog } from "./NewBranchDialog";
import { makeMockGitHydra } from "../../test/mockGitHydra";
import { makeCommit } from "../../test/fixtures";

function makeRef(overrides: Partial<RefInfo>): RefInfo {
  return {
    fullName: "refs/heads/main",
    shortName: "main",
    type: "local-branch",
    targetCommitSha: "abc1234abc1234abc1234abc1234abc1234abc1",
    isAnnotatedTag: false,
    isSymbolic: false,
    ...overrides,
  };
}

describe("NewBranchDialog", () => {
  it("creates a branch from HEAD with the default (unchecked switch, hasWorkdir) settings (AC1)", async () => {
    const api = makeMockGitHydra();
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(
      <NewBranchDialog
        api={api}
        refs={[]}
        hasWorkdir
        isEmptyRepo={false} isUnbornHead={false}
        onClose={onClose}
        onCreated={onCreated}
      />,
    );

    await userEvent.type(screen.getByLabelText(/branch name/i), "feature/new-thing");
    await userEvent.click(screen.getByRole("button", { name: /create branch/i }));

    await waitFor(() =>
      expect(vi.mocked(api.createBranch)).toHaveBeenCalledWith({
        name: "feature/new-thing",
        startPoint: undefined,
        switchToIt: true,
      }),
    );
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid name before ever calling createBranch (FR-35/AC5)", async () => {
    const api = makeMockGitHydra();
    vi.mocked(api.validateBranchName).mockResolvedValueOnce({
      ok: false,
      error: { name: "InvalidRefNameError", message: '"bad name" is not a valid branch name: contains a space' },
    });
    render(<NewBranchDialog api={api} refs={[]} hasWorkdir isEmptyRepo={false} isUnbornHead={false} onClose={() => {}} onCreated={() => {}} />);

    await userEvent.type(screen.getByLabelText(/branch name/i), "bad name");
    await userEvent.click(screen.getByRole("button", { name: /create branch/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/not a valid branch name/i);
    expect(vi.mocked(api.createBranch)).not.toHaveBeenCalled();
  });

  it("passes the pre-filled start point through unchanged when opened from 'Create branch here' (FR-54/AC2)", async () => {
    const api = makeMockGitHydra();
    render(
      <NewBranchDialog
        api={api}
        refs={[]}
        hasWorkdir
        isEmptyRepo={false} isUnbornHead={false}
        defaultStartPoint={{ value: "deadbeef", label: "Commit deadbee" }}
        onClose={() => {}}
        onCreated={() => {}}
      />,
    );

    expect(screen.getByRole("option", { name: "Commit deadbee" })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/branch name/i), "from-commit");
    await userEvent.click(screen.getByRole("button", { name: /create branch/i }));

    await waitFor(() =>
      expect(vi.mocked(api.createBranch)).toHaveBeenCalledWith(
        expect.objectContaining({ name: "from-commit", startPoint: "deadbeef" }),
      ),
    );
  });

  it("lets the start point be set to an existing remote-tracking branch (AC4)", async () => {
    const api = makeMockGitHydra();
    const refs: RefInfo[] = [
      makeRef({
        fullName: "refs/remotes/origin/feature-x",
        shortName: "origin/feature-x",
        type: "remote-branch",
        remoteName: "origin",
      }),
    ];
    render(<NewBranchDialog api={api} refs={refs} hasWorkdir isEmptyRepo={false} isUnbornHead={false} onClose={() => {}} onCreated={() => {}} />);

    await userEvent.type(screen.getByLabelText(/branch name/i), "feature-x");
    await userEvent.selectOptions(screen.getByLabelText(/start point/i), "origin/feature-x");
    await userEvent.click(screen.getByRole("button", { name: /create branch/i }));

    await waitFor(() =>
      expect(vi.mocked(api.createBranch)).toHaveBeenCalledWith(
        expect.objectContaining({ name: "feature-x", startPoint: "origin/feature-x" }),
      ),
    );
  });

  it("hides the working directory from switching (unchecked, disabled) and explains why on a bare repo (FR-49)", () => {
    const api = makeMockGitHydra();
    render(<NewBranchDialog api={api} refs={[]} hasWorkdir={false} isEmptyRepo={false} isUnbornHead={false} onClose={() => {}} onCreated={() => {}} />);

    const checkbox = screen.getByRole("checkbox", { name: /switch to the new branch/i });
    expect(checkbox).toBeDisabled();
    expect(checkbox).not.toBeChecked();
    expect(screen.getByText(/bare repository/i)).toBeInTheDocument();
  });

  it("reflects an unborn-HEAD/zero-commit repo with an explicit message instead of a form (AC12)", () => {
    const api = makeMockGitHydra();
    const onClose = vi.fn();
    render(<NewBranchDialog api={api} refs={[]} hasWorkdir isEmptyRepo isUnbornHead onClose={onClose} onCreated={() => {}} />);

    expect(screen.getByText(/no commits yet/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/branch name/i)).not.toBeInTheDocument();

    return userEvent.click(screen.getByRole("button", { name: /close/i })).then(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it("never defaults the start-point picker to HEAD when HEAD is unborn but other branches have commits (bare repo whose default branch was never pushed)", async () => {
    // Manual verification (real Electron app, real bare repo) caught this: HEAD can point at a
    // branch name that was never actually pushed while other branches have real history — a
    // default selection of "HEAD (current)" is then guaranteed to fail with a raw git error.
    const api = makeMockGitHydra();
    const refs: RefInfo[] = [makeRef({ shortName: "main", fullName: "refs/heads/main" })];
    render(
      <NewBranchDialog
        api={api}
        refs={refs}
        hasWorkdir={false}
        isEmptyRepo={false}
        isUnbornHead
        onClose={() => {}}
        onCreated={() => {}}
      />,
    );

    const select = screen.getByLabelText(/start point/i) as HTMLSelectElement;
    expect(select.value).toBe("main");
    expect(screen.getByRole("option", { name: /HEAD.*no commit yet/i })).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/branch name/i), "from-main");
    await userEvent.click(screen.getByRole("button", { name: /create branch/i }));
    await waitFor(() =>
      expect(vi.mocked(api.createBranch)).toHaveBeenCalledWith(
        expect.objectContaining({ name: "from-main", startPoint: "main" }),
      ),
    );
  });

  it("passes the new branch's tip sha to onCreated when 'switch to it' moved HEAD (specs/graph-head-indicator-and-refresh-alerting.md Problem 1)", async () => {
    const api = makeMockGitHydra({ commits: [makeCommit("c1", [], { subject: "Only commit" })] });
    const onCreated = vi.fn();
    render(
      <NewBranchDialog
        api={api}
        refs={[]}
        hasWorkdir
        isEmptyRepo={false}
        isUnbornHead={false}
        onClose={() => {}}
        onCreated={onCreated}
      />,
    );

    // Default: hasWorkdir true seeds the "switch to new branch" checkbox checked.
    expect(screen.getByRole("checkbox", { name: /switch to the new branch/i })).toBeChecked();
    await userEvent.type(screen.getByLabelText(/branch name/i), "feature/switches");
    await userEvent.click(screen.getByRole("button", { name: /create branch/i }));

    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith({ sha: "c1", currentBranch: "feature/switches" }),
    );
  });

  it("passes no sha to onCreated when 'switch to it' is unchecked, since HEAD never moved", async () => {
    const api = makeMockGitHydra({ commits: [makeCommit("c1", [], { subject: "Only commit" })] });
    const onCreated = vi.fn();
    render(
      <NewBranchDialog
        api={api}
        refs={[]}
        hasWorkdir
        isEmptyRepo={false}
        isUnbornHead={false}
        onClose={() => {}}
        onCreated={onCreated}
      />,
    );

    await userEvent.click(screen.getByRole("checkbox", { name: /switch to the new branch/i }));
    await userEvent.type(screen.getByLabelText(/branch name/i), "feature/no-switch");
    await userEvent.click(screen.getByRole("button", { name: /create branch/i }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(onCreated).toHaveBeenCalledWith(undefined);
  });

  it("Escape closes the dialog", async () => {
    const api = makeMockGitHydra();
    const onClose = vi.fn();
    render(<NewBranchDialog api={api} refs={[]} hasWorkdir isEmptyRepo={false} isUnbornHead={false} onClose={onClose} onCreated={() => {}} />);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
