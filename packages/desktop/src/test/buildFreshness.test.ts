// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let root: string;
const touch = (rel: string, secondsAgo: number) => {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, "x");
  const t = new Date(Date.now() - secondsAgo * 1000);
  fs.utimesSync(full, t, t);
};

// Fresh module each test: the helper checks only once per process.
const load = async () => {
  vi.resetModules();
  return (await import("../../e2e-playwright/helpers/buildFreshness")).assertBuildIsFresh;
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "githydra-fresh-"));
  delete process.env.GITHYDRA_SKIP_BUILD_CHECK;
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const outputs = (secondsAgo: number) => {
  touch("desktop/dist-electron/main.js", secondsAgo);
  touch("desktop/dist/index.html", secondsAgo);
  touch("git-core/dist/index.js", secondsAgo);
};

describe("assertBuildIsFresh (e2e launcher guard)", () => {
  it("passes when every source is older than the build outputs", async () => {
    touch("desktop/src/App.tsx", 600);
    touch("git-core/src/index.ts", 600);
    outputs(60);
    const check = await load();
    expect(() => check(path.join(root, "desktop"))).not.toThrow();
  });

  it("throws naming the newest source when it is newer than the build", async () => {
    outputs(600);
    touch("desktop/src/components/Foo.tsx", 60);
    const check = await load();
    expect(() => check(path.join(root, "desktop"))).toThrow(/Stale build: .*Foo\.tsx.*npm run build/);
  });

  it("notices a newer git-core source too", async () => {
    outputs(600);
    touch("git-core/src/editFile.ts", 30);
    const check = await load();
    expect(() => check(path.join(root, "desktop"))).toThrow(/Stale build/);
  });

  it("ignores test files and e2e specs when judging staleness", async () => {
    outputs(600);
    touch("desktop/src/Foo.test.tsx", 10);
    touch("desktop/e2e-playwright/electron/x.spec.ts", 10);
    touch("desktop/src/test/helper.ts", 10);
    const check = await load();
    expect(() => check(path.join(root, "desktop"))).not.toThrow();
  });

  it("throws when a build output is missing", async () => {
    touch("desktop/src/App.tsx", 600);
    touch("desktop/dist/index.html", 60);
    const check = await load();
    expect(() => check(path.join(root, "desktop"))).toThrow(/Build output missing/);
  });

  it("can be bypassed explicitly", async () => {
    outputs(600);
    touch("desktop/src/App.tsx", 10);
    process.env.GITHYDRA_SKIP_BUILD_CHECK = "1";
    const check = await load();
    expect(() => check(path.join(root, "desktop"))).not.toThrow();
  });
});
