// SPDX-License-Identifier: GPL-3.0-or-later
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";

/**
 * The filesystem seam of the copy engine and the `.worktreeinclude` reader (specs/worktree-copy-ignored.md FR-630, AC 8):
 * tests inject fakes for `lstat`, `open`, `realpath` and `mkdir`. Stats are bigint so Windows file ids keep their precision.
 */

export interface FsStat {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  mode: bigint;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface FsHandle {
  stat(): Promise<FsStat>;
  read(buf: Buffer, offset: number, length: number, position: number | null): Promise<{ bytesRead: number }>;
  write(buf: Buffer, offset: number, length: number): Promise<{ bytesWritten: number }>;
  close(): Promise<void>;
}

export interface CopyFs {
  lstat(p: string): Promise<FsStat>;
  /** Numeric `flags` (O_* constants) so no-follow and exclusive-create are explicit. */
  open(p: string, flags: number, mode?: number): Promise<FsHandle>;
  realpath(p: string): Promise<string>;
  /** Non-recursive. */
  mkdir(p: string, mode?: number): Promise<void>;
  unlink(p: string): Promise<void>;
  /** Remove an EMPTY directory (fails when it is not empty). Optional so older fakes keep working. */
  rmdir?(p: string): Promise<void>;
}

export const realCopyFs: CopyFs = {
  lstat: (p) => fs.lstat(p, { bigint: true }),
  open: async (p, flags, mode) => {
    const h = await fs.open(p, flags, mode);
    return {
      stat: () => h.stat({ bigint: true }),
      read: (buf, offset, length, position) => h.read(buf, offset, length, position),
      write: (buf, offset, length) => h.write(buf, offset, length),
      close: () => h.close(),
    };
  },
  realpath: (p) => fs.realpath(p),
  mkdir: async (p, mode) => {
    await fs.mkdir(p, { recursive: false, mode });
  },
  unlink: (p) => fs.unlink(p),
  rmdir: (p) => fs.rmdir(p),
};

// Lazy: Vite stubs node:fs in the renderer and throws on property reads at module load (CLAUDE.md pitfall).
/** O_NOFOLLOW is undefined on Windows (0 there): callers then re-check realpath after the open. */
export const noFollowFlag = (): number => (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
export const readFlags = (): number => fsConstants.O_RDONLY | noFollowFlag() | ((fsConstants as { O_NONBLOCK?: number }).O_NONBLOCK ?? 0);
/** Exclusive create ('wx'): never overwrites, and never follows a link at the leaf. */
export const createExclusiveFlags = (): number => fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag();

export const errCode = (err: unknown): string => (typeof err === "object" && err !== null && typeof (err as { code?: unknown }).code === "string" ? (err as { code: string }).code : "");

/** Size and mtime always compare; dev/ino too when the platform reports them. */
export function sameFileIdentity(a: Pick<FsStat, "dev" | "ino" | "size" | "mtimeNs">, b: Pick<FsStat, "dev" | "ino" | "size" | "mtimeNs">): boolean {
  if (a.size !== b.size || a.mtimeNs !== b.mtimeNs) return false;
  // Specs FR-643 (L4): size+mtime alone is enough only when the inode is reported as 0 on BOTH sides.
  if ((a.ino === 0n) !== (b.ino === 0n)) return false;
  if (a.ino !== 0n && (a.ino !== b.ino || a.dev !== b.dev)) return false;
  return true;
}
