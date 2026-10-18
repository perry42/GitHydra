// SPDX-License-Identifier: GPL-3.0-or-later
import { useRef, useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { GITHYDRA_TAB_ID, type ProgramsSnapshot } from "../../../shared/programsContract";
import { buildOpenInProgramItem, type OpenInProgramModel } from "../../lib/openInProgram";
import { mockProgram } from "../../test/mockGitHydra";
import { ContextMenu } from "./ContextMenu";

/** specs/external-programs.md AC1: the inline accordion is ONE menu row; every behaviour of FR-617. */

function snapshot(over: Partial<ProgramsSnapshot> = {}): ProgramsSnapshot {
  return {
    programs: [
      mockProgram({ id: "vscode", name: "Visual Studio Code" }),
      mockProgram({ id: "cursor", name: "Cursor" }),
      mockProgram({ id: "gone", name: "Old Editor", path: "C:/Tools/gone/gone.exe", available: false, unavailableReason: "Not found at C:/Tools/gone/gone.exe" }),
      mockProgram({ id: "hidden", name: "Hidden Editor", hidden: true }),
    ],
    defaultId: "cursor",
    fallbackReason: null,
    ...over,
  };
}

function model(over: Partial<OpenInProgramModel> = {}): OpenInProgramModel {
  return {
    snapshot: snapshot(),
    refresh: vi.fn(),
    openInTab: vi.fn(),
    openInProgram: vi.fn(),
    managePrograms: vi.fn(),
    ...over,
  };
}

function Harness({ m, onClose = () => {}, expanded = false }: { m: OpenInProgramModel; onClose?: () => void; expanded?: boolean }) {
  return (
    <ContextMenu
      x={10}
      y={10}
      ariaLabel="Actions for branch feature"
      items={[
        { label: "Checkout", onSelect: () => {} },
        buildOpenInProgramItem(m, { label: "Open worktree", contextLine: "Checked out at C:/w/feature", initiallyExpanded: expanded }),
      ]}
      onClose={onClose}
    />
  );
}

const parent = () => screen.getByRole("menuitem", { name: "Open worktree" });

describe("Open worktree accordion (FR-617, AC1)", () => {
  it("is one row, opens collapsed, with aria-haspopup, aria-expanded=false and no children in the accessibility tree", () => {
    render(<Harness m={model()} />);
    expect(screen.getAllByRole("menuitem", { name: "Open worktree" })).toHaveLength(1);
    expect(parent()).toHaveAttribute("aria-haspopup", "menu");
    expect(parent()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menuitem", { name: "GitHydra tab" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /Cursor/ })).toBeNull();
    // The visible hint and the checked-out line are there.
    expect(screen.getByText("Opens in Cursor")).toBeInTheDocument();
    expect(screen.getByText("Checked out at C:/w/feature")).toBeInTheDocument();
  });

  it("carries the description text exactly as FR-617, in a real element reached through aria-describedby", () => {
    render(<Harness m={model()} />);
    const ids = parent().getAttribute("aria-describedby")!.split(" ");
    const texts = ids.map((id) => document.getElementById(id)?.textContent);
    expect(texts).toContain("Enter opens in Cursor, Right arrow chooses another program");
  });

  it("a click on the row body runs the default once and closes the menu", async () => {
    const m = model();
    const onClose = vi.fn();
    render(<Harness m={m} onClose={onClose} />);
    await userEvent.click(parent());
    expect(m.openInProgram).toHaveBeenCalledTimes(1);
    expect(m.openInProgram).toHaveBeenCalledWith("cursor");
    expect(onClose).toHaveBeenCalled();
  });

  it("Enter on the row runs the default too", async () => {
    const m = model();
    render(<Harness m={m} />);
    parent().focus();
    await userEvent.keyboard("{Enter}");
    expect(m.openInProgram).toHaveBeenCalledWith("cursor");
  });

  it("the chevron expands in place (no launch) and focus lands on the default child", async () => {
    const m = model();
    const onClose = vi.fn();
    render(<Harness m={m} onClose={onClose} />);
    await userEvent.click(parent().querySelector(".gh-context-menu__chevron")!);
    expect(m.openInProgram).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(parent()).toHaveAttribute("aria-expanded", "true");
    const cursor = screen.getByRole("menuitem", { name: /Cursor/ });
    expect(document.activeElement).toBe(cursor);
    expect(cursor).toHaveTextContent("default");
    expect(within(cursor).getByText("default")).toBeInTheDocument();
  });

  it("Right arrow expands from the row and focuses the default child; Left collapses and returns focus to the parent", async () => {
    render(<Harness m={model()} />);
    parent().focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(parent()).toHaveAttribute("aria-expanded", "true");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: /Cursor/ }));
    await userEvent.keyboard("{ArrowLeft}");
    expect(parent()).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).toBe(parent());
    expect(screen.queryByRole("menuitem", { name: /Cursor/ })).toBeNull();
  });

  it("lists GitHydra tab, the detected programs, a disabled not-found row, then Manage programs; hidden programs are not listed", async () => {
    render(<Harness m={model()} />);
    parent().focus();
    await userEvent.keyboard("{ArrowRight}");
    const names = within(screen.getByRole("menu", { name: /Open worktree: choose a program/ }))
      .getAllByRole("menuitem")
      .map((i) => i.textContent);
    expect(names[0]).toMatch(/^GitHydra tab/);
    expect(names.findIndex((n) => /Cursor/.test(n ?? ""))).toBeGreaterThan(0);
    expect(names.some((n) => /Hidden Editor/.test(n ?? ""))).toBe(false);
    expect(names.at(-2)).toMatch(/Old Editor/);
    expect(names.at(-1)).toMatch(/Manage programs/);
  });

  it("the disabled child is aria-disabled, reachable with the arrow keys, its aria-describedby resolves to the reason, and it does nothing", async () => {
    const m = model();
    const onClose = vi.fn();
    render(<Harness m={m} onClose={onClose} />);
    parent().focus();
    await userEvent.keyboard("{ArrowRight}");
    const gone = screen.getByRole("menuitem", { name: /Old Editor/ });
    expect(gone).toHaveAttribute("aria-disabled", "true");
    expect(document.getElementById(gone.getAttribute("aria-describedby")!)).toHaveTextContent("Not found at C:/Tools/gone/gone.exe");
    // From the default child (Cursor) ArrowDown reaches it before Manage programs.
    let reached = false;
    for (let i = 0; i < 6 && !reached; i++) {
      await userEvent.keyboard("{ArrowDown}");
      reached = document.activeElement === gone;
    }
    expect(reached).toBe(true);
    await userEvent.keyboard("{Enter}");
    expect(m.openInProgram).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Enter, Space and Right arrow on a disabled row do nothing, and its reason stays reachable", async () => {
    const m = model();
    const onClose = vi.fn();
    render(<Harness m={m} onClose={onClose} expanded />);
    const gone = screen.getByRole("menuitem", { name: /Old Editor/ });
    gone.focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    await userEvent.keyboard("{ArrowRight}");
    expect(m.openInProgram).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(gone);
    expect(screen.getByRole("menuitem", { name: "Open worktree" })).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById(gone.getAttribute("aria-describedby")!)).toHaveTextContent("Not found at");
  });

  it("a program that changed since approval is a disabled row with the review reason", async () => {
    const reason = "This program changed since you approved it. Review it in Manage programs.";
    const m = model({ snapshot: snapshot({ programs: [mockProgram({ id: "ed", name: "Ed", available: false, needsReconfirm: true, unavailableReason: reason })] }) });
    render(<Harness m={m} expanded />);
    const row = screen.getByRole("menuitem", { name: /Ed/ });
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(document.getElementById(row.getAttribute("aria-describedby")!)).toHaveTextContent(reason);
    await userEvent.click(row);
    expect(m.openInProgram).not.toHaveBeenCalled();
  });

  it("choosing a program runs it for that program and closes; GitHydra tab and Manage programs run theirs", async () => {
    const m = model();
    const onClose = vi.fn();
    const { rerender } = render(<Harness m={m} onClose={onClose} expanded />);
    await userEvent.click(screen.getByRole("menuitem", { name: /Visual Studio Code/ }));
    expect(m.openInProgram).toHaveBeenCalledWith("vscode");
    await userEvent.click(screen.getByRole("menuitem", { name: "GitHydra tab" }));
    expect(m.openInTab).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("menuitem", { name: /Manage programs/ }));
    expect(m.managePrograms).toHaveBeenCalledTimes(1);
    rerender(<Harness m={m} onClose={onClose} expanded />);
  });

  it("Esc closes the menu", async () => {
    const onClose = vi.fn();
    render(<Harness m={model()} onClose={onClose} />);
    parent().focus();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("first run (no default): the body click expands and does NOT launch; the hint asks to choose", async () => {
    const m = model({ snapshot: snapshot({ defaultId: null }) });
    render(<Harness m={m} />);
    expect(screen.getByText("Choose a program")).toBeInTheDocument();
    await userEvent.click(parent());
    expect(m.openInProgram).not.toHaveBeenCalled();
    expect(m.openInTab).not.toHaveBeenCalled();
    expect(parent()).toHaveAttribute("aria-expanded", "true");
    const texts = parent().getAttribute("aria-describedby")!.split(" ").map((id) => document.getElementById(id)?.textContent);
    expect(texts).toContain("Enter or Right arrow chooses a program.");
  });

  it("a vanished default falls back to GitHydra tab and says why", async () => {
    const reason = "Cursor was not found, so GitHydra tab is used instead.";
    const m = model({ snapshot: snapshot({ defaultId: GITHYDRA_TAB_ID, fallbackReason: reason }) });
    render(<Harness m={m} />);
    expect(screen.getByText(reason)).toBeInTheDocument();
    await userEvent.click(parent());
    expect(m.openInTab).toHaveBeenCalledTimes(1);
    expect(m.openInProgram).not.toHaveBeenCalled();
  });

  it("asks the caller to re-validate its list when the menu opens", () => {
    const m = model();
    render(<Harness m={m} />);
    expect(m.refresh).toHaveBeenCalledTimes(1);
  });

  it("opening expanded (the chooser) puts focus on the default child straight away", () => {
    render(<Harness m={model()} expanded />);
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: /Cursor/ }));
  });
});

describe("focus returns to the invoking control on Esc (FR-617)", () => {
  function WithInvoker() {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLButtonElement | null>(null);
    return (
      <>
        <button ref={ref} type="button" onClick={() => setOpen(true)}>
          invoker
        </button>
        {open && (
          <ContextMenu
            x={0}
            y={0}
            ariaLabel="Actions"
            items={[buildOpenInProgramItem(model(), { label: "Open worktree" })]}
            onClose={() => {
              setOpen(false);
              queueMicrotask(() => ref.current?.focus());
            }}
          />
        )}
      </>
    );
  }

  it("document.activeElement is the same invoker element after Esc, expanded or not", async () => {
    render(<WithInvoker />);
    const invoker = screen.getByRole("button", { name: "invoker" });
    await userEvent.click(invoker);
    parent().focus();
    await userEvent.keyboard("{ArrowRight}{Escape}");
    await Promise.resolve();
    expect(document.activeElement).toBe(invoker);
  });
});
