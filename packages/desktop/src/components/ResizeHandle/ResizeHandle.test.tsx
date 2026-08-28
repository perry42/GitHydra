import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ResizeHandle } from "./ResizeHandle";

/**
 * specs/layout-and-view-polish.md Must-have C15/AC9: role="separator", aria-orientation
 * "vertical", and live aria-value* — this is the accessibility contract every one of the five
 * resize handles must satisfy; `useResizableWidth`'s own tests cover the drag/keyboard math, so
 * this component test just confirms the presentational/ARIA wiring is exactly right.
 */
describe("ResizeHandle", () => {
  it("exposes the separator role, vertical orientation, and current aria-value* (AC9)", () => {
    render(
      <ResizeHandle
        label="Resize Changes panel"
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={680}
        aria-valuemin={420}
        aria-valuemax={1200}
        tabIndex={0}
        onPointerDown={() => {}}
        onKeyDown={() => {}}
      />,
    );
    const handle = screen.getByRole("separator", { name: "Resize Changes panel" });
    expect(handle).toHaveAttribute("aria-orientation", "vertical");
    expect(handle).toHaveAttribute("aria-valuenow", "680");
    expect(handle).toHaveAttribute("aria-valuemin", "420");
    expect(handle).toHaveAttribute("aria-valuemax", "1200");
    expect(handle).toHaveAttribute("tabindex", "0");
  });

  it("is keyboard-focusable and forwards key events to onKeyDown (Must-have C15)", async () => {
    const onKeyDown = vi.fn();
    const user = userEvent.setup();
    render(
      <ResizeHandle
        label="Resize Changes panel"
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={680}
        aria-valuemin={420}
        aria-valuemax={1200}
        tabIndex={0}
        onPointerDown={() => {}}
        onKeyDown={onKeyDown}
      />,
    );
    await user.tab();
    expect(screen.getByRole("separator")).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(onKeyDown).toHaveBeenCalled();
  });
});
