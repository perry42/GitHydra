// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { stripInjectedFlags, summarizePartialFailure } from "./partialStagingErrors";

describe("partial staging error summaries", () => {
  it("strips injected -c flags", () => {
    expect(stripInjectedFlags("git -c core.fsmonitor=false -c core.hooksPath=C:/x apply --cached")).toBe("git apply --cached");
  });

  it("maps index.lock to a specific one-liner", () => {
    const f = summarizePartialFailure("unstage", "git -c core.a=b apply - exited with code 128:\nfatal: Unable to create '.git/index.lock': File exists.");
    expect(f.summary).toBe("Couldn't unstage: another git process holds index.lock");
    expect(f.details).not.toContain("core.a");
  });

  it("falls back to git's first message line, not the echoed command", () => {
    const f = summarizePartialFailure("discard", "git -c core.a=b apply -R - exited with code 1:\nerror: patch failed: f.txt:3\nmore");
    expect(f.summary).toBe("Couldn't discard the selection: patch failed: f.txt:3");
  });

  it("uses the first line of a plain message", () => {
    expect(summarizePartialFailure("stage", "boom\nsecond").summary).toBe("Couldn't stage the selection: boom");
  });
});
