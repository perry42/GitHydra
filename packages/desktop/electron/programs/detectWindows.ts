// SPDX-License-Identifier: GPL-3.0-or-later
import * as path from "node:path";
import { EDITORS, type EditorDef } from "./catalog";
import { compareVersions, isRiskyLocation, realpathOf, safe, slugVersion } from "./detectShared";
import type { DetectedProgram, DetectEnv } from "./types";

const win = path.win32;
const UNINSTALL = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
const HIVES = [
  { key: `HKLM\\${UNINSTALL}`, hkcu: false },
  { key: `HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall`, hkcu: false },
  // Writable by any process of the current user, so its install dirs are constrained below (FR-618).
  { key: `HKCU\\${UNINSTALL}`, hkcu: true },
];
const DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const MAX_KEEP_PER_VERSIONED_EDITOR = 2;

interface RegEntry {
  name: string;
  publisher: string;
  location: string;
  version: string;
}

/** `reg query <key> /s` output: key lines start with HKEY_, value lines are `    Name    REG_SZ    data`. Tolerates junk. */
export function parseRegQuery(text: string): RegEntry[] {
  const entries: RegEntry[] = [];
  let cur: Record<string, string> | null = null;
  const flush = () => {
    if (cur?.DisplayName && cur.InstallLocation) {
      entries.push({ name: cur.DisplayName, publisher: cur.Publisher ?? "", location: cur.InstallLocation, version: cur.DisplayVersion ?? "" });
    }
  };
  for (const line of text.split(/\r?\n/)) {
    if (/^HKEY_/i.test(line)) {
      flush();
      cur = {};
      continue;
    }
    if (!cur) continue;
    const m = /^\s+(\S.*?)\s{2,}REG_\w+(?:\s{2,}(.*))?$/.exec(line);
    if (m && m[1] !== undefined) cur[m[1]] = (m[2] ?? "").trim();
  }
  flush();
  return entries;
}

function matchEditor(displayName: string, publisher: string): EditorDef | null {
  const name = displayName.toLowerCase();
  const pub = publisher.toLowerCase();
  let best: EditorDef | null = null;
  let bestLen = 0;
  for (const e of EDITORS) {
    if (!e.win) continue;
    if (!e.win.publishers.some((p) => pub.startsWith(p.toLowerCase()))) continue;
    for (const n of e.win.names) {
      // The longest prefix wins so "Visual Studio Code Insiders" is never taken for plain "Visual Studio Code".
      if (name.startsWith(n.toLowerCase()) && n.length > bestLen) {
        best = e;
        bestLen = n.length;
      }
    }
  }
  return best;
}

/** `C:\x\y\` -> `C:\x\y`; null when it is not a plain drive-absolute path (UNC, relative, quoted junk). */
function cleanLocation(raw: string): string | null {
  const trimmed = raw.trim().replace(/^"(.*)"$/, "$1");
  if (trimmed.includes("\0") || !DRIVE_ABSOLUTE.test(trimmed)) return null;
  return win.normalize(trimmed).replace(/[\\/]+$/, "");
}

function validRoot(value: string | undefined): string | null {
  return value && DRIVE_ABSOLUTE.test(value) ? win.normalize(value).replace(/[\\/]+$/, "") : null;
}

const within = (child: string, root: string): boolean => {
  const c = child.toLowerCase();
  const r = root.toLowerCase();
  return c === r || c.startsWith(`${r}\\`);
};

interface Candidate {
  editor: EditorDef;
  exe: string;
  resolved: string;
  version: string;
}

function versionOf(entry: RegEntry): string {
  const m = /(\d{4}\.\d+(?:\.\d+)*)/.exec(entry.name);
  return m?.[1] ?? entry.version;
}

