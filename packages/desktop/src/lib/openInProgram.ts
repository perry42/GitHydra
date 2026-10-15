// SPDX-License-Identifier: GPL-3.0-or-later
import { GITHYDRA_TAB_ID, type ProgramsSnapshot } from "../../shared/programsContract";
import type { ContextMenuAccordionChild, ContextMenuItem } from "../components/ContextMenu/ContextMenu";
import { visibleText } from "./worktrees";

/**
 * specs/external-programs.md FR-617/FR-624: the one "Open worktree" / "Open folder in editor" accordion item, built the same way for
 * the branch menu, the commit menu, the Worktrees row menu, the palette's chooser and the tab-bar split button.
 */
export interface OpenInProgramModel {
  /** null until the first list has arrived; the row then expands instead of launching. */
  snapshot: ProgramsSnapshot | null;
  /** FR-621: re-validate with a stat when the menu opens. */
  refresh: () => void;
  openInTab: () => void;
  openInProgram: (programId: string) => void;
  managePrograms: () => void;
}

export interface OpenInProgramOptions {
  label: string;
  title?: string;
  /** The split button on a repo has no "GitHydra tab" (the repo is already open there). */
  includeTab?: boolean;
  initiallyExpanded?: boolean;
  /** "Checked out at <path>" (specs/worktrees.md FR-607). */
  contextLine?: string;
}

const MANAGE_KEY = "manage";
const TAB_KEY = GITHYDRA_TAB_ID;

/** What a plain click runs, or null when it cannot run anything (first run, or no usable external default). */
export function resolveDefault(
  snapshot: ProgramsSnapshot | null,
  includeTab: boolean,
): { kind: "tab" } | { kind: "program"; id: string; name: string } | null {
  if (!snapshot || snapshot.defaultId === null) return null;
  if (snapshot.defaultId === GITHYDRA_TAB_ID) return includeTab ? { kind: "tab" } : null;
  const p = snapshot.programs.find((x) => x.id === snapshot.defaultId);
  return p && p.available && !p.hidden ? { kind: "program", id: p.id, name: p.name } : includeTab ? { kind: "tab" } : null;
}

export function buildOpenInProgramItem(model: OpenInProgramModel, opts: OpenInProgramOptions): ContextMenuItem {
  const includeTab = opts.includeTab ?? true;
  const snap = model.snapshot;
  const def = resolveDefault(snap, includeTab);
  const defaultKey = def?.kind === "tab" ? TAB_KEY : def?.kind === "program" ? def.id : undefined;
  const defaultName = def?.kind === "tab" ? "GitHydra tab" : def?.kind === "program" ? visibleText(def.name) : null;

  const children: ContextMenuAccordionChild[] = [];
  if (includeTab) {
    children.push({
      key: TAB_KEY,
      label: "GitHydra tab",
      checked: def?.kind === "tab",
      ...(def?.kind === "tab" ? { badge: "default" } : {}),
      onSelect: model.openInTab,
    });
  }
  const shown = (snap?.programs ?? []).filter((p) => !p.hidden);
  for (const p of shown.filter((x) => x.available)) {
    children.push({
      key: p.id,
      label: visibleText(p.name),
      checked: def?.kind === "program" && def.id === p.id,
      ...(def?.kind === "program" && def.id === p.id ? { badge: "default" } : {}),
      onSelect: () => model.openInProgram(p.id),
    });
  }
  // A program that is gone stays visible and reachable, with its reason (never silently dropped, FR-617/FR-623).
  for (const p of shown.filter((x) => !x.available)) {
    children.push({
      key: p.id,
      label: visibleText(p.name),
      disabled: true,
      reason: visibleText(p.unavailableReason ?? "Not available."),
      onSelect: () => undefined,
    });
  }
  if (shown.length === 0 && snap) {
    children.push({ key: "none", label: "No programs found", disabled: true, reason: "Choose Manage programs to add your own.", onSelect: () => undefined });
  }
  children.push({ key: MANAGE_KEY, label: "Manage programs…", separatorBefore: true, onSelect: model.managePrograms });

  const fallback = snap?.fallbackReason ?? null;
  const hint = def ? (fallback ? fallback : `Opens in ${defaultName}`) : "Choose a program";
  const description = def
    ? `Enter opens in ${defaultName}, Right arrow chooses another program${fallback ? `. ${fallback}` : ""}`
    : "Enter or Right arrow chooses a program.";

  return {
    label: opts.label,
    ...(opts.title ? { title: opts.title } : {}),
    accordion: {
      children,
      ...(opts.contextLine ? { contextLine: opts.contextLine } : {}),
      hint,
      description,
      defaultKey,
      initiallyExpanded: opts.initiallyExpanded,
      onMenuOpen: model.refresh,
      onBodyActivate: def
        ? def.kind === "tab"
          ? model.openInTab
          : () => model.openInProgram(def.id)
        : undefined,
    },
  };
}
