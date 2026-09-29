// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import {
  IconBranches,
  IconChanges,
  IconCheckout,
  IconClone,
  IconDelete,
  IconMoon,
  IconNewBranch,
  IconOpenRepo,
  IconPush,
  IconRefresh,
  IconRefPin,
  IconRefRemote,
  IconRefTag,
  IconStashes,
  IconSun,
} from "./Icon";

const ICONS = [
  ["IconBranches", IconBranches],
  ["IconChanges", IconChanges],
  ["IconStashes", IconStashes],
  ["IconOpenRepo", IconOpenRepo],
  ["IconClone", IconClone],
  ["IconRefresh", IconRefresh],
  ["IconSun", IconSun],
  ["IconMoon", IconMoon],
  ["IconNewBranch", IconNewBranch],
  ["IconCheckout", IconCheckout],
  ["IconDelete", IconDelete],
  ["IconPush", IconPush],
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

// specs/ref-chip-gutter-redesign.md FR-416: the three new ref-chip type glyphs default to 14px
// (matching `IconWarning`'s own already-shipped small-icon-in-a-chip precedent), so they're
// deliberately excluded from the `ICONS` 18x18-default table above (`IconWarning` itself is
// excluded from that table for the same reason) — covered here instead, against their own real
// default rather than an 18px assumption that would fail.
const CHIP_ICONS = [
  ["IconRefTag", IconRefTag],
  ["IconRefRemote", IconRefRemote],
  ["IconRefPin", IconRefPin],
] as const;

describe("Icon vocabulary — ref-chip type glyphs (FR-416, 14px default)", () => {
  it.each(CHIP_ICONS)(
    "%s renders a decorative, 14px-default, 2px-stroke svg sharing the same 18x18 viewBox grid",
    (_name, Icon) => {
      const { container } = render(<Icon />);
      const svg = container.querySelector("svg");
      expect(svg).not.toBeNull();
      expect(svg).toHaveAttribute("viewBox", "0 0 18 18");
      expect(svg).toHaveAttribute("width", "14");
      expect(svg).toHaveAttribute("height", "14");
      expect(svg).toHaveAttribute("stroke-width", "2");
      expect(svg).toHaveAttribute("stroke", "currentColor");
      expect(svg).toHaveAttribute("aria-hidden", "true");
      expect(svg).toHaveAttribute("focusable", "false");
      expect(svg?.textContent).toBe("");
    },
  );

  it("still supports a custom size override (14px is only the default)", () => {
    const { container } = render(<IconRefTag size={18} />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("width", "18");
    expect(svg).toHaveAttribute("height", "18");
  });

  it("each of the three new glyphs draws a distinct path (no accidental shared/duplicate shape)", () => {
    const paths = CHIP_ICONS.map(([, Icon]) => {
      const { container } = render(<Icon />);
      return container.querySelector("svg")!.innerHTML;
    });
    expect(new Set(paths).size).toBe(paths.length);
  });
});
