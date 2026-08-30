import { describe, it, expect, afterEach } from "vitest";
import { watchRepositoryRefs, type RepositoryWatcher } from "../src/watcher";
import { getRepositoryState } from "../src/repository";
import { git, initRepo, writeFile, commit, cleanup } from "./testRepo";

/**
 * Regression coverage for the bug test-agent reproduced against `watchRepositoryRefs` during
 * merge-rebase-conflict-resolution (FR-59/AC11) acceptance verification: the watcher correctly
 * fired for a rebase *starting* (rebase-merge/ created) and *progressing* (msgnum updated inside
 * it via an intermediate `--continue`), but did NOT fire when the operation *ended* — either
 * `git rebase --abort` or a multi-step rebase's final `--continue`, both of which delete the
 * `rebase-merge/` directory entirely.
 *
 * Root cause (confirmed against this file's actual behavior on this Windows environment, not
 * assumed): once the nested recursive `fs.watch` set up on `rebase-merge/` (see watcher.ts's
 * FR-59 self-healing block) has its target directory deleted out from under it, the underlying
 * Windows `ReadDirectoryChangesW` handle goes stale and the watcher emits an effectively
 * unbounded storm of spurious "rename" events referencing the now-invalid path — never a clean
 * removal signal, never an "error" event, and never stopping on its own. Every one of those
 * events called the shared debounce's `scheduleFire()`, which resets the same timer on every
 * call — so `onChange` wasn't merely delayed, it was starved out completely for as long as the
 * storm continued (observed: hundreds of thousands of events in well under a second, with no gap
 * ever reaching the 150ms default debounce window). The fix (in `tryWatch` in watcher.ts) checks,
 * on every nested-watch event, whether the watched target itself still exists; if not, it closes
 * and drops that watcher immediately (stopping the storm at its source) and fires exactly one
 * change notification for the removal.
 *
 * These tests run real `git rebase --abort` / a real multi-step `git rebase --continue` against
 * a real temp-directory repo and assert the watcher's `onChange` actually fires within a bounded
 * wait — not a mock, and not a component-level check (that's exactly the kind of test that
 * previously passed while this bug shipped).
 */

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length) await cleanup(cleanupDirs.pop()!);
});

async function makeRepo(): Promise<string> {
  const dir = await initRepo();
  cleanupDirs.push(dir);
  return dir;
}

/** Poll-free wait: resolves as soon as `onChange` has fired at least `times`, or rejects on timeout. */
function waitForChangeCount(
  getCount: () => number,
  times: number,
  timeoutMs: number,
  label: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (getCount() >= times) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(
          new Error(
            `${label}: onChange fired ${getCount()} time(s), expected >= ${times}, within ${timeoutMs}ms`,
          ),
        );
        return;
      }
      setTimeout(check, 25);
    };
    check();
  });
}

/** Two commits on `feature`, each touching a distinct file (a.txt / b.txt), and one commit on
 * `main` that independently changes both of those same files — so `git rebase main` from
 * `feature` conflicts on a.txt at step 1 of 2, and (after resolving only a.txt and continuing)
 * conflicts again on b.txt at step 2 of 2, giving a genuine intermediate `--continue`
 * (rebase-merge/ persists, msgnum advances) followed by a genuine final `--continue`
 * (rebase-merge/ is deleted on completion). One file per step keeps each conflict isolated and
 * the resolution deterministic, unlike reusing a single file across both commits. */
async function setupMultiStepConflictingRebase(): Promise<{ dir: string }> {
  const dir = await makeRepo();
  await writeFile(dir, "a.txt", "base-a\n");
  await writeFile(dir, "b.txt", "base-b\n");
  await commit(dir, "base");
  await git(dir, ["checkout", "-q", "-b", "feature"]);
  await writeFile(dir, "a.txt", "feature-a\n");
  await commit(dir, "f1: change a.txt");
  await writeFile(dir, "b.txt", "feature-b\n");
  await commit(dir, "f2: change b.txt");
  await git(dir, ["checkout", "-q", "main"]);
  await writeFile(dir, "a.txt", "main-a\n");
  await writeFile(dir, "b.txt", "main-b\n");
  await commit(dir, "m1: change both files");
  await git(dir, ["checkout", "-q", "feature"]);
  await git(dir, ["rebase", "main"]).catch(() => {
    /* expected: stops with an a.txt conflict at step 1 */
  });
  return { dir };
}

