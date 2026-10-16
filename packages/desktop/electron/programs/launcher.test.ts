// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { launchProcess, scrubEnv, type SpawnFn } from "./launcher";
import { resolveLaunchFolder } from "./folderRules";

/** specs/external-programs.md AC4: the spawn seam, hostile folder names, the scrubbed env, plus one real-process proof. */

const HOSTILE = [
  "C:\\Users\\a\\my project & co",
  "/home/a/proj; rm -rf ~",
  "/home/a/$(touch pwned)",
  "/home/a/it's \"quoted\" `tick`",
  "C:\\Users\\a\\100%\\^caret",
];

function spy() {
  const unref = vi.fn();
  const fn = vi.fn(() => ({ unref })) as unknown as SpawnFn & ReturnType<typeof vi.fn>;
  return { fn, unref };
}

describe("launchProcess (FR-622)", () => {
  it("spawns (exe, [folder]) with shell:false, detached, stdio ignore, the home dir as cwd, and unrefs", async () => {
    const { fn, unref } = spy();
    const r = await launchProcess({ exe: "/usr/bin/code", kind: "exe", folder: "/work/repo", platform: "linux", home: "/home/a", env: { PATH: "/usr/bin" }, spawnFn: fn });
    expect(r).toEqual({ ok: true });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("/usr/bin/code", ["/work/repo"], expect.objectContaining({ shell: false, detached: true, stdio: "ignore", cwd: "/home/a" }));
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it.each(HOSTILE)("hands the hostile folder %j over as ONE intact argument", async (folder) => {
    const { fn } = spy();
    const platform = folder.startsWith("C:") ? "win32" : "linux";
    await launchProcess({ exe: "x", kind: "exe", folder, platform, home: "/h", env: {}, spawnFn: fn });
    const call = (fn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    expect(call[1]).toHaveLength(1);
    expect((call[1] as string[])[0]).toBe(folder);
  });

  it("drops ELECTRON_*, NODE_*, GIT_*, LD_PRELOAD, DYLD_*, PYTHON*, _JAVA_OPTIONS from the child's env", async () => {
    const { fn } = spy();
    await launchProcess({
      exe: "/usr/bin/code",
      kind: "exe",
      folder: "/w",
      platform: "linux",
      home: "/h",
      env: { ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "--x", GIT_DIR: "/x", GIT_SSH_COMMAND: "ssh", LD_PRELOAD: "/x.so", DYLD_INSERT_LIBRARIES: "/y", PYTHONPATH: "/p", _JAVA_OPTIONS: "-X", node_env: "lower", HOME: "/h", PATH: "/usr/bin", LANG: "C" },
      spawnFn: fn,
    });
    const options = (fn as unknown as { mock: { calls: [string, string[], { env: Record<string, string> }][] } }).mock.calls[0]![2];
    expect(Object.keys(options.env).sort()).toEqual(["HOME", "LANG", "PATH"]);
    expect(scrubEnv({ Electron_Thing: "1", Path: "p" })).toEqual({ Path: "p" });
  });

  it("L3: also drops LD_LIBRARY_PATH, JAVA_TOOL_OPTIONS, JDK_JAVA_OPTIONS, BASH_ENV, ENV, PERL5OPT, RUBYOPT", () => {
    const scrubbed = scrubEnv({ LD_LIBRARY_PATH: "/x", JAVA_TOOL_OPTIONS: "-javaagent:x", JDK_JAVA_OPTIONS: "-X", BASH_ENV: "/e", ENV: "/e", PERL5OPT: "-Mx", RUBYOPT: "-rx", PATH: "/usr/bin", HOME: "/h", JAVA_HOME: "/jdk" });
    expect(scrubbed).toEqual({ PATH: "/usr/bin", HOME: "/h", JAVA_HOME: "/jdk" });
  });

  it("hands hostile names with spaces and quotes through a REAL process intact (the win32 argv control)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-launch2-"));
    try {
      const out = path.join(dir, "argv.json");
      const script = path.join(dir, "fake-editor.js");
      fs.writeFileSync(script, `require("fs").writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));`);
      // Quotes are illegal in Windows names, so use what each OS allows; both have spaces and shell metacharacters.
      const folder = path.join(dir, process.platform === "win32" ? "a b & c (1) ^ % !x" : `a b "q" 'q' & $(x) \`z\``);
      fs.mkdirSync(folder);
      const wrapped: SpawnFn = (command, args, options) => spawn(command, [script, out, ...args], options);
      expect(await launchProcess({ exe: process.execPath, kind: "exe", folder, platform: process.platform === "win32" ? "win32" : "linux", home: dir, env: process.env, spawnFn: wrapped })).toEqual({ ok: true });
      const deadline = Date.now() + 15_000;
      while (!fs.existsSync(out) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 100));
      expect(JSON.parse(fs.readFileSync(out, "utf8"))).toEqual([folder]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("macOS uses /usr/bin/open -a <abs .app> <folder> and nothing else", async () => {
    const { fn } = spy();
    await launchProcess({ exe: "/Applications/Cursor.app", kind: "app", folder: "/Users/a/repo", platform: "darwin", home: "/Users/a", env: {}, spawnFn: fn });
    expect(fn).toHaveBeenCalledWith("/usr/bin/open", ["-a", "/Applications/Cursor.app", "/Users/a/repo"], expect.objectContaining({ shell: false }));
  });

  it("rejects a folder that is relative or starts with '-' and never spawns", async () => {
    const { fn } = spy();
    for (const folder of ["-rf", "--help", "relative/dir", "./x", ""]) {
      expect(await launchProcess({ exe: "/usr/bin/code", kind: "exe", folder, platform: "linux", home: "/h", env: {}, spawnFn: fn })).toEqual({ ok: false, reason: "rejected-argument" });
    }
    expect(fn).not.toHaveBeenCalled();
  });

  it("reports a spawn failure (sync throw or async 'error') without retrying", async () => {
    const throwing = vi.fn(() => {
      throw new Error("ENOENT C:\\secret\\path");
    }) as unknown as SpawnFn;
    expect(await launchProcess({ exe: "x", kind: "exe", folder: "/w", platform: "linux", home: "/h", env: {}, spawnFn: throwing })).toEqual({ ok: false, reason: "spawn-failed" });
    expect(throwing).toHaveBeenCalledTimes(1);

    const asyncFail = vi.fn(() => ({
      unref: vi.fn(),
      once: (event: string, cb: (e?: Error) => void) => {
        if (event === "error") queueMicrotask(() => cb(new Error("EACCES")));
      },
    })) as unknown as SpawnFn;
    expect(await launchProcess({ exe: "x", kind: "exe", folder: "/w", platform: "linux", home: "/h", env: {}, spawnFn: asyncFail })).toEqual({ ok: false, reason: "spawn-failed" });
    expect(asyncFail).toHaveBeenCalledTimes(1);
  });

  it("REAL process: the folder arrives intact as the only argument (process.execPath as the editor)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-launch-"));
    try {
      const out = path.join(dir, "argv.json");
      const script = path.join(dir, "fake-editor.js");
      fs.writeFileSync(script, `require("fs").writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));`);
      // Names legal on the host that still hold shell metacharacters.
      const folderName = process.platform === "win32" ? "my project & co (1);x" : "my project & co; $(x) 'q'";
      const folder = path.join(dir, folderName);
      fs.mkdirSync(folder);
      // The real spawn, wrapped only so the fake editor knows where to write: process.execPath [script, out] is the "program".
      const wrapped: SpawnFn = (command, args, options) => spawn(command, [script, out, ...args], options);
      const result = await launchProcess({ exe: process.execPath, kind: "exe", folder, platform: process.platform === "win32" ? "win32" : "linux", home: dir, env: process.env, spawnFn: wrapped });
      expect(result).toEqual({ ok: true });
      const deadline = Date.now() + 15_000;
      while (!fs.existsSync(out) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 100));
      expect(JSON.parse(fs.readFileSync(out, "utf8"))).toEqual([folder]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("resolveLaunchFolder (FR-622)", () => {
  const base = (over: Partial<Parameters<typeof resolveLaunchFolder>[1]> = {}) => ({
    platform: "win32" as const,
    realpath: async (p: string) => p,
    isDirectory: async () => true,
    ...over,
  });

  it("accepts an absolute real directory", async () => {
    expect(await resolveLaunchFolder("C:\\work\\repo", base())).toBe("C:\\work\\repo");
  });

  it("refuses UNC, \\\\?\\UNC, \\\\.\\, relative and non-directory folders", async () => {
    for (const bad of ["\\\\host\\share\\repo", "\\\\?\\UNC\\host\\share\\repo", "\\\\.\\C:\\x", "//host/share/x", "repo", "-x"]) {
      expect(await resolveLaunchFolder(bad, base())).toBeNull();
    }
    expect(await resolveLaunchFolder("C:\\work\\file.txt", base({ isDirectory: async () => false }))).toBeNull();
  });

  it("refuses a folder whose realpath is a network path", async () => {
    expect(await resolveLaunchFolder("Z:\\mapped", base({ realpath: async () => "\\\\host\\share\\x" }))).toBeNull();
  });

  it("returns null instead of throwing when the folder vanished", async () => {
    const gone = base({
      realpath: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(await resolveLaunchFolder("C:\\gone", gone)).toBeNull();
  });
});

describe("launcher and detection modules stay shell-free (AC4 source grep)", () => {
  const dir = __dirname;
  const sources = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")] as const);

  it("has no exec(, execSync, execFile or shell: true outside comments", () => {
    for (const [name, text] of sources) {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      // `.exec(` is RegExp.exec, not child_process: only a bare call or an import of exec/execFile is wrong.
      expect(code, name).not.toMatch(/(^|[^.\w])exec(File)?\s*\(/);
      expect(code, name).not.toMatch(/import\s*\{[^}]*\bexec(File)?\b[^}]*\}\s*from\s*"(node:)?child_process"/);
      expect(code, name).not.toMatch(/execSync|execFileSync|spawnSync/);
      expect(code, name).not.toMatch(/shell\s*:\s*true/);
    }
  });

  it("has no network access", () => {
    for (const [name, text] of sources) expect(text, name).not.toMatch(/node:https?|node:net|fetch\(|XMLHttpRequest|WebSocket/);
  });
});
