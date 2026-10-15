// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { GitHydraApi } from "../../../shared/ipcContract";
import { GITHYDRA_TAB_ID, type AddProgramResult, type ProgramsSnapshot, type ProgramView } from "../../../shared/programsContract";
import { unwrap } from "../../hooks/gitHydraClient";
import { useDialogChrome } from "../../hooks/useDialogChrome";
import { visibleText } from "../../lib/worktrees";
import { IconOpenInEditor } from "../Icon/Icon";
import "./ProgramsDialog.css";

export interface ProgramsDialogProps {
  api: GitHydraApi;
  onClose: () => void;
  /** The menus keep their own copy of the list; the dialog hands it back after every change. */
  onChanged?: (snapshot: ProgramsSnapshot) => void;
}

type Pending = { pendingId: string; path: string; why: "repository" | "world-writable"; replaces: string | null };
type Message = { tone: "info" | "error"; text: string };

const RISK_TEXT: Record<Pending["why"], string> = {
  repository: "This file is inside a repository or a worktree.",
  "world-writable": "This file is in a folder that any user of this computer can write to.",
};

/**
 * specs/external-programs.md FR-623: the Programs dialog. Same shell as the Identity Profiles dialog (overlay, panel, list rows),
 * self-contained so it can move into a future Settings page. It never sees or sends a path: Add and Locate open a picker in main.
 */
