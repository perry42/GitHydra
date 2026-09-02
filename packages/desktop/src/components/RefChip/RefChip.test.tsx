import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { RefChip } from "./RefChip";

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
});
