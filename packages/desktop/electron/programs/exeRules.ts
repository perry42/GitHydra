// SPDX-License-Identifier: GPL-3.0-or-later
import * as path from "node:path";
import type { ExeProblem } from "../../shared/programsContract";
import { locationRisk } from "./detectShared";
import type { DetectEnv, Platform } from "./types";

/**
 * specs/external-programs.md FR-622/FR-642: what a program path must satisfy, at save time AND again at every launch. The string
 * checks are platform independent on purpose (a `.cmd` is refused on any OS); the file checks use the injected seams.
 */
export interface RuleEnv extends DetectEnv {
  isDirectory(path: string): Promise<boolean>;
  isExecutable?(path: string): Promise<boolean>;
  realpath(path: string): Promise<string>;
  readHead?(path: string, bytes: number): Promise<Uint8Array>;
}

/** They would read the folder argument as command text (FR-642). */
const INTERPRETERS = new Set(["cmd", "powershell", "powershell_ise", "pwsh", "wscript", "cscript", "mshta", "rundll32", "regsvr32", "bash", "sh", "zsh", "dash", "ksh", "fish", "csh", "tcsh"]);
/** Node cannot spawn .cmd/.bat without a shell (CVE-2024-27980) and a shell reopens injection through & % ^ in a folder name. */
const SCRIPT_EXTENSIONS = [".cmd", ".bat", ".ps1", ".lnk", ".vbs", ".vbe", ".wsf", ".com"];

export const PROBLEM_TEXT: Record<ExeProblem, string> = {
  relative: "That path is not absolute. Choose the program file from the file picker.",
  unc: "Programs on network paths (\\\\server\\share) are not supported.",
  missing: "That file does not exist.",
  directory: "That is a folder, not a program.",
  "not-executable": "That file is not marked as executable.",
  interpreter: "That is a command interpreter. It would treat the folder name as a command, so it cannot be used here.",
  "script-extension": "Script files (.cmd, .bat, .ps1, .lnk, .vbs) cannot be used. Choose the program's own .exe.",
  "not-windows-exe": "That file is not a Windows program (.exe).",
};

export function leafName(p: string): string {
  return p.split(/[\\/]/).pop() ?? "";
}

/** Pure string checks, identical on every OS. Returns null when nothing is wrong yet. */
export function stringProblem(p: string, platform: Platform): ExeProblem | null {
  if (typeof p !== "string" || p === "" || p.includes("\0")) return "relative";
  if (/^(\\\\|\/\/)/.test(p)) return "unc";
  const absolute = platform === "win32" ? /^[A-Za-z]:[\\/]/.test(p) : path.posix.isAbsolute(p);
  if (!absolute) return "relative";
  const leaf = leafName(p).toLowerCase();
  if (SCRIPT_EXTENSIONS.some((ext) => leaf.endsWith(ext))) return "script-extension";
  const stem = leaf.replace(/\.[^.]*$/, "");
  if (INTERPRETERS.has(leaf) || INTERPRETERS.has(stem)) return "interpreter";
  return null;
}

export type ProgramPathCheck =
  | { ok: true; resolved: string; kind: "exe" | "app"; risk: "repository" | "world-writable" | null }
  | { ok: false; problem: ExeProblem };

export async function checkProgramPath(p: string, env: RuleEnv): Promise<ProgramPathCheck> {
  const bad = stringProblem(p, env.platform);
  if (bad) return { ok: false, problem: bad };
  const flavour = env.platform === "win32" ? path.win32 : path.posix;
  const isApp = env.platform === "darwin" && p.toLowerCase().endsWith(".app");
  try {
    if (isApp) {
      if (!(await env.isDirectory(p))) return { ok: false, problem: (await env.exists(p)) ? "not-executable" : "missing" };
    } else {
      if (await env.isDirectory(p)) return { ok: false, problem: "directory" };
      if (!(await env.exists(p))) return { ok: false, problem: "missing" };
      if (env.platform === "win32") {
        if (!p.toLowerCase().endsWith(".exe")) return { ok: false, problem: "not-windows-exe" };
        const head = env.readHead ? await env.readHead(p, 2) : null;
        if (!head || head[0] !== 0x4d || head[1] !== 0x5a) return { ok: false, problem: "not-windows-exe" };
      } else if (env.isExecutable && !(await env.isExecutable(p))) {
        return { ok: false, problem: "not-executable" };
      }
    }
    const resolved = await env.realpath(p);
    // The realpath is re-checked: a symlink may lead to a script or an interpreter.
    const again = stringProblem(resolved, env.platform);
    if (again) return { ok: false, problem: again };
    return { ok: true, resolved, kind: isApp ? "app" : "exe", risk: await locationRisk(env, resolved, flavour) };
  } catch {
    return { ok: false, problem: "missing" };
  }
}
