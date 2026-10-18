// SPDX-License-Identifier: GPL-3.0-or-later
// CI helper: turns a vitest --reporter=json file into one GitHub annotation per failing test file,
// because annotations are the only log surface readable without login and are capped at ~10 per kind.
import { readFileSync, existsSync } from "node:fs";

const [file, label = "vitest"] = process.argv.slice(2);
if (!file || !existsSync(file)) {
  console.log(`::warning::${label}: no vitest json report at ${file}`);
  process.exit(0);
}
const report = JSON.parse(readFileSync(file, "utf8"));
const esc = (s) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const levels = ["error", "warning", "notice"];
let n = 0;
for (const suite of report.testResults ?? []) {
  const failed = (suite.assertionResults ?? []).filter((a) => a.status === "failed");
  if (failed.length === 0 && suite.status !== "failed") continue;
  const lines = failed.map((a) => `- ${a.fullName}: ${(a.failureMessages ?? []).join(" | ").slice(0, 700)}`);
  if (failed.length === 0) lines.push(`suite failed: ${(suite.message ?? "").slice(0, 1500)}`);
  const name = suite.name.replace(/\/g, "/").replace(/^.*\/packages\//, "packages/");
  const level = levels[Math.min(Math.floor(n / 10), 2)];
  console.log(`::${level} title=${label} ${name}::${esc(lines.join("\n")).slice(0, 12000)}`);
  n += 1;
}
console.log(`${label}: ${n} failing file(s)`);
