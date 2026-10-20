// SPDX-License-Identifier: GPL-3.0-or-later
// `npm run check:linux [-- <spec name>...]`: run the real-Electron specs worth checking before a push,
// in a Linux Docker container (xvfb 1920x1080x24, one worker) and natively here. See ROADMAP.md "CI and test tooling".
// Flags: --list (print the selection, run nothing), --linux-only, --native-only, --all (every spec).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktop = path.join(root, "packages", "desktop");
const specRoot = path.join(desktop, "e2e-playwright");

// Same set CI runs on every push (.github/workflows/ci.yml, job `smoke`).
const SMOKE = ["rendererBootsSmoke", "worktrees.spec", "worktreeCopyIgnored.spec", "copyIntoExisting.spec", "refChipDragMerge.spec"];
// Window size CI uses; the specs depend on layout width (ROADMAP "Real-app specs sensitive to the window size").
const WINDOW = process.env.GITHYDRA_E2E_WINDOW ?? "1400x900";

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const manual = argv.filter((a) => !a.startsWith("--"));

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: root, encoding: "utf8", shell: false, ...opts });
}

function git(...args) {
  const r = run("git", args);
  return r.status === 0 ? r.stdout.trim() : "";
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".spec.ts")) out.push(p);
  }
  return out;
}

const allSpecs = walk(path.join(specRoot, "electron")).map((p) => path.relative(desktop, p).split(path.sep).join("/"));

function changedFiles() {
  const base = git("merge-base", "HEAD", "origin/dev") || git("merge-base", "HEAD", "dev");
  const committed = base ? git("diff", "--name-only", `${base}...HEAD`).split("\n") : [];
  const dirty = git("diff", "--name-only", "HEAD").split("\n");
  const untracked = git("ls-files", "--others", "--exclude-standard").split("\n");
  return [...new Set([...committed, ...dirty, ...untracked].filter(Boolean))];
}

// Words from a changed source file name: CamelCase / kebab parts of at least 5 letters, minus generic ones.
const GENERIC = new Set(["index", "types", "utils", "hooks", "style", "styles", "panel", "dialog", "test", "tests", "spec", "electron", "preload"]);
function keywords(file) {
  const base = path.basename(file).replace(/\.(test|spec)?\.?(tsx?|css|mts|mjs)$/, "");
  const words = base.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g) ?? [];
  const whole = base.length >= 5 ? [base.toLowerCase()] : [];
  return [...new Set([...whole, ...words.map((w) => w.toLowerCase()).filter((w) => w.length >= 5 && !GENERIC.has(w))])];
}

function select() {
  if (flags.has("--all")) return { specs: allSpecs, why: new Map(allSpecs.map((s) => [s, "--all"])) };
  const why = new Map();
  const add = (spec, reason) => {
    if (!why.has(spec)) why.set(spec, reason);
  };
  for (const name of manual) for (const s of allSpecs.filter((s) => s.includes(name))) add(s, `name "${name}"`);
  if (manual.length) return { specs: [...why.keys()], why };

  const changed = changedFiles();
  for (const f of changed) {
    const rel = path.relative(desktop, path.join(root, f)).split(path.sep).join("/");
    if (allSpecs.includes(rel)) add(rel, "spec changed");
  }
  const sources = changed.filter((f) => /^packages\/.+\.(tsx?|css)$/.test(f) && !f.includes("e2e-playwright/"));
  const words = new Set(sources.flatMap(keywords));
  for (const spec of allSpecs) {
    const text = readFileSync(path.join(desktop, spec), "utf8").toLowerCase() + spec.toLowerCase();
    const hit = [...words].find((w) => text.includes(w));
    if (hit) add(spec, `keyword "${hit}"`);
  }
  for (const name of SMOKE) for (const s of allSpecs.filter((s) => s.includes(name))) add(s, "smoke");
  return { specs: [...why.keys()], why };
}

