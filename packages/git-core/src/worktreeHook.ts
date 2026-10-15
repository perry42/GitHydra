// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { listWorktrees } from "./worktreeList";
import { visibleUntrustedText } from "./worktreeParse";
import { toWorktreeError, wrapGit, wtRunAllowing } from "./worktreeRunner";

/**
 * specs/worktrees.md FR-644 (git-core half): is there a `post-checkout` hook that `git worktree add` would run?
 * Read-only; the per-repository trust record lives in the app's main process, never here.
 */

const PREVIEW_READ_BYTES = 64 * 1024;
const PREVIEW_MAX_ROWS = 20;
const PREVIEW_ROW_CHARS = 120;
const READ_CHUNK = 64 * 1024;

export type PostCheckoutHookInfo =
  | { present: false }
  | {
      present: true;
      /** The file git would execute. */
      hookPath: string;
      hooksDir: string;
      /** The raw `core.hooksPath` value (`~` expanded by git), or null when unset. */
      hooksPathConfig: string | null;
      /** A relative `core.hooksPath` resolves inside the NEW worktree at run time: consent cannot be given for it. */
      hooksPathRelative: boolean;
      /** sha256 of the whole file (streamed, no size cap). */
      contentSha256: string;
      size: number;
      executable: boolean;
      /** Names of every OTHER non-.sample file in the hooks dir (they stay disabled while the post-checkout hook runs). */
      otherHooks: string[];
      /**
       * sha256 over (hook path, content hash, executable bit, core.hooksPath value, sorted names of every non-.sample file
       * in the hooks dir): FR-644's binding for a remembered choice and the `expectedHookFingerprint` of `addWorktree`.
       */
      fingerprint: string;
      /** First rows of the hook, escapes made visible, long lines wrapped and space runs collapsed visibly. */
      preview: string;
      /** The preview omits part of the file (more rows than shown, or bytes beyond the preview window). */
      previewTruncated: boolean;
      /** Lines in the whole file. */
      previewLineCount: number;
      /** The head holds NUL bytes or mostly undecodable bytes: not a text script, the preview cannot be trusted to show what runs. */
      previewIsBinary: boolean;
    };

/** Streams the whole file once: sha256, size and line count, plus the first bytes for the preview. */
async function readHook(file: string): Promise<{ sha256: string; size: number; lines: number; head: Buffer; mode: number }> {
  const handle = await fs.open(file, "r");
  try {
    const st = await handle.stat();
    const hash = createHash("sha256");
    const head: Buffer[] = [];
    let headBytes = 0;
    let size = 0;
    let newlines = 0;
    let lastByte = 0x0a;
    const buf = Buffer.alloc(READ_CHUNK);
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, READ_CHUNK, null);
      if (bytesRead === 0) break;
      const chunk = buf.subarray(0, bytesRead);
      hash.update(chunk);
      size += bytesRead;
      for (const b of chunk) if (b === 0x0a) newlines++;
      lastByte = chunk[bytesRead - 1]!;
      if (headBytes < PREVIEW_READ_BYTES) {
        const take = chunk.subarray(0, PREVIEW_READ_BYTES - headBytes);
        head.push(Buffer.from(take));
        headBytes += take.length;
      }
    }
    return { sha256: hash.digest("hex"), size, lines: newlines + (lastByte === 0x0a ? 0 : 1), head: Buffer.concat(head), mode: st.mode };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Escapes made visible, runs of 9+ blanks collapsed to a visible marker, long lines wrapped: nothing hides past a wide gap. */
export function buildHookPreview(head: string, wholeFileShown: boolean): { preview: string; truncated: boolean } {
  const rows: string[] = [];
  let truncated = !wholeFileShown;
  const lines = head.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "" && wholeFileShown) lines.pop();
  outer: for (const raw of lines) {
    const text = visibleUntrustedText(raw.replace(/\t/g, "  ").replace(/ {9,}/g, (m) => `[${m.length} spaces]`));
    if (text === "") {
      if (rows.length >= PREVIEW_MAX_ROWS) {
        truncated = true;
        break;
      }
      rows.push("");
      continue;
    }
    for (let i = 0; i < text.length; i += PREVIEW_ROW_CHARS) {
      if (rows.length >= PREVIEW_MAX_ROWS) {
        truncated = true;
        break outer;
      }
      rows.push(text.slice(i, i + PREVIEW_ROW_CHARS));
    }
  }
  return { preview: rows.join("\n"), truncated };
}

/** NUL bytes, or 10%+ replacement characters after a UTF-8 decode of the head. */
export function looksBinary(head: Buffer): boolean {
  if (head.includes(0)) return true;
  const text = new TextDecoder().decode(head);
  if (text.length === 0) return false;
  let bad = 0;
  for (const ch of text) if (ch === "�") bad++;
  return bad >= 8 && bad / text.length > 0.1;
}

