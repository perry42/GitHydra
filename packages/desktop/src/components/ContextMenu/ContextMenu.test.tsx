// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
});
