// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { IgnoreScope, IgnoreTarget } from "@githydra/git-core";
import { useDialogChrome } from "../../hooks/useDialogChrome";
import { currentPlan, trackedRowCount, writableRowCount, type PendingIgnore } from "../../hooks/useIgnoreFlow";
import { IGNORE_TARGETS, scopeOptions, summarizeIgnoreReport, type ScopeImpact } from "../../lib/ignoreMessages";
import { pathSample, plural } from "../../lib/fileSelection";
import "./IgnorePopover.css";

export interface IgnorePopoverProps {
  state: PendingIgnore;
  /** Per scope, what the rule would touch in the Changes list (computed by the panel from its rows). */
  impact: Record<IgnoreScope, ScopeImpact>;
  onScope: (scope: IgnoreScope) => void;
  onTarget: (target: IgnoreTarget) => void;
  onApply: (stopTracking: boolean) => void;
  onCancel: () => void;
}

/** FR-517: the expanded list is capped; the counts above it are the real totals. */
const STOP_LIST_LIMIT = 50;
/** FR-523: a count over this reads "5000+". */
const COUNT_CAP = 5000;
const fmtCount = (n: number): string => (n > COUNT_CAP ? `${COUNT_CAP}+` : String(n));
const MARGIN = 8;

function ruleText(rules: string[], fallback: string): string {
  if (rules.length === 0) return fallback;
  return rules.length === 1 ? rules[0]! : `${rules[0]} +${rules.length - 1} more`;
}

/**
 * specs/ignore-and-multiselect.md D1/D2/D3/FR-495 (user-approved mockup, option 1): scope, destination and blast radius on ONE
 * anchored popover instead of a menu, a second menu and a dialog. Non-modal in the ARIA sense (the list behind stays visible)
 * but it traps Tab, takes focus on the checked scope, and Enter from anywhere but a button runs the primary action. Esc and an
 * outside press cancel; the panel returns focus to the invoker (FR-513).
 */
