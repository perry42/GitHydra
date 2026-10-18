// SPDX-License-Identifier: GPL-3.0-or-later
import { detectLinux } from "./detectLinux";
import { detectMac } from "./detectMac";
import { detectWindows } from "./detectWindows";
import type { DetectedProgram, DetectEnv } from "./types";

/** FR-621: the one place the platform picks a detector; the detectors themselves read no process global. */
export async function detectPrograms(env: DetectEnv): Promise<DetectedProgram[]> {
  try {
    if (env.platform === "win32") return await detectWindows(env);
    if (env.platform === "darwin") return await detectMac(env);
    return await detectLinux(env);
  } catch {
    return [];
  }
}
