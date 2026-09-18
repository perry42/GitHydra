// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { deriveRepoNameFromUrl, joinDestinationPath } from "./cloneDestination";

describe("cloneDestination (specs/online-sync-clone.md FR-351)", () => {
  describe("deriveRepoNameFromUrl", () => {
    it("strips a trailing .git from an https URL", () => {
      expect(deriveRepoNameFromUrl("https://github.com/octocat/Hello-World.git")).toBe("Hello-World");
    });

    it("handles an https URL with no .git suffix", () => {
      expect(deriveRepoNameFromUrl("https://github.com/octocat/Hello-World")).toBe("Hello-World");
    });

    it("handles a scp-style ssh URL (git@host:owner/repo.git)", () => {
      expect(deriveRepoNameFromUrl("git@github.com:octocat/Hello-World.git")).toBe("Hello-World");
    });

    it("handles a trailing slash", () => {
      expect(deriveRepoNameFromUrl("https://github.com/octocat/Hello-World.git/")).toBe("Hello-World");
    });

    it("handles a local POSIX path", () => {
      expect(deriveRepoNameFromUrl("/home/user/repos/my-repo")).toBe("my-repo");
    });

    it("handles a local Windows path", () => {
      expect(deriveRepoNameFromUrl("D:\\repos\\my-repo")).toBe("my-repo");
    });

    it("falls back to 'repository' for an empty/whitespace-only URL", () => {
      expect(deriveRepoNameFromUrl("")).toBe("repository");
      expect(deriveRepoNameFromUrl("   ")).toBe("repository");
    });

    it("derives from whatever single token remains for a scheme with no further path (an edge case no real clone URL actually has)", () => {
      expect(deriveRepoNameFromUrl("https://")).toBe("https");
    });
  });

  describe("joinDestinationPath", () => {
    it("joins with a forward slash for a POSIX-styled parent", () => {
      expect(joinDestinationPath("/home/user/projects", "my-repo")).toBe("/home/user/projects/my-repo");
    });

    it("joins with a backslash for a Windows-styled parent", () => {
      expect(joinDestinationPath("D:\\Users\\me\\projects", "my-repo")).toBe("D:\\Users\\me\\projects\\my-repo");
    });

    it("strips a trailing separator from the parent before joining", () => {
      expect(joinDestinationPath("/home/user/projects/", "my-repo")).toBe("/home/user/projects/my-repo");
      expect(joinDestinationPath("D:\\Users\\me\\projects\\", "my-repo")).toBe("D:\\Users\\me\\projects\\my-repo");
    });
  });
});
