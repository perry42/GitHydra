// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useMemo, useState } from "react";
import type { LocalBranchInfo, RemoteBranchInfo, WorktreeEntry, WorktreeList } from "@githydra/git-core";
import type { GitHydraApi } from "../../../shared/ipcContract";
import { unwrap } from "../../hooks/gitHydraClient";
import type { WorktreePickerMode } from "../../hooks/useWorktreeActions";
import { COPY_PALETTE_LABEL, copyIntoReason, findSourceEntry, folderName, pickerSubLine } from "../../lib/worktreeCopyExisting";
import { describeWorktree, visibleText, worktreeName } from "../../lib/worktrees";
import { WorktreePicker, type WorktreePickerItem } from "./WorktreePicker";

export interface WorktreePickerHostProps {
  mode: WorktreePickerMode;
  api: GitHydraApi;
  list: WorktreeList | null;
  onCreateForBranch: (branch: string) => void;
  onCreateForRemote: (remote: string, branch: string) => void;
  onOpen: (entry: WorktreeEntry) => void;
  /** specs/external-programs.md FR-617: Right arrow in Open mode. */
  onChooseProgram?: (entry: WorktreeEntry) => void;
  /** What Enter does in Open mode (the default program), shown under the list. */
  openHint?: string;
  onRemove: (entry: WorktreeEntry) => void;
  onClose: () => void;
  /** Called instead of `onClose` once a row was picked (the action that follows owns the focus). Defaults to `onClose`. */
  onPicked?: () => void;
  /** specs/worktree-copy-ignored.md FR-656 ("copyInto" mode): the active tab's path, which is the source and is left out of the list. */
  activePath?: string | null;
  onCopyInto?: (entry: WorktreeEntry) => void;
  /** Esc in "copyInto" mode: back to the command list. */
  onBack?: () => void;
}

const TITLES: Record<WorktreePickerMode, { title: string; placeholder: string; empty: string }> = {
  createFromBranch: { title: "Worktree: Create from branch", placeholder: "Create a worktree from which branch?", empty: "No branches match" },
  open: { title: "Worktree: Open", placeholder: "Open which worktree?", empty: "No worktrees match" },
  remove: { title: "Worktree: Remove", placeholder: "Remove which worktree?", empty: "No worktrees match" },
  copyInto: { title: COPY_PALETTE_LABEL, placeholder: "Choose a worktree", empty: "No worktrees match" },
};

/** specs/worktrees.md FR-607: the three palette pickers. Unavailable rows are listed with their reason (never silently dropped). */
export function WorktreePickerHost({ mode, api, list, onCreateForBranch, onCreateForRemote, onOpen, onChooseProgram, openHint, onRemove, onClose, onPicked, activePath = null, onCopyInto, onBack }: WorktreePickerHostProps) {
  const [branches, setBranches] = useState<{ local: LocalBranchInfo[]; remote: RemoteBranchInfo[] } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== "createFromBranch") return;
    let cancelled = false;
    void (async () => {
      try {
        const [local, remote] = await Promise.all([api.listBranches(), api.listRemoteBranches()]);
        if (!cancelled) setBranches({ local: unwrap(local), remote: unwrap(remote) });
      } catch (err) {
        if (!cancelled) setLoadError(`Could not load branches: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, mode]);

  const { items, byKey } = useMemo(() => {
    const out: WorktreePickerItem[] = [];
    const entries = new Map<string, WorktreeEntry>();
    if (mode === "createFromBranch") {
      const hasWorktree = new Set((list?.entries ?? []).map((e) => e.branch).filter((b): b is string => b !== null));
      for (const b of branches?.local ?? []) {
        const at = list?.entries.find((e) => e.branch === b.name)?.path ?? b.checkedOutInWorktree;
        out.push({
          key: `local:${b.name}`,
          label: visibleText(b.name),
          disabledReason: b.isCurrent
            ? "This is the current branch; it cannot get a second worktree."
            : hasWorktree.has(b.name) || b.checkedOutInWorktree
              ? `Checked out at ${visibleText(at ?? "another worktree")}`
              : null,
        });
      }
      const localNames = new Set((branches?.local ?? []).map((b) => b.name));
      for (const r of branches?.remote ?? []) {
        if (localNames.has(r.name) || r.name === "HEAD") continue;
        out.push({ key: `remote:${r.remoteName}:${r.name}`, label: `${visibleText(r.remoteName)}/${visibleText(r.name)}`, secondary: "Creates a local tracking branch", disabledReason: null });
      }
    } else if (mode === "copyInto" && list) {
      // FR-656: the source is left out (not shown disabled); refused destinations stay listed with their FR-650 reason.
      const source = findSourceEntry(list, activePath);
      for (const e of list.entries) {
        if (e.isBare || (source && source.id === e.id)) continue;
        const key = e.id ?? "main";
        entries.set(key, e);
        out.push({ key, label: worktreeName(e), secondary: pickerSubLine(e), disabledReason: copyIntoReason(e, { source, list }) });
      }
    } else {
      for (const e of list?.entries ?? []) {
        if (e.isBare) continue;
        const row = describeWorktree(e, list?.untrusted ?? false);
        const key = e.id ?? "main";
        entries.set(key, e);
        out.push({ key, label: row.name, secondary: row.path, disabledReason: mode === "open" ? row.openReason : row.removeReason });
      }
    }
    return { items: out, byKey: entries };
  }, [mode, branches, list, activePath]);

  const copy = TITLES[mode];
  const sourceFolder = list && mode === "copyInto" ? folderName(findSourceEntry(list, activePath)?.path ?? activePath ?? list.mainPath) : "";
  return (
    <WorktreePicker
      title={copy.title}
      placeholder={copy.placeholder}
      emptyText={copy.empty}
      items={items}
      loading={mode === "createFromBranch" && branches === null && loadError === null}
      loadError={loadError}
      onClose={onClose}
      footerHint={mode === "open" ? openHint : undefined}
      {...(mode === "copyInto"
        ? {
            contextLine: `Copy ignored files from ${visibleText(sourceFolder)} into which worktree?`,
            listLabel: "Worktrees",
            footerHints: ["Up Down move", "Enter choose", "Esc back"],
            silentDisabled: true,
            stackedRows: true,
            onEscape: onBack,
          }
        : {})}
      onChoose={
        mode === "open" && onChooseProgram
          ? (key) => {
              const entry = byKey.get(key);
              if (entry) {
                onChooseProgram(entry);
                (onPicked ?? onClose)();
              }
            }
          : undefined
      }
      onPick={(key) => {
        if (key.startsWith("local:")) onCreateForBranch(key.slice("local:".length));
        else if (key.startsWith("remote:")) {
          const rest = key.slice("remote:".length);
          const cut = rest.indexOf(":");
          onCreateForRemote(rest.slice(0, cut), rest.slice(cut + 1));
        } else {
          const entry = byKey.get(key);
          if (entry) {
            if (mode === "open") onOpen(entry);
            else if (mode === "copyInto") onCopyInto?.(entry);
            else onRemove(entry);
          }
        }
        (onPicked ?? onClose)();
      }}
    />
  );
}
