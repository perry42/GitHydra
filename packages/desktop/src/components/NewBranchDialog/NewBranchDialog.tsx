import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import type { CreateBranchOptions, RefInfo } from "@githydra/git-core";
import type { GitHydraApi } from "../../../shared/ipcContract";
import { unwrap } from "../../hooks/gitHydraClient";
import "./NewBranchDialog.css";

export interface NewBranchDialogProps {
  api: GitHydraApi;
  /** Local/remote branches + tags to populate the start-point picker (FR-49) — the same `RefInfo[]`
   * the graph already reads, so no separate fetch is needed for this dialog. */
  refs: RefInfo[];
  /** FR-49: "switch to it" requires a working directory to switch into — hidden/disabled on a
   * bare repo (`repoState.isBare` / no `workdir`). */
  hasWorkdir: boolean;
  /** FR-49/AC12: an unborn-HEAD, zero-commit repo has no start-point commit at all. */
  isEmptyRepo: boolean;
  /** Pre-fills the start point (FR-54's "Create branch here" from a specific commit). */
  defaultStartPoint?: { value: string; label: string };
  onClose: () => void;
  /** Called after a successful create, before `onClose` — the caller refreshes refs/branch list (FR-56). */
  onCreated: () => void;
}

const CUSTOM_VALUE = "__custom__";

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * FR-49: name field validated against `validateBranchName` before submit (FR-35, AC5 — no
 * mutating call is ever attempted for an invalid name), a start-point picker defaulting to HEAD,
 * and a "switch to new branch" checkbox. One instance is rendered by `App` regardless of which
 * surface requested it (the Branches panel's "+ New Branch" button, or the graph's "Create branch
 * here" context-menu action) so both go through identical validation/creation logic.
 */
export function NewBranchDialog({
  api,
  refs,
  hasWorkdir,
  isEmptyRepo,
  defaultStartPoint,
  onClose,
  onCreated,
}: NewBranchDialogProps) {
  const titleId = useId();
  const nameId = useId();
  const nameErrorId = useId();
  const startPointId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [startPointValue, setStartPointValue] = useState(defaultStartPoint ? defaultStartPoint.value : "");
  const [customStartPoint, setCustomStartPoint] = useState("");
  const [switchToIt, setSwitchToIt] = useState(hasWorkdir);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    dialogRef.current?.querySelector<HTMLElement>("input,select,button")?.focus();
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const localBranches = useMemo(() => refs.filter((r) => r.type === "local-branch"), [refs]);
  const tags = useMemo(() => refs.filter((r) => r.type === "tag"), [refs]);
  const remoteBranchesByRemote = useMemo(() => {
    const map = new Map<string, RefInfo[]>();
    for (const r of refs) {
      if (r.type !== "remote-branch") continue;
      const key = r.remoteName ?? "remote";
      const bucket = map.get(key);
      if (bucket) bucket.push(r);
      else map.set(key, [r]);
    }
    return map;
  }, [refs]);

  async function validateName(candidate: string): Promise<boolean> {
    const trimmed = candidate.trim();
    if (!trimmed) {
      setNameError("Branch name is required.");
      return false;
    }
    try {
      unwrap(await api.validateBranchName(trimmed));
      setNameError(null);
      return true;
    } catch (err) {
      setNameError(messageOf(err));
      return false;
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (isEmptyRepo || submitting) return;
    setSubmitError(null);
    const trimmed = name.trim();
    const valid = await validateName(trimmed);
    if (!valid) return;

    let startPoint: string | undefined;
    if (startPointValue === CUSTOM_VALUE) {
      const custom = customStartPoint.trim();
      if (!custom) {
        setSubmitError("Enter a commit SHA, branch, or tag to start from.");
        return;
      }
      startPoint = custom;
    } else if (startPointValue) {
      startPoint = startPointValue;
    }

    const options: CreateBranchOptions = {
      name: trimmed,
      startPoint,
      switchToIt: hasWorkdir && switchToIt,
    };

    setSubmitting(true);
    try {
      unwrap(await api.createBranch(options));
      onCreated();
      onClose();
    } catch (err) {
      setSubmitError(messageOf(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="gh-new-branch__overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={dialogRef}
        className="gh-new-branch"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <h2 id={titleId} className="gh-new-branch__title">
          New Branch
        </h2>

        {isEmptyRepo ? (
          <>
            {/* AC12: unborn HEAD / zero-commit repo — there is no start-point commit to branch
                from yet, an explicit message rather than a broken form or a crash. */}
            <p className="gh-new-branch__empty">
              This repository has no commits yet, so there is no start point to create a branch
              from. Make the first commit, then create a branch.
            </p>
            <div className="gh-new-branch__actions">
              <button type="button" className="gh-new-branch__cancel" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={(e) => void handleSubmit(e)}>
            <label className="gh-new-branch__label" htmlFor={nameId}>
              Branch name
            </label>
            <input
              id={nameId}
              type="text"
              className="gh-mono gh-new-branch__input"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (nameError) setNameError(null);
              }}
              onBlur={() => {
                if (name.trim()) void validateName(name);
              }}
              aria-invalid={nameError ? true : undefined}
              aria-describedby={nameError ? nameErrorId : undefined}
              placeholder="feature/my-change"
              required
            />
            {nameError && (
              <p id={nameErrorId} className="gh-new-branch__error" role="alert">
                {nameError}
              </p>
            )}

            <label className="gh-new-branch__label" htmlFor={startPointId}>
              Start point
            </label>
            <select
              id={startPointId}
              className="gh-mono gh-new-branch__input"
              value={startPointValue}
              onChange={(e) => setStartPointValue(e.target.value)}
            >
              <option value="">HEAD (current)</option>
              {defaultStartPoint && <option value={defaultStartPoint.value}>{defaultStartPoint.label}</option>}
              {localBranches.length > 0 && (
                <optgroup label="Branches">
                  {localBranches.map((r) => (
                    <option key={r.fullName} value={r.shortName}>
                      {r.shortName}
                    </option>
                  ))}
                </optgroup>
              )}
              {[...remoteBranchesByRemote.entries()].map(([remote, branches]) => (
                <optgroup key={remote} label={remote}>
                  {branches.map((r) => (
                    <option key={r.fullName} value={r.shortName}>
                      {r.shortName}
                    </option>
                  ))}
                </optgroup>
              ))}
              {tags.length > 0 && (
                <optgroup label="Tags">
                  {tags.map((r) => (
                    <option key={r.fullName} value={r.shortName}>
                      {r.shortName}
                    </option>
                  ))}
                </optgroup>
              )}
              <option value={CUSTOM_VALUE}>Custom (commit SHA / ref)…</option>
            </select>

            {startPointValue === CUSTOM_VALUE && (
              <input
                type="text"
                className="gh-mono gh-new-branch__input"
                value={customStartPoint}
                onChange={(e) => setCustomStartPoint(e.target.value)}
                placeholder="Commit SHA, branch, or tag"
                aria-label="Custom start point"
              />
            )}

            <label className="gh-new-branch__checkbox">
              <input
                type="checkbox"
                checked={hasWorkdir && switchToIt}
                disabled={!hasWorkdir}
                onChange={(e) => setSwitchToIt(e.target.checked)}
              />
              Switch to the new branch
            </label>
            {!hasWorkdir && (
              <p className="gh-new-branch__hint">
                This is a bare repository — there is no working directory to switch into.
              </p>
            )}

            {submitError && (
              <p className="gh-new-branch__error" role="alert">
                {submitError}
              </p>
            )}

            <div className="gh-new-branch__actions">
              <button type="button" className="gh-new-branch__cancel" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="gh-new-branch__submit" disabled={submitting || !name.trim()}>
                {submitting ? "Creating…" : "Create branch"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
