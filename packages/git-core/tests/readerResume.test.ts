// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * specs/instant-tab-revisit.md FR-245: a fresh commit-log reader must be able to "resume" past
 * commits a caller already has cached (e.g. a fast-path-reactivated tab's cached first page,
 * `useRepositoryGraph.ts`) and serve byte-for-byte the same subsequent history a from-scratch
 * reader would have — no duplicate, no gap, no corruption if the resume point doesn't actually
 * line up with what's really there.
 */
import { describe, it, expect, afterEach } from "vitest";
import { CommitLogReader, PrefetchedCommitPager, fastForwardCommitPager } from "../src/commitLog";
import { Repository } from "../src/index";
import { ReaderResumeMismatchError, InvalidArgumentError } from "../src/errors";
import type { CommitInfo } from "../src/types";
import { initRepo, writeFile, commit, cleanup, seedLinearHistoryViaFastImport } from "./testRepo";

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length) await cleanup(cleanupDirs.pop()!);
});

/** Minimal, otherwise-valid CommitInfo for exercising PrefetchedCommitPager directly. */
function makeCommitInfo(sha: string): CommitInfo {
  return {
    sha,
    abbrevSha: sha.slice(0, 7),
    parents: [],
    authorName: "Test Author",
    authorEmail: "author@example.com",
    authorDate: "2024-01-01T00:00:00Z",
    committerName: "Test Author",
    committerEmail: "author@example.com",
    committerDate: "2024-01-01T00:00:00Z",
    subject: "test",
    body: "",
    message: "test",
    refs: [],
    isHistoryBoundary: false,
  };
}

describe("fastForwardCommitPager", () => {
  it("resumed page 1 is byte-for-byte identical to a from-scratch reader's page 2 (AC9 core guarantee)", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    // Oldest-first mark order; git log itself always returns newest-first.
    const shasOldestFirst = await seedLinearHistoryViaFastImport(dir, { count: 30 });
    const shasNewestFirst = [...shasOldestFirst].reverse();

    // Baseline: a from-scratch reader, read in two pages of 10.
    const baseline = new CommitLogReader(dir, undefined);
    const basePage1 = await baseline.readPage(10);
    const basePage2 = await baseline.readPage(10);
    baseline.close();
    expect(basePage1.commits.map((c) => c.sha)).toEqual(shasNewestFirst.slice(0, 10));
    expect(basePage2.commits.map((c) => c.sha)).toEqual(shasNewestFirst.slice(10, 20));

    // A caller already has page 1 (from cache) and creates a fresh reader, resuming past it.
    const lastCachedSha = basePage1.commits[basePage1.commits.length - 1]!.sha;
    const resumed = new CommitLogReader(dir, undefined);
    await fastForwardCommitPager(resumed, { skip: 10, sha: lastCachedSha });
    const resumedPage = await resumed.readPage(10);
    resumed.close();

    expect(resumedPage.commits.map((c) => c.sha)).toEqual(basePage2.commits.map((c) => c.sha));
    expect(resumedPage.commits).toEqual(basePage2.commits);
    expect(resumedPage.done).toBe(basePage2.done);
  });

  it("continues correctly across the rest of history after a resume (no cumulative drift)", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    const shasOldestFirst = await seedLinearHistoryViaFastImport(dir, { count: 25 });
    const shasNewestFirst = [...shasOldestFirst].reverse();

    const resumed = new CommitLogReader(dir, undefined);
    await fastForwardCommitPager(resumed, { skip: 7, sha: shasNewestFirst[6]! });
    const rest: string[] = [];
    for (;;) {
      const page = await resumed.readPage(4); // page size that doesn't evenly divide the remainder
      rest.push(...page.commits.map((c) => c.sha));
      if (page.done) break;
    }
    resumed.close();

    expect(rest).toEqual(shasNewestFirst.slice(7));
  });

  it("is a no-op when skip is 0", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    const sha = await commit(dir, "only commit");

    const reader = new CommitLogReader(dir, undefined);
    await fastForwardCommitPager(reader, { skip: 0, sha: "irrelevant" });
    const page = await reader.readPage(10);
    reader.close();
    expect(page.commits.map((c) => c.sha)).toEqual([sha]);
  });

  it("rejects a negative skip", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    await commit(dir, "only commit");
    const reader = new CommitLogReader(dir, undefined);
    await expect(fastForwardCommitPager(reader, { skip: -1, sha: "x" })).rejects.toThrow(InvalidArgumentError);
    reader.close();
  });

  it("throws ReaderResumeMismatchError (not silently-wrong data) when the sha at the resume point no longer matches — e.g. history was rewritten underneath the cache", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    const shasOldestFirst = await seedLinearHistoryViaFastImport(dir, { count: 12 });
    const shasNewestFirst = [...shasOldestFirst].reverse();

    // Caller's cache thinks the 5th-from-newest commit is some sha that isn't actually there.
    const reader = new CommitLogReader(dir, undefined);
    let caught: unknown;
    try {
      await fastForwardCommitPager(reader, { skip: 5, sha: "0000000000000000000000000000000000dead" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ReaderResumeMismatchError);
    const mismatch = caught as InstanceType<typeof ReaderResumeMismatchError>;
    expect(mismatch.expectedSkip).toBe(5);
    expect(mismatch.expectedSha).toBe("0000000000000000000000000000000000dead");
    expect(mismatch.actualCount).toBe(5);
    expect(mismatch.actualSha).toBe(shasNewestFirst[4]);
    reader.close();
  });

  it("throws ReaderResumeMismatchError when the walk ends before reaching the requested skip count — e.g. the cache is stale after a history-shrinking force-push", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    const shasOldestFirst = await seedLinearHistoryViaFastImport(dir, { count: 3 });
    const rootSha = shasOldestFirst[0]!; // last commit `readPage` yields, since git log is newest-first

    const reader = new CommitLogReader(dir, undefined);
    let caught: unknown;
    try {
      await fastForwardCommitPager(reader, { skip: 10, sha: "irrelevant-since-walk-ends-first" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ReaderResumeMismatchError);
    const mismatch = caught as InstanceType<typeof ReaderResumeMismatchError>;
    expect(mismatch.actualCount).toBe(3);
    // The walk found (and consumed) all 3 real commits before running out — actualSha reflects
    // the last one actually seen, not null; only a walk that finds ZERO commits at all (an empty
    // history, or every commit already consumed by a prior readPage call) leaves it null.
    expect(mismatch.actualSha).toBe(rootSha);
    reader.close();
  });

  it("leaves actualSha null when the walk finds no commits at all before ending (e.g. an empty repository)", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);

    const reader = new CommitLogReader(dir, undefined);
    let caught: unknown;
    try {
      await fastForwardCommitPager(reader, { skip: 1, sha: "irrelevant-repo-is-empty" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ReaderResumeMismatchError);
    const mismatch = caught as InstanceType<typeof ReaderResumeMismatchError>;
    expect(mismatch.actualCount).toBe(0);
    expect(mismatch.actualSha).toBeNull();
    reader.close();
  });

  it("resumes correctly against a filtered walk too (author filter), matching the filtered from-scratch order", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    const shas: string[] = [];
    for (let i = 0; i < 8; i++) {
      await writeFile(dir, "a.txt", String(i));
      shas.push(await commit(dir, `commit ${i}`));
    }
    shas.reverse();

    const baseline = new CommitLogReader(dir, { author: "Test Author" });
    const basePage1 = await baseline.readPage(3);
    const basePage2 = await baseline.readPage(3);
    baseline.close();

    const resumed = new CommitLogReader(dir, { author: "Test Author" });
    await fastForwardCommitPager(resumed, {
      skip: 3,
      sha: basePage1.commits[basePage1.commits.length - 1]!.sha,
    });
    const resumedPage = await resumed.readPage(3);
    resumed.close();

    expect(resumedPage.commits.map((c) => c.sha)).toEqual(basePage2.commits.map((c) => c.sha));
  });

  it("works uniformly against PrefetchedCommitPager (the sha-filter pager shape), not just the streaming reader", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    const c1 = await commit(dir, "first");
    await writeFile(dir, "a.txt", "2");
    const c2 = await commit(dir, "second");

    const pager = new PrefetchedCommitPager([makeCommitInfo(c2), makeCommitInfo(c1)]);
    await fastForwardCommitPager(pager, { skip: 1, sha: c2 });
    const page = await pager.readPage(10);
    pager.close();
    expect(page.commits.map((c) => c.sha)).toEqual([c1]);
  });
});

