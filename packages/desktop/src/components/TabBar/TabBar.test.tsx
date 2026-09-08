// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TabBar } from "./TabBar";
import type { RepoTab } from "../../hooks/useRepoTabs";

function makeTab(id: string, repoPath: string): RepoTab {
  return {
    id,
    repoPath,
    remembered: { selectedSha: null, filter: {}, showAllRefs: false, rightPanel: "none", selectedFile: null },
  };
}

describe("TabBar", () => {
  it("Must-have 1: renders the tablist and '+ New tab' control even with zero tabs", () => {
    render(<TabBar tabs={[]} activeTabId={null} onActivate={() => {}} onClose={() => {}} onNewTab={() => {}} />);
    expect(screen.getByRole("tablist", { name: /open repositories/i })).toBeInTheDocument();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.getByRole("button", { name: /open a repository in a new tab/i })).toBeInTheDocument();
  });

  it("shows each tab's short label (final path segment) with the full path as a tooltip", () => {
    render(
      <TabBar
        tabs={[makeTab("t1", "/Users/dev/code/gitHydra"), makeTab("t2", "D:\\repos\\service")]}
        activeTabId="t1"
        onActivate={() => {}}
        onClose={() => {}}
        onNewTab={() => {}}
      />,
    );
    const tabs = screen.getAllByRole("tab");
    expect(tabs[0]).toHaveTextContent("gitHydra");
    expect(tabs[0]).toHaveAttribute("title", "/Users/dev/code/gitHydra");
    expect(tabs[1]).toHaveTextContent("service");
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(tabs[1]).toHaveAttribute("aria-selected", "false");
  });

  it("calls onActivate when a tab is clicked, and onClose (without activating) when its close control is clicked", async () => {
    const onActivate = vi.fn();
    const onClose = vi.fn();
    render(
      <TabBar
        tabs={[makeTab("t1", "/repoA"), makeTab("t2", "/repoB")]}
        activeTabId="t1"
        onActivate={onActivate}
        onClose={onClose}
        onNewTab={() => {}}
      />,
    );

    await userEvent.click(screen.getAllByRole("tab")[1]!);
    expect(onActivate).toHaveBeenCalledWith("t2");

    await userEvent.click(screen.getByRole("button", { name: /close repoA tab/i }));
    expect(onClose).toHaveBeenCalledWith("t1");
    // Closing a tab is not the same gesture as activating it.
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("calls onNewTab when '+ New tab' is clicked", async () => {
    const onNewTab = vi.fn();
    render(<TabBar tabs={[]} activeTabId={null} onActivate={() => {}} onClose={() => {}} onNewTab={onNewTab} />);
    await userEvent.click(screen.getByRole("button", { name: /open a repository in a new tab/i }));
    expect(onNewTab).toHaveBeenCalledTimes(1);
  });

  it("is keyboard-operable: ArrowRight/ArrowLeft move focus and activate the adjacent tab", async () => {
    const onActivate = vi.fn();
    render(
      <TabBar
        tabs={[makeTab("t1", "/repoA"), makeTab("t2", "/repoB"), makeTab("t3", "/repoC")]}
        activeTabId="t1"
        onActivate={onActivate}
        onClose={() => {}}
        onNewTab={() => {}}
      />,
    );
    const tabs = screen.getAllByRole("tab");
    // Roving tabindex: only the active tab is in the normal tab order.
    expect(tabs[0]).toHaveAttribute("tabindex", "0");
    expect(tabs[1]).toHaveAttribute("tabindex", "-1");

    tabs[0]!.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onActivate).toHaveBeenCalledWith("t2");
    expect(tabs[1]).toHaveFocus();

    await userEvent.keyboard("{ArrowLeft}");
    expect(onActivate).toHaveBeenCalledWith("t1");
    expect(tabs[0]).toHaveFocus();

    await userEvent.keyboard("{End}");
    expect(onActivate).toHaveBeenCalledWith("t3");
    expect(tabs[2]).toHaveFocus();
  });

  it("closes the focused tab on Delete/Backspace", async () => {
    const onClose = vi.fn();
    render(
      <TabBar
        tabs={[makeTab("t1", "/repoA"), makeTab("t2", "/repoB")]}
        activeTabId="t1"
        onActivate={() => {}}
        onClose={onClose}
        onNewTab={() => {}}
      />,
    );
    screen.getAllByRole("tab")[0]!.focus();
    await userEvent.keyboard("{Delete}");
    expect(onClose).toHaveBeenCalledWith("t1");
  });

  describe("switching (fast-tab-switch race defense in depth)", () => {
    it("disables every other tab's activate control, every tab's close control, and '+ New tab' while switching", () => {
      render(
        <TabBar
          tabs={[makeTab("t1", "/repoA"), makeTab("t2", "/repoB")]}
          activeTabId="t1"
          onActivate={() => {}}
          onClose={() => {}}
          onNewTab={() => {}}
          switching
        />,
      );
      const tabs = screen.getAllByRole("tab");
      expect(tabs[0]).toBeEnabled(); // the active tab itself stays inert-but-enabled
      expect(tabs[1]).toBeDisabled();
      for (const closeButton of screen.getAllByRole("button", { name: /close .* tab/i })) {
        expect(closeButton).toBeDisabled();
      }
      expect(screen.getByRole("button", { name: /open a repository in a new tab/i })).toBeDisabled();
    });

    it("ignores a click on a disabled (non-active) tab while switching — onActivate is not called", () => {
      const onActivate = vi.fn();
      render(
        <TabBar
          tabs={[makeTab("t1", "/repoA"), makeTab("t2", "/repoB")]}
          activeTabId="t1"
          onActivate={onActivate}
          onClose={() => {}}
          onNewTab={() => {}}
          switching
        />,
      );
      // The button is both `disabled` and `pointer-events: none` — real browsers/user-event both
      // already refuse to dispatch a click at all, which is the primary protection here. Firing
      // the click event directly (bypassing that check) confirms there's no dangling handler that
      // would still act on it if some other path ever did deliver the event.
      fireEvent.click(screen.getAllByRole("tab")[1]!);
      expect(onActivate).not.toHaveBeenCalled();
    });

    it("ignores ArrowRight/ArrowLeft/Delete while switching, even from the still-focusable active tab", async () => {
      const onActivate = vi.fn();
      const onClose = vi.fn();
      render(
        <TabBar
          tabs={[makeTab("t1", "/repoA"), makeTab("t2", "/repoB")]}
          activeTabId="t1"
          onActivate={onActivate}
          onClose={onClose}
          onNewTab={() => {}}
          switching
        />,
      );
      screen.getAllByRole("tab")[0]!.focus();
      await userEvent.keyboard("{ArrowRight}{Delete}");
      expect(onActivate).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    });

    it("re-enables everything once switching goes back to false", () => {
      const { rerender } = render(
        <TabBar
          tabs={[makeTab("t1", "/repoA"), makeTab("t2", "/repoB")]}
          activeTabId="t1"
          onActivate={() => {}}
          onClose={() => {}}
          onNewTab={() => {}}
          switching
        />,
      );
      rerender(
        <TabBar
          tabs={[makeTab("t1", "/repoA"), makeTab("t2", "/repoB")]}
          activeTabId="t1"
          onActivate={() => {}}
          onClose={() => {}}
          onNewTab={() => {}}
          switching={false}
        />,
      );
      expect(screen.getAllByRole("tab")[1]).toBeEnabled();
      expect(screen.getByRole("button", { name: /open a repository in a new tab/i })).toBeEnabled();
    });
  });
});
