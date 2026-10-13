// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WorktreeNotice } from "../../lib/worktreeNotices";
import { WorktreeNotices } from "./WorktreeNotices";

const notice = (over: Partial<WorktreeNotice>): WorktreeNotice => ({ id: 1, tone: "info", text: "Hello", actions: [], ...over });

describe("WorktreeNotices (FR-634, banner-uniform-look AC5)", () => {
  it("uses the shared banner classes and an aria-hidden icon", () => {
    render(<WorktreeNotices notices={[notice({ tone: "warning", text: "Careful" })]} onDismiss={() => {}} onOpenBranches={() => {}} />);
    const banner = screen.getByRole("alert");
    expect(banner.className).toContain("gh-status-banner");
    expect(banner.className).toContain("gh-status-banner--warning");
    expect(banner.querySelector(".gh-banner-icon")).toHaveAttribute("aria-hidden", "true");
  });

  it("persists with fake timers advanced 60 s and is removed only by Dismiss", async () => {
    vi.useFakeTimers();
    try {
      const onDismiss = vi.fn();
      render(<WorktreeNotices notices={[notice({})]} onDismiss={onDismiss} onOpenBranches={() => {}} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(screen.getByText("Hello")).toBeInTheDocument();
      screen.getByRole("button", { name: "Dismiss" }).click();
      expect(onDismiss).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the kept-branch notice carries 'Open Branches'", async () => {
    const onOpenBranches = vi.fn();
    render(
      <WorktreeNotices
        notices={[notice({ tone: "warning", actions: [{ kind: "openBranches", label: "Open Branches" }] })]}
        onDismiss={() => {}}
        onOpenBranches={onOpenBranches}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Open Branches" }));
    expect(onOpenBranches).toHaveBeenCalled();
  });

  it("'Copy command' writes the fixed string to the clipboard and shows 'Copied'; it executes nothing", async () => {
    const write = vi.fn(async (_t: string) => {});
    render(
      <WorktreeNotices
        notices={[notice({ text: "package.json found - dependencies are not installed in this worktree.", actions: [{ kind: "copy", label: "Copy command", text: "npm ci" }] })]}
        onDismiss={() => {}}
        onOpenBranches={() => {}}
        writeClipboard={write}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Copy command" }));
    expect(write).toHaveBeenCalledWith("npm ci");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("a disabled action is aria-disabled (reason reachable), not a disabled button, and does nothing", async () => {
    render(
      <WorktreeNotices
        notices={[notice({ actions: [{ kind: "disabled", label: "Initialize submodules", reason: "Not yet." }] })]}
        onDismiss={() => {}}
        onOpenBranches={() => {}}
      />,
    );
    const button = screen.getByRole("button", { name: "Initialize submodules" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute("title", "Not yet.");
  });
});
