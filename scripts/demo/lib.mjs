// SPDX-License-Identifier: GPL-3.0-or-later
// Shared helpers for the dev-only manual testing kit (docs/manual-testing/README.md). Never packaged or imported by app code.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const desktopRoot = path.join(repoRoot, "packages", "desktop");
export const MARKER = "githydra-demo"; // file inside the git dir: `tick` only touches repos carrying it

const scaleEnv = Number(process.env.GITHYDRA_DEMO_SCALE);
/** GITHYDRA_DEMO_SCALE (default 1) shrinks the big scenarios (history/file counts) so unit tests stay fast. */
export const SCALE = Number.isFinite(scaleEnv) && scaleEnv > 0 ? scaleEnv : 1;
export const scaled = (n, min = 10) => Math.max(min, Math.round(n * SCALE));

export const lines = (n, prefix = "line") => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`).join("\n") + "\n";

/** Replaces 1-based line `n` of `text`, keeping the line ending style. */
export function setLine(text, n, replacement) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const parts = text.split(eol);
  parts[n - 1] = replacement;
  return parts.join(eol);
}

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", GIT_MERGE_AUTOEDIT: "no", GIT_OPTIONAL_LOCKS: "0" };
delete GIT_ENV.ELECTRON_RUN_AS_NODE;

export function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 512 * 1024 * 1024, windowsHide: true }).toString();
}
/** Like git() but never throws; conflicts make merge/rebase/cherry-pick exit non-zero by design. */
export function tryGit(cwd, ...args) {
  try {
    return { ok: true, out: git(cwd, ...args) };
  } catch (e) {
    return { ok: false, out: String(e.stdout ?? "") + String(e.stderr ?? "") };
  }
}

/** Repo handle: tiny wrapper so scenarios read as a script. */
export function makeRepo(dir, { branch = "main" } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const r = {
    dir,
    git: (...a) => git(dir, ...a),
    tryGit: (...a) => tryGit(dir, ...a),
    write(file, content) {
      const full = path.join(dir, file);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    },
    read: (file) => fs.readFileSync(path.join(dir, file)),
    remove: (file) => fs.rmSync(path.join(dir, file), { force: true, recursive: true }),
    /** Writes (string|Buffer) or deletes (null) every entry. */
    apply(files) {
      for (const [f, c] of Object.entries(files)) (c === null ? r.remove(f) : r.write(f, c));
    },
    commit(msg, files) {
      if (files) r.apply(files);
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "--allow-empty", "-m", msg);
    },
  };
  git(dir, "init", "-q", "-b", branch);
  for (const [k, v] of [["user.name", "Demo User"], ["user.email", "demo@example.com"], ["core.autocrlf", "false"], ["core.safecrlf", "false"],
    ["commit.gpgsign", "false"], ["gc.auto", "0"], ["merge.conflictStyle", "merge"], ["core.longpaths", "true"]]) git(dir, "config", k, v);
  fs.writeFileSync(path.join(gitDirOf(dir), MARKER), "githydra manual-testing repo\n");
  return r;
}

/**
 * base commit on main, `feature` branch with the "theirs" edits, then main gets the "ours" edits; leaves HEAD on main.
 * Each argument maps path -> string|Buffer (write) or null (delete).
 */
export function twoSided(r, { base, ours, theirs, theirsBranch = "feature" }) {
  r.commit("base", base);
  r.git("checkout", "-q", "-b", theirsBranch);
  r.commit(`${theirsBranch}: change`, theirs);
  r.git("checkout", "-q", "main");
  r.commit("main: change", ours);
}

/** Builds a linear/merge history with `git fast-import` (thousands of commits in about a second). */
export function fastImportHistory(r, commits) {
  const chunks = [];
  const push = (s) => chunks.push(Buffer.isBuffer(s) ? s : Buffer.from(s));
  let t = 1700000000;
  for (const c of commits) {
    const msg = Buffer.from(c.msg);
    push(`commit ${c.ref}\nmark :${c.mark}\ncommitter Demo User <demo@example.com> ${t} +0000\ndata ${msg.length}\n`);
    push(msg);
    push("\n");
    t += 3600;
    if (c.from) push(`from :${c.from}\n`);
    for (const m of c.merge ?? []) push(`merge :${m}\n`);
    for (const [file, content] of Object.entries(c.files ?? {})) {
      const body = Buffer.from(content);
      push(`M 100644 inline ${file}\ndata ${body.length}\n`);
      push(body);
      push("\n");
    }
    push("\n");
  }
  execFileSync("git", ["fast-import", "--quiet"], { cwd: r.dir, env: GIT_ENV, input: Buffer.concat(chunks), maxBuffer: 512 * 1024 * 1024 });
}

export function gitDirOf(dir) {
  return path.resolve(dir, git(dir, "rev-parse", "--git-dir").trim());
}
const commonDirOf = (dir) => path.resolve(dir, git(dir, "rev-parse", "--git-common-dir").trim());

/** Snapshot of the git state scenarios claim in their descriptions; compared with each scenario's `expect`. Only `keys` are computed (each costs a git spawn). */
export function inspect(dir, keys) {
  const memo = {};
  const once = (k, f) => (k in memo ? memo[k] : (memo[k] = f()));
  const gd = () => once("gd", () => gitDirOf(dir));
  const has = (p) => fs.existsSync(path.join(gd(), p));
  const head = () => once("head", () => tryGit(dir, "rev-parse", "--verify", "-q", "HEAD"));
  const lineCount = (...a) => { const r = tryGit(dir, ...a); return r.ok ? r.out.split(/\r?\n/).filter(Boolean).length : 0; };
  const count = (...a) => { const r = tryGit(dir, ...a); return r.ok ? Number(r.out.trim()) : 0; };
  const UNMERGED = new Set(["UU", "AA", "DD", "AU", "UA", "DU", "UD"]);
  const status = () => once("status", () => {
    const entries = git(dir, "status", "--porcelain=v1", "-z", "--untracked-files=all").split("\0").filter(Boolean);
    const t = { unmerged: 0, staged: 0, unstaged: 0, untracked: 0, changed: entries.length };
    for (const e of entries) {
      const xy = e.slice(0, 2);
      if (xy === "??") t.untracked++;
      else if (UNMERGED.has(xy)) t.unmerged++;
      else {
        if (xy[0] !== " ") t.staged++;
        if (xy[1] !== " ") t.unstaged++;
      }
    }
    return t;
  });
  const probes = {
    operation: () => (has("rebase-merge") || has("rebase-apply") ? "rebase" : has("MERGE_HEAD") ? "merge" : has("CHERRY_PICK_HEAD") ? "cherry-pick" : has("REVERT_HEAD") ? "revert" : "none"),
    empty: () => !head().ok,
    detached: () => head().ok && !tryGit(dir, "symbolic-ref", "-q", "HEAD").ok,
    commits: () => count("rev-list", "--all", "--count"),
    merges: () => count("rev-list", "--all", "--merges", "--count"),
    branches: () => lineCount("for-each-ref", "refs/heads"),
    tags: () => lineCount("for-each-ref", "refs/tags"),
    stashes: () => lineCount("stash", "list"),
    worktrees: () => lineCount("worktree", "list"),
    submodules: () => lineCount("submodule", "status"),
    unmerged: () => status().unmerged, staged: () => status().staged, unstaged: () => status().unstaged,
    untracked: () => status().untracked, changed: () => status().changed,
    conflictStyle: () => tryGit(dir, "config", "merge.conflictStyle").out.trim(),
  };
  return Object.fromEntries((keys ?? Object.keys(probes)).map((k) => [k, probes[k]()]));
}

// ---- safety: demo repos live under the OS temp dir only, never in GitHydra's own checkout ----
const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
const norm = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
const inside = (child, parent) => { const rel = path.relative(norm(parent), norm(child)); return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)); };

/** Throws unless `p` is under the OS temp dir and outside this checkout. Resolves through the nearest existing ancestor. */
export function assertSafeDir(p) {
  let probe = path.resolve(p);
  const tail = [];
  while (!fs.existsSync(probe)) { tail.unshift(path.basename(probe)); const up = path.dirname(probe); if (up === probe) break; probe = up; }
  const full = path.join(real(probe), ...tail);
  if (!inside(full, real(os.tmpdir()))) throw new Error(`Refusing ${full}: demo repos must live under the OS temp dir (${os.tmpdir()}).`);
  if (inside(full, real(repoRoot)) || inside(real(repoRoot), full)) throw new Error(`Refusing ${full}: overlaps the GitHydra checkout.`);
  return full;
}

export function isDemoRepo(dir) {
  try { return fs.existsSync(path.join(gitDirOf(dir), MARKER)) || fs.existsSync(path.join(commonDirOf(dir), MARKER)); } catch { return false; }
}

// ---- build freshness (idea from packages/desktop/e2e-playwright/helpers/buildFreshness.ts) ----
const SOURCE_EXT = /\.(tsx?|js|css|html|json|mts)$/;
const SKIP_DIR = new Set(["node_modules", "dist", "dist-electron", "e2e-playwright", ".tmp-test-repos", "coverage", "test", "tests"]);
function newestSource(dir, best) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) newestSource(full, best); }
    else if (SOURCE_EXT.test(e.name) && !/\.(test|spec)\.[tj]sx?$/.test(e.name)) {
      const ms = fs.statSync(full).mtimeMs;
      if (ms > best.ms) { best.ms = ms; best.file = full; }
    }
  }
}
/** Returns null when the build is usable, else the message to show. */
export function buildProblem() {
  if (process.env.GITHYDRA_SKIP_BUILD_CHECK === "1") return null;
  const gitCore = path.join(repoRoot, "packages", "git-core");
  const outs = [path.join(desktopRoot, "dist-electron", "main.js"), path.join(desktopRoot, "dist", "index.html"), path.join(gitCore, "dist", "index.js")];
  let oldest = Infinity;
  for (const o of outs) {
    if (!fs.existsSync(o)) return `Build output missing: ${o}\nRun this from the repo root, then retry:\n  npm run build`;
    oldest = Math.min(oldest, fs.statSync(o).mtimeMs);
  }
  const best = { file: "", ms: 0 };
  for (const root of [desktopRoot, gitCore]) for (const sub of ["src", "electron", "shared"]) newestSource(path.join(root, sub), best);
  if (best.ms > oldest + 5000) return `Stale build: ${path.relative(repoRoot, best.file)} changed ${Math.round((best.ms - oldest) / 1000)}s after the last build.\nRun this from the repo root, then retry:\n  npm run build\n(GITHYDRA_SKIP_BUILD_CHECK=1 bypasses this check.)`;
  return null;
}
