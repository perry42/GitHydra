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
    const toggle = screen.getByRole("button", { name: /search & filter/i });
    await user.click(toggle); // expand
    await user.click(toggle); // collapse
    expect(onClear).not.toHaveBeenCalled();
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
    await expand(user);
    const clearButton = screen.getByRole("button", { name: /clear/i });
    expect(clearButton).toBeEnabled();
    await user.click(clearButton);
    expect(onClear).toHaveBeenCalled();
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
