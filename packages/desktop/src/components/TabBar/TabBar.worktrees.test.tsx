// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TabBar } from "./TabBar";
import type { RepoTab } from "../../hooks/useRepoTabs";
import type { TabLabelModel } from "../../lib/worktrees";

const tab = (id: string, repoPath: string): RepoTab => ({
  id,
  repoPath,
  remembered: { selectedSha: null, filter: {}, showAllRefs: false, rightPanel: "none", selectedFile: null },
});

describe("TabBar worktree labels (FR-612)", () => {
  const labels: Record<string, TabLabelModel> = {
    t1: { label: "main", suffix: "acme", glyph: "main", title: "/w/acme", ariaLabel: "main, acme, main worktree at /w/acme" },
    t2: { label: "feature/PROJ-1...debounce-v3", suffix: "acme", glyph: "linked", title: "/w/acme.worktrees/f", ariaLabel: "feature/PROJ-1-search-debounce-v3, acme, worktree at /w/acme.worktrees/f" },
  };

  it("renders the glyph, the branch label and the muted repo suffix; the full path is the title and the accessible name", () => {
    render(
      <TabBar
        tabs={[tab("t1", "/w/acme"), tab("t2", "/w/acme.worktrees/f"), tab("t3", "/w/other")]}
        activeTabId="t1"
        onActivate={() => {}}
        onClose={() => {}}
        onNewTab={() => {}}
        tabLabels={labels}
      />,
    );
    const [t1, t2, t3] = screen.getAllByRole("tab");
    expect(t1).toHaveTextContent("main");
    expect(t1).toHaveTextContent("acme");
    expect(t1).toHaveAttribute("title", "/w/acme");
    expect(t1).toHaveAccessibleName("main, acme, main worktree at /w/acme");
    expect(t1!.querySelector(".gh-tab-bar__glyph svg")).toHaveAttribute("aria-hidden", "true");
    expect(t2).toHaveTextContent("feature/PROJ-1...debounce-v3");
    expect(t2).toHaveAttribute("title", "/w/acme.worktrees/f");
    expect(t2!.querySelector(".gh-tab-bar__suffix")).toHaveTextContent("acme");
    // A tab without a model keeps today's folder-name label, no glyph, no suffix.
    expect(t3).toHaveTextContent("other");
    expect(t3!.querySelector(".gh-tab-bar__glyph")).toBeNull();
    expect(t3!.querySelector(".gh-tab-bar__suffix")).toBeNull();
  });

  it("a worktree tab has no CSS width cap and no end ellipsis, so the JS middle cut is what is shown (two long branches differ)", async () => {
    const css = (await import("./TabBar.css?raw")).default as string;
    expect(css).toMatch(/\.gh-tab-bar__tab--worktree \{[^}]*max-width: none/s);
    expect(css).toMatch(/\.gh-tab-bar__tab--worktree \.gh-tab-bar__tab-button \{[^}]*text-overflow: clip/s);
    const { truncateMiddle } = await import("../../lib/worktrees");
    const a = truncateMiddle("feature/PROJ-1234567-fix-search-debounce-v2");
    const b = truncateMiddle("feature/PROJ-1234567-fix-search-debounce-v3");
    expect(a).not.toBe(b);
    expect(Array.from(a)).toHaveLength(24);
    render(
      <TabBar
        tabs={[tab("t2", "/w/acme.worktrees/f")]}
        activeTabId="t2"
        onActivate={() => {}}
        onClose={() => {}}
        onNewTab={() => {}}
        tabLabels={{ t2: { label: a, suffix: null, glyph: "linked", title: "/w/acme.worktrees/f", ariaLabel: "x" } }}
      />,
    );
    expect(screen.getByRole("tab").closest(".gh-tab-bar__tab")!.className).toContain("gh-tab-bar__tab--worktree");
  });

  it("the close control uses the branch label", () => {
    render(<TabBar tabs={[tab("t2", "/w/acme.worktrees/f")]} activeTabId="t2" onActivate={() => {}} onClose={() => {}} onNewTab={() => {}} tabLabels={labels} />);
    expect(screen.getByRole("button", { name: "Close feature/PROJ-1...debounce-v3 tab" })).toBeInTheDocument();
  });

  it("a conflict count still joins the accessible name of a worktree tab", () => {
    render(
      <TabBar tabs={[tab("t2", "/w/acme.worktrees/f")]} activeTabId="t2" onActivate={() => {}} onClose={() => {}} onNewTab={() => {}} tabLabels={labels} conflictCounts={{ t2: 2 }} />,
    );
    expect(screen.getByRole("tab")).toHaveAccessibleName(/worktree at \/w\/acme\.worktrees\/f, 2 conflicts to resolve/);
  });
});
