// SPDX-License-Identifier: GPL-3.0-or-later
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

    // specs/repo-open-feedback-fixes.md FR-204/FR-205, AC5-7.
    it("AC6: forwards the matching entry's divergentPickedPaths entry down to its row as persistent secondary context", () => {
      render(
        <EmptyState
          title="No repository open"
          description="Choose a repository."
          recentRepos={["/repo", "/other"]}
          divergentPickedPaths={{ "/repo": "/repo/packages/sub" }}
        />,
      );
      expect(screen.getByText(/originally opened from/i)).toBeInTheDocument();
      expect(screen.getByText(/\/repo\/packages\/sub/)).toBeInTheDocument();
    });

    it("AC7: omitting divergentPickedPaths (or a given entry's key) renders every row with no secondary-context line", () => {
      render(
        <EmptyState
          title="No repository open"
          description="Choose a repository."
          recentRepos={["/repoA", "/repoB"]}
        />,
      );
      expect(screen.queryByText(/originally opened from/i)).not.toBeInTheDocument();
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

    // specs/online-sync-clone.md FR-351: the slot specs/repo-list.md Must-have 2/AC11 reserved
    // (and originally shipped permanently disabled — see this describe block's git history) is now
    // live.
    it("FR-351: renders no 'Clone a repository' button when onClone is omitted, even with onBrowse present", () => {
      render(<EmptyState title="No repository open" description="Choose a repository." onBrowse={() => {}} />);
      expect(screen.queryByRole("button", { name: /clone a repository/i })).not.toBeInTheDocument();
    });

    it("FR-351: shows 'Clone a repository' and calls onClone when clicked — no dialog wiring here, just the callback", async () => {
      const onClone = vi.fn();
      render(
        <EmptyState title="No repository open" description="Choose a repository." onBrowse={() => {}} onClone={onClone} />,
      );
      const clone = screen.getByRole("button", { name: /clone a repository/i });
      expect(clone).toBeEnabled();
      await userEvent.click(clone);
      expect(onClone).toHaveBeenCalledTimes(1);
    });

    it("FR-351/Must-have 4: disabled=true also disables 'Clone a repository' (a switch already in flight)", () => {
      render(
        <EmptyState
          title="No repository open"
          description="Choose a repository."
          onBrowse={() => {}}
          onClone={() => {}}
          disabled
        />,
      );
      expect(screen.getByRole("button", { name: /clone a repository/i })).toBeDisabled();
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
