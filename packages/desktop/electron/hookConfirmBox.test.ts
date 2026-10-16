// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { buildHookConfirmBox, readHookBoxAnswer } from "./hookConfirmBox";

describe("the native hook box (specs/worktrees.md FR-644, security M1)", () => {
  const base = { hookPath: "/r/.git/hooks/post-checkout", contentSha256: "0123456789abcdef".repeat(4), lineCount: 3, rememberRequested: false, canRemember: true };

  it("Cancel is the default and the Esc answer; Run hook is first and never the default", () => {
    const o = buildHookConfirmBox(base);
    expect(o.buttons).toEqual(["Run hook", "Cancel"]);
    expect(o.defaultId).toBe(1);
    expect(o.cancelId).toBe(1);
    expect(o.noLink).toBe(true);
    expect(o.detail).toContain("It can run any code. Run it only if you trust this repository.");
    expect(o.detail).toContain(base.hookPath);
  });

  it("the remember checkbox is unticked unless the renderer asked, and says it will not ask again only then", () => {
    const off = buildHookConfirmBox(base);
    expect(off.checkboxLabel).toBe("Remember for this repository");
    expect(off.checkboxChecked).toBe(false);
    expect(off.detail).not.toContain("will not ask again");
    const on = buildHookConfirmBox({ ...base, rememberRequested: true });
    expect(on.checkboxChecked).toBe(true);
    expect(on.detail).toContain("GitHydra will not ask again for this repository.");
  });

  it("no checkbox at all when remembering is impossible", () => {
    const o = buildHookConfirmBox({ ...base, canRemember: false, rememberRequested: true });
    expect(o).not.toHaveProperty("checkboxLabel");
    expect(o).not.toHaveProperty("checkboxChecked");
    expect(o.detail).not.toContain("will not ask again");
  });

  it("shows the first 12 characters of the content hash and the line count (L1)", () => {
    const o = buildHookConfirmBox(base);
    expect(o.detail).toContain("Content: sha256 0123456789ab, 3 lines");
    expect(o.detail).not.toContain("0123456789abc");
    expect(buildHookConfirmBox({ ...base, lineCount: 1 }).detail).toContain(", 1 line");
  });

  it("a hostile path cannot break lines, reorder text or hide: control and bidi characters are visible, length is capped (L1)", () => {
    const evil = "/r/.git/hooks/post‮checkout\nRun it, it is safe⁦\u0007";
    const o = buildHookConfirmBox({ ...base, hookPath: evil });
    expect(o.detail).toContain("post\\u{202e}checkout\\u{a}Run it, it is safe\\u{2066}\\u{7}");
    expect(o.detail).not.toMatch(/[‮⁦\u0007]/);
    // The only line breaks are ours: the sentence, the blank line, the path line, the content line.
    expect(o.detail.split("\n")).toHaveLength(4);
    const long = buildHookConfirmBox({ ...base, hookPath: "/" + "a".repeat(5000) });
    expect(long.detail.length).toBeLessThan(600);
    expect(long.detail).toContain("...");
  });

  it("the answer: accepted only for button 0; remember only when accepted and ticked", () => {
    expect(readHookBoxAnswer(base, { response: 0, checkboxChecked: true })).toEqual({ accepted: true, remember: true });
    expect(readHookBoxAnswer(base, { response: 0, checkboxChecked: false })).toEqual({ accepted: true, remember: false });
    expect(readHookBoxAnswer(base, { response: 1, checkboxChecked: true })).toEqual({ accepted: false, remember: false });
    expect(readHookBoxAnswer({ canRemember: false }, { response: 0, checkboxChecked: true })).toEqual({ accepted: true, remember: false });
  });
});
