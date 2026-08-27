import { builtinModules } from "node:module";
import { defineConfig } from "vite";

// Main-process/preload build. Both electron/main.ts and electron/preload.ts pull in
// shared/ipcContract.ts (and main.ts additionally pulls in electron/repoSession.ts) via bare
// relative imports. Bundling them (instead of plain `tsc`, which just mirrors the source
// folder structure 1:1 into dist-electron/electron/*.js + dist-electron/shared/*.js) does two
// things at once:
//
//   1. Flattens output to dist-electron/main.js and dist-electron/preload.js, matching what
//      package.json's "main" field and main.ts's own loadFile()/preload path.join() calls
//      already assume.
//   2. Produces fully self-contained single-file output with no cross-file `require(...)`.
//      This is load-bearing for preload.js specifically: BrowserWindow is created with
//      `sandbox: true` (intentional — see main.ts), and Electron's sandboxed preload context
//      cannot resolve bare relative requires to sibling files the way a normal Node CJS module
//      graph can. An unbundled multi-file preload silently fails to load under sandbox: true,
//      window.gitHydra never gets defined, and the renderer is left with a blank/broken screen.
//
// main.ts and preload.ts are built via two SEPARATE `vite build` invocations (see package.json's
// build:electron / dev:electron scripts, which pass --mode main / --mode preload), not one build
// with two lib.entry entries. A single multi-entry rollup/rolldown build extracts code shared
// between entries (here, shared/ipcContract.ts) into a separate common chunk that each entry
// then `require()`s by filename — which reintroduces the exact cross-file-require problem this
// config exists to avoid, specifically breaking the sandboxed preload again. Building each entry
// in its own isolated rollup graph forces everything to inline into that one file instead.
//
// electron/main.ts and shared/ipcContract.ts must stay free of anything that can't run in
// Node — this config does not transform them into browser code, just bundles+downlevels them.
const nodeBuiltins = [...builtinModules, ...builtinModules.map((mod) => `node:${mod}`)];

export default defineConfig(({ mode }) => {
  const entryName = mode === "preload" ? "preload" : "main";

  return {
    root: import.meta.dirname,
    build: {
      outDir: "dist-electron",
      // Only the first of the two invocations (main) should clear dist-electron; the second
      // (preload) must not wipe out the main.js the first invocation just produced.
      emptyOutDir: entryName === "main",
      target: "node18",
      minify: false,
      sourcemap: true,
      lib: {
        entry: `electron/${entryName}.ts`,
        formats: ["cjs"],
        fileName: () => `${entryName}.js`,
      },
      rollupOptions: {
        // "electron" is provided by the Electron runtime itself (including inside the
        // sandboxed preload context). "@githydra/git-core" is a real npm workspace dependency
        // resolved from node_modules at runtime by the (non-sandboxed) main process — no need
        // to bundle it, and bundling it would duplicate its own git-shelling logic for no
        // benefit.
        external: ["electron", "@githydra/git-core", ...nodeBuiltins],
      },
    },
  };
});
