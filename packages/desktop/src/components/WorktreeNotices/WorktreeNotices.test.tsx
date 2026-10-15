// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WorktreeNotice } from "../../lib/worktreeNotices";
import { WorktreeNotices } from "./WorktreeNotices";

const notice = (over: Partial<WorktreeNotice>): WorktreeNotice => ({ id: 1, tone: "info", text: "Hello", actions: [], ...over });

describe("WorktreeNotices (FR-634, banner-uniform-look AC5)", () => {
  it("uses the shared banner classes and an aria-hidden icon; the container is a labelled region", () => {
    render(<WorktreeNotices notices={[notice({ tone: "warning", text: "Careful" })]} onDismiss={() => {}} onOpenBranches={() => {}} />);
    const banner = screen.getByRole("alert");
    expect(banner.className).toContain("gh-status-banner");
    expect(banner.className).toContain("gh-status-banner--warning");
    expect(banner.querySelector(".gh-banner-icon")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("region", { name: "Worktree notices" })).toBeInTheDocument();
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

  it("a group is ONE banner with ONE Dismiss and ONE live region; each line has its own quiet 'Copy command'", async () => {
    const write = vi.fn(async (_t: string) => {});
    render(
      <WorktreeNotices
        notices={[
          notice({
            tone: "success",
            text: 'Created worktree "x".',
            lines: [
              { text: "package.json found - dependencies are not installed in this worktree.", action: { kind: "copy", label: "Copy command", text: "npm ci" } },
              { text: "A post-checkout hook in this repository was skipped." },
            ],
          }),
        ]}
        onDismiss={() => {}}
        onOpenBranches={() => {}}
        writeClipboard={write}
      />,
    );
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
    expect(screen.getAllByRole("button", { name: "Dismiss" })).toHaveLength(1);
    const line = screen.getByText(/package\.json found/).closest("li")!;
    const copy = within(line).getByRole("button", { name: "Copy command" });
    expect(copy.className).toContain("gh-status-banner__action--quiet");
    await userEvent.click(copy);
    expect(write).toHaveBeenCalledWith("npm ci");
    expect(await within(line).findByRole("button", { name: "Copied" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" }).className).toContain("gh-status-banner__action--quiet");
  });

  it("shows control and bidi characters in notice text visibly", () => {
    render(<WorktreeNotices notices={[notice({ text: "branch a" + String.fromCharCode(0x202e) + "b" })]} onDismiss={() => {}} onOpenBranches={() => {}} />);
    expect(screen.getByText(/branch a/).textContent).toContain("\\u{202e}");
  });

  it("the quiet modifier is in the shared stylesheet, keeps 24px, and no existing banner class uses it", () => {
    const css = fs.readFileSync(path.join(__dirname, "../StatusBanner/StatusBanner.css"), "utf8");
    expect(css).toMatch(/\.gh-status-banner__action--quiet \{[^}]*min-height: 24px/s);
    const tsx = fs.readFileSync(path.join(__dirname, "../StatusBanner/StatusBanner.tsx"), "utf8");
    expect(tsx).not.toContain("action--quiet");
  });
});
