// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { detectLinux } from "./detectLinux";
import { detectMac } from "./detectMac";
import { detectPrograms } from "./detect";
import { detectWindows, parseRegQuery } from "./detectWindows";
import type { DetectEnv } from "./types";

/** specs/external-programs.md AC3: pure detectors fed canned `reg query` / `mdfind` output and a virtual file system, on any OS. */

const SYSTEM_ROOT = "C:\\Windows";
const REG = "C:\\Windows\\System32\\reg.exe";

function entry(key: string, v: Record<string, string>): string {
  return [`HKEY_X\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${key}`, ...Object.entries(v).map(([k, val]) => `    ${k}    REG_SZ    ${val}`), ""].join("\r\n");
}

function winEnv(opts: { hklm?: string[]; hkcu?: string[]; files?: string[]; dirs?: Record<string, string[]>; repoUnder?: string[]; env?: Record<string, string> }) {
  const files = new Set((opts.files ?? []).map((f) => f.toLowerCase()));
  const calls: { command: string; args: readonly string[] }[] = [];
  const exists = vi.fn(async (p: string) => files.has(p.toLowerCase()));
  const env: DetectEnv = {
    platform: "win32",
    env: { SystemRoot: SYSTEM_ROOT, LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local", ProgramFiles: "C:\\Program Files", ...(opts.env ?? {}) },
    runCommand: async (command, args) => {
      calls.push({ command, args });
      const key = String(args[1]);
      if (key.startsWith("HKCU")) return (opts.hkcu ?? []).join("\r\n");
      if (key.includes("WOW6432Node")) return "";
      return (opts.hklm ?? []).join("\r\n");
    },
    exists,
    readdir: async (d) => opts.dirs?.[d.toLowerCase()] ?? [],
    hasGitAncestor: async (p) => (opts.repoUnder ?? []).some((r) => p.toLowerCase().startsWith(r.toLowerCase())),
  };
  return { env, calls, exists };
}

const VSCODE = entry("{A}", {
  DisplayName: "Microsoft Visual Studio Code",
  Publisher: "Microsoft Corporation",
  InstallLocation: "C:\\Program Files\\Microsoft VS Code\\",
  DisplayIcon: "C:\\Program Files\\Microsoft VS Code\\unins000.exe",
});

describe("detectWindows (FR-618)", () => {
  it("finds an editor by DisplayName prefix AND Publisher, using InstallLocation + the known exe name", async () => {
    const { env } = winEnv({ hklm: [VSCODE], files: ["C:\\Program Files\\Microsoft VS Code\\Code.exe"] });
    const found = await detectWindows(env);
    expect(found.map((p) => [p.id, p.exe])).toEqual([["vscode", "C:\\Program Files\\Microsoft VS Code\\Code.exe"]]);
  });

  it("queries with the absolute system reg.exe and an argv array, once per hive", async () => {
    const { env, calls } = winEnv({});
    await detectWindows(env);
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.command).toBe(REG);
      expect(Array.isArray(c.args)).toBe(true);
      expect(c.args[0]).toBe("query");
    }
    expect(calls.map((c) => c.args[1]).join(" ")).toMatch(/HKLM.*HKLM.*WOW6432Node.*HKCU/);
  });

  it("returns [] for no editors, a rejecting runCommand, and an unusable SystemRoot, never throwing", async () => {
    expect(await detectWindows(winEnv({}).env)).toEqual([]);
    const rejecting = winEnv({}).env;
    rejecting.runCommand = async () => {
      throw new Error("boom");
    };
    expect(await detectWindows(rejecting)).toEqual([]);
    expect(await detectWindows(winEnv({ env: { SystemRoot: "..\\evil" } }).env)).toEqual([]);
    expect(await detectWindows(winEnv({ env: { SystemRoot: "\\\\host\\share\\Windows" } }).env)).toEqual([]);
  });

  it("excludes a name match with the wrong Publisher", async () => {
    const spoof = entry("{B}", { DisplayName: "Microsoft Visual Studio Code", Publisher: "Totally Legit Ltd", InstallLocation: "C:\\Program Files\\Microsoft VS Code\\" });
    const { env } = winEnv({ hklm: [spoof], files: ["C:\\Program Files\\Microsoft VS Code\\Code.exe"] });
    expect(await detectWindows(env)).toEqual([]);
  });

  it("excludes an editor whose executable is missing, and never looks at DisplayIcon", async () => {
    const { env, exists } = winEnv({ hklm: [VSCODE], files: ["C:\\Program Files\\Microsoft VS Code\\unins000.exe"] });
    expect(await detectWindows(env)).toEqual([]);
    expect(exists.mock.calls.map((c) => String(c[0]).toLowerCase())).not.toContain("c:\\program files\\microsoft vs code\\unins000.exe");
  });

  it("tolerates truncated and non-UTF8 output", async () => {
    const { env } = winEnv({ hklm: ["HKEY_X\\Uninstall\\{A}\r\n    DisplayName    REG_SZ    Microsoft Visual Stud", "\uFFFD\uFFFD\uFFFD    REG_SZ", VSCODE.slice(0, 120)], files: [] });
    await expect(detectWindows(env)).resolves.toEqual([]);
    expect(parseRegQuery("not a registry dump at all")).toEqual([]);
  });

  it("does not take Visual Studio Code Insiders for Visual Studio Code (longest prefix wins)", async () => {
    const insiders = entry("{C}", { DisplayName: "Microsoft Visual Studio Code Insiders", Publisher: "Microsoft Corporation", InstallLocation: "C:\\Program Files\\Microsoft VS Code Insiders" });
    const { env } = winEnv({ hklm: [insiders], files: ["C:\\Program Files\\Microsoft VS Code Insiders\\Code - Insiders.exe"] });
    expect((await detectWindows(env)).map((p) => p.id)).toEqual(["vscode-insiders"]);
  });

  it("constrains HKCU hits to LOCALAPPDATA\\Programs, ProgramFiles or the Toolbox dir", async () => {
    const mk = (loc: string) => entry("{D}", { DisplayName: "Cursor", Publisher: "Anysphere", InstallLocation: loc });
    const inPrograms = winEnv({ hkcu: [mk("C:\\Users\\a\\AppData\\Local\\Programs\\cursor")], files: ["C:\\Users\\a\\AppData\\Local\\Programs\\cursor\\Cursor.exe"] });
    expect((await detectWindows(inPrograms.env)).map((p) => p.id)).toEqual(["cursor"]);
    const planted = winEnv({ hkcu: [mk("C:\\Users\\a\\Downloads\\cursor")], files: ["C:\\Users\\a\\Downloads\\cursor\\Cursor.exe"] });
    expect(await detectWindows(planted.env)).toEqual([]);
    // The same location through HKLM (admin-written) is not constrained.
    const hklm = winEnv({ hklm: [mk("C:\\Tools\\cursor")], files: ["C:\\Tools\\cursor\\Cursor.exe"] });
    expect((await detectWindows(hklm.env)).map((p) => p.id)).toEqual(["cursor"]);
  });

  it("ignores a UNC or relative InstallLocation", async () => {
    const unc = winEnv({ hklm: [entry("{E}", { DisplayName: "Cursor", Publisher: "Anysphere", InstallLocation: "\\\\host\\share\\cursor" })], files: ["\\\\host\\share\\cursor\\Cursor.exe"] });
    expect(await detectWindows(unc.env)).toEqual([]);
    const rel = winEnv({ hklm: [entry("{E}", { DisplayName: "Cursor", Publisher: "Anysphere", InstallLocation: "cursor" })], files: ["cursor\\Cursor.exe"] });
    expect(await detectWindows(rel.env)).toEqual([]);
  });

  it("ignores a hit inside a repository", async () => {
    const { env } = winEnv({ hklm: [VSCODE], files: ["C:\\Program Files\\Microsoft VS Code\\Code.exe"], repoUnder: ["C:\\Program Files\\Microsoft VS Code"] });
    expect(await detectWindows(env)).toEqual([]);
  });

  it("finds JetBrains IDEs: current and previous versions from the registry, plus Toolbox installs", async () => {
    const idea = (v: string) =>
      entry(`{I${v}}`, { DisplayName: `IntelliJ IDEA ${v}`, Publisher: "JetBrains s.r.o.", InstallLocation: `C:\\Program Files\\JetBrains\\IntelliJ IDEA ${v}` });
    const { env } = winEnv({
      hklm: [idea("2023.3"), idea("2024.1.2"), idea("2022.2")],
      files: [
        "C:\\Program Files\\JetBrains\\IntelliJ IDEA 2023.3\\bin\\idea64.exe",
        "C:\\Program Files\\JetBrains\\IntelliJ IDEA 2024.1.2\\bin\\idea64.exe",
        "C:\\Program Files\\JetBrains\\IntelliJ IDEA 2022.2\\bin\\idea64.exe",
        "C:\\Users\\a\\AppData\\Local\\JetBrains\\Toolbox\\apps\\PyCharm-P\\ch-0\\241.1\\bin\\pycharm64.exe",
      ],
      dirs: {
        "c:\\users\\a\\appdata\\local\\jetbrains\\toolbox\\apps\\pycharm-p": ["ch-0"],
        "c:\\users\\a\\appdata\\local\\jetbrains\\toolbox\\apps\\pycharm-p\\ch-0": ["241.1", "junk.txt"],
      },
    });
    const found = await detectWindows(env);
    expect(found.filter((p) => p.editorId === "intellij-idea").map((p) => p.name)).toEqual(["IntelliJ IDEA 2024.1.2", "IntelliJ IDEA 2023.3"]);
    expect(found.find((p) => p.editorId === "pycharm")?.exe).toBe("C:\\Users\\a\\AppData\\Local\\JetBrains\\Toolbox\\apps\\PyCharm-P\\ch-0\\241.1\\bin\\pycharm64.exe");
  });
});