export function detectPostCheckoutHook(repoPath: string): Promise<PostCheckoutHookInfo> {
  return wrapGit("inspect", () => detectCore(repoPath));
}

async function detectCore(repoPath: string): Promise<PostCheckoutHookInfo> {
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
  try {
    const st = await fs.stat(hookPath);
    if (!st.isFile()) return { present: false };
  } catch {
    return { present: false };
  }
  let read: Awaited<ReturnType<typeof readHook>>;
  try {
    read = await readHook(hookPath);
  } catch {
    return { present: false };
  }

  const names: string[] = [];
  try {
    for (const e of await fs.readdir(hooksDir, { withFileTypes: true })) {
      if (!e.isDirectory() && !e.name.endsWith(".sample")) names.push(e.name);
    }
  } catch {
    // unreadable dir: the hook itself was readable, so keep going with what we know
  }
  names.sort();
  const executable = process.platform === "win32" ? true : (read.mode & 0o111) !== 0;
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([hookPath, read.sha256, executable, hooksPathConfig, names]))
    .digest("hex");
  const shown = buildHookPreview(new TextDecoder().decode(read.head), read.size <= PREVIEW_READ_BYTES);
  return {
    present: true,
    hookPath,
    hooksDir,
    hooksPathConfig,
    hooksPathRelative: relative,
    contentSha256: read.sha256,
    size: read.size,
    executable,
    otherHooks: names.filter((n) => n !== "post-checkout"),
    fingerprint,
    preview: shown.preview,
    previewTruncated: shown.truncated,
    previewLineCount: read.lines,
    previewIsBinary: looksBinary(read.head),
  };
}

/**
 * FR-644 consent: a private dir holding ONLY a copy of the consented hook, so no sibling hook (reference-transaction,
 * post-index-change, ...) runs with it. The copy is hashed again so a swap after detection is caught. Caller removes `dir`.
 * Caveat: a hook that finds sibling files through `$0` sees the private dir instead of the original hooks dir.
 */
export function prepareConsentedHooksDir(info: Extract<PostCheckoutHookInfo, { present: true }>): Promise<{ dir: string } | null> {
  return wrapGit("add", () => prepareCore(info));
}

/** Consent dirs still on disk; removed at process exit so a crash or kill cannot leave a copy of a hook behind for long. */
const pendingConsentDirs = new Set<string>();
let exitSweepInstalled = false;

function registerConsentDir(dir: string): void {
  pendingConsentDirs.add(dir);
  if (exitSweepInstalled) return;
  exitSweepInstalled = true;
  process.once("exit", () => {
    for (const d of pendingConsentDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // best-effort only
      }
    }
  });
}

/** Removes a dir made by `prepareConsentedHooksDir` and forgets it. */
export async function releaseConsentDir(dir: string): Promise<void> {
  const real = dir.split("/").join(path.sep);
  pendingConsentDirs.delete(dir);
  await fs.rm(real, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Startup sweep (slice 2 calls it once): removes `githydra-hook-*` consent dirs in the temp dir that are older than
 * `maxAgeMs` and not in use by this process. Returns how many were removed.
 */
export async function sweepStaleConsentDirs(maxAgeMs = 60 * 60 * 1000, tmpDir: string = os.tmpdir()): Promise<number> {
  let removed = 0;
  let names: string[];
  try {
    names = await fs.readdir(tmpDir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.startsWith("githydra-hook-")) continue;
    const full = path.join(tmpDir, name);
    if ([...pendingConsentDirs].some((d) => path.resolve(d) === path.resolve(full))) continue;
    try {
      const st = await fs.lstat(full);
      if (!st.isDirectory() || st.isSymbolicLink() || Date.now() - st.mtimeMs < maxAgeMs) continue;
      // On a shared POSIX temp dir another user's folder is none of ours to delete.
      if (typeof process.getuid === "function" && st.uid !== process.getuid()) continue;
      await fs.rm(full, { recursive: true, force: true });
      removed++;
    } catch {
      // someone else's or already gone: leave it
    }
  }
  return removed;
}

async function prepareCore(info: Extract<PostCheckoutHookInfo, { present: true }>): Promise<{ dir: string } | null> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "githydra-hook-"));
  const portable = dir.split("\\").join("/");
  registerConsentDir(portable);
  const target = path.join(dir, "post-checkout");
  try {
    await fs.copyFile(info.hookPath, target);
    if (process.platform !== "win32") await fs.chmod(target, info.executable ? 0o755 : 0o644);
    const copy = await readHook(target);
    if (copy.sha256 !== info.contentSha256) {
      await releaseConsentDir(portable);
      return null;
    }
    return { dir: portable };
  } catch (err) {
    await releaseConsentDir(portable);
    throw err;
  }
}