describe("Repository.createCommitLogReader with resumeAfter (FR-245 integration)", () => {
  it("a resumed reader created via Repository matches a from-scratch reader's later pages exactly", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await seedLinearHistoryViaFastImport(dir, { count: 20 });

    const repo = await Repository.open(dir);

    const fromScratch = await repo.createCommitLogReader();
    const page1 = await fromScratch.readPage(10);
    const page2 = await fromScratch.readPage(10);
    fromScratch.close();

    const resumedReader = await repo.createCommitLogReader(undefined, undefined, {
      skip: 10,
      sha: page1.commits[page1.commits.length - 1]!.sha,
    });
    const resumedPage = await resumedReader.readPage(10);
    resumedReader.close();

    expect(resumedPage.commits.map((c) => c.sha)).toEqual(page2.commits.map((c) => c.sha));
    expect(resumedPage.done).toBe(page2.done);
  });

  it("closes the reader and rejects instead of returning any commits when resumeAfter doesn't match reality", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await seedLinearHistoryViaFastImport(dir, { count: 5 });
    const repo = await Repository.open(dir);

    await expect(
      repo.createCommitLogReader(undefined, undefined, { skip: 2, sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" }),
    ).rejects.toThrow(ReaderResumeMismatchError);
  });

  it("omitting resumeAfter behaves exactly as before (no behavior change for existing callers)", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "1");
    const sha = await commit(dir, "only commit");
    const repo = await Repository.open(dir);

    const reader = await repo.createCommitLogReader();
    const page = await reader.readPage(10);
    reader.close();
    expect(page.commits.map((c) => c.sha)).toEqual([sha]);
  });
});
