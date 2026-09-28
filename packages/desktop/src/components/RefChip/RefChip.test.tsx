// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { RefChip, refChipAccessibleLabel } from "./RefChip";

describe("RefChip", () => {
  it("labels a local branch chip accessibly and shows it unfilled by default", () => {
    render(<RefChip decoration={{ name: "main", fullName: "refs/heads/main", type: "local-branch" }} />);
    const chip = screen.getByRole("img", { name: /local branch: main/i });
    expect(chip).toBeInTheDocument();
    expect(chip.className).not.toContain("gh-refchip--filled");
  });

  it("marks the current checked-out ref via the --filled class (bold ink, not a colored fill — DESIGN.md gutter revision)", () => {
    render(<RefChip decoration={{ name: "main", fullName: "refs/heads/main", type: "local-branch" }} filled />);
    expect(screen.getByRole("img", { name: /local branch: main/i }).className).toContain(
      "gh-refchip--filled",
    );
  });

  it("visually and accessibly distinguishes a detached HEAD from a branch tip (AC4)", () => {
    render(<RefChip decoration={{ name: "HEAD", fullName: null, type: "head" }} detached />);
    const chip = screen.getByRole("img", { name: /HEAD \(detached\)/i });
    expect(chip.className).toContain("gh-refchip--detached");
  });

  it("gives remote-tracking branches a distinct label from local branches", () => {
    render(
      <RefChip decoration={{ name: "origin/main", fullName: "refs/remotes/origin/main", type: "remote-branch" }} />,
    );
    expect(screen.getByRole("img", { name: /remote branch: origin\/main/i })).toBeInTheDocument();
  });

  it("never carries an inline color style — the label is plain ink, color stays on the graph's lanes only (DESIGN.md gutter revision)", () => {
    render(<RefChip decoration={{ name: "main", fullName: "refs/heads/main", type: "local-branch" }} filled />);
    const chip = screen.getByRole("img", { name: /local branch: main/i });
    expect(chip.getAttribute("style")).toBeNull();
  });

  // specs/ref-chip-gutter-legibility.md FR-411: the "+N" collapse popover (CommitGraph.tsx) reuses
  // this exact function to build its informational rows — this pins down that it produces the
  // identical string a hover `title`/`aria-label` on the chip itself would show, for every
  // decoration type and the diverged suffix, so the two never drift apart.
  describe("refChipAccessibleLabel (reused verbatim by CommitGraph.tsx's +N popover, FR-411)", () => {
    it("matches the rendered chip's own aria-label/title for a plain local branch", () => {
      const decoration = { name: "main", fullName: "refs/heads/main", type: "local-branch" as const };
      render(<RefChip decoration={decoration} />);
      const chip = screen.getByRole("img");
      expect(refChipAccessibleLabel(decoration, false, false)).toBe(chip.getAttribute("aria-label"));
    });

    it("matches the rendered chip's own aria-label/title for a diverged local branch", () => {
      const decoration = { name: "main", fullName: "refs/heads/main", type: "local-branch" as const };
      render(<RefChip decoration={decoration} diverged />);
      const chip = screen.getByRole("img");
      expect(refChipAccessibleLabel(decoration, false, true)).toBe(chip.getAttribute("aria-label"));
      expect(refChipAccessibleLabel(decoration, false, true)).toMatch(/\(diverged from its upstream\)$/);
    });

    it("matches the rendered chip's own aria-label/title for a detached HEAD", () => {
      const decoration = { name: "HEAD", fullName: null, type: "head" as const };
      render(<RefChip decoration={decoration} detached />);
      const chip = screen.getByRole("img");
      expect(refChipAccessibleLabel(decoration, true, false)).toBe(chip.getAttribute("aria-label"));
    });
  });
});