export function ProgramsDialog({ api, onClose, onChanged }: ProgramsDialogProps) {
  const titleId = useId();
  const radioGroupId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [snapshot, setSnapshot] = useState<ProgramsSnapshot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  const accept = useCallback((next: ProgramsSnapshot) => {
    setSnapshot(next);
    onChangedRef.current?.(next);
  }, []);

  const load = useCallback(async () => {
    try {
      accept(unwrap(await api.listExternalPrograms()));
    } catch (err) {
      setMessage({ tone: "error", text: `Could not load programs: ${err instanceof Error ? err.message : String(err)}` });
    }
  }, [api, accept]);

  useEffect(() => {
    void load();
  }, [load]);

  const { onOverlayMouseDown } = useDialogChrome({
    onEscape: () => (pending ? setPending(null) : onClose()),
    escapeDeps: [onClose, pending],
    getFocusTarget: () => dialogRef.current?.querySelector<HTMLElement>("button, input") ?? null,
    onBackdropClick: onClose,
  });

  /** One place for every action: marks the dialog busy, shows what came back, reloads the list. */
  async function run(label: string, work: () => Promise<void>) {
    setBusy(label);
    setMessage(null);
    try {
      await work();
    } catch (err) {
      setMessage({ tone: "error", text: err instanceof Error ? visibleText(err.message) : "That did not work." });
    } finally {
      setBusy(null);
    }
  }

  function describeAdd(res: AddProgramResult, replaces: string | null): void {
    if ("status" in res) {
      if (res.status === "added") setMessage({ tone: "info", text: `${replaces ? "Updated" : "Added"} ${visibleText(res.program.name)}.` });
      else if (res.status === "rejected") setMessage({ tone: "error", text: res.message });
      else if (res.status === "needs-confirm") setPending({ pendingId: res.pendingId, path: res.path, why: res.why, replaces });
      return;
    }
    setMessage({ tone: "error", text: res.message });
  }

  const add = () =>
    run("add", async () => {
      describeAdd(unwrap(await api.addExternalProgram()), null);
      await load();
    });
  const locate = (p: ProgramView) =>
    run(`locate:${p.id}`, async () => {
      describeAdd(unwrap(await api.locateExternalProgram(p.id)), p.id);
      await load();
    });
  const confirm = () =>
    run("confirm", async () => {
      if (!pending) return;
      const { pendingId, replaces } = pending;
      setPending(null);
      describeAdd(unwrap(await api.confirmAddExternalProgram(pendingId)), replaces);
      await load();
    });
  const rescan = () =>
    run("rescan", async () => {
      accept(unwrap(await api.rescanExternalPrograms()));
      setMessage({ tone: "info", text: "Looked for programs again." });
    });
  const simple = (label: string, call: () => Promise<{ ok: true; snapshot: ProgramsSnapshot } | { ok: false; message: string }>) =>
    run(label, async () => {
      const res = await call();
      if (res.ok) accept(res.snapshot);
      else setMessage({ tone: "error", text: res.message });
    });

  const defaultId = snapshot?.defaultId ?? null;
  const rows = snapshot?.programs ?? [];

  return (
    <div className="gh-programs-dialog__overlay" onMouseDown={onOverlayMouseDown}>
      <div ref={dialogRef} className="gh-programs-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId} className="gh-programs-dialog__title">
          <IconOpenInEditor /> Programs
        </h2>
        <p className="gh-programs-dialog__intro">
          Programs that can open a worktree or repository folder. They are found on this computer and kept in a file only GitHydra
          writes; nothing is sent anywhere. The default is the program last used.
        </p>

        {message && (
          <p className={`gh-programs-dialog__message gh-programs-dialog__message--${message.tone}`} role={message.tone === "error" ? "alert" : "status"}>
            {message.text}
          </p>
        )}

        {pending && (
          <div className="gh-programs-dialog__confirm" role="alertdialog" aria-labelledby={`${radioGroupId}-confirm`}>
            <p id={`${radioGroupId}-confirm`} className="gh-programs-dialog__confirm-text">
              {RISK_TEXT[pending.why]} Only add it if you trust everything in that folder. Full path:
            </p>
            <code className="gh-programs-dialog__confirm-path gh-mono">{visibleText(pending.path)}</code>
            <div className="gh-programs-dialog__confirm-actions">
              <button type="button" className="gh-programs-dialog__button" onClick={() => setPending(null)}>
                Cancel
              </button>
              <button type="button" className="gh-programs-dialog__button gh-programs-dialog__button--primary" onClick={() => void confirm()}>
                Add anyway
              </button>
            </div>
          </div>
        )}

        {snapshot === null && !message ? (
          <p className="gh-programs-dialog__hint" role="status" aria-busy="true">
            Looking for programs…
          </p>
        ) : (
          <ul className="gh-programs-dialog__list" role="radiogroup" aria-label="Default program">
            <li className="gh-programs-dialog__row">
              <div className="gh-programs-dialog__row-main">
                <span className="gh-programs-dialog__row-name">GitHydra tab</span>
                <span className="gh-programs-dialog__row-detail">Opens the folder as a new tab here. Always available.</span>
              </div>
              <label className="gh-programs-dialog__radio">
                <input
                  type="radio"
                  name={radioGroupId}
                  checked={defaultId === GITHYDRA_TAB_ID}
                  disabled={busy !== null}
                  onChange={() => void simple("default", async () => unwrap(await api.setDefaultExternalProgram(GITHYDRA_TAB_ID)))}
                />
                Default
                <span className="gh-visually-hidden">: GitHydra tab</span>
              </label>
            </li>
            {rows.map((p) => (
              <ProgramRow
                key={p.id}
                program={p}
                radioName={radioGroupId}
                isDefault={p.isDefault && defaultId !== GITHYDRA_TAB_ID}
                busy={busy !== null}
                onDefault={() => void simple("default", async () => unwrap(await api.setDefaultExternalProgram(p.id)))}
                onToggleHidden={() => void simple("hide", async () => unwrap(await api.setExternalProgramHidden(p.id, !p.hidden)))}
                onLocate={() => void locate(p)}
                onRemove={() => void simple("remove", async () => unwrap(await api.removeExternalProgram(p.id)))}
              />
            ))}
            {snapshot && rows.length === 0 && (
              <li className="gh-programs-dialog__empty">No editors were found on this computer. Use Add program to choose your own.</li>
            )}
          </ul>
        )}

        {snapshot?.fallbackReason && <p className="gh-programs-dialog__hint">{visibleText(snapshot.fallbackReason)}</p>}

        <div className="gh-programs-dialog__actions">
          <button type="button" className="gh-programs-dialog__button" onClick={() => void add()} disabled={busy !== null}>
            Add program…
          </button>
          <button type="button" className="gh-programs-dialog__button" onClick={() => void rescan()} disabled={busy !== null}>
            {busy === "rescan" ? "Looking…" : "Rescan"}
          </button>
          <span className="gh-programs-dialog__spacer" />
          <button type="button" className="gh-programs-dialog__button" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function ProgramRow({
  program: p,
  radioName,
  isDefault,
  busy,
  onDefault,
  onToggleHidden,
  onLocate,
  onRemove,
}: {
  program: ProgramView;
  radioName: string;
  isDefault: boolean;
  busy: boolean;
  onDefault: () => void;
  onToggleHidden: () => void;
  onLocate: () => void;
  onRemove: () => void;
}) {
  const missing = !p.available;
  const detailId = useId();
  return (
    <li className={`gh-programs-dialog__row${missing ? " gh-programs-dialog__row--missing" : ""}${p.hidden ? " gh-programs-dialog__row--hidden" : ""}`} aria-disabled={missing ? true : undefined}>
      <div className="gh-programs-dialog__row-main">
        <span className="gh-programs-dialog__row-name">
          {visibleText(p.name)}
          {p.hidden && <span className="gh-programs-dialog__tag"> Hidden</span>}
          {p.source === "custom" && <span className="gh-programs-dialog__tag"> Added by you</span>}
        </span>
        <span id={detailId} className="gh-programs-dialog__row-detail gh-mono" title={p.resolvedPath ? `Resolves to ${p.resolvedPath}` : p.path}>
          {missing ? visibleText(p.unavailableReason ?? `Not found at ${p.path}`) : visibleText(p.path)}
        </span>
      </div>
      <div className="gh-programs-dialog__row-actions">
        <label className="gh-programs-dialog__radio">
          <input
            type="radio"
            name={radioName}
            checked={isDefault}
            disabled={busy || missing || p.hidden}
            onChange={onDefault}
            aria-describedby={detailId}
          />
          Default
          <span className="gh-visually-hidden">: {visibleText(p.name)}</span>
        </label>
        <button
          type="button"
          className="gh-programs-dialog__button gh-programs-dialog__button--small"
          disabled={busy || isDefault}
          title={isDefault ? "The default program cannot be hidden." : undefined}
          aria-label={`${p.hidden ? "Show" : "Hide"} ${visibleText(p.name)}`}
          onClick={onToggleHidden}
        >
          {p.hidden ? "Show" : "Hide"}
        </button>
        {missing && (
          <button type="button" className="gh-programs-dialog__button gh-programs-dialog__button--small" disabled={busy} aria-label={`Locate ${visibleText(p.name)}`} onClick={onLocate}>
            Locate…
          </button>
        )}
        {p.source === "custom" && (
          <button type="button" className="gh-programs-dialog__button gh-programs-dialog__button--small gh-programs-dialog__button--danger" disabled={busy} aria-label={`Remove ${visibleText(p.name)}`} onClick={onRemove}>
            Remove
          </button>
        )}
      </div>
    </li>
  );
}
