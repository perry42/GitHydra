// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { isImageEligibleChange } from "./imageDiffEligibility";

describe("isImageEligibleChange (FR-139)", () => {
  it("is eligible for a fixed-list extension, case-insensitive", () => {
    expect(isImageEligibleChange("assets/logo.PNG")).toBe(true);
    expect(isImageEligibleChange("icon.ico")).toBe(true);
    expect(isImageEligibleChange("photo.jpg")).toBe(true);
    expect(isImageEligibleChange("photo.jpeg")).toBe(true);
    expect(isImageEligibleChange("anim.gif")).toBe(true);
    expect(isImageEligibleChange("bitmap.bmp")).toBe(true);
    expect(isImageEligibleChange("vector.svg")).toBe(true);
  });

  it("is not eligible for a binary extension outside the fixed list", () => {
    expect(isImageEligibleChange("archive.zip")).toBe(false);
    expect(isImageEligibleChange("doc.pdf")).toBe(false);
    expect(isImageEligibleChange("design.psd")).toBe(false);
    expect(isImageEligibleChange("modern.webp")).toBe(false);
  });

  it("is eligible for a rename when only the OLD path qualifies", () => {
    expect(isImageEligibleChange("renamed.dat", "original.png")).toBe(true);
  });

  it("is eligible for a rename when only the NEW path qualifies", () => {
    expect(isImageEligibleChange("renamed.jpg", "original.dat")).toBe(true);
  });

  it("is not eligible when neither the path nor an omitted/non-image oldPath qualifies", () => {
    expect(isImageEligibleChange("readme.txt")).toBe(false);
    expect(isImageEligibleChange("readme.txt", "old-readme.txt")).toBe(false);
  });

  // security-reviewer finding: a naive `.endsWith(ext)` check disagreed with git-core's
  // `path.extname()`-based check for a bare dotfile named exactly `.png` — `path.extname(".png")`
  // is `""` (a dotfile has no extension, same as `.gitignore`), so git-core's own gate would
  // reject it even though the old `.endsWith` logic said eligible. Both sides must agree, since
  // git-core's check is the one that actually gates the byte read.
  it("is NOT eligible for a bare dotfile named exactly an image extension (matches git-core's path.extname semantics)", () => {
    expect(isImageEligibleChange(".png")).toBe(false);
    expect(isImageEligibleChange("assets/.svg")).toBe(false);
  });

  it("is still eligible for a real extension nested under a leading-dot directory", () => {
    expect(isImageEligibleChange(".config/logo.png")).toBe(true);
  });
});
