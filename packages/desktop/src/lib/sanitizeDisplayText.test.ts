// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { sanitizeDisplayText } from "./sanitizeDisplayText";

const S = (...cps: number[]) => String.fromCodePoint(...cps);

describe("sanitizeDisplayText", () => {
  it("removes bidi overrides/isolates and invisible characters", () => {
    expect(sanitizeDisplayText("ma" + S(0x202e, 0x2066, 0x200b, 0xe0041, 0xfe0f) + "in")).toBe("main");
  });
  it("turns control characters into spaces and leaves ordinary text alone", () => {
    expect(sanitizeDisplayText("a" + S(0x07, 0x1b) + "b")).toBe("a b");
    expect(sanitizeDisplayText("feature/caf" + S(0xe9) + "-" + S(0x65e5, 0x672c))).toBe("feature/caf" + S(0xe9) + "-" + S(0x65e5, 0x672c));
  });
});
