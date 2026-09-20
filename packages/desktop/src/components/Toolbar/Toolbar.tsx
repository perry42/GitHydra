// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import {
  IconBranches,
  IconChanges,
  IconChevronDown,
  IconFetch,
  IconFind,
  IconIdentity,
  IconMoreHorizontal,
  IconPull,
  IconPush,
  IconRefresh,
  IconStashes,
} from "../Icon/Icon";
import { ContextMenu, type ContextMenuItem } from "../ContextMenu/ContextMenu";
import { keyComboLabel } from "../../lib/platform";
import type { PullStrategyChoice } from "../../hooks/usePullAction";
import "./Toolbar.css";

export interface ToolbarProps {
  repoPath: string | null;
  onRefresh: () => void;
  canRefresh: boolean;
  /**
   * specs/refresh-without-teardown.md: true while a manual refresh (`graph.refresh()`) is
   * in-flight — independent of `canRefresh`/`graph.status`, since a manual refresh no longer moves
   * `status` away from `"ready"` at all (see `useRepositoryGraph`'s `refresh` doc comment). Drives
   * the button's `aria-busy`, a spinning icon, and disabling it for the duration (prevents piling
   * up overlapping refreshes from a double-click) — defaults to `false` for callers that don't
   * pass it.
   */
  isRefreshing?: boolean;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  /** FR-28: whether the Changes toggle should be shown at all (a repo is open and past the
   * opening/error states) — independent of whether there happen to be any changes right now, so
   * a bare repo or a clean working tree can still reach the panel's explicit empty states. */
  showChangesToggle?: boolean;
  /** Total pending change count (staged+unstaged+untracked+conflicted), or `null` for a bare
   * repo (no working directory to count) — shown as a badge on the toggle. */
  changesCount?: number | null;
  changesOpen?: boolean;
  onToggleChanges?: () => void;
  /** FR-56: whether the Branches toggle should be shown — a repo is open and past opening/error. */
  showBranchesToggle?: boolean;
  /** FR-56: current-branch indicator, refreshed after any successful branch operation. `null`
   * for detached HEAD, unborn HEAD, or a bare repo, rendered as a neutral "Branches" label
   * rather than a blank/misleading branch name in those cases. */
  currentBranchLabel?: string | null;
  /**
   * specs/online-sync-fetch.md FR-326: "fetched 3m ago" / "never fetched this session", appended
   * to the current-branch button's `title` tooltip — the same text-carried-caveat convention
   * DESIGN.md's "Ahead/behind 'last-known' captioning" already established (never color-only),
   * now backed by a real per-session timestamp instead of a permanently-static caveat (FR-57's
   * text this supersedes). `null`/omitted renders no caption at all (e.g. no repo open yet).
   *
   * toolbar-action-row redesign: also reused verbatim as the sync cluster's own freshness caveat —
   * folded into Pull/Push's accessible name/`title` whenever a non-zero ahead/behind count is
   * shown, so neither ever implies a live number the data doesn't actually have.
   */
  lastFetchedLabel?: string | null;
  /**
   * design-pass "Branches panel relocation": the Branches panel is now a persistent left sidebar
   * (always rendered while a repo is open) rather than one of the toggleable right-hand rails —
   * this button no longer opens/closes it, it expands/collapses it. `branchesOpen` /
   * `onToggleBranches` keep their original names (the button's visible label/position and the
   * "current branch at a glance" purpose are unchanged) but now mean "sidebar expanded" / "toggle
   * the sidebar's collapsed state".
   */
  branchesOpen?: boolean;
  onToggleBranches?: () => void;
  /** specs/stash.md FR-93: whether the Stash toggle should be shown — a repo is open and past
   * opening/error. */
  showStashToggle?: boolean;
  /** FR-93: live `git stash list` count, or `null` for a bare repo (no working directory). */
  stashCount?: number | null;
  stashOpen?: boolean;
  onToggleStash?: () => void;
  /** Edge cases: disables the toggle itself (not just the panel body) on a bare repository,
   * naming the reason — stash is entirely inapplicable with no working directory. */
  stashDisabledReason?: string | null;
  /**
   * specs/find-commits-overlay.md FR-258: whether the "Find commits" icon button is shown at all
   * — the exact gate the retired `FilterBar` rendered under (`graph.status === "ready" &&
   * graph.repoState && !graph.repoState.isEmpty && !graph.repoState.isUnbornHead`), not just
   * `showChangesToggle`/`showBranchesToggle`'s looser "repo open" gate.
   */
  showFindCommitsButton?: boolean;
  /**
   * FR-259/FR-263: a single click handler — App owns whether this opens or closes-and-clears
   * (re-clicking while the overlay is already open is one of FR-263's remaining explicit close
   * triggers), so this button, like Refresh, carries no pressed/active visual state of its own.
   */
  onFindCommits?: () => void;
  /**
   * FR-263 revision: whether a commit filter is currently applied, independent of whether the
   * overlay itself is visible — clicking outside the overlay now only hides it (the filter can
   * outlive that), so this button needs its own active-state signal or an applied-but-hidden
   * filter would be silently invisible. Mirrors the retired `FilterBar`'s collapsed-toggle dot:
   * a small filled indicator plus visually-hidden text, never color-only.
   */
  findCommitsActive?: boolean;
  /**
   * specs/online-sync-fetch.md FR-327: whether the Fetch action is shown at all — a repo is open
   * and past the opening/error states, same gate `showChangesToggle`/`showBranchesToggle` use.
   */
  showFetchButton?: boolean;
  /** FR-327: triggers `fetchAllRemotes()` for the active tab's repo. */
  onFetch?: () => void;
  /** FR-322: true while a fetch is already in flight — disables the button and shows a spinning
   * icon, the same treatment Refresh's own `isRefreshing` already established, so a double-click
   * can't pile up a second overlapping attempt. */
  isFetching?: boolean;
  /**
   * specs/online-sync-pull.md FR-343: whether the Pull action is shown at all — the same
   * "repo is open, past the opening/error states" gate `showFetchButton` uses.
   */
  showPullButton?: boolean;
  /** FR-343: null when Pull is eligible; otherwise the exact reason it's disabled right now (no
   * configured upstream, a bare repo, an unborn HEAD, or an operation already in progress) —
   * rendered as the button's `title`/part of its `aria-label`, the same disabled-with-reason
   * convention `stashDisabledReason` already established. */
  pullDisabledReason?: string | null;
  /** FR-339: triggers `pull()` for the active tab's repo, using `pullStrategy`. */
  onPull?: () => void;
  /** FR-322-mirrored: true while a pull is already in flight. */
  isPulling?: boolean;
  /** FR-339: the current per-pull strategy override — `"auto"` (no override; git-core resolves the
   * repo's own config) by default. */
  pullStrategy?: PullStrategyChoice;
  onPullStrategyChange?: (strategy: PullStrategyChoice) => void;
  /**
   * specs/online-sync-push.md FR-349: whether the Push action is shown at all — the same
   * "repo is open, past the opening/error states" gate `showFetchButton`/`showPullButton` use.
   */
  showPushButton?: boolean;
  /** FR-349: null when Push is eligible; otherwise the exact reason it's disabled right now (a
   * bare repo, a detached HEAD, an unborn HEAD, an operation already in progress, or no remotes
   * configured) — rendered as the button's `title`/part of its `aria-label`, the same
   * disabled-with-reason convention `pullDisabledReason` already established. */
  pushDisabledReason?: string | null;
  /** FR-344: triggers a push for the active tab's repo, using `pushRemote`. */
  onPush?: () => void;
  /** FR-348: true while a push is already in flight. */
  isPushing?: boolean;
  /** FR-345: shown only when more than one remote is configured — a single-remote repo pushes to
   * it with zero extra click, matching `pullStrategy`'s own always-available-but-optional shape. */
  showPushRemotePicker?: boolean;
  /** FR-345: every remote name the picker offers, in order. */
  pushRemotes?: readonly string[];
  /** FR-345: the remote a push currently targets. */
  pushRemote?: string | null;
  onPushRemoteChange?: (remoteName: string) => void;
  /**
   * toolbar-action-row redesign: the current branch's own behind/ahead counts against its
   * configured upstream (`usePushTarget`'s `behind`/`ahead` — the exact same read FR-347's
   * pre-push confirmation already uses, no new git-core call/IPC). Drives Pull's/Push's own count
   * pill respectively: rendered ONLY when non-zero (an in-sync repo is the row's quietest state),
   * capped at "99+" for display while the real number always stays in the accessible name, and
   * — when BOTH are non-zero at once (a genuine divergence) — recolors the whole sync cluster with
   * the `warning` status token, matching how `RefChip`'s own diverged glyph already uses it.
   * `null`/omitted renders both segments exactly as before this redesign (no pill, no icon).
   */
  behind?: number | null;
  ahead?: number | null;
  /**
   * specs/git-identity-profiles.md: opens the Git Identity Profiles dialog — always shown,
   * independent of repo state (FR-329's profile library is fully usable with no repo open at
   * all), so this carries no `show*`/gating prop of its own, matching the theme toggle's own
   * always-visible utility-button convention.
   */
  onOpenIdentityProfiles?: () => void;
  /**
   * specs/keyboard-shortcuts-reference.md FR-231: opens the `KeyboardShortcutsScreen` overlay —
   * toolbar-action-row redesign gives this reference screen its first-ever toolbar affordance (an
   * entry in the new `⋯` overflow menu, alongside the theme toggle) closing a real discoverability
   * gap; previously only reachable via the command palette / its own `Ctrl+/` keybinding.
   */
  onOpenKeyboardShortcuts?: () => void;
}

