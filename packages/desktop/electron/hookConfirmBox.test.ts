// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { buildHookConfirmBox, readHookBoxAnswer } from "./hookConfirmBox";

describe("the native hook box (specs/worktrees.md FR-644, security M1)", () => {
  const base = { hookPath: "/r/.git/hooks/post-checkout", rememberRequested: false, canRemember: true };

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

  it("the answer: accepted only for button 0; remember only when accepted and ticked", () => {
    expect(readHookBoxAnswer(base, { response: 0, checkboxChecked: true })).toEqual({ accepted: true, remember: true });
    expect(readHookBoxAnswer(base, { response: 0, checkboxChecked: false })).toEqual({ accepted: true, remember: false });
    expect(readHookBoxAnswer(base, { response: 1, checkboxChecked: true })).toEqual({ accepted: false, remember: false });
    expect(readHookBoxAnswer({ canRemember: false }, { response: 0, checkboxChecked: true })).toEqual({ accepted: true, remember: false });
  });
});
