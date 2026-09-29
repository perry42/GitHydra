// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * specs/ref-chip-gutter-redesign.md Addendum, AC3a: a real, programmatic contrast-ratio
 * computation — not eyeballed — for every `--gh-lane-{1-8}` slot in both themes, at the exact
 * opacity `RefChip.tsx` actually ships (`REF_CHIP_LANE_TINT_PERCENT`), against both ink tokens the
 * chip's text can render in (`--gh-ink-secondary` the plain/unfilled state, `--gh-ink-primary` the
 * bold `filled` state). Reads the real hex values straight out of `theme.css` (never duplicates
 * them as hardcoded literals here) so this test can't silently drift from the actual shipped
 * tokens — the same "read the real source" convention `layoutBudget.test.ts`'s CSS-mechanism
 * describe block and `RefChip.test.tsx`'s FR-415 border describe block already established.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { contrastRatio, hexToRgb, mixSrgbHex } from "../../lib/contrastRatio";
import { REF_CHIP_LANE_TINT_PERCENT } from "./RefChip";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const themeCss = fs.readFileSync(path.join(dirname, "..", "..", "theme.css"), "utf8");

const WCAG_AA_NORMAL_TEXT_MIN_CONTRAST = 4.5;
const LANE_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

/** Pulls one `--token-name: #hex;` value out of a specific `{ ... }` block in `theme.css`'s raw
 * source text (light theme's block starts at `:root,\n[data-theme="light"] {`, dark theme's at
 * `[data-theme="dark"] {`) — a small, purpose-built parse, not a general CSS parser, matching this
 * test file's one job. */
function readToken(blockSelectorPattern: RegExp, tokenName: string): string {
  const blockMatch = themeCss.match(blockSelectorPattern);
  if (!blockMatch) throw new Error(`theme.css: couldn't find block for ${blockSelectorPattern}`);
  const blockStart = blockMatch.index! + blockMatch[0].length;
  const blockEnd = themeCss.indexOf("\n}", blockStart);
  const block = themeCss.slice(blockStart, blockEnd);
  const tokenMatch = block.match(new RegExp(`--${tokenName}:\\s*(#[0-9a-fA-F]{3,6})\\s*;`));
  if (!tokenMatch) throw new Error(`theme.css: couldn't find --${tokenName} in this block`);
  return tokenMatch[1]!;
}

const LIGHT_BLOCK = /:root,\s*\[data-theme="light"\]\s*\{/;
const DARK_BLOCK = /\[data-theme="dark"\]\s*\{/;

interface ThemeTokens {
  name: "light" | "dark";
  surface: string;
  inkSecondary: string;
  inkPrimary: string;
  lanes: Record<(typeof LANE_SLOTS)[number], string>;
}

function readThemeTokens(name: "light" | "dark", blockPattern: RegExp): ThemeTokens {
  const lanes = Object.fromEntries(
    LANE_SLOTS.map((slot) => [slot, readToken(blockPattern, `gh-lane-${slot}`)]),
  ) as ThemeTokens["lanes"];
  return {
    name,
    surface: readToken(blockPattern, "gh-surface"),
    inkSecondary: readToken(blockPattern, "gh-ink-secondary"),
    inkPrimary: readToken(blockPattern, "gh-ink-primary"),
    lanes,
  };
}

const THEMES: ThemeTokens[] = [readThemeTokens("light", LIGHT_BLOCK), readThemeTokens("dark", DARK_BLOCK)];

describe("RefChip lane-tint background contrast (specs/ref-chip-gutter-redesign.md Addendum, FR-417/AC3a)", () => {
  it("parsed real theme.css tokens sanity check (catches a broken parse before it silently passes everything)", () => {
    const light = THEMES.find((t) => t.name === "light")!;
    const dark = THEMES.find((t) => t.name === "dark")!;
    expect(light.surface.toLowerCase()).toBe("#ffffff");
    expect(dark.surface.toLowerCase()).toBe("#1a1a19");
    expect(light.lanes[1].toLowerCase()).toBe("#2a78d6");
    expect(dark.lanes[1].toLowerCase()).toBe("#3987e5");
  });

  for (const theme of THEMES) {
    for (const slot of LANE_SLOTS) {
      it(`${theme.name} theme, lane ${slot}: chip background (lane color mixed ${REF_CHIP_LANE_TINT_PERCENT}% into --gh-surface) keeps --gh-ink-secondary text at >= 4.5:1`, () => {
        const bg = mixSrgbHex(theme.lanes[slot], theme.surface, REF_CHIP_LANE_TINT_PERCENT);
        const ratio = contrastRatio(hexToRgb(theme.inkSecondary), bg);
        expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN_CONTRAST);
      });

      it(`${theme.name} theme, lane ${slot}: chip background keeps --gh-ink-primary (filled/bold state) text at >= 4.5:1`, () => {
        const bg = mixSrgbHex(theme.lanes[slot], theme.surface, REF_CHIP_LANE_TINT_PERCENT);
        const ratio = contrastRatio(hexToRgb(theme.inkPrimary), bg);
        expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN_CONTRAST);
      });
    }
  }

  it("documents the actual worst-case slot/theme combination found (regression guard: if this ever changes, the opacity constant's own doc comment needs re-checking, not just this number)", () => {
    let worst = Infinity;
    let worstLabel = "";
    for (const theme of THEMES) {
      for (const slot of LANE_SLOTS) {
        const bg = mixSrgbHex(theme.lanes[slot], theme.surface, REF_CHIP_LANE_TINT_PERCENT);
        const ratio = contrastRatio(hexToRgb(theme.inkSecondary), bg);
        if (ratio < worst) {
          worst = ratio;
          worstLabel = `${theme.name} theme, lane ${slot}`;
        }
      }
    }
    // RefChip.tsx's own REF_CHIP_LANE_TINT_PERCENT doc comment states the worst case is light
    // theme's lane 7 (violet) at ~5.7:1 — this pins that exact claim against the real computation,
    // so a future token change that silently invalidates the doc comment's own claim fails loudly.
    expect(worstLabel).toBe("light theme, lane 7");
    expect(worst).toBeGreaterThanOrEqual(5.5);
    expect(worst).toBeLessThan(6);
  });

  it("would fail at the old REF_GUTTER... no — sanity: a solid (100%) lane fill would NOT clear 4.5:1 for at least one slot in light theme, confirming a tint (not a solid fill) is the real reason this passes", () => {
    // Documents *why* FR-417 mixes toward the surface instead of using the raw lane color directly
    // — this is the exact regression a future "just use the lane color as the background" shortcut
    // would reintroduce, silently, without this guard.
    const light = THEMES.find((t) => t.name === "light")!;
    const worstAtFullSaturation = Math.min(
      ...LANE_SLOTS.map((slot) => contrastRatio(hexToRgb(light.inkSecondary), hexToRgb(light.lanes[slot]))),
    );
    expect(worstAtFullSaturation).toBeLessThan(WCAG_AA_NORMAL_TEXT_MIN_CONTRAST);
  });
});
