import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WorkingDirectoryChanges } from "@githydra/git-core";
import { ChangesPanel } from "./ChangesPanel";
import { makeMockGitHydra } from "../../test/mockGitHydra";

function baseChanges(overrides: Partial<WorkingDirectoryChanges> = {}): WorkingDirectoryChanges {
  return { staged: [], unstaged: [], untracked: [], conflicted: [], ...overrides };
}

describe("ChangesPanel", () => {
  it("shows Staged/Unstaged/Untracked/Conflicted sections with per-file status and counts (AC1/AC9)", async () => {
    const api = makeMockGitHydra({
      workingDirectoryChanges: baseChanges({
        staged: [{ path: "a.ts", status: "modified", category: "staged" }],
        unstaged: [{ path: "b.ts", status: "modified", category: "unstaged" }],
        untracked: [{ path: "c.ts", status: "added", category: "untracked" }],
        conflicted: [{ path: "d.ts", status: "unmerged", category: "conflicted" }],
      }),
    });
    render(<ChangesPanel api={api} onClose={() => {}} onWorkingDirChanged={() => {}} onCommitCreated={() => {}} />);

    await waitFor(() => expect(screen.getByText("Staged (1)")).toBeInTheDocument());
    expect(screen.getByText("Unstaged (1)")).toBeInTheDocument();
    expect(screen.getByText("Untracked (1)")).toBeInTheDocument();
    expect(screen.getByText("Conflicted (1)")).toBeInTheDocument();
    // "a.ts" is the auto-selected (Must-have #2) staged file, so it now also appears as the
    // DiffView heading — scope to the file-list button to avoid ambiguity.
    expect(screen.getByRole("button", { name: /modified.*a\.ts/i })).toBeInTheDocument();

    // AC9: a conflicted file offers no stage/unstage control.
    const conflictedRow = screen.getByText("d.ts").closest<HTMLElement>(".gh-changes-panel__file")!;
    expect(within(conflictedRow).queryByRole("button")).not.toBeInTheDocument();
  });

  it("clicking an untracked file shows its content as an all-addition diff (AC2)", async () => {
    const api = makeMockGitHydra({
      workingDirectoryChanges: baseChanges({
        untracked: [{ path: "new.ts", status: "added", category: "untracked" }],
      }),
      fileDiff: {
        status: "ok",
        isBinary: false,
        hunks: [
          {
            header: "@@ -0,0 +1,1 @@",
            oldStart: 0,
            oldLines: 0,
            newStart: 1,
            newLines: 1,
            lines: [{ type: "add", content: "brand new content", oldLineNumber: null, newLineNumber: 1 }],
          },
        ],
      },
    });
    render(<ChangesPanel api={api} onClose={() => {}} onWorkingDirChanged={() => {}} onCommitCreated={() => {}} />);

    await waitFor(() => expect(screen.getByRole("button", { name: /added:.*new\.ts/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /added:.*new\.ts/i }));

    expect(vi.mocked(api.getUntrackedFileDiff)).toHaveBeenCalledWith("new.ts");
    await waitFor(() => expect(screen.getByText("brand new content")).toBeInTheDocument());
  });

  it("clicking an unstaged file's diff, then staging it and clicking it again, switches the diff source from unstaged to staged (AC3)", async () => {
    const api = makeMockGitHydra({
      workingDirectoryChanges: baseChanges({
        unstaged: [{ path: "a.ts", status: "modified", category: "unstaged" }],
      }),
    });
    vi.mocked(api.getUnstagedFileDiff).mockResolvedValue({
      ok: true,
      data: {
        status: "ok",
        isBinary: false,
        hunks: [
          {
            header: "@@ -1 +1 @@",
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: [{ type: "add", content: "worktree-vs-index content", oldLineNumber: null, newLineNumber: 1 }],
          },
        ],
      },
    });
    vi.mocked(api.getStagedFileDiff).mockResolvedValue({
      ok: true,
      data: {
        status: "ok",
        isBinary: false,
        hunks: [
          {
            header: "@@ -1 +1 @@",
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: [{ type: "add", content: "index-vs-HEAD content", oldLineNumber: null, newLineNumber: 1 }],
          },
        ],
      },
    });

    render(<ChangesPanel api={api} onClose={() => {}} onWorkingDirChanged={() => {}} onCommitCreated={() => {}} />);
    await waitFor(() => expect(screen.getByText("Unstaged (1)")).toBeInTheDocument());

    // Click the unstaged row's diff: worktree-vs-index source.
    await userEvent.click(screen.getByRole("button", { name: /modified.*a\.ts/i }));
    expect(vi.mocked(api.getUnstagedFileDiff)).toHaveBeenCalledWith("a.ts");
    await waitFor(() => expect(screen.getByText("worktree-vs-index content")).toBeInTheDocument());

    // Stage it — the file moves to the Staged section.
    await userEvent.click(screen.getByRole("button", { name: /^stage$/i }));
    await waitFor(() => expect(screen.getByText("Staged (1)")).toBeInTheDocument());

    // Click the now-staged row's diff: source must switch to index-vs-HEAD, not reuse the stale
    // unstaged result.
    await userEvent.click(screen.getByRole("button", { name: /modified.*a\.ts/i }));
    expect(vi.mocked(api.getStagedFileDiff)).toHaveBeenCalledWith("a.ts");
    await waitFor(() => expect(screen.getByText("index-vs-HEAD content")).toBeInTheDocument());
    expect(screen.queryByText("worktree-vs-index content")).not.toBeInTheDocument();
  });

  it("clicking Stage moves a file to Staged, and Unstage reverses it (AC5)", async () => {
    const api = makeMockGitHydra({
      workingDirectoryChanges: baseChanges({
        unstaged: [{ path: "b.ts", status: "modified", category: "unstaged" }],
      }),
    });
    render(<ChangesPanel api={api} onClose={() => {}} onWorkingDirChanged={() => {}} onCommitCreated={() => {}} />);

    await waitFor(() => expect(screen.getByText("Unstaged (1)")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /^stage$/i }));

    expect(vi.mocked(api.stageFile)).toHaveBeenCalledWith("b.ts");
    await waitFor(() => expect(screen.getByText("Staged (1)")).toBeInTheDocument());
    expect(screen.getByText("Unstaged (0)")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^unstage$/i }));
    expect(vi.mocked(api.unstageFile)).toHaveBeenCalledWith("b.ts");
    await waitFor(() => expect(screen.getByText("Unstaged (1)")).toBeInTheDocument());
  });

  it("reverts the optimistic move and surfaces an error when the git call fails (FR-30)", async () => {
    const api = makeMockGitHydra({
      workingDirectoryChanges: baseChanges({
        unstaged: [{ path: "b.ts", status: "modified", category: "unstaged" }],
      }),
    });
    vi.mocked(api.stageFile).mockResolvedValueOnce({
      ok: false,
      error: { name: "GitCommandError", message: "fatal: could not stage" },
    });

    render(<ChangesPanel api={api} onClose={() => {}} onWorkingDirChanged={() => {}} onCommitCreated={() => {}} />);
    await waitFor(() => expect(screen.getByText("Unstaged (1)")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /^stage$/i }));

    // Reverted: the file is back in Unstaged, not left showing as Staged.
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/could not stage/i));
    expect(screen.getByText("Unstaged (1)")).toBeInTheDocument();
    expect(screen.getByText("Staged (0)")).toBeInTheDocument();
  });

  it("stage-all and unstage-all act on every eligible file in one action (AC6)", async () => {
    const api = makeMockGitHydra({
      workingDirectoryChanges: baseChanges({
        unstaged: [{ path: "a.ts", status: "modified", category: "unstaged" }],
        untracked: [{ path: "b.ts", status: "added", category: "untracked" }],
      }),
    });
    render(<ChangesPanel api={api} onClose={() => {}} onWorkingDirChanged={() => {}} onCommitCreated={() => {}} />);

    await waitFor(() => expect(screen.getByText("Unstaged (1)")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /^stage all$/i }));

    expect(vi.mocked(api.stageAllFiles)).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByText("Staged (2)")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /^unstage all$/i }));
    expect(vi.mocked(api.unstageAllFiles)).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByText("Staged (0)")).toBeInTheDocument());
  });

  it("discarding an unstaged file's changes requires confirming a dialog naming the file; canceling leaves it untouched (AC7)", async () => {
    const api = makeMockGitHydra({
      workingDirectoryChanges: baseChanges({
        unstaged: [{ path: "b.ts", status: "modified", category: "unstaged" }],
      }),
    });
    render(<ChangesPanel api={api} onClose={() => {}} onWorkingDirChanged={() => {}} onCommitCreated={() => {}} />);
    await waitFor(() => expect(screen.getByText("Unstaged (1)")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /discard changes to b\.ts/i }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(/"b\.ts"/);
    expect(dialog).toHaveTextContent(/cannot be undone/i);

    // Cancel: no discard call, file untouched.
    await userEvent.click(within(dialog).getByRole("button", { name: /cancel/i }));
    expect(vi.mocked(api.discardTrackedFileChanges)).not.toHaveBeenCalled();
    expect(screen.getByText("Unstaged (1)")).toBeInTheDocument();

    // Confirm: calls the destructive method and the file leaves Unstaged.
    await userEvent.click(screen.getByRole("button", { name: /discard changes to b\.ts/i }));
    await userEvent.click(screen.getByRole("button", { name: /^discard$/i }));
    expect(vi.mocked(api.discardTrackedFileChanges)).toHaveBeenCalledWith("b.ts");
  });

  it("discarding an untracked file calls the untracked-specific discard method, not the tracked one", async () => {
    const api = makeMockGitHydra({
      workingDirectoryChanges: baseChanges({
        untracked: [{ path: "new.ts", status: "added", category: "untracked" }],
      }),
    });
    render(<ChangesPanel api={api} onClose={() => {}} onWorkingDirChanged={() => {}} onCommitCreated={() => {}} />);
    await waitFor(() => expect(screen.getByText("Untracked (1)")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /discard changes to new\.ts/i }));
    await userEvent.click(screen.getByRole("button", { name: /^discard$/i }));

    expect(vi.mocked(api.discardUntrackedFile)).toHaveBeenCalledWith("new.ts");
    expect(vi.mocked(api.discardTrackedFileChanges)).not.toHaveBeenCalled();
  });

  it("Commit is disabled at zero staged files or an empty subject, and enabled with both satisfied (AC8)", async () => {
    const api = makeMockGitHydra({
      workingDirectoryChanges: baseChanges({
        staged: [{ path: "a.ts", status: "modified", category: "staged" }],
      }),
    });
    render(<ChangesPanel api={api} onClose={() => {}} onWorkingDirChanged={() => {}} onCommitCreated={() => {}} />);
    await waitFor(() => expect(screen.getByText("Staged (1)")).toBeInTheDocument());

    const commitButton = screen.getByRole("button", { name: /^commit$/i });
    expect(commitButton).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/subject/i), "Fix the thing");
    expect(commitButton).toBeEnabled();
  });

  it("pressing Enter in the Subject field does NOT submit the commit (regression: silent accidental commit)", async () => {
    // A single-line <input> inside a <form> submits on plain Enter by default (HTML's implicit
    // submission), which would create a real commit without the user ever clicking "Commit" —
    // reported by a user as "the stage function immediately stages AND commits."
    const api = makeMockGitHydra({
      workingDirectoryChanges: baseChanges({
        staged: [{ path: "a.ts", status: "modified", category: "staged" }],
      }),
    });
    render(<ChangesPanel api={api} onClose={() => {}} onWorkingDirChanged={() => {}} onCommitCreated={() => {}} />);
    await waitFor(() => expect(screen.getByText("Staged (1)")).toBeInTheDocument());

    await userEvent.type(screen.getByLabelText(/subject/i), "Fix the thing{Enter}");

    expect(vi.mocked(api.createCommit)).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/subject/i)).toHaveValue("Fix the thing");

    // The explicit button click must still work.
    await userEvent.click(screen.getByRole("button", { name: /^commit$/i }));
    expect(vi.mocked(api.createCommit)).toHaveBeenCalledWith({ subject: "Fix the thing", body: undefined });
  });

  it("a successful commit clears the composer and shows zero staged files afterward (AC8)", async () => {
    const onCommitCreated = vi.fn();
    const api = makeMockGitHydra({
      workingDirectoryChanges: baseChanges({
        staged: [{ path: "a.ts", status: "modified", category: "staged" }],
      }),
    });
    render(
      <ChangesPanel api={api} onClose={() => {}} onWorkingDirChanged={() => {}} onCommitCreated={onCommitCreated} />,
    );
    await waitFor(() => expect(screen.getByText("Staged (1)")).toBeInTheDocument());

    await userEvent.type(screen.getByLabelText(/subject/i), "Fix the thing");
    await userEvent.click(screen.getByRole("button", { name: /^commit$/i }));

    expect(vi.mocked(api.createCommit)).toHaveBeenCalledWith({ subject: "Fix the thing", body: undefined });
    await waitFor(() => expect(screen.getByLabelText(/subject/i)).toHaveValue(""));
    expect(onCommitCreated).toHaveBeenCalledTimes(1);
  });

  it("shows an explicit 'no working directory' state for a bare repo, not an error or blank panel (AC10)", async () => {
    const api = makeMockGitHydra({ workingDirectoryChanges: null });
    render(<ChangesPanel api={api} onClose={() => {}} onWorkingDirChanged={() => {}} onCommitCreated={() => {}} />);
    await waitFor(() => expect(screen.getByText(/bare repository/i)).toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("auto-selects the first diffable file (Staged -> Unstaged -> Untracked order) once ready, with no click required (Must-have #2)", async () => {
    const api = makeMockGitHydra({
      workingDirectoryChanges: baseChanges({
        unstaged: [{ path: "unstaged.ts", status: "modified", category: "unstaged" }],
        untracked: [{ path: "untracked.ts", status: "added", category: "untracked" }],
      }),
    });
    render(<ChangesPanel api={api} onClose={() => {}} onWorkingDirChanged={() => {}} onCommitCreated={() => {}} />);

    await waitFor(() => expect(vi.mocked(api.getUnstagedFileDiff)).toHaveBeenCalledWith("unstaged.ts"));
    expect(vi.mocked(api.getUntrackedFileDiff)).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /modified.*unstaged\.ts/i })).toHaveAttribute("aria-pressed", "true");
  });

  it("shows an explicit 'No diff found.' message when the working directory has only Conflicted entries (AC5)", async () => {
    const api = makeMockGitHydra({
      workingDirectoryChanges: baseChanges({
        conflicted: [{ path: "d.ts", status: "unmerged", category: "conflicted" }],
      }),
    });
    render(<ChangesPanel api={api} onClose={() => {}} onWorkingDirChanged={() => {}} onCommitCreated={() => {}} />);

    await waitFor(() => expect(screen.getByText("Conflicted (1)")).toBeInTheDocument());
    expect(screen.getByText(/no diff found\./i)).toBeInTheDocument();
    expect(screen.queryByText(/select a file to view its diff/i)).not.toBeInTheDocument();
  });

  it("bumping reloadToken while already open forces a fresh reload and re-auto-selects the first diffable file, without unmounting the panel (Must-have #2/#3)", async () => {
    const api = makeMockGitHydra({
      workingDirectoryChanges: baseChanges({
        unstaged: [{ path: "a.ts", status: "modified", category: "unstaged" }],
      }),
    });
    const { rerender } = render(
      <ChangesPanel
        api={api}
        onClose={() => {}}
        onWorkingDirChanged={() => {}}
        onCommitCreated={() => {}}
        reloadToken={0}
      />,
    );
    const asideBefore = await screen.findByRole("complementary", { name: "Changes" });
    await waitFor(() => expect(vi.mocked(api.getWorkingDirectoryChanges)).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(vi.mocked(api.getUnstagedFileDiff)).toHaveBeenCalledWith("a.ts"));

    rerender(
      <ChangesPanel
        api={api}
        onClose={() => {}}
        onWorkingDirChanged={() => {}}
        onCommitCreated={() => {}}
        reloadToken={1}
      />,
    );

    // Same panel instance — not unmounted/remounted — but a fresh reload was triggered.
    expect(screen.getByRole("complementary", { name: "Changes" })).toBe(asideBefore);
    await waitFor(() => expect(vi.mocked(api.getWorkingDirectoryChanges).mock.calls.length).toBeGreaterThanOrEqual(2));
  });
});
