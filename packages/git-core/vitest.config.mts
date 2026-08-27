import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each test shells out to real `git` a handful (sometimes several dozen) of times to
    // build fixture repos. Process-spawn overhead on Windows in particular makes the vitest
    // default (5s) too tight for fixture-heavy tests.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
