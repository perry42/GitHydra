// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * specs/instant-tab-revisit.md FR-245: IPC-boundary coverage for `GitHydraApi.createLogReader()`'s
 * `resumeAfter` option — `packages/git-core/tests/readerResume.test.ts` already proves
 * `fastForwardCommitPager`/`Repository.createCommitLogReader({ resumeAfter })` are correct against
 * real git-core; this file proves the plumbing ABOVE that (the `IpcResult`-wrapping, the reader
 * registry, `serializeError()`'s `ReaderResumeMismatchError` branch) is wired correctly at the same
 * boundary `electron/main.ts`'s real `ipcMain.handle` callbacks use — `./realGitHydraApi.ts` mirrors
 * those handlers function-for-function (see its own module doc comment), so exercising it here
 * exercises the exact same logic `main.ts` runs, without needing a real Electron process.
 *
 * Deliberately calls the `GitHydraApi` object directly rather than rendering `<App/>`: this
 * feature has no UI entry point yet (ROADMAP.md's tech-debt entry — not wired in to replace
 * `useRepositoryGraph.ts`'s shipped fast-forward fix), so there is nothing for a React test to
 * drive through the UI. This is the IPC layer's own contract test.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRealGitHydraApi, type RealGitHydraHandle } from "./realGitHydraApi";
import { cleanup, commitAll, initRepo, writeFile } from "./gitFixture";
import type { CommitLogPage } from "@githydra/git-core";

// ROADMAP.md's "git-core test suite is flaky under full parallel load" tech debt (same symptom
// class independently confirmed in this package's own e2e suite per that entry): this file, like
// `packages/git-core/tests/readerResume.test.ts`, seeds real linear history via many sequential
// real `git commit` child-process spawns (heavier than most of this suite's fixtures, which reuse
// a single pre-seeded commit) and drives a real `RepoSession`/`Repository` through several more
// real spawns per test — comfortably enough to blow past vitest's default 5000ms `testTimeout` on
// a loaded machine without being a real hang.
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

const handles: RealGitHydraHandle[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (handles.length) handles.pop()!.dispose();
  while (dirs.length) await cleanup(dirs.pop()!);
});

async function seedLinearHistory(dir: string, count: number): Promise<string[]> {
  const shasOldestFirst: string[] = [];
  for (let i = 0; i < count; i++) {
    await writeFile(dir, "a.txt", String(i));
    shasOldestFirst.push(await commitAll(dir, `commit ${i}`));
  }
  return shasOldestFirst;
}

async function readAll(
  handle: RealGitHydraHandle,
  readerId: string,
  pageSize: number,
): Promise<CommitLogPage["commits"]> {
  const commits: CommitLogPage["commits"] = [];
  for (;;) {
    const result = await handle.api.readPage(readerId, pageSize);
    if (!result.ok) throw new Error(`readPage failed: ${result.error.name}: ${result.error.message}`);
    commits.push(...result.data.commits);
    if (result.data.done) break;
  }
  return commits;
}

describe("GitHydraApi.createLogReader with resumeAfter (specs/instant-tab-revisit.md FR-245, IPC boundary)", () => {
  it("a resumed reader's first page matches a from-scratch reader's later page exactly, through the real IPC-shaped API", async () => {
    const dir = await initRepo();
    dirs.push(dir);
    await seedLinearHistory(dir, 12);

    const handle = createRealGitHydraApi();
    handles.push(handle);
    const opened = await handle.api.openRepo(dir);
    expect(opened.ok).toBe(true);

    const fromScratch = await handle.api.createLogReader(undefined);
    expect(fromScratch.ok).toBe(true);
    if (!fromScratch.ok) return;
    const page1 = await handle.api.readPage(fromScratch.data, 5);
    expect(page1.ok).toBe(true);
    if (!page1.ok) return;
    const page2 = await handle.api.readPage(fromScratch.data, 5);
    expect(page2.ok).toBe(true);
    if (!page2.ok) return;
    await handle.api.closeReader(fromScratch.data);

    const lastCachedSha = page1.data.commits[page1.data.commits.length - 1]!.sha;
    const resumed = await handle.api.createLogReader(undefined, undefined, {
      skip: page1.data.commits.length,
      sha: lastCachedSha,
    });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    const resumedPage = await handle.api.readPage(resumed.data, 5);
    expect(resumedPage.ok).toBe(true);
    if (!resumedPage.ok) return;
    await handle.api.closeReader(resumed.data);

    expect(resumedPage.data.commits.map((c) => c.sha)).toEqual(page2.data.commits.map((c) => c.sha));
    expect(resumedPage.data.done).toBe(page2.data.done);
  });

  it("loadMore()-shaped usage: resuming past a full cached page returns correct, contiguous remaining history", async () => {
    const dir = await initRepo();
    dirs.push(dir);
    const shasOldestFirst = await seedLinearHistory(dir, 12);
    const shasNewestFirst = [...shasOldestFirst].reverse();

    const handle = createRealGitHydraApi();
    handles.push(handle);
    await handle.api.openRepo(dir);

    // Simulate a fast-path-reactivated tab: it already has the first 8 rows cached (from a
    // previous session/activation), and no live reader yet — exactly FR-245's scenario.
    const cachedRows = shasNewestFirst.slice(0, 8);
    const resumed = await handle.api.createLogReader(undefined, undefined, {
      skip: cachedRows.length,
      sha: cachedRows[cachedRows.length - 1]!,
    });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;

    const rest = await readAll(handle, resumed.data, 6);
    await handle.api.closeReader(resumed.data);

    expect(rest.map((c) => c.sha)).toEqual(shasNewestFirst.slice(8));
  });

  it("surfaces a mismatched resumeAfter as a distinctly-named ReaderResumeMismatchError IpcResult, never as commit data", async () => {
    const dir = await initRepo();
    dirs.push(dir);
    await seedLinearHistory(dir, 5);

    const handle = createRealGitHydraApi();
    handles.push(handle);
    await handle.api.openRepo(dir);

    const result = await handle.api.createLogReader(undefined, undefined, {
      skip: 2,
      sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.name).toBe("ReaderResumeMismatchError");
    expect(result.error.message.length).toBeGreaterThan(0);
  });

  it("omitting resumeAfter behaves exactly as every other createLogReader call (no behavior change)", async () => {
    const dir = await initRepo();
    dirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    const sha = await commitAll(dir, "only commit");

    const handle = createRealGitHydraApi();
    handles.push(handle);
    await handle.api.openRepo(dir);

    const reader = await handle.api.createLogReader(undefined);
    expect(reader.ok).toBe(true);
    if (!reader.ok) return;
    const page = await handle.api.readPage(reader.data, 10);
    await handle.api.closeReader(reader.data);

    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.data.commits.map((c) => c.sha)).toEqual([sha]);
  });
});
