// SPDX-License-Identifier: GPL-3.0-or-later
import type { CSSProperties, MouseEvent } from "react";
import type { RefDecoration } from "@githydra/git-core";
import { laneColorVar } from "../../lib/laneAssignment";
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
  /**
   * specs/ref-chip-gutter-redesign.md Addendum (FR-417): this chip's own commit's graph lane color
   * slot — the exact same value `CommitRow.tsx`'s `laid.colorSlot` already carries and
   * `GraphCanvas.tsx` already draws that commit's node/lane lines with (`laneColorHex`/
   * `laneColorVar`, `lib/laneAssignment.ts`/`lib/cssVars.ts`). When present, the chip's background
   * is tinted with this same lane color (`REF_CHIP_LANE_TINT_PERCENT`, see below) instead of
   * FR-415's neutral border. Omitted — `DetailPanel.tsx`'s own caller, which lists a selected
   * commit's ref decorations without running that commit through `LaneAssigner` at all, so it has
   * no real lane-color value to thread — falls back to FR-415's prior neutral-bordered, untinted
   * treatment rather than guessing or inventing one.
   */
  laneColorSlot?: number;
  /**
   * specs/ref-chip-synced-upstream-merge.md FR-3/FR-4: set on a `local-branch` chip whose upstream
   * is EXACTLY synced (ahead===0 && behind===0) and that upstream's own remote-branch decoration is
   * on this same commit — `RefChip` renders BOTH icons (this branch's, then the remote's) before
   * one shared label (never doubling the name), and folds the synced-upstream name into the
   * accessible label (FR-5). `null`/omitted renders exactly as before — every other caller/scenario
   * untouched.
   */
  syncedRemote?: RefDecoration | null;
}

/**
 * specs/ref-chip-gutter-redesign.md Addendum (FR-417): the percentage of the lane color mixed into
 * `--gh-surface` for the chip's background tint — chosen from a real, programmatic contrast
 * computation (`contrastRatio.ts`, `refChipLaneTint.contrast.test.ts`), not eyeballed. The binding
 * constraint is `--gh-ink-secondary` (the plain/unfilled state's lighter-weight text) against the
 * mixed background, checked across all 8 `--gh-lane-N` slots in both themes: the worst case is
 * light theme's slot 7 (violet, `#4a3aa7`) — NOT one of the three hues (aqua/yellow/magenta)
 * DESIGN.md's "Color strategy" flags as sub-3:1, because that flag is about those hues used at FULL
 * saturation (a solid fill/border), a different scenario from a low-opacity tint toward a
 * near-white surface, where the darkest/most saturated hue (violet) shifts the mixed background's
 * luminance the most. At this percentage, light theme's worst case is ~5.7:1 and dark theme's is
 * ~7.2:1 — both comfortably above the 4.5:1 AA text floor (light theme's own ceiling before
 * dropping below 4.5:1 is 32%; this is chosen well under that for margin, and a single shared value
 * works for both themes since dark theme has even more headroom, so no themed pair is needed).
 */
export const REF_CHIP_LANE_TINT_PERCENT = 20;

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
 *
 * Follow-up to specs/ref-chip-gutter-redesign.md: exported (was module-private) so `CommitGraph.tsx`'s
 * "+N" collapse popover (`refCollapseMenuItems`, specs/ref-chip-gutter-legibility.md FR-411) can
 * render the SAME per-type icon on its informational rows as the chip itself does, rather than the
 * popover staying plain-text-only — found via a real user report: a chip collapsed behind "+N" (a
 * `remote-branch` in the reported case) showed no icon at all in the popover, inconsistent with every
 * visible chip now carrying one. Single source of truth, so the two can't drift apart.
 */
