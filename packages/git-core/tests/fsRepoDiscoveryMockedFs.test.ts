// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach, vi } from "vitest";
import * as path from "node:path";
import * as nodeFs from "node:fs/promises";

/**
 * Deliberately its own file (mirrors `noNetworkCalls.test.ts`'s own doc comment on why IT is
 * separate): mocking `node:fs/promises` at module scope must be in place before
 * `fsRepoDiscovery.ts` (which imports from it) is first loaded, and doing that in a file shared
 * with `fsRepoDiscovery.test.ts`'s many real-filesystem tests would affect (and risk subtly
 * breaking) every one of those.
 *
 * Security-review finding (2026-09-04): a plain `fs.stat`/`fs.lstat` call has no abort-signal
 * support in Node and can hang indefinitely against a wedged filesystem — `fastCheckRepositoryDiscovery()`
 * cannot force-interrupt such a call, but the tests below prove the OVERALL operation still makes
 * forward progress: a caller abort settles the outer promise immediately even while a specific
 * fs call is deliberately kept pending forever (never just "abort before the walk starts", which
 * `fsRepoDiscovery.test.ts` already covers and would pass even without this fix), and a
 * device/filesystem boundary is honored using a directly-injected stat result (a real second
 * mounted filesystem/drive isn't available/portable in this test environment).
 */

type StatOverride = (p: string) => { dev: number } | undefined;
let statOverride: StatOverride | null = null;
let lstatOverride: ((p: string) => "pending" | undefined) | null = null;
let releasePendingLstat: (() => void) | null = null;

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: (async (p: string, ...rest: unknown[]) => {
      const override = statOverride?.(p);
      if (override) {
        const real = await actual.stat(p);
        return Object.assign(Object.create(Object.getPrototypeOf(real)), real, { dev: override.dev });
      }
      // @ts-expect-error - forwarding rest args to the real implementation
      return actual.stat(p, ...rest);
    }) as typeof actual.stat,
    lstat: (async (p: string, ...rest: unknown[]) => {
      if (lstatOverride?.(p) === "pending") {
        return new Promise((resolve, reject) => {
          releasePendingLstat = () => actual.lstat(p).then(resolve, reject);
        });
      }
      // @ts-expect-error - forwarding rest args to the real implementation
      return actual.lstat(p, ...rest);
    }) as typeof actual.lstat,
  };
});

const { fastCheckRepositoryDiscovery } = await import("../src/fsRepoDiscovery");
const { OperationCancelledError } = await import("../src/errors");
const { initRepo, makeTempDir, cleanup } = await import("./testRepo");

const cleanupDirs: string[] = [];

afterEach(async () => {
  statOverride = null;
  lstatOverride = null;
  releasePendingLstat = null;
  while (cleanupDirs.length) await cleanup(cleanupDirs.pop()!);
});

describe("fastCheckRepositoryDiscovery — caller cancellation interrupts a stuck in-flight fs call", () => {
  it("rejects with OperationCancelledError promptly on abort, without ever waiting for a permanently-stuck `.git` lstat call to resolve", async () => {
    const dir = await makeTempDir();
    cleanupDirs.push(dir);
    const dotGitPath = path.join(dir, ".git");
    lstatOverride = (p) => (p === dotGitPath ? "pending" : undefined);

    const controller = new AbortController();
    const promise = fastCheckRepositoryDiscovery(dir, controller.signal);

    // Give the walk a real moment to actually start and get stuck inside the mocked lstat call.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(releasePendingLstat).not.toBeNull(); // sanity: the walk really is stuck there right now

    const start = Date.now();
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(OperationCancelledError);
    // Proves this came from the abort racing ahead of the stuck call, not from the stuck call
    // itself ever resolving (which never happens until the explicit release below).
    expect(Date.now() - start).toBeLessThan(1000);

    // Releasing the now-irrelevant stuck call afterward must not throw/resurface anywhere (the
    // outer promise already settled and this result is simply discarded).
    releasePendingLstat?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});

describe("fastCheckRepositoryDiscovery — device/filesystem boundary", () => {
  it('stops at a simulated device boundary and answers "definitely-not-a-repo", never crossing into a differently-mounted parent even though it has a real .git', async () => {
    const repoDir = await initRepo();
    cleanupDirs.push(repoDir);
    const leaf = path.join(repoDir, "mid", "leaf");
    await nodeFs.mkdir(leaf, { recursive: true });

    // Simulate `repoDir` living on a different device/filesystem than its child `repoDir/mid` —
    // the walk must stop the moment it would step from `repoDir/mid` up into `repoDir`, never
    // reaching (or checking) `repoDir`'s own real `.git`.
    const repoDirResolved = path.resolve(repoDir);
    statOverride = (p) => (path.resolve(p) === repoDirResolved ? { dev: -999 } : undefined);

    await expect(fastCheckRepositoryDiscovery(leaf)).resolves.toBe("definitely-not-a-repo");
  });
});
