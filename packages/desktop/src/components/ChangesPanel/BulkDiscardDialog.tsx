// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useId, useState } from "react";
import type { WorkingDirectoryFileChange } from "@githydra/git-core";
import type { GitHydraApi } from "../../../shared/ipcContract";
import { unwrap } from "../../hooks/gitHydraClient";
import { ConfirmDialog } from "../ConfirmDialog/ConfirmDialog";
import { FileStatusIcon } from "../FileStatusIcon/FileStatusIcon";
import { bulkDiscardCount, bulkDiscardNeedsTyping, type PendingBulkDiscard } from "../../hooks/useBulkDiscard";
import { discardConfirmToken, pathSample, plural } from "../../lib/fileSelection";
import "./BulkDialogs.css";

export interface BulkDiscardDialogProps {
  state: PendingBulkDiscard;
  api: GitHydraApi;
  /** Status letters for the listed files, from the panel's rows (display only; never used to choose what is discarded). */
  entries: ReadonlyMap<string, WorkingDirectoryFileChange>;
  canConfirm: boolean;
  onIncludeUntracked: (value: boolean) => void;
  onTyped: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

/** `+n` / `-m` for one file, or why there is no count. */
type LineStats = { kind: "lines"; added: number; removed: number } | { kind: "binary" };

/** FR-520/FR-522: names only up to this many files; counts from the next tier up. The list is capped at LIST_LIMIT rows. */
const NAMES_ONLY_UP_TO = 5;
const LIST_LIMIT = 50;
/** FR-522: a count that is not here after this long is silently left out. */
const PREVIEW_GIVE_UP_MS = 3000;

/**
 * Line counts for the files the dialog lists, from git-core's read-only `getDiscardPreview` (FR-521): one call for the visible
 * sample (at most STATS_LIMIT paths), never the whole selection. A failed read just leaves rows without a count.
 */
function useLineStats(api: GitHydraApi, paths: readonly string[], enabled: boolean): ReadonlyMap<string, LineStats> {
  const [stats, setStats] = useState<ReadonlyMap<string, LineStats>>(new Map());
  const key = enabled ? paths.join("\n") : "";
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      try {
        const gaveUp = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timed out")), PREVIEW_GIVE_UP_MS);
        });
        const rows = unwrap(await Promise.race([api.getDiscardPreview(key.split("\n")), gaveUp]));
        if (cancelled) return;
        const next = new Map<string, LineStats>();
        for (const r of rows) {
          if (r.binary) next.set(r.path, { kind: "binary" });
          else if (r.added !== null && r.removed !== null) next.set(r.path, { kind: "lines", added: r.added, removed: r.removed });
        }
        setStats(next);
      } catch (err) {
        // No count is better than a wrong one; the action stays enabled and nothing is shown to the user (FR-522).
        console.warn("Discard preview counts unavailable:", err instanceof Error ? err.message : err);
      } finally {
        clearTimeout(timer);
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, key]);
  return stats;
}

function namedList(paths: readonly string[], total = paths.length, limit = 5): string {
  const { shown } = pathSample(paths, limit);
  const more = Math.max(total, paths.length) - shown.length;
  return shown.join(", ") + (more > 0 ? ` and ${more} more` : "");
}

function StatsCell({ stats }: { stats: LineStats | undefined }) {
  if (!stats) return null;
  if (stats.kind === "binary") return <span className="gh-bulk-dialog__stat">binary</span>;
  return (
    <span className="gh-bulk-dialog__stat">
      {stats.added > 0 && (
        <span className="gh-bulk-dialog__plus">
          <span className="gh-visually-hidden">{stats.added} lines added</span>
          <span aria-hidden="true">+{stats.added}</span>
        </span>
      )}
      {stats.removed > 0 && (
        <span className="gh-bulk-dialog__minus">
          <span className="gh-visually-hidden">{stats.removed} lines removed</span>
          <span aria-hidden="true">-{stats.removed}</span>
        </span>
      )}
    </span>
  );
}

/**
 * specs/ignore-and-multiselect.md FR-508/FR-509 (D6, D7, revised): what exactly is lost, per file, before anything runs: status
 * letter, path and +/- line counts; untracked files are a separate opt-in checkbox, unchecked by default; above 20 files the
 * count must be typed. Discard is never the default-focused control (Cancel, or the type-to-confirm field), and a STALE_DIFF
 * refusal names the files that changed.
 */
