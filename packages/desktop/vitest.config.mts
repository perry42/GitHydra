import { defineConfig, configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: true,
    globals: false,
    // `e2e-playwright/**/*.spec.ts` (test-agent's Playwright coverage, playwright.config.ts) uses
    // `@playwright/test`'s own `test`/`expect`, launches real Electron processes, and depends on
    // `playwright.config.ts`'s `webServer` — none of which exist under Vitest. Vitest's default
    // include pattern matches `*.spec.ts` too, so without this exclude it tries (and fails) to
    // collect those files as if they were Vitest tests. Run via `npm run test:e2e:playwright`
    // instead (a separate `playwright test` invocation), never `npm test`.
    exclude: [...configDefaults.exclude, "e2e-playwright/**"],
  },
});
