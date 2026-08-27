import type { GitHydraApi, IpcResult } from "../../shared/ipcContract";

/** Thin, mockable seam over `window.gitHydra` (exposed by preload.ts via contextBridge) — lets
 * component/hook tests inject a fake implementation instead of requiring a real Electron host. */
export function getGitHydraApi(): GitHydraApi {
  if (typeof window === "undefined" || !window.gitHydra) {
    throw new Error(
      "window.gitHydra is not available — this must run inside GitHydra's Electron preload " +
        "bridge (or a test must stub window.gitHydra before rendering).",
    );
  }
  return window.gitHydra;
}

export class GitHydraIpcError extends Error {
  constructor(public readonly errorName: string, message: string) {
    super(message);
    this.name = errorName;
  }
}

export function unwrap<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new GitHydraIpcError(result.error.name, result.error.message);
  return result.data;
}
