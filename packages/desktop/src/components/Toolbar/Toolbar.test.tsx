// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Toolbar } from "./Toolbar";

describe("Toolbar", () => {
  it("disables Refresh when no repo is open and enables it once one is", () => {
    const { rerender } = render(
      <Toolbar repoPath={null} onRefresh={() => {}} canRefresh={false} theme="dark" onToggleTheme={() => {}} />,
    );
    expect(screen.getByRole("button", { name: /refresh commit graph/i })).toBeDisabled();

    rerender(<Toolbar repoPath="/repo" onRefresh={() => {}} canRefresh theme="dark" onToggleTheme={() => {}} />);
    expect(screen.getByRole("button", { name: /refresh commit graph/i })).toBeEnabled();
  });

  // toolbar-action-row redesign: the theme toggle PERMANENTLY moved into the new `⋯` overflow
  // menu — it's no longer a direct top-level button at all, at any width.
  it("calls onToggleTheme from inside the '⋯' overflow menu", async () => {
    const onToggleTheme = vi.fn();
    render(<Toolbar repoPath={null} onRefresh={() => {}} canRefresh={false} theme="dark" onToggleTheme={onToggleTheme} />);
    expect(screen.queryByRole("button", { name: /switch to light theme/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /more actions/i }));
    await userEvent.click(screen.getByRole("menuitem", { name: /switch to light theme/i }));
    expect(onToggleTheme).toHaveBeenCalled();
  });

  it("specs/keyboard-shortcuts-reference.md FR-231: the overflow menu's 'Keyboard shortcuts' entry calls onOpenKeyboardShortcuts and shows its keybinding hint", async () => {
    const onOpenKeyboardShortcuts = vi.fn();
    render(
      <Toolbar
        repoPath={null}
        onRefresh={() => {}}
        canRefresh={false}
        theme="dark"
        onToggleTheme={() => {}}
        onOpenKeyboardShortcuts={onOpenKeyboardShortcuts}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /more actions/i }));
    const item = screen.getByRole("menuitem", { name: "Keyboard shortcuts" });
    expect(within(screen.getByRole("menu")).getByText(/ctrl\+\//i)).toBeInTheDocument();
    await userEvent.click(item);
    expect(onOpenKeyboardShortcuts).toHaveBeenCalledTimes(1);
  });

  it("specs/repo-list.md (revised IA): no 'Open repository…' control exists anywhere in the Toolbar", () => {
    render(<Toolbar repoPath="/repo" onRefresh={() => {}} canRefresh theme="dark" onToggleTheme={() => {}} />);
    expect(screen.queryByRole("button", { name: /open repository/i })).not.toBeInTheDocument();
  });

  it("hides the Changes toggle until a repo is open, then shows a badge with the pending count", () => {
    const { rerender } = render(
      <Toolbar repoPath={null} onRefresh={() => {}} canRefresh={false} theme="dark" onToggleTheme={() => {}} />,
    );
    expect(screen.queryByRole("button", { name: /^changes/i })).not.toBeInTheDocument();

    const onToggleChanges = vi.fn();
    rerender(
      <Toolbar
        repoPath="/repo"
        onRefresh={() => {}}
        canRefresh
        theme="dark"
        onToggleTheme={() => {}}
        showChangesToggle
        changesCount={3}
        onToggleChanges={onToggleChanges}
      />,
    );
    const toggle = screen.getByRole("button", { name: /changes, 3 pending/i });
    expect(toggle).toHaveTextContent("3");
  });

  it("shows the current-branch indicator and toggles the Branches sidebar's collapsed state on click (FR-56, design-pass relocation)", async () => {
    const onToggleBranches = vi.fn();
    render(
      <Toolbar
        repoPath="/repo"
        onRefresh={() => {}}
        canRefresh
        theme="dark"
        onToggleTheme={() => {}}
        showBranchesToggle
        currentBranchLabel="main"
        onToggleBranches={onToggleBranches}
      />,
    );
    const toggle = screen.getByRole("button", { name: /branches.*current branch main/i });
    expect(toggle).toHaveTextContent("main");
    // width-shedding fix: with no `lastFetchedLabel` at all, `title` still carries the branch name
    // alone — the sighted, hover-only recovery path for whatever the chip's own 160px `max-width`
    // ellipsis clips (Toolbar.css's `.gh-toolbar__branch span.gh-mono`), not left unset just
    // because there's no freshness caption to append.
    expect(toggle).toHaveAttribute("title", "main");
    await userEvent.click(toggle);
    expect(onToggleBranches).toHaveBeenCalledTimes(1);
  });

  it("caps a long branch name's rendered label span at the ref-chip convention's 160px, full name still in title/aria-label", () => {
    const longBranch = "feature/redesign-onboarding-flow-v2";
    render(
      <Toolbar
        repoPath="/repo"
        onRefresh={() => {}}
        canRefresh
        theme="dark"
        onToggleTheme={() => {}}
        showBranchesToggle
        currentBranchLabel={longBranch}
      />,
    );
    const toggle = screen.getByRole("button", { name: new RegExp(`current branch ${longBranch}`, "i") });
    // The label span carries the CSS class Toolbar.css's `.gh-toolbar__branch span.gh-mono` targets
    // with `max-width: 160px` + ellipsis — jsdom doesn't lay out CSS, so this asserts the class is
    // present (what the truncation rule actually hooks), not a rendered pixel width.
    const label = toggle.querySelector("span.gh-mono");
    expect(label).not.toBeNull();
    expect(label).toHaveTextContent(longBranch);
    // The full, untruncated name is always recoverable — from the accessible name (screen reader)
    // and from `title` (sighted hover) — independent of whatever the CSS visually clips.
    expect(toggle).toHaveAttribute("title", longBranch);
    expect(toggle).toHaveAccessibleName(expect.stringContaining(longBranch));
  });

  describe("adaptive Stashes chip", () => {
    it("renders as a plain ghost icon button (no visible label, gh-toolbar__icon-button) at zero/unknown count", () => {
      render(
        <Toolbar
          repoPath="/repo"
          onRefresh={() => {}}
          canRefresh
          theme="dark"
          onToggleTheme={() => {}}
          showStashToggle
          stashCount={0}
        />,
      );
      const toggle = screen.getByRole("button", { name: "Stashes" });
      expect(toggle).toHaveClass("gh-toolbar__icon-button");
      expect(toggle).not.toHaveClass("gh-toolbar__button");
      expect(toggle.textContent).toBe("");
      expect(toggle.querySelector("svg")).not.toBeNull();
    });

    it("promotes to the full labeled chip with its badge once it has contents, and toggles the panel on click", async () => {
      const onToggleStash = vi.fn();
      render(
        <Toolbar
          repoPath="/repo"
          onRefresh={() => {}}
          canRefresh
          theme="dark"
          onToggleTheme={() => {}}
          showStashToggle
          stashCount={2}
          onToggleStash={onToggleStash}
        />,
      );
      const toggle = screen.getByRole("button", { name: /stashes, 2/i });
      expect(toggle).toHaveClass("gh-toolbar__button");
      expect(toggle).toHaveTextContent("Stashes");
      expect(toggle).toHaveTextContent("2");
      await userEvent.click(toggle);
      expect(onToggleStash).toHaveBeenCalledTimes(1);
    });

    it("disables the toggle with a stated reason on a bare repository, in BOTH the ghost-icon and labeled forms", () => {
      const { rerender } = render(
        <Toolbar
          repoPath="/repo"
          onRefresh={() => {}}
          canRefresh
          theme="dark"
          onToggleTheme={() => {}}
          showStashToggle
          stashCount={0}
          stashDisabledReason="This is a bare repository — it has no working directory, so there is nothing to stash."
        />,
      );
      let toggle = screen.getByRole("button", { name: "Stashes" });
      expect(toggle).toBeDisabled();
      expect(toggle).toHaveAttribute("title", expect.stringMatching(/bare repository/i));

      rerender(
        <Toolbar
          repoPath="/repo"
          onRefresh={() => {}}
          canRefresh
          theme="dark"
          onToggleTheme={() => {}}
          showStashToggle
          stashCount={2}
          stashDisabledReason="This is a bare repository — it has no working directory, so there is nothing to stash."
        />,
      );
      toggle = screen.getByRole("button", { name: /stashes, 2/i });
      expect(toggle).toBeDisabled();
      expect(toggle).toHaveAttribute("title", expect.stringMatching(/bare repository/i));
    });
  });

  it("design-pass fix #1: demotes Refresh to an icon-only ghost button with no visible label text", () => {
    render(<Toolbar repoPath="/repo" onRefresh={() => {}} canRefresh theme="dark" onToggleTheme={() => {}} />);
    const refresh = screen.getByRole("button", { name: /refresh commit graph/i });
    expect(refresh).toHaveClass("gh-toolbar__icon-button");
    expect(refresh).not.toHaveClass("gh-toolbar__button");
    expect(refresh.textContent).toBe("");
    expect(refresh.querySelector("svg")).not.toBeNull();
  });

  it("groups panel-toggle chips + Find + Refresh together in the local-tools cluster", () => {
    render(
      <Toolbar
        repoPath="/repo"
        onRefresh={() => {}}
        canRefresh
        theme="dark"
        onToggleTheme={() => {}}
        showBranchesToggle
        currentBranchLabel="main"
        showChangesToggle
        showStashToggle
        showFindCommitsButton
        onFindCommits={() => {}}
      />,
    );
    const branchesToggle = screen.getByRole("button", { name: /branches.*current branch main/i });
    const changesToggle = screen.getByRole("button", { name: "Changes" });
    const findButton = screen.getByRole("button", { name: "Find commits" });
    const refreshButton = screen.getByRole("button", { name: /refresh commit graph/i });
    for (const control of [branchesToggle, changesToggle, findButton, refreshButton]) {
      expect(control.closest(".gh-toolbar__group--toggles")).not.toBeNull();
    }
    expect(branchesToggle).toHaveClass("gh-toolbar__button");
    expect(branchesToggle.querySelector("svg")).not.toBeNull();
  });

  // specs/refresh-without-teardown.md AC4: a visible, testable loading affordance while
  // `isRefreshing` is true, independent of `canRefresh`/`status`.
  it("shows a busy Refresh button while isRefreshing is true, and a plain one once it clears", () => {
    const { rerender } = render(
      <Toolbar repoPath="/repo" onRefresh={() => {}} canRefresh theme="dark" onToggleTheme={() => {}} isRefreshing />,
    );
    const busyRefresh = screen.getByRole("button", { name: /refreshing commit graph/i });
    expect(busyRefresh).toHaveAttribute("aria-busy", "true");
    expect(busyRefresh).toBeDisabled();
    expect(busyRefresh.querySelector("svg")).toHaveClass("gh-toolbar__icon--spin");

    rerender(
      <Toolbar
        repoPath="/repo"
        onRefresh={() => {}}
        canRefresh
        theme="dark"
        onToggleTheme={() => {}}
        isRefreshing={false}
      />,
    );
    const idleRefresh = screen.getByRole("button", { name: /^refresh commit graph$/i });
    expect(idleRefresh).toHaveAttribute("aria-busy", "false");
    expect(idleRefresh).toBeEnabled();
    expect(idleRefresh.querySelector("svg")).not.toHaveClass("gh-toolbar__icon--spin");
  });

  describe("specs/find-commits-overlay.md FR-258", () => {
    it("hides the 'Find commits' button by default, shows it once showFindCommitsButton is true, and calls onFindCommits on click", async () => {
      const { rerender } = render(
        <Toolbar repoPath={null} onRefresh={() => {}} canRefresh={false} theme="dark" onToggleTheme={() => {}} />,
      );
      expect(screen.queryByRole("button", { name: "Find commits" })).not.toBeInTheDocument();

      const onFindCommits = vi.fn();
      rerender(
        <Toolbar
          repoPath="/repo"
          onRefresh={() => {}}
          canRefresh
          theme="dark"
          onToggleTheme={() => {}}
          showFindCommitsButton
          onFindCommits={onFindCommits}
        />,
      );
      const button = screen.getByRole("button", { name: "Find commits" });
      expect(button).toHaveClass("gh-toolbar__icon-button");
      expect(button).toHaveAttribute("title", expect.stringMatching(/find commits/i));
      expect(button.querySelector("svg")).not.toBeNull();
      await userEvent.click(button);
      expect(onFindCommits).toHaveBeenCalledTimes(1);
    });

    it("FR-263 revision: findCommitsActive shows a dot AND folds the active state into the accessible name (not just a visually-hidden span an explicit aria-label would silently suppress)", () => {
      const { rerender } = render(
        <Toolbar
          repoPath="/repo"
          onRefresh={() => {}}
          canRefresh
          theme="dark"
          onToggleTheme={() => {}}
          showFindCommitsButton
          onFindCommits={() => {}}
        />,
      );
      const inactive = screen.getByRole("button", { name: "Find commits" });
      expect(inactive.querySelector(".gh-toolbar__icon-button-indicator")).toBeNull();

      rerender(
        <Toolbar
          repoPath="/repo"
          onRefresh={() => {}}
          canRefresh
          theme="dark"
          onToggleTheme={() => {}}
          showFindCommitsButton
          onFindCommits={() => {}}
          findCommitsActive
        />,
      );
      const active = screen.getByRole("button", { name: /find commits.*filter is currently applied/i });
      expect(active.querySelector(".gh-toolbar__icon-button-indicator")).toBeInTheDocument();
    });
  });

  describe("sync cluster (specs/online-sync-fetch.md, online-sync-pull.md, online-sync-push.md)", () => {
    it("renders nothing at all when Fetch/Pull/Push are all hidden", () => {
      render(<Toolbar repoPath="/repo" onRefresh={() => {}} canRefresh theme="dark" onToggleTheme={() => {}} />);
      expect(document.querySelector(".gh-sync-cluster")).not.toBeInTheDocument();
    });

    it("hides the Fetch button by default, shows it once showFetchButton is true (icon + visible label), and calls onFetch on click", async () => {
      const { rerender } = render(
        <Toolbar repoPath={null} onRefresh={() => {}} canRefresh={false} theme="dark" onToggleTheme={() => {}} />,
      );
      expect(screen.queryByRole("button", { name: /fetch all remotes/i })).not.toBeInTheDocument();

      const onFetch = vi.fn();
      rerender(
        <Toolbar
          repoPath="/repo"
          onRefresh={() => {}}
          canRefresh
          theme="dark"
          onToggleTheme={() => {}}
          showFetchButton
          onFetch={onFetch}
        />,
      );
      const button = screen.getByRole("button", { name: /fetch all remotes/i });
      expect(button).toHaveClass("gh-sync-cluster__button");
      expect(button).toHaveTextContent("Fetch");
      await userEvent.click(button);
      expect(onFetch).toHaveBeenCalledTimes(1);
    });

    it("disables the Fetch button and marks it aria-busy while isFetching (no piling up overlapping fetches)", () => {
      render(
        <Toolbar
          repoPath="/repo"
          onRefresh={() => {}}
          canRefresh
          theme="dark"
          onToggleTheme={() => {}}
          showFetchButton
          onFetch={() => {}}
          isFetching
        />,
      );
      const button = screen.getByRole("button", { name: /fetching remotes/i });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("aria-busy", "true");
    });

    it("surfaces the last-fetched caption as a title on the current-branch indicator (text-carried, DESIGN.md caption convention)", () => {
      render(
        <Toolbar
          repoPath="/repo"
          onRefresh={() => {}}
          canRefresh
          theme="dark"
          onToggleTheme={() => {}}
          showBranchesToggle
          currentBranchLabel="main"
          lastFetchedLabel="fetched 3 minutes ago"
        />,
      );
      const toggle = screen.getByRole("button", { name: /branches.*current branch main.*fetched 3 minutes ago/i });
      // width-shedding fix: the branch chip's own label is now capped with ellipsis truncation
      // (Toolbar.css's `.gh-toolbar__branch span.gh-mono`), so `title` now leads with the full
      // branch name (the sighted, hover-only recovery path for whatever the chip clips) with the
      // freshness caption still appended — not the caption alone as before that cap existed.
      expect(toggle).toHaveAttribute("title", "main — fetched 3 minutes ago");
    });

    describe("Pull", () => {
      it("hides Pull by default, shows Fetch|Pull|Push as one bordered cluster once shown, and calls onPull on click", async () => {
        const { rerender } = render(
          <Toolbar repoPath={null} onRefresh={() => {}} canRefresh={false} theme="dark" onToggleTheme={() => {}} />,
        );
        expect(screen.queryByRole("button", { name: /^pull$/i })).not.toBeInTheDocument();

        const onPull = vi.fn();
        rerender(
          <Toolbar
            repoPath="/repo"
            onRefresh={() => {}}
            canRefresh
            theme="dark"
            onToggleTheme={() => {}}
            showPullButton
            pullDisabledReason={null}
            onPull={onPull}
          />,
        );
        const button = screen.getByRole("button", { name: /^pull$/i });
        expect(button).toHaveClass("gh-sync-cluster__button");
        expect(button.closest(".gh-sync-cluster")).not.toBeNull();
        await userEvent.click(button);
        expect(onPull).toHaveBeenCalledTimes(1);
      });

      it("FR-343: disables the Pull button with the exact reason as its title/aria-label, matching the app's existing disabled-with-reason convention", () => {
        render(
          <Toolbar
            repoPath="/repo"
            onRefresh={() => {}}
            canRefresh
            theme="dark"
            onToggleTheme={() => {}}
            showPullButton
            pullDisabledReason="This branch has no upstream configured — set one before pulling."
            onPull={() => {}}
          />,
        );
        const button = screen.getByRole("button", { name: /no upstream configured/i });
        expect(button).toBeDisabled();
        expect(button).toHaveAttribute("title", "This branch has no upstream configured — set one before pulling.");
      });

      it("disables the Pull button and marks it aria-busy while isPulling (no piling up overlapping pulls)", () => {
        render(
          <Toolbar
            repoPath="/repo"
            onRefresh={() => {}}
            canRefresh
            theme="dark"
            onToggleTheme={() => {}}
            showPullButton
            pullDisabledReason="A pull is already running."
            onPull={() => {}}
            isPulling
          />,
        );
        const button = screen.getByRole("button", { name: /pulling/i });
        expect(button).toBeDisabled();
        expect(button).toHaveAttribute("aria-busy", "true");
      });

      it("FR-339: the strategy caret opens a menu defaulting to Auto checked, and calls onPullStrategyChange when a different strategy is picked", async () => {
        const onPullStrategyChange = vi.fn();
        render(
          <Toolbar
            repoPath="/repo"
            onRefresh={() => {}}
            canRefresh
            theme="dark"
            onToggleTheme={() => {}}
            showPullButton
            pullDisabledReason={null}
            onPull={() => {}}
            onPullStrategyChange={onPullStrategyChange}
          />,
        );
        const caret = screen.getByRole("button", { name: /pull strategy options/i });
        expect(caret).toHaveAttribute("aria-haspopup", "menu");
        expect(caret).toHaveAttribute("aria-expanded", "false");
        await userEvent.click(caret);
        expect(caret).toHaveAttribute("aria-expanded", "true");

        const menu = screen.getByRole("menu", { name: /strategy for this pull/i });
        expect(within(menu).getByRole("menuitemradio", { name: "Auto" })).toHaveAttribute("aria-checked", "true");
        expect(within(menu).getByText(/applies to this pull only/i)).toBeInTheDocument();

        await userEvent.click(within(menu).getByRole("menuitemradio", { name: "Rebase" }));
        expect(onPullStrategyChange).toHaveBeenCalledWith("rebase");
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      });

      it("keyboard: Escape closes the strategy menu and returns focus to its caret", async () => {
        render(
          <Toolbar
            repoPath="/repo"
            onRefresh={() => {}}
            canRefresh
            theme="dark"
            onToggleTheme={() => {}}
            showPullButton
            pullDisabledReason={null}
            onPull={() => {}}
          />,
        );
        const caret = screen.getByRole("button", { name: /pull strategy options/i });
        await userEvent.click(caret);
        expect(screen.getByRole("menu")).toBeInTheDocument();
        await userEvent.keyboard("{Escape}");
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
        expect(caret).toHaveFocus();
      });

      it("keyboard: ArrowDown moves focus from the checked strategy to the next item", async () => {
        render(
          <Toolbar
            repoPath="/repo"
            onRefresh={() => {}}
            canRefresh
            theme="dark"
            onToggleTheme={() => {}}
            showPullButton
            pullDisabledReason={null}
            onPull={() => {}}
            pullStrategy="auto"
          />,
        );
        await userEvent.click(screen.getByRole("button", { name: /pull strategy options/i }));
        expect(screen.getByRole("menuitemradio", { name: "Auto" })).toHaveFocus();
        await userEvent.keyboard("{ArrowDown}");
        expect(screen.getByRole("menuitemradio", { name: "Merge" })).toHaveFocus();
      });
    });

    describe("Push", () => {
      it("hides Push/remote picker by default, shows the Push button (but no picker for a single remote) once shown, and calls onPush on click", async () => {
        const { rerender } = render(
          <Toolbar repoPath={null} onRefresh={() => {}} canRefresh={false} theme="dark" onToggleTheme={() => {}} />,
        );
        expect(screen.queryByRole("button", { name: /^push$/i })).not.toBeInTheDocument();

        const onPush = vi.fn();
        rerender(
          <Toolbar
            repoPath="/repo"
            onRefresh={() => {}}
            canRefresh
            theme="dark"
            onToggleTheme={() => {}}
            showPushButton
            pushDisabledReason={null}
            onPush={onPush}
            showPushRemotePicker={false}
            pushRemotes={["origin"]}
            pushRemote="origin"
          />,
        );
        const button = screen.getByRole("button", { name: /^push$/i });
        expect(button).toHaveClass("gh-sync-cluster__button");
        expect(screen.queryByRole("button", { name: /push remote options/i })).not.toBeInTheDocument();
        await userEvent.click(button);
        expect(onPush).toHaveBeenCalledTimes(1);
      });

      it("FR-345: shows the remote-picker caret only when more than one remote is configured, checking the given pushRemote and calling onPushRemoteChange when a different one is picked", async () => {
        const onPushRemoteChange = vi.fn();
        render(
          <Toolbar
            repoPath="/repo"
            onRefresh={() => {}}
            canRefresh
            theme="dark"
            onToggleTheme={() => {}}
            showPushButton
            pushDisabledReason={null}
            onPush={() => {}}
            showPushRemotePicker
            pushRemotes={["origin", "upstream"]}
            pushRemote="origin"
            onPushRemoteChange={onPushRemoteChange}
          />,
        );
        const caret = screen.getByRole("button", { name: /push remote options/i });
        await userEvent.click(caret);
        const menu = screen.getByRole("menu", { name: /push to/i });
        expect(within(menu).getByRole("menuitemradio", { name: "origin" })).toHaveAttribute("aria-checked", "true");
        expect(within(menu).getByRole("menuitemradio", { name: "upstream" })).toHaveAttribute("aria-checked", "false");

        await userEvent.click(within(menu).getByRole("menuitemradio", { name: "upstream" }));
        expect(onPushRemoteChange).toHaveBeenCalledWith("upstream");
      });

      it("FR-349: disables the Push button with the exact reason as its title/aria-label, matching the app's existing disabled-with-reason convention", () => {
        render(
          <Toolbar
            repoPath="/repo"
            onRefresh={() => {}}
            canRefresh
            theme="dark"
            onToggleTheme={() => {}}
            showPushButton
            pushDisabledReason="This repository has no remotes configured — add one before pushing."
            onPush={() => {}}
          />,
        );
        const button = screen.getByRole("button", { name: /no remotes configured/i });
        expect(button).toBeDisabled();
        expect(button).toHaveAttribute("title", "This repository has no remotes configured — add one before pushing.");
      });

      it("disables the Push button and marks it aria-busy while isPushing (no piling up overlapping pushes)", () => {
        render(
          <Toolbar
            repoPath="/repo"
            onRefresh={() => {}}
            canRefresh
            theme="dark"
            onToggleTheme={() => {}}
            showPushButton
            pushDisabledReason="A push is already running."
            onPush={() => {}}
            isPushing
          />,
        );
        const button = screen.getByRole("button", { name: /pushing/i });
        expect(button).toBeDisabled();
        expect(button).toHaveAttribute("aria-busy", "true");
      });

      it("never renders any force/delete/tags/all/mirror-shaped control alongside Push", () => {
        render(
          <Toolbar
            repoPath="/repo"
            onRefresh={() => {}}
            canRefresh
            theme="dark"
            onToggleTheme={() => {}}
            showPushButton
            pushDisabledReason={null}
            onPush={() => {}}
            showPushRemotePicker
            pushRemotes={["origin", "upstream"]}
            pushRemote="origin"
          />,
        );
        const buttonNames = screen.getAllByRole("button").map((b) => b.textContent + (b.getAttribute("aria-label") ?? ""));
        for (const name of buttonNames) {
          expect(name.toLowerCase()).not.toMatch(/force|delete|mirror|--tags|--all/);
        }
      });
    });

    describe("ahead/behind pills (toolbar-action-row redesign)", () => {
      it("renders no pill and no icon on either segment when both ahead and behind are zero/unknown — the quietest state", () => {
        render(
          <Toolbar
            repoPath="/repo"
            onRefresh={() => {}}
            canRefresh
            theme="dark"
            onToggleTheme={() => {}}
            showPullButton
            pullDisabledReason={null}
            onPull={() => {}}
            showPushButton
            pushDisabledReason={null}
            onPush={() => {}}
            ahead={0}
            behind={0}
          />,
        );
        expect(document.querySelector(".gh-sync-pill")).not.toBeInTheDocument();
        const pull = screen.getByRole("button", { name: "Pull" });
        const push = screen.getByRole("button", { name: "Push" });
        expect(pull.querySelector("svg")).toBeNull();
        expect(push.querySelector("svg")).toBeNull();
        expect(document.querySelector(".gh-sync-cluster--diverged")).not.toBeInTheDocument();
      });

      it("shows Pull's pill/icon only when behind > 0, folding the real count into the accessible name and title", () => {
        render(
          <Toolbar
            repoPath="/repo"
            onRefresh={() => {}}
            canRefresh
            theme="dark"
            onToggleTheme={() => {}}
            showPullButton
            pullDisabledReason={null}
            onPull={() => {}}
            behind={2}
            ahead={0}
            lastFetchedLabel="fetched 3 minutes ago"
          />,
        );
        const pull = screen.getByRole("button", { name: /pull — 2 commits behind — fetched 3 minutes ago/i });
        expect(pull.querySelector("svg")).not.toBeNull();
        expect(pull).toHaveAttribute("title", expect.stringMatching(/2 commits behind.*fetched 3 minutes ago/i));
        const pill = pull.querySelector(".gh-sync-pill")!;
        expect(pill).toHaveTextContent("2");
        expect(pill).toHaveAttribute("aria-hidden", "true");
        expect(pill).not.toHaveClass("gh-sync-pill--warning");
      });

      it("shows Push's pill/icon only when ahead > 0, folding the real count into the accessible name", () => {
        render(
          <Toolbar
            repoPath="/repo"
            onRefresh={() => {}}
            canRefresh
            theme="dark"
            onToggleTheme={() => {}}
            showPushButton
            pushDisabledReason={null}
            onPush={() => {}}
            ahead={5}
            behind={0}
          />,
        );
        const push = screen.getByRole("button", { name: /push — 5 commits ahead/i });
        expect(push.querySelector("svg")).not.toBeNull();
        expect(push.querySelector(".gh-sync-pill")).toHaveTextContent("5");
      });

      it("caps the pill's own display text at '99+' while the real number stays in the accessible name", () => {
        render(
          <Toolbar
            repoPath="/repo"
            onRefresh={() => {}}
            canRefresh
            theme="dark"
            onToggleTheme={() => {}}
            showPushButton
            pushDisabledReason={null}
            onPush={() => {}}
            ahead={142}
            behind={0}
          />,
        );
        const push = screen.getByRole("button", { name: /push — 142 commits ahead/i });
        expect(push.querySelector(".gh-sync-pill")).toHaveTextContent("99+");
      });

      it("diverged (both ahead AND behind non-zero): warning border on the cluster, warning-filled pills, and 'diverged' stated in both accessible names", () => {
        render(
          <Toolbar
            repoPath="/repo"
            onRefresh={() => {}}
            canRefresh
            theme="dark"
            onToggleTheme={() => {}}
            showPullButton
            pullDisabledReason={null}
            onPull={() => {}}
            showPushButton
            pushDisabledReason={null}
            onPush={() => {}}
            ahead={3}
            behind={2}
          />,
        );
        expect(document.querySelector(".gh-sync-cluster--diverged")).toBeInTheDocument();
        const pull = screen.getByRole("button", { name: /pull — diverged.*2 commits behind.*3 commits ahead/i });
        const push = screen.getByRole("button", { name: /push — diverged.*2 commits behind.*3 commits ahead/i });
        for (const pill of document.querySelectorAll(".gh-sync-pill")) {
          expect(pill).toHaveClass("gh-sync-pill--warning");
        }
        expect(pull).toBeInTheDocument();
        expect(push).toBeInTheDocument();
      });

      it("never implies freshness the data doesn't have — no caveat text at all when lastFetchedLabel is null", () => {
        render(
          <Toolbar
            repoPath="/repo"
            onRefresh={() => {}}
            canRefresh
            theme="dark"
            onToggleTheme={() => {}}
            showPullButton
            pullDisabledReason={null}
            onPull={() => {}}
            behind={2}
            lastFetchedLabel={null}
          />,
        );
        const pull = screen.getByRole("button", { name: /^pull — 2 commits behind$/i });
        expect(pull).not.toHaveAttribute("title", expect.stringMatching(/fetched|ago/i));
      });

      it("disabled state keeps the exact plain disabled-reason title/name — never adds count/freshness noise", () => {
        render(
          <Toolbar
            repoPath="/repo"
            onRefresh={() => {}}
            canRefresh
            theme="dark"
            onToggleTheme={() => {}}
            showPullButton
            pullDisabledReason="This branch has no upstream configured — set one before pulling."
            onPull={() => {}}
            behind={2}
            lastFetchedLabel="fetched 3 minutes ago"
          />,
        );
        const button = screen.getByRole("button", { name: /no upstream configured/i });
        expect(button).toHaveAttribute("title", "This branch has no upstream configured — set one before pulling.");
      });
    });
  });

  describe("specs/git-identity-profiles.md", () => {
    it("shows the 'Git identity profiles' icon button unconditionally and calls onOpenIdentityProfiles on click", async () => {
      const onOpenIdentityProfiles = vi.fn();
      render(
        <Toolbar
          repoPath={null}
          onRefresh={() => {}}
          canRefresh={false}
          theme="dark"
          onToggleTheme={() => {}}
          onOpenIdentityProfiles={onOpenIdentityProfiles}
        />,
      );
      const button = screen.getByRole("button", { name: /git identity profiles/i });
      expect(button).toHaveClass("gh-toolbar__icon-button");
      await userEvent.click(button);
      expect(onOpenIdentityProfiles).toHaveBeenCalledTimes(1);
    });
  });

  it("falls back to a neutral 'Branches' label for detached HEAD / bare repos (no misleading branch name)", () => {
    render(
      <Toolbar
        repoPath="/repo"
        onRefresh={() => {}}
        canRefresh
        theme="dark"
        onToggleTheme={() => {}}
        showBranchesToggle
        currentBranchLabel={null}
      />,
    );
    expect(screen.getByRole("button", { name: "Branches" })).toBeInTheDocument();
  });
});
