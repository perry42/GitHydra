// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { listWorktrees } from "./worktreeList";
import { visibleUntrustedText } from "./worktreeParse";
import { toWorktreeError, wtRunAllowing } from "./worktreeRunner";

/**
 * specs/worktrees.md FR-644 (git-core half): is there a `post-checkout` hook that `git worktree add` would run?
 * Read-only; the per-repository trust record lives in the app's main process, never here.
 */

const HOOK_READ_CAP = 1024 * 1024;
const PREVIEW_MAX_LINES = 20;
const PREVIEW_MAX_CHARS = 2000;

export type PostCheckoutHookInfo =
  | { present: false }
  | {
      present: true;
      /** The file git would execute. */
      hookPath: string;
      hooksDir: string;
      /** The raw `core.hooksPath` value (`~` expanded by git), or null when unset. */
      hooksPathConfig: string | null;
      /** A relative `core.hooksPath` resolves inside the NEW worktree at run time; what is read here is the source's copy. */
      hooksPathRelative: boolean;
      contentSha256: string;
      size: number;
      /** Bytes beyond the read cap were not hashed (the size is part of the fingerprint then). */
      truncated: boolean;
      executable: boolean;
      /** sha256 over (hook path, content hash, core.hooksPath value): FR-644's binding for a remembered choice. */
      fingerprint: string;
      /** First lines of the hook, control characters made visible, capped for display. */
      preview: string;
    };

export async function detectPostCheckoutHook(repoPath: string): Promise<PostCheckoutHookInfo> {
  const list = await listWorktrees(repoPath);
  let hooksPathConfig: string | null = null;
  try {
    const r = await wtRunAllowing(["config", "--path", "--get", "core.hooksPath"], repoPath, [0, 1]);
    if (r.exitCode === 0) hooksPathConfig = r.stdout.replace(/\r?\n$/, "") || null;
  } catch (err) {
    throw toWorktreeError("inspect", err);
  }

  const relative = hooksPathConfig !== null && !path.isAbsolute(hooksPathConfig) && !/^[A-Za-z]:[\\/]/.test(hooksPathConfig);
  let hooksDir: string;
  if (hooksPathConfig === null) hooksDir = path.join(list.commonDir, "hooks");
  else if (hooksPathConfig === "~") hooksDir = os.homedir();
  else hooksDir = path.resolve(list.mainPath, hooksPathConfig);

  const hookPath = path.join(hooksDir, "post-checkout");
  let handle: fs.FileHandle;
  try {
    const st = await fs.stat(hookPath);
    if (!st.isFile()) return { present: false };
    handle = await fs.open(hookPath, "r");
  } catch {
    return { present: false };
  }
  try {
    const st = await handle.stat();
    const buf = Buffer.alloc(Math.min(st.size, HOOK_READ_CAP));
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const content = buf.subarray(0, bytesRead);
    const truncated = st.size > HOOK_READ_CAP;
    const hash = createHash("sha256").update(content);
    if (truncated) hash.update(`\0size:${st.size}`);
    const contentSha256 = hash.digest("hex");
    const fingerprint = createHash("sha256")
      .update([hookPath, contentSha256, hooksPathConfig ?? ""].join("\0"))
      .digest("hex");
    const previewText = new TextDecoder().decode(content.subarray(0, PREVIEW_MAX_CHARS));
    const preview = previewText
      .split(/\r?\n/)
      .slice(0, PREVIEW_MAX_LINES)
      .map((line) => visibleUntrustedText(line.replace(/\t/g, "  ")))
      .join("\n");
    return {
      present: true,
      hookPath,
      hooksDir,
      hooksPathConfig,
      hooksPathRelative: relative,
      contentSha256,
      size: st.size,
      truncated,
      executable: process.platform === "win32" ? true : (st.mode & 0o111) !== 0,
      fingerprint,
      preview,
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}
