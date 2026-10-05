// SPDX-License-Identifier: GPL-3.0-or-later
import { createRef, useCallback, useRef, useState, type RefObject } from "react";
import { render } from "@testing-library/react";
import type { WorkingDirectoryChanges, WorkingDirectoryFileChange } from "@githydra/git-core";
import { ChangesPanel, type ChangesPanelHandle, type ChangesPanelProps } from "../components/ChangesPanel/ChangesPanel";
import { makeMockGitHydra } from "./mockGitHydra";
import type { GitHydraApi } from "../../shared/ipcContract";

/**
 * specs/ignore-and-multiselect.md tests: plays `useRepositoryGraph`'s part for ChangesPanel. It owns `changes`, re-reads it
 * from the (stateful) mock when the panel reports a mutation, and lets a test push an "external" change with `ctl.read`.
 */
export interface PanelControl {
  read: (next: WorkingDirectoryChanges) => void;
}

export const file = (
  path: string,
  category: WorkingDirectoryFileChange["category"],
  status: WorkingDirectoryFileChange["status"] = "modified",
): WorkingDirectoryFileChange => ({ path, category, status });

export const list = (p: Partial<WorkingDirectoryChanges>): WorkingDirectoryChanges => ({
  staged: [],
  unstaged: [],
  untracked: [],
  conflicted: [],
  ...p,
});

function Harness({
  api,
  initial,
  ctl,
  panelRef,
  ...rest
}: {
  api: GitHydraApi;
  initial: WorkingDirectoryChanges;
  ctl: { current: PanelControl | null };
  panelRef: RefObject<ChangesPanelHandle | null>;
} & Omit<
  ChangesPanelProps,
  "changes" | "liveRevision" | "api"
>) {
  const [changes, setChanges] = useState(initial);
  const [rev, setRev] = useState(0);
  const onChangedProp = useRef(rest.onWorkingDirChanged);
  onChangedProp.current = rest.onWorkingDirChanged;
  ctl.current = {
    read: (next) => {
      setChanges(next);
      setRev((r) => r + 1);
    },
  };
  const refetch = useCallback(() => {
    void api.getWorkingDirectoryChanges().then((r) => {
      if (r.ok && r.data) {
        setChanges(r.data);
        setRev((n) => n + 1);
      }
    });
  }, [api]);
  return (
    <ChangesPanel
      {...rest}
      ref={panelRef}
      api={api}
      changes={changes}
      liveRevision={rev}
      onWorkingDirChanged={() => {
        refetch();
        onChangedProp.current();
      }}
    />
  );
}

export function mountPanel(
  initial: WorkingDirectoryChanges,
  extra: Partial<ChangesPanelProps> = {},
  apiOptions: Parameters<typeof makeMockGitHydra>[0] = {},
) {
  const api = makeMockGitHydra({ workingDirectoryChanges: initial, ...apiOptions });
  const ctl: { current: PanelControl | null } = { current: null };
  const panelRef = createRef<ChangesPanelHandle>();
  const view = render(
    <Harness
      api={api}
      initial={initial}
      ctl={ctl}
      panelRef={panelRef}
      onClose={() => {}}
      onWorkingDirChanged={() => {}}
      onCommitCreated={() => {}}
      {...extra}
    />,
  );
  return { api, ctl, panelRef, ...view };
}
