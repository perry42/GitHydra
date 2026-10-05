// SPDX-License-Identifier: GPL-3.0-or-later
import type { BulkAction, Eligibility } from "../../lib/fileSelection";
import { plural } from "../../lib/fileSelection";
import "./BulkDialogs.css";

export interface BulkBarProps {
  selectedCount: number;
  eligibility: Record<BulkAction, Eligibility>;
  busy: boolean;
  onStage: () => void;
  onUnstage: () => void;
  onDiscard: () => void;
  /** Opens the Ignore scope menu anchored under the button. */
  onIgnore: (anchor: HTMLElement) => void;
  onClear: () => void;
}

const LABELS: Record<BulkAction, string> = { stage: "Stage", unstage: "Unstage", discard: "Discard", ignore: "Ignore" };

/**
 * specs/ignore-and-multiselect.md D5/FR-506: appears at 2+ selected rows. Each action shows how many selected rows it
 * applies to and "N skipped" for the rest BEFORE it runs; an action with nothing eligible is disabled with its reason.
 */
export function BulkBar({ selectedCount, eligibility, busy, onStage, onUnstage, onDiscard, onIgnore, onClear }: BulkBarProps) {
  const handlers: Record<BulkAction, (el: HTMLElement) => void> = {
    stage: onStage,
    unstage: onUnstage,
    discard: onDiscard,
    ignore: onIgnore,
  };
  return (
    <div className="gh-bulk-bar" role="toolbar" aria-label={`Actions for ${plural(selectedCount, "selected file")}`}>
      <span className="gh-bulk-bar__count">{selectedCount} selected</span>
      <div className="gh-bulk-bar__actions">
        {(["stage", "unstage", "discard", "ignore"] as BulkAction[]).map((action) => {
          const { eligible, skipped } = eligibility[action];
          const reason = eligible.length === 0 ? (skipped[0]?.reason ?? "Nothing selected applies.") : undefined;
          return (
            <button
              key={action}
              type="button"
              className={`gh-bulk-bar__button${action === "discard" ? " gh-bulk-bar__button--danger" : ""}`}
              disabled={eligible.length === 0 || busy}
              title={reason ?? (skipped.length > 0 ? `${plural(skipped.length, "selected file")} skipped: ${skipped[0]!.reason}` : undefined)}
              aria-haspopup={action === "ignore" ? "menu" : undefined}
              onClick={(e) => handlers[action](e.currentTarget)}
            >
              {LABELS[action]} {eligible.length}
              {action === "discard" || action === "ignore" ? "…" : ""}
              {skipped.length > 0 && <span className="gh-bulk-bar__skipped"> · {skipped.length} skipped</span>}
            </button>
          );
        })}
      </div>
      <button type="button" className="gh-bulk-bar__clear" onClick={onClear}>
        Clear
      </button>
    </div>
  );
}
