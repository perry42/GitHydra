// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MergeBranchPicker } from "./MergeBranchPicker";
import { makeLocalBranch, makeRepoState } from "../../test/fixtures";
import { makeMockGitHydra } from "../../test/mockGitHydra";

/** specs/branch-panel-drag-merge.md FR-437: the palette's "Merge branch into current branch…" picker. */
const HEAD = "b".repeat(40);
const TIP = "a".repeat(40);

function setup(opts: { relationship?: "diverged" | "a-ancestor-of-b" | "b-ancestor-of-a"; repoState?: ReturnType<typeof makeRepoState> } = {}) {
  const api = makeMockGitHydra({
    localBranches: [
      makeLocalBranch("main", { isCurrent: true, tipSha: HEAD }),
      makeLocalBranch("feature", { tipSha: TIP }),
    ],
    commitPairRelationship: opts.relationship ?? "diverged",
  });
  const onMerge = vi.fn();
  const onClose = vi.fn();
  render(
    <MergeBranchPicker
      api={api}
      repoState={opts.repoState ?? makeRepoState({ headSha: HEAD, currentBranch: "main" })}
      busy={false}
      onMerge={onMerge}
      onClose={onClose}
    />,
  );
  return { onMerge, onClose };
}

describe("MergeBranchPicker", () => {
  it("lists other local branches (never the current one) and merges the chosen one into the current branch", async () => {
    const { onMerge, onClose } = setup();
    expect(await screen.findByRole("option", { name: "feature" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "main" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("option", { name: "feature" }));
    await waitFor(() => expect(onMerge).toHaveBeenCalledWith(TIP, HEAD, "main"));
    expect(onClose).toHaveBeenCalled();
  });

  it("explains an 'Already up to date' outcome inline and runs nothing", async () => {
    const { onMerge, onClose } = setup({ relationship: "a-ancestor-of-b" });
    await userEvent.click(await screen.findByRole("option", { name: "feature" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Already up to date");
    expect(onMerge).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows the bare-repo reason up front and refuses to merge", async () => {
    const { onMerge } = setup({ repoState: makeRepoState({ headSha: HEAD, currentBranch: "main", isBare: true, workdir: null }) });
    expect(await screen.findByRole("status")).toHaveTextContent(/bare repository/i);
    await userEvent.click(await screen.findByRole("option", { name: "feature" }));
    expect(onMerge).not.toHaveBeenCalled();
  });

  it("Enter picks the highlighted branch from the keyboard", async () => {
    const { onMerge } = setup();
    await screen.findByRole("option", { name: "feature" });
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(onMerge).toHaveBeenCalledWith(TIP, HEAD, "main"));
  });
});
