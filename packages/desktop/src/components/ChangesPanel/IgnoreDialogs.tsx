// SPDX-License-Identifier: GPL-3.0-or-later
import { useId } from "react";
import type { IgnoreTarget } from "@githydra/git-core";
import { ConfirmDialog } from "../ConfirmDialog/ConfirmDialog";
import { trackedRowCount, writableRowCount, type PendingIgnore } from "../../hooks/useIgnoreFlow";
import { IGNORE_TARGETS, summarizeIgnoreReport, targetFileLabel } from "../../lib/ignoreMessages";
import { plural } from "../../lib/fileSelection";
import "./BulkDialogs.css";

export interface IgnoreDialogProps {
  state: PendingIgnore;
  onTarget: (target: IgnoreTarget) => void;
  onNext: () => void;
  onApply: (stopTracking: boolean) => void;
  onCancel: () => void;
}

/**
 * specs/ignore-and-multiselect.md D2/D3/FR-495: "Add to" (Root preselected / Nearest / Private), then, only when a selected
 * file is tracked, the Ignore only / Ignore and Stop Tracking / Cancel confirmation. Both are modals, so they join the
 * live-refresh idle gate (FR-465) through the panel's dialog-open signal.
 */
export function IgnoreDialog(props: IgnoreDialogProps) {
  return props.state.step === "target" ? <IgnoreTargetDialog {...props} /> : <IgnoreTrackedDialog {...props} />;
}

function IgnoreTargetDialog({ state, onTarget, onNext, onCancel }: IgnoreDialogProps) {
  const name = useId();
  const ready = state.preview.status === "ready" ? state.preview.report : null;
  const tracked = ready ? trackedRowCount(ready) : 0;
  const writable = ready ? writableRowCount(ready) : 0;
  const shared = ready?.files.some((f) => f.sharedWithOtherWorktrees) ?? false;
  const refused = ready?.rows.filter((r) => r.outcome === "refused") ?? [];

  let preview: string;
  if (state.preview.status === "loading") preview = "Checking…";
  else if (state.preview.status === "error") preview = state.preview.message;
  else if (writable > 0) {
    const rules = Array.from(new Set(ready!.rows.filter((r) => r.outcome === "will-write").map((r) => r.rule ?? "")));
    const file = ready!.files.find((f) => f.rules.length > 0);
    preview = `Will add ${rules.length === 1 ? rules[0] : plural(rules.length, "rule")} to ${file?.file ?? targetFileLabel(state.target)}${file?.created ? " (new file)" : ""}.`;
  } else {
    preview = summarizeIgnoreReport(ready!).text;
  }
  const fileName = ready?.files[0]?.file ?? targetFileLabel(state.target);
  const canGo = ready !== null && !state.running && (writable > 0 || tracked > 0);

  return (
    <ConfirmDialog
      title="Ignore: add to"
      message="Choose which file gets the new ignore rule."
      confirmLabel={tracked > 0 ? "Next…" : `Add to ${fileName}`}
      initialFocus="content"
      confirmDisabled={!canGo}
      busy={state.running}
      notice={state.error ?? undefined}
      onConfirm={onNext}
      onCancel={onCancel}
    >
      <fieldset className="gh-bulk-dialog__targets">
        <legend className="gh-visually-hidden">Add to</legend>
        {IGNORE_TARGETS.map((t) => (
          <label key={t.target} className="gh-bulk-dialog__radio">
            <input
              type="radio"
              name={name}
              value={t.target}
              checked={state.target === t.target}
              data-dialog-autofocus={state.target === t.target ? "" : undefined}
              onChange={() => onTarget(t.target)}
            />
            <span>
              <span className="gh-bulk-dialog__radio-label">{t.label}</span>
              <span className="gh-bulk-dialog__radio-hint">{t.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <p className="gh-bulk-dialog__line" role="status">
        {state.running ? "Writing the ignore rules…" : preview}
      </p>
      {shared && state.target === "exclude" && (
        <p className="gh-bulk-dialog__line">
          This repository is a linked worktree: .git/info/exclude is shared with the main checkout and every other worktree.
        </p>
      )}
      {refused.length > 0 && writable > 0 && (
        <p className="gh-bulk-dialog__line">
          {plural(refused.length, "file")} will be skipped: {refused[0]!.reason}
        </p>
      )}
    </ConfirmDialog>
  );
}

function IgnoreTrackedDialog({ state, onApply, onCancel }: IgnoreDialogProps) {
  const report = state.preview.status === "ready" ? state.preview.report : null;
  const stop = report?.stopTracking ?? null;
  const writable = report ? writableRowCount(report) : 0;
  const trackedSelected = report ? trackedRowCount(report) : 0;
  const stopCount = stop?.count ?? 0;

  return (
    <ConfirmDialog
      title="These files are tracked by git"
      message={
        report
          ? `${plural(trackedSelected, "selected file")} ${trackedSelected === 1 ? "is" : "are"} already tracked. An ignore rule alone does not make git forget tracked files.`
          : "Checking which selected files are tracked…"
      }
      confirmLabel="Ignore and Stop Tracking"
      initialFocus="cancel"
      confirmDisabled={!report || stopCount === 0 || state.running}
      secondaryAction={
        report && writable > 0 ? { label: "Ignore only", onClick: () => onApply(false), disabled: state.running } : undefined
      }
      busy={state.running}
      notice={state.error ?? (state.preview.status === "error" ? state.preview.message : undefined)}
      onConfirm={() => onApply(true)}
      onCancel={onCancel}
    >
      {state.running && (
        <p className="gh-bulk-dialog__line" role="status">
          Writing the ignore rules and removing files from the index… this can take a few seconds.
        </p>
      )}
      {stop && (
        <div className="gh-bulk-dialog__details">
          <p className="gh-bulk-dialog__line">
            Stop tracking removes {plural(stopCount, "file")} from git&apos;s index. The files stay on disk, and the removals
            appear as staged changes for you to commit.
          </p>
          {stop.otherMatchesStillTracked > 0 && (
            <p className="gh-bulk-dialog__line">
              {plural(stop.otherMatchesStillTracked, "other tracked file")} matching this rule{" "}
              {stop.otherMatchesStillTracked === 1 ? "stays" : "stay"} tracked.
            </p>
          )}
          {stop.mixedRows.length > 0 && (
            <p className="gh-bulk-dialog__line">
              {plural(stop.mixedRows.length, "partly staged file")}: the staged edits are dropped from the index (your working copy is
              untouched).
            </p>
          )}
          {stop.renamedRows.length > 0 && (
            <p className="gh-bulk-dialog__line">
              {plural(stop.renamedRows.length, "staged rename")}: only the new path is untracked; the old path stays staged as deleted.
            </p>
          )}
          {(stop.skippedSubmodules.length > 0 || stop.skippedConflicted.length > 0) && (
            <p className="gh-bulk-dialog__line">
              {plural(stop.skippedSubmodules.length + stop.skippedConflicted.length, "submodule or conflicted path")} will not be
              untracked.
            </p>
          )}
          <p className="gh-bulk-dialog__line">
            {writable > 0
              ? "Ignore only writes the rule; git keeps tracking these files until you stop tracking them."
              : "The rule is already in place, so only Ignore and Stop Tracking applies."}
          </p>
        </div>
      )}
    </ConfirmDialog>
  );
}
