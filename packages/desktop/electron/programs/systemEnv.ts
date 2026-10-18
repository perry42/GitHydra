// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scrubEnv } from "./launcher";
import type { RuleEnv } from "./exeRules";
import type { Platform } from "./types";

const RUN_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * `reg.exe` / `mdfind` with an argv array and the same scrubbed env as launches (FR-618). Output is capped (a truncated
 * tail is tolerated by the parsers) and decoded leniently; a failure or timeout is an empty string, never a throw.
 */
export function runCommand(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, [...args], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"], env: scrubEnv(process.env) });
    } catch {
      resolve("");
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => child.kill(), RUN_TIMEOUT_MS);
    child.stdout?.on("data", (c: Buffer) => {
      if (size < MAX_OUTPUT_BYTES) {
        chunks.push(c);
        size += c.length;
      }
    });
    const done = (): void => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    child.once("error", done);
    child.once("close", done);
  });
}

/** Walks up from `p` looking for a `.git` entry; the home folder itself is not treated as a repository. */
export async function hasGitAncestor(p: string, home: string, flavour: typeof path.posix | typeof path.win32): Promise<boolean> {
  let cur = flavour.dirname(p);
  const homeKey = home ? flavour.resolve(home).toLowerCase() : null;
  for (let i = 0; i < 64; i++) {
    if (!(homeKey && flavour.resolve(cur).toLowerCase() === homeKey)) {
      try {
        await fs.lstat(flavour.join(cur, ".git"));
        return true;
      } catch {
        // not here
      }
    }
    const up = flavour.dirname(cur);
    if (up === cur) return false;
    cur = up;
  }
  return false;
}

export async function isWorldWritableDir(dir: string): Promise<boolean> {
  try {
    const st = await fs.stat(dir);
    return st.isDirectory() && (st.mode & 0o002) !== 0;
  } catch {
    return false;
  }
}

export function createSystemEnv(overrides: { platform?: Platform; env?: Record<string, string | undefined>; homedir?: string } = {}): RuleEnv {
  const platform = overrides.platform ?? (process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux");
  const home = overrides.homedir ?? os.homedir();
  const flavour = platform === "win32" ? path.win32 : path.posix;
  return {
    platform,
    env: overrides.env ?? process.env,
    homedir: home,
    runCommand,
    async exists(p) {
      try {
        const st = await fs.stat(p);
        if (!st.isFile()) return false;
        if (platform !== "win32") await fs.access(p, 1);
        return true;
      } catch {
        return false;
      }
    },
    async isDirectory(p) {
      try {
        return (await fs.stat(p)).isDirectory();
      } catch {
        return false;
      }
    },
    async isExecutable(p) {
      try {
        await fs.access(p, 1);
        return true;
      } catch {
        return false;
      }
    },
    realpath: (p) => fs.realpath(p),
    readdir: (d) => fs.readdir(d),
    hasGitAncestor: (p) => hasGitAncestor(p, home, flavour),
    // Windows ACLs are not mode bits; the HKCU/location rules cover it there.
    isWorldWritableDir: platform === "win32" ? async () => false : isWorldWritableDir,
    async fingerprint(p) {
      try {
        const st = await fs.stat(p);
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(p)) hash.update(chunk as Buffer);
        return { size: st.size, mtimeMs: st.mtimeMs, sha256: hash.digest("hex") };
      } catch {
        return null;
      }
    },
    async readHead(p, bytes) {
      const handle = await fs.open(p, "r");
      try {
        const buf = Buffer.alloc(bytes);
        const { bytesRead } = await handle.read(buf, 0, bytes, 0);
        return buf.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    },
  };
}