const PULL_STRATEGY_CHOICES: { value: PullStrategyChoice; label: string; description: string }[] = [
  { value: "auto", label: "Auto", description: "Follows this repository's own git config — the default." },
  { value: "merge", label: "Merge", description: "Always creates a merge commit for this one pull." },
  { value: "rebase", label: "Rebase", description: "Replays your commits on top of the incoming ones." },
];

function pluralCommits(n: number): string {
  return `${n} commit${n === 1 ? "" : "s"}`;
}

/** Cap the PILL's own display text at "99+" — the real number always stays in the accessible name
 * (this function is never used to build that name). */
function cappedPillText(n: number): string {
  return n > 99 ? "99+" : String(n);
}

/**
 * Builds Pull's/Push's enriched accessible name once idle+enabled — folds the relevant ahead/
 * behind count and the freshness caveat into the one string an `aria-label` produces (an explicit
 * `aria-label` overrides the whole subtree for accessible-name computation, so this has to be the
 * single place the count is announced — see this file's own historical note on that, still true
 * below). Returns the plain base name unchanged whenever there's nothing to report (the zero-count
 * "quietest" state) — this is also exactly what keeps every disabled/busy branch, and every
 * pre-existing "Pull"/"Push"-exact-name test, working unmodified.
 */
function buildSyncName(
  base: "Pull" | "Push",
  ahead: number | null,
  behind: number | null,
  lastFetchedLabel: string | null,
): string {
  const hasAhead = ahead !== null && ahead > 0;
  const hasBehind = behind !== null && behind > 0;
  const freshnessSuffix = lastFetchedLabel ? ` — ${lastFetchedLabel}` : "";
  if (hasAhead && hasBehind) {
    return `${base} — diverged (${pluralCommits(behind!)} behind, ${pluralCommits(ahead!)} ahead)${freshnessSuffix}`;
  }
  if (base === "Pull" && hasBehind) {
    return `${base} — ${pluralCommits(behind!)} behind${freshnessSuffix}`;
  }
  if (base === "Push" && hasAhead) {
    return `${base} — ${pluralCommits(ahead!)} ahead${freshnessSuffix}`;
  }
  return base;
}