export function BulkDiscardDialog({ state, api, entries, canConfirm, onIncludeUntracked, onTyped, onConfirm, onCancel }: BulkDiscardDialogProps) {
  const typedId = useId();
  const hintId = useId();
  const all = state.mode === "all";
  const count = bulkDiscardCount(state);
  const needsTyping = bulkDiscardNeedsTyping(state);
  const mixed = new Set(state.tracked.filter((r) => r.section === "mixed").map((r) => r.path)).size;
  const listed = [...state.tracked.map((r) => r.path), ...(state.includeUntracked ? state.untracked.map((r) => r.path) : [])];
  const sample = pathSample(listed, LIST_LIMIT);
  const showCounts = listed.length > NAMES_ONLY_UP_TO;
  const isUntracked = (p: string) => state.untracked.some((r) => r.path === p);
  const showDetails = state.phase === "ready" || state.phase === "running";
  const stats = useLineStats(
    api,
    sample.shown.filter((p) => state.tracked.some((r) => r.path === p)),
    showDetails && showCounts,
  );

  const title = all
    ? "Discard all changes?"
    : state.phase === "loading"
      ? "Discard changes?"
      : `Discard changes to ${plural(count, "file")}?`;
  let message: string;
  if (state.phase === "loading") message = "Reading the current changes…";
  else if (state.phase === "stale") {
    message = `These files changed since you opened this: ${namedList(state.stalePaths, state.staleTotal)}. Nothing was discarded. Cancel and review the changes again.`;
  } else if (state.phase === "error" && count === 0) {
    message = "Could not read the current changes. Nothing was discarded.";
  } else if (count === 0 && state.phase !== "error") {
    message = state.untracked.length > 0 ? "Only untracked files are selected. Tick the box below to delete them." : "There is nothing to discard.";
  } else {
    const head = `This discards your uncommitted changes in ${plural(state.tracked.length, "tracked file")}`;
    const del = state.includeUntracked ? ` and permanently deletes ${plural(state.untracked.length, "untracked file")}${all ? "" : " from disk"}` : "";
    message = `${head}${del}.${all ? " Staged content is not touched." : ""} This cannot be undone.`;
  }

  const skippedReasons = Array.from(new Set(state.skipped.map((s) => s.reason))).slice(0, 2).join(" ");
  const untrackedHint = pathSample(state.untracked.map((r) => r.path), 2);

  return (
    <ConfirmDialog
      title={title}
      message={message}
      confirmLabel={state.phase === "running" ? "Discarding…" : count > 0 ? `Discard ${plural(count, "file")}` : "Discard"}
      destructive
      initialFocus="cancel"
      confirmDisabled={!canConfirm}
      busy={state.phase === "running"}
      notice={state.phase === "error" ? (state.error ?? "Discard failed.") : undefined}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      {state.phase === "running" && (
        <p className="gh-bulk-dialog__line" role="status">
          Discarding {plural(count, "file")}… this can take a few seconds. Please keep this window open.
        </p>
      )}
      {showDetails && (
        <div className="gh-bulk-dialog__details">
          {mixed > 0 && (
            <p className="gh-bulk-dialog__line">
              {plural(mixed, "partly staged file")} keep their staged changes; only the unstaged part is discarded.
            </p>
          )}
          {listed.length > 0 && (
            <ul className="gh-bulk-dialog__paths gh-mono" aria-label="Files to discard">
              {sample.shown.map((p) => {
                const entry = entries.get(p);
                return (
                  <li key={p}>
                    {entry && <FileStatusIcon status={entry.status} />}
                    <span className="gh-bulk-dialog__path">{p}</span>
                    {showCounts && (isUntracked(p) ? <span className="gh-bulk-dialog__stat">new file</span> : <StatsCell stats={stats.get(p)} />)}
                  </li>
                );
              })}
              {sample.more > 0 && <li className="gh-bulk-dialog__more">and {sample.more} more</li>}
            </ul>
          )}
          {state.skipped.length > 0 && (
            <p className="gh-bulk-dialog__line">
              {state.skipped.length} skipped. {skippedReasons}
            </p>
          )}
          {state.untracked.length > 0 && (
            <div className="gh-bulk-dialog__check">
              <label>
                <input
                  type="checkbox"
                  checked={state.includeUntracked}
                  disabled={state.phase !== "ready"}
                  aria-describedby={hintId}
                  onChange={(e) => onIncludeUntracked(e.target.checked)}
                />
                Also delete {plural(state.untracked.length, "untracked file")}
              </label>
              <span id={hintId} className="gh-bulk-dialog__hint">
                {untrackedHint.shown.join(", ")}
                {untrackedHint.more > 0 ? `, +${untrackedHint.more}` : ""}. Not in git; they cannot be restored.
              </span>
            </div>
          )}
          {needsTyping && (
            <div className="gh-bulk-dialog__typing">
              <label htmlFor={typedId}>
                Type <strong>{discardConfirmToken(count)}</strong> to confirm{all ? "" : " (more than 20 files)"}
              </label>
              <input
                id={typedId}
                type="text"
                autoComplete="off"
                spellCheck={false}
                inputMode="numeric"
                value={state.typed}
                disabled={state.phase !== "ready"}
                onChange={(e) => onTyped(e.target.value)}
                // Enter never discards (FR-520): the button is the only way through.
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
