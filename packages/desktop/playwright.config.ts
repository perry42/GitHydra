import { defineConfig } from "@playwright/test";

/**
 * Playwright coverage (test-agent's gap-closing plan) — deliberately separate from the Vitest
 * suite (`vitest.config.mts`/`npm test`), which is jsdom-only and can never exercise a real
 * Electron `contextBridge`/`ipcMain` transport, a real `BrowserWindow`, or real browser pixels.
 * Run via `npm run test:e2e:playwright` (see package.json) — that script runs `npm run build`
 * first, since:
 *   - `e2e-playwright/electron/*.spec.ts` launch the REAL built app (`dist-electron/main.js` +
 *     `dist-electron/preload.js` + `dist/index.html`), not source TS — Electron's `sandbox: true`
 *     preload requires the bundled single-file output (see `vite.config.electron.mts`'s own doc
 *     comment), and there is no dev-mode equivalent worth reproducing here.
 *   - `e2e-playwright/browser/*.spec.ts` render a small test-only harness
 *     (`src/test/playwrightHarness/harness.html`) through the Vite dev server (started below via
 *     `webServer`) in a real Chromium browser — this one doesn't need the Electron build at all,
 *     but shares this config/`webServer` for simplicity of a single `playwright test` invocation.
 *
 * Two projects, matched by directory, since they need different Playwright "modes" (Electron's
 * own `_electron` launcher takes full control of browser/page lifecycle itself; the browser
 * project uses Playwright's ordinary `page` fixture against `webServer`'s dev server).
 */
export default defineConfig({
  testDir: "./e2e-playwright",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  webServer: {
    command: "npm run dev:renderer",
    url: "http://localhost:5173/index.html",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [
    {
      name: "electron",
      testDir: "./e2e-playwright/electron",
    },
    {
      name: "browser",
      testDir: "./e2e-playwright/browser",
      use: {
        baseURL: "http://localhost:5173",
      },
    },
  ],
});
