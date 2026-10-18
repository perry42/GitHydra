// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useRef, useState } from "react";
import type { GitHydraApi } from "../../shared/ipcContract";
import { GITHYDRA_TAB_ID, type LaunchTarget, type ProgramsSnapshot } from "../../shared/programsContract";
import type { OpenInProgramModel } from "../lib/openInProgram";
import type { WorktreeNotice } from "../lib/worktreeNotices";
import { visibleText } from "../lib/worktrees";
import { unwrap } from "./gitHydraClient";

export interface UseExternalProgramsOptions {
  api: GitHydraApi;
  /** In-flow banner (specs/worktrees.md FR-634): never a floating toast. */
  notify: (notice: Omit<WorktreeNotice, "id">) => void;
  onManagePrograms: () => void;
}

export interface UseExternalProgramsResult {
  snapshot: ProgramsSnapshot | null;
  /** Re-read the list (a stat per program) when a menu opens. */
  refresh: () => void;
  /** Used by the Programs dialog after it changed something. */
  setSnapshot: (s: ProgramsSnapshot) => void;
  /** FR-617: the model one accordion needs; `openTab` is the GitHydra-tab behaviour of that surface. */
  modelFor: (openTab: () => void, target: LaunchTarget | null) => OpenInProgramModel;
  launch: (programId: string, target: LaunchTarget) => Promise<void>;
  chooseTab: (openTab: () => void) => void;
}

/**
 * specs/external-programs.md FR-617/FR-622/FR-624: the cached program list for every "Open in..." surface, and the launch itself.
 * Choosing a program other than the stored default says so in an in-flow banner and makes it the default ("last used").
 */
export function useExternalPrograms({ api, notify, onManagePrograms }: UseExternalProgramsOptions): UseExternalProgramsResult {
  const [snapshot, setSnapshot] = useState<ProgramsSnapshot | null>(null);
  const snapshotRef = useRef<ProgramsSnapshot | null>(null);
  snapshotRef.current = snapshot;
  const generation = useRef(0);
  const optsRef = useRef({ api, notify, onManagePrograms });
  optsRef.current = { api, notify, onManagePrograms };

  const refresh = useCallback(() => {
    const mine = ++generation.current;
    void (async () => {
      try {
        const next = unwrap(await optsRef.current.api.listExternalPrograms());
        if (mine === generation.current) setSnapshot(next);
      } catch {
        // A failed read keeps the last list: the menu still works, the next open tries again.
      }
    })();
  }, []);

  useEffect(() => {
    refresh();
  }, [api, refresh]);

  const applySnapshot = useCallback((s: ProgramsSnapshot) => {
    generation.current++;
    setSnapshot(s);
  }, []);

  const defaultAnnouncement = (name: string): string => `Opened in ${visibleText(name)}. ${visibleText(name)} is now your default.`;

  const launch = useCallback(async (programId: string, target: LaunchTarget) => {
    const { api: a, notify: say } = optsRef.current;
    const known = snapshotRef.current?.programs.find((p) => p.id === programId);
    try {
      const res = unwrap(await a.launchExternalProgram({ programId, target }));
      if (res.ok) {
        // Optimistic: main stored this program as the default; the next click must not wait for the re-read below.
        generation.current++;
        setSnapshot((prev) => (prev ? { ...prev, defaultId: programId, fallbackReason: null, programs: prev.programs.map((p) => ({ ...p, isDefault: p.id === programId })) } : prev));
        if (!res.wasDefault) say({ tone: "success", text: defaultAnnouncement(res.programName), actions: [] });
        refresh();
        return;
      }
      const name = visibleText(known?.name ?? "The program");
      if (res.reason === "spawn-failed") {
        // FR-622: names the program and its path; nothing is retried.
        say({
          tone: "error",
          text: `Could not start ${name} at ${visibleText(known?.path ?? "its saved path")}. It was not retried.`,
          actions: [{ kind: "managePrograms", label: "Manage programs" }],
        });
      } else {
        say({ tone: "error", text: visibleText(res.message), actions: [{ kind: "managePrograms", label: "Manage programs" }] });
      }
      refresh();
    } catch (err) {
      say({ tone: "error", text: err instanceof Error ? visibleText(err.message) : "The program could not be started.", actions: [] });
    }
  }, [refresh]);

  const chooseTab = useCallback(
    (openTab: () => void) => {
      openTab();
      if (snapshotRef.current?.defaultId === GITHYDRA_TAB_ID) return;
      const { api: a, notify: say } = optsRef.current;
      void (async () => {
        try {
          const res = unwrap(await a.setDefaultExternalProgram(GITHYDRA_TAB_ID));
          if (res.ok) {
            applySnapshot(res.snapshot);
            say({ tone: "success", text: defaultAnnouncement("GitHydra tab"), actions: [] });
          }
        } catch {
          // The tab opened; only the remembered default failed to save.
        }
      })();
    },
    [applySnapshot],
  );

  const modelFor = useCallback(
    (openTab: () => void, target: LaunchTarget | null): OpenInProgramModel => ({
      // Read at call time: a menu that is already open keeps a builder from an earlier render and must still see a newer list.
      snapshot: snapshotRef.current,
      refresh,
      openInTab: () => chooseTab(openTab),
      openInProgram: (id) => {
        if (target) void launch(id, target);
      },
      managePrograms: () => optsRef.current.onManagePrograms(),
    }),
    [refresh, chooseTab, launch],
  );

  return { snapshot, refresh, setSnapshot: applySnapshot, modelFor, launch, chooseTab };
}
