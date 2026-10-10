// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StatusBanner } from "./StatusBanner";
import { makeRepoState } from "../../test/fixtures";
import { makeMockGitHydra } from "../../test/mockGitHydra";

// specs/mid-merge-landing.md FR-577/578.
const merge = makeRepoState({
  inProgressOperation: "merge",
  currentBranch: "main",
  inProgressOperationDetail: {
    kind: "merge",
    incomingRef: "feature",
    mergeHeadSha: "a".repeat(40),
    headSha: "b".repeat(40),
    headSubject: null,
  } as never,
});
const wd = (conflicted: number) => ({ hasChanges: true, staged: 0, unstaged: 0, untracked: 0, conflicted });

describe("conflict landing banner", () => {
  it("is a labelled region with the bold headline, conflict count, primary Resolve and a blocked Continue with its reason", async () => {
    const onResolve = vi.fn();
    render(
      <StatusBanner
        repoState={merge}
        hasExternalChanges={false}
        onRefresh={() => {}}
        api={makeMockGitHydra()}
        workingDirStatus={wd(2)}
        onResolveConflicts={onResolve}
      />,
    );
    const region = screen.getByRole("region", { name: "Merge in progress" });
    expect(within(region).getByRole("status")).toHaveTextContent("Merge in progress: feature into main");
    expect(region).toHaveTextContent("2 files have conflicts");
    const cont = within(region).getByRole("button", { name: /^continue$/i });
    expect(cont).toBeDisabled();
    expect(cont).toHaveAccessibleDescription(/2 conflicted files remain unresolved/);
    await userEvent.click(within(region).getByRole("button", { name: "Resolve conflicts (2)" }));
    expect(onResolve).toHaveBeenCalledTimes(1);
  });

  it("turns into the calm 'All conflicts resolved' state with Continue merge and no Resolve button at 0 left", () => {
    const props = { repoState: merge, hasExternalChanges: false, onRefresh: () => {}, api: makeMockGitHydra(), onResolveConflicts: () => {} };
    const { rerender } = render(<StatusBanner {...props} workingDirStatus={wd(1)} />);
    rerender(<StatusBanner {...props} workingDirStatus={wd(0)} />);
    expect(screen.getByRole("status")).toHaveTextContent("All conflicts resolved");
    expect(screen.queryByRole("button", { name: /resolve conflicts/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue merge" })).toBeEnabled();
  });

  it("uses cherry-pick wording and never claims 'all resolved' when no conflict was ever seen", () => {
    render(
      <StatusBanner
        repoState={makeRepoState({
          inProgressOperation: "cherry-pick",
          inProgressOperationDetail: {
            kind: "cherry-pick",
            targetSha: "c".repeat(40),
            targetSubject: "Fix it",
            remainingAfterCurrent: 2,
          } as never,
        })}
        hasExternalChanges={false}
        onRefresh={() => {}}
        api={makeMockGitHydra()}
        workingDirStatus={wd(0)}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent('Cherry-pick in progress: ccccccc "Fix it" (2 more queued)');
    expect(screen.getByRole("status")).not.toHaveTextContent("All conflicts resolved");
  });
});
