import { useEffect, useId, useState, type FormEvent } from "react";
import type { CommitLogFilter } from "@githydra/git-core";
import "./FilterBar.css";

export interface FilterBarProps {
  filter: CommitLogFilter;
  onApply: (filter: CommitLogFilter) => void;
  onClear: () => void;
  showAllRefs: boolean;
  onShowAllRefsChange: (value: boolean) => void;
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

/** FR-14/FR-7: search/filter bar backed by CommitLogFilter. A SHA/prefix search takes over the
 * whole query (matching git-core's documented "sha set -> all other filters ignored" behavior —
 * see packages/git-core's commitLog.ts), so entering one clears the rest here too. */
export function FilterBar({ filter, onApply, onClear, showAllRefs, onShowAllRefsChange }: FilterBarProps) {
  const [form, setForm] = useState<FormState>(() => filterToForm(filter));
  const idPrefix = useId();

  useEffect(() => {
    setForm(filterToForm(filter));
  }, [filter]);

  const isFilterActive = Object.values(filter).some((v) => (Array.isArray(v) ? v.length > 0 : Boolean(v)));

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
        <input
          type="checkbox"
          checked={showAllRefs}
          onChange={(e) => onShowAllRefsChange(e.target.checked)}
        />
        Show all branches &amp; tags
      </label>
    </form>
  );
}