describe("detectMac (FR-619)", () => {
  const HOME = "/Users/a";
  function macEnv(hits: Record<string, string[]>, opts: { real?: Record<string, string>; dirs?: string[]; repoUnder?: string[] } = {}) {
    const calls: { command: string; args: readonly string[] }[] = [];
    const dirs = new Set(opts.dirs ?? Object.values(hits).flat());
    const env: DetectEnv = {
      platform: "darwin",
      env: { HOME },
      homedir: HOME,
      runCommand: async (command, args) => {
        calls.push({ command, args });
        const id = /'(.+)'/.exec(String(args[0]))?.[1] ?? "";
        return (hits[id] ?? []).join("\n");
      },
      exists: async () => false,
      isDirectory: async (p) => dirs.has(p) || [...dirs].some((d) => (opts.real?.[d] ?? d) === p),
      realpath: async (p) => opts.real?.[p] ?? p,
      hasGitAncestor: async (p) => (opts.repoUnder ?? []).some((r) => p.startsWith(r)),
    };
    return { env, calls };
  }

  it("asks mdfind by a built-in bundle id with an argv array and the absolute path", async () => {
    const { env, calls } = macEnv({});
    expect(await detectMac(env)).toEqual([]);
    const vscode = calls.find((c) => String(c.args[0]).includes("com.microsoft.VSCode'"));
    expect(vscode?.command).toBe("/usr/bin/mdfind");
    expect(vscode?.args).toEqual(["kMDItemCFBundleIdentifier == 'com.microsoft.VSCode'"]);
  });

  it("accepts hits only under /Applications, /System/Applications or ~/Applications, outside any repo", async () => {
    const { env } = macEnv(
      {
        "com.microsoft.VSCode": ["/Applications/Visual Studio Code.app", "/tmp/evil/Visual Studio Code.app", "/Users/a/projects/repo/Evil.app"],
        "dev.zed.Zed": ["/Users/a/Applications/Zed.app"],
        "com.sublimetext.4": ["/Applications/Sublime Text.app"],
      },
      { repoUnder: ["/Applications/Sublime Text.app"] },
    );
    const found = await detectMac(env);
    expect(found.map((p) => [p.id, p.exe, p.kind])).toEqual([
      ["vscode", "/Applications/Visual Studio Code.app", "app"],
      ["zed", "/Users/a/Applications/Zed.app", "app"],
    ]);
  });

  it("realpaths every hit: a symlink in /Applications that leads outside is refused", async () => {
    const { env } = macEnv({ "com.microsoft.VSCode": ["/Applications/Code.app"] }, { real: { "/Applications/Code.app": "/Users/a/repo/Code.app" }, dirs: ["/Users/a/repo/Code.app"] });
    expect(await detectMac(env)).toEqual([]);
  });

  it("returns [] when mdfind rejects", async () => {
    const { env } = macEnv({});
    env.runCommand = async () => {
      throw new Error("no spotlight");
    };
    expect(await detectMac(env)).toEqual([]);
  });
});

