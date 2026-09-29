// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { REF_CHIP_LANE_TINT_PERCENT, RefChip, refChipAccessibleLabel } from "./RefChip";

const dirname = path.dirname(fileURLToPath(import.meta.url));

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

  // specs/ref-chip-gutter-redesign.md Addendum (FR-417): without a `laneColorSlot` (DetailPanel's
  // caller, which has no lane-assignment context for its commit), the chip carries no inline style
  // at all — the FR-415 neutral border fallback below is pure CSS, no per-instance computed color.
  it("carries no inline style when laneColorSlot is omitted (DetailPanel's no-lane-context fallback)", () => {
    render(<RefChip decoration={{ name: "main", fullName: "refs/heads/main", type: "local-branch" }} filled />);
    const chip = screen.getByRole("img", { name: /local branch: main/i });
    expect(chip.getAttribute("style")).toBeNull();
    expect(chip.className).toContain("gh-refchip--neutral");
  });

  // Follow-up to specs/ref-chip-gutter-legibility.md: `iconOnly` drops the visible label span
  // (fixing the crowded checked-out-row squeeze, see CommitRow.tsx) while keeping the full
  // accessible name/tooltip — a sighted user still sees only the glyph, but the name isn't lost.
  it("iconOnly renders the glyph with no visible label text, keeping the full accessible name/title", () => {
    const decoration = { name: "HEAD", fullName: null, type: "head" as const };
    render(<RefChip decoration={decoration} filled iconOnly />);
    const chip = screen.getByRole("img", { name: /^HEAD: HEAD$/i });
    expect(chip.className).toContain("gh-refchip--icon-only");
    expect(chip.getAttribute("title")).toBe("HEAD: HEAD");
    expect(chip.querySelector(".gh-refchip__label")).not.toBeInTheDocument();
  });

  // specs/ref-chip-gutter-redesign.md FR-416: `iconOnly` must still render the literal type icon —
  // it only ever hides the visible text label, never the glyph (the chip would otherwise render as
  // a fully empty box with only a border, which the spec's "still no visible label, but the new
  // literal icon should still render" composition explicitly requires).
  it("iconOnly still renders the literal type icon even with no visible label", () => {
    const decoration = { name: "HEAD", fullName: null, type: "head" as const };
    render(<RefChip decoration={decoration} filled iconOnly />);
    const chip = screen.getByRole("img", { name: /^HEAD: HEAD$/i });
    const icon = chip.querySelector("svg[data-ref-icon='head']");
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute("aria-hidden", "true");
  });

  // specs/ref-chip-gutter-redesign.md FR-416: one literal, recognizable icon per ref-decoration
  // type — no dot/ring/diamond/square abstract shapes remain.
  describe("literal type icons (FR-416)", () => {
    it.each([
      ["local-branch" as const, "local branch: main", "main"],
      ["remote-branch" as const, "remote branch: origin/main", "origin/main"],
      ["tag" as const, "tag: v1.0", "v1.0"],
    ])("renders a distinct, aria-hidden literal icon for a %s chip", (type, _accessibleName, name) => {
      const decoration = { name, fullName: `refs/x/${name}`, type };
      render(<RefChip decoration={decoration} />);
      const chip = screen.getByRole("img");
      const icon = chip.querySelector(`svg[data-ref-icon='${type}']`);
      expect(icon).not.toBeNull();
      expect(icon).toHaveAttribute("aria-hidden", "true");
      expect(icon).toHaveAttribute("focusable", "false");
    });

    it("renders the pin icon (not a checkmark) for a detached-HEAD chip", () => {
      const decoration = { name: "HEAD", fullName: null, type: "head" as const };
      render(<RefChip decoration={decoration} detached />);
      const chip = screen.getByRole("img");
      expect(chip.querySelector("svg[data-ref-icon='head']")).not.toBeNull();
    });

    it("no longer renders any of the old abstract dot/ring/diamond/square glyph classes", () => {
      const decoration = { name: "main", fullName: "refs/heads/main", type: "local-branch" as const };
      const { container } = render(<RefChip decoration={decoration} />);
      for (const stale of [
        "gh-refchip__icon--branch",
        "gh-refchip__icon--remote",
        "gh-refchip__icon--tag",
        "gh-refchip__icon--head",
      ]) {
        expect(container.querySelector(`.${stale}`)).toBeNull();
      }
    });
  });

  // specs/ref-chip-gutter-legibility.md's original FR-415: a visible, neutral-ink border, identical
  // across every chip state (filled/detached/plain/diverged) — never a second state signal, never
  // a lane hue. specs/ref-chip-gutter-redesign.md's Addendum (FR-417) narrowed this to the ONE
  // fallback case where `laneColorSlot` is omitted (`.gh-refchip--neutral`) — every other chip now
  // gets a lane-color tint instead (`.gh-refchip--tinted`, no border), covered in its own describe
  // block below. jsdom's `getComputedStyle` doesn't resolve `var()` inside shorthand properties at
  // all (verified directly — a `border: 1px solid var(--x)` rule computes to `border-style: none`
  // in jsdom regardless of whether `--x` is defined, while the exact same rule with a literal color
  // computes correctly), so a DOM-measurement assertion here would either be meaningless or fail
  // for the wrong reason. Instead, this reads `RefChip.css`'s actual source — the same "can't
  // verify real CSS via jsdom" fallback `layoutBudget.test.ts`'s own container-query describe block
  // already establishes for this reason. Real Electron screenshots (AC5/AC6,
  // `refChipGutterVisualCheck.spec.ts`) are the actual rendered-pixel verification.
  describe("visible neutral border — the no-laneColorSlot fallback only (FR-415, narrowed by FR-417)", () => {
    const css = fs.readFileSync(path.join(dirname, "RefChip.css"), "utf8");

    it("applies a 1px solid neutral-ink border on .gh-refchip--neutral (not the shared base .gh-refchip rule, not a filled/detached state modifier)", () => {
      const neutralRuleMatch = css.match(/\.gh-refchip--neutral\s*\{([^}]*)\}/);
      expect(neutralRuleMatch).not.toBeNull();
      const neutralRule = neutralRuleMatch![1];
      expect(neutralRule).toMatch(/border:\s*1px solid var\(--gh-border\)/);

      const baseRuleMatch = css.match(/\.gh-refchip\s*\{([^}]*)\}/);
      expect(baseRuleMatch).not.toBeNull();
      expect(baseRuleMatch![1]).toMatch(/border-radius:\s*3px/);
      expect(baseRuleMatch![1]).toMatch(/box-sizing:\s*border-box/);
      expect(baseRuleMatch![1]).not.toMatch(/^\s*border:/m);
    });

    it("never sources the actual border declaration from --gh-border-subtle (too faint at this text scale) or a lane-hue token", () => {
      // The doc comment above the rule mentions `--gh-border-subtle` by name to explain why it was
      // rejected — this checks the real declaration line, not the file's prose, so that mention
      // doesn't make this assertion vacuous.
      const borderDeclarationMatch = css.match(/^\s*border:\s*1px solid.+;$/m);
      expect(borderDeclarationMatch).not.toBeNull();
      const borderDeclaration = borderDeclarationMatch![0];
      expect(borderDeclaration).toContain("var(--gh-border)");
      expect(borderDeclaration).not.toMatch(/--gh-border-subtle|--gh-lane/);
    });

    it("the filled/detached state rules don't redeclare border — the border stays a constant object-boundary, never a second state signal", () => {
      const filledRuleMatch = css.match(/\.gh-refchip--filled\s*\{([^}]*)\}/);
      const detachedRuleMatch = css.match(/\.gh-refchip--detached\s*\{([^}]*)\}/);
      expect(filledRuleMatch).not.toBeNull();
      expect(detachedRuleMatch).not.toBeNull();
      expect(filledRuleMatch![1]).not.toMatch(/border/);
      expect(detachedRuleMatch![1]).not.toMatch(/border-color|border-width|border-style|^border:/);
    });

    it("renders --neutral (not --tinted) in every state when laneColorSlot is omitted", () => {
      const decoration = { name: "main", fullName: "refs/heads/main", type: "local-branch" as const };
      const { unmount } = render(<RefChip decoration={decoration} filled detached diverged />);
      const classes = screen.getByRole("img").className.split(" ");
      expect(classes).toContain("gh-refchip");
      expect(classes).toContain("gh-refchip--neutral");
      expect(classes).not.toContain("gh-refchip--tinted");
      unmount();
    });
  });

  // specs/ref-chip-gutter-redesign.md Addendum (FR-417): every chip with a real `laneColorSlot`
  // gets a background tinted with that commit's own graph lane color instead of the neutral border.
  describe("lane-color tint background (FR-417)", () => {
    const css = fs.readFileSync(path.join(dirname, "RefChip.css"), "utf8");

    it("adds .gh-refchip--tinted (not --neutral) and an inline background style referencing the matching --gh-lane-N token, when laneColorSlot is provided", () => {
      const decoration = { name: "main", fullName: "refs/heads/main", type: "local-branch" as const };
      render(<RefChip decoration={decoration} laneColorSlot={2} />);
      const chip = screen.getByRole("img", { name: /local branch: main/i });
      const classes = chip.className.split(" ");
      expect(classes).toContain("gh-refchip--tinted");
      expect(classes).not.toContain("gh-refchip--neutral");
      const style = chip.getAttribute("style") ?? "";
      expect(style).toContain("color-mix(in srgb");
      // colorSlot 2 -> the third lane token (0-indexed slot -> 1-indexed --gh-lane-N, same mapping
      // laneColorVar()/laneColorHex() already use everywhere else in this codebase).
      expect(style).toContain("--gh-lane-3");
      expect(style).toContain(`${REF_CHIP_LANE_TINT_PERCENT}%`);
      expect(style).toContain("var(--gh-surface)");
    });

    it("never sets an inline text/icon color — only the background is per-instance-dynamic, ink stays token/class-driven", () => {
      const decoration = { name: "main", fullName: "refs/heads/main", type: "local-branch" as const };
      render(<RefChip decoration={decoration} laneColorSlot={0} filled />);
      const style = screen.getByRole("img").getAttribute("style") ?? "";
      expect(style).not.toMatch(/(?<!background-)color:/);
    });

    it("maps different colorSlot values to their own distinct --gh-lane-N token (colorSlot 0 -> lane 1, colorSlot 7 -> lane 8, wraps mod 8)", () => {
      const decoration = { name: "main", fullName: "refs/heads/main", type: "local-branch" as const };
      const slot0 = render(<RefChip decoration={decoration} laneColorSlot={0} />);
      expect(screen.getByRole("img").getAttribute("style")).toContain("--gh-lane-1");
      slot0.unmount();

      const slot7 = render(<RefChip decoration={decoration} laneColorSlot={7} />);
      expect(screen.getByRole("img").getAttribute("style")).toContain("--gh-lane-8");
      slot7.unmount();

      const slot8 = render(<RefChip decoration={decoration} laneColorSlot={8} />);
      expect(screen.getByRole("img").getAttribute("style")).toContain("--gh-lane-1");
      slot8.unmount();
    });

    it("applies the tint in every state (filled/detached/diverged), not just the plain default", () => {
      const decoration = { name: "main", fullName: "refs/heads/main", type: "local-branch" as const };
      const { unmount } = render(<RefChip decoration={decoration} laneColorSlot={4} filled detached diverged />);
      const chip = screen.getByRole("img");
      expect(chip.className).toContain("gh-refchip--tinted");
      expect(chip.getAttribute("style")).toContain("--gh-lane-5");
      unmount();
    });

    it(".gh-refchip--tinted has no border in RefChip.css — the filled surface itself is the chip's visible boundary", () => {
      const tintedRuleMatch = css.match(/\.gh-refchip--tinted\s*\{([^}]*)\}/);
      expect(tintedRuleMatch).not.toBeNull();
      expect(tintedRuleMatch![1]).toMatch(/border:\s*none/);
    });
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

    it("appends the synced-upstream suffix when a syncedRemoteName is supplied", () => {
      const decoration = { name: "main", fullName: "refs/heads/main", type: "local-branch" as const };
      expect(refChipAccessibleLabel(decoration, false, false, "origin/main")).toBe(
        "local branch: main (synced with origin/main)",
      );
    });

    it("prefers the diverged suffix over the synced-upstream suffix if both were somehow supplied", () => {
      const decoration = { name: "main", fullName: "refs/heads/main", type: "local-branch" as const };
      expect(refChipAccessibleLabel(decoration, false, true, "origin/main")).toBe(
        "local branch: main (diverged from its upstream)",
      );
    });
  });

  // specs/ref-chip-synced-upstream-merge.md FR-4/FR-5
  describe("synced-upstream merge (specs/ref-chip-synced-upstream-merge.md)", () => {
    const local = { name: "main", fullName: "refs/heads/main", type: "local-branch" as const };
    const remote = { name: "origin/main", fullName: "refs/remotes/origin/main", type: "remote-branch" as const };

    it("renders both icons and one shared (never doubled) label when syncedRemote is set", () => {
      const { container } = render(<RefChip decoration={local} syncedRemote={remote} />);
      const chip = screen.getByRole("img", { name: "local branch: main (synced with origin/main)" });
      expect(chip.className).toContain("gh-refchip--synced-upstream");
      expect(container.querySelectorAll('svg[data-ref-icon="local-branch"]')).toHaveLength(1);
      expect(container.querySelectorAll('svg[data-ref-icon="remote-branch"]')).toHaveLength(1);
      // The label renders once — "main", never "main origin/main" or similar doubling.
      expect(chip.querySelectorAll(".gh-refchip__label")).toHaveLength(1);
      expect(chip.querySelector(".gh-refchip__label")).toHaveTextContent("main");
    });

    it("renders exactly one icon (no synced-upstream class) when syncedRemote is omitted — pre-existing behavior unchanged", () => {
      const { container } = render(<RefChip decoration={local} />);
      const chip = screen.getByRole("img", { name: "local branch: main" });
      expect(chip.className).not.toContain("gh-refchip--synced-upstream");
      expect(container.querySelectorAll("svg")).toHaveLength(1);
    });

    it("both icons stay aria-hidden — the merged chip's own aria-label remains the sole accessible name", () => {
      const { container } = render(<RefChip decoration={local} syncedRemote={remote} />);
      for (const svg of container.querySelectorAll("svg")) {
        expect(svg.getAttribute("aria-hidden")).toBe("true");
      }
    });
  });
});
