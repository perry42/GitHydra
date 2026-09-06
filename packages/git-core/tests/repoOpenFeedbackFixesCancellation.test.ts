// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach } from "vitest";
import { listRefs } from "../src/refs";
import { getUpstreamBranch } from "../src/upstream";
import { getWorkingDirectoryChanges } from "../src/workingDirStatus";
import { listStashes } from "../src/stash";
import { Repository } from "../src/index";
import { OperationCancelledError } from "../src/errors";
import { git, initRepo, writeFile, commit, cleanup } from "./testRepo";

/**
 * specs/repo-open-feedback-fixes.md FR-197: extends the existing, already-proven `signal`
 * cancellation plumbing (`gitProcess.ts`'s `armTimeout()`/SIGTERM-then-SIGKILL escalation, already
 * covered end-to-end by `gitProcess.test.ts`) to the specific reads `useRepositoryGraph.ts`'s
 * `refreshAuxData`/`startReader` issue during a still-in-flight cancellable `openRepo` attempt —
 * `getRefs`/`getUpstreamBranch`/`getWorkingDirectoryChanges`/`listStashes`/
 * `createCommitLogReader`'s first `readPage()`. Exercised against REAL repos/REAL git processes
 * (not mocks), proving each function's own `signal` is genuinely wired through to `runGit`/
 * `spawnGit`, and — for `getUpstreamBranch` specifically — that a cancellation is never silently
 * folded into that function's own "no upstream configured" `null` fallback.
 */

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length) await cleanup(cleanupDirs.pop()!);
});

describe("listRefs cancellation (FR-197)", () => {
  it("rejects with OperationCancelledError when the caller aborts", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "hello");
    await commit(dir, "first commit");
    await git(dir, ["tag", "v1"]);

    const controller = new AbortController();
    controller.abort();
    await expect(listRefs(dir, controller.signal)).rejects.toBeInstanceOf(OperationCancelledError);
  });

  it("an uncancelled call completes normally (no regression)", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "hello");
    await commit(dir, "first commit");
    await git(dir, ["tag", "v1"]);

    const refs = await listRefs(dir);
    expect(refs.some((r) => r.shortName === "v1")).toBe(true);
  });
});

describe("getUpstreamBranch cancellation (FR-197)", () => {
  it("rejects with OperationCancelledError — never silently folded into the ordinary 'no upstream configured' null fallback", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "hello");
    await commit(dir, "first commit");

    const controller = new AbortController();
    controller.abort();
    await expect(getUpstreamBranch(dir, controller.signal)).rejects.toBeInstanceOf(OperationCancelledError);
  });

  it("an uncancelled call on a branch with no upstream still degrades to null (no regression)", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "hello");
    await commit(dir, "first commit");

    await expect(getUpstreamBranch(dir)).resolves.toBeNull();
  });
});

describe("getWorkingDirectoryChanges cancellation (FR-197)", () => {
  it("rejects with OperationCancelledError when the caller aborts", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "hello");
    await commit(dir, "first commit");
    await writeFile(dir, "a.txt", "changed");

    const controller = new AbortController();
    controller.abort();
    await expect(getWorkingDirectoryChanges(dir, controller.signal)).rejects.toBeInstanceOf(OperationCancelledError);
  });
});

describe("listStashes cancellation (FR-197)", () => {
  it("rejects with OperationCancelledError when the caller aborts", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "hello");
    await commit(dir, "first commit");
    await writeFile(dir, "a.txt", "changed");
    await git(dir, ["stash", "push"]);

    const controller = new AbortController();
    controller.abort();
    await expect(listStashes(dir, controller.signal)).rejects.toBeInstanceOf(OperationCancelledError);
  });
});

// specs/repo-open-feedback-fixes.md FR-197/FR-199: `CommitLogReader` is the one call site here
// that does NOT go through `runGit`/`armTimeout` (it's a long-lived `spawnGit` process, streamed
// incrementally as pages are requested — see its own doc comment) — its cancellation detection
// (distinguishing a caller abort from a genuine `git log` failure) is hand-rolled, not reused
// generic plumbing, so it needs its own direct proof.
describe("Repository.createCommitLogReader / CommitLogReader cancellation (FR-197)", () => {
  it("a reader created with a signal rejects its first readPage() with OperationCancelledError when the caller aborts before the process has finished", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    for (let i = 0; i < 5; i++) {
      await writeFile(dir, "a.txt", `line ${i}\n`);
      await commit(dir, `commit ${i}`);
    }

    const repo = await Repository.open(dir);
    const controller = new AbortController();
    const reader = await repo.createCommitLogReader(undefined, controller.signal);
    try {
      const pagePromise = reader.readPage(1);
      controller.abort();
      await expect(pagePromise).rejects.toBeInstanceOf(OperationCancelledError);
    } finally {
      reader.close();
    }
  });

  it("a reader created with a signal that is never aborted behaves exactly as before (no regression)", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "hello");
    const sha = await commit(dir, "first commit");

    const repo = await Repository.open(dir);
    const controller = new AbortController();
    const reader = await repo.createCommitLogReader(undefined, controller.signal);
    try {
      const page = await reader.readPage(10);
      expect(page.commits.map((c) => c.sha)).toEqual([sha]);
      expect(page.done).toBe(true);
    } finally {
      reader.close();
    }
  });

  it("aborting after the reader has already fully finished is a harmless no-op — readPage() keeps returning already-buffered data", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "hello");
    const sha = await commit(dir, "first commit");

    const repo = await Repository.open(dir);
    const controller = new AbortController();
    const reader = await repo.createCommitLogReader(undefined, controller.signal);
    try {
      const page = await reader.readPage(10);
      expect(page.commits.map((c) => c.sha)).toEqual([sha]);
      controller.abort();
      const secondPage = await reader.readPage(10);
      expect(secondPage.commits).toEqual([]);
      expect(secondPage.done).toBe(true);
    } finally {
      reader.close();
    }
  });
});
