// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from "react";
import type { ConflictSides } from "@githydra/git-core";
import type { GitHydraApi } from "../../shared/ipcContract";
import { sideNamesFromLabels, type SideNames } from "../lib/conflictModel";
import { unwrap } from "./gitHydraClient";

export interface ConflictEditorContext {
  status: "idle" | "loading" | "ready";
  names: SideNames;
  /** FR-559: stages 2 and 3 are readable text; otherwise Yours/Incoming/Both are disabled with `sidesReason`. */
  sidesOk: boolean;
  sidesReason: string;
  /** The path is not (or no longer) unmerged: fall back to the ordinary editor. */
  notUnmerged: boolean;
}

const IDLE: ConflictEditorContext = { status: "idle", names: sideNamesFromLabels(null), sidesOk: true, sidesReason: "", notUnmerged: false };

const SIDE_REASON = "The original sides could not be read (missing, binary or over the size limit). Edit the text by hand.";

/** FR-559: the FR-61 side names and the stage readability, read once per open while the merge is in progress. */
export function useConflictEditorContext(api: GitHydraApi, path: string, enabled: boolean): ConflictEditorContext {
  const [ctx, setCtx] = useState<ConflictEditorContext>(IDLE);
  useEffect(() => {
    if (!enabled) {
      setCtx(IDLE);
      return;
    }
    let cancelled = false;
    setCtx({ ...IDLE, status: "loading" });
    void (async () => {
      const [labels, sides] = await Promise.all([
        api.getConflictSideLabels().then(unwrap).catch(() => null),
        api.readConflictSides(path).then(unwrap).catch(() => undefined) as Promise<ConflictSides | null | undefined>,
      ]);
      if (cancelled) return;
      const names = sideNamesFromLabels(labels);
      if (sides === null) return setCtx({ ...IDLE, status: "ready", names, notUnmerged: true });
      const ok = sides !== undefined && sides.ours.status === "ok" && sides.theirs.status === "ok";
      setCtx({ status: "ready", names, sidesOk: ok, sidesReason: ok ? "" : SIDE_REASON, notUnmerged: false });
    })();
    return () => {
      cancelled = true;
    };
  }, [api, path, enabled]);
  return ctx;
}
