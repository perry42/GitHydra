import * as os from "node:os";
import { defineConfig } from "vitest/config";

// ROADMAP.md's "git-core test suite is flaky under full parallel load" entry: running all ~30
// test files at once, each spawning many real git.exe child processes, saturates process
// creation + disk I/O on Windows and produces spurious timeouts/EBUSY races that never
// reproduce when a file is run in isolation. Capping how many test files run concurrently
// (rather than relying on vitest's own CPU-count-based default) trades a bit of wall-clock time
// for a lot less contention. Half the available cores, floor of 2, is a deliberately
// conservative starting point — this file exists specifically because "just parallelize on
// every core" was the failure mode.
const maxWorkers = Math.max(2, Math.floor(os.cpus().length / 2));

export default defineConfig({
  test: {
    // Each test shells out to real `git` a handful (sometimes several dozen) of times to
    // build fixture repos. Process-spawn overhead on Windows in particular makes the vitest
    // default (5s) too tight for fixture-heavy tests, and the heaviest suites (commitLog,
    // noNetworkCalls, watcher, cherryPick, stash — see ROADMAP.md) need even more headroom
    // under full-suite contention than a single file run in isolation ever does. Individual
    // `it(...)` calls in those files must not pass an explicit timeout lower than this value —
    // doing so silently shadows this default back down and reintroduces the exact timeouts this
    // config bump is meant to fix (this happened once: several `watcher.test.ts`/
    // `noNetworkCalls.test.ts` tests had explicit 10s/15s overrides left over from before this
    // default was raised).
    // Observed directly while measuring this fix: this dev machine routinely runs other,
    // unrelated processes concurrently (other agent worktrees' own builds/test runs — see
    // CLAUDE.md's/the team's "concurrent agent worktrees" note), so contention isn't only this
    // suite's own file/worker parallelism — it can also come from entirely external load this
    // config has no control over. 90s gives the heaviest suites (e.g. `commitLog.test.ts`'s ~50
    // sequential real `git commit` invocations, which measured 70-80s under just moderate
    // self-inflicted contention) headroom against that external variance too, not just this
    // suite's own worst case.
    testTimeout: 90000,
    hookTimeout: 90000,
    // Vitest 4 moved pool concurrency options to this pool-agnostic top-level field (the old
    // `poolOptions.forks.maxForks` is deprecated — see the migration guide linked in vitest's own
    // warning if this regresses). `maxWorkers` directly, not `poolOptions`.
    maxWorkers,
  },
});
