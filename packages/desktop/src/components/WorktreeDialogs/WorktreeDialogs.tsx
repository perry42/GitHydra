// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useId, useRef, useState } from "react";
import type { BranchMergeState, PrunedEntry, WorktreeEntry } from "@githydra/git-core";
import type { GitHydraApi } from "../../../shared/ipcContract";
import { unwrap } from "../../hooks/gitHydraClient";
import { discardConfirmToken } from "../../lib/fileSelection";
import { MISSING_CLEANUP_DESCRIPTION, visibleText } from "../../lib/worktrees";
import { distrustMessage, planRemoval, type RemovalPlan } from "../../lib/worktreeRemove";
import { ConfirmDialog } from "../ConfirmDialog/ConfirmDialog";
import "../ChangesPanel/BulkDialogs.css";

export interface RemoveOutcome {
  /** Shown in the dialog; the dialog stays open. */
  notice: string;
  /** The state may have changed (a dirty or submodule refusal): read it again and ask again. */
  reload?: boolean;
}

export interface RemoveWorktreeDialogProps {
  api: GitHydraApi;
  entry: WorktreeEntry;
  /** The menu item chosen: "Remove worktree and delete branch" was picked (still downgraded when unmerged). */
  wantsDeleteBranch: boolean;
  openAsTab: boolean;
  currentBranch: string;
  /** Resolves null when the flow finished and the owner closes the dialog. */
  onConfirm: (plan: RemovalPlan) => Promise<RemoveOutcome | null>;
  onCancel: () => void;
}

type Loaded = { phase: "loading" } | { phase: "refused"; message: string } | { phase: "ready"; plan: RemovalPlan };

/**
 * specs/worktrees.md FR-615/FR-616: the remove confirm. Cancel has initial focus; a clean worktree says ignored files go too;
 * a dirty one states the count (typed above the shared 20-file threshold, Enter in the field never confirms); submodules are
 * listed before force is offered; an unmerged branch downgrades the action and says why.
 */
