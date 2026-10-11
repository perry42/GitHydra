#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Dev-only manual testing kit. See docs/manual-testing/README.md. Run via `npm run demo -- <scenario>` from the repo root.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildScenario, verifyScenario } from "./build.mjs";
import { closeLaunched, launchApp } from "./launch.mjs";
import { assertSafeDir, buildProblem } from "./lib.mjs";
import { byName, scenarios } from "./scenarios/index.mjs";
import { actions, tick } from "./tick.mjs";

const USAGE = `Usage (from the GitHydra repo root):
  npm run demo -- --list                      list scenarios
  npm run demo -- <scenario> [options]        build the scenario's repo(s) in the OS temp dir and open the built app on it
  npm run demo -- --all-repos <folder>        only build every scenario's repos under <folder> (inside the OS temp dir), no app
  npm run demo -- tick <repo> [action]        external git activity on a demo repo (actions: ${Object.keys(actions).join(", ")})
Options: --keep (do not delete repos/profile on exit), --same-profile (stable repo + profile, survives runs; for recovery-draft),
         --rebuild (with --same-profile: rebuild the repos), --no-tick (multi-tab: skip the delayed merge), --tick-after <sec>,
         --smoke (launch, check it is ready, close, exit 0/1)
Close the app window with X. Prerequisite: npm run build`;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const valueOf = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && ["--all-repos", "--tick-after"].includes(argv[i - 1])));

const rmDir = (d) => fs.rmSync(assertSafeDir(d), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

function printScenarioList() {
  const w = Math.max(...scenarios.map((s) => s.name.length));
  for (const s of scenarios) console.log(`  ${s.name.padEnd(w)}  ${s.summary}`);
}

function allRepos(folder) {
  if (!folder) throw new Error("--all-repos needs a folder inside the OS temp dir, e.g. --all-repos " + path.join(os.tmpdir(), "githydra-demo-all"));
  const root = assertSafeDir(folder);
  for (const s of scenarios) {
    const dir = path.join(root, s.name);
    if (fs.existsSync(dir)) throw new Error(`${dir} already exists; pick an empty folder.`);
    const built = buildScenario(s, dir);
    const bad = verifyScenario(s, built);
    console.log(`${bad.length ? "MISMATCH" : "ok      "} ${s.name}  ${built.repo}${bad.length ? "\n  " + bad.join("\n  ") : ""}`);
  }
}

async function runScenario(sc) {
  const problem = buildProblem();
  if (problem) { console.error(problem); process.exitCode = 1; return; }

  const stable = flag("--same-profile");
  const tmp = os.tmpdir();
  let base, root, userData;
  if (stable) {
    base = path.join(tmp, "githydra-demo-stable", sc.name);
    root = path.join(base, "repos");
    userData = path.join(base, "profile");
    assertSafeDir(base);
    if (flag("--rebuild")) { rmDir(root); fs.rmSync(path.join(base, "layout.json"), { force: true }); }
    fs.mkdirSync(userData, { recursive: true });
  } else {
    root = fs.mkdtempSync(path.join(tmp, `githydra-demo-${sc.name}-`));
    userData = fs.mkdtempSync(path.join(tmp, "githydra-demo-profile-"));
  }
  const keep = flag("--keep") || stable;
  let handle, cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await closeLaunched(handle);
    if (!keep) { rmDir(root); rmDir(userData); }
  };
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => cleanup().finally(() => process.exit(0)));

  try {
    const layoutFile = stable ? path.join(base, "layout.json") : null; // stable mode remembers where the scenario put its repos
    let built;
    if (layoutFile && fs.existsSync(layoutFile) && fs.existsSync(root)) built = JSON.parse(fs.readFileSync(layoutFile, "utf8"));
    else {
      built = buildScenario(sc, root);
      if (layoutFile) fs.writeFileSync(layoutFile, JSON.stringify(built));
    }
    const bad = verifyScenario(sc, built);
    if (bad.length && !stable) console.log("WARNING: the built repo does not match its description:\n  " + bad.join("\n  "));
    const repos = [built.repo, ...built.extra];

    console.log(`\n=== ${sc.name} ===\n${sc.tryText}\n`);
    console.log(`Repo (opened):   ${built.repo}`);
    for (const e of built.extra) console.log(`Extra repo:      ${e}   (open it in another tab; the file picker offers it next)`);
    console.log(`Profile:         ${userData}${stable ? "  (kept; reuse with --same-profile)" : ""}`);
    if (!keep) console.log("Repos and profile are deleted when you close the window (use --keep to keep them).");
    if (stable) console.log("Stable repo + profile in use; add --rebuild to start over.");
    console.log("Starting the app...");

    handle = await launchApp({ userDataDir: userData, repos });
    console.log(handle.ready ? `READY repo=${built.repo}` : "NOT-CONFIRMED: the toolbar did not appear in time; the window is open, check it by eye.");

    if (flag("--smoke")) {
      process.exitCode = handle.ready ? 0 : 1;
      return;
    }
    console.log("Close the window with X when you are done.");

    let timer;
    if (built.autoTick && !flag("--no-tick")) {
      const sec = Number(valueOf("--tick-after") ?? built.autoTick.afterSec);
      timer = setTimeout(() => {
        try { console.log(`[tick after ${sec}s] ${built.autoTick.action}: ${tick(built.autoTick.repo, built.autoTick.action)}`); } catch (e) { console.log(`[tick] ${e.message}`); }
      }, sec * 1000);
    }
    await handle.closed;
    clearTimeout(timer);
  } finally {
    await cleanup();
  }
}

async function main() {
  if (flag("--help") || flag("-h")) return console.log(USAGE);
  if (flag("--list")) return printScenarioList();
  if (positional[0] === "tick") {
    if (!positional[1]) return console.log(Object.entries(actions).map(([k, v]) => `  ${k.padEnd(12)} ${v.help}`).join("\n") + "\n\nusage: npm run demo -- tick <repo> [action]");
    return console.log(tick(positional[1], positional[2]));
  }
  if (flag("--all-repos")) return allRepos(valueOf("--all-repos"));

  const sc = byName(positional[0]);
  if (!sc) {
    console.log(positional[0] ? `Unknown scenario "${positional[0]}". Available:` : USAGE + "\n\nScenarios:");
    printScenarioList();
    process.exitCode = positional[0] ? 1 : 0;
    return;
  }
  await runScenario(sc);
}

main().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; });
