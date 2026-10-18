// SPDX-License-Identifier: GPL-3.0-or-later
import * as path from "node:path";
import { EDITORS } from "./catalog";
import { isRiskyLocation, realpathOf, safe, slugVersion } from "./detectShared";
import type { DetectedProgram, DetectEnv } from "./types";

const posix = path.posix;
export const MDFIND = "/usr/bin/mdfind";
const MAX_PER_BUNDLE = 2;

async function detect(env: DetectEnv): Promise<DetectedProgram[]> {
  const home = env.homedir ?? env.env.HOME ?? "";
  // Spotlight also indexes folders a repository ships, so only the system application folders are accepted (FR-619).
  const roots = ["/Applications", "/System/Applications", ...(posix.isAbsolute(home) ? [posix.join(home, "Applications")] : [])];
  const realRoots: string[] = [];
  for (const r of roots) realRoots.push((await realpathOf(env, r)) || r);

  const out: DetectedProgram[] = [];
  const seen = new Set<string>();
  for (const editor of EDITORS) {
    for (const bundleId of editor.mac?.bundleIds ?? []) {
      // Bundle ids come from the built-in list only, never from a repository or the renderer.
      const raw = await safe(() => env.runCommand(MDFIND, [`kMDItemCFBundleIdentifier == '${bundleId}'`]), "");
      let kept = 0;
      for (const line of String(raw).split(/\r?\n/)) {
        const hit = line.trim();
        if (!hit || !posix.isAbsolute(hit) || hit.includes("\0") || kept >= MAX_PER_BUNDLE) continue;
        const real = await realpathOf(env, hit);
        if (!real || !real.endsWith(".app") || seen.has(real)) continue;
        if (!realRoots.some((r) => real.startsWith(`${r}/`))) continue;
        const isDir = env.isDirectory ? await safe(() => env.isDirectory!(real), false) : await safe(() => env.exists(real), false);
        if (!isDir) continue;
        if (await isRiskyLocation(env, real, posix)) continue;
        seen.add(real);
        kept++;
        const base = posix.basename(real, ".app");
        const idSuffix = out.some((p) => p.editorId === editor.id) ? `-${slugVersion(base) || "2"}` : "";
        out.push({ id: `${editor.id}${idSuffix}`, name: idSuffix ? base : editor.name, exe: real, resolved: real, kind: "app", editorId: editor.id });
      }
    }
  }
  return out;
}

/** FR-619. Never throws. Launching is `/usr/bin/open -a <that .app>`; nothing is run here except `mdfind`. */
export async function detectMac(env: DetectEnv): Promise<DetectedProgram[]> {
  return safe(() => detect(env), []);
}
