// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach } from "vitest";
import { stageFile } from "../src/staging";
import { createStash, applyStash } from "../src/stash";
import { git, initRepo, writeFile, commit, cleanup } from "./testRepo";

/**
 * Regression test for the concurrent-git-invocation `.git/index.lock` race: a user-initiated
 * mutation (stage a file) firing at roughly the same moment as another mutation (apply a stash)
 * — exactly the reproduction from the real Playwright IPC-transport suite (`git -c
 * core.fsmonitor=false add -- b.txt` racing `git -c core.fsmonitor=false stash apply stash@{0}`
 * for `.git/index.lock`) — must now queue instead of racing. See `enqueueGitTask`'s doc comment
 * in `src/gitProcess.ts` for the fix.
 */
describe("concurrent git-core mutations against the same repo", () => {
  const cleanupDirs: string[] = [];
  afterEach(async () => {
    while (cleanupDirs.length) await cleanup(cleanupDirs.pop()!);
  });

  it("stageFile and applyStash fired concurrently both succeed instead of racing for index.lock", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "a.txt", "first");
    await commit(dir, "seed");

    // Build a stash entry to apply back.
    await writeFile(dir, "a.txt", "stashed change");
    await createStash(dir, {});
    // createStash restores the working tree to clean (the change is now only in the stash).
    const cleanStatus = await git(dir, ["status", "--porcelain=v1"]);
    expect(cleanStatus.stdout.trim()).toBe("");

    // A second, unrelated change to stage concurrently with the stash apply above.
    await writeFile(dir, "b.txt", "new file");

    // Fire both real mutating git-core calls at the same time, exactly like the app's
    // user-initiated stage action racing its own post-mutation refresh (or, here, a second
    // user-initiated mutation) — this is what previously raced for index.lock.
    const results = await Promise.allSettled([stageFile(dir, "b.txt"), applyStash(dir, 0)]);

    for (const r of results) {
      if (r.status === "rejected") {
        throw r.reason;
      }
    }

    const finalStatus = await git(dir, ["status", "--porcelain=v1"]);
    // b.txt staged as a new file, a.txt back with its stashed content — either way, both present,
    // proving BOTH mutations actually took effect rather than one silently losing the race.
    expect(finalStatus.stdout).toContain("b.txt");
    expect(finalStatus.stdout).toContain("a.txt");
  });

  it("many concurrent stageFile calls for distinct files all succeed", async () => {
    const dir = await initRepo();
    cleanupDirs.push(dir);
    await writeFile(dir, "seed.txt", "seed");
    await commit(dir, "seed");

    const fileCount = 15;
    const files = Array.from({ length: fileCount }, (_, i) => `file-${i}.txt`);
    await Promise.all(files.map((f) => writeFile(dir, f, "content")));

    const results = await Promise.allSettled(files.map((f) => stageFile(dir, f)));
    const failures = results.filter((r) => r.status === "rejected");
    expect(failures).toEqual([]);

    const { stdout } = await git(dir, ["status", "--porcelain=v1"]);
    for (const f of files) {
      expect(stdout).toContain(`A  ${f}`);
    }
  });
});
