// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FindCommitsOverlay } from "./FindCommitsOverlay";

describe("FindCommitsOverlay (specs/find-commits-overlay.md)", () => {
  it("AC4: shows SHA/Author/Message/From/To/File path, Search, Clear, and Show all branches & tags — nothing else, no disclosure/toggle chrome — and the SHA field has focus immediately on open", () => {
    render(
      <FindCommitsOverlay
        filter={{}}
        onApply={() => {}}
        onClear={() => {}}
        showAllRefs={false}
        onShowAllRefsChange={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByLabelText(/^sha$/i)).toHaveFocus();
    expect(screen.getByLabelText(/^author$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^message$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^from$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^to$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^file path$/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /clear/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/show all branches/i)).toBeInTheDocument();
    // No leftover "More filters"/outer disclosure toggle from the superseded FilterBar shape.
    expect(screen.queryByRole("button", { name: /more filters/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /search & filter/i })).not.toBeInTheDocument();
    // No query-syntax hint text (Non-goals: no prefix-syntax query language).
    expect(screen.queryByText(/prefix|query language|syntax/i)).not.toBeInTheDocument();
  });

  it("AC5: opening for a tab with an already-applied filter shows those values pre-filled, not a blank form", () => {
    render(
      <FindCommitsOverlay
        filter={{ author: "jane", messageSubstring: "fix bug", paths: ["src/app.ts"] }}
        onApply={() => {}}
        onClear={() => {}}
        showAllRefs={false}
        onShowAllRefsChange={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByLabelText(/^author$/i)).toHaveValue("jane");
    expect(screen.getByLabelText(/^message$/i)).toHaveValue("fix bug");
    expect(screen.getByLabelText(/^file path$/i)).toHaveValue("src/app.ts");
  });

  it("AC6: submitting applies author/message/path filters together", async () => {
    const onApply = vi.fn();
    const user = userEvent.setup();
    render(
      <FindCommitsOverlay
        filter={{}}
        onApply={onApply}
        onClear={() => {}}
        showAllRefs={false}
        onShowAllRefsChange={() => {}}
        onClose={() => {}}
      />,
    );
    await user.type(screen.getByLabelText(/^author$/i), "jane");
    await user.type(screen.getByLabelText(/^message$/i), "fix bug");
    await user.type(screen.getByLabelText(/^file path$/i), "src/app.ts");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(onApply).toHaveBeenCalledWith({ author: "jane", messageSubstring: "fix bug", paths: ["src/app.ts"] });
  });

  it("AC6: a SHA search overrides all other fields, unchanged from today's git-core sha-wins-all behavior", async () => {
    const onApply = vi.fn();
    const user = userEvent.setup();
    render(
      <FindCommitsOverlay
        filter={{}}
        onApply={onApply}
        onClear={() => {}}
        showAllRefs={false}
        onShowAllRefsChange={() => {}}
        onClose={() => {}}
      />,
    );
    await user.type(screen.getByLabelText(/^author$/i), "jane");
    await user.type(screen.getByLabelText(/^sha$/i), "abc1234");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(onApply).toHaveBeenCalledWith({ sha: "abc1234" });
  });

  it("Clear calls onClear and disables itself when no filter is active — Clear alone never closes the overlay", async () => {
    const onClear = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <FindCommitsOverlay
        filter={{}}
        onApply={() => {}}
        onClear={onClear}
        showAllRefs={false}
        onShowAllRefsChange={() => {}}
        onClose={onClose}
      />,
    );
    expect(screen.getByRole("button", { name: /clear/i })).toBeDisabled();

    rerender(
      <FindCommitsOverlay
        filter={{ author: "jane" }}
        onApply={() => {}}
        onClear={onClear}
        showAllRefs={false}
        onShowAllRefsChange={() => {}}
        onClose={onClose}
      />,
    );
    const clearButton = screen.getByRole("button", { name: /clear/i });
    expect(clearButton).toBeEnabled();
    await user.click(clearButton);
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("toggles show-all-refs", async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(
      <FindCommitsOverlay
        filter={{}}
        onApply={() => {}}
        onClear={() => {}}
        showAllRefs={false}
        onShowAllRefsChange={onToggle}
        onClose={() => {}}
      />,
    );
    await user.click(screen.getByLabelText(/show all branches/i));
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it("FR-264: shows the honest 'loaded' commit-count readout only when provided, matching the retired FilterBar's wording", () => {
    const { rerender } = render(
      <FindCommitsOverlay
        filter={{}}
        onApply={() => {}}
        onClear={() => {}}
        showAllRefs={false}
        onShowAllRefsChange={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByText(/commits loaded/i)).not.toBeInTheDocument();

    rerender(
      <FindCommitsOverlay
        filter={{}}
        onApply={() => {}}
        onClear={() => {}}
        showAllRefs={false}
        onShowAllRefsChange={() => {}}
        onClose={() => {}}
        loadedCommitCount={1532}
        hasMoreCommits
      />,
    );
    expect(screen.getByText("1,532+ commits loaded")).toBeInTheDocument();
  });

  describe("FR-263/AC7: closing (Esc / click-outside / re-trigger) hides AND clears", () => {
    it("Escape calls onClose", async () => {
      const onClose = vi.fn();
      const user = userEvent.setup();
      render(
        <FindCommitsOverlay
          filter={{}}
          onApply={() => {}}
          onClear={() => {}}
          showAllRefs={false}
          onShowAllRefsChange={() => {}}
          onClose={onClose}
        />,
      );
      await user.keyboard("{Escape}");
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("clicking anywhere outside the panel calls onClose WITHOUT consuming the click — the other control's own onClick still fires too, unlike CommandPalette's full-screen modal scrim (required for AC9's 'switch tabs via a normal click while the overlay is open' flow)", async () => {
      const onClose = vi.fn();
      const onOtherClick = vi.fn();
      const user = userEvent.setup();
      render(
        <div>
          <button type="button" onClick={onOtherClick}>
            Some other app control (e.g. a TabBar tab)
          </button>
          <FindCommitsOverlay
            filter={{}}
            onApply={() => {}}
            onClear={() => {}}
            showAllRefs={false}
            onShowAllRefsChange={() => {}}
            onClose={onClose}
          />
        </div>,
      );
      await user.click(screen.getByRole("button", { name: /some other app control/i }));
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onOtherClick).toHaveBeenCalledTimes(1);
    });

    it("clicking inside the panel itself does not close it", async () => {
      const onClose = vi.fn();
      const user = userEvent.setup();
      render(
        <FindCommitsOverlay
          filter={{}}
          onApply={() => {}}
          onClear={() => {}}
          showAllRefs={false}
          onShowAllRefsChange={() => {}}
          onClose={onClose}
        />,
      );
      await user.click(screen.getByLabelText(/^author$/i));
      expect(onClose).not.toHaveBeenCalled();
    });

    it("re-firing the same open shortcut (Ctrl/Cmd+Shift+F) while already open calls onClose, even though the global keybinding layer is suspended while this is mounted", async () => {
      const onClose = vi.fn();
      const user = userEvent.setup();
      render(
        <FindCommitsOverlay
          filter={{}}
          onApply={() => {}}
          onClear={() => {}}
          showAllRefs={false}
          onShowAllRefsChange={() => {}}
          onClose={onClose}
        />,
      );
      await user.keyboard("{Control>}{Shift>}f{/Shift}{/Control}");
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("AC8: typing values without pressing Search, then closing, never calls onApply — the draft is simply discarded (this component unmounts on close; App re-seeds from the unchanged tab filter next open)", async () => {
      const onApply = vi.fn();
      const onClose = vi.fn();
      const user = userEvent.setup();
      render(
        <FindCommitsOverlay
          filter={{}}
          onApply={onApply}
          onClear={() => {}}
          showAllRefs={false}
          onShowAllRefsChange={() => {}}
          onClose={onClose}
        />,
      );
      await user.type(screen.getByLabelText(/^author$/i), "never submitted");
      await user.keyboard("{Escape}");
      expect(onApply).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe("FR-265/AC9: force-closes when openSequence changes while mounted", () => {
    it("calls onClose when openSequence changes, but not on the initial mount render nor on an unrelated re-render with the same openSequence", () => {
      const onClose = vi.fn();
      const { rerender } = render(
        <FindCommitsOverlay
          filter={{}}
          onApply={() => {}}
          onClear={() => {}}
          showAllRefs={false}
          onShowAllRefsChange={() => {}}
          onClose={onClose}
          openSequence={1}
        />,
      );
      expect(onClose).not.toHaveBeenCalled();

      // Same openSequence, some other prop changes (e.g. filter prop churn) — must not force-close.
      rerender(
        <FindCommitsOverlay
          filter={{ author: "jane" }}
          onApply={() => {}}
          onClear={() => {}}
          showAllRefs={false}
          onShowAllRefsChange={() => {}}
          onClose={onClose}
          openSequence={1}
        />,
      );
      expect(onClose).not.toHaveBeenCalled();

      // A real openSequence bump (tab switch/close) — force-close.
      rerender(
        <FindCommitsOverlay
          filter={{}}
          onApply={() => {}}
          onClear={() => {}}
          showAllRefs={false}
          onShowAllRefsChange={() => {}}
          onClose={onClose}
          openSequence={2}
        />,
      );
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
