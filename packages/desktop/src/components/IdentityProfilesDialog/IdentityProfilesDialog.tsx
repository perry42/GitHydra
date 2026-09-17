// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { LocalIdentityValue } from "@githydra/git-core";
import type { GitHydraApi } from "../../../shared/ipcContract";
import { unwrap } from "../../hooks/gitHydraClient";
import type { UseIdentityApplicationsResult } from "../../hooks/useIdentityApplications";
import { useIdentityProfileApplication } from "../../hooks/useIdentityProfileApplication";
import type { IdentityProfile, IdentityProfileInput, UseIdentityProfilesResult } from "../../hooks/useIdentityProfiles";
import { formatDate, formatRelativeDate, truncate } from "../../lib/format";
import { describeIdentityLossOnRemoveNotice, describeNoSshKeyApplyNotice } from "../../lib/identityNotices";
import { ConfirmDialog } from "../ConfirmDialog/ConfirmDialog";
import { IconDelete, IconIdentity } from "../Icon/Icon";
import "./IdentityProfilesDialog.css";

export interface IdentityProfilesDialogProps {
  api: GitHydraApi;
  /** `null` means no repo is open — the "This repository" section renders an explicit
   * "open a repository" message instead of attempting any identity-config read/write; the profile
   * library (create/edit/delete) stays fully usable regardless (FR-329: a profile's lifecycle never
   * depends on any repo being open). */
  repoPath: string | null;
  profiles: UseIdentityProfilesResult;
  applications: UseIdentityApplicationsResult;
  onClose: () => void;
  /** specs/self-write-refresh-suppression.md FR-6b — forwarded verbatim to
   * `useIdentityProfileApplication`'s options of the same names (see that hook's own doc comment). */
  onMutationStart?: () => void;
  onMutationSettled?: () => void;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * specs/git-identity-profiles.md FR-329 through FR-337: one modal combining the profile library
 * (create/edit/delete, FR-329) with the active repo's identity status (FR-335) and apply/remove
 * actions (FR-330/FR-334/FR-336) — reuses `ConfirmDialog`'s exact overlay/panel/shadow shell as a
 * larger form, the same precedent `NewBranchDialog`/`CreateStashDialog` already established, rather
 * than inventing a second modal chrome. A single dialog (not a library dialog PLUS a separate
 * per-repo panel) was chosen because the two halves are small enough to share one screen without
 * crowding, and because FR-335's whole point — "applying a profile is understood as an override,
 * never an invisible change" — reads most directly when the current state and the actions that
 * change it sit together.
 */
export function IdentityProfilesDialog({
  api,
  repoPath,
  profiles,
  applications,
  onClose,
  onMutationStart,
  onMutationSettled,
}: IdentityProfilesDialogProps) {
  const titleId = useId();
  const repoSectionId = useId();
  const librarySectionId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const [editing, setEditing] = useState<IdentityProfile | "new" | null>(null);
  const [pendingDelete, setPendingDelete] = useState<IdentityProfile | null>(null);

  const application = useIdentityProfileApplication({
    api,
    repoPath,
    applications,
    onMutationStart,
    onSettled: onMutationSettled,
  });

  // Accessibility fix, caught in a keyboard-only pass: a single effect that both re-subscribed
  // this listener AND re-ran the initial-focus query on every `editing`/`pendingDelete`/
  // `pendingConflict` change (as one combined effect would) steals focus back to the dialog's
  // FIRST focusable element every time either state changes — e.g. clicking "+ New profile"
  // unmounts that very button (it's conditionally rendered only while `editing === null`), and a
  // combined effect would then yank focus to something else in the dialog entirely instead of
  // leaving it to land naturally (or, better, into the newly-opened form — see
  // `IdentityProfileForm`'s own mount-time focus effect below). Split in two: this one only ever
  // (re)installs the Escape listener; the initial-focus query runs once, on mount, below.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Escape closes whatever's on top first (a two-tier close, matching NewBranchDialog's
      // "the innermost thing wins" convention every other stacked-dialog pair in this codebase
      // follows) — never closes the whole dialog out from under an open form/confirmation.
      if (e.key !== "Escape") return;
      if (pendingDelete || application.pendingConflict) return; // their own ConfirmDialog handles it
      if (editing !== null) {
        setEditing(null);
        return;
      }
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, editing, pendingDelete, application.pendingConflict]);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only, deliberately (see the
  // comment above): this must not re-run when `editing`/etc. change.
  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>("input,select,button")?.focus();
  }, []);

  const applicationRecord = applications.getApplication(repoPath);
  const hasAnyManaged = Boolean(
    application.state &&
      (application.state.userName.managedByGitHydra ||
        application.state.userEmail.managedByGitHydra ||
        application.state.sshCommand.managedByGitHydra),
  );
  // Amendment (2026-09-17) FR-379: re-checked from the same `getIdentityConfigState()` read the
  // remove flow already needs — `null` (renders nothing) whenever removal wouldn't leave either
  // field genuinely unconfigured, or the state isn't loaded yet.
  const identityLossOnRemoveNotice = describeIdentityLossOnRemoveNotice(application.state);
  // Amendment (2026-09-17) FR-378: which copy variant a keyless profile's Apply notice uses —
  // `null` (each `ProfileRow` renders nothing for a keyless profile) until the repo's identity
  // state has actually loaded, since the notice depends on it.
  const sshCommandManagedByGitHydra = application.state?.sshCommand.managedByGitHydra ?? null;

  return (
    <div className="gh-identity-dialog__overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialogRef} className="gh-identity-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId} className="gh-identity-dialog__title">
          <IconIdentity /> Git Identity Profiles
        </h2>
        <p className="gh-identity-dialog__intro">
          Profiles are stored locally by GitHydra only — never synced, never sent anywhere. Applying
          one writes only this repository's local git config; it never touches your global config
          or any other repository.
        </p>

        <section aria-labelledby={repoSectionId} className="gh-identity-dialog__section">
          <h3 id={repoSectionId} className="gh-identity-dialog__section-heading">
            This repository
          </h3>

          {!repoPath && <p className="gh-identity-dialog__hint">Open a repository to see or apply its identity.</p>}

          {repoPath && application.status === "loading" && (
            <p className="gh-identity-dialog__hint" role="status" aria-live="polite" aria-busy="true">
              Loading current identity…
            </p>
          )}

          {repoPath && application.status === "error" && (
            <p className="gh-identity-dialog__error" role="alert">
              Could not load this repository's identity: {application.errorMessage}{" "}
              <button type="button" className="gh-identity-dialog__link-button" onClick={application.reload}>
                Retry
              </button>
            </p>
          )}

          {repoPath && application.status === "ready" && application.state && (
            <>
              <dl className="gh-identity-dialog__status">
                <IdentityStatusRow label="user.name" value={application.state.userName} />
                <IdentityStatusRow label="user.email" value={application.state.userEmail} />
                <IdentityStatusRow label="core.sshCommand" value={application.state.sshCommand} />
              </dl>
              {applicationRecord && (
                <p className="gh-identity-dialog__applied-caption">
                  Applied: {applicationRecord.profileDisplayName} —{" "}
                  <span title={formatDate(applicationRecord.appliedAt)}>{formatRelativeDate(applicationRecord.appliedAt)}</span>
                </p>
              )}
              {/* Amendment (2026-09-17) FR-379: informational, never a confirmation gate — removal
                  still proceeds on this button's own single click, no second click added. */}
              {identityLossOnRemoveNotice && (
                <p className="gh-identity-dialog__notice" role="status">
                  {identityLossOnRemoveNotice}
                </p>
              )}
              <button
                type="button"
                className="gh-identity-dialog__remove"
                onClick={application.removeApplication}
                disabled={application.busy || !hasAnyManaged}
                title={!hasAnyManaged ? "No GitHydra-applied identity to remove from this repository." : undefined}
              >
                Remove applied profile
              </button>
            </>
          )}

          {application.error && (
            <p className="gh-identity-dialog__error" role="alert">
              {application.error}{" "}
              <button type="button" className="gh-identity-dialog__link-button" onClick={application.dismissError}>
                Dismiss
              </button>
            </p>
          )}
        </section>

        <section aria-labelledby={librarySectionId} className="gh-identity-dialog__section">
          <div className="gh-identity-dialog__lib-header">
            <h3 id={librarySectionId} className="gh-identity-dialog__section-heading">
              Profiles
            </h3>
            {editing === null && (
              <button type="button" className="gh-identity-dialog__new" onClick={() => setEditing("new")}>
                + New profile
              </button>
            )}
          </div>

          {profiles.profiles.length === 0 && editing === null && (
            <p className="gh-identity-dialog__empty">No profiles yet — create one to switch identities per repository.</p>
          )}

          {editing === null && profiles.profiles.length > 0 && (
            <ul className="gh-identity-dialog__list">
              {profiles.profiles.map((profile) => (
                <ProfileRow
                  key={profile.id}
                  profile={profile}
                  repoOpen={repoPath !== null}
                  busy={application.busy}
                  sshCommandManagedByGitHydra={sshCommandManagedByGitHydra}
                  onApply={() => application.applyProfile(profile)}
                  onEdit={() => setEditing(profile)}
                  onDelete={() => setPendingDelete(profile)}
                />
              ))}
            </ul>
          )}

          {editing !== null && (
            <IdentityProfileForm
              api={api}
              initial={editing === "new" ? null : editing}
              onCancel={() => setEditing(null)}
              onSave={(input) => {
                if (editing === "new") profiles.createProfile(input);
                else profiles.updateProfile(editing.id, input);
                setEditing(null);
              }}
            />
          )}
        </section>

        <div className="gh-identity-dialog__actions">
          <button type="button" className="gh-identity-dialog__done" onClick={onClose}>
            Done
          </button>
        </div>
      </div>

      {pendingDelete && (
        <ConfirmDialog
          title="Delete profile?"
          message={`Delete the profile "${pendingDelete.displayName}"? This only removes it from GitHydra's profile library — it does not change any repository's git config.`}
          confirmLabel="Delete"
          destructive
          onConfirm={() => {
            profiles.deleteProfile(pendingDelete.id);
            setPendingDelete(null);
          }}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {/* FR-334: the one place this feature ever overwrites a value it didn't itself set — always
          gated behind this explicit confirmation, never auto-forced. */}
      {application.pendingConflict && (
        <ConfirmDialog
          title="Overwrite existing git identity config?"
          message={application.pendingConflict.message}
          confirmLabel="Overwrite and apply"
          destructive
          onConfirm={application.confirmApplyWithForce}
          onCancel={application.cancelApplyConflict}
        />
      )}
    </div>
  );
}