export const TYPE_ICON: Record<RefDecoration["type"], typeof IconBranches> = {
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
export function refChipAccessibleLabel(
  decoration: RefDecoration,
  detached: boolean,
  diverged: boolean,
  /**
   * specs/ref-chip-synced-upstream-merge.md FR-5: the synced upstream's short name (e.g.
   * "origin/main"), when this chip represents a merged local+remote pair — appended as
   * `` ` (synced with ${syncedRemoteName})` ``, never relying on the two icons alone to convey the
   * merge. Mutually exclusive with `diverged` in practice (an exactly-synced branch can't also be
   * diverged) — if both were somehow true, `diverged`'s suffix wins (the more actionable state).
   */
  syncedRemoteName?: string | null,
): string {
  const isHead = decoration.type === "head";
  const label = isHead ? (detached ? "HEAD (detached)" : "HEAD") : decoration.name;
  if (diverged) return `${TYPE_LABEL[decoration.type]}: ${label} (diverged from its upstream)`;
  if (syncedRemoteName) return `${TYPE_LABEL[decoration.type]}: ${label} (synced with ${syncedRemoteName})`;
  return `${TYPE_LABEL[decoration.type]}: ${label}`;
}

/**
 * DESIGN.md "Ref chip": a plain-ink text label with a small type-glyph. specs/ref-chip-gutter-
 * redesign.md Addendum (FR-417) revised the "color stays restricted to the graph's own lane lines/
 * nodes" rule this comment used to state: when `laneColorSlot` is available, the chip's background
 * is now tinted with that SAME lane color (a low-opacity `color-mix()`, never a solid pill fill),
 * so the chip visually echoes the lane it sits beside rather than staying colorless — text/icon
 * ink itself is still never colored by lane, only the chip's own surface is. The branch/tag/HEAD
 * type distinction and the "this is the current ref" / "HEAD is detached" states are still all
 * conveyed through icon shape, weight, and label text, independent of the lane tint.
 */
export function RefChip({
  decoration,
  filled = false,
  detached = false,
  diverged = false,
  onContextMenu,
  iconOnly = false,
  laneColorSlot,
  syncedRemote = null,
}: RefChipProps) {
  const isHead = decoration.type === "head";
  const label = isHead ? (detached ? "HEAD (detached)" : "HEAD") : decoration.name;
  const TypeIcon = TYPE_ICON[decoration.type];
  const SyncedRemoteIcon = syncedRemote ? TYPE_ICON[syncedRemote.type] : null;
  // specs/online-sync-fetch.md FR-326: the accessible name/tooltip carries the divergence
  // explicitly — never relying on the warning glyph's color alone, per this system's status-token
  // policy ("Always icon + label, never color alone"). specs/ref-chip-synced-upstream-merge.md
  // FR-5: same reasoning extended to the synced-upstream merge.
  const accessibleLabel = refChipAccessibleLabel(decoration, detached, diverged, syncedRemote?.name);

  // FR-417: only a design-token-sourced `color-mix()` expression, never a literal/hardcoded color
  // — the same pattern `CommitGraph.tsx`'s drag-ghost dot already establishes for per-row dynamic
  // lane coloring that can't be expressed as a static CSS class (the lane varies per commit, not
  // per component instance). `laneColorSlot == null` (DetailPanel's caller) leaves `style`
  // undefined entirely — no inline style at all in that fallback case.
  const hasLaneTint = laneColorSlot != null;
  const style: CSSProperties | undefined = hasLaneTint
    ? { background: `color-mix(in srgb, ${laneColorVar(laneColorSlot)} ${REF_CHIP_LANE_TINT_PERCENT}%, var(--gh-surface))` }
    : undefined;

  return (
    <span
      className={`gh-refchip${hasLaneTint ? " gh-refchip--tinted" : " gh-refchip--neutral"}${filled ? " gh-refchip--filled" : ""}${detached ? " gh-refchip--detached" : ""}${iconOnly ? " gh-refchip--icon-only" : ""}${syncedRemote ? " gh-refchip--synced-upstream" : ""}`}
      role="img"
      aria-label={accessibleLabel}
      title={accessibleLabel}
      style={style}
      onContextMenu={onContextMenu}
    >
      <TypeIcon
        className="gh-refchip__icon"
        size={decoration.type === "local-branch" ? 14 : undefined}
        aria-hidden="true"
        data-ref-icon={decoration.type}
      />
      {/* specs/ref-chip-synced-upstream-merge.md FR-4: the synced upstream's own icon, right after
          this branch's icon, before the (single, never-doubled) label. */}
      {SyncedRemoteIcon && (
        <SyncedRemoteIcon className="gh-refchip__icon" aria-hidden="true" data-ref-icon={syncedRemote!.type} />
      )}
      {!iconOnly && <span className="gh-refchip__label">{label}</span>}
      {!iconOnly && diverged && <IconWarning className="gh-refchip__diverged" />}
    </span>
  );
}
