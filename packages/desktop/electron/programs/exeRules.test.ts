// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { checkProgramPath, stringProblem, PROBLEM_TEXT, type RuleEnv } from "./exeRules";
import type { Platform } from "./types";

/** specs/external-programs.md AC5: save-time rejection, each with its own reason string. */

function env(platform: Platform, over: Partial<RuleEnv> & { files?: string[]; dirs?: string[]; repo?: string[]; writable?: string[]; mz?: boolean } = {}): RuleEnv {
  const files = new Set(over.files ?? []);
  const dirs = new Set(over.dirs ?? []);
  return {
    platform,
    env: {},
    runCommand: async () => "",
    exists: async (p) => files.has(p),
    isDirectory: async (p) => dirs.has(p),
    isExecutable: async () => true,
    realpath: async (p) => p,
    readHead: async () => Uint8Array.from(over.mz === false ? [0x00, 0x00] : [0x4d, 0x5a]),
    hasGitAncestor: async (p) => (over.repo ?? []).some((r) => p.startsWith(r)),
    isWorldWritableDir: async (d) => (over.writable ?? []).includes(d),
    ...over,
  };
}

describe("stringProblem (any OS)", () => {
  it.each([
    ["code", "win32", "relative"],
    ["..\\x\\Code.exe", "win32", "relative"],
    ["./code", "linux", "relative"],
    ["", "linux", "relative"],
    ["\\\\host\\share\\Code.exe", "win32", "unc"],
    ["C:\\tools\\run.cmd", "win32", "script-extension"],
    ["C:\\tools\\RUN.BAT", "win32", "script-extension"],
    ["/opt/x/run.ps1", "linux", "script-extension"],
    ["C:\\x\\link.lnk", "win32", "script-extension"],
    ["C:\\x\\a.vbs", "win32", "script-extension"],
    ["C:\\Windows\\System32\\cmd.exe", "win32", "interpreter"],
    ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "win32", "interpreter"],
    ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "win32", "interpreter"],
    ["C:\\Windows\\System32\\wscript.exe", "win32", "interpreter"],
    ["C:\\Windows\\System32\\mshta.exe", "win32", "interpreter"],
    ["/bin/bash", "linux", "interpreter"],
    ["/bin/sh", "darwin", "interpreter"],
  ] as const)("%s on %s -> %s", (p, platform, problem) => {
    expect(stringProblem(p, platform)).toBe(problem);
  });

  it("lets an ordinary absolute program through and gives each problem its own sentence", () => {
    expect(stringProblem("C:\\Program Files\\Code\\Code.exe", "win32")).toBeNull();
    expect(stringProblem("/usr/bin/code", "linux")).toBeNull();
    const texts = Object.values(PROBLEM_TEXT);
    expect(new Set(texts).size).toBe(texts.length);
  });
});

describe("checkProgramPath", () => {
  it("reports distinct reasons: missing, directory, not executable, not a Windows exe", async () => {
    expect(await checkProgramPath("/usr/bin/nope", env("linux"))).toEqual({ ok: false, problem: "missing" });
    expect(await checkProgramPath("/opt/dir", env("linux", { dirs: ["/opt/dir"] }))).toEqual({ ok: false, problem: "directory" });
    expect(await checkProgramPath("/opt/file", env("linux", { files: ["/opt/file"], isExecutable: async () => false }))).toEqual({ ok: false, problem: "not-executable" });
    expect(await checkProgramPath("C:\\x\\a.txt", env("win32", { files: ["C:\\x\\a.txt"] }))).toEqual({ ok: false, problem: "not-windows-exe" });
    expect(await checkProgramPath("C:\\x\\fake.exe", env("win32", { files: ["C:\\x\\fake.exe"], mz: false }))).toEqual({ ok: false, problem: "not-windows-exe" });
  });

  it("accepts a real exe (extension and MZ magic)", async () => {
    const r = await checkProgramPath("C:\\Tools\\ed.exe", env("win32", { files: ["C:\\Tools\\ed.exe"] }));
    expect(r).toMatchObject({ ok: true, kind: "exe", risk: null });
  });

  it("flags a hand-added exe inside a repository or a world-writable folder (confirm, not refusal)", async () => {
    const inRepo = await checkProgramPath("/home/a/proj/tools/ed", env("linux", { files: ["/home/a/proj/tools/ed"], repo: ["/home/a/proj"] }));
    expect(inRepo).toMatchObject({ ok: true, risk: "repository" });
    const writable = await checkProgramPath("/tmp/ed", env("linux", { files: ["/tmp/ed"], writable: ["/tmp"] }));
    expect(writable).toMatchObject({ ok: true, risk: "world-writable" });
  });

  it("refuses a symlink whose target is a script or an interpreter", async () => {
    const e = env("linux", { files: ["/usr/local/bin/ed"], realpath: async () => "/bin/bash" });
    expect(await checkProgramPath("/usr/local/bin/ed", e)).toEqual({ ok: false, problem: "interpreter" });
  });

  it("treats a macOS .app as a directory program", async () => {
    const r = await checkProgramPath("/Applications/Zed.app", env("darwin", { dirs: ["/Applications/Zed.app"] }));
    expect(r).toMatchObject({ ok: true, kind: "app" });
    expect(await checkProgramPath("/Applications/Gone.app", env("darwin"))).toEqual({ ok: false, problem: "missing" });
  });

  it("never throws when a seam does", async () => {
    const e = env("linux", {
      isDirectory: async () => {
        throw new Error("EIO");
      },
    });
    expect(await checkProgramPath("/usr/bin/code", e)).toEqual({ ok: false, problem: "missing" });
  });
});
