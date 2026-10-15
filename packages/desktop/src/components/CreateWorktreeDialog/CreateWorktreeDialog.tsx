// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { AddWorktreeSource } from "@githydra/git-core";
import type { GitHydraApi } from "../../../shared/ipcContract";
import { unwrap } from "../../hooks/gitHydraClient";
import { useDialogChrome } from "../../hooks/useDialogChrome";
import {
  CREATE_INTRO,
  DETACHED_WARNING,
  destinationFailure,
  joinFolder,
  resolveWorktreeFolder,
  type CreateFailure,
  type CreateWorktreeValues,
  type WorktreeCreateRequest,
} from "../../lib/worktreeCreate";
import { visibleText } from "../../lib/worktrees";
import { IconChevronDown, IconChevronRight, IconError } from "../Icon/Icon";
// The overlay, frame, inputs and buttons are NewBranchDialog's; this stylesheet only adds the sticky-footer layout and the new parts.
import "../NewBranchDialog/NewBranchDialog.css";
import "./CreateWorktreeDialog.css";

export interface CreateWorktreeDialogProps {
  api: GitHydraApi;
  request: WorktreeCreateRequest;
  /** The MAIN worktree's path (FR-609): relative folders resolve against its parent. */
  mainPath: string;
  /** Resolves null on success (the owner closes the dialog) or the failure to show in a field. */
  onSubmit: (values: CreateWorktreeValues) => Promise<CreateFailure | null>;
  /** The "Open" / "Open that worktree" link: opens the worktree that is in the way instead of creating one. */
  onOpenExisting: (path: string) => void;
  onCancel: () => void;
}

const VALIDATE_DEBOUNCE_MS = 350;

/** An in-field message: an icon (never colour alone), then the text and, inline at the end of it, the optional link. */
function FieldMessage({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} className="gh-create-worktree__error" role="alert">
      <span className="gh-create-worktree__error-icon" aria-hidden="true">
        <IconError size={12} />
      </span>
      <span>{children}</span>
    </p>
  );
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The slug source for the default folder: the branch for a fixed source, else what the user typed, else the commit. */
function slugSource(request: WorktreeCreateRequest, typedName: string, detached: boolean): string {
  if (request.kind === "branch" || request.kind === "remote") return request.branch;
  if (detached && request.kind === "commit") return `detached-${request.sha.slice(0, 7)}`;
  const typed = typedName.trim();
  if (typed) return typed;
  return request.kind === "commit" ? request.sha.slice(0, 7) : "new-branch";
}

/**
 * specs/worktrees.md FR-608..610 (visual truth: the owner-approved mockup). 440 px shell like NewBranchDialog, a sticky
 * footer, and only the body scrolls so it fits an 800 px high window. Validation is in-field with aria-describedby (no toast);
 * the destination rules live in git-core (FR-639), this dialog only shows them.
 */
