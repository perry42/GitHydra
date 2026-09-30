// SPDX-License-Identifier: GPL-3.0-or-later
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * specs/branch-panel-drag-merge.md FR-430: fails if any renderer source calls `switchBranch`,
 * `switchToCommit`, or a switching `createBranch` outside the `lib/guardedCheckout.ts` choke point.
 */
const SRC = join(__dirname, "..");
const CHOKE_POINT = join(SRC, "lib", "guardedCheckout.ts");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "test") continue; // mocks / real-API adapters implement the API, they do not call it.
      walk(full, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function findViolations(source: string): string[] {
  const code = stripComments(source);
  const found: string[] = [];
  // Receiver must be the API object (api / gitHydra / getGitHydraApi()); `guard.switchBranch(` is the choke point.
  const API_RECEIVER = String.raw`(?:\b(?:api|gitHydra)|getGitHydraApi\(\))\s*\.\s*`;
  if (new RegExp(API_RECEIVER + String.raw`switchBranch\s*\(`).test(code)) found.push("direct .switchBranch(");
  if (new RegExp(API_RECEIVER + String.raw`switchToCommit\s*\(`).test(code)) found.push("direct .switchToCommit(");
  for (const m of code.matchAll(/\.createBranch\s*\(/g)) {
    const args = code.slice(m.index! + m[0].length, m.index! + m[0].length + 400);
    if (!args.trimStart().startsWith("{")) found.push("createBranch called with a non-literal argument");
    const closeIdx = args.indexOf("})");
    const literal = closeIdx === -1 ? args : args.slice(0, closeIdx);
    if (/switchToIt\s*:(?!\s*false\b)/.test(literal)) found.push("createBranch with switchToIt other than false");
  }
  return found;
}

describe("FR-430: every checkout goes through guardedCheckout", () => {
  it("no renderer source outside lib/guardedCheckout.ts calls switchBranch/switchToCommit/switching createBranch", () => {
    const offenders = walk(SRC)
      .filter((f) => f !== CHOKE_POINT)
      .flatMap((f) => findViolations(readFileSync(f, "utf8")).map((v) => `${relative(SRC, f)}: ${v}`));
    expect(offenders).toEqual([]);
  });

  it("the scanner itself flags direct calls (so a green run means something)", () => {
    expect(findViolations("await api.switchBranch(name)")).toHaveLength(1);
    expect(findViolations("api.switchToCommit(sha)")).toHaveLength(1);
    expect(findViolations("api.createBranch({ name, switchToIt: true })")).toHaveLength(1);
    expect(findViolations("api.createBranch(options)")).toHaveLength(1);
    expect(findViolations("api.createBranch({ name, switchToIt: false })")).toEqual([]);
    expect(findViolations("await window.gitHydra.switchBranch(n)")).toHaveLength(1);
    expect(findViolations("guard.switchBranch(n)")).toEqual([]);
    expect(findViolations("// api.switchBranch(x)\n/* api.switchToCommit(y) */")).toEqual([]);
  });
});