async function openWatcher(dir: string, onChange: () => void): Promise<RepositoryWatcher> {
  const state = await getRepositoryState(dir);
  return watchRepositoryRefs(state.gitDir, state.commonGitDir, onChange, { debounceMs: 150 });
}

describe("watchRepositoryRefs: rebase-merge/rebase-apply directory removal (FR-59/AC11 regression)", () => {
  it("fires onChange when `git rebase --abort` deletes rebase-merge/ entirely", async () => {
    const { dir } = await setupMultiStepConflictingRebase();
    // Sanity: really mid-rebase, conflicted, rebase-merge/ present, before the watcher even opens.
    const preState = await getRepositoryState(dir);
    expect(preState.inProgressOperation).toBe("rebase");

    let changeCount = 0;
    const watcher = await openWatcher(dir, () => {
      changeCount += 1;
    });
    try {
      // Baseline count right before the destructive op, so we only count post-abort fires.
      const before = changeCount;

      await git(dir, ["rebase", "--abort"]);

      const postState = await getRepositoryState(dir);
      expect(postState.inProgressOperation).toBeNull(); // real abort actually completed.

      await waitForChangeCount(() => changeCount, before + 1, 5000, "rebase --abort");
    } finally {
      watcher.close();
    }
  });

  it("fires onChange on the intermediate --continue (rebase-merge/ persists) AND the final --continue (rebase-merge/ is deleted)", async () => {
    const { dir } = await setupMultiStepConflictingRebase();
    const midState = await getRepositoryState(dir);
    expect(midState.inProgressOperation).toBe("rebase");
    const midDetail = midState.inProgressOperationDetail;
    if (midDetail?.kind !== "rebase") throw new Error("expected rebase detail");
    expect(midDetail.currentStep).toBe(1);
    expect(midDetail.totalSteps).toBe(2);

    let changeCount = 0;
    const watcher = await openWatcher(dir, () => {
      changeCount += 1;
    });
    try {
      // --- Step 1: resolve the a.txt conflict and continue (rebase-merge/ persists afterward). ---
      const beforeFirstContinue = changeCount;
      await writeFile(dir, "a.txt", "resolved-a\n");
      await git(dir, ["add", "a.txt"]);
      await git(dir, ["rebase", "--continue"], { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" }).catch(() => {
        /* expected: stops again with the b.txt conflict */
      });

      const afterFirstContinueState = await getRepositoryState(dir);
      expect(afterFirstContinueState.inProgressOperation).toBe("rebase"); // still going — step 2 of 2.
      const afterFirstDetail = afterFirstContinueState.inProgressOperationDetail;
      if (afterFirstDetail?.kind !== "rebase") throw new Error("expected rebase detail");
      expect(afterFirstDetail.currentStep).toBe(2);

      await waitForChangeCount(
        () => changeCount,
        beforeFirstContinue + 1,
        5000,
        "intermediate rebase --continue (rebase-merge/ persists)",
      );

      // --- Step 2 (final): resolve the b.txt conflict and continue — this deletes rebase-merge/. ---
      const beforeFinalContinue = changeCount;
      await writeFile(dir, "b.txt", "resolved-b\n");
      await git(dir, ["add", "b.txt"]);
      await git(dir, ["rebase", "--continue"], { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" });

      const finalState = await getRepositoryState(dir);
      expect(finalState.inProgressOperation).toBeNull(); // rebase genuinely completed.

      await waitForChangeCount(
        () => changeCount,
        beforeFinalContinue + 1,
        5000,
        "final rebase --continue (rebase-merge/ deleted on completion)",
      );
    } finally {
      watcher.close();
    }
  });

  it("does not spin forever / leak an unbounded event storm after rebase-merge/ is removed (debounce settles)", async () => {
    const { dir } = await setupMultiStepConflictingRebase();

    let changeCount = 0;
    const watcher = await openWatcher(dir, () => {
      changeCount += 1;
    });
    try {
      await git(dir, ["rebase", "--abort"]);
      await waitForChangeCount(() => changeCount, 1, 5000, "rebase --abort (storm settle check)");

      // If the stale nested watch were still storming, changeCount would keep climbing well past
      // 1 during this window (each new event doesn't call onChange directly, but a real storm's
      // volume is what previously starved the debounce in the first place — so it should have
      // settled to a small, stable number of fires shortly after the single removal event, not
      // grown further from the same operation).
      const settledCount = changeCount;
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(changeCount).toBe(settledCount);
    } finally {
      watcher.close();
    }
  });
});