export function CreateWorktreeDialog({ api, request, mainPath, onSubmit, onOpenExisting, onCancel }: CreateWorktreeDialogProps) {
  const titleId = useId();
  const nameId = useId();
  const nameErrorId = useId();
  const folderId = useId();
  const folderErrorId = useId();
  const previewId = useId();
  const advancedId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const folderRef = useRef<HTMLInputElement | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);

  const needsName = request.kind === "commit" || request.kind === "newFromHead";
  const [name, setName] = useState("");
  const [detached, setDetached] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [folder, setFolder] = useState("");
  const [folderTouched, setFolderTouched] = useState(false);
  const [openAfter, setOpenAfter] = useState(true);
  const [nameError, setNameError] = useState<string | null>(null);
  const [folderFailure, setFolderFailure] = useState<CreateFailure | null>(null);
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [branchLink, setBranchLink] = useState<CreateFailure["link"] | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const slug = slugSource(request, name, detached);

  // FR-609: the prefilled folder follows the branch name until the user edits the field themselves.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = unwrap(await api.getDefaultWorktreePath(slug));
        if (cancelled) return;
        setFolder((current) => (folderTouched ? current : next));
      } catch (err) {
        if (!cancelled) setGeneralError(`Could not work out a default folder: ${messageOf(err)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
    // folderTouched is read only to decide whether to overwrite; a toggle must not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, slug]);

  // FR-610: Folder when the branch is fixed, the branch-name input for a commit. Mount-only, like the other dialogs.
  const { onOverlayMouseDown } = useDialogChrome({
    onEscape: onCancel,
    escapeDeps: [onCancel],
    getFocusTarget: () => (needsName ? nameRef.current : folderRef.current),
    onBackdropClick: onCancel,
  });

  const resolved = resolveWorktreeFolder(folder, mainPath);
  // The resolved absolute path is always shown, so the user can read the leaf even when the field scrolls.
  const showPreview = resolved !== "";

  // A slower answer for older input never overwrites the answer for newer input.
  const nameSeq = useRef(0);
  const folderSeq = useRef(0);

  async function validateName(candidate: string): Promise<boolean> {
    const mine = ++nameSeq.current;
    const trimmed = candidate.trim();
    if (!trimmed) {
      setNameError("Branch name is required.");
      return false;
    }
    try {
      // Verbatim NewBranchDialog behaviour: the same IPC, the same message text.
      unwrap(await api.validateBranchName(trimmed));
      if (mine === nameSeq.current) setNameError(null);
      return true;
    } catch (err) {
      if (mine === nameSeq.current) setNameError(messageOf(err));
      return false;
    }
  }

  async function validateFolder(): Promise<boolean> {
    const mine = ++folderSeq.current;
    if (resolved === "") {
      setFolderFailure({ field: "folder", message: "Choose a folder for the worktree." });
      return false;
    }
    try {
      const check = unwrap(await api.validateWorktreeDestination(resolved));
      if (!check.ok) {
        if (mine === folderSeq.current) setFolderFailure(destinationFailure(check));
        return false;
      }
      if (mine === folderSeq.current) setFolderFailure(null);
      return true;
    } catch (err) {
      if (mine === folderSeq.current) setFolderFailure({ field: "folder", message: messageOf(err) });
      return false;
    }
  }

  // Validate while typing (debounced), not only on blur, so a blocking message shows up before Create is pressed.
  useEffect(() => {
    if (folder.trim() === "") return;
    const t = setTimeout(() => void validateFolder(), VALIDATE_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // validateFolder closes over `resolved`, which is derived from `folder`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder]);
  useEffect(() => {
    if (!needsName || name.trim() === "") return;
    const t = setTimeout(() => void validateName(name), VALIDATE_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  async function handleBrowse() {
    try {
      const picked = unwrap(await api.pickWorktreeFolder());
      if (!picked) return;
      setFolderTouched(true);
      setFolder(joinFolder(picked, slug.replace(/[\\/]/g, "-")));
      setFolderFailure(null);
    } catch (err) {
      setGeneralError(messageOf(err));
    }
  }

  function buildSource(): AddWorktreeSource {
    switch (request.kind) {
      case "branch":
        return { kind: "branch", branch: request.branch };
      case "remote":
        return { kind: "remoteBranch", remote: request.remote, branch: request.branch };
      case "commit":
        return detached ? { kind: "detached", commit: request.sha } : { kind: "newBranch", branch: name.trim(), startPoint: request.sha };
      case "newFromHead":
        return { kind: "newBranch", branch: name.trim(), startPoint: "HEAD" };
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    const needsNameCheck = needsName && !(request.kind === "commit" && detached);
    // A blocking message is already on screen for this very input: go to the field instead of asking again.
    if (nameError && needsNameCheck) return void nameRef.current?.focus();
    if (folderFailure) return void folderRef.current?.focus();
    setGeneralError(null);
    setBranchLink(null);
    const nameOk = needsNameCheck ? await validateName(name) : true;
    const folderOk = await validateFolder();
    if (!nameOk) return void nameRef.current?.focus();
    if (!folderOk) return void folderRef.current?.focus();
    setSubmitting(true);
    try {
      const failure = await onSubmit({ destination: resolved, source: buildSource(), openAfter });
      if (!failure) return;
      if (failure.field === "folder") {
        setFolderFailure(failure);
        folderRef.current?.focus();
      } else if (failure.field === "branch") {
        setNameError(failure.message);
        setBranchLink(failure.link ?? null);
        (needsName ? nameRef : folderRef).current?.focus();
      } else setGeneralError(failure.message);
    } catch (err) {
      setGeneralError(messageOf(err));
    } finally {
      setSubmitting(false);
    }
  }

  const sourceLine =
    request.kind === "branch" ? (
      <span className="gh-create-worktree__chip gh-mono">{visibleText(request.branch)}</span>
    ) : request.kind === "remote" ? (
      <>
        <span className="gh-create-worktree__chip gh-mono">
          {visibleText(request.remote)}/{visibleText(request.branch)}
        </span>
        <p className="gh-create-worktree__hint">
          A local branch <span className="gh-mono">{visibleText(request.branch)}</span> is created, tracking this remote branch.
        </p>
      </>
    ) : null;

  const startHint =
    request.kind === "commit" ? `Starts at ${request.label}.` : request.kind === "newFromHead" ? `Starts at ${request.headLabel}.` : null;

  return (
    <div className="gh-new-branch__overlay" onMouseDown={onOverlayMouseDown}>
      <div ref={dialogRef} className="gh-new-branch gh-create-worktree" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId} className="gh-new-branch__title gh-create-worktree__title">
          Create worktree
        </h2>
        <form className="gh-create-worktree__form" onSubmit={(e) => void handleSubmit(e)} noValidate>
          <div className="gh-create-worktree__body">
            <p className="gh-create-worktree__intro">{CREATE_INTRO}</p>

            {sourceLine && (
              <div className="gh-create-worktree__field">
                <span className="gh-create-worktree__label">Branch</span>
                {sourceLine}
              </div>
            )}

            {needsName && !(request.kind === "commit" && detached) && (
              <div className="gh-create-worktree__field">
                <label className="gh-create-worktree__label" htmlFor={nameId}>
                  New branch name
                </label>
                <input
                  id={nameId}
                  ref={nameRef}
                  type="text"
                  className="gh-mono gh-new-branch__input gh-create-worktree__input"
                  value={name}
                  placeholder="feature/my-change"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={nameError ? true : undefined}
                  aria-describedby={nameError ? nameErrorId : undefined}
                  onChange={(e) => {
                    setName(e.target.value);
                    if (nameError) setNameError(null);
                    setBranchLink(null);
                  }}
                  onBlur={() => {
                    if (name.trim()) void validateName(name);
                  }}
                />
                {nameError && (
                  <FieldMessage id={nameErrorId}>
                    {nameError}{" "}
                    {branchLink && (
                      <button type="button" className="gh-create-worktree__link" onClick={() => onOpenExisting(branchLink.path)}>
                        {branchLink.label}
                      </button>
                    )}
                  </FieldMessage>
                )}
                {startHint && <p className="gh-create-worktree__hint">{startHint}</p>}
              </div>
            )}
            {needsName && request.kind === "commit" && detached && startHint && (
              <p className="gh-create-worktree__hint">Detached at {request.label}. No branch is created.</p>
            )}
            {!needsName && nameError && (
              <FieldMessage>
                {nameError}{" "}
                {branchLink && (
                  <button type="button" className="gh-create-worktree__link" onClick={() => onOpenExisting(branchLink.path)}>
                    {branchLink.label}
                  </button>
                )}
              </FieldMessage>
            )}

            <div className="gh-create-worktree__field">
              <label className="gh-create-worktree__label" htmlFor={folderId}>
                Folder
              </label>
              <div className="gh-create-worktree__row">
                <input
                  id={folderId}
                  ref={folderRef}
                  type="text"
                  className="gh-mono gh-new-branch__input gh-create-worktree__input"
                  value={folder}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={folderFailure ? true : undefined}
                  aria-describedby={[folderFailure ? folderErrorId : null, showPreview ? previewId : null].filter(Boolean).join(" ") || undefined}
                  onChange={(e) => {
                    setFolder(e.target.value);
                    setFolderTouched(true);
                    if (folderFailure) setFolderFailure(null);
                  }}
                  onBlur={() => {
                    if (folder.trim()) void validateFolder();
                  }}
                />
                <button type="button" className="gh-new-branch__cancel gh-create-worktree__browse" onClick={() => void handleBrowse()}>
                  Browse…
                </button>
              </div>
              {showPreview && (
                <p id={previewId} className="gh-create-worktree__preview gh-mono">
                  Will create: {visibleText(resolved)}
                </p>
              )}
              {folderFailure && (
                <FieldMessage id={folderErrorId}>
                  {folderFailure.message}{" "}
                  {folderFailure.link && (
                    <button type="button" className="gh-create-worktree__link" onClick={() => onOpenExisting(folderFailure.link!.path)}>
                      {folderFailure.link.label}
                    </button>
                  )}
                </FieldMessage>
              )}
            </div>

            <label className="gh-create-worktree__check">
              <input type="checkbox" checked={openAfter} onChange={(e) => setOpenAfter(e.target.checked)} />
              Open after create
            </label>

            {request.kind === "commit" && (
              <div className="gh-create-worktree__advanced">
                <button
                  type="button"
                  className="gh-create-worktree__disclosure"
                  aria-expanded={advancedOpen}
                  aria-controls={advancedId}
                  onClick={() => setAdvancedOpen((v) => !v)}
                >
                  <span aria-hidden="true">{advancedOpen ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}</span> Advanced
                </button>
                <div id={advancedId} hidden={!advancedOpen}>
                  <label className="gh-create-worktree__check">
                    <input type="checkbox" checked={detached} onChange={(e) => setDetached(e.target.checked)} />
                    Detached HEAD (no branch)
                  </label>
                  {detached && (
                    <p className="gh-create-worktree__warning" role="note">
                      {DETACHED_WARNING}
                    </p>
                  )}
                </div>
              </div>
            )}

            {generalError && (
              <FieldMessage>{generalError}</FieldMessage>
            )}
          </div>
          <div className="gh-create-worktree__footer">
            <button type="button" className="gh-new-branch__cancel" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className="gh-new-branch__submit" disabled={submitting}>
              {submitting ? "Creating…" : "Create worktree"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
