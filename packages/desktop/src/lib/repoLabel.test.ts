import { describe, expect, it } from "vitest";
import { repoTabLabel } from "./repoLabel";

describe("repoTabLabel", () => {
  it("returns the final segment of a POSIX path", () => {
    expect(repoTabLabel("/Users/dev/code/gitHydra")).toBe("gitHydra");
  });

  it("returns the final segment of a Windows path", () => {
    expect(repoTabLabel("D:\\projects\\GitHydra")).toBe("GitHydra");
  });

  it("tolerates a trailing separator", () => {
    expect(repoTabLabel("/repos/service/")).toBe("service");
    expect(repoTabLabel("D:\\repos\\service\\")).toBe("service");
  });

  it("falls back to the full path when there is no separator", () => {
    expect(repoTabLabel("repo")).toBe("repo");
  });
});
