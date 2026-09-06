// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmDialog } from "./ConfirmDialog";

describe("ConfirmDialog", () => {
  it("names the file and states the change is unrecoverable, as an alertdialog (FR-31)", () => {
    render(
      <ConfirmDialog
        title="Discard changes?"
        message={'Discard changes to "src/a.ts"? This cannot be undone.'}
        confirmLabel="Discard"
        destructive
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    const dialog = screen.getByRole("alertdialog", { name: /discard changes\?/i });
    expect(dialog).toHaveAccessibleDescription(/src\/a\.ts.*cannot be undone/i);
  });

  it("calls onConfirm only after an explicit click — no single-click destructive path", async () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        title="Discard changes?"
        message="Discard changes to a.ts?"
        confirmLabel="Discard"
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    expect(onConfirm).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /discard/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("cancels on Escape and on clicking the overlay backdrop, and leaves the file untouched", async () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        title="Discard changes?"
        message="Discard changes to a.ts?"
        confirmLabel="Discard"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("cancels via the explicit Cancel button", async () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        title="Discard changes?"
        message="Discard changes to a.ts?"
        confirmLabel="Discard"
        onConfirm={() => {}}
        onCancel={onCancel}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
