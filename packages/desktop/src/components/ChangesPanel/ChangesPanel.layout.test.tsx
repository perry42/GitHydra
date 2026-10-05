// SPDX-License-Identifier: GPL-3.0-or-later
// specs/changes-panel-layout.md FR-486..FR-490 (AC1-AC5): drawer width, compact file rows, pinned commit form.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WorkingDirectoryChanges } from "@githydra/git-core";
import { ChangesPanel } from "./ChangesPanel";
import { FilePath, splitPath } from "./FilePath";
import { makeMockGitHydra } from "../../test/mockGitHydra";
import { CHANGES_PANEL_STORAGE_KEY } from "../../lib/layoutSizes";

function renderPanel(changes: Partial<WorkingDirectoryChanges> = {}) {
  const api = makeMockGitHydra({ workingDirectoryChanges: { staged: [], unstaged: [], untracked: [], conflicted: [], ...changes } });
  return render(
    <ChangesPanel
      api={api}
      changes={{ staged: [], unstaged: [], untracked: [], conflicted: [], ...changes }}
      onClose={() => {}}
      onWorkingDirChanged={() => {}}
      onCommitCreated={() => {}}
    />,
  );
}

function setWindowWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
}

const panelSep = () => screen.getByRole("separator", { name: "Resize Changes panel" });
const panelEl = () => screen.getByRole("complementary", { name: "Changes" });

describe("Changes drawer width (FR-486)", () => {
  const originalWidth = window.innerWidth;
  beforeEach(() => {
    window.localStorage.clear();
    setWindowWidth(1400);
  });
  afterEach(() => setWindowWidth(originalWidth));

  it("opens at about 60% of the window", () => {
    renderPanel({ unstaged: [{ path: "a.ts", status: "modified", category: "unstaged" }] });
    expect(panelEl().style.width).toBe("840px");
  });

  it("keyboard arrows resize (ArrowLeft grows, as dragging left does) and the width persists across remounts", () => {
    const first = renderPanel();
    fireEvent.keyDown(panelSep(), { key: "ArrowLeft" });
    expect(panelEl().style.width).toBe("856px");
    expect(window.localStorage.getItem(CHANGES_PANEL_STORAGE_KEY)).toBe("856");
    first.unmount();
    renderPanel();
    expect(panelEl().style.width).toBe("856px");
  });

  it("double-clicking the handle restores the default and forgets the stored width", () => {
    renderPanel();
    fireEvent.keyDown(panelSep(), { key: "ArrowLeft" });
    fireEvent.keyDown(panelSep(), { key: "ArrowLeft" });
    expect(panelEl().style.width).toBe("872px");
    fireEvent.doubleClick(panelSep());
    expect(panelEl().style.width).toBe("840px");
    expect(window.localStorage.getItem(CHANGES_PANEL_STORAGE_KEY)).toBeNull();
  });

  it("is a labelled, focusable separator", () => {
    renderPanel();
    expect(panelSep()).toHaveAttribute("tabindex", "0");
    expect(panelSep()).toHaveAttribute("aria-orientation", "vertical");
  });

  it("keeps the diff >= 480px: the file column's max is the drawer width minus 480", () => {
    renderPanel();
    expect(screen.getByRole("separator", { name: "Resize file list" })).toHaveAttribute("aria-valuemax", "360");
  });

  it("in a drawer too small for that, the file column sits at its own 160px minimum (the diff wins)", () => {
    setWindowWidth(700); // drawer = its 420px floor; 420 - 480 < 160
    renderPanel();
    const fileSep = screen.getByRole("separator", { name: "Resize file list" });
    expect(fileSep).toHaveAttribute("aria-valuenow", "160");
  });

  it("does not crash when localStorage is unavailable", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    renderPanel();
    fireEvent.keyDown(panelSep(), { key: "ArrowLeft" });
    expect(panelEl().style.width).toBe("856px");
    get.mockRestore();
    set.mockRestore();
  });
});

