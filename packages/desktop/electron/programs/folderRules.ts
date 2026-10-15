// SPDX-License-Identifier: GPL-3.0-or-later
import * as path from "node:path";
import type { Platform } from "./types";

export interface FolderFs {
  platform: Platform;
  realpath(p: string): Promise<string>;
  isDirectory(p: string): Promise<boolean>;
}

/** UNC, `\\?\UNC`, `\\?\` and `\\.\` forms; touching one can trigger SMB/NTLM traffic (FR-622). */
export const looksLikeNetworkOrDevicePath = (p: string): boolean => /^(\\\\|\/\/)/.test(p);

/**
 * specs/external-programs.md FR-622: the folder handed to a program is a realpath'd, absolute directory, never a network path.
 * Main passes only folders it derived itself (a verified worktree or the open repository's top level); this is the last check.
 */
export async function resolveLaunchFolder(candidate: string, fs: FolderFs): Promise<string | null> {
  if (typeof candidate !== "string" || candidate === "" || candidate.includes("\0")) return null;
  if (looksLikeNetworkOrDevicePath(candidate)) return null;
  const absolute = fs.platform === "win32" ? /^[A-Za-z]:[\\/]/.test(candidate) : path.posix.isAbsolute(candidate);
  if (!absolute) return null;
  try {
    const real = await fs.realpath(candidate);
    if (looksLikeNetworkOrDevicePath(real) || real.startsWith("-")) return null;
    return (await fs.isDirectory(real)) ? real : null;
  } catch {
    return null;
  }
}
