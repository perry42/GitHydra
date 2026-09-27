// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { KeyCap } from "./KeyCap";

function setPlatform(platform: string | undefined) {
  Object.defineProperty(window.navigator, "platform", { value: platform, configurable: true });
}

describe("KeyCap (specs/keyboard-shortcuts-visual-redesign.md)", () => {
  const originalPlatform = window.navigator.platform;
  afterEach(() => {
    setPlatform(originalPlatform);
  });

  it("FR-387: renders one chip per key, joined by '+' glyphs, never one chip containing the whole string", () => {
    setPlatform("Win32");
    render(<KeyCap combo={{ key: "k", mod: true }} />);
    const chips = screen.getAllByText(/^(Ctrl|K)$/);
    expect(chips).toHaveLength(2);
    expect(chips[0]).toHaveTextContent("Ctrl");
    expect(chips[1]).toHaveTextContent("K");
    // Never a single chip containing "Ctrl+K" as one string.
    expect(screen.queryByText("Ctrl+K")).not.toBeInTheDocument();
    // The '+' glyph is its own element, not baked into either chip's text.
    expect(screen.getByText("+")).toBeInTheDocument();
  });

  it("FR-387: a three-part combo (mod+shift+key) renders three chips and two '+' glyphs", () => {
    setPlatform("Win32");
    const { container } = render(<KeyCap combo={{ key: "f", mod: true, shift: true }} />);
    // eslint-disable-next-line testing-library/no-node-access
    const chips = container.querySelectorAll(".gh-keycap");
    expect(chips).toHaveLength(3);
    expect(chips[0]).toHaveTextContent("Ctrl");
    expect(chips[1]).toHaveTextContent("Shift");
    expect(chips[2]).toHaveTextContent("F");
    // eslint-disable-next-line testing-library/no-node-access
    expect(container.querySelectorAll(".gh-keycap__plus")).toHaveLength(2);
  });

  it("FR-388: each chip is flat (no shadow class), bordered, rounded, and carries the shared mono class", () => {
    const { container } = render(<KeyCap combo={{ key: "k", mod: true }} />);
    // eslint-disable-next-line testing-library/no-node-access
    const chips = container.querySelectorAll(".gh-keycap");
    chips.forEach((chip) => {
      expect(chip).toHaveClass("gh-keycap");
      expect(chip).toHaveClass("gh-mono");
    });
  });

  it("exposes a single flattened accessible name for assistive tech, hiding the per-chip DOM", () => {
    setPlatform("Win32");
    render(<KeyCap combo={{ key: "k", mod: true }} />);
    // eslint-disable-next-line testing-library/no-node-access
    const group = document.querySelector(".gh-keycap-group") as HTMLElement;
    expect(group).toHaveAttribute("aria-label", "Ctrl+K");
    // eslint-disable-next-line testing-library/no-node-access
    group.querySelectorAll("span").forEach((el) => {
      expect(el).toHaveAttribute("aria-hidden", "true");
    });
  });

  it("labels the mod key per platform, same as keyComboLabel", () => {
    setPlatform("MacIntel");
    render(<KeyCap combo={{ key: "k", mod: true }} />);
    expect(screen.getByText("Cmd")).toBeInTheDocument();
    expect(screen.queryByText("Ctrl")).not.toBeInTheDocument();
  });

  it("applies an extra className to the group wrapper without affecting chip content", () => {
    const { container } = render(<KeyCap combo={{ key: "Enter", mod: true }} className="gh-extra" />);
    // eslint-disable-next-line testing-library/no-node-access
    const group = container.querySelector(".gh-keycap-group");
    expect(group).toHaveClass("gh-extra");
  });

  describe("specs/keyboard-shortcut-rebinding.md FR-402: the 'listening' variant", () => {
    it('defaults to the plain group class with no "listening" variant', () => {
      const { container } = render(<KeyCap combo={{ key: "k", mod: true }} />);
      // eslint-disable-next-line testing-library/no-node-access
      const group = container.querySelector(".gh-keycap-group");
      expect(group).not.toHaveClass("gh-keycap-group--listening");
    });

    it('variant="listening" adds the listening modifier class without changing chip content', () => {
      const { container } = render(<KeyCap combo={{ key: "b", mod: true, shift: true }} variant="listening" />);
      // eslint-disable-next-line testing-library/no-node-access
      const group = container.querySelector(".gh-keycap-group");
      expect(group).toHaveClass("gh-keycap-group--listening");
      // eslint-disable-next-line testing-library/no-node-access
      const chips = Array.from(container.querySelectorAll(".gh-keycap")).map((c) => c.textContent);
      expect(chips).toEqual(["Ctrl", "Shift", "B"]);
    });

    it("combines the listening variant with an extra caller className", () => {
      const { container } = render(<KeyCap combo={{ key: "k", mod: true }} variant="listening" className="gh-extra" />);
      // eslint-disable-next-line testing-library/no-node-access
      const group = container.querySelector(".gh-keycap-group");
      expect(group).toHaveClass("gh-keycap-group--listening");
      expect(group).toHaveClass("gh-extra");
    });
  });
});
