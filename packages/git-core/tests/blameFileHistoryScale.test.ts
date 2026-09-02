import { describe, it, expect, afterEach, vi } from "vitest";

/**
 * specs/blame.md AC13 ("File history for a file touched by thousands of commits pages
 * incrementally (FR-129) rather than blocking BlamePanel's open on a full history fetch") was
 * previously only exercised at "mechanism level" — blame.test.ts's `getFileHistory` describe
 * block pages a 5-commit fixture with page size 2, which proves `readPage(count)`/`close()`'s
 * *contract shape* but never anything resembling "thousands of commits". This file adds real
 * behavioral coverage at actual scale (~1500 commits).
 *
 * Layer choice: git-core, not `packages/desktop`'s `useFileHistory` hook (in
 * `src/hooks/useBlame.ts`). Reasoning:
 *  - `useFileHistory` already has hook-level wiring coverage in `useBlame.test.ts` (it opens one
 *    reader per target and calls `readPage(FILE_HISTORY_PAGE_SIZE)` once on open, `loadMore()`
 *    per additional page) — but that's against a *mocked* IPC layer, which proves call-count
 *    wiring, not the actual scale/streaming behavior AC13 claims.
 *  - AC13's real claim — that opening a huge file's history doesn't block on a full fetch — is a
 *    property of `blame.ts`'s `FileHistoryReader`/`getFileHistory()` (and, by shared contract,
 *    `commitLog.ts`'s `CommitPager`), not of the hook. Proving it here, against a real repo and a
 *    real `git log --follow` child process, is the only way to prove the claim rather than its
 *    UI-level plumbing.
 *
 * Mechanism (read directly from `src/blame.ts` before writing these assertions): `getFileHistory`
 * returns a `FileHistoryReader` that spawns exactly ONE long-lived `git log --follow` process
 * (via `spawnGit`, no `--max-count`/`-n` anywhere in its argv) and reads its stdout
 * incrementally, buffering only up to the next requested page boundary and trimming consumed
 * records off the front of that buffer after each `readPage()` call — i.e. paging is achieved by
 * pausing/resuming reads over one streaming process, NOT by re-invoking git per page and NOT by
 * asking git itself to bound each call via a `-n`/`--max-count`-style flag. That means "bounded
 * per page" for this implementation is proven by: (a) exactly one `git log --follow` spawn for an
 * entire multi-page read, no matter how many pages it takes, and (b) the first page resolving
 * while that one process is still alive/streaming (not already exited) even over a large history
 * — i.e. `readPage()` never needs the underlying walk to finish before returning a page. Both are
 * asserted below directly against real spawned-process state, not timing thresholds.
 *
 * Large-repo generation: `seedLinearHistoryViaFastImport` (tests/testRepo.ts) seeds ~1500 commits
 * via a single `git fast-import` invocation instead of ~1500 sequential `git commit` calls, which
 * would make this file far too slow to run as part of the normal suite.
 */

const spawnCalls: { command: string; args: readonly string[]; child: import("node:child_process").ChildProcess }[] =
  [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (command: string, args: readonly string[], ...rest: unknown[]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const child = (actual.spawn as any)(command, args, ...rest);
      spawnCalls.push({ command, args, child });
      return child;
    },
  };
});

// Imports that transitively load gitProcess.ts must come after vi.mock (hoisted by vitest to the
// top of the file automatically, but written after here for readability/clarity of intent) — same
// convention noNetworkCalls.test.ts already established for this codebase.
const { getFileHistory } = await import("../src/blame");
const { initRepo, seedLinearHistoryViaFastImport, cleanup } = await import("./testRepo");
type CommitPager = Awaited<ReturnType<typeof getFileHistory>>;

const cleanupDirs: string[] = [];
afterEach(async () => {
  spawnCalls.length = 0;
  while (cleanupDirs.length) await cleanup(cleanupDirs.pop()!);
});

/** Only the `git log --follow ...` invocation `FileHistoryReader` makes — never confused with the
 * `git fast-import`/setup calls `seedLinearHistoryViaFastImport`/`initRepo` also make through the
 * same mocked `spawn`. */
function isFileHistorySpawn(command: string, args: readonly string[]): boolean {
  return /git(\.exe)?$/i.test(command) && args[0] === "log" && args.includes("--follow");
}

async function readAllPages(reader: CommitPager, pageSize: number): Promise<{ shas: string[]; pageLengths: number[] }> {
  const shas: string[] = [];
  const pageLengths: number[] = [];
  for (;;) {
    const page = await reader.readPage(pageSize);
    pageLengths.push(page.commits.length);
    shas.push(...page.commits.map((c) => c.sha));
    if (page.done) break;
  }
  return { shas, pageLengths };
}

const LARGE_COUNT = 1500;

