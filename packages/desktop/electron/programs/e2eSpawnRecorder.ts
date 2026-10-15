// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import * as path from "node:path";
import type { ChildLike, SpawnFn } from "./launcher";

/** The one env var that swaps the real spawn for a recorder. Test-only: see `chooseSpawnFn`. */
export const E2E_SPAWN_RECORD_ENV = "GITHYDRA_E2E_SPAWN_RECORD";

/**
 * Appends one JSON line per would-be launch (command, argv, the option values that matter) instead of starting a process, so a
 * real-Electron spec can assert the argv without opening an editor. specs/external-programs.md AC9.
 */
export function createSpawnRecorder(file: string): SpawnFn {
  return (command, args, options) => {
    const env = (options.env ?? {}) as Record<string, string>;
    const line = JSON.stringify({
      command,
      args,
      shell: options.shell,
      detached: options.detached,
      stdio: options.stdio,
      cwd: options.cwd,
      droppedKeysPresent: Object.keys(env).filter((k) => /^(ELECTRON_|NODE_|GIT_)/i.test(k)),
    });
    appendFileSync(file, `${line}\n`, "utf8");
    const child: ChildLike = { unref: () => undefined };
    return child;
  };
}

/**
 * Honoured ONLY for an unpackaged app AND an explicit absolute path in `GITHYDRA_E2E_SPAWN_RECORD`; a packaged build always uses
 * the real `spawn`, whatever the environment says (a user's shell can never turn launches into file writes).
 */
export function chooseSpawnFn(opts: { isPackaged: boolean; env: Record<string, string | undefined> }): SpawnFn {
  const file = opts.env[E2E_SPAWN_RECORD_ENV];
  if (!opts.isPackaged && typeof file === "string" && path.isAbsolute(file)) return createSpawnRecorder(file);
  return (command, args, options) => spawn(command, args, options);
}