interface AnchorPoint {
  x: number;
  y: number;
}

function anchorBelow(el: HTMLElement): AnchorPoint {
  const rect = el.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom + 4 };
}

/**
 * design-pass fix #1 ("Toolbar has no visual hierarchy"), REVISED by the toolbar-action-row
 * redesign into three role clusters, separated by exactly two hairline `__divider`s:
 *   1. **Local graph tools** — the three panel-toggle chips (Branches/Changes/Stashes, unchanged
 *      bordered-chip treatment) plus Find and Refresh as ghost icon buttons. Refresh MOVED here
 *      from the old lone "utility" cluster: it's a local re-read, and sitting inside the network
 *      cluster read as "refetch from remote," which it never is.
 *   2. **Sync cluster** — Fetch/Pull/Push fused into one bordered, segmented unit (`.gh-sync-
 *      cluster`), the row's one elevated tier (see the props doc above for the ahead/behind pill
 *      contract). Pull/Push each carry a caret (`aria-haspopup="menu"`) fused to their own right
 *      edge, opening a small strategy/remote-picker menu — replacing both native `<select>`s the
 *      previous toolbar used.
 *   3. **App settings** — Identity (unchanged ghost icon) then the new rightmost `⋯` overflow menu
 *      (theme toggle + Keyboard shortcuts — see `onOpenKeyboardShortcuts` above).
 * The Stashes chip is additionally adaptive (see its own render branch below): a plain ghost icon
 * button at zero/unknown count, promoted to the full labeled+badge chip only once it has contents.
 *
 * There is deliberately no single "hero" button here — the commit graph is the primary surface
 * (DESIGN.md's FIRST VIEWPORT) — Push's segmented/bordered treatment is about visual PROMINENCE
 * commensurate with being the one action that mutates a shared remote, never extra PERMISSION (no
 * force-push affordance exists anywhere in this component, not even hidden).
 */
