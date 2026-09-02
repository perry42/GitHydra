import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FilterBar } from "./FilterBar";

/** Helper matching specs/layout-and-view-polish.md Must-have A: the form is collapsed by
 * default, so every existing behavioral test needs to expand it first. */
async function expand(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /search & filter/i }));
}

describe("FilterBar", () => {
  it("renders collapsed by default — only the toggle control, no field yet (AC1)", () => {
    render(
      <FilterBar filter={{}} onApply={() => {}} onClear={() => {}} showAllRefs={false} onShowAllRefsChange={() => {}} />,
    );
    expect(screen.getByRole("button", { name: /search & filter/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/^author$/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("search")).not.toBeInTheDocument();
  });

  it("expands the form on activation and collapses again on a second activation (AC2)", async () => {
    const user = userEvent.setup();
    render(
      <FilterBar filter={{}} onApply={() => {}} onClear={() => {}} showAllRefs={false} onShowAllRefsChange={() => {}} />,
    );
    const toggle = screen.getByRole("button", { name: /search & filter/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText(/^author$/i)).toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText(/^author$/i)).not.toBeInTheDocument();
  });

  it("is keyboard-operable via Enter/Space (AC2)", async () => {
    const user = userEvent.setup();
    render(
      <FilterBar filter={{}} onApply={() => {}} onClear={() => {}} showAllRefs={false} onShowAllRefsChange={() => {}} />,
    );
    await user.tab();
    expect(screen.getByRole("button", { name: /search & filter/i })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByLabelText(/^author$/i)).toBeInTheDocument();
  });

  it("shows an indicator on the collapsed control when a filter is active, and not otherwise (AC4)", () => {
    const { rerender } = render(
      <FilterBar filter={{}} onApply={() => {}} onClear={() => {}} showAllRefs={false} onShowAllRefsChange={() => {}} />,
    );
    expect(screen.queryByText(/filter is currently applied/i)).not.toBeInTheDocument();

    rerender(
      <FilterBar
        filter={{ author: "jane" }}
        onApply={() => {}}
        onClear={() => {}}
        showAllRefs={false}
        onShowAllRefsChange={() => {}}
      />,
    );
    expect(screen.getByText(/filter is currently applied/i)).toBeInTheDocument();
  });

  it("collapsing never clears the applied filter — no onClear call (AC3)", async () => {
    const onClear = vi.fn();
    const user = userEvent.setup();
    render(
      <FilterBar
        filter={{ author: "jane" }}
        onApply={() => {}}
        onClear={onClear}
        showAllRefs={false}
        onShowAllRefsChange={() => {}}
      />,
    );
    // Mounting with an already-active filter starts expanded (see the "starts expanded..." test
    // below), so toggling twice here exercises collapse-then-expand rather than the reverse —
    // either order must never call onClear.
    const toggle = screen.getByRole("button", { name: /search & filter/i });
    await user.click(toggle); // collapse
    await user.click(toggle); // expand
    expect(onClear).not.toHaveBeenCalled();
  });

  it("starts already expanded when mounted with an already-active filter, so the values aren't hidden behind an extra click (specs/multi-repo-tabs.md AC4 fix)", () => {
    render(
      <FilterBar
        filter={{ author: "jane" }}
        onApply={() => {}}
        onClear={() => {}}
        showAllRefs={false}
        onShowAllRefsChange={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /search & filter/i })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText(/^author$/i)).toHaveValue("jane");
  });

  it("resets the disclosure to match the incoming filter only when openSequence changes (a repo/tab boundary), never on an ordinary same-tab filter change", () => {
    const { rerender } = render(
      <FilterBar
        filter={{}}
        onApply={() => {}}
        onClear={() => {}}
        showAllRefs={false}
        onShowAllRefsChange={() => {}}
        openSequence={1}
      />,
    );
    const toggle = screen.getByRole("button", { name: /search & filter/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    // Same tab (openSequence unchanged): applying a filter through some other means (e.g. the
    // graph's own filter state updating) must not force the disclosure open behind the user's
    // back — only their own click does that.
    rerender(
      <FilterBar
        filter={{ author: "jane" }}
        onApply={() => {}}
        onClear={() => {}}
        showAllRefs={false}
        onShowAllRefsChange={() => {}}
        openSequence={1}
      />,
    );
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    // A new openSequence (switching to/reactivating a different tab) with a non-empty incoming
    // filter resets the disclosure to reflect it, matching AC4.
    rerender(
      <FilterBar
        filter={{ author: "jane" }}
        onApply={() => {}}
        onClear={() => {}}
        showAllRefs={false}
        onShowAllRefsChange={() => {}}
        openSequence={2}
      />,
    );
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    // ...and back to a fresh/empty-filter tab collapses it again (AC5, still preserved).
    rerender(
      <FilterBar
        filter={{}}
        onApply={() => {}}
        onClear={() => {}}
        showAllRefs={false}
        onShowAllRefsChange={() => {}}
        openSequence={3}
      />,
    );
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("applies author/message/date/path filters together (FR-7/FR-14)", async () => {
    const onApply = vi.fn();
    const user = userEvent.setup();
    render(
      <FilterBar filter={{}} onApply={onApply} onClear={() => {}} showAllRefs={false} onShowAllRefsChange={() => {}} />,
    );
    await expand(user);
    await user.type(screen.getByLabelText(/^author$/i), "jane");
    await user.type(screen.getByLabelText(/^message$/i), "fix bug");
    await user.type(screen.getByLabelText(/^file path$/i), "src/app.ts");
    await user.click(screen.getByRole("button", { name: "Search" }));

    expect(onApply).toHaveBeenCalledWith({
      author: "jane",
      messageSubstring: "fix bug",
      paths: ["src/app.ts"],
    });
  });

  it("a SHA search overrides all other fields, matching git-core's documented sha-filter behavior", async () => {
    const onApply = vi.fn();
    const user = userEvent.setup();
    render(
      <FilterBar filter={{}} onApply={onApply} onClear={() => {}} showAllRefs={false} onShowAllRefsChange={() => {}} />,
    );
    await expand(user);
    await user.type(screen.getByLabelText(/^author$/i), "jane");
    await user.type(screen.getByLabelText(/^sha$/i), "abc1234");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(onApply).toHaveBeenCalledWith({ sha: "abc1234" });
  });

  it("clearing calls onClear and disables itself when no filter is active", async () => {
    const onClear = vi.fn();
    const user = userEvent.setup();
    render(
      <FilterBar filter={{}} onApply={() => {}} onClear={onClear} showAllRefs={false} onShowAllRefsChange={() => {}} />,
    );
    await expand(user);
    expect(screen.getByRole("button", { name: /clear/i })).toBeDisabled();
  });

  it("enables Clear once a filter is active and calls onClear on click", async () => {
    const onClear = vi.fn();
    const user = userEvent.setup();
    render(
      <FilterBar
        filter={{ author: "jane" }}
        onApply={() => {}}
        onClear={onClear}
        showAllRefs={false}
        onShowAllRefsChange={() => {}}
      />,
    );
    // Already expanded on mount, since the incoming filter is already active — see the
    // "starts already expanded..." test above. No need to click the disclosure open.
    const clearButton = screen.getByRole("button", { name: /clear/i });
    expect(clearButton).toBeEnabled();
    await user.click(clearButton);
    expect(onClear).toHaveBeenCalled();
  });

  it("design-pass fix #5: shows an honest 'loaded' commit-count readout in the collapsed row's trailing space when provided", () => {
    const { rerender } = render(
      <FilterBar filter={{}} onApply={() => {}} onClear={() => {}} showAllRefs={false} onShowAllRefsChange={() => {}} />,
    );
    expect(screen.queryByText(/commits loaded/i)).not.toBeInTheDocument();

    rerender(
      <FilterBar
        filter={{}}
        onApply={() => {}}
        onClear={() => {}}
        showAllRefs={false}
        onShowAllRefsChange={() => {}}
        loadedCommitCount={1532}
      />,
    );
    expect(screen.getByText("1,532 commits loaded")).toBeInTheDocument();

    rerender(
      <FilterBar
        filter={{}}
        onApply={() => {}}
        onClear={() => {}}
        showAllRefs={false}
        onShowAllRefsChange={() => {}}
        loadedCommitCount={1532}
        hasMoreCommits
      />,
    );
    // The "+" signals more history exists beyond what's loaded — never implies this is the whole
    // repo's history when it isn't (matches BranchesPanel's ahead/behind "last-known" honesty).
    expect(screen.getByText("1,532+ commits loaded")).toBeInTheDocument();
  });

  it("toggles show-all-refs (FR-15)", async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(
      <FilterBar filter={{}} onApply={() => {}} onClear={() => {}} showAllRefs={false} onShowAllRefsChange={onToggle} />,
    );
    await expand(user);
    await user.click(screen.getByLabelText(/show all branches/i));
    expect(onToggle).toHaveBeenCalledWith(true);
  });
});
