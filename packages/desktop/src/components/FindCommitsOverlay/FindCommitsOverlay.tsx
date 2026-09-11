// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { CommitLogFilter } from "@githydra/git-core";
import { matchesKeyCombo } from "../../lib/platform";
import { IconCalendar } from "../Icon/Icon";
import "./FindCommitsOverlay.css";

export interface FindCommitsOverlayProps {
  filter: CommitLogFilter;
  onApply: (filter: CommitLogFilter) => void;
  onClear: () => void;
  showAllRefs: boolean;
  onShowAllRefsChange: (value: boolean) => void;
  /**
   * specs/find-commits-overlay.md FR-265: bumped by the caller (`useRepositoryGraph`'s
   * `openSequence`) on every real "repo identity changed" event — a tab switch or a tab close
   * landing on an adjacent tab. Reused verbatim from the retired `FilterBar`'s own prop of the
   * same name/meaning; this component force-closes (via `onClose`, the same close-and-clear path
   * as Esc/click-outside) whenever it changes while mounted, so it never sits open pointed at a
   * stale tab's filter.
   */
  openSequence?: number;
  /** FR-264: the "N commits loaded" status readout, moved here from the retired FilterBar's
   * collapsed row — rendered only while this overlay is open (it's never mounted otherwise). */
  loadedCommitCount?: number;
  hasMoreCommits?: boolean;
  /**
   * FR-263/AC7: closes the overlay AND clears the active filter back to empty — the single close
   * path for Esc, clicking outside, re-triggering the open action while already open (this
   * component's own local keydown listener, since the global keybinding layer is suspended while
   * `findCommitsOpen` is folded into `anyModalDialogOpen` — FR-266), and a tab-boundary force-close
   * (FR-265). The caller (`App.tsx`) is expected to both hide this component (unmount) and call
   * `onClear` from this single callback — matching `CommandPalette`'s `onClose` convention, just
   * with the extra "also clear" behavior this feature's spec requires.
   */
  onClose: () => void;
}

interface FormState {
  author: string;
  message: string;
  sha: string;
  dateFrom: string;
  dateTo: string;
  path: string;
}

const EMPTY: FormState = { author: "", message: "", sha: "", dateFrom: "", dateTo: "", path: "" };

/** Reused verbatim from the retired `FilterBar.tsx` (specs/find-commits-overlay.md FR-257). */
export function filterToForm(filter: CommitLogFilter): FormState {
  return {
    author: filter.author ?? "",
    message: filter.messageSubstring ?? "",
    sha: filter.sha ?? "",
    dateFrom: filter.dateFrom ?? "",
    dateTo: filter.dateTo ?? "",
    path: filter.paths?.[0] ?? "",
  };
}

/** Reused verbatim from the retired `FilterBar.tsx` (specs/find-commits-overlay.md FR-257). */
export function isFilterActiveOf(filter: CommitLogFilter): boolean {
  return Object.values(filter).some((v) => (Array.isArray(v) ? v.length > 0 : Boolean(v)));
}

/**
 * specs/find-commits-overlay.md — the "Find commits" floating overlay that replaces the retired,
 * permanently-mounted `FilterBar` row. Only ever rendered by `App.tsx` while its own
 * `findCommitsOpen` boolean is true (conditionally mounted exactly like `CommandPalette`), so
 * there is zero reserved vertical space above the commit graph in any other state (FR-257/AC1).
 *
 * FR-260: all six fields (SHA/Author/Message/From/To/Path) render together, flat — the prior
 * primary/secondary "More filters" two-tier disclosure (`specs/filter-bar-visual-redesign.md`) is
 * dropped entirely; this overlay's own mount/unmount is now the one disclosure layer.
 *
 * FR-261: seeded on mount from the active tab's current filter/showAllRefs — reopening for a tab
 * with an already-applied filter shows those values, not a blank form. The SHA field is
 * auto-focused on open (FR-261), matching `CommandPalette`/`NewBranchDialog`'s established
 * focused-input-on-open convention.
 *
 * FR-263/AC7/AC8: closing this overlay — via Esc, clicking outside it, or re-triggering the open
 * action while it's already open — always calls `onClose` (hide + clear the active filter),
 * regardless of whether the visible field values were ever submitted; typed-but-unsubmitted drafts
 * are simply discarded since this component unmounts. The "re-trigger" leg is handled by this
 * component's own local keydown listener below (mirroring the exact combo that opens it) because
 * the global keybinding layer is suspended (FR-266) the entire time this is mounted — a second
 * press of the same shortcut would otherwise never reach anything.
 */
