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
});
