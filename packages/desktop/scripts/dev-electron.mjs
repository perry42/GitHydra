// Runs the main.ts and preload.ts watch builds (see vite.config.electron.mts for why they are
// two separate `vite build` invocations rather than one multi-entry build) concurrently, without
// pulling in an extra "run things in parallel" npm dependency for a single dev-only script.
// Plain Node child_process keeps this portable across Windows/macOS/Linux shells.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const desktopRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const modes = ["main", "preload"];
const children = modes.map((mode) =>
  spawn(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["vite", "build", "--config", "vite.config.electron.mts", "--mode", mode, "--watch"],
    { cwd: desktopRoot, stdio: "inherit", shell: false },
  ),
);

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill();
  process.exit(code);
}

for (const child of children) {
  child.on("exit", (code) => shutdown(code ?? 0));
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
