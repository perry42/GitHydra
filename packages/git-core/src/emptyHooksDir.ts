// SPDX-License-Identifier: GPL-3.0-or-later
import { rmdirSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

let emptyHooksDir: Promise<string> | null = null;

/**
 * A private empty dir to point core.hooksPath at: `/dev/null` resolves against the drive root on Windows.
 * Shared by partialStaging (FR-456) and worktree add (specs/worktrees.md FR-638).
 */
export function getEmptyHooksDir(): Promise<string> {
  emptyHooksDir ??= fs.mkdtemp(path.join(os.tmpdir(), "githydra-nohooks-")).then(
    (dir) => {
      process.once("exit", () => {
        try {
          rmdirSync(dir);
        } catch {
          // best-effort cleanup only
        }
      });
      return dir.split("\\").join("/");
    },
    (err) => {
      emptyHooksDir = null;
      throw err;
    },
  );
  return emptyHooksDir;
}
