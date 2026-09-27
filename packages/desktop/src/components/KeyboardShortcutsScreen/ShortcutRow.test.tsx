// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ShortcutRow, type ShortcutRowProps } from "./ShortcutRow";

function baseProps(overrides: Partial<ShortcutRowProps> = {}): ShortcutRowProps {
  return {
    commandId: "new-branch",
    label: "New branch…",
    keybindings: [],
    hasOverride: false,
    isActive: false,
    conflict: null,
    message: null,
    disabled: false,
    onStartEdit: vi.fn(),
    onCapture: vi.fn(),
    onCancelEdit: vi.fn(),
    onReassign: vi.fn(),
    onCancelConflict: vi.fn(),
    onResetToDefault: vi.fn(),
    ...overrides,
  };
}

function renderRow(props: Partial<ShortcutRowProps> = {}) {
  return render(
    <ul>
      <ShortcutRow {...baseProps(props)} />
    </ul>,
  );
}

describe("ShortcutRow (specs/keyboard-shortcut-rebinding.md FR-402)", () => {
  it("shows 'No shortcut' plus an icon-only Edit button when there's no binding and no override", () => {
    renderRow();
    expect(screen.getByText(/no shortcut/i)).toBeInTheDocument();
    const editButton = screen.getByRole("button", { name: /edit shortcut for new branch/i });
    expect(editButton).toBeInTheDocument();
    expect(editButton).toHaveAttribute("title", "Edit shortcut for New branch…");
    expect(screen.queryByRole("button", { name: /reset to default/i })).not.toBeInTheDocument();
  });

  it("clicking Edit calls onStartEdit with this row's command id", async () => {
    const onStartEdit = vi.fn();
    renderRow({ onStartEdit });
    await userEvent.click(screen.getByRole("button", { name: /edit shortcut/i }));
    expect(onStartEdit).toHaveBeenCalledWith("new-branch");
  });

  it("FR-400: shows 'Reset to default' only when hasOverride is true", () => {
    renderRow({ hasOverride: true });
    expect(screen.getByRole("button", { name: /reset to default/i })).toBeInTheDocument();
  });

  it("clicking 'Reset to default' calls onResetToDefault with this row's command id", async () => {
    const onResetToDefault = vi.fn();
    renderRow({ hasOverride: true, onResetToDefault });
    await userEvent.click(screen.getByRole("button", { name: /reset to default/i }));
    expect(onResetToDefault).toHaveBeenCalledWith("new-branch");
  });

  it("renders each keybinding as KeyCap chips joined by '/' between multiple combos", () => {
    renderRow({
      keybindings: [
        { key: "r", mod: true },
        { key: "F5" },
      ],
    });
    // eslint-disable-next-line testing-library/no-node-access
    const chips = Array.from(document.querySelectorAll(".gh-keycap")).map((c) => c.textContent);
    expect(chips).toEqual(["Ctrl", "R", "F5"]);
  });

  it("disabled=true disables both Edit and (when present) Reset, without hiding either", () => {
    renderRow({ disabled: true, hasOverride: true });
    expect(screen.getByRole("button", { name: /edit shortcut/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /reset to default/i })).toBeDisabled();
  });

  it("FR-397/398: shows the rejection message inline (role=alert) when not active", () => {
    renderRow({ message: "Shortcuts must include Ctrl (Cmd on macOS)." });
    expect(screen.getByRole("alert")).toHaveTextContent(/must include ctrl/i);
  });

  it("isActive with no conflict shows the 'Press a key combination…' placeholder and no Edit/Reset buttons", () => {
    renderRow({ isActive: true });
    expect(screen.getByText(/press a key combination/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /edit shortcut/i })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: /press a key combination/i })).toBeInTheDocument();
  });

  it("FR-399: isActive with a conflict shows the warning naming the conflicting command, plus Reassign/Cancel", () => {
    renderRow({
      isActive: true,
      conflict: { combo: { key: "p", mod: true, shift: true }, conflictLabel: "Pull" },
    });
    const group = screen.getByRole("group", { name: /conflict/i });
    expect(within(group).getByText(/is already used by/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reassign/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^cancel$/i })).toBeInTheDocument();
  });

  it("clicking Reassign/Cancel in the conflict view calls the matching callback", async () => {
    const onReassign = vi.fn();
    const onCancelConflict = vi.fn();
    renderRow({
      isActive: true,
      conflict: { combo: { key: "p", mod: true }, conflictLabel: "Pull" },
      onReassign,
      onCancelConflict,
    });
    await userEvent.click(screen.getByRole("button", { name: /reassign/i }));
    expect(onReassign).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(onCancelConflict).toHaveBeenCalledTimes(1);
  });
});
