// SPDX-License-Identifier: GPL-3.0-or-later
import * as path from "node:path";
import { EDITORS, type EditorDef } from "./catalog";
import { isRiskyLocation, realpathOf, safe } from "./detectShared";
import type { DetectedProgram, DetectEnv } from "./types";

const posix = path.posix;

async function detect(env: DetectEnv): Promise<DetectedProgram[]> {
  const home = env.homedir ?? env.env.HOME ?? "";
  const haveHome = posix.isAbsolute(home);
  const knownDirs = [
    "/usr/bin",
    "/snap/bin",
    "/var/lib/flatpak/exports/bin",
    ...(haveHome ? [posix.join(home, ".local/share/flatpak/exports/bin"), posix.join(home, ".local/share/JetBrains/Toolbox/scripts")] : []),
  ];
  // Only absolute PATH entries: `.`, empty and relative ones would run whatever sits in the current folder (FR-620).
  const pathDirs = (env.env.PATH ?? "")
    .split(":")
    .filter((d) => d !== "" && d !== "." && posix.isAbsolute(d) && !d.includes("\0"))
    .map((d) => posix.normalize(d));

  const accept = async (candidate: string): Promise<{ resolved: string } | null> => {
    if (!(await safe(() => env.exists(candidate), false))) return null;
    const resolved = (await realpathOf(env, candidate)) || candidate;
    if (await isRiskyLocation(env, resolved, posix)) return null;
    // A symlink in a writable PATH folder pointing at a good target is as swappable as the target itself.
    if (resolved !== candidate && (await isRiskyLocation(env, candidate, posix))) return null;
    return { resolved };
  };

  const out: DetectedProgram[] = [];
  const findFor = async (editor: EditorDef): Promise<void> => {
    const names = editor.linux?.commands ?? [];
    const flatpak = editor.linux?.flatpak ?? [];
    const known = knownDirs.flatMap((d) => [...names, ...flatpak].map((n) => posix.join(d, n)));
    const viaPath = pathDirs.flatMap((d) => names.map((n) => posix.join(d, n)));
    // Known locations first, PATH only as the fallback (FR-620).
    for (const candidate of [...known, ...viaPath]) {
      const ok = await accept(candidate);
      if (!ok) continue;
      out.push({ id: editor.id, name: editor.name, exe: candidate, resolved: ok.resolved, kind: "exe", editorId: editor.id });
      return;
    }
  };
  for (const editor of EDITORS) {
    if (editor.linux) await findFor(editor);
  }
  return out;
}

/** FR-620. Never throws; AppImages are not detected (Add program covers them). */
export async function detectLinux(env: DetectEnv): Promise<DetectedProgram[]> {
  return safe(() => detect(env), []);
}
