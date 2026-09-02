import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import {
  IconBranches,
  IconChanges,
  IconCheckout,
  IconDelete,
  IconMoon,
  IconNewBranch,
  IconOpenRepo,
  IconRefresh,
  IconStashes,
  IconSun,
} from "./Icon";

const ICONS = [
  ["IconBranches", IconBranches],
  ["IconChanges", IconChanges],
  ["IconStashes", IconStashes],
  ["IconOpenRepo", IconOpenRepo],
  ["IconRefresh", IconRefresh],
  ["IconSun", IconSun],
  ["IconMoon", IconMoon],
  ["IconNewBranch", IconNewBranch],
  ["IconCheckout", IconCheckout],
  ["IconDelete", IconDelete],
] as const;

describe("Icon vocabulary", () => {
  it.each(ICONS)("%s renders a decorative 18x18, 2px-stroke svg (never a unicode glyph)", (_name, Icon) => {
    const { container } = render(<Icon />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute("viewBox", "0 0 18 18");
    expect(svg).toHaveAttribute("width", "18");
    expect(svg).toHaveAttribute("height", "18");
    expect(svg).toHaveAttribute("stroke-width", "2");
    expect(svg).toHaveAttribute("stroke", "currentColor");
    // Decorative by default — every real caller supplies its own accessible name via a label or
    // aria-label on the containing control, matching this system's color/shape-is-never-the-only-
    // signal policy extended to icon-only buttons.
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("focusable", "false");
    // No text content at all — real authored paths/shapes only, never a Unicode glyph/emoji.
    expect(svg?.textContent).toBe("");
  });

  it("supports a custom size (still square)", () => {
    const { container } = render(<IconBranches size={24} />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("width", "24");
    expect(svg).toHaveAttribute("height", "24");
  });
});
