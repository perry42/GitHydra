// SPDX-License-Identifier: GPL-3.0-or-later
import { killLeakedApps } from "./helpers/processTree";

/** Safety net for specs that aborted before their own closeApp ran; see helpers/processTree.ts for what is (not) killed. */
export default async function globalTeardown(): Promise<void> {
  const killed = killLeakedApps(process.pid);
  if (killed.length) console.warn(`[globalTeardown] killed ${killed.length} leaked Electron app(s): ${killed.join(", ")}`);
}