async function detect(env: DetectEnv): Promise<DetectedProgram[]> {
  const e = env.env;
  const systemRoot = validRoot(e.SystemRoot ?? e.SYSTEMROOT);
  if (!systemRoot) return [];
  // Absolute, so a planted reg.exe in the cwd or on PATH can never win (FR-618).
  const reg = win.join(systemRoot, "System32", "reg.exe");
  const localAppData = validRoot(e.LOCALAPPDATA);
  const toolboxDir = localAppData ? win.join(localAppData, "JetBrains", "Toolbox") : null;
  const hkcuRoots = [
    localAppData ? win.join(localAppData, "Programs") : null,
    validRoot(e.ProgramFiles),
    validRoot(e.ProgramW6432),
    validRoot(e["ProgramFiles(x86)"]),
    toolboxDir,
  ].filter((r): r is string => r !== null);

  const candidates: Candidate[] = [];
  const consider = async (editor: EditorDef, base: string, rels: string[], version: string): Promise<void> => {
    for (const rel of rels) {
      const exe = win.join(base, rel);
      if (!exe.toLowerCase().endsWith(".exe")) continue;
      if (!(await safe(() => env.exists(exe), false))) continue;
      const resolved = (await realpathOf(env, exe)) || exe;
      if (await isRiskyLocation(env, resolved, win)) continue;
      candidates.push({ editor, exe, resolved, version });
      return;
    }
  };

  for (const hive of HIVES) {
    const out = await safe(() => env.runCommand(reg, ["query", hive.key, "/s"]), "");
    for (const entry of parseRegQuery(String(out))) {
      const editor = matchEditor(entry.name, entry.publisher);
      if (!editor?.win) continue;
      const location = cleanLocation(entry.location);
      if (!location) continue;
      if (hive.hkcu && !hkcuRoots.some((r) => within(location, r))) continue;
      await consider(editor, location, editor.win.exes, versionOf(entry));
    }
  }

  // JetBrains Toolbox keeps IDEs under apps\<product>\ch-N\<build>\bin; read-only directory listing, nothing is run.
  if (toolboxDir && env.readdir) {
    const apps = win.join(toolboxDir, "apps");
    for (const editor of EDITORS) {
      const tb = editor.win?.toolbox;
      if (!tb) continue;
      for (const dir of tb.dirs) {
        const channels = (await safe(() => env.readdir!(win.join(apps, dir)), [])).filter((c) => /^ch-/i.test(c));
        const builds: { build: string; base: string }[] = [];
        for (const ch of channels) {
          for (const build of await safe(() => env.readdir!(win.join(apps, dir, ch)), [])) {
            if (/^\d+(\.\d+)+$/.test(build)) builds.push({ build, base: win.join(apps, dir, ch, build) });
          }
        }
        builds.sort((a, b) => compareVersions(b.build, a.build));
        for (const b of builds.slice(0, MAX_KEEP_PER_VERSIONED_EDITOR)) await consider(editor, b.base, [tb.exe], "");
      }
    }
  }

  return shape(candidates);
}

function shape(candidates: Candidate[]): DetectedProgram[] {
  const out: DetectedProgram[] = [];
  const seenPath = new Set<string>();
  const perEditor = new Map<string, number>();
  const usedIds = new Set<string>();
  const sorted = [...candidates].sort((a, b) => (a.editor.id === b.editor.id && a.version && b.version ? compareVersions(b.version, a.version) : 0));
  for (const c of sorted) {
    const key = c.resolved.toLowerCase();
    if (seenPath.has(key)) continue;
    const count = perEditor.get(c.editor.id) ?? 0;
    if (count >= (c.editor.versioned ? MAX_KEEP_PER_VERSIONED_EDITOR : 1)) continue;
    seenPath.add(key);
    perEditor.set(c.editor.id, count + 1);
    let id = c.editor.versioned && c.version ? `${c.editor.id}-${slugVersion(c.version)}` : c.editor.id;
    for (let n = 2; usedIds.has(id); n++) id = `${c.editor.id}-${n}`;
    usedIds.add(id);
    out.push({
      id,
      name: c.editor.versioned && c.version ? `${c.editor.name} ${c.version}` : c.editor.name,
      exe: c.exe,
      resolved: c.resolved,
      kind: "exe",
      editorId: c.editor.id,
    });
  }
  return out;
}

/** FR-618. Never throws; a rejecting `runCommand` and an empty registry both give []. */
export async function detectWindows(env: DetectEnv): Promise<DetectedProgram[]> {
  return safe(() => detect(env), []);
}
