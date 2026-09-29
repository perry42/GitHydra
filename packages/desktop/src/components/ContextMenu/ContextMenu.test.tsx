// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContextMenu } from "./ContextMenu";

describe("ContextMenu", () => {
  const items = [
    { label: "Checkout", disabled: true },
    { label: "Create branch here", disabled: true },
    { label: "Cherry-pick", disabled: true },
  ];

  it("exposes the FR-16 extension point as a labeled menu with stubbed (disabled) actions", () => {
    render(<ContextMenu x={10} y={10} sha="abc1234" items={items} onClose={() => {}} />);
    const menu = screen.getByRole("menu", { name: /actions for commit abc1234/i });
    expect(menu).toBeInTheDocument();
    for (const item of items) {
      expect(screen.getByRole("menuitem", { name: item.label })).toBeDisabled();
    }
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(<ContextMenu x={10} y={10} sha="abc1234" items={items} onClose={onClose} />);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on an outside click", async () => {
    const onClose = vi.fn();
    render(
      <div>
        <div data-testid="outside">Outside</div>
        <ContextMenu x={10} y={10} sha="abc1234" items={items} onClose={onClose} />
      </div>,
    );
    await userEvent.click(screen.getByTestId("outside"));
    expect(onClose).toHaveBeenCalled();
  });

  // specs/drag-commit-menu.md FR-304/305: an optional header slot, rendered above the item list,
  // reusing this component's own chrome pixel-for-pixel rather than a forked visual component.
  it("FR-304: renders an optional header above the item list when supplied", () => {
    render(
      <ContextMenu
        x={10}
        y={10}
        sha="abc1234"
        ariaLabel="Dragged main onto feature-x"
        header={<span>Dragged main onto feature-x</span>}
        items={items}
        onClose={() => {}}
      />,
    );
    const menu = screen.getByRole("menu", { name: /dragged main onto feature-x/i });
    expect(menu).toHaveTextContent(/dragged main onto feature-x/i);
  });

  it("omits the header entirely for every existing (no-header) caller", () => {
    const { container } = render(<ContextMenu x={10} y={10} sha="abc1234" items={items} onClose={() => {}} />);
    expect(container.querySelector(".gh-context-menu__header")).not.toBeInTheDocument();
  });

  // Follow-up to specs/ref-chip-gutter-legibility.md FR-411: an optional per-item icon slot (used
  // by CommitGraph.tsx's "+N" ref-collapse popover to show the same per-type icon the visible chip
  // renders) — additive, every existing (no-icon) caller must render identically to before.
  it("renders an optional icon before the label when an item supplies one, and omits the icon slot entirely for items that don't", () => {
    render(
      <ContextMenu
        x={10}
        y={10}
        sha="abc1234"
        items={[{ label: "With icon", disabled: true, icon: <svg data-testid="my-icon" /> }, ...items]}
        onClose={() => {}}
      />,
    );
    const withIcon = screen.getByRole("menuitem", { name: "With icon" });
    expect(within(withIcon).getByTestId("my-icon")).toBeInTheDocument();
    const withoutIcon = screen.getByRole("menuitem", { name: "Checkout" });
    expect(withoutIcon.querySelector(".gh-context-menu__item-icon")).not.toBeInTheDocument();
  });

  // specs/drag-commit-menu.md FR-316: explicit regression coverage for the design-draft bug where
  // an inline `style.display` write silently defeated the CSS class controlling visibility, so
  // scroll/Escape/outside-click all appeared wired but did nothing. This component never writes
  // `style.display` (see ContextMenu.tsx) — verified here via a real scroll event, since that's
  // the one dismiss path that's entirely new (Escape/outside-click were already covered above and
  // pre-date this fix).
  it("FR-316: closes when the graph scrolls underneath it, even though `scroll` doesn't bubble (capture-phase listener)", () => {
    const onClose = vi.fn();
    render(
      <div>
        <div data-testid="scroller" style={{ overflow: "auto", height: 10 }}>
          <div style={{ height: 1000 }} />
        </div>
        <ContextMenu x={10} y={10} sha="abc1234" items={items} onClose={onClose} />
      </div>,
    );
    const scroller = screen.getByTestId("scroller");
    scroller.dispatchEvent(new Event("scroll", { bubbles: false }));
    expect(onClose).toHaveBeenCalled();
  });

  // toolbar-action-row redesign: the radio-style `checked` item (Pull's strategy picker, Push's
  // remote picker), the per-item `description` line, and the optional `footer` slot.
  describe("toolbar-action-row redesign additions", () => {
    const radioItems = [
      { label: "Auto", checked: true, description: "Follows this repository's own git config" },
      { label: "Merge", checked: false, description: "Always create a merge commit" },
      { label: "Rebase", checked: false, description: "Replay your commits on top" },
    ];

    it("renders checked/unchecked items as menuitemradio with aria-checked, plus each item's description", () => {
      render(<ContextMenu x={10} y={10} sha="abc1234" items={radioItems} onClose={() => {}} />);
      const auto = screen.getByRole("menuitemradio", { name: "Auto" });
      expect(auto).toHaveAttribute("aria-checked", "true");
      const merge = screen.getByRole("menuitemradio", { name: "Merge" });
      expect(merge).toHaveAttribute("aria-checked", "false");
      expect(screen.getByText("Follows this repository's own git config")).toBeInTheDocument();
    });

    it("plain (no `checked` field) items stay role=menuitem with no aria-checked attribute at all", () => {
      render(<ContextMenu x={10} y={10} sha="abc1234" items={items} onClose={() => {}} />);
      const item = screen.getByRole("menuitem", { name: "Checkout" });
      expect(item).not.toHaveAttribute("aria-checked");
    });

    it("renders an optional footer below the item list, omitted by every caller that doesn't pass one", () => {
      const { rerender } = render(<ContextMenu x={10} y={10} sha="abc1234" items={items} onClose={() => {}} />);
      expect(screen.queryByText(/applies to this pull only/i)).not.toBeInTheDocument();

      rerender(
        <ContextMenu
          x={10}
          y={10}
          sha="abc1234"
          items={radioItems}
          onClose={() => {}}
          footer={<span>Applies to this pull only. Your git config is never written.</span>}
        />,
      );
      expect(screen.getByText(/applies to this pull only/i)).toBeInTheDocument();
    });

    it("opens with focus already on the checked item, and Up/Down/Home/End move focus among enabled items only, wrapping at either end", async () => {
      const withOneDisabled = [
        { label: "Auto", checked: true },
        { label: "Merge", checked: false, disabled: true },
        { label: "Rebase", checked: false },
      ];
      render(<ContextMenu x={10} y={10} sha="abc1234" items={withOneDisabled} onClose={() => {}} />);
      const auto = screen.getByRole("menuitemradio", { name: "Auto" });
      const rebase = screen.getByRole("menuitemradio", { name: "Rebase" });
      expect(auto).toHaveFocus();

      // Disabled "Merge" is skipped entirely by arrow navigation.
      await userEvent.keyboard("{ArrowDown}");
      expect(rebase).toHaveFocus();
      // Wraps back around.
      await userEvent.keyboard("{ArrowDown}");
      expect(auto).toHaveFocus();
      await userEvent.keyboard("{ArrowUp}");
      expect(rebase).toHaveFocus();
      await userEvent.keyboard("{Home}");
      expect(auto).toHaveFocus();
      await userEvent.keyboard("{End}");
      expect(rebase).toHaveFocus();
    });
  });

  // Found via real user report: the Toolbar's rightmost "More actions" button anchors its menu's
  // LEFT edge at the button's own left edge (`anchorBelow` in Toolbar.tsx), so on a wide window the
  // menu's right edge runs off the actual viewport with no way to see or reach the cut-off items —
  // this component previously never checked the anchor point against the window at all. Fixed
  // generically here (benefits every caller, not just the overflow menu) rather than in one caller.
  describe("viewport-edge clamping", () => {
    const realInnerWidth = window.innerWidth;
    const realInnerHeight = window.innerHeight;

    afterEach(() => {
      Object.defineProperty(window, "innerWidth", { value: realInnerWidth, configurable: true });
      Object.defineProperty(window, "innerHeight", { value: realInnerHeight, configurable: true });
    });

    function mockMenuSize(width: number, height: number) {
      // jsdom never computes real layout — `getBoundingClientRect` always returns zeros unless
      // stubbed, so this stands in for "the menu, once rendered, turned out to be this big."
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
        width,
        height,
        top: 0,
        left: 0,
        right: width,
        bottom: height,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });
    }

    it("pulls the menu left when its anchor would push it past the right edge of the window", () => {
      Object.defineProperty(window, "innerWidth", { value: 400, configurable: true });
      Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
      mockMenuSize(220, 100);
      // Anchored at x=350 -- 350 + 220 = 570, well past the 400px-wide window.
      const { container } = render(<ContextMenu x={350} y={10} sha="abc1234" items={items} onClose={() => {}} />);
      const menu = container.querySelector<HTMLElement>(".gh-context-menu")!;
      // Clamped to keep its full 220px width inside the window, with an 8px margin from the edge.
      expect(menu.style.left).toBe("172px");
      // y=10 already fits (10 + 100 well under 800) -- untouched.
      expect(menu.style.top).toBe("10px");
    });

    it("pulls the menu up when its anchor would push it past the bottom edge of the window", () => {
      Object.defineProperty(window, "innerWidth", { value: 1000, configurable: true });
      Object.defineProperty(window, "innerHeight", { value: 300, configurable: true });
      mockMenuSize(200, 150);
      const { container } = render(<ContextMenu x={10} y={250} sha="abc1234" items={items} onClose={() => {}} />);
      const menu = container.querySelector<HTMLElement>(".gh-context-menu")!;
      expect(menu.style.left).toBe("10px");
      expect(menu.style.top).toBe("142px");
    });

    it("leaves the anchor untouched when the menu already fits fully on screen", () => {
      Object.defineProperty(window, "innerWidth", { value: 1920, configurable: true });
      Object.defineProperty(window, "innerHeight", { value: 1080, configurable: true });
      mockMenuSize(220, 100);
      const { container } = render(<ContextMenu x={50} y={50} sha="abc1234" items={items} onClose={() => {}} />);
      const menu = container.querySelector<HTMLElement>(".gh-context-menu")!;
      expect(menu.style.left).toBe("50px");
      expect(menu.style.top).toBe("50px");
    });
  });
});
