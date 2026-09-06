// SPDX-License-Identifier: GPL-3.0-or-later
/// <reference types="vite/client" />
import type { GitHydraApi } from "../shared/ipcContract";

declare global {
  interface Window {
    gitHydra: GitHydraApi;
  }
}

export {};
