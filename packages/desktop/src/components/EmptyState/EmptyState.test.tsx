import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
  it("shows an explicit, non-blank status message (AC7)", () => {
    render(<EmptyState title="No commits yet" description="This repository has no commits." />);
    expect(screen.getByRole("status")).toHaveTextContent("No commits yet");
    expect(screen.getByText(/this repository has no commits/i)).toBeInTheDocument();
  });

  // specs/repo-list.md
  describe("Recent repositories (specs/repo-list.md)", () => {
    it("AC9: renders no 'Recent repositories' section when recentRepos is empty/omitted", () => {
      render(<EmptyState title="No repository open" description="Choose a repository." />);
      expect(screen.queryByText("Recent repositories")).not.toBeInTheDocument();
    });

    it("Must-have 2: lists each recent path with its derived tab-label", () => {
      render(
        <EmptyState
          title="No repository open"
          description="Choose a repository."
          recentRepos={["/home/user/repoA", "/home/user/repoB"]}
        />,
      );
      expect(screen.getByText("Recent repositories")).toBeInTheDocument();
      expect(screen.getByText("repoA")).toBeInTheDocument();
      expect(screen.getByText("repoB")).toBeInTheDocument();
      expect(screen.getByTitle("/home/user/repoA")).toBeInTheDocument();
    });

    it("AC2: clicking an entry calls onOpenRecent with its path", async () => {
      const onOpenRecent = vi.fn();
      render(
        <EmptyState
          title="No repository open"
          description="Choose a repository."
          recentRepos={["/repoA"]}
          onOpenRecent={onOpenRecent}
        />,
      );
      await userEvent.click(screen.getByTitle("/repoA"));
      expect(onOpenRecent).toHaveBeenCalledWith("/repoA");
    });

    it("AC6: renders the inline 'not found' + 'remove from list' state for the matching entry only", async () => {
      const onRemoveRecent = vi.fn();
      render(
        <EmptyState
          title="No repository open"
          description="Choose a repository."
          recentRepos={["/repoA", "/repoGone"]}
          notFoundPath="/repoGone"
          onRemoveRecent={onRemoveRecent}
        />,
      );
      expect(screen.getByText(/not found/i)).toBeInTheDocument();
      // repoA is untouched — still a plain clickable button, not the not-found treatment.
      expect(screen.getByTitle("/repoA").tagName).toBe("BUTTON");

      await userEvent.click(screen.getByRole("button", { name: /remove from list/i }));
      expect(onRemoveRecent).toHaveBeenCalledWith("/repoGone");
    });

    it("disables (via busyPath) the specific entry whose open attempt is in flight", () => {
      render(
        <EmptyState
          title="No repository open"
          description="Choose a repository."
          recentRepos={["/repoA", "/repoB"]}
          busyPath="/repoA"
        />,
      );
      expect(screen.getByTitle("/repoA")).toBeDisabled();
      expect(screen.getByTitle("/repoB")).toBeEnabled();
    });
  });
});