// One heavy run at a time (CLAUDE.md): two suites at once produce load-only flakes.
const lockFile = path.join(os.tmpdir(), "githydra-heavy-run.lock");
function takeLock() {
  if (existsSync(lockFile)) {
    const pid = Number(readFileSync(lockFile, "utf8"));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {}
    if (alive) {
      console.error(`Another heavy run (pid ${pid}) holds ${lockFile}. Wait for it to finish.`);
      process.exit(2);
    }
  }
  writeFileSync(lockFile, String(process.pid));
  const release = () => {
    try {
      rmSync(lockFile, { force: true });
    } catch {}
  };
  process.on("exit", release);
  process.on("SIGINT", () => process.exit(130));
}

const DOCKERFILE = `FROM node:22
RUN apt-get update && apt-get install -y --no-install-recommends xvfb xauth rsync git ca-certificates libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2 libgtk-3-0 libxshmfence1 fonts-liberation && rm -rf /var/lib/apt/lists/*
RUN git config --global user.name check && git config --global user.email check@example.com
`;

function runLinux(specs) {
  if (run("docker", ["version"]).status !== 0) {
    console.error("Docker is not available; skipping the Linux run (use --native-only to silence this).");
    return 1;
  }
  const tag = "githydra-check-linux:node22";
  const build = run("docker", ["build", "-t", tag, "-"], { input: DOCKERFILE, stdio: ["pipe", "inherit", "inherit"] });
  if (build.status !== 0) return build.status ?? 1;
  // A wedged container must not live for hours: bound the test run itself.
  const CONTAINER_TIMEOUT_S = 600 + 180 * specs.length;
  const lockHash =createHash("sha1").update(readFileSync(path.join(root, "package-lock.json"))).digest("hex");
  // The repo is mounted read-only and synced into a named volume: host node_modules/dist are Windows builds.
  const script = `set -e
mkdir -p /work && rsync -a --delete --exclude .lockhash --exclude node_modules --exclude dist --exclude dist-electron --exclude .git --exclude test-results --exclude playwright-report /src/ /work/
cd /work
if [ "$(cat /work/.lockhash 2>/dev/null)" != "${lockHash}" ]; then npm ci --no-audit --no-fund && echo "${lockHash}" > /work/.lockhash; fi
npm run build
cd packages/desktop
npx playwright install chromium
# xvfb-run hangs forever in this image (it never sees Xvfb's ready signal), so start the display by hand.
Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp &
export DISPLAY=:99
sleep 2
timeout ${CONTAINER_TIMEOUT_S} npx playwright test --project=electron --workers=1 ${specs.join(" ")}`;
  const r = run(
    "docker",
    ["run", "--rm", "-v", `${root}:/src:ro`, "-v", "githydra-check-linux-work:/work", "-v", "githydra-check-linux-pw:/root/.cache/ms-playwright", "-e", `GITHYDRA_E2E_WINDOW=${WINDOW}`, "-e", "CI=1", tag, "bash", "-c", script],
    { stdio: "inherit" },
  );
  return r.status ?? 1;
}

function runNative(specs) {
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const build = run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], { stdio: "inherit", shell: process.platform === "win32" });
  if (build.status !== 0) return build.status ?? 1;
  const r = run(npx, ["playwright", "test", "--project=electron", "--workers=1", ...specs], {
    cwd: desktop,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, GITHYDRA_E2E_WINDOW: WINDOW },
  });
  return r.status ?? 1;
}

const { specs, why } = select();
if (!specs.length) {
  console.log("No specs selected.");
  process.exit(0);
}
console.log(`Selected ${specs.length} spec(s) (window ${WINDOW}):`);
for (const s of specs) console.log(`  ${s}  [${why.get(s)}]`);

// vitest --changed (import-graph based) covers the unit side; Playwright has no affected-test selection.
console.log("\nUnit side: cd packages/desktop && npx vitest run --changed origin/dev");
if (flags.has("--list")) process.exit(0);

takeLock();
const names = specs.map((s) => s.replace(/^e2e-playwright\/electron\//, ""));
const results = {};
if (!flags.has("--native-only")) results.linux = runLinux(names);
if (!flags.has("--linux-only")) results.native = runNative(names);
console.log("\nResult:", Object.entries(results).map(([k, v]) => `${k} ${v === 0 ? "PASS" : "FAIL"}`).join(", "));
process.exit(Object.values(results).some((v) => v !== 0) ? 1 : 0);
