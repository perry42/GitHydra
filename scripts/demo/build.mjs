// SPDX-License-Identifier: GPL-3.0-or-later
// Builds a scenario's repos into a folder and checks the result against the scenario's `expect` (used by run.mjs and the unit test).
import * as fs from "node:fs";
import * as path from "node:path";
import { assertSafeDir, inspect, makeRepo } from "./lib.mjs";

/** Builds `sc` under `root` (created if needed). Returns { repo, extra, meta, autoTick }. */
export function buildScenario(sc, root) {
  assertSafeDir(root);
  fs.mkdirSync(root, { recursive: true });
  const ctx = { root, repo: (name, opts) => makeRepo(path.join(root, name), opts) };
  const res = sc.build(ctx);
  return { extra: [], meta: {}, ...res };
}

const expectedFor = (exp, meta) => (typeof exp === "function" ? exp(meta) : exp);

/** Returns a list of mismatch descriptions (empty when the repo matches the scenario's claims). */
export function verifyState(actual, expected) {
  const bad = [];
  for (const [k, want] of Object.entries(expected ?? {})) {
    const got = actual[k];
    const ok = want && typeof want === "object" ? got >= want.min : got === want;
    if (!ok) bad.push(`${k}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  }
  return bad;
}

export function verifyScenario(sc, built) {
  const check = (dir, exp, label) => verifyState(inspect(dir, Object.keys(exp)), exp).map((m) => `${label}: ${m}`);
  const bad = check(built.repo, expectedFor(sc.expect, built.meta), sc.name);
  (sc.expectExtra ?? []).forEach((exp, i) => bad.push(...check(built.extra[i], exp, `${sc.name} extra[${i}]`)));
  return bad;
}