export function Toolbar({
  repoPath,
  onRefresh,
  canRefresh,
  isRefreshing = false,
  theme,
  onToggleTheme,
  showChangesToggle = false,
  changesCount = null,
  changesOpen = false,
  onToggleChanges,
  showBranchesToggle = false,
  currentBranchLabel = null,
  lastFetchedLabel = null,
  branchesOpen = false,
  onToggleBranches,
  showStashToggle = false,
  stashCount = null,
  stashOpen = false,
  onToggleStash,
  stashDisabledReason = null,
  showFindCommitsButton = false,
  onFindCommits,
  findCommitsActive = false,
  showFetchButton = false,
  onFetch,
  isFetching = false,
  showPullButton = false,
  pullDisabledReason = null,
  onPull,
  isPulling = false,
  pullStrategy = "auto",
  onPullStrategyChange,
  showPushButton = false,
  pushDisabledReason = null,
  onPush,
  isPushing = false,
  showPushRemotePicker = false,
  pushRemotes = [],
  pushRemote = null,
  onPushRemoteChange,
  behind = null,
  ahead = null,
  onOpenIdentityProfiles,
  onOpenKeyboardShortcuts,
}: ToolbarProps) {
  const showSyncCluster = showFetchButton || showPullButton || showPushButton;

  // Width shedding (currently-undefined-in-spec behavior this redesign defines): as the row runs
  // out of room, shed in this fixed order — (1) repo path truncates (already handled by its own
  // `flex: 1`/ellipsis, untouched here), (2) panel chips drop labels rightmost-first (Stashes, then
  // Changes, then Branches), (3) sync segments drop labels but NEVER their counts, (4) Identity
  // folds into the `⋯` menu.
  //
  // test-agent finding (real-Electron repro, `toolbarActionRow.spec.ts`'s "width shedding must not
  // collapse..." test): the ORIGINAL version of this observed `.gh-toolbar__actions` itself — an
  // element whose own rendered width is a function of `shedLevel`, the very state the observer
  // sets. That's a self-referential measurement target: any full-label width that happened to sit
  // under the widest threshold tripped a shed level, which removed DOM content, which shrank the
  // observed element further, which computed an even higher shed level next callback — collapsing
  // all the way to maximally-shed with no correction, regardless of how much room was genuinely
  // free elsewhere (the repo-path label happily absorbs any slack via its own `flex: 1`). Fixed by
  // observing `.gh-toolbar` (the whole header) instead: a flex item stretched to its parent's full
  // width by the app shell's `align-items: stretch` default (`App.css`'s `.gh-app`, a column flex
  // container) — its rendered width reflects the window's genuinely available space and does NOT
  // change as a consequence of shedding, so the feedback loop can't occur.
  //
  // Hysteresis: each transition has a separate shed-down/restore-up threshold (a real gap, not the
  // same value) so a window parked exactly on a boundary can't flicker between two levels every
  // resize tick. `ResizeObserver` is unavailable/stubbed-inert under jsdom (see `test/setup.ts`),
  // so `shedLevel` simply never leaves 0 in every component test — every existing "full label"
  // assertion is unaffected by this being here at all.
  const headerRef = useRef<HTMLElement | null>(null);
  const [shedLevel, setShedLevel] = useState(0);
  useEffect(() => {
    const el = headerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    // Heuristic thresholds (px of the HEADER's own width — comfortably below the app's enforced
    // 880px window-minWidth, per `electron/windowBounds.ts`'s `MIN_WIDTH`, so any window size a
    // user can actually resize to shows the full, unshed row by default) — a first pass, not yet
    // tuned against a real running-app measurement pass across many real repo/branch-name lengths;
    // revisit with real screenshots. `down` must be strictly less than `up` for every entry (the
    // hysteresis gap) — asserted below rather than only in a code comment.
    const thresholds: { down: number; up: number }[] = [
      { down: 820, up: 860 }, // level 0 -> 1: Stashes label
      { down: 740, up: 780 }, // level 1 -> 2: Changes label
      { down: 660, up: 700 }, // level 2 -> 3: Branches label
      { down: 560, up: 600 }, // level 3 -> 4: sync-segment labels
      { down: 460, up: 500 }, // level 4 -> 5: fold Identity into "⋯"
    ];
    if (import.meta.env.DEV) {
      for (const { down, up } of thresholds) {
        console.assert(down < up, "Toolbar width-shedding thresholds must have down < up (hysteresis gap)");
      }
    }
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? Number.POSITIVE_INFINITY;
      setShedLevel((previousLevel) => {
        let level = previousLevel;
        // Shed further while genuinely below the current level's own "shed down" threshold —
        // cascades through multiple levels in one measurement if the width dropped a lot at once.
        while (level < thresholds.length && width < thresholds[level]!.down) level += 1;
        // Restore while genuinely above the level-below's "restore up" threshold — a real gap
        // above the corresponding shed-down value, so a boundary-parked width can't oscillate.
        while (level > 0 && width > thresholds[level - 1]!.up) level -= 1;
        return level;
      });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const hideStashLabel = shedLevel >= 1;
  const hideChangesLabel = shedLevel >= 2;
  const hideBranchesLabel = shedLevel >= 3;
  const hideSyncLabels = shedLevel >= 4;
  const foldIdentityIntoMenu = shedLevel >= 5;

  const [openMenu, setOpenMenu] = useState<"pull" | "push" | "more" | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<AnchorPoint>({ x: 0, y: 0 });
  const pullCaretRef = useRef<HTMLButtonElement | null>(null);
  const pushCaretRef = useRef<HTMLButtonElement | null>(null);
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);

  // Escape inside a menu returns focus to whichever trigger opened it (ContextMenu itself doesn't
  // know which button that was) — a plain effect keyed on `openMenu` closing is simpler than
  // threading a focus-restore callback through three separate menu instances.
  const previouslyOpenMenu = useRef<typeof openMenu>(null);
  useEffect(() => {
    if (previouslyOpenMenu.current && !openMenu) {
      const triggers = { pull: pullCaretRef, push: pushCaretRef, more: moreButtonRef };
      triggers[previouslyOpenMenu.current].current?.focus();
    }
    previouslyOpenMenu.current = openMenu;
  }, [openMenu]);

  const openPullMenu = () => {
    if (pullCaretRef.current) setMenuAnchor(anchorBelow(pullCaretRef.current));
    setOpenMenu((m) => (m === "pull" ? null : "pull"));
  };
  const openPushMenu = () => {
    if (pushCaretRef.current) setMenuAnchor(anchorBelow(pushCaretRef.current));
    setOpenMenu((m) => (m === "push" ? null : "push"));
  };
  const openMoreMenu = () => {
    if (moreButtonRef.current) setMenuAnchor(anchorBelow(moreButtonRef.current));
    setOpenMenu((m) => (m === "more" ? null : "more"));
  };

  const diverged = (ahead ?? 0) > 0 && (behind ?? 0) > 0;
  const showPullIcon = isPulling || (behind ?? 0) > 0;
  const showPushIcon = isPushing || (ahead ?? 0) > 0;

  const pullName = isPulling
    ? "Pulling…"
    : pullDisabledReason
      ? `Pull (${pullDisabledReason})`
      : buildSyncName("Pull", ahead, behind, lastFetchedLabel);
  const pullTitle =
    pullDisabledReason ??
    ((behind ?? 0) > 0
      ? buildSyncName("Pull", ahead, behind, lastFetchedLabel)
      : "Pull — fetch and bring your current branch up to date with its upstream");

  const pushName = isPushing
    ? "Pushing…"
    : pushDisabledReason
      ? `Push (${pushDisabledReason})`
      : buildSyncName("Push", ahead, behind, lastFetchedLabel);
  const pushTitle =
    pushDisabledReason ??
    ((ahead ?? 0) > 0
      ? buildSyncName("Push", ahead, behind, lastFetchedLabel)
      : "Push — publish your current branch's commits to the remote");

  const pullMenuItems: ContextMenuItem[] = PULL_STRATEGY_CHOICES.map((choice) => ({
    label: choice.label,
    description: choice.description,
    checked: pullStrategy === choice.value,
    onSelect: () => onPullStrategyChange?.(choice.value),
  }));

  const pushMenuItems: ContextMenuItem[] = pushRemotes.map((remote) => ({
    label: remote,
    checked: pushRemote === remote,
    onSelect: () => onPushRemoteChange?.(remote),
  }));

  const overflowMenuItems: ContextMenuItem[] = [
    {
      label: theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
      onSelect: onToggleTheme,
    },
    {
      label: "Keyboard shortcuts",
      description: keyComboLabel({ key: "/", mod: true }),
      onSelect: onOpenKeyboardShortcuts,
    },
    // Width shedding, step 4: Identity folds in here once the row is genuinely too narrow for its
    // own standalone button — a real conditional entry (driven by `shedLevel`), not a second,
    // always-present duplicate control alongside the standalone button below.
    ...(foldIdentityIntoMenu
      ? [{ label: "Git identity profiles", onSelect: onOpenIdentityProfiles }]
      : []),
  ];

  return (
    <header className="gh-toolbar" ref={headerRef}>
      <span className="gh-toolbar__brand">GitHydra</span>
      <span className="gh-toolbar__repo-path gh-mono" title={repoPath ?? undefined}>
        {repoPath ?? "No repository open"}
      </span>
      <div className="gh-toolbar__actions">
        {
          // toolbar-action-row redesign: cluster 1 (local graph tools) always renders — Refresh
          // (and, when shown, Find) live here unconditionally, independent of whether any of the
          // three panel-toggle chips happen to be shown at all. Only each individual CHIP inside
          // is still gated by its own `show*` prop.
        }
        <div className="gh-toolbar__group gh-toolbar__group--toggles">
            {showBranchesToggle && (
              <button
                type="button"
                onClick={onToggleBranches}
                className={`gh-toolbar__button gh-toolbar__branch${branchesOpen ? " gh-toolbar__button--active" : ""}`}
                aria-pressed={branchesOpen}
                aria-label={
                  currentBranchLabel
                    ? `Branches — current branch ${currentBranchLabel}${lastFetchedLabel ? `, ${lastFetchedLabel}` : ""}`
                    : "Branches"
                }
                title={lastFetchedLabel ?? undefined}
              >
                <IconBranches />
                {!hideBranchesLabel && <span className="gh-mono">{currentBranchLabel ?? "Branches"}</span>}
              </button>
            )}
            {showChangesToggle && (
              <button
                type="button"
                onClick={onToggleChanges}
                className={`gh-toolbar__button${changesOpen ? " gh-toolbar__button--active" : ""}`}
                aria-pressed={changesOpen}
                aria-label={changesCount ? `Changes, ${changesCount} pending` : "Changes"}
              >
                <IconChanges />
                {!hideChangesLabel && "Changes"}
                {changesCount ? <span className="gh-toolbar__badge gh-tabular">{changesCount}</span> : null}
              </button>
            )}
            {showStashToggle &&
              (stashCount ? (
                <button
                  type="button"
                  onClick={onToggleStash}
                  disabled={stashDisabledReason !== null}
                  title={stashDisabledReason ?? undefined}
                  className={`gh-toolbar__button${stashOpen ? " gh-toolbar__button--active" : ""}`}
                  aria-pressed={stashOpen}
                  aria-label={`Stashes, ${stashCount}`}
                >
                  <IconStashes />
                  {!hideStashLabel && "Stashes"}
                  <span className="gh-toolbar__badge gh-tabular">{stashCount}</span>
                </button>
              ) : (
                // Adaptive Stashes chip: zero/unknown count is the common case (a repo is clean of
                // stashes far more often than not), so it renders as a plain ghost icon button —
                // matching Refresh/theme's own icon-button treatment — rather than a permanently
                // labeled chip with nothing to report. Promotes to the full labeled+badge chip
                // above the instant a stash actually exists; never resizes ambiently (only ever a
                // consequence of the user's own stash/pop action).
                <button
                  type="button"
                  onClick={onToggleStash}
                  disabled={stashDisabledReason !== null}
                  title={stashDisabledReason ?? undefined}
                  className={`gh-toolbar__icon-button${stashOpen ? " gh-toolbar__button--active" : ""}`}
                  aria-pressed={stashOpen}
                  aria-label="Stashes"
                >
                  <IconStashes />
                </button>
              ))}
            {showFindCommitsButton && (
              <button
                type="button"
                onClick={onFindCommits}
                // specs/find-commits-overlay.md FR-263: identifies this specific button to
                // `FindCommitsOverlay`'s own click-outside listener so it's excluded from the
                // generic "closed on any outside click" check — this button's own `onClick`
                // (`App.tsx`'s toggle wrapper) is the single, race-free owner of the "re-click
                // while open closes it" behavior. Without this, a real browser/user-event's
                // separate mousedown-then-click sequence lets the click-outside listener close the
                // overlay on mousedown, after which the click event (now reading fresh,
                // already-closed state) reopens it — a flicker-closed-then-reopen bug, not a
                // close.
                data-find-commits-trigger="true"
                className="gh-toolbar__icon-button"
                // security-reviewer finding: an explicit aria-label overrides the button's
                // subtree for accessible-name computation, so a visually-hidden span inside it is
                // never folded into what a screen reader announces — the label itself must carry
                // the active-filter state, not a hidden text sibling the label silently
                // suppresses.
                aria-label={findCommitsActive ? "Find commits (a commit filter is currently applied)" : "Find commits"}
                title={`Find commits (${keyComboLabel({ key: "f", mod: true, shift: true })})`}
              >
                <IconFind />
                {/* FR-263 revision: a filter can now stay applied with the overlay hidden (a
                    click-outside dismissal no longer clears it) — this dot is the sighted-only
                    signal that's true; the aria-label above carries the same state for assistive
                    tech, mirroring the retired FilterBar's collapsed-toggle dot's intent. */}
                {findCommitsActive && <span className="gh-toolbar__icon-button-indicator" aria-hidden="true" />}
              </button>
            )}
            {/* toolbar-action-row redesign: Refresh moved here (was the old lone "utility"
                cluster) — it's a local re-read, and sitting inside the network cluster read as
                "refetch from remote," which it never is. */}
            <button
              type="button"
              onClick={onRefresh}
              disabled={!canRefresh || isRefreshing}
              aria-busy={isRefreshing}
              className="gh-toolbar__icon-button"
              aria-label={isRefreshing ? "Refreshing commit graph…" : "Refresh commit graph"}
              title="Refresh (manual — always available regardless of auto-detect)"
            >
              <IconRefresh className={isRefreshing ? "gh-toolbar__icon--spin" : undefined} />
            </button>
        </div>

        {/* toolbar-action-row redesign: divider 1 always separates cluster 1 (local graph tools,
            always present — Refresh alone guarantees that) from whichever cluster follows it
            (the sync cluster when shown, otherwise cluster 3 directly) — exactly two dividers
            total in the normal (sync cluster shown) case, degrading to one when there's no sync
            cluster to separate at all. */}
        <span className="gh-toolbar__divider" aria-hidden="true" />

        {showSyncCluster && (
          <div
            className={`gh-sync-cluster${diverged ? " gh-sync-cluster--diverged" : ""}`}
            role="group"
            aria-label="Sync with remote"
          >
            {showFetchButton && (
              <button
                type="button"
                onClick={onFetch}
                disabled={isFetching}
                aria-busy={isFetching}
                className="gh-sync-cluster__button"
                aria-label={isFetching ? "Fetching remotes…" : "Fetch all remotes"}
                title="Fetch all remotes — pulls down remote-tracking refs (does not merge or change your working directory)"
              >
                <IconFetch className={isFetching ? "gh-toolbar__icon--pulse" : undefined} />
                {!hideSyncLabels && <span>{isFetching ? "Fetching…" : "Fetch"}</span>}
              </button>
            )}
            {showFetchButton && showPullButton && <span className="gh-sync-cluster__divider" aria-hidden="true" />}
            {showPullButton && (
              <div className="gh-sync-cluster__segment">
                <button
                  type="button"
                  onClick={onPull}
                  disabled={pullDisabledReason !== null}
                  aria-busy={isPulling}
                  className="gh-sync-cluster__button"
                  aria-label={pullName}
                  title={pullTitle}
                >
                  {showPullIcon && <IconPull className={isPulling ? "gh-toolbar__icon--pulse" : undefined} />}
                  {!hideSyncLabels && <span>Pull</span>}
                  {(behind ?? 0) > 0 && (
                    <span
                      className={`gh-sync-pill gh-tabular${diverged ? " gh-sync-pill--warning" : ""}`}
                      aria-hidden="true"
                    >
                      {cappedPillText(behind!)}
                    </span>
                  )}
                </button>
                <span className="gh-sync-cluster__divider gh-sync-cluster__divider--subtle" aria-hidden="true" />
                <button
                  ref={pullCaretRef}
                  type="button"
                  onClick={openPullMenu}
                  disabled={isPulling}
                  className="gh-sync-cluster__caret"
                  aria-haspopup="menu"
                  aria-expanded={openMenu === "pull"}
                  aria-label="Pull strategy options"
                  title="Choose the strategy for this pull"
                >
                  <IconChevronDown size={12} />
                </button>
                {openMenu === "pull" && (
                  <ContextMenu
                    x={menuAnchor.x}
                    y={menuAnchor.y}
                    ariaLabel="Strategy for this pull"
                    header={<span>Strategy for this pull</span>}
                    items={pullMenuItems}
                    onClose={() => setOpenMenu(null)}
                    footer={<span>Applies to this pull only. Your git config is never written.</span>}
                  />
                )}
              </div>
            )}
            {showPullButton && showPushButton && <span className="gh-sync-cluster__divider" aria-hidden="true" />}
            {showPushButton && (
              <div className="gh-sync-cluster__segment">
                <button
                  type="button"
                  onClick={onPush}
                  disabled={pushDisabledReason !== null}
                  aria-busy={isPushing}
                  className="gh-sync-cluster__button"
                  aria-label={pushName}
                  title={pushTitle}
                >
                  {showPushIcon && <IconPush className={isPushing ? "gh-toolbar__icon--pulse" : undefined} />}
                  {!hideSyncLabels && <span>Push</span>}
                  {(ahead ?? 0) > 0 && (
                    <span
                      className={`gh-sync-pill gh-tabular${diverged ? " gh-sync-pill--warning" : ""}`}
                      aria-hidden="true"
                    >
                      {cappedPillText(ahead!)}
                    </span>
                  )}
                </button>
                {/* FR-345: the caret only ever OPENS a menu on a multi-remote repo, but its width
                    is always reserved (a visually-inert, non-interactive same-size placeholder
                    otherwise) so the cluster's geometry never shifts between a one-remote and a
                    multi-remote repo. */}
                {showPushRemotePicker ? (
                  <>
                    <span className="gh-sync-cluster__divider gh-sync-cluster__divider--subtle" aria-hidden="true" />
                    <button
                      ref={pushCaretRef}
                      type="button"
                      onClick={openPushMenu}
                      disabled={isPushing}
                      className="gh-sync-cluster__caret"
                      aria-haspopup="menu"
                      aria-expanded={openMenu === "push"}
                      aria-label="Push remote options"
                      title="Choose which remote to push to"
                    >
                      <IconChevronDown size={12} />
                    </button>
                  </>
                ) : (
                  <span className="gh-sync-cluster__caret gh-sync-cluster__caret--reserved" aria-hidden="true" />
                )}
                {openMenu === "push" && (
                  <ContextMenu
                    x={menuAnchor.x}
                    y={menuAnchor.y}
                    ariaLabel="Push to"
                    header={<span>Push to</span>}
                    items={pushMenuItems}
                    onClose={() => setOpenMenu(null)}
                  />
                )}
              </div>
            )}
          </div>
        )}

        {/* Divider 2: only when the sync cluster was actually shown (divider 1 above already
            separates cluster 1 from cluster 3 directly when there's no sync cluster between
            them) — this is what keeps the total at exactly two dividers in the normal case. */}
        {showSyncCluster && <span className="gh-toolbar__divider" aria-hidden="true" />}

        <div className="gh-toolbar__group gh-toolbar__group--settings">
          {!foldIdentityIntoMenu && (
            <button
              type="button"
              onClick={onOpenIdentityProfiles}
              className="gh-toolbar__icon-button"
              aria-label="Git identity profiles"
              title="Git identity profiles — manage per-repo commit identity and SSH key profiles"
            >
              <IconIdentity />
            </button>
          )}
          <button
            ref={moreButtonRef}
            type="button"
            onClick={openMoreMenu}
            className="gh-toolbar__icon-button"
            aria-haspopup="menu"
            aria-expanded={openMenu === "more"}
            aria-label="More actions"
            title="More actions"
          >
            <IconMoreHorizontal />
          </button>
          {openMenu === "more" && (
            <ContextMenu
              x={menuAnchor.x}
              y={menuAnchor.y}
              ariaLabel="More actions"
              items={overflowMenuItems}
              onClose={() => setOpenMenu(null)}
            />
          )}
        </div>
      </div>
    </header>
  );
}