describe("detectLinux (FR-620)", () => {
  function linuxEnv(files: string[], opts: { PATH?: string; real?: Record<string, string>; repoUnder?: string[]; writable?: string[] } = {}) {
    const set = new Set(files);
    const env: DetectEnv = {
      platform: "linux",
      env: { PATH: opts.PATH ?? "", HOME: "/home/a" },
      homedir: "/home/a",
      runCommand: async () => "",
      exists: async (p) => set.has(p),
      realpath: async (p) => opts.real?.[p] ?? p,
      hasGitAncestor: async (p) => (opts.repoUnder ?? []).some((r) => p.startsWith(r)),
      isWorldWritableDir: async (d) => (opts.writable ?? []).includes(d),
    };
    return env;
  }

  it("finds known locations, snap, flatpak exports and JetBrains Toolbox scripts", async () => {
    const found = await detectLinux(
      linuxEnv(["/usr/bin/code", "/snap/bin/codium", "/var/lib/flatpak/exports/bin/dev.zed.Zed", "/home/a/.local/share/JetBrains/Toolbox/scripts/idea"], { real: { "/snap/bin/codium": "/usr/bin/snap" } }),
    );
    expect(found.map((p) => p.id).sort()).toEqual(["intellij-idea", "vscode", "vscodium", "zed"]);
    expect(found.find((p) => p.id === "vscodium")).toMatchObject({ exe: "/snap/bin/codium", resolved: "/usr/bin/snap" });
  });

  it("uses absolute PATH entries only and ignores '.', empty and relative ones", async () => {
    const files = ["/opt/tools/bin/zed", "/home/a/proj/zed", "/rel/bin/subl"];
    const found = await detectLinux(linuxEnv(files, { PATH: ".::bin:rel/bin:/opt/tools/bin" }));
    expect(found.map((p) => [p.id, p.exe])).toEqual([["zed", "/opt/tools/bin/zed"]]);
  });

  it("prefers known locations over PATH", async () => {
    const found = await detectLinux(linuxEnv(["/usr/bin/code", "/opt/x/code"], { PATH: "/opt/x" }));
    expect(found).toHaveLength(1);
    expect(found[0]!.exe).toBe("/usr/bin/code");
  });

  it("ignores hits inside a repository, a world-writable directory, or a symlink leading into one", async () => {
    const found = await detectLinux(
      linuxEnv(["/opt/repo/bin/code", "/tmp/bin/codium", "/opt/ok/bin/zed", "/opt/ok/bin/subl"], {
        PATH: "/opt/repo/bin:/tmp/bin:/opt/ok/bin",
        repoUnder: ["/opt/repo"],
        writable: ["/tmp"],
        real: { "/opt/ok/bin/subl": "/opt/repo/real/subl" },
      }),
    );
    expect(found.map((p) => p.id)).toEqual(["zed"]);
  });

  it("returns [] for an empty machine and when the seams throw", async () => {
    expect(await detectLinux(linuxEnv([]))).toEqual([]);
    const env = linuxEnv([]);
    env.exists = async () => {
      throw new Error("io");
    };
    expect(await detectLinux(env)).toEqual([]);
  });
});

describe("detectPrograms (FR-621)", () => {
  it("dispatches on env.platform and never throws", async () => {
    const env = winEnv({}).env;
    expect(await detectPrograms(env)).toEqual([]);
    env.runCommand = () => {
      throw new Error("sync throw");
    };
    expect(await detectPrograms(env)).toEqual([]);
  });
});
