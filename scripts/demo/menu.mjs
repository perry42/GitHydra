#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Dev-only manual testing kit: a pick-a-scenario menu so nothing has to be typed. Start it by double-clicking play.cmd,
// from VS Code (Terminal > Run Task > "GitHydra demo kit: menu"), or `node scripts/demo/menu.mjs`. See README.md in this folder.
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { scenarios } from "./scenarios/index.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const short = (text, n = 96) => (text.length > n ? text.slice(0, n - 1) + "…" : text);

function printMenu() {
  console.log("\nGitHydra manual-testing kit: pick a practice repo to open in the real app\n");
  const w = String(scenarios.length).length;
  scenarios.forEach((s, i) => console.log(`  ${String(i + 1).padStart(w)}. ${s.name}\n${" ".repeat(w + 5)}${short(s.summary)}`));
  console.log("\nType a number or a name, then Enter. q = quit.");
}

function pick(answer) {
  const a = answer.trim();
  if (!a) return null;
  const n = Number(a);
  if (Number.isInteger(n) && n >= 1 && n <= scenarios.length) return scenarios[n - 1];
  return scenarios.find((s) => s.name === a) ?? null;
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on("close", () => process.exit(0));

for (;;) {
  printMenu();
  const choice = (await rl.question("> ")).trim();
  if (choice === "q" || choice === "quit") break;
  const sc = pick(choice);
  if (!sc) { console.log(`Not a scenario: "${choice}"`); continue; }
  const keep = !sc.stable && /^y/i.test((await rl.question("Keep the practice repo after you close the window (to look at it later)? [y/N] ")).trim());
  const args = [path.join(here, "run.mjs"), sc.name, "--auto-build"];
  if (sc.stable) args.push("--same-profile"); // recovery-draft needs a profile that survives runs
  else if (keep) args.push("--keep");
  console.log(`\nOpening ${sc.name} (the app is rebuilt first if it is out of date; close its window with X when you are done)...\n`);
  spawnSync(process.execPath, args, { stdio: "inherit" }); // fixed argv, no shell
  console.log("\nThe window is closed. Back to the menu.");
}
rl.close();
