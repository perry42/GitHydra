// SPDX-License-Identifier: GPL-3.0-or-later
import type { MouseEvent } from "react";
import type { RefDecoration } from "@githydra/git-core";
import { IconBranches, IconRefPin, IconRefRemote, IconRefTag, IconWarning } from "../Icon/Icon";
import "./RefChip.css";

export interface RefChipProps {
  decoration: RefDecoration;
  /** Current/checked-out ref (DESIGN.md gutter revision): rendered in primary ink + bold weight
   * instead of a colored fill — the type distinction stays text/icon-driven, never color. */
  filled?: boolean;
  /** HEAD not attached to a branch tip (AC4) — distinguished from a normal branch/tag chip via a
   * dashed underline + italic label, never a color swap (DESIGN.md gutter revision). */
  detached?: boolean;
  /**
   * specs/online-sync-fetch.md FR-326: true when this chip's local branch has both unpushed
   * (`ahead`) and unpulled (`behind`) commits against its upstream as of the last fetch — a real
   * divergence, not merely "behind." Renders a small `warning`-token glyph (`IconWarning`) after
   * the label, folded into this chip's own `aria-label`/`title` text rather than color alone (this
   * system's "never color alone" status-token policy). Only ever `true` for a `local-branch` chip
   * — remote-tracking branches/tags/HEAD have no ahead/behind concept of their own.
   */
  diverged?: boolean;
  /** FR-55: a local-branch chip gets a right-click menu (Checkout/Delete) — omitted for
   * remote-branch/tag/HEAD chips, which this component never invokes the handler for. */
  onContextMenu?: (event: MouseEvent) => void;
  /**
   * Follow-up to specs/ref-chip-gutter-legibility.md: on a checked-out row that ALSO has a second
   * ref collapsing behind the "+N" affix, the synthetic HEAD badge (`showHeadMarker` in
   * CommitRow.tsx) was competing for the same 100px gutter as the branch chip and the "+N" button
   * — both text labels shrank via their own `min-width: 0` ellipsis down to one illegible
   * character ("H..", "m."), caught via a real screenshot, not a DOM assertion. The badge's own
   * "HEAD" text is redundant exactly in this crowded case (the branch chip is already bold/filled,
   * and the whole row is already visually marked current) — so `iconOnly` drops the visible label
   * span entirely, keeping only the glyph. `role="img"`/`aria-label`/`title` already carry the full
   * "HEAD" text regardless of this flag, so the accessible name and hover tooltip are unaffected.
   * Omitted (the default) renders exactly as before — every other caller/scenario is untouched.
   */
  iconOnly?: boolean;
}

const TYPE_LABEL: Record<RefDecoration["type"], string> = {
  "local-branch": "local branch",
  "remote-branch": "remote branch",
  tag: "tag",
  head: "HEAD",
};

/**
 * specs/ref-chip-gutter-redesign.md FR-416: one literal, recognizable icon per ref-decoration type,
 * replacing the old abstract dot/ring/diamond/square glyph vocabulary (`RefChip.css`'s now-removed
 * `.gh-refchip__icon--branch`/`--remote`/`--tag`/`--head` rules) — a real object shape no longer
 * collides with the graph's own commit-node dot (`NODE_RADIUS`, `graphGeometry.ts`) the way the old
 * 8x8 filled-circle "branch" glyph did, one column over. `IconBranches` is reused verbatim (already
 * means "branch" everywhere else in the app); the other three are new (`Icon.tsx`).
 */
const TYPE_ICON: Record<RefDecoration["type"], typeof IconBranches> = {
  "local-branch": IconBranches,
  "remote-branch": IconRefRemote,
  tag: IconRefTag,
  head: IconRefPin,
};

/**
 * specs/ref-chip-gutter-legibility.md FR-411: the exact accessible-label string a chip's
 * `title`/`aria-label` already carries (`${TYPE_LABEL[type]}: ${name}`, including the "(diverged
 * from its upstream)" suffix) — pulled out to a standalone function so the "+N" collapse popover
 * (`CommitGraph.tsx`'s `refCollapseMenu`) can reuse this exact string-building logic for its
 * informational rows rather than inventing new copy, per that FR's own text.
 */
export function refChipAccessibleLabel(decoration: RefDecoration, detached: boolean, diverged: boolean): string {
  const isHead = decoration.type === "head";
  const label = isHead ? (detached ? "HEAD (detached)" : "HEAD") : decoration.name;
  return diverged
    ? `${TYPE_LABEL[decoration.type]}: ${label} (diverged from its upstream)`
    : `${TYPE_LABEL[decoration.type]}: ${label}`;
}

/**
 * DESIGN.md "Ref chip" (gutter revision): a plain-ink text label with a small type-glyph, not a
 * colored pill — color stays restricted to the graph's own lane lines/nodes (see GraphCanvas).
 * The branch/tag/HEAD type distinction and the "this is the current ref" / "HEAD is detached"
 * states are still all conveyed, just through icon shape, weight, and label text instead of hue.
 */
export function RefChip({
  decoration,
  filled = false,
  detached = false,
  diverged = false,
  onContextMenu,
  iconOnly = false,
}: RefChipProps) {
  const isHead = decoration.type === "head";
  const label = isHead ? (detached ? "HEAD (detached)" : "HEAD") : decoration.name;
  const TypeIcon = TYPE_ICON[decoration.type];
  // specs/online-sync-fetch.md FR-326: the accessible name/tooltip carries the divergence
  // explicitly — never relying on the warning glyph's color alone, per this system's status-token
  // policy ("Always icon + label, never color alone").
  const accessibleLabel = refChipAccessibleLabel(decoration, detached, diverged);

  return (
    <span
      className={`gh-refchip${filled ? " gh-refchip--filled" : ""}${detached ? " gh-refchip--detached" : ""}${iconOnly ? " gh-refchip--icon-only" : ""}`}
      role="img"
      aria-label={accessibleLabel}
      title={accessibleLabel}
      onContextMenu={onContextMenu}
    >
      <TypeIcon
        className="gh-refchip__icon"
        size={decoration.type === "local-branch" ? 14 : undefined}
        aria-hidden="true"
        data-ref-icon={decoration.type}
      />
      {!iconOnly && <span className="gh-refchip__label">{label}</span>}
      {!iconOnly && diverged && <IconWarning className="gh-refchip__diverged" />}
    </span>
  );
}
