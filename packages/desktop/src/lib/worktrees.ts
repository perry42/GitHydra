// SPDX-License-Identifier: GPL-3.0-or-later
import type { WorktreeEntry, WorktreeList } from "@githydra/git-core";
import { looksLikeSamePath } from "../../shared/pathEquivalence";
import type { RepoTab } from "../hooks/useRepoTabs";
import { repoTabLabel } from "./repoLabel";

/** specs/worktrees.md FR-612: the longest tab label, in characters (counted in JS, never by CSS). */
export const TAB_LABEL_MAX_CHARS = 28;

// Control, bidi and invisible characters become visible escapes (FR-612): a branch or path is attacker-controlled text.
// Code point ranges (control, soft hyphen, Arabic letter mark, Hangul fillers, Mongolian selectors, zero-width and bidi
// marks, word joiner and invisible operators, Braille blank, variation selectors, BOM, tag characters).
const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x34f, 0x34f], [0x61c, 0x61c], [0x115f, 0x1160], [0x17b4, 0x17b5],
  [0x180b, 0x180f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069], [0x2800, 0x2800],
  [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xffa0, 0xffa0], [0xe0000, 0xe007f],
];
const hex = (n: number): string => "\\u{" + n.toString(16) + "}";
const INVISIBLE = new RegExp("[" + INVISIBLE_RANGES.map(([a, b]) => (a === b ? hex(a) : hex(a) + "-" + hex(b))).join("") + "]", "gu");