export function FindCommitsOverlay({
  filter,
  onApply,
  onClear,
  showAllRefs,
  onShowAllRefsChange,
  openSequence,
  loadedCommitCount,
  hasMoreCommits = false,
  onClose,
}: FindCommitsOverlayProps) {
  const [form, setForm] = useState<FormState>(() => filterToForm(filter));
  const idPrefix = useId();
  const titleId = useId();
  const shaInputRef = useRef<HTMLInputElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const openSequenceRef = useRef(openSequence);

  useEffect(() => {
    setForm(filterToForm(filter));
  }, [filter]);

  // FR-261: SHA auto-focused the instant this overlay mounts.
  useEffect(() => {
    shaInputRef.current?.focus();
  }, []);

  // FR-263 (re-trigger leg) + FR-265: Esc, the same open combo fired again, and an `openSequence`
  // change (a tab switch/close while open) all route through the same close-and-clear `onClose`.
  useEffect(() => {
    function onDocKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (matchesKeyCombo(e, { key: "f", mod: true, shift: true })) {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener("keydown", onDocKeyDown);
    return () => document.removeEventListener("keydown", onDocKeyDown);
  }, [onClose]);

  // FR-263/AC7 (click-outside leg): unlike `CommandPalette`'s dark full-screen scrim, this overlay
  // is explicitly NOT a centered full-screen modal (FR-259) — it must not block clicks on the rest
  // of the app (the toolbar, tab bar, branches sidebar, or the graph itself) the way a scrim
  // element physically would. A document-level `mousedown` listener that only checks whether the
  // click landed outside this panel's own DOM subtree — rather than an intervening full-viewport
  // click-catcher div — closes this overlay WITHOUT consuming the click, so whatever the user
  // actually clicked (e.g. a different tab in the TabBar, AC9) still receives it normally.
  //
  // The toolbar's own "Find commits" trigger button (`data-find-commits-trigger`) is deliberately
  // excluded from this check: a real pointer interaction dispatches `mousedown` and `click` as two
  // separate events, and React can (and does, under `@testing-library/user-event`'s realistic
  // sequencing, which is what caught this) re-render in between. Without this exclusion,
  // re-clicking that button to close the overlay would race — `mousedown` closes it here first,
  // then the button's own `click` handler reopens it because it now reads fresh (already-closed)
  // state. Excluding the trigger leaves it as the single, race-free owner of the "re-click while
  // open closes it" leg of FR-263; this listener still owns every other outside click.
  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      const target = e.target as Element | null;
      if (target?.closest("[data-find-commits-trigger]")) return;
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [onClose]);

  useEffect(() => {
    if (openSequence === undefined) return;
    if (openSequence === openSequenceRef.current) return;
    openSequenceRef.current = openSequence;
    onClose();
    // Deliberately not depending on anything but `openSequence`/`onClose` — this must only react
    // to a genuine repo/tab-identity change, the same boundary `FilterBar`'s own `openSequence`
    // effect used.
  }, [openSequence, onClose]);

  const isFilterActive = isFilterActiveOf(filter);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmedSha = form.sha.trim();
    if (trimmedSha) {
      onApply({ sha: trimmedSha });
      return;
    }
    const next: CommitLogFilter = {};
    if (form.author.trim()) next.author = form.author.trim();
    if (form.message.trim()) next.messageSubstring = form.message.trim();
    if (form.dateFrom.trim()) next.dateFrom = form.dateFrom.trim();
    if (form.dateTo.trim()) next.dateTo = form.dateTo.trim();
    if (form.path.trim()) next.paths = [form.path.trim()];
    onApply(next);
  }

  function handleClear() {
    setForm(EMPTY);
    onClear();
  }

  return (
    <div
      ref={panelRef}
      className="gh-find-commits"
      role="dialog"
      aria-labelledby={titleId}
    >
      <h2 id={titleId} className="gh-visually-hidden">
        Find commits
      </h2>
      <form className="gh-find-commits__form" onSubmit={handleSubmit} role="search" aria-label="Find commits">
        <div className="gh-find-commits__fields">
          <div className="gh-find-commits__field">
            <label htmlFor={`${idPrefix}-sha`}>SHA</label>
            <input
              ref={shaInputRef}
              id={`${idPrefix}-sha`}
              type="text"
              value={form.sha}
              placeholder="abc1234"
              onChange={(e) => setForm((f) => ({ ...f, sha: e.target.value }))}
            />
          </div>
          <div className="gh-find-commits__field">
            <label htmlFor={`${idPrefix}-author`}>Author</label>
            <input
              id={`${idPrefix}-author`}
              type="text"
              value={form.author}
              onChange={(e) => setForm((f) => ({ ...f, author: e.target.value }))}
            />
          </div>
          <div className="gh-find-commits__field gh-find-commits__field--grow">
            <label htmlFor={`${idPrefix}-message`}>Message</label>
            <input
              id={`${idPrefix}-message`}
              type="text"
              value={form.message}
              onChange={(e) => setForm((f) => ({ ...f, message: e.target.value }))}
            />
          </div>
          <div className="gh-find-commits__field">
            <label htmlFor={`${idPrefix}-from`}>From</label>
            <div className="gh-find-commits__date-input-wrap">
              <input
                id={`${idPrefix}-from`}
                type="date"
                value={form.dateFrom}
                onChange={(e) => setForm((f) => ({ ...f, dateFrom: e.target.value }))}
              />
              <IconCalendar size={14} className="gh-find-commits__calendar-icon" />
            </div>
          </div>
          <div className="gh-find-commits__field">
            <label htmlFor={`${idPrefix}-to`}>To</label>
            <div className="gh-find-commits__date-input-wrap">
              <input
                id={`${idPrefix}-to`}
                type="date"
                value={form.dateTo}
                onChange={(e) => setForm((f) => ({ ...f, dateTo: e.target.value }))}
              />
              <IconCalendar size={14} className="gh-find-commits__calendar-icon" />
            </div>
          </div>
          <div className="gh-find-commits__field">
            <label htmlFor={`${idPrefix}-path`}>File path</label>
            <input
              id={`${idPrefix}-path`}
              type="text"
              value={form.path}
              onChange={(e) => setForm((f) => ({ ...f, path: e.target.value }))}
            />
          </div>
        </div>

        <div className="gh-find-commits__footer">
          <button type="submit" className="gh-find-commits__apply">
            Search
          </button>
          <button type="button" className="gh-find-commits__clear" onClick={handleClear} disabled={!isFilterActive}>
            Clear
          </button>
          <label className="gh-find-commits__toggle">
            <input type="checkbox" checked={showAllRefs} onChange={(e) => onShowAllRefsChange(e.target.checked)} />
            Show all branches &amp; tags
          </label>
          {loadedCommitCount != null && (
            <span
              className="gh-find-commits__status gh-tabular"
              title={
                hasMoreCommits
                  ? "More history is available — scroll the graph or search to load further commits."
                  : "The full loaded history."
              }
            >
              {loadedCommitCount.toLocaleString()}
              {hasMoreCommits ? "+" : ""} commits loaded
            </span>
          )}
        </div>
      </form>
    </div>
  );
}
