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

    it("AC6 (revised — Try again): clicking 'Try again' on a not-found entry re-attempts the same path", async () => {
      const onOpenRecent = vi.fn();
      render(
        <EmptyState
          title="No repository open"
          description="Choose a repository."
          recentRepos={["/repoGone"]}
          notFoundPath="/repoGone"
          onOpenRecent={onOpenRecent}
        />,
      );
      await userEvent.click(screen.getByRole("button", { name: /try again/i }));
      expect(onOpenRecent).toHaveBeenCalledWith("/repoGone");
    });
  });

  // specs/repo-list.md Must-have 2/AC10/AC11 (revised IA): the landing screen is the single
  // surface for opening a repo — "Open a repository" (real) plus a visually reserved, inert
  // "Clone a repository" slot.
  describe("landing-screen actions (specs/repo-list.md, revised IA)", () => {
    it("renders no actions row at all when onBrowse is omitted (the 'No commits yet'/'No matching commits' usages)", () => {
      render(<EmptyState title="No commits yet" description="This repository has no commits." />);
      expect(screen.queryByRole("button", { name: /open a repository/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /clone a repository/i })).not.toBeInTheDocument();
    });

    it("Must-have 2: shows 'Open a repository' and calls onBrowse when clicked — no native dialog wiring here, just the callback", async () => {
      const onBrowse = vi.fn();
      render(<EmptyState title="No repository open" description="Choose a repository." onBrowse={onBrowse} />);
      await userEvent.click(screen.getByRole("button", { name: "Open a repository" }));
      expect(onBrowse).toHaveBeenCalledTimes(1);
    });

    it("Must-have 2/AC11: shows a visually reserved 'Clone a repository' action that is genuinely disabled with no click handler — not an active roadmap promise, never a dead-but-enabled click target", async () => {
      const onBrowse = vi.fn();
      render(<EmptyState title="No repository open" description="Choose a repository." onBrowse={onBrowse} />);
      const clone = screen.getByRole("button", { name: /clone a repository/i });
      expect(clone).toBeDisabled();
      expect(clone).toHaveAttribute("aria-disabled", "true");
      // specs/repo-list.md Non-goals: "not a commitment to build it next" — the tooltip must not
      // read as an active roadmap promise ("coming soon" was the security-flagged overclaim).
      expect(clone).toHaveAttribute("title", expect.stringMatching(/not yet available/i));
      expect(clone).not.toHaveAttribute("title", expect.stringMatching(/coming soon/i));
      // A disabled native <button> never dispatches a click at all — confirmed here (via the
      // shared `onBrowse` spy, the only click handler anywhere near this button) so a future
      // accidental change (e.g. swapping `disabled` for CSS-only styling, or adding a stray
      // `onClick`) can't silently re-enable it without this test catching it.
      await userEvent.click(clone);
      expect(onBrowse).not.toHaveBeenCalled();
    });

    it("AC10: no 'Open repository…' toolbar-style control is rendered here — only 'Open a repository'", () => {
      const onBrowse = vi.fn();
      render(<EmptyState title="No repository open" description="Choose a repository." onBrowse={onBrowse} />);
      expect(screen.queryByRole("button", { name: /^open repository/i })).not.toBeInTheDocument();
    });

    it("Must-have 4: disabled=true disables 'Open a repository' and every recent row (a switch already in flight)", () => {
      render(
        <EmptyState
          title="No repository open"
          description="Choose a repository."
          onBrowse={() => {}}
          recentRepos={["/repoA"]}
          disabled
        />,
      );
      expect(screen.getByRole("button", { name: "Open a repository" })).toBeDisabled();
      expect(screen.getByTitle("/repoA")).toBeDisabled();
    });
  });
});