export function visibleText(raw: string): string {
  return raw.replace(INVISIBLE, (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`);
}

/**
 * FR-612 / AC14: keeps the first and the last characters so two branches sharing a long prefix stay distinguishable
 * ("feature/PROJ-1...debounce-v3"). Counts code points, not UTF-16 units, so an emoji is never split.
 */
export function truncateMiddle(text: string, max: number = TAB_LABEL_MAX_CHARS): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const ellipsis = "...";
  const room = Math.max(2, max - ellipsis.length);
  const head = Math.ceil(room / 2);
  const tail = room - head;
  return chars.slice(0, head).join("") + ellipsis + chars.slice(chars.length - tail).join("");
}

export function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "";
}

/** The row/tab name: the branch, or "detached <short sha>" (FR-612/FR-613). */
export function worktreeName(entry: Pick<WorktreeEntry, "branch" | "shortHead" | "head" | "isBare">): string {
  if (entry.branch) return visibleText(entry.branch);
  if (entry.isBare) return "bare repository";
  return `detached ${entry.shortHead ?? shortSha(entry.head)}`.trim();
}

// --- FR-614 / FR-615 reasons (exact wording is part of the acceptance criteria) ---

export const MISSING_OPEN_REASON = "Its folder is missing.";
export const MISSING_CLEANUP_DESCRIPTION = "Its folder is missing. Clean up removes the leftover Git record. No files are deleted.";
export const UNTRUSTED_LIST_REASON = "Git's worktree list and this repository's records disagree, so worktrees cannot be opened or removed here.";
export const UNSUPPORTED_REASON = "This worktree entry cannot be trusted, so it cannot be opened or removed.";
export const MAIN_REMOVE_REASON = "The main worktree cannot be removed.";
export const BARE_OPEN_REASON = "A bare repository has no working folder to open.";

export function lockedRemoveReason(lockReason: string | null): string {
  const why = lockReason ? visibleText(lockReason) : "no reason given";
  return `Locked: ${why}. Unlock it with git worktree unlock before removing.`;
}

export interface WorktreeRowModel {
  entry: WorktreeEntry;
  name: string;
  /** Visible, escaped path (control characters are shown as escapes). */
  path: string;
  isMain: boolean;
  /** Null: allowed. A string: why the action is disabled. */
  openReason: string | null;
  removeReason: string | null;
  /** Clean up applies to a Missing entry only. */
  canCleanUp: boolean;
  /** Remove-and-delete-branch needs a branch to delete. */
  canDeleteBranch: boolean;
}

export function describeWorktree(entry: WorktreeEntry, listUntrusted: boolean): WorktreeRowModel {
  const missing = entry.prunable;
  let openReason: string | null = null;
  let removeReason: string | null = null;
  if (entry.isBare) openReason = BARE_OPEN_REASON;
  else if (missing) openReason = MISSING_OPEN_REASON;
  else if (!entry.supported) openReason = UNSUPPORTED_REASON;
  else if (listUntrusted && !entry.isMain) openReason = UNTRUSTED_LIST_REASON;

  if (entry.isMain || entry.isBare) removeReason = MAIN_REMOVE_REASON;
  else if (entry.locked) removeReason = lockedRemoveReason(entry.lockReason);
  else if (!entry.supported) removeReason = UNSUPPORTED_REASON;
  else if (listUntrusted) removeReason = UNTRUSTED_LIST_REASON;
  else if (missing) removeReason = MISSING_OPEN_REASON;

  return {
    entry,
    name: worktreeName(entry),
    path: visibleText(entry.path),
    isMain: entry.isMain,
    openReason,
    removeReason,
    canCleanUp: missing && !entry.isMain && !entry.locked && entry.supported && !listUntrusted && entry.id !== null,
    canDeleteBranch: entry.branch !== null,
  };
}

// --- tab identity and label (FR-611, FR-612) ---

/** What the tab bar needs to know about a worktree-backed tab; filled from the active repo's worktree list. */
export interface WorktreeTabIdentity {
  path: string;
  name: string;
  isMain: boolean;
  /** The repository this worktree belongs to (its common git dir), so two worktrees of one repo count as ONE repo. */
  repoKey: string;
  repoName: string;
  /** Worktrees registered in the repo when last listed (a bare entry does not count). */
  worktreeCount: number;
}

function repoNameOf(list: WorktreeList): string {
  return repoTabLabel(list.mainPath).replace(/\.git$/i, "") || "repo";
}

/** FR-612: one identity per openable entry of a listing. */
export function identitiesFromList(list: WorktreeList): WorktreeTabIdentity[] {
  const count = list.entries.filter((e) => !e.isBare).length;
  const repoName = repoNameOf(list);
  return list.entries
    .filter((e) => !e.isBare)
    .map((e) => ({
      path: e.path,
      name: worktreeName(e),
      isMain: e.isMain,
      repoKey: list.commonDir,
      repoName,
      worktreeCount: count,
    }));
}

export type TabGlyph = "main" | "linked" | null;

export interface TabLabelModel {
  /** Branch / "detached <sha>" / folder name, already truncated and escaped. */
  label: string;
  /** Muted suffix: the repository name, only when more than one repository is open. */
  suffix: string | null;
  glyph: TabGlyph;
  /** Full path for the tooltip and the accessible name. */
  title: string;
  ariaLabel: string;
}

/**
 * FR-612: worktree-aware labels. A tab gets the branch-first label only when its path is a linked worktree, or the main
 * worktree of a repository that has two or more worktrees; every other tab keeps today's folder-name label (assumption:
 * the owner's mockup never relabelled plain single-worktree repos, and existing tests pin the folder name).
 * The suffix depends on the number of distinct repositories open, never on how many tabs one repository has.
 */
export function buildTabLabels(tabs: readonly RepoTab[], identities: readonly WorktreeTabIdentity[]): Record<string, TabLabelModel> {
  const identityOf = (tab: RepoTab): WorktreeTabIdentity | null =>
    identities.find((i) => looksLikeSamePath(i.path, tab.repoPath)) ?? null;
  const repoKeys = new Set(tabs.map((t) => identityOf(t)?.repoKey ?? `path:${t.repoPath}`));
  const manyRepos = repoKeys.size > 1;
  const out: Record<string, TabLabelModel> = {};
  for (const tab of tabs) {
    const id = identityOf(tab);
    if (!id || (id.isMain && id.worktreeCount < 2)) continue;
    const label = truncateMiddle(id.name);
    const suffix = manyRepos ? truncateMiddle(visibleText(id.repoName), 16) : null;
    const title = visibleText(tab.repoPath);
    out[tab.id] = {
      label,
      suffix,
      glyph: id.isMain ? "main" : "linked",
      title,
      ariaLabel: `${id.name}${suffix ? `, ${id.repoName}` : ""}, ${id.isMain ? "main worktree" : "worktree"} at ${tab.repoPath}`,
    };
  }
  return out;
}

export function findTabForPath(tabs: readonly RepoTab[], ...paths: string[]): RepoTab | null {
  return tabs.find((t) => paths.some((p) => looksLikeSamePath(t.repoPath, p))) ?? null;
}

// --- branch / commit lookups for menus and cards (FR-607, FR-613) ---

export interface WorktreeIndex {
  byBranch: ReadonlyMap<string, WorktreeEntry>;
  /** Entries whose HEAD is the given commit (FR-607 commit menu). */
  byHead: ReadonlyMap<string, WorktreeEntry>;
}

export function indexWorktrees(entries: readonly WorktreeEntry[]): WorktreeIndex {
  const byBranch = new Map<string, WorktreeEntry>();
  const byHead = new Map<string, WorktreeEntry>();
  for (const e of entries) {
    if (e.isBare) continue;
    if (e.branch) byBranch.set(e.branch, e);
    if (e.head && !byHead.has(e.head)) byHead.set(e.head, e);
  }
  return { byBranch, byHead };
}

export const EMPTY_WORKTREE_INDEX: WorktreeIndex = { byBranch: new Map(), byHead: new Map() };

export type WorktreeMenuAction =
  | { kind: "create"; label: string }
  | { kind: "open"; label: string; entry: WorktreeEntry; description: string };

/**
 * FR-607 / AC12: exactly ONE worktree item per menu; never both, never a disabled twin. Null when worktree info is
 * unavailable (a planted network path, FR-601): no worktree action is offered at all.
 */
export function branchWorktreeMenuAction(branch: string, index: WorktreeIndex, available = true): WorktreeMenuAction | null {
  if (!available) return null;
  const entry = index.byBranch.get(branch);
  if (entry) return { kind: "open", label: "Open worktree", entry, description: `Checked out at ${visibleText(entry.path)}` };
  return { kind: "create", label: "Create worktree…" };
}

export function commitWorktreeMenuAction(sha: string, index: WorktreeIndex, available = true): WorktreeMenuAction | null {
  if (!available) return null;
  const entry = index.byHead.get(sha);
  if (entry) return { kind: "open", label: "Open worktree", entry, description: `Checked out at ${visibleText(entry.path)}` };
  return { kind: "create", label: `Create worktree from commit ${sha.slice(0, 7)}…` };
}