function describeSource(value: LocalIdentityValue): { text: string; detail: string | null } {
  if (value.localValue !== null) {
    return value.managedByGitHydra
      ? { text: value.localValue, detail: "Applied by GitHydra" }
      : { text: value.localValue, detail: "Set locally (not by GitHydra)" };
  }
  if (value.globalValue !== null) {
    return { text: value.globalValue, detail: "Inherited from global config" };
  }
  return { text: "Not set", detail: null };
}

/** FR-335: one config key's current state, distinguishing "set locally" (and whether GitHydra set
 * it) from "inherited from global config" from "not set at all" — text-carried, never color-only,
 * matching this system's status-token policy. */
function IdentityStatusRow({ label, value }: { label: string; value: LocalIdentityValue }) {
  const { text, detail } = describeSource(value);
  return (
    <div className="gh-identity-dialog__status-row">
      <dt className="gh-mono gh-identity-dialog__status-key">{label}</dt>
      <dd className="gh-identity-dialog__status-value">
        <span className="gh-mono">{text}</span>
        {detail && <span className="gh-identity-dialog__status-detail"> — {detail}</span>}
      </dd>
    </div>
  );
}

function ProfileRow({
  profile,
  repoOpen,
  busy,
  sshCommandManagedByGitHydra,
  onApply,
  onEdit,
  onDelete,
}: {
  profile: IdentityProfile;
  repoOpen: boolean;
  busy: boolean;
  /** Amendment (2026-09-17) FR-378: the repo's CURRENT `core.sshCommand.managedByGitHydra` — `null`
   * until that state has loaded (or no repo is open), in which case this row shows no notice at
   * all rather than guessing which copy variant applies. */
  sshCommandManagedByGitHydra: boolean | null;
  onApply: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  // Amendment (2026-09-17) FR-378: informational, independent of FR-334's separate conflict
  // modal — visible on this primary Apply surface before the user ever clicks Apply, never gated
  // behind its own confirmation.
  const noSshKeyNotice =
    repoOpen && !profile.sshIdentityFilePath && sshCommandManagedByGitHydra !== null
      ? describeNoSshKeyApplyNotice(sshCommandManagedByGitHydra)
      : null;

  return (
    <li className="gh-identity-dialog__row">
      <div className="gh-identity-dialog__row-main">
        <span className="gh-identity-dialog__row-name">{profile.displayName}</span>
        <span className="gh-identity-dialog__row-detail gh-mono">
          {profile.userName} &lt;{profile.userEmail}&gt;
        </span>
        {profile.sshIdentityFilePath && (
          <span className="gh-identity-dialog__row-detail gh-mono" title={profile.sshIdentityFilePath}>
            SSH key: {truncate(profile.sshIdentityFilePath, 48)}
          </span>
        )}
        {noSshKeyNotice && (
          <p className="gh-identity-dialog__notice" role="status">
            {noSshKeyNotice}
          </p>
        )}
      </div>
      <div className="gh-identity-dialog__row-actions">
        <button
          type="button"
          onClick={onApply}
          disabled={!repoOpen || busy}
          title={!repoOpen ? "Open a repository to apply this profile." : undefined}
        >
          {busy ? "Working…" : "Apply to this repository"}
        </button>
        <button type="button" onClick={onEdit}>
          Edit
        </button>
        <button type="button" className="gh-identity-dialog__delete" onClick={onDelete}>
          <IconDelete />
          Delete
        </button>
      </div>
    </li>
  );
}

/**
 * FR-329's create/edit form. FR-332: the SSH identity-file path is picked exclusively through the
 * native file dialog (`api.pickSshIdentityFile()`) — there is deliberately no free-text input for
 * it anywhere in this form, so there is no path here that could feed an arbitrary string toward
 * git-core's `core.sshCommand` shell-metacharacter validator; the picked path is shown read-only.
 */
function IdentityProfileForm({
  api,
  initial,
  onCancel,
  onSave,
}: {
  api: GitHydraApi;
  initial: IdentityProfile | null;
  onCancel: () => void;
  onSave: (input: IdentityProfileInput) => void;
}) {
  const nameId = useId();
  const userNameId = useId();
  const userEmailId = useId();
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const [displayName, setDisplayName] = useState(initial?.displayName ?? "");
  const [userName, setUserName] = useState(initial?.userName ?? "");
  const [userEmail, setUserEmail] = useState(initial?.userEmail ?? "");
  const [sshIdentityFilePath, setSshIdentityFilePath] = useState<string | null>(initial?.sshIdentityFilePath ?? null);
  const [pickError, setPickError] = useState<string | null>(null);

  // Accessibility fix: this component mounts fresh every time the dialog opens it (conditionally
  // rendered, never kept mounted-but-hidden) — so a plain mount-time focus here reliably lands in
  // the newly-opened form's first field, rather than leaving keyboard focus stranded wherever it
  // was on the button that got unmounted to reveal this form (see `IdentityProfilesDialog`'s own
  // doc comment on its initial-focus effect for the full reasoning this fix is paired with).
  useEffect(() => {
    nameInputRef.current?.focus();
  }, []);

  async function handleBrowse() {
    setPickError(null);
    try {
      const path = unwrap(await api.pickSshIdentityFile());
      if (path !== null) setSshIdentityFilePath(path);
    } catch (err) {
      setPickError(messageOf(err));
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmedName = displayName.trim();
    const trimmedUserName = userName.trim();
    const trimmedEmail = userEmail.trim();
    if (!trimmedName || !trimmedUserName || !trimmedEmail) return;
    onSave({ displayName: trimmedName, userName: trimmedUserName, userEmail: trimmedEmail, sshIdentityFilePath });
  }

  const valid = displayName.trim() && userName.trim() && userEmail.trim();

  return (
    <form className="gh-identity-dialog__form" onSubmit={handleSubmit}>
      <label className="gh-identity-dialog__label" htmlFor={nameId}>
        Profile name
      </label>
      <input
        id={nameId}
        ref={nameInputRef}
        type="text"
        className="gh-identity-dialog__input"
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
        placeholder="Work"
        required
      />

      <label className="gh-identity-dialog__label" htmlFor={userNameId}>
        user.name
      </label>
      <input
        id={userNameId}
        type="text"
        className="gh-mono gh-identity-dialog__input"
        value={userName}
        onChange={(e) => setUserName(e.target.value)}
        placeholder="Jane Doe"
        required
      />

      <label className="gh-identity-dialog__label" htmlFor={userEmailId}>
        user.email
      </label>
      <input
        id={userEmailId}
        type="email"
        className="gh-mono gh-identity-dialog__input"
        value={userEmail}
        onChange={(e) => setUserEmail(e.target.value)}
        placeholder="jane@work.example"
        required
      />

      <span className="gh-identity-dialog__label">SSH identity file (optional)</span>
      <div className="gh-identity-dialog__ssh-row">
        <output
          className="gh-mono gh-identity-dialog__ssh-path"
          aria-label="Selected SSH identity file"
          title={sshIdentityFilePath ?? undefined}
        >
          {sshIdentityFilePath ?? "(none)"}
        </output>
        <button type="button" onClick={() => void handleBrowse()}>
          Browse…
        </button>
        {sshIdentityFilePath && (
          <button type="button" onClick={() => setSshIdentityFilePath(null)}>
            Clear
          </button>
        )}
      </div>
      <p className="gh-identity-dialog__hint">
        Selected via your OS's file picker only — GitHydra never reads its contents, only its path.
      </p>
      {pickError && (
        <p className="gh-identity-dialog__error" role="alert">
          {pickError}
        </p>
      )}

      <div className="gh-identity-dialog__actions">
        <button type="button" className="gh-identity-dialog__cancel" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="gh-identity-dialog__submit" disabled={!valid}>
          {initial ? "Save changes" : "Create profile"}
        </button>
      </div>
    </form>
  );
}
