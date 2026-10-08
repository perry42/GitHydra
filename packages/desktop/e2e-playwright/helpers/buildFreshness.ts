// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Real-Electron specs run the built `dist`/`dist-electron`, so editing or switching branches without
 * `npm run build` silently tests OLD code (CLAUDE.md pitfall). Refuse to launch on a stale build.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const SOURCE_EXT = /\.(tsx?|js|css|html|json|mts)$/;
const SKIP_DIR = new Set(["node_modules", "dist", "dist-electron", "e2e-playwright", ".tmp-test-repos", "coverage"]);
const isTestFile = (name: string) => /\.(test|spec)\.[tj]sx?$/.test(name);

function newestSource(dir: string, best: { file: string; ms: number }): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIR.has(e.name) && e.name !== "test" && e.name !== "tests") newestSource(full, best);
    } else if (SOURCE_EXT.test(e.name) && !isTestFile(e.name)) {
      const ms = fs.statSync(full).mtimeMs;
      if (ms > best.ms) {
        best.ms = ms;
        best.file = full;
      }
    }
  }
}

let checked = false;

/** Throws if any non-test source under desktop or git-core is newer than the build outputs. */
export function assertBuildIsFresh(desktopRoot: string): void {
  if (checked || process.env.GITHYDRA_SKIP_BUILD_CHECK === "1") return;
  checked = true;
  const gitCoreRoot = path.resolve(desktopRoot, "..", "git-core");
  const outputs = [
    path.join(desktopRoot, "dist-electron", "main.js"),
    path.join(desktopRoot, "dist", "index.html"),
    path.join(gitCoreRoot, "dist", "index.js"),
  ];
  let oldestOut = Infinity;
  for (const o of outputs) {
    if (!fs.existsSync(o)) {
      throw new Error(`Build output missing: ${o}. Run \`npm run build\` from the repo root before real-Electron tests.`);
    }
    oldestOut = Math.min(oldestOut, fs.statSync(o).mtimeMs);
  }
  const best = { file: "", ms: 0 };
  for (const root of [desktopRoot, gitCoreRoot]) {
    for (const sub of ["src", "electron", "shared"]) newestSource(path.join(root, sub), best);
  }
  // 5 s tolerance: some build steps touch outputs slightly before the last source read.
  if (best.ms > oldestOut + 5000) {
    const age = Math.round((best.ms - oldestOut) / 1000);
    throw new Error(
      `Stale build: ${path.relative(desktopRoot, best.file)} changed ${age}s after the last build. ` +
        "Run `npm run build` from the repo root, then re-run (set GITHYDRA_SKIP_BUILD_CHECK=1 to bypass).",
    );
  }
}
