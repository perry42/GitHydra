import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { CommitLogFilter } from "@githydra/git-core";
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
    // Deliberately not depending on `filter` — this effect must only run when `openSequence`
    // itself changes; it reads whatever `filter` value this render already has (which, per the
    // ordering guarantee in `useRepositoryGraph.openRepo`, is already the new tab's filter by the
    // time `openSequence` bumps — see that field's doc comment).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSequence]);

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
          <div className="gh-filter-bar__field">
            <label htmlFor={`${idPrefix}-from`}>From</label>
            <input
              id={`${idPrefix}-from`}
              type="date"
              value={form.dateFrom}
              onChange={(e) => setForm((f) => ({ ...f, dateFrom: e.target.value }))}
            />
          </div>
          <div className="gh-filter-bar__field">
            <label htmlFor={`${idPrefix}-to`}>To</label>
            <input
              id={`${idPrefix}-to`}
              type="date"
              value={form.dateTo}
              onChange={(e) => setForm((f) => ({ ...f, dateTo: e.target.value }))}
            />
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
