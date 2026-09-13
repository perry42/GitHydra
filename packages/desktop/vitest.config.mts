import * as os from "node:os";
import { defineConfig, configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";

// ROADMAP.md's "git-core test suite is flaky under full parallel load" entry (confirmed to also
// affect this package's real-backend e2e suite — `App.cherryPick.e2e.test.tsx`,
// `App.stash.e2e.test.tsx`, `App.restoreTabs.e2e.test.tsx`, `App.amendNetwork.e2e.test.tsx`,
// `App.repoOpenElapsed.test.tsx` all intermittently timed out under the full ~87-file parallel
// suite and passed reliably in isolation): capping concurrent test files trades some wall-clock
// time for a lot less real-git.exe-spawn / jsdom-under-CPU-load contention. Same conservative
// half-the-cores/floor-2 heuristic as `packages/git-core/vitest.config.mts`.
const maxWorkers = Math.max(2, Math.floor(os.cpus().length / 2));

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: true,
    globals: false,
    // Vitest's own default (5s) is too tight even for plain jsdom/React tests once the whole
    // suite is under contention (e.g. `App.repoOpenElapsed.test.tsx` has no per-test override of
    // its own and was timing out for exactly this reason), and the real-git.exe e2e specs above
    // already carry their own higher per-test overrides (25s-50s) for the same load reasons — this
    // is just the floor every other test in the suite now also gets.
    // See `packages/git-core/vitest.config.mts`'s longer comment on this same value: this dev
    // machine can have other, unrelated processes (other agent worktrees' own builds/test runs)
    // competing for the same cores, so headroom needs to cover more than just this suite's own
    // internal contention.
    testTimeout: 45000,
    hookTimeout: 45000,
    // Vitest 4 moved pool concurrency options to this pool-agnostic top-level field (the old
    // `poolOptions.forks.maxForks` is deprecated) — see `packages/git-core/vitest.config.mts` for
    // the same setting and full rationale.
    maxWorkers,
    // `e2e-playwright/**/*.spec.ts` (test-agent's Playwright coverage, playwright.config.ts) uses
    // `@playwright/test`'s own `test`/`expect`, launches real Electron processes, and depends on
    // `playwright.config.ts`'s `webServer` — none of which exist under Vitest. Vitest's default
    // include pattern matches `*.spec.ts` too, so without this exclude it tries (and fails) to
    // collect those files as if they were Vitest tests. Run via `npm run test:e2e:playwright`
    // instead (a separate `playwright test` invocation), never `npm test`.
    exclude: [...configDefaults.exclude, "e2e-playwright/**"],
  },
});
