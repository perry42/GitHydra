// SPDX-License-Identifier: GPL-3.0-or-later
import { rmdirSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

let emptyHooksDir: Promise<string> | null = null;
let exitHookInstalled = false;
const created: string[] = [];

/**
 * A private empty dir to point core.hooksPath at: `/dev/null` resolves against the drive root on Windows.
 * Shared by partialStaging (FR-456) and worktree add/remove/branch delete (specs/worktrees.md FR-638).
 *
 * The cached dir is re-checked before every use (a temp cleaner may have removed it, or on a shared POSIX temp dir
 * someone else may have replaced it) and recreated unless it is a directory owned by this user. The path appears in the
 * argv of the git process, so it is visible in the process list; it holds nothing secret.
 */
export function getEmptyHooksDir(): Promise<string> {
  const create = (): Promise<string> =>
    fs.mkdtemp(path.join(os.tmpdir(), "githydra-nohooks-")).then((dir) => {
      created.push(dir);
      if (!exitHookInstalled) {
        exitHookInstalled = true;
        process.once("exit", () => {
          for (const d of created) {
            try {
              rmdirSync(d);
            } catch {
              // best-effort cleanup only
            }
          }
        });
      }
      return dir.split("\\").join("/");
    });
  const fresh = (): Promise<string> => {
    const next = create();
    emptyHooksDir = next;
    next.catch(() => {
      if (emptyHooksDir === next) emptyHooksDir = null;
    });
    return next;
  };
  if (!emptyHooksDir) return fresh();
  const cached = emptyHooksDir;
  return cached.then(async (dir) => {
    try {
      const st = await fs.lstat(dir);
      const uid = typeof process.getuid === "function" ? process.getuid() : null;
      if (st.isDirectory() && !st.isSymbolicLink() && (uid === null || st.uid === uid)) return dir;
    } catch {
      // missing: recreate below
    }
    if (emptyHooksDir === cached) emptyHooksDir = null;
    return emptyHooksDir ?? fresh();
  });
}