describe("getFileHistory at scale (~1500 commits, AC13)", () => {
  it(
    "pages the full history in exact page-size chunks (all but the last page), in newest-first order matching fast-import's own commit order, across several different page sizes",
    async () => {
      const dir = await initRepo();
      cleanupDirs.push(dir);
      const t0 = performance.now();
      const shasOldestFirst = await seedLinearHistoryViaFastImport(dir, { count: LARGE_COUNT, filePath: "a.txt" });
      const seedMs = performance.now() - t0;
      expect(shasOldestFirst).toHaveLength(LARGE_COUNT);
      const expectedNewestFirst = [...shasOldestFirst].reverse();

      const t1 = performance.now();
      for (const pageSize of [37, 401]) {
        const reader = await getFileHistory(dir, "HEAD", "a.txt");
        const { shas, pageLengths } = await readAllPages(reader, pageSize);
        reader.close();

        // Full history present, in the correct order, none dropped/duplicated at scale.
        expect(shas).toEqual(expectedNewestFirst);

        // Every page except the last returned EXACTLY pageSize commits (the actual "pages
        // incrementally" behavior, not just "eventually returns everything").
        expect(pageLengths.length).toBeGreaterThan(1); // sanity: multiple pages really were needed
        for (let i = 0; i < pageLengths.length - 1; i++) {
          expect(pageLengths[i]).toBe(pageSize);
        }
        const lastLen = pageLengths[pageLengths.length - 1]!;
        expect(lastLen).toBeGreaterThan(0);
        expect(lastLen).toBeLessThanOrEqual(pageSize);
        expect(pageLengths.reduce((a, b) => a + b, 0)).toBe(LARGE_COUNT);
      }
      const readMs = performance.now() - t1;

      // Reported for visibility (see task write-up), and a generous upper bound to catch a real
      // performance regression (e.g. an accidental re-walk per page) without being timing-flaky.
      // eslint-disable-next-line no-console
      console.log(
        `[blame scale test] fast-import seed of ${LARGE_COUNT} commits: ${seedMs.toFixed(0)}ms; ` +
          `two full paged reads (page sizes 37 and 401) over that history: ${readMs.toFixed(0)}ms`,
      );
      expect(readMs).toBeLessThan(20_000);
    },
    30_000,
  );

  it("spawns exactly one `git log --follow` process for an entire multi-page read over ~1500 commits, not one per page", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await seedLinearHistoryViaFastImport(dir, { count: LARGE_COUNT, filePath: "a.txt" });

    spawnCalls.length = 0;
    const reader = await getFileHistory(dir, "HEAD", "a.txt");
    const { pageLengths } = await readAllPages(reader, 50);
    reader.close();

    expect(pageLengths.length).toBeGreaterThan(1); // sanity: this really did take multiple readPage() calls

    const logFollowSpawns = spawnCalls.filter((c) => isFileHistorySpawn(c.command, c.args));
    expect(logFollowSpawns).toHaveLength(1);

    // Confirm the "bounded per page" mechanism really is stream-pausing, not git itself being
    // asked to cap each call (no -n/--max-count anywhere in the one invocation's argv).
    const args = logFollowSpawns[0]!.args;
    expect(args.some((a) => a === "-n" || a.startsWith("--max-count"))).toBe(false);
  });

  it("resolves the first page while the underlying `git log --follow` process is still alive (not already exited) over ~1500 commits — proves readPage() doesn't block on the full walk finishing first", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await seedLinearHistoryViaFastImport(dir, { count: LARGE_COUNT, filePath: "a.txt" });

    spawnCalls.length = 0;
    const reader = await getFileHistory(dir, "HEAD", "a.txt");
    const page = await reader.readPage(5);
    expect(page.commits).toHaveLength(5);
    expect(page.done).toBe(false);

    const logFollowSpawns = spawnCalls.filter((c) => isFileHistorySpawn(c.command, c.args));
    expect(logFollowSpawns).toHaveLength(1);
    const child = logFollowSpawns[0]!.child;
    // If the first page's resolution had required the entire ~1500-commit walk to finish (a
    // full-history materialization) rather than a genuinely bounded/incremental read, this
    // process would already have exited by the time readPage() resolved.
    expect(child.exitCode).toBeNull();
    expect(child.killed).toBe(false);
    expect(child.exitCode).toBeNull();

    reader.close();
  });

  it("never re-fetches/duplicates commits already consumed by an earlier page when reading with a small page size across the full ~1500-commit history", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    const shasOldestFirst = await seedLinearHistoryViaFastImport(dir, { count: LARGE_COUNT, filePath: "a.txt" });
    const expectedNewestFirst = [...shasOldestFirst].reverse();

    const reader = await getFileHistory(dir, "HEAD", "a.txt");
    const { shas } = await readAllPages(reader, 1); // worst case: one commit per readPage() call
    reader.close();

    expect(shas).toHaveLength(LARGE_COUNT);
    expect(new Set(shas).size).toBe(LARGE_COUNT); // no duplicates
    expect(shas).toEqual(expectedNewestFirst); // no drops, no reordering
  }, 30_000);
});
