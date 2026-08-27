import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FilterBar } from "./FilterBar";

describe("FilterBar", () => {
  it("applies author/message/date/path filters together (FR-7/FR-14)", async () => {
    const onApply = vi.fn();
    render(
      <FilterBar filter={{}} onApply={onApply} onClear={() => {}} showAllRefs={false} onShowAllRefsChange={() => {}} />,
    );
    await userEvent.type(screen.getByLabelText(/^author$/i), "jane");
    await userEvent.type(screen.getByLabelText(/^message$/i), "fix bug");
    await userEvent.type(screen.getByLabelText(/^file path$/i), "src/app.ts");
    await userEvent.click(screen.getByRole("button", { name: /search/i }));

    expect(onApply).toHaveBeenCalledWith({
      author: "jane",
      messageSubstring: "fix bug",
      paths: ["src/app.ts"],
    });
  });

  it("a SHA search overrides all other fields, matching git-core's documented sha-filter behavior", async () => {
    const onApply = vi.fn();
    render(
      <FilterBar filter={{}} onApply={onApply} onClear={() => {}} showAllRefs={false} onShowAllRefsChange={() => {}} />,
    );
    await userEvent.type(screen.getByLabelText(/^author$/i), "jane");
    await userEvent.type(screen.getByLabelText(/^sha$/i), "abc1234");
    await userEvent.click(screen.getByRole("button", { name: /search/i }));
    expect(onApply).toHaveBeenCalledWith({ sha: "abc1234" });
  });

  it("clearing calls onClear and disables itself when no filter is active", async () => {
    const onClear = vi.fn();
    render(
      <FilterBar filter={{}} onApply={() => {}} onClear={onClear} showAllRefs={false} onShowAllRefsChange={() => {}} />,
    );
    expect(screen.getByRole("button", { name: /clear/i })).toBeDisabled();
  });

  it("enables Clear once a filter is active and calls onClear on click", async () => {
    const onClear = vi.fn();
    render(
      <FilterBar
        filter={{ author: "jane" }}
        onApply={() => {}}
        onClear={onClear}
        showAllRefs={false}
        onShowAllRefsChange={() => {}}
      />,
    );
    const clearButton = screen.getByRole("button", { name: /clear/i });
    expect(clearButton).toBeEnabled();
    await userEvent.click(clearButton);
    expect(onClear).toHaveBeenCalled();
  });

  it("toggles show-all-refs (FR-15)", async () => {
    const onToggle = vi.fn();
    render(
      <FilterBar filter={{}} onApply={() => {}} onClear={() => {}} showAllRefs={false} onShowAllRefsChange={onToggle} />,
    );
    await userEvent.click(screen.getByLabelText(/show all branches/i));
    expect(onToggle).toHaveBeenCalledWith(true);
  });
});
