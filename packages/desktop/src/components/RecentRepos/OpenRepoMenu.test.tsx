import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OpenRepoMenu } from "./OpenRepoMenu";

/**
 * specs/repo-list.md Must-have 2/3/4, AC2/AC4/AC6 — component-level coverage for the shared
 * "+ New tab"/"Open repository…" split button, independent of the App-level wiring already
 * covered in `App.repoList.test.tsx`.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

function renderMenu(overrides: Partial<React.ComponentProps<typeof OpenRepoMenu>> = {}) {
  const onBrowse = vi.fn();
  const onOpenRecent = vi.fn().mockResolvedValue("opened");
  const onRemoveRecent = vi.fn();
  const utils = render(
    <OpenRepoMenu
      triggerContent="+"
      triggerClassName="trigger"
      ariaLabel="Open a repository in a new tab"
      recentRepos={[]}
      onBrowse={onBrowse}
      onOpenRecent={onOpenRecent}
      onRemoveRecent={onRemoveRecent}
      menuLabel="Recent repositories — new tab"
      {...overrides}
    />,
  );
  return { ...utils, onBrowse, onOpenRecent, onRemoveRecent };
}

describe("OpenRepoMenu", () => {
  it("Must-have 2 (split button): the trigger always calls onBrowse directly, with or without recent repos — never intercepted by a popover", async () => {
    const { onBrowse: onBrowseEmpty } = renderMenu({ recentRepos: [] });
    await userEvent.click(screen.getByRole("button", { name: /open a repository in a new tab/i }));
    expect(onBrowseEmpty).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
  });

  it("Must-have 2: with zero recent repos, no disclosure caret is rendered at all", () => {
    renderMenu({ recentRepos: [] });
    expect(screen.queryByRole("button", { name: /recent repositories/i })).not.toBeInTheDocument();
  });

  it("Must-have 2: with recent repos, the trigger still calls onBrowse directly — the caret is a separate control", async () => {
    const { onBrowse } = renderMenu({ recentRepos: ["/repoA"] });
    await userEvent.click(screen.getByRole("button", { name: /open a repository in a new tab/i }));
    expect(onBrowse).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
  });

  it("Must-have 2: with recent repos, clicking the caret opens a popover with entries + Browse…", async () => {
    const { onBrowse } = renderMenu({ recentRepos: ["/repoA", "/repoB"] });
    await userEvent.click(screen.getByRole("button", { name: /recent repositories — new tab/i }));
    const popover = await screen.findByRole("group", { name: /recent repositories — new tab/i });
    expect(within(popover).getByTitle("/repoA")).toBeInTheDocument();
    expect(within(popover).getByTitle("/repoB")).toBeInTheDocument();
    expect(within(popover).getByRole("button", { name: /^browse…$/i })).toBeInTheDocument();
    expect(onBrowse).not.toHaveBeenCalled();
  });

  it("AC2: clicking a recent entry calls onOpenRecent with its path and closes the popover on success", async () => {
    const { onOpenRecent } = renderMenu({ recentRepos: ["/repoA"] });
    await userEvent.click(screen.getByRole("button", { name: /recent repositories — new tab/i }));
    const popover = await screen.findByRole("group");
    await userEvent.click(within(popover).getByTitle("/repoA"));
    expect(onOpenRecent).toHaveBeenCalledWith("/repoA");
    await waitFor(() => expect(screen.queryByRole("group")).not.toBeInTheDocument());
  });

  it("clicking Browse… inside the popover calls onBrowse and closes the popover", async () => {
    const { onBrowse } = renderMenu({ recentRepos: ["/repoA"] });
    await userEvent.click(screen.getByRole("button", { name: /recent repositories — new tab/i }));
    const popover = await screen.findByRole("group");
    await userEvent.click(within(popover).getByRole("button", { name: /^browse…$/i }));
    expect(onBrowse).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("group")).not.toBeInTheDocument());
  });

  it("AC6: a 'not-found' result shows the inline state and keeps the popover open; removing keeps it open too", async () => {
    const onOpenRecent = vi.fn().mockResolvedValue("not-found");
    renderMenu({ recentRepos: ["/repoGone"], onOpenRecent });
    await userEvent.click(screen.getByRole("button", { name: /recent repositories — new tab/i }));
    const popover = await screen.findByRole("group");
    await userEvent.click(within(popover).getByTitle("/repoGone"));

    await waitFor(() => expect(within(popover).getByText(/not found/i)).toBeInTheDocument());
    expect(screen.getByRole("group")).toBeInTheDocument();

    const removeButton = within(popover).getByRole("button", { name: /remove from list/i });
    await userEvent.click(removeButton);
    expect(screen.getByRole("group")).toBeInTheDocument();
  });

  it("Escape closes the popover and returns focus to the caret", async () => {
    renderMenu({ recentRepos: ["/repoA"] });
    const caret = screen.getByRole("button", { name: /recent repositories — new tab/i });
    await userEvent.click(caret);
    await screen.findByRole("group");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("group")).not.toBeInTheDocument());
    expect(caret).toHaveFocus();
  });

  it("clicking outside the popover closes it", async () => {
    render(
      <div>
        <OpenRepoMenu
          triggerContent="+"
          triggerClassName="trigger"
          ariaLabel="Open a repository in a new tab"
          recentRepos={["/repoA"]}
          onBrowse={vi.fn()}
          onOpenRecent={vi.fn().mockResolvedValue("opened")}
          onRemoveRecent={vi.fn()}
          menuLabel="Recent repositories — new tab"
        />
        <button type="button">Outside</button>
      </div>,
    );
    await userEvent.click(screen.getByRole("button", { name: /recent repositories — new tab/i }));
    await screen.findByRole("group");
    await userEvent.click(screen.getByRole("button", { name: "Outside" }));
    await waitFor(() => expect(screen.queryByRole("group")).not.toBeInTheDocument());
  });
});