describe("compact file rows (FR-487)", () => {
  it("splitPath keeps the name intact and the directory separate", () => {
    expect(splitPath("packages/desktop/src/hooks/useChangesPanel.ts")).toEqual({
      dir: "packages/desktop/src/hooks",
      name: "useChangesPanel.ts",
    });
    expect(splitPath("README.md")).toEqual({ dir: "", name: "README.md" });
  });

  it("renders the name first and the directory after it, left-truncatable and with the full path on hover", () => {
    const { container } = render(<FilePath path="packages/desktop/src/hooks/useChangesPanel.ts" />);
    const root = container.firstElementChild as HTMLElement;
    expect(root).toHaveAttribute("title", "packages/desktop/src/hooks/useChangesPanel.ts");
    const [name, dir] = Array.from(root.children) as [HTMLElement, HTMLElement];
    expect(name).toHaveClass("gh-changes-panel__file-name");
    expect(name).toHaveTextContent("useChangesPanel.ts");
    expect(dir).toHaveClass("gh-changes-panel__file-dir");
    // The <bdi> keeps the path left-to-right inside the rtl ellipsis trick.
    expect(dir.querySelector("bdi")).toHaveTextContent("packages/desktop/src/hooks");
  });

  it("names the old path for a rename, for screen readers and as the tooltip", () => {
    const { container } = render(<FilePath path="src/new.ts" oldPath="src/old.ts" />);
    expect(container.firstElementChild).toHaveAttribute("title", "src/old.ts → src/new.ts");
    expect(container).toHaveTextContent("renamed from src/old.ts");
  });

  it("Stage and Discard are real, Tab-reachable buttons right after the row's file button", async () => {
    renderPanel({ unstaged: [{ path: "src/b.ts", status: "modified", category: "unstaged" }] });
    const row = screen.getByTitle("src/b.ts").closest<HTMLElement>(".gh-changes-panel__file")!;
    const fileBtn = within(row).getAllByRole("button")[0]!;
    fileBtn.focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(within(row).getByRole("button", { name: "Stage" }));
    await userEvent.tab();
    expect(document.activeElement).toBe(within(row).getByRole("button", { name: /discard changes to src\/b\.ts/i }));
  });
});

describe("pinned commit form (FR-489)", () => {
  const files = Array.from({ length: 500 }, (_, i) => ({
    path: `dir/file-${i}.ts`,
    status: "modified" as const,
    category: "unstaged" as const,
  }));

  const more = () => document.querySelector<HTMLElement>(".gh-changes-panel__composer-more")!;

  it("sits outside the scrolling file list, so the subject is visible with 500 changed files", () => {
    renderPanel({ unstaged: files });
    // Not getByLabelText: with 500 rows jsdom spends tens of seconds resolving labels, which is not what this test is about.
    const subject = document.getElementById("gh-commit-subject")!;
    expect(subject.closest(".gh-changes-panel__scroll")).toBeNull();
    const scroll = document.querySelector(".gh-changes-panel__scroll")!;
    expect(scroll.querySelectorAll(".gh-changes-panel__file")).toHaveLength(500);
    // The form is the column's last child: pinned beneath the list, not inside it.
    const column = document.querySelector(".gh-changes-panel__files")!;
    expect(column.lastElementChild).toBe(subject.closest("form"));
  });

  it("starts collapsed, expands on focus, and collapses on blur when body is empty and Amend is off", async () => {
    renderPanel({ unstaged: files.slice(0, 2) });
    expect(more()).toHaveAttribute("hidden");
    await userEvent.click(screen.getByLabelText("Subject"));
    expect(more()).not.toHaveAttribute("hidden");
    // Moving within the form keeps it open.
    await userEvent.tab();
    expect(more()).not.toHaveAttribute("hidden");
    await userEvent.click(document.body);
    expect(more()).toHaveAttribute("hidden");
  });

  it("never loses typed text: a non-empty body keeps the form open after blur and the text survives", async () => {
    renderPanel({ unstaged: files.slice(0, 2) });
    await userEvent.click(screen.getByLabelText("Subject"));
    await userEvent.type(screen.getByLabelText(/body/i), "why this changed");
    await userEvent.click(document.body);
    expect(more()).not.toHaveAttribute("hidden");
    expect(screen.getByLabelText(/body/i)).toHaveValue("why this changed");
  });

  it("stays open while Amend is checked", async () => {
    const api = makeMockGitHydra({ workingDirectoryChanges: { staged: [], unstaged: [], untracked: [], conflicted: [] } });
    render(
      <ChangesPanel
        api={api}
        changes={{ staged: [], unstaged: [], untracked: [], conflicted: [] }}
        headSha={"a".repeat(40)}
        onClose={() => {}}
        onWorkingDirChanged={() => {}}
        onCommitCreated={() => {}}
      />,
    );
    await userEvent.click(screen.getByLabelText("Subject"));
    await userEvent.click(screen.getByRole("checkbox", { name: /amend last commit/i }));
    await userEvent.click(document.body);
    expect(more()).not.toHaveAttribute("hidden");
  });

  it("Enter in the subject still does not submit a commit", async () => {
    renderPanel({ staged: [{ path: "a.ts", status: "modified", category: "staged" }] });
    const subject = screen.getByLabelText("Subject");
    await userEvent.type(subject, "msg{Enter}");
    expect(subject).toHaveValue("msg");
  });
});
