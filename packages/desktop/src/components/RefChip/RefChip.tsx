import type { MouseEvent } from "react";
import type { RefDecoration } from "@githydra/git-core";
import "./RefChip.css";

export interface RefChipProps {
  decoration: RefDecoration;
  /** Current/checked-out ref (DESIGN.md gutter revision): rendered in primary ink + bold weight
   * instead of a colored fill — the type distinction stays text/icon-driven, never color. */
  filled?: boolean;
  /** HEAD not attached to a branch tip (AC4) — distinguished from a normal branch/tag chip via a
   * dashed underline + italic label, never a color swap (DESIGN.md gutter revision). */
  detached?: boolean;
  /** FR-55: a local-branch chip gets a right-click menu (Checkout/Delete) — omitted for
   * remote-branch/tag/HEAD chips, which this component never invokes the handler for. */
  onContextMenu?: (event: MouseEvent) => void;
}

const TYPE_LABEL: Record<RefDecoration["type"], string> = {
  "local-branch": "local branch",
  "remote-branch": "remote branch",
  tag: "tag",
  head: "HEAD",
};

/**
 * DESIGN.md "Ref chip" (gutter revision): a plain-ink text label with a small type-glyph, not a
 * colored pill — color stays restricted to the graph's own lane lines/nodes (see GraphCanvas).
 * The branch/tag/HEAD type distinction and the "this is the current ref" / "HEAD is detached"
 * states are still all conveyed, just through icon shape, weight, and label text instead of hue.
 */
export function RefChip({ decoration, filled = false, detached = false, onContextMenu }: RefChipProps) {
  const isHead = decoration.type === "head";
  const label = isHead ? (detached ? "HEAD (detached)" : "HEAD") : decoration.name;
  const kindClass =
    decoration.type === "local-branch"
      ? "gh-refchip__icon--branch"
      : decoration.type === "remote-branch"
        ? "gh-refchip__icon--remote"
        : decoration.type === "tag"
          ? "gh-refchip__icon--tag"
          : "gh-refchip__icon--head";

  return (
    <span
      className={`gh-refchip${filled ? " gh-refchip--filled" : ""}${detached ? " gh-refchip--detached" : ""}`}
      role="img"
      aria-label={`${TYPE_LABEL[decoration.type]}: ${label}`}
      title={`${TYPE_LABEL[decoration.type]}: ${label}`}
      onContextMenu={onContextMenu}
    >
      <span className={`gh-refchip__icon ${kindClass}`} aria-hidden="true" />
      <span className="gh-refchip__label">{label}</span>
    </span>
  );
}
