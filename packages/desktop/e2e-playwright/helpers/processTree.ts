// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Test-only process-tree utilities for e2e teardown. Never imported by production code.
 */
import { execFileSync, spawnSync } from "node:child_process";

export interface ProcInfo {
  pid: number;
  ppid: number;
  cmd: string;
}

/** Playwright's Electron launcher injects this loader into every app it starts; a user's normal launch never has it. */
export const PLAYWRIGHT_LOADER_MARKER = "playwright-core";
export const PW_LOADER_PATH_PART = /electron[\/]loader\.js/;
/** specs name their temp profiles githydra-pw-userdata-* or githydra-pw-recovery-*. */
export const PW_USERDATA_MARKER = "githydra-pw-";

export function listProcesses(): ProcInfo[] {
  try {
    if (process.platform === "win32") {
      const ps =
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress";
      const psExe = `${process.env.SystemRoot ?? "C:/Windows"}/System32/WindowsPowerShell/v1.0/powershell.exe`;
      const out = execFileSync(psExe, ["-NoProfile", "-NonInteractive", "-Command", ps], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        timeout: 30_000,
      });
      const rows = JSON.parse(out || "[]") as Array<{ ProcessId: number; ParentProcessId: number; CommandLine: string | null }>;
      return (Array.isArray(rows) ? rows : [rows]).map((r) => ({ pid: r.ProcessId, ppid: r.ParentProcessId, cmd: r.CommandLine ?? "" }));
    }
    const out = execFileSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return out
      .split("\n")
      .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3]! }));
  } catch {
    return [];
  }
}

/** Kills `pid` and all its descendants. A force kill is intended: a dirty window vetoes polite closes (electron/closeGuard.ts). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function killTree(pid: number): void {
  if (!pid || !isAlive(pid)) return;
  if (process.platform === "win32") {
    // Bounded: taskkill /T walks the whole process table and is slow on a loaded machine; fall back to a plain kill.
    const r = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 20_000 });
    if (r.error && isAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    return;
  }
  const procs = listProcesses();
  const kids = (p: number): number[] => procs.filter((x) => x.ppid === p).flatMap((x) => [...kids(x.pid), x.pid]);
  for (const p of [...kids(pid), pid]) {
    try {
      process.kill(p, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/** Playwright-launched GitHydra roots (not their Chromium helper children) from the process list. */
export function playwrightGitHydraRoots(procs: ProcInfo[]): ProcInfo[] {
  const isMatch = (p: ProcInfo) => p.cmd.includes(PW_USERDATA_MARKER) && PW_LOADER_PATH_PART.test(p.cmd) && p.cmd.includes(PLAYWRIGHT_LOADER_MARKER);
  const matches = procs.filter(isMatch);
  const ids = new Set(matches.map((m) => m.pid));
  return matches.filter((m) => !ids.has(m.ppid));
}

/** True when `pid` has `ancestor` somewhere up its parent chain. */
export function isDescendantOf(pid: number, ancestor: number, procs: ProcInfo[]): boolean {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  for (let cur = byPid.get(pid), hops = 0; cur && hops < 64; cur = byPid.get(cur.ppid), hops++) {
    if (cur.ppid === ancestor) return true;
  }
  return false;
}

/**
 * Kills leftover Playwright-launched GitHydra apps that belong to this run (descend from `runPid`) or are orphans (parent gone).
 * A concurrent run's apps (parent alive, elsewhere) and a user's normally launched GitHydra (no loader flag) are left alone.
 */
export function killLeakedApps(runPid: number): number[] {
  const procs = listProcesses();
  const alive = new Set(procs.map((p) => p.pid));
  const killed: number[] = [];
  for (const root of playwrightGitHydraRoots(procs)) {
    if (!alive.has(root.ppid) || isDescendantOf(root.pid, runPid, procs)) {
      killTree(root.pid);
      killed.push(root.pid);
    }
  }
  return killed;
}
