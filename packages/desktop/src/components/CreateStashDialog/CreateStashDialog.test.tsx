// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WorkingDirectoryChanges } from "@githydra/git-core";
import { CreateStashDialog } from "./CreateStashDialog";
import { makeMockGitHydra } from "../../test/mockGitHydra";

function baseChanges(overrides: Partial<WorkingDirectoryChanges> = {}): WorkingDirectoryChanges {
  return { staged: [], unstaged: [], untracked: [], conflicted: [], ...overrides };
}

function noop() {}

describe("CreateStashDialog", () => {
  it("lists every staged/unstaged/untracked file, all checked by default, excluding conflicted paths (FR-99)", async () => {
    const api = makeMockGitHydra({
      workingDirectoryChanges: baseChanges({
        staged: [{ path: "a.ts", status: "modified", category: "staged" }],
        unstaged: [{ path: "b.ts", status: "modified", category: "unstaged" }],
        untracked: [{ path: "c.ts", status: "added", category: "untracked" }],
        conflicted: [{ path: "d.ts", status: "unmerged", category: "conflicted" }],
      }),
    });
    render(
      <CreateStashDialog api={api} isBare={false} isUnbornHead={false} onClose={noop} onCreated={noop} />,
    );

    await waitFor(() => expect(screen.getByText("a.ts")).toBeInTheDocument());
    expect(screen.getByText("b.ts")).toBeInTheDocument();
    expect(screen.getByText("c.ts")).toBeInTheDocument();
    expect(screen.queryByText("d.ts")).not.toBeInTheDocument();

    // Staged/unstaged checkboxes default checked; the untracked one starts visually unchecked
    // (and disabled) until "Include untracked files" is turned on (git's own default).
    expect(screen.getByLabelText(/a\.ts/i)).toBeChecked();
    expect(screen.getByLabelText(/b\.ts/i)).toBeChecked();
    expect(screen.getByLabelText(/c\.ts/i)).not.toBeChecked();
    expect(screen.getByLabelText(/c\.ts/i)).toBeDisabled();
  });

  it("'Include untracked files' defaults unchecked and re-enables the untracked checklist rows, all checked, once turned on (FR-99)", async () => {
    const api = makeMockGitHydra({
      workingDirectoryChanges: baseChanges({
        untracked: [{ path: "c.ts", status: "added", category: "untracked" }],
      }),
    });
    render(
      <CreateStashDialog api={api} isBare={false} isUnbornHead={false} onClose={noop} onCreated={noop} />,
    );
    await waitFor(() => expect(screen.getByText("c.ts")).toBeInTheDocument());

    const includeUntracked = screen.getByLabelText(/include untracked files/i);
    expect(includeUntracked).not.toBeChecked();

    await userEvent.click(includeUntracked);
    expect(screen.getByLabelText(/c\.ts/i)).toBeEnabled();
    expect(screen.getByLabelText(/c\.ts/i)).toBeChecked();
  });

  it("submits only the checked paths plus includeUntracked, and calls onCreated then onClose (AC1/AC2)", async () => {
    const onCreated = vi.fn();
    const onClose = vi.fn();
    const api = makeMockGitHydra({
      workingDirectoryChanges: baseChanges({
        staged: [{ path: "a.ts", status: "modified", category: "staged" }],
        unstaged: [{ path: "b.ts", status: "modified", category: "unstaged" }],
      }),
    });
    render(
      <CreateStashDialog api={api} isBare={false} isUnbornHead={false} onClose={onClose} onCreated={onCreated} />,
    );
    await waitFor(() => expect(screen.getByText("a.ts")).toBeInTheDocument());

    // Uncheck b.ts — only a.ts should be submitted.
    await userEvent.click(screen.getByLabelText(/b\.ts/i));
    await userEvent.type(screen.getByLabelText(/message/i), "my custom message");
    await userEvent.click(screen.getByRole("button", { name: /create stash/i }));

    await waitFor(() =>
      expect(vi.mocked(api.createStash)).toHaveBeenCalledWith({
        message: "my custom message",
        paths: ["a.ts"],
        includeUntracked: false,
      }),
    );
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("disables submit and shows an explicit empty state when there is nothing to stash (FR-100)", async () => {
    const api = makeMockGitHydra({ workingDirectoryChanges: baseChanges() });
    render(
      <CreateStashDialog api={api} isBare={false} isUnbornHead={false} onClose={noop} onCreated={noop} />,
    );
    await waitFor(() => expect(screen.getByText(/no changes to stash/i)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /create stash/i })).not.toBeInTheDocument();
  });

  it("shows an explicit message and no form on a bare repository, without calling getWorkingDirectoryChanges (FR-100)", async () => {
    const api = makeMockGitHydra({ workingDirectoryChanges: baseChanges() });
    render(<CreateStashDialog api={api} isBare={true} isUnbornHead={false} onClose={noop} onCreated={noop} />);
    expect(screen.getByText(/bare repository/i)).toBeInTheDocument();
    expect(vi.mocked(api.getWorkingDirectoryChanges)).not.toHaveBeenCalled();
  });

  it("shows an explicit message and no form on an unborn HEAD (AC6)", async () => {
    const api = makeMockGitHydra({ workingDirectoryChanges: baseChanges() });
    render(<CreateStashDialog api={api} isBare={false} isUnbornHead={true} onClose={noop} onCreated={noop} />);
    expect(screen.getByText(/no commits yet/i)).toBeInTheDocument();
    expect(vi.mocked(api.getWorkingDirectoryChanges)).not.toHaveBeenCalled();
  });

  it("surfaces a create failure (e.g. a repo-wide conflict) without closing the dialog", async () => {
    const onCreated = vi.fn();
    const onClose = vi.fn();
    const api = makeMockGitHydra({
      workingDirectoryChanges: baseChanges({
        staged: [{ path: "a.ts", status: "modified", category: "staged" }],
      }),
    });
    vi.mocked(api.createStash).mockResolvedValueOnce({
      ok: false,
      error: { name: "NothingEligibleToStashError", message: "Nothing is eligible to stash." },
    });
    render(
      <CreateStashDialog api={api} isBare={false} isUnbornHead={false} onClose={onClose} onCreated={onCreated} />,
    );
    await waitFor(() => expect(screen.getByText("a.ts")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /create stash/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/nothing is eligible to stash/i);
    expect(onCreated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
