// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { OrphanedHeadResult } from "@githydra/git-core";
import { OrphanedCommitsDialog } from "./OrphanedCommitsDialog";

const HEAD = "a".repeat(40);

function result(over: Partial<OrphanedHeadResult> = {}): OrphanedHeadResult {
  return {
    status: "orphaned",
    reason: "orphaned",
    headSha: HEAD,
    total: 2,
    totalIsCapped: false,
    shown: [
      { sha: HEAD, shortSha: "aaaaaaa", subject: "Second commit" },
      { sha: "c".repeat(40), shortSha: "ccccccc", subject: "First commit" },
    ],
    ...over,
  };
}

function renderDialog(over: Partial<React.ComponentProps<typeof OrphanedCommitsDialog>> = {}) {
  const handlers = { onCreateBranch: vi.fn(), onLeave: vi.fn(), onCancel: vi.fn() };
  render(<OrphanedCommitsDialog result={result()} description={null} headMoved={false} {...handlers} {...over} />);
  return handlers;
}

describe("OrphanedCommitsDialog (FR-430)", () => {
  it("strips bidi/invisible characters from the description and isolates it", () => {
    const evil = "Merging x into ma" + String.fromCodePoint(0x202e, 0x200b) + "in first.";
    renderDialog({ description: evil });
    const p = screen.getByText("Merging x into main first.");
    expect(p).toHaveClass("gh-orphan-dialog__description");
  });

  it("is an alertdialog with count, commit rows, and the reflog note", () => {
    renderDialog();
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveAccessibleName(/not saved on any branch/i);
    expect(dialog).toHaveAccessibleDescription(/2 commits/);
    expect(dialog).toHaveAccessibleDescription(/reflog/i);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("aaaaaaa")).toBeInTheDocument();
    expect(screen.getByText("Second commit")).toBeInTheDocument();
  });

  it("singular and capped counts", () => {
    const { unmount } = render(
      <OrphanedCommitsDialog
        result={result({ total: 1, shown: [result().shown[0]!] })}
        description={null}
        headMoved={false}
        onCreateBranch={() => {}}
        onLeave={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole("alertdialog")).toHaveAccessibleDescription(/1 commit\b(?!s)/);
    unmount();
    renderDialog({ result: result({ total: 1000, totalIsCapped: true }) });
    expect(screen.getByRole("alertdialog")).toHaveAccessibleDescription(/1000\+ commits/);
    expect(screen.getByText(/and 998\+ more/)).toBeInTheDocument();
  });

  it("initial focus is Cancel; Tab order is Create, Leave, Cancel and wraps (focus trapped)", async () => {
    renderDialog();
    const create = screen.getByRole("button", { name: "Create branch here…" });
    const leave = screen.getByRole("button", { name: "Leave commits behind" });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel).toHaveFocus();
    await userEvent.tab();
    expect(create).toHaveFocus(); // wrapped forward out of the last control
    await userEvent.tab();
    expect(leave).toHaveFocus();
    await userEvent.tab();
    expect(cancel).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(leave).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(create).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(cancel).toHaveFocus(); // wrapped backward
  });

  it("Escape and a backdrop click both cancel; Enter on the focused default does not leave commits behind", async () => {
    const h = renderDialog();
    await userEvent.keyboard("{Enter}"); // focus is on Cancel
    expect(h.onCancel).toHaveBeenCalledTimes(1);
    expect(h.onLeave).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    expect(h.onCancel).toHaveBeenCalledTimes(2);
    await userEvent.click(document.querySelector(".gh-confirm-dialog__overlay")!);
    expect(h.onCancel).toHaveBeenCalledTimes(3);
  });

  it("buttons call their handlers", async () => {
    const h = renderDialog();
    await userEvent.click(screen.getByRole("button", { name: "Create branch here…" }));
    await userEvent.click(screen.getByRole("button", { name: "Leave commits behind" }));
    expect(h.onCreateBranch).toHaveBeenCalledTimes(1);
    expect(h.onLeave).toHaveBeenCalledTimes(1);
  });

  it("unknown: generic variant, no commit list, no stderr, still offers all three when headSha is known", () => {
    renderDialog({ result: result({ status: "unknown", reason: "timeout", total: 0, shown: [] }) });
    expect(screen.getByRole("alertdialog")).toHaveAccessibleName("Couldn't check whether this HEAD has unsaved commits");
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.getByRole("button", { name: "Create branch here…" })).toBeInTheDocument();
  });

  it("unknown without a resolvable headSha hides Create branch here (nothing to point a branch at)", () => {
    renderDialog({ result: result({ status: "unknown", reason: "error", headSha: null, total: 0, shown: [] }) });
    expect(screen.queryByRole("button", { name: "Create branch here…" })).toBeNull();
    expect(screen.getByRole("button", { name: "Leave commits behind" })).toBeInTheDocument();
  });

  it("drag copy and the HEAD-moved notice render as text", () => {
    renderDialog({ description: "Merging feature into main needs to check out main first.", headMoved: true });
    expect(screen.getByText("Merging feature into main needs to check out main first.")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/HEAD changed while the dialog was open/);
  });

  it("a hostile subject renders inertly: text node only, isolated, never in a name/label", () => {
    const hostile = '<img src=x onerror="window.__pwned=1"><b>bold</b> ‮evil';
    renderDialog({
      result: result({ total: 1, shown: [{ sha: HEAD, shortSha: "aaaaaaa", subject: hostile }] }),
    });
    const row = screen.getByRole("listitem");
    expect(row.querySelector("img")).toBeNull();
    expect(row.querySelector("b")).toBeNull();
    const subject = row.querySelector(".gh-orphan-dialog__subject")!;
    expect(subject.textContent).toBe(hostile);
    expect(subject).toHaveAttribute("dir", "auto");
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    expect(screen.getByRole("alertdialog").getAttribute("aria-label") ?? "").not.toContain("evil");
    expect(screen.getByRole("alertdialog")).not.toHaveAccessibleName(/onerror/);
  });
});
