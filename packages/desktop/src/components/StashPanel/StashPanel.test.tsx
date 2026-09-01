import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StashPanel } from "./StashPanel";
import { makeMockGitHydra } from "../../test/mockGitHydra";
import { makeRepoState, makeStash } from "../../test/fixtures";

function noop() {}

describe("StashPanel", () => {
  it("lists every stash in stash@{0}-first order, showing message/branch/date (FR-94)", async () => {
    const api = makeMockGitHydra({
      stashes: [
        makeStash(0, { message: "WIP on main: abc1234 Latest work", branch: "main" }),
        makeStash(1, { message: "WIP on feature-x: def5678 Older work", branch: "feature-x" }),
      ],
    });
    render(
      <StashPanel
        api={api}
        repoState={makeRepoState()}
        onClose={noop}
        onRequestNewStash={noop}
        onMutated={noop}
        onMutationStart={noop}
        onMutationSettled={noop}
        onConflict={noop}
        createDisabledReason={null}
      />,
    );

    await waitFor(() => expect(screen.getByText(/latest work/i)).toBeInTheDocument());
    expect(screen.getByText(/older work/i)).toBeInTheDocument();
    expect(screen.getAllByText("main")[0]).toBeInTheDocument();
    expect(screen.getByText("feature-x")).toBeInTheDocument();
  });

  it("shows '(detached HEAD)' for a stash created with git's own default message while HEAD was detached (FR-94/edge cases)", async () => {
    const api = makeMockGitHydra({
      stashes: [makeStash(0, { branch: null, message: "WIP on (no branch): abc1234 Commit 0" })],
    });
    render(
      <StashPanel
        api={api}
        repoState={makeRepoState()}
        onClose={noop}
        onRequestNewStash={noop}
        onMutated={noop}
        onMutationStart={noop}
        onMutationSettled={noop}
        onConflict={noop}
        createDisabledReason={null}
      />,
    );
    await waitFor(() => expect(screen.getByText("(detached HEAD)")).toBeInTheDocument());
  });

  it("regression: a stash created with a custom message on a normal branch never claims '(detached HEAD)' (bug found via manual end-to-end testing)", async () => {
    // git-core's `branch` is `null` for ANY custom-message stash, whether or not HEAD was
    // actually detached at creation time — showing "(detached HEAD)" here would assert something
    // false about a repo that was really on "master".
    const api = makeMockGitHydra({
      stashes: [makeStash(0, { branch: null, message: "e2e test stash" })],
    });
    render(
      <StashPanel
        api={api}
        repoState={makeRepoState()}
        onClose={noop}
        onRequestNewStash={noop}
        onMutated={noop}
        onMutationStart={noop}
        onMutationSettled={noop}
        onConflict={noop}
        createDisabledReason={null}
      />,
    );
    await waitFor(() => expect(screen.getByText("e2e test stash")).toBeInTheDocument());
    expect(screen.queryByText("(detached HEAD)")).not.toBeInTheDocument();
    expect(screen.getByText(/unknown.*custom message/i)).toBeInTheDocument();
  });

  it("selecting a stash shows its diff read-only, with no stage/unstage controls (FR-95)", async () => {
    const api = makeMockGitHydra({
      stashes: [makeStash(0, { message: "WIP on main: abc1234 x" })],
      stashDiffs: {
        0: {
          files: [
            {
              path: "a.ts",
              status: "modified",
              isUntracked: false,
              diff: {
                status: "ok",
                isBinary: false,
                hunks: [
                  {
                    header: "@@ -1 +1 @@",
                    oldStart: 1,
                    oldLines: 1,
                    newStart: 1,
                    newLines: 1,
                    lines: [{ type: "add", content: "stashed content", oldLineNumber: null, newLineNumber: 1 }],
                  },
                ],
              },
            },
          ],
        },
      },
    });
    render(
      <StashPanel
        api={api}
        repoState={makeRepoState()}
        onClose={noop}
        onRequestNewStash={noop}
        onMutated={noop}
        onMutationStart={noop}
        onMutationSettled={noop}
        onConflict={noop}
        createDisabledReason={null}
      />,
    );

    await waitFor(() => expect(screen.getByText("stashed content")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /^stage$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^unstage$/i })).not.toBeInTheDocument();
  });

  it("Apply and Pop are always-visible, separate buttons carrying the spec's exact tooltip text, with no confirmation (FR-96)", async () => {
    const api = makeMockGitHydra({ stashes: [makeStash(0, { message: "WIP on main: abc1234 x" })] });
    render(
      <StashPanel
        api={api}
        repoState={makeRepoState()}
        onClose={noop}
        onRequestNewStash={noop}
        onMutated={noop}
        onMutationStart={noop}
        onMutationSettled={noop}
        onConflict={noop}
        createDisabledReason={null}
      />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: /^apply$/i })).toBeInTheDocument());

    const applyButton = screen.getByRole("button", { name: /^apply$/i });
    const popButton = screen.getByRole("button", { name: /^pop$/i });
    expect(applyButton).toHaveAttribute("title", "Apply this stash's changes, keep it in the list.");
    expect(popButton).toHaveAttribute("title", "Apply this stash's changes and remove it from the list.");

    await userEvent.click(applyButton);
    expect(vi.mocked(api.applyStash)).toHaveBeenCalledWith(0);
    // No ConfirmDialog for Apply/Pop.
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("Drop routes through ConfirmDialog naming the stash's message; canceling leaves it untouched (FR-97)", async () => {
    const api = makeMockGitHydra({ stashes: [makeStash(0, { message: "WIP on main: abc1234 important work" })] });
    render(
      <StashPanel
        api={api}
        repoState={makeRepoState()}
        onClose={noop}
        onRequestNewStash={noop}
        onMutated={noop}
        onMutationStart={noop}
        onMutationSettled={noop}
        onConflict={noop}
        createDisabledReason={null}
      />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: /^drop$/i })).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /^drop$/i }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(/important work/);

    await userEvent.click(within(dialog).getByRole("button", { name: /cancel/i }));
    expect(vi.mocked(api.dropStash)).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /^drop$/i }));
    const dialogAgain = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialogAgain).getByRole("button", { name: /^drop$/i }));
    expect(vi.mocked(api.dropStash)).toHaveBeenCalledWith(0);
  });

  it("a conflicting Apply calls onConflict('apply') and leaves the stash in the list, matching git's real pop-never-drops-on-conflict behavior for apply too (FR-96/AC11)", async () => {
    const onConflict = vi.fn();
    const onMutated = vi.fn();
    const api = makeMockGitHydra({ stashes: [makeStash(0, { message: "WIP on main: abc1234 x" })] });
    vi.mocked(api.applyStash).mockResolvedValueOnce({
      ok: true,
      data: { status: "conflict", conflictedPaths: ["a.ts"] },
    });
    render(
      <StashPanel
        api={api}
        repoState={makeRepoState()}
        onClose={noop}
        onRequestNewStash={noop}
        onMutated={onMutated}
        onMutationStart={noop}
        onMutationSettled={noop}
        onConflict={onConflict}
        createDisabledReason={null}
      />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: /^apply$/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /^apply$/i }));

    await waitFor(() => expect(onConflict).toHaveBeenCalledWith("apply", ["a.ts"]));
    expect(onMutated).toHaveBeenCalled();
  });

  it("disables 'New Stash…' with the caller's reason (FR-100)", async () => {
    const api = makeMockGitHydra({ stashes: [] });
    render(
      <StashPanel
        api={api}
        repoState={makeRepoState()}
        onClose={noop}
        onRequestNewStash={noop}
        onMutated={noop}
        onMutationStart={noop}
        onMutationSettled={noop}
        onConflict={noop}
        createDisabledReason="There are no changes to stash."
      />,
    );
    await waitFor(() => expect(screen.getByText(/no stashes yet/i)).toBeInTheDocument());
    const newStashButton = screen.getByRole("button", { name: /new stash/i });
    expect(newStashButton).toBeDisabled();
    expect(newStashButton).toHaveAttribute("title", "There are no changes to stash.");
  });

  it("shows an explicit 'no working directory' state on a bare repository, disabling stash actions (edge cases)", async () => {
    const api = makeMockGitHydra({ stashes: null });
    render(
      <StashPanel
        api={api}
        repoState={makeRepoState({ isBare: true, workdir: null })}
        onClose={noop}
        onRequestNewStash={noop}
        onMutated={noop}
        onMutationStart={noop}
        onMutationSettled={noop}
        onConflict={noop}
        createDisabledReason="This is a bare repository — it has no working directory, so there is nothing to stash."
      />,
    );
    await waitFor(() => expect(screen.getAllByText(/bare repository/i)[0]).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /^apply$/i })).not.toBeInTheDocument();
  });
});