export function RemoveWorktreeDialog({ api, entry, wantsDeleteBranch, openAsTab, currentBranch, onConfirm, onCancel }: RemoveWorktreeDialogProps) {
  const typedId = useId();
  const [loaded, setLoaded] = useState<Loaded>({ phase: "loading" });
  const [typed, setTyped] = useState("");
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Captured when the dialog opens: closing the worktree's own tab mid-flow must not make the dialog re-read and flicker.
  const openAsTabRef = useRef(openAsTab);
  const currentBranchRef = useRef(currentBranch);

  useEffect(() => {
    let cancelled = false;
    setLoaded({ phase: "loading" });
    void (async () => {
      try {
        if (entry.id === null) {
          if (!cancelled) setLoaded({ phase: "refused", message: "The main worktree cannot be removed." });
          return;
        }
        const state = unwrap(await api.getWorktreeRemovalState(entry.id));
        if (cancelled) return;
        if (!state.ok) {
          setLoaded({ phase: "refused", message: distrustMessage(state.reason) });
          return;
        }
        // The merge decision is made when the dialog opens (FR-615); a failed read means "unmerged", never a guess that deletes.
        let merge: BranchMergeState | null = null;
        if (wantsDeleteBranch && entry.branch) {
          try {
            merge = unwrap(await api.getBranchMergeState(entry.branch));
          } catch {
            merge = null;
          }
        }
        if (cancelled) return;
        setLoaded({ phase: "ready", plan: planRemoval({ entry, state, merge, wantsDeleteBranch, openAsTab: openAsTabRef.current, currentBranch: currentBranchRef.current }) });
      } catch (err) {
        if (!cancelled) setLoaded({ phase: "refused", message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, entry, wantsDeleteBranch, reloadKey]);

  const plan = loaded.phase === "ready" ? loaded.plan : null;
  const typedOk = !plan?.needsTyping || typed.trim() === discardConfirmToken(plan.count);
  const canConfirm = plan !== null && typedOk && !running;

  async function confirm() {
    if (!plan || !canConfirm) return;
    setRunning(true);
    setNotice(null);
    try {
      const outcome = await onConfirm(plan);
      if (outcome) {
        setNotice(outcome.notice);
        setTyped("");
        if (outcome.reload) setReloadKey((k) => k + 1);
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  const title = plan?.title ?? "Remove worktree?";
  const message =
    loaded.phase === "loading"
      ? "Checking the worktree…"
      : loaded.phase === "refused"
        ? loaded.message
        : loaded.plan.message;

  return (
    <ConfirmDialog
      title={title}
      message={message}
      confirmLabel={running ? "Removing…" : (plan?.confirmLabel ?? "Remove worktree")}
      destructive
      initialFocus="cancel"
      confirmDisabled={!canConfirm}
      busy={running || loaded.phase === "loading"}
      notice={notice ?? undefined}
      onConfirm={() => void confirm()}
      onCancel={onCancel}
    >
      {plan && (
        <div className="gh-bulk-dialog__details">
          {plan.tabLine && <p className="gh-bulk-dialog__line">{plan.tabLine}</p>}
          {plan.submodules.length > 0 && (
            <>
              <p className="gh-bulk-dialog__line">This worktree contains submodules. Removing it deletes them too.</p>
              <ul className="gh-bulk-dialog__paths gh-mono" aria-label="Submodules">
                {plan.submodules.map((s) => (
                  <li key={s}>
                    <span className="gh-bulk-dialog__path">{visibleText(s)}</span>
                    {plan.dirtySubmodules.includes(s) && <span className="gh-bulk-dialog__stat">uncommitted changes</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
          {plan.keptBranchLine && <p className="gh-bulk-dialog__line">{plan.keptBranchLine}</p>}
          {plan.needsTyping && (
            <div className="gh-bulk-dialog__typing">
              <label htmlFor={typedId}>
                Type <strong>{discardConfirmToken(plan.count)}</strong> to confirm (more than 20 files)
              </label>
              <input
                id={typedId}
                type="text"
                autoComplete="off"
                spellCheck={false}
                inputMode="numeric"
                value={typed}
                disabled={running}
                onChange={(e) => setTyped(e.target.value)}
                // Enter never confirms (FR-615): the button is the only way through.
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.preventDefault();
                }}
              />
            </div>
          )}
        </div>
      )}
    </ConfirmDialog>
  );
}

export interface CleanUpWorktreeDialogProps {
  entry: WorktreeEntry;
  /** Other missing worktrees git would also forget (FR-604); empty until git-core asks for confirmation. */
  alsoForgotten: readonly PrunedEntry[];
  busy: boolean;
  notice: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/** specs/worktrees.md FR-604/FR-614: Forgetting a missing worktree removes the leftover Git record only; no files are deleted. */
export function CleanUpWorktreeDialog({ entry, alsoForgotten, busy, notice, onConfirm, onCancel }: CleanUpWorktreeDialogProps) {
  const others = alsoForgotten.length > 0;
  return (
    <ConfirmDialog
      title="Forget missing worktree?"
      message={others ? "This would also forget these other missing worktrees. No files are deleted." : MISSING_CLEANUP_DESCRIPTION}
      confirmLabel={busy ? "Forgetting…" : others ? "Forget all" : "Forget missing worktree"}
      initialFocus="cancel"
      busy={busy}
      confirmDisabled={busy}
      notice={notice ?? undefined}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <div className="gh-bulk-dialog__details">
        <p className="gh-bulk-dialog__line">
          Worktree <span className="gh-mono">{visibleText(entry.branch ?? entry.shortHead ?? "detached")}</span> at{" "}
          <span className="gh-mono">{visibleText(entry.path)}</span>
        </p>
        {others && (
          <>
            <ul className="gh-bulk-dialog__paths gh-mono" aria-label="Also forgotten">
              {alsoForgotten.map((o) => (
                <li key={o.id}>
                  <span className="gh-bulk-dialog__path">{o.path ? visibleText(o.path) : visibleText(o.id)}</span>
                </li>
              ))}
            </ul>
            <p className="gh-bulk-dialog__line">
              If a drive is only unplugged, reconnect it instead; <span className="gh-mono">git worktree repair</span> can recover it.
            </p>
          </>
        )}
      </div>
    </ConfirmDialog>
  );
}
