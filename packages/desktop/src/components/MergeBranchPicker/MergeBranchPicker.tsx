// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { CommitPairRelationship, LocalBranchInfo, RepositoryState } from "@githydra/git-core";
import type { GitHydraApi } from "../../../shared/ipcContract";
import { useDialogChrome } from "../../hooks/useDialogChrome";
import { unwrap } from "../../hooks/gitHydraClient";
import { computeMergeOrRebaseDisabledReason } from "../../lib/dragCommitMenu";
import "../CommandPalette/CommandPalette.css";

export interface MergeBranchPickerProps {
  api: GitHydraApi;
  repoState: RepositoryState | null;
  /** True while a checkout/merge from the drag flow is already in flight. */
  busy: boolean;
  /** FR-427/437: merge `aSha` (the picked branch's tip) into the current branch — the same
   * `runMerge` the drag menu's "Merge A into B" item calls, with `targetBranch` the current branch. */
  onMerge: (aSha: string, bSha: string, targetBranch?: string) => void;
  onClose: () => void;
}

/**
 * specs/branch-panel-drag-merge.md FR-437: the keyboard alternative to dragging a branch onto the
 * current one — a filterable picker of local branches opened by the "Merge branch into current
 * branch…" command. Reuses the Command Palette's overlay chrome/classes (one visual language for
 * type-to-filter pickers). Choosing a branch runs the SAME ancestry read and FR-307/308 disabled-
 * reason table as the drag menu, once, at selection time; a disabled outcome is explained inline and
 * nothing runs.
 */
export function MergeBranchPicker({ api, repoState, busy, onMerge, onClose }: MergeBranchPickerProps) {
  const titleId = useId();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [branches, setBranches] = useState<LocalBranchInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = unwrap(await api.listBranches());
        if (!cancelled) setBranches(list);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  const { onOverlayMouseDown } = useDialogChrome({
    onEscape: onClose,
    escapeDeps: [onClose],
    refocusWithEscapeEffect: true,
    getFocusTarget: () => inputRef.current,
    onBackdropClick: onClose,
  });

  // Merging the current branch into itself is meaningless — never offered.
  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (branches ?? []).filter((b) => !b.isCurrent && b.name.toLowerCase().includes(q));
  }, [branches, query]);
  useEffect(() => setHighlighted(0), [query]);
  const safeIndex = candidates.length === 0 ? -1 : Math.min(highlighted, candidates.length - 1);

  // The state-only reasons (bare, in-progress, unborn HEAD) are known before any git read.
  const upFrontReason = computeMergeOrRebaseDisabledReason(repoState, "diverged", busy, "merge");
  const headSha = repoState?.headSha ?? null;

  async function pick(branch: LocalBranchInfo) {
    if (upFrontReason || !headSha || checking) {
      setNotice(upFrontReason ?? "There is no current commit to merge into.");
      return;
    }
    setChecking(true);
    setNotice(null);
    let relationship: CommitPairRelationship | "error";
    try {
      relationship =
        branch.tipSha === headSha
          ? "a-ancestor-of-b"
          : unwrap(await api.computeCommitPairRelationship(branch.tipSha, headSha));
    } catch {
      relationship = "error";
    }
    setChecking(false);
    const reason = computeMergeOrRebaseDisabledReason(repoState, relationship, busy, "merge");
    if (reason) {
      setNotice(`Merge ${branch.name} into ${repoState?.currentBranch ?? "HEAD"}: ${reason}`);
      return;
    }
    onMerge(branch.tipSha, headSha, repoState?.isDetachedHead ? undefined : (repoState?.currentBranch ?? undefined));
    onClose();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlighted((i) => (candidates.length === 0 ? 0 : (Math.max(i, 0) + 1) % candidates.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((i) => (candidates.length === 0 ? 0 : (Math.max(i, 0) - 1 + candidates.length) % candidates.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const b = safeIndex >= 0 ? candidates[safeIndex] : undefined;
      if (b) void pick(b);
    }
  }

  const target = repoState?.currentBranch ?? "the current commit";
  return (
    <div className="gh-command-palette__overlay" onMouseDown={onOverlayMouseDown}>
      <div className="gh-command-palette" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId} className="gh-visually-hidden">
          Merge branch into {target}
        </h2>
        <input
          ref={inputRef}
          type="text"
          className="gh-command-palette__input gh-mono"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={safeIndex >= 0 ? `${listId}-${safeIndex}` : undefined}
          aria-label={`Choose a branch to merge into ${target}`}
          placeholder={`Merge which branch into ${target}?`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {(upFrontReason || notice) && (
          <p className="gh-command-palette__empty" role="status">
            {notice ?? upFrontReason}
          </p>
        )}
        <ul id={listId} role="listbox" aria-label="Local branches" className="gh-command-palette__list">
          {loadError ? (
            <li className="gh-command-palette__empty" role="presentation">
              Could not load branches: {loadError}
            </li>
          ) : branches === null ? (
            <li className="gh-command-palette__empty" role="presentation">
              Loading branches…
            </li>
          ) : candidates.length === 0 ? (
            <li className="gh-command-palette__empty" role="presentation">
              No other local branches match
            </li>
          ) : (
            candidates.map((b, index) => (
              <li
                key={b.fullName}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === safeIndex}
                className={`gh-command-palette__item${index === safeIndex ? " gh-command-palette__item--highlighted" : ""}`}
                onMouseEnter={() => setHighlighted(index)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void pick(b)}
              >
                <span className="gh-command-palette__label gh-mono">{b.name}</span>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
