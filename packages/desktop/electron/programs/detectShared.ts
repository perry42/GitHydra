// SPDX-License-Identifier: GPL-3.0-or-later
import * as path from "node:path";
import type { DetectEnv } from "./types";

/** Never throws: any failure of a seam is "nothing found". */
export async function safe<T>(work: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await work();
  } catch {
    return fallback;
  }
}

export const realpathOf = (env: DetectEnv, p: string): Promise<string> => safe(async () => (env.realpath ? await env.realpath(p) : p), "");

export function ancestors(p: string, flavour: typeof path.posix | typeof path.win32): string[] {
  const out: string[] = [];
  let cur = flavour.dirname(p);
  for (let i = 0; i < 64; i++) {
    out.push(cur);
    const up = flavour.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return out;
}

/**
 * FR-620/FR-642: a hit inside a repository, a worktree or a world-writable folder is not trusted. The real `hasGitAncestor`
 * never takes the user's home folder itself as a repository (a dotfiles `~/.git` would disqualify every tool under it).
 */
export async function locationRisk(
  env: DetectEnv,
  p: string,
  flavour: typeof path.posix | typeof path.win32,
): Promise<"repository" | "world-writable" | null> {
  // A seam that throws counts as risky: unknown is never trusted.
  if (env.hasGitAncestor && (await safe(() => env.hasGitAncestor!(p), true))) return "repository";
  if (env.isWorldWritableDir) {
    for (const dir of ancestors(p, flavour)) {
      if (await safe(() => env.isWorldWritableDir!(dir), true)) return "world-writable";
    }
  }
  return null;
}

export async function isRiskyLocation(env: DetectEnv, p: string, flavour: typeof path.posix | typeof path.win32): Promise<boolean> {
  return (await locationRisk(env, p, flavour)) !== null;
}

/** "2024.1.2" style versions compare numerically, part by part. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[^0-9]+/).filter(Boolean).map(Number);
  const pb = b.split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function slugVersion(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "");
}
