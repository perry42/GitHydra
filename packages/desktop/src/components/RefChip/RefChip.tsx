import type { RefDecoration } from "@githydra/git-core";
import "./RefChip.css";

export interface RefChipProps {
  decoration: RefDecoration;
  /** CSS color (a `var(--gh-lane-N)` token) for the owning lane's hue, per DESIGN.md's ref-chip
   * spec — ignored (overridden) for a detached HEAD chip, which always uses the fixed status
   * "serious" color regardless of lane, matching DESIGN.md's status-palette table. */
  laneColor: string;
  /** Filled background only for the current HEAD/checked-out ref (DESIGN.md). */
  filled?: boolean;
  /** HEAD not attached to a branch tip (AC4) — distinguished from a normal branch/tag chip. */
  detached?: boolean;
}

const TYPE_LABEL: Record<RefDecoration["type"], string> = {
  "local-branch": "local branch",
  "remote-branch": "remote branch",
  tag: "tag",
  head: "HEAD",
};

export function RefChip({ decoration, laneColor, filled = false, detached = false }: RefChipProps) {
  const isHead = decoration.type === "head";
  const color = isHead && detached ? "var(--gh-status-serious)" : laneColor;
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
      style={{ borderColor: color, ["--gh-refchip-fill" as string]: color }}
      role="img"
      aria-label={`${TYPE_LABEL[decoration.type]}: ${label}`}
      title={`${TYPE_LABEL[decoration.type]}: ${label}`}
    >
      <span className={`gh-refchip__icon ${kindClass}`} aria-hidden="true" />
      <span className="gh-refchip__label">{label}</span>
    </span>
  );
}
