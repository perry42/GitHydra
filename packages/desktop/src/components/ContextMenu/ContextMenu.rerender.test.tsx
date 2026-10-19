// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContextMenu } from "./ContextMenu";

// Toolbar passes an inline onClose, so every parent re-render used to re-run the focus-on-open effect and snap focus back.
const makeItems = () => [
  { label: "Auto", checked: false, onSelect: () => {} },
  { label: "Merge", checked: true, onSelect: () => {} },
  { label: "Rebase", checked: false, onSelect: () => {} },
];

describe("ContextMenu parent re-render", () => {
  it("keeps focus where ArrowDown moved it when the parent re-renders with a new onClose", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ContextMenu x={0} y={0} ariaLabel="Strategy" items={makeItems()} onClose={() => {}} />);
    expect(screen.getByRole("menuitemradio", { name: "Merge" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitemradio", { name: "Rebase" })).toHaveFocus();
    rerender(<ContextMenu x={0} y={0} ariaLabel="Strategy" items={makeItems()} onClose={() => {}} />);
    expect(screen.getByRole("menuitemradio", { name: "Rebase" })).toHaveFocus();
  });

  it("calls the newest onClose on Escape after a re-render", async () => {
    const user = userEvent.setup();
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<ContextMenu x={0} y={0} ariaLabel="Strategy" items={makeItems()} onClose={first} />);
    rerender(<ContextMenu x={0} y={0} ariaLabel="Strategy" items={makeItems()} onClose={second} />);
    await user.keyboard("{Escape}");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("fires an accordion's onMenuOpen once across re-renders", () => {
    const onMenuOpen = vi.fn();
    const mk = () => [{ label: "Open in", accordion: { children: [], hint: "h", description: "d", onMenuOpen } }];
    const { rerender } = render(<ContextMenu x={0} y={0} ariaLabel="A" items={mk()} onClose={() => {}} />);
    rerender(<ContextMenu x={0} y={0} ariaLabel="A" items={mk()} onClose={() => {}} />);
    expect(onMenuOpen).toHaveBeenCalledTimes(1);
  });
});