export function IgnorePopover({ state, impact, onScope, onTarget, onApply, onCancel }: IgnorePopoverProps) {
  const ids = { title: useId(), summary: useId(), group: useId(), select: useId() };
  const rootRef = useRef<HTMLDivElement | null>(null);
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  const [showFiles, setShowFiles] = useState(false);
  const listId = useId();
  const [pos, setPos] = useState({ left: state.anchor.x, top: state.anchor.y });

  const { plan, fresh } = currentPlan(state);
  const report = plan?.status === "ready" ? plan.report : null;
  const tracked = report ? trackedRowCount(report) > 0 : false;
  const stop = report?.stopTracking ?? null;
  const writable = report ? writableRowCount(report) : 0;
  const options = scopeOptions(state.rows);
  const canGo = fresh && !state.running && report !== null;
  const canWrite = canGo && writable > 0;
  const canStop = canGo && (stop?.count ?? 0) > 0;

  useDialogChrome({
    onEscape: onCancel,
    escapeDeps: [onCancel],
    getFocusTarget: () => rootRef.current?.querySelector<HTMLElement>('input[type="radio"]:checked') ?? null,
  });

  // An outside press cancels, like a menu; a press inside (or on the control that opened it) does not.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onCancel();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onCancel]);

  // Opens below the anchor, flips above when there is no room, and is clamped to the viewport once its real size is known.
  const heightKey = `${tracked}|${showFiles}|${report ? "r" : "l"}|${state.error ? "e" : ""}`;
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const { x, y, yAbove } = state.anchor;
    const left = Math.max(MARGIN, Math.min(x, window.innerWidth - width - MARGIN));
    const below = y + 4;
    const top =
      below + height <= window.innerHeight - MARGIN ? below : Math.max(MARGIN, Math.min(yAbove - height - 4, window.innerHeight - height - MARGIN));
    setPos({ left, top });
  }, [state.anchor, heightKey]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Tab") {
      const stops = Array.from(
        rootRef.current?.querySelectorAll<HTMLElement>(
          'input[type="radio"]:checked, select, button:not(:disabled):not([aria-disabled="true"])',
        ) ?? [],
      );
      if (stops.length === 0) return;
      const first = stops[0]!;
      const last = stops[stops.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      // Radios of one group are a single tab stop in the browser (the checked one); wrap only at the real ends.
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    } else if (e.key === "Enter" && !(e.target as HTMLElement).closest("button")) {
      e.preventDefault();
      if (!primaryRef.current?.disabled) primaryRef.current?.click();
    }
  };

  // The one line under the controls. It keeps the previous preview's text while the next one is read (no "Checking..." flash).
  let summary = "";
  if (plan?.status === "error") summary = plan.message;
  else if (report) {
    if (tracked) {
      summary =
        writable > 0
          ? "Ignore only writes the rule; git keeps tracking tracked files until you stop tracking them."
          : `${summarizeIgnoreReport({ ...report, stopTracking: null }).text} Only stop tracking applies.`;
    } else if (writable > 0) {
      const rules = Array.from(new Set(report.rows.filter((r) => r.outcome === "will-write").map((r) => r.rule ?? "")));
      const file = report.files.find((f) => f.rules.length > 0);
      const dest = IGNORE_TARGETS.find((t) => t.target === state.target)!.file;
      const hidden = impact[state.scope].hidden;
      summary =
        `${hidden > 0 ? `Hides ${fmtCount(hidden)} ${hidden === 1 ? "file" : "files"}. ` : ""}Adds ${rules.length === 1 ? rules[0] : plural(rules.length, "rule")} to ` +
        `${state.target === "exclude" ? dest : (file?.file ?? dest)}${file?.created ? " (new file)" : ""}.`;
    } else {
      summary = summarizeIgnoreReport({ ...report, stopTracking: null }).text;
    }
  }
  const shared = report?.files.some((f) => f.sharedWithOtherWorktrees) ?? false;
  const refused = report?.rows.filter((r) => r.outcome === "refused") ?? [];
  const sample = stop ? pathSample(stop.paths, STOP_LIST_LIMIT) : { shown: [], more: 0 };
  const single = state.rows.length === 1 ? state.rows[0]! : null;

  return (
    <div
      ref={rootRef}
      className="gh-ignore-pop"
      role="dialog"
      aria-modal="false"
      aria-labelledby={ids.title}
      aria-describedby={ids.summary}
      aria-busy={!fresh || state.running || undefined}
      style={{ left: pos.left, top: pos.top }}
      onKeyDown={onKeyDown}
    >
      <h2 id={ids.title} className="gh-ignore-pop__title">
        Ignore {single ? <code className="gh-mono">{single.path}</code> : plural(state.rows.length, "file")}
        {tracked && <span className="gh-ignore-pop__badge">tracked</span>}
      </h2>

      <div role="radiogroup" aria-label="Scope" className="gh-ignore-pop__scopes">
        {options.map((o) => {
          const scopePlan = state.plans[o.scope]?.plan;
          const rules =
            scopePlan?.status === "ready"
              ? Array.from(new Set(scopePlan.report.rows.map((r) => r.rule).filter((r): r is string => !!r)))
              : [];
          const n = impact[o.scope].others;
          const disabled = o.disabledReason !== null;
          return (
            <label key={o.scope} className={`gh-ignore-pop__opt${disabled ? " gh-ignore-pop__opt--disabled" : ""}`} title={o.disabledReason ?? o.label}>
              <input
                type="radio"
                name={ids.group}
                checked={state.scope === o.scope}
                disabled={disabled}
                onChange={() => onScope(o.scope)}
              />
              <span>
                <span className="gh-visually-hidden">{o.label}: </span>
                {disabled ? (
                  <span className="gh-ignore-pop__x">{o.label} ({o.disabledReason})</span>
                ) : (
                  <>
                    <code className="gh-mono">{ruleText(rules, o.label)}</code>
                    {n > 0 && <span className="gh-ignore-pop__x" title="Among the changed files listed">+{fmtCount(n)} {n === 1 ? "file" : "files"}</span>}
                  </>
                )}
              </span>
            </label>
          );
        })}
      </div>

      <div className="gh-ignore-pop__field">
        <label htmlFor={ids.select} className="gh-ignore-pop__label">
          Add to
        </label>
        <select id={ids.select} value={state.target} disabled={state.running} onChange={(e) => onTarget(e.target.value as IgnoreTarget)}>
          {IGNORE_TARGETS.map((t) => (
            <option key={t.target} value={t.target}>
              {t.target === "nearest" && state.target === "nearest" && report?.files[0]
                ? `Nearest .gitignore (${report.files[0].file}${report.files[0].created ? ", will create" : ""})`
                : t.label}
            </option>
          ))}
        </select>
      </div>

      {tracked && stop && stop.count > 0 && (
        <>
          <p className="gh-ignore-pop__sum">
            A rule alone does not make git forget a tracked file. Stop tracking removes {fmtCount(stop.count)} {stop.count === 1 ? "file" : "files"}{" "}
            from git&apos;s index; they stay on disk and the deletions appear as staged changes.
          </p>
          <button
            type="button"
            className="gh-ignore-pop__disclosure"
            aria-expanded={showFiles}
            aria-controls={listId}
            onClick={() => setShowFiles((v) => !v)}
          >
            <span aria-hidden="true">{showFiles ? "▾" : "▸"}</span> {showFiles ? "Hide files" : `Show ${fmtCount(stop.count)} ${stop.count === 1 ? "file" : "files"}`}
          </button>
          <ul id={listId} hidden={!showFiles} className="gh-ignore-pop__list gh-mono" aria-label="Files that become staged deletions">
            {sample.shown.map((p) => (
              <li key={p}>
                <span className="gh-ignore-pop__st" aria-hidden="true">
                  D
                </span>
                <span className="gh-visually-hidden">Deleted: </span>
                {p}
              </li>
            ))}
            {sample.more > 0 && <li className="gh-ignore-pop__more">and {sample.more} more</li>}
          </ul>
          {stop.otherMatchesStillTracked > 0 && (
            <p className="gh-ignore-pop__sum">
              {plural(stop.otherMatchesStillTracked, "other tracked file")} matching this rule {stop.otherMatchesStillTracked === 1 ? "stays" : "stay"}{" "}
              tracked.
            </p>
          )}
          {stop.mixedRows.length > 0 && (
            <p className="gh-ignore-pop__sum">
              {plural(stop.mixedRows.length, "partly staged file")}: the staged edits are dropped from the index (your working copy is untouched).
            </p>
          )}
          {stop.renamedRows.length > 0 && (
            <p className="gh-ignore-pop__sum">
              {plural(stop.renamedRows.length, "staged rename")}: only the new path is untracked; the old path stays staged as deleted.
            </p>
          )}
          {stop.skippedSubmodules.length + stop.skippedConflicted.length > 0 && (
            <p className="gh-ignore-pop__sum">
              {plural(stop.skippedSubmodules.length + stop.skippedConflicted.length, "submodule or conflicted path")} will not be untracked.
            </p>
          )}
        </>
      )}

      <p id={ids.summary} className="gh-ignore-pop__sum gh-ignore-pop__sum--live" aria-live="polite">
        {summary}
      </p>
      {shared && state.target === "exclude" && (
        <p className="gh-ignore-pop__sum">
          This repository is a linked worktree: .git/info/exclude is shared with the main checkout and every other worktree.
        </p>
      )}
      {refused.length > 0 && writable > 0 && (
        <p className="gh-ignore-pop__sum">
          {plural(refused.length, "file")} will be skipped: {refused[0]!.reason}
        </p>
      )}
      {state.running && (
        <p className="gh-ignore-pop__sum" role="status">
          {tracked ? "Writing the ignore rules and removing files from the index…" : "Writing the ignore rules…"}
        </p>
      )}
      {state.error && (
        <p className="gh-ignore-pop__sum gh-ignore-pop__sum--error" role="alert">
          {state.error}
        </p>
      )}

      <div className="gh-ignore-pop__buttons">
        <button type="button" className="gh-ignore-pop__btn" onClick={onCancel}>
          Cancel
        </button>
        {tracked && (
          <button type="button" className="gh-ignore-pop__btn" disabled={!canWrite} onClick={() => onApply(false)}>
            Ignore only
          </button>
        )}
        <button
          ref={primaryRef}
          type="button"
          className="gh-ignore-pop__btn gh-ignore-pop__btn--primary"
          disabled={tracked ? !canStop : !canWrite}
          onClick={() => onApply(tracked)}
        >
          {tracked ? "Ignore and stop tracking" : "Ignore"}
        </button>
      </div>
    </div>
  );
}
