// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { CommitLogFilter } from "@githydra/git-core";
import { IconCalendar } from "../Icon/Icon";
import "./FilterBar.css";

export interface FilterBarProps {
  filter: CommitLogFilter;
  onApply: (filter: CommitLogFilter) => void;
  onClear: () => void;
  showAllRefs: boolean;
  onShowAllRefsChange: (value: boolean) => void;
  /**
   * specs/multi-repo-tabs.md: bumped by the caller (`useRepositoryGraph`'s `openSequence`) on
   * every real "repo identity changed" event — including reactivating a previously-visited tab.
   * Optional/undefined for callers outside the tab feature (nothing to reset against, so the
   * disclosure just keeps its current state forever, same as before this prop existed).
   */
  openSequence?: number;
  /**
   * design-pass fix #5 ("dead whitespace under toolbar"): the collapsed row's trailing space
   * (mostly empty next to the small "Search & filter" toggle) now carries a quiet, honest status
   * readout instead of sitting blank — how many commits are currently loaded into the graph.
   * Deliberately worded "loaded" (not "total") since this is only ever the currently-fetched
   * page count (`useRepositoryGraph`'s pagination, FR-12) — the same "never imply more than we
   * know" framing `BranchesPanel`'s ahead/behind captioning already established. Omitted (no
   * readout rendered) when undefined, so callers outside the one real usage aren't forced to wire
   * it up.
   */
  loadedCommitCount?: number;
  /** Pairs with `loadedCommitCount`: true when more history exists beyond what's loaded, so the
   * readout can say "1,532+ commits loaded" rather than implying that's the repo's full history. */
  hasMoreCommits?: boolean;
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

function filterToForm(filter: CommitLogFilter): FormState {
  return {
    author: filter.author ?? "",
    message: filter.messageSubstring ?? "",
    sha: filter.sha ?? "",
    dateFrom: filter.dateFrom ?? "",
    dateTo: filter.dateTo ?? "",
    path: filter.paths?.[0] ?? "",
  };
}

function isFilterActiveOf(filter: CommitLogFilter): boolean {
  return Object.values(filter).some((v) => (Array.isArray(v) ? v.length > 0 : Boolean(v)));
}

/**
 * specs/filter-bar-visual-redesign.md FR-250/251: the From/To/Path subset of `isFilterActiveOf`,
 * used both for the secondary "More filters" disclosure's own active-state dot (FR-250, separate
 * from the outer toggle's all-six-fields dot) and for seeding/resetting its expanded state on a
 * repo/tab boundary (FR-251), mirroring `isFilterActiveOf`'s role for the outer toggle exactly.
 */
function isFromToPathActiveOf(filter: CommitLogFilter): boolean {
  return Boolean(filter.dateFrom || filter.dateTo || (filter.paths && filter.paths.length > 0));
}

/**
 * FR-14/FR-7: search/filter bar backed by CommitLogFilter. A SHA/prefix search takes over the
 * whole query (matching git-core's documented "sha set -> all other filters ignored" behavior —
 * see packages/git-core's commitLog.ts), so entering one clears the rest here too.
 *
 * specs/layout-and-view-polish.md Must-have A: the form itself (all fields/behavior below,
 * unchanged) is wrapped behind a collapsed-by-default toggle control, so it costs one toolbar-
 * height row instead of a permanent row when nobody's filtering.
 *
 * specs/multi-repo-tabs.md fix: `form`'s values are always prop-driven (the `useEffect` below
 * resyncs it from `filter` on every change, regardless of mount/remount), so this component does
 * *not* need to be remounted on every repo open just to pick up a different tab's filter values —
 * a plain prop change already does that. `expanded`, on the other hand, really is local,
 * un-lifted state (deliberately not persisted globally — see spec) — but resetting it by
 * force-remounting the whole component on every `openSequence` bump had a side effect: switching
 * back to a tab whose filter was already applied re-collapsed the disclosure, hiding the (still
 * correctly restored) field values behind a click. Instead, `openSequence` changes reset just
 * `expanded` (via the effect below), seeded from whether *that* tab's incoming filter is active —
 * giving both A5's "a genuinely fresh, unfiltered repo open starts collapsed" and this fix's "a
 * reactivated tab with an applied filter starts already showing it" for free from the same signal.
 *
 * specs/filter-bar-visual-redesign.md: the expanded form (this doc comment's "form" above) is
 * itself now two-tiered — a primary row (SHA/Author/Message/Search/Clear/show-all-refs, unchanged
 * behavior) always shown once `expanded`, plus a secondary "More filters" disclosure nested inside
 * it gating From/To/Path. The secondary disclosure (`moreExpanded` below) reuses the exact same
 * `openSequence`/`lastOpenSequenceRef` reset mechanism as `expanded`, just seeded from the From/
 * To/Path subset (`isFromToPathActiveOf`) instead of all six fields — see FR-249-251.
 */
export function FilterBar({
  filter,
  onApply,
  onClear,
  showAllRefs,
  onShowAllRefsChange,
  openSequence,
  loadedCommitCount,
  hasMoreCommits = false,
}: FilterBarProps) {
  const [form, setForm] = useState<FormState>(() => filterToForm(filter));
  const [expanded, setExpanded] = useState(() => isFilterActiveOf(filter));
  // specs/filter-bar-visual-redesign.md FR-248/249: the secondary "More filters" disclosure
  // (From/To/Path) nested inside the primary form — same reset mechanism as `expanded` below,
  // just seeded/reset from the From/To/Path subset rather than all six fields (FR-251).
  const [moreExpanded, setMoreExpanded] = useState(() => isFromToPathActiveOf(filter));
  const idPrefix = useId();
  // Tracks the last `openSequence` this component has already reacted to, so the reset below only
  // fires on a genuine "repo identity changed" boundary — never on a same-tab filter change (e.g.
  // the user applying/clearing a filter mid-session, which must never fight their manual
  // expand/collapse toggle).
  const lastOpenSequenceRef = useRef(openSequence);

  useEffect(() => {
    setForm(filterToForm(filter));
  }, [filter]);

  useEffect(() => {
    if (openSequence === undefined) return;
    if (openSequence === lastOpenSequenceRef.current) return;
    lastOpenSequenceRef.current = openSequence;
    setExpanded(isFilterActiveOf(filter));
    setMoreExpanded(isFromToPathActiveOf(filter));
    // Deliberately not depending on `filter` — this effect must only run when `openSequence`
    // itself changes; it reads whatever `filter` value this render already has (which, per the
    // ordering guarantee in `useRepositoryGraph.openRepo`, is already the new tab's filter by the
    // time `openSequence` bumps — see that field's doc comment).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSequence]);

  const isFilterActive = isFilterActiveOf(filter);
  const isFromToPathActive = isFromToPathActiveOf(filter);

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
    <div className="gh-filter-bar-collapsed-row">
      <div className="gh-filter-bar__top-row">
        <button
          type="button"
          className={`gh-toolbar__button gh-filter-bar__disclosure${expanded ? " gh-toolbar__button--active" : ""}`}
          aria-expanded={expanded}
          onClick={() => setExpanded((e) => !e)}
        >
          Search &amp; filter
          {isFilterActive && (
            <>
              <span className="gh-filter-bar__toggle-indicator" aria-hidden="true" />
              <span className="gh-visually-hidden">(a filter is currently applied)</span>
            </>
          )}
        </button>
        {loadedCommitCount != null && (
          <span
            className="gh-filter-bar__status gh-tabular"
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

      {expanded && (
        <form className="gh-filter-bar" onSubmit={handleSubmit} role="search" aria-label="Filter commit graph">
          <div className="gh-filter-bar__field">
            <label htmlFor={`${idPrefix}-sha`}>SHA</label>
            <input
              id={`${idPrefix}-sha`}
              type="text"
              value={form.sha}
              placeholder="abc1234"
              onChange={(e) => setForm((f) => ({ ...f, sha: e.target.value }))}
            />
          </div>
          <div className="gh-filter-bar__field">
            <label htmlFor={`${idPrefix}-author`}>Author</label>
            <input
              id={`${idPrefix}-author`}
              type="text"
              value={form.author}
              onChange={(e) => setForm((f) => ({ ...f, author: e.target.value }))}
            />
          </div>
          <div className="gh-filter-bar__field gh-filter-bar__field--grow">
            <label htmlFor={`${idPrefix}-message`}>Message</label>
            <input
              id={`${idPrefix}-message`}
              type="text"
              value={form.message}
              onChange={(e) => setForm((f) => ({ ...f, message: e.target.value }))}
            />
          </div>

          {/* specs/filter-bar-visual-redesign.md FR-248/249: From/To/Path move behind this
           * secondary disclosure, reusing the outer "Search & filter" toggle's exact collapsed-
           * disclosure pattern (chevron + label button; expands in place; never remounts the form
           * or clears the fields it reveals) — see DetailPanel's own metadata-block toggle for the
           * chevron precedent this mirrors. */}
          <button
            type="button"
            className={`gh-filter-bar__more-toggle${moreExpanded ? " gh-filter-bar__more-toggle--active" : ""}`}
            aria-expanded={moreExpanded}
            onClick={() => setMoreExpanded((e) => !e)}
          >
            <span className="gh-filter-bar__more-toggle-chevron" aria-hidden="true">
              {moreExpanded ? "▾" : "▸"}
            </span>
            More filters
            {isFromToPathActive && (
              <>
                <span className="gh-filter-bar__toggle-indicator" aria-hidden="true" />
                <span className="gh-visually-hidden">(a date or file path filter is currently applied)</span>
              </>
            )}
          </button>

          {moreExpanded && (
            <>
              <div className="gh-filter-bar__field">
                <label htmlFor={`${idPrefix}-from`}>From</label>
                <div className="gh-filter-bar__date-input-wrap">
                  <input
                    id={`${idPrefix}-from`}
                    type="date"
                    value={form.dateFrom}
                    onChange={(e) => setForm((f) => ({ ...f, dateFrom: e.target.value }))}
                  />
                  <IconCalendar size={14} className="gh-filter-bar__calendar-icon" />
                </div>
              </div>
              <div className="gh-filter-bar__field">
                <label htmlFor={`${idPrefix}-to`}>To</label>
                <div className="gh-filter-bar__date-input-wrap">
                  <input
                    id={`${idPrefix}-to`}
                    type="date"
                    value={form.dateTo}
                    onChange={(e) => setForm((f) => ({ ...f, dateTo: e.target.value }))}
                  />
                  <IconCalendar size={14} className="gh-filter-bar__calendar-icon" />
                </div>
              </div>
              <div className="gh-filter-bar__field">
                <label htmlFor={`${idPrefix}-path`}>File path</label>
                <input
                  id={`${idPrefix}-path`}
                  type="text"
                  value={form.path}
                  onChange={(e) => setForm((f) => ({ ...f, path: e.target.value }))}
                />
              </div>
            </>
          )}

          <button type="submit" className="gh-filter-bar__apply">
            Search
          </button>
          <button type="button" className="gh-filter-bar__clear" onClick={handleClear} disabled={!isFilterActive}>
            Clear
          </button>

          <label className="gh-filter-bar__toggle">
            <input type="checkbox" checked={showAllRefs} onChange={(e) => onShowAllRefsChange(e.target.checked)} />
            Show all branches &amp; tags
          </label>
        </form>
      )}
    </div>
  );
}
