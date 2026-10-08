// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from "react";
import type { GitHydraApi } from "../../shared/ipcContract";

export type EditEligibility =
  | { status: "none" }
  | { status: "pending" }
  | { status: "eligible"; hasStagedContent: boolean }
  | { status: "ineligible"; reason: string };

/**
 * specs/edit-in-diff.md FR-468: can the open file be edited? Asks the main process (git-core's probe) whenever the path
 * changes or the working tree was re-read; the previous answer stays up meanwhile so the Edit button never flickers.
 * A failed probe is shown as the reason rather than hidden (disabled + reason, never absent).
 */
export function useEditEligibility(api: GitHydraApi, path: string | null, revision: number | undefined): EditEligibility {
  const [state, setState] = useState<{ path: string | null; value: EditEligibility }>({ path: null, value: { status: "none" } });

  useEffect(() => {
    if (path === null) {
      setState({ path: null, value: { status: "none" } });
      return;
    }
    let stale = false;
    setState((prev) => (prev.path === path ? prev : { path, value: { status: "pending" } }));
    void (async () => {
      let value: EditEligibility;
      try {
        const r = await api.probeEditableFile(path);
        if (!r.ok) value = { status: "ineligible", reason: r.message };
        else if (!r.data.eligible) value = { status: "ineligible", reason: r.data.message };
        else value = { status: "eligible", hasStagedContent: r.data.hasStagedContent };
      } catch (e) {
        value = { status: "ineligible", reason: e instanceof Error ? e.message : "Could not check this file" };
      }
      if (!stale) setState({ path, value });
    })();
    return () => {
      stale = true;
    };
  }, [api, path, revision]);

  return state.path === path ? state.value : path === null ? { status: "none" } : { status: "pending" };
}
